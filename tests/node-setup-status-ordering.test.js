import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';
import { defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';
import { StateStore } from '../src/main/state-store.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = performance.now() + 1000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Controlled operation did not reach its ordering boundary');
    await nextTurn();
  }
}

// These are real manager/StateStore/configuration operations with controlled
// RPC replies and process state. No executable, cookie, network, or native
// service is opened or run. process.execPath is only stat/access validated.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-node-status-ordering-'));
  const store = new StateStore(path.join(root, 'state'), null);
  await store.init();
  await store.mutate(state => {
    state.providers = []; state.localServices = [];
    state.settings.network = 'regtest';
    state.settings.offlineMode = false; state.settings.localOnly = false;
  });
  const calls = [], states = new Map(), timers = new Set(), gates = [];
  const behavior = { syncing: false, rpcGate: null, ordGate: null, coreStopGate: null, throwOrdSnapshot: false };
  const coreStarted = deferred(), coreStopped = deferred();
  const services = {
    editing: new Map(), starting: new Map(), stopping: new Map(), removing: new Map(), processes: new Map(),
    list() {
      const snapshot = store.get(['localServices']).map(service => ({ ...service, status: states.get(service.id) ?? 'stopped' }));
      if (behavior.throwOrdSnapshot) {
        behavior.throwOrdSnapshot = false;
        Object.defineProperty(snapshot.find(service => service.id === 'guided-ord-regtest'), 'status', {
          get() { throw Object.assign(new Error('controlled old service snapshot failure'), { code: 'CONTROLLED_READ_FAILURE' }); }
        });
      }
      return snapshot;
    },
    async start(id) {
      calls.push(`start:${id}`); states.set(id, 'running');
      if (id === 'guided-core-regtest') coreStarted.resolve();
    },
    async stop(id) {
      calls.push(`stop:${id}`);
      if (id === 'guided-core-regtest' && behavior.coreStopGate) {
        const gate = behavior.coreStopGate; behavior.coreStopGate = null;
        gate.entered.resolve(); await gate.release.promise;
      }
      states.set(id, 'stopped');
      if (id === 'guided-core-regtest') coreStopped.resolve();
    }
  };
  const manager = new NodeSetupManager({
    stateStore: store, localServiceManager: services,
    providerManager: {
      providerMutations: new Set(), blockedProviders: new Set(),
      assertNoPendingCleanup() {}, invalidateRouting() {}, refresh() {},
      list: () => store.get(['providers'])
    },
    software: { async shutdown() {} }, rootDirectory: path.join(root, 'nodes'),
    confirm: async () => true,
    coreFactory: () => ({ async rpc(method) {
      calls.push(`rpc:${method}`);
      const result = method === 'getindexinfo' ? { txindex: { synced: true } }
        : { chain: 'regtest', blocks: 100, headers: behavior.syncing ? 101 : 100,
          initialblockdownload: behavior.syncing, verificationprogress: 0.9, pruned: false };
      if (method === 'getblockchaininfo' && behavior.rpcGate) {
        const gate = behavior.rpcGate; behavior.rpcGate = null;
        gate.entered.resolve(); await gate.release.promise;
      }
      return { result };
    } }),
    ordFactory: () => ({ async health() {
      calls.push('ord:health');
      if (behavior.ordGate) {
        const gate = behavior.ordGate; behavior.ordGate = null;
        gate.entered.resolve(); await gate.release.promise;
      }
      return { ok: true, height: 100 };
    } }),
    restProbe: async () => ({ chain: 'regtest' }),
    setTimer: callback => { timers.add(callback); return callback; },
    clearTimer: callback => timers.delete(callback)
  });
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    try { await manager.shutdown(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  const draft = defaultNodeSetupDraft({ rootDirectory: path.join(root, 'nodes'), network: 'regtest' });
  draft.core.executable = process.execPath; draft.ord.executable = process.execPath;
  const preview = await manager.run({ action: 'preview', draft });
  const saved = await manager.run({ action: 'apply', token: preview.token });
  const hold = name => {
    const gate = { entered: deferred(), release: deferred() };
    gates.push(gate); behavior[name] = gate; return gate;
  };
  const action = action => manager.run({ action, setupId: saved.setupId });
  return { manager, store, calls, states, timers, behavior, hold, action, saved, coreStarted, coreStopped };
}

test('status ordering control: concurrent passive reads coalesce without extra RPC or service effects', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.states.set('guided-core-regtest', 'running');
  const gate = f.hold('rpcGate');
  const first = f.action('status'); await gate.entered.promise;
  const second = f.action('status'); await nextTurn();
  assert.equal(f.calls.filter(call => call === 'rpc:getblockchaininfo').length, 1);
  gate.release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(a.core.phase, 'ready'); assert.equal(a.ord.phase, 'stopped');
  assert.equal(f.calls.some(call => call.startsWith('start:') || call.startsWith('stop:')), false);
});

test('start must not reuse a pre-start stopped Core snapshot or lose the new Ord dependency intent', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  // Advanced controls or an unexpected Core exit can leave Ord running alone.
  // The pending health reply captured that earlier service-list snapshot.
  f.states.set('guided-ord-regtest', 'running');
  const gate = f.hold('ordGate');
  const polling = f.action('status'); await gate.entered.promise;
  // Ord then exits, and the user starts the saved pair. Fresh Core is syncing.
  f.states.set('guided-ord-regtest', 'stopped'); f.behavior.syncing = true;
  const starting = f.action('start'); await f.coreStarted.promise; await nextTurn();
  gate.release.resolve();
  const [oldSnapshot, started] = await Promise.all([polling, starting]);
  assert.equal(oldSnapshot.core.phase, 'stopped');
  assert.equal(f.states.get('guided-core-regtest'), 'running');
  t.diagnostic(JSON.stringify({ nativeExecuted: false, returnedCore: started.core.phase,
    returnedOrd: started.ord.phase, dependencyIntentRetained: f.manager.desired === f.saved.setupId,
    timers: f.timers.size, coreRunning: true, ordRunning: f.states.get('guided-ord-regtest') === 'running' }));
  assert.deepEqual({ core: started.core.phase, ord: started.ord.phase,
    intent: f.manager.desired === f.saved.setupId, timers: f.timers.size },
  { core: 'syncing', ord: 'stopped', intent: true, timers: 1 });
  assert.equal(f.calls.includes('start:guided-ord-regtest'), false);
  f.behavior.syncing = false;
  await f.manager.advance(f.manager.saved(f.saved.setupId));
  assert.equal(f.calls.filter(call => call === 'start:guided-ord-regtest').length, 1);
});

test('stop must return a post-stop read instead of reusing a pending ready snapshot', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.states.set('guided-core-regtest', 'running'); f.states.set('guided-ord-regtest', 'running');
  const gate = f.hold('rpcGate');
  const polling = f.action('status'); await gate.entered.promise;
  const stopping = f.action('stop'); await f.coreStopped.promise; await nextTurn();
  assert.deepEqual(f.calls.filter(call => call.startsWith('stop:')),
    ['stop:guided-ord-regtest', 'stop:guided-core-regtest']);
  gate.release.resolve();
  const [oldSnapshot, stopped] = await Promise.all([polling, stopping]);
  assert.equal(oldSnapshot.core.phase, 'ready');
  assert.equal(f.states.get('guided-core-regtest'), 'stopped');
  assert.equal(f.states.get('guided-ord-regtest'), 'stopped');
  t.diagnostic(JSON.stringify({ nativeExecuted: false, returnedCore: stopped.core.phase,
    returnedOrd: stopped.ord.phase, managedCore: 'stopped', managedOrd: 'stopped' }));
  assert.deepEqual({ core: stopped.core.phase, ord: stopped.ord.phase }, { core: 'stopped', ord: 'stopped' });
  assert.equal(f.manager.desired, null); assert.equal(f.timers.size, 0);
  assert.equal(f.calls.some(call => call.startsWith('start:')), false);
});

test('stop control: late in-flight advance cannot authorize Ord after Stop clears intent', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.behavior.syncing = true;
  await f.action('start'); assert.equal(f.timers.size, 1);
  f.behavior.syncing = false; const gate = f.hold('rpcGate');
  const advancing = f.manager.advance(f.manager.saved(f.saved.setupId)); await gate.entered.promise;
  const stopping = f.action('stop'); await nextTurn();
  assert.equal(f.manager.desired, null);
  gate.release.resolve(); await Promise.all([advancing, stopping]);
  assert.equal(f.calls.includes('start:guided-ord-regtest'), false);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls.filter(call => call.startsWith('stop:')),
    ['stop:guided-ord-regtest', 'stop:guided-core-regtest']);
});

test('stop drains a read admitted during process effects and preserves the original passive snapshot', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.states.set('guided-core-regtest', 'running'); f.states.set('guided-ord-regtest', 'running');
  const stopGate = f.hold('coreStopGate');
  const stopping = f.action('stop'); await stopGate.entered.promise;
  const rpcGate = f.hold('rpcGate');
  const polling = f.action('status'); await rpcGate.entered.promise;
  stopGate.release.resolve(); await f.coreStopped.promise; await nextTurn();
  rpcGate.release.resolve();
  const [oldSnapshot, stopped] = await Promise.all([polling, stopping]);
  assert.equal(oldSnapshot.core.phase, 'ready'); assert.equal(oldSnapshot.ord.phase, 'stopped');
  assert.equal(stopped.core.phase, 'stopped'); assert.equal(stopped.ord.phase, 'stopped');
  assert.equal(f.manager.lastStatus, stopped);
  assert.notEqual(oldSnapshot, stopped);
  await nextTurn(); assert.equal(f.manager.lastStatus.core.phase, 'stopped');
});

test('an old passive read rejection cannot prevent explicit managed Stop or its fresh result', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.states.set('guided-core-regtest', 'running'); f.states.set('guided-ord-regtest', 'running');
  // The service collaborator exposes a captured snapshot whose later Ord
  // access fails. The rejection is outside RPC error-to-status normalization.
  f.behavior.throwOrdSnapshot = true; const gate = f.hold('rpcGate');
  const polling = f.action('status'); const observed = polling.catch(cause => cause);
  await gate.entered.promise;
  const stopping = f.action('stop'); await f.coreStopped.promise; await nextTurn();
  gate.release.resolve();
  assert.equal((await observed).code, 'CONTROLLED_READ_FAILURE');
  const stopped = await stopping;
  assert.equal(stopped.core.phase, 'stopped'); assert.equal(stopped.ord.phase, 'stopped');
  assert.equal(f.manager.lastStatus, stopped);
  assert.deepEqual(f.calls.filter(call => call.startsWith('stop:')),
    ['stop:guided-ord-regtest', 'stop:guided-core-regtest']);
});

test('shutdown while Start drains an ignored-abort old read blocks fresh RPC and retains drain ownership', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.states.set('guided-ord-regtest', 'running');
  const gate = f.hold('ordGate');
  const polling = f.action('status'); const pollingOutcome = polling.catch(cause => cause);
  await gate.entered.promise;
  f.states.set('guided-ord-regtest', 'stopped'); f.behavior.syncing = true;
  const starting = f.action('start'); const startingOutcome = starting.catch(cause => cause);
  await f.coreStarted.promise; await nextTurn();
  let shutdownSettled = false;
  const shutdown = f.manager.shutdown().then(() => { shutdownSettled = true; });
  await nextTurn(); assert.equal(shutdownSettled, false);
  assert.equal(f.manager.controller.signal.aborted, true);
  assert.equal(f.calls.some(call => call.startsWith('rpc:')), false);
  gate.release.resolve();
  assert.equal((await pollingOutcome).code, 'APP_SHUTTING_DOWN');
  assert.equal((await startingOutcome).code, 'APP_SHUTTING_DOWN');
  await shutdown; assert.equal(shutdownSettled, true);
  assert.equal(f.calls.some(call => call.startsWith('rpc:')), false);
  assert.equal(f.calls.includes('start:guided-ord-regtest'), false);
  assert.equal(f.manager.desired, null); assert.equal(f.timers.size, 0);
});

test('new Start drains old advancement before publishing replacement intent or allowing Ord admission', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.behavior.syncing = true;
  await f.action('start'); assert.equal(f.timers.size, 1);
  f.behavior.syncing = false; const gate = f.hold('rpcGate');
  const advancing = f.manager.advance(f.manager.saved(f.saved.setupId)); await gate.entered.promise;
  // The old ready reply must not authorize Ord after a newly requested Core
  // start, whose current chain observation is deliberately still syncing.
  f.behavior.syncing = true;
  const starting = f.action('start');
  await until(() => f.manager.desired === null || f.calls.filter(call => call === 'start:guided-core-regtest').length === 2);
  gate.release.resolve(); await advancing;
  const started = await starting;
  assert.equal(started.core.phase, 'syncing'); assert.equal(started.ord.phase, 'stopped');
  assert.equal(f.calls.includes('start:guided-ord-regtest'), false);
  assert.equal(f.calls.filter(call => call === 'start:guided-core-regtest').length, 2);
  assert.equal(f.manager.desired, f.saved.setupId); assert.equal(f.timers.size, 1);
});

test('a rejected automatic advancement cannot clear the replacement Start intent in its delayed tracked catch', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.behavior.syncing = true;
  await f.action('start');
  f.behavior.syncing = false; f.behavior.throwOrdSnapshot = true;
  const gate = f.hold('rpcGate');
  const callback = [...f.timers][0]; callback(); await gate.entered.promise;
  const oldAdvance = f.manager.advancing.catch(cause => cause);
  f.behavior.syncing = true;
  const starting = f.action('start');
  await until(() => f.manager.desired === null || f.calls.filter(call => call === 'start:guided-core-regtest').length === 2);
  gate.release.resolve(); assert.equal((await oldAdvance).code, 'CONTROLLED_READ_FAILURE');
  const started = await starting; await nextTurn();
  t.diagnostic(JSON.stringify({ nativeExecuted: false, automaticFailure: 'CONTROLLED_READ_FAILURE',
    returnedCore: started.core.phase, dependencyIntentRetained: f.manager.desired === f.saved.setupId, timers: f.timers.size }));
  assert.equal(started.core.phase, 'syncing');
  assert.equal(f.calls.includes('start:guided-ord-regtest'), false);
  assert.equal(f.manager.desired, f.saved.setupId); assert.equal(f.timers.size, 1);
});

test('a queued old timer callback cannot adopt a same-ID replacement Start after clearInterval', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.behavior.syncing = true;
  await f.action('start'); const oldCallback = [...f.timers][0];
  await f.action('start'); assert.equal(f.timers.size, 1);
  assert.notEqual([...f.timers][0], oldCallback);
  const count = f.calls.length;
  oldCallback(); await nextTurn();
  assert.equal(f.calls.length, count);
  assert.equal(f.manager.desired, f.saved.setupId); assert.equal(f.timers.size, 1);
  // The replacement timer still performs the expected readiness work.
  f.behavior.syncing = false;
  [...f.timers][0]();
  await until(() => f.calls.includes('start:guided-ord-regtest'));
  assert.equal(f.calls.filter(call => call === 'start:guided-ord-regtest').length, 1);
});

test('a timer admitted before intent replacement cannot run its deferred body for the new intent', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.behavior.syncing = true;
  await f.action('start'); const callback = [...f.timers][0];
  const count = f.calls.length;
  callback();
  // This synchronous reset models the interval callback having been admitted
  // just before a lifecycle boundary, but its tracked microtask not yet run.
  f.manager.clearIntent();
  await nextTurn();
  assert.equal(f.calls.length, count); assert.equal(f.manager.desired, null);
  await f.action('start'); assert.equal(f.manager.desired, f.saved.setupId);
});

test('ownership change while draining is rechecked before any fresh network work', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.states.set('guided-ord-regtest', 'running');
  const gate = f.hold('ordGate');
  const polling = f.action('status'); const pollingOutcome = polling.catch(cause => cause);
  await gate.entered.promise;
  const starting = f.action('start'); const startingOutcome = starting.catch(cause => cause);
  await f.coreStarted.promise; await nextTurn();
  await f.store.mutate(state => { state.providers[0].name = 'Edited while read was pending'; });
  gate.release.resolve();
  assert.equal((await pollingOutcome).code, 'NODE_SETUP_CHANGED');
  assert.equal((await startingOutcome).code, 'NODE_SETUP_CHANGED');
  assert.equal(f.calls.some(call => call.startsWith('rpc:')), false);
  assert.equal(f.calls.includes('start:guided-ord-regtest'), false);
});
