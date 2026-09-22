import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';
import { StateStore } from '../src/main/state-store.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
// Real disposable persistence. Download and process lifecycle are synthetic:
// no network, Core execution, chain synchronization, or credential access.
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bitcoin-easy-node-')));
  const gates = []; let manager;
  t.after(async () => { for (const gate of gates) gate.resolve(); await manager?.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const store = new StateStore(path.join(root, 'state'), null); await store.init();
  await store.mutate(state => { state.providers = []; state.localServices = []; Object.assign(state.settings, { network: 'mainnet', offlineMode: false, localOnly: false }); });
  const calls = [], processes = new Map();
  const behavior = { consent: true, failStart: false, failRefresh: false, install: null, clock: 1000 };
  const capacity = { availableBytes: 100 * 1024 ** 3, memoryBytes: 8 * 1024 ** 3, logicalCpus: 8, writable: true, osSupported: true, platform: process.platform, arch: process.arch };
  const executable = path.join(root, 'synthetic-bitcoind');
  const descriptor = { kind: 'core', version: '31.1', url: 'https://example.invalid/fixture', sha256: 'fixture' };
  const software = { catalog: () => ({ core: descriptor }), destination: () => executable, discover: async () => ({ core: [], ord: [] }), shutdown: async () => {},
    install: async (kind, options) => {
      calls.push(`install:${kind}`);
      if (behavior.install) await behavior.install(options);
      options.signal.throwIfAborted();
      await fs.writeFile(executable, 'Synthetic test program. Never executed.', { mode: 0o700 });
      return { executable };
    } };
  const providers = { providerMutations: new Set(), blockedProviders: new Set(), assertNoPendingCleanup() {}, invalidateRouting() {},
    refresh() { if (behavior.failRefresh) throw new Error('synthetic refresh failure'); }, list: () => store.get(['providers']) };
  const services = { editing: new Map(), starting: new Map(), stopping: new Map(), removing: new Map(), processes: new Map(),
    list: () => store.get(['localServices']).map(service => ({ ...service, status: processes.get(service.id) ?? 'stopped' })),
    start: async id => { calls.push(`start:${id}`); if (behavior.failStart) throw new Error('synthetic launch refused'); processes.set(id, 'running'); },
    stop: async id => { calls.push(`stop:${id}`); processes.set(id, 'stopped'); } };
  manager = new NodeSetupManager({ stateStore: store, providerManager: providers, localServiceManager: services, software, rootDirectory: path.join(root, 'nodes'),
    inspectCapacity: async rootDirectory => ({ rootDirectory, ...capacity }), now: () => behavior.clock,
    confirm: async (action, value) => { calls.push(`confirm:${action}`); return typeof behavior.consent === 'function' ? behavior.consent(value) : behavior.consent; },
    coreFactory: () => ({ rpc: async method => ({ result: method === 'getindexinfo' ? {} : { chain: 'main', blocks: 20, headers: 100, initialblockdownload: true, verificationprogress: .2, pruned: true } }) }),
    setTimer: () => ({ unref() {} }), clearTimer() {} });
  const preview = fields => manager.run({ action: 'easy-preview', ...fields });
  const start = async fields => manager.run({ action: 'easy-start', token: (await preview(fields)).token });
  return { root, manager, store, calls, capacity, behavior, descriptor, software, services, providers, gates, preview, start };
}

test('inspection and easy preview are read-only; single consent performs pinned install, save and start', async t => {
  const f = await fixture(t);
  const inspected = await f.manager.run({ action: 'inspect' }); assert.equal(inspected.easy.eligible, true);
  const p = await f.preview(); assert.deepEqual(f.calls, []); assert.equal(f.store.get(['nodeSetup']), undefined);
  await assert.rejects(fs.stat(path.join(f.root, 'nodes')), { code: 'ENOENT' });
  const result = await f.manager.run({ action: 'easy-start', token: p.token });
  assert.equal(result.committed, true); assert.equal(result.status.core.phase, 'syncing'); assert.equal(result.startWarning, null);
  assert.equal(result.services[0].status, 'running');
  assert.deepEqual(f.calls, ['confirm:easy-start', 'install:core', 'start:guided-core-mainnet']);
  assert.equal(result.setup.autoStart, false); assert.equal(result.setup.plan.draft.core.storage, 'pruned');
  assert.equal(result.setup.plan.draft.core.dbCacheMiB, 512); assert.equal(result.setup.plan.draft.core.validationThreads, 4);
  const args = result.setup.plan.services[0].args;
  for (const flag of ['-dbcache=512', '-par=4', '-prune=10000', '-txindex=0', '-listen=0', '-natpmp=0', '-rpcbind=127.0.0.1']) assert.ok(args.includes(flag));
  assert.equal(args.some(arg => /assumevalid|assumeutxo|connect=0|networkactive=0/.test(arg)), false);
  assert.equal(result.setup.plan.ord.selected, false); assert.equal(result.providers.length, 1);
  assert.equal(f.manager.saved(result.setupId).id, result.setupId);
  const reopened = new StateStore(f.store.directory, null); await reopened.init(); assert.equal(reopened.get(['nodeSetup']).id, result.setupId);
  assert.equal((await f.manager.run({ action: 'easy-status', token: p.token })).canCancel, false);
  assert.equal((await f.manager.run({ action: 'inspect' })).easy, undefined);
});

test('explicit autostart opt-in is saved without turning Core into a system startup service', async t => {
  const f = await fixture(t); const value = await f.start({ autoStart: true });
  assert.equal(value.setup.autoStart, true); assert.equal(value.services[0].autoStart, false);
});

test('denied consent neither installs nor saves nor starts', async t => {
  const f = await fixture(t); f.behavior.consent = false;
  await assert.rejects(f.start(), { code: 'USER_REJECTED' });
  assert.deepEqual(f.calls, ['confirm:easy-start']); assert.equal(f.store.get(['nodeSetup']), undefined);
});

test('unsafe or unknown capacity refuses the easy path without changing advanced minimums', async t => {
  const f = await fixture(t); f.capacity.availableBytes = 29 * 1024 ** 3;
  await assert.rejects(f.start(), { code: 'EASY_NODE_REVIEW_REQUIRED' }); assert.deepEqual(f.calls, []);
  f.capacity.availableBytes = null; await assert.rejects(f.preview(), { code: 'EASY_NODE_REVIEW_REQUIRED' });
});

test('closed easy action shapes reject renderer authority and consent injection', async t => {
  const f = await fixture(t);
  for (const payload of [
    { action: 'easy-start', token: 'bad', consented: true }, { action: 'easy-preview', executable: process.execPath },
    { action: 'easy-preview', args: ['-listen=1'] }, { action: 'capacity', url: 'https://example.invalid/' },
    { action: 'apply', token: 'bad', consented: true }, { action: 'start', setupId: 'bad', automatic: true }
  ]) await assert.rejects(f.manager.run(payload), { code: 'INVALID_NODE_SETUP_ACTION' });
  await assert.rejects(f.preview({ autoStart: 'true' }), { code: 'INVALID_NODE_SETUP' });
  await assert.rejects(f.manager.run({ action: 'easy-start', token: 'unknown' }), { code: 'EASY_NODE_CHANGED' });
  assert.deepEqual(f.calls, []);
});

test('expired, replaced and already-used tokens never silently replay setup', async t => {
  const f = await fixture(t); const old = await f.preview(); const next = await f.preview();
  await assert.rejects(f.manager.run({ action: 'easy-start', token: old.token }), { code: 'EASY_NODE_CHANGED' });
  f.behavior.clock += 16 * 60_000;
  await assert.rejects(f.manager.run({ action: 'easy-start', token: next.token }), { code: 'NODE_SETUP_PREVIEW_EXPIRED' });
  const fresh = await f.preview(); await f.manager.run({ action: 'easy-start', token: fresh.token });
  await assert.rejects(f.manager.run({ action: 'easy-start', token: fresh.token }), { code: 'NODE_SETUP_PREVIEW_EXPIRED' });
  assert.equal(f.calls.filter(call => call === 'install:core').length, 1);
});

test('free-space, privacy, catalog and network are rechecked after native confirmation', async t => {
  for (const change of ['disk', 'offline', 'localOnly', 'catalog', 'network', 'folder']) await t.test(change, async t => {
    const f = await fixture(t);
    f.behavior.consent = async () => {
      if (change === 'disk') f.capacity.availableBytes = 1024;
      if (change === 'folder') f.capacity.rootDirectory = path.join(f.root, 'redirected');
      if (change === 'offline') await f.store.updateSettings({ offlineMode: true });
      if (change === 'localOnly') await f.store.updateSettings({ localOnly: true });
      if (change === 'network') await f.store.updateSettings({ network: 'signet' });
      if (change === 'catalog') f.software.catalog = () => ({ core: { ...f.descriptor, version: 'changed' } });
      return true;
    };
    await assert.rejects(f.start());
    assert.equal(f.calls.some(call => call.startsWith('install:') || call.startsWith('start:')), false);
    assert.equal(f.store.get(['nodeSetup']), undefined);
  });
});

test('existing data and conflicting service definitions are never overwritten', async t => {
  const f = await fixture(t); const directory = path.join(f.root, 'nodes', 'core-mainnet');
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'personal.txt'), 'keep');
  await assert.rejects(f.preview(), { code: 'NODE_SETUP_DIRECTORY_EXISTS' });
  assert.equal(await fs.readFile(path.join(directory, 'personal.txt'), 'utf8'), 'keep'); assert.deepEqual(f.calls, []);
  await f.store.mutate(state => state.localServices.push({ id: 'guided-core-mainnet' }));
  await assert.rejects(f.preview({ rootDirectory: path.join(f.root, 'different') }), { code: 'NODE_SETUP_COLLISION' });
});

test('existing saved setup must be resumed, never duplicated', async t => {
  const f = await fixture(t); const first = await f.start();
  await assert.rejects(f.start({ rootDirectory: path.join(f.root, 'another') }), { code: 'EASY_NODE_REVIEW_REQUIRED' });
  assert.equal(f.store.get(['nodeSetup']).id, first.setupId); assert.equal(f.calls.filter(call => call === 'install:core').length, 1);
});

test('cancel during a held download drains it with no node configuration or process start', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred(); f.gates.push(gate);
  f.behavior.install = async () => { entered.resolve(); await gate.promise; };
  const p = await f.preview(); const starting = f.manager.run({ action: 'easy-start', token: p.token });
  const rejected = assert.rejects(starting, { code: 'USER_REJECTED' }); await entered.promise;
  assert.equal((await f.manager.run({ action: 'easy-status', token: p.token })).phase, 'downloading');
  assert.equal((await f.manager.run({ action: 'easy-cancel', token: p.token })).cancelled, true);
  await assert.rejects(f.preview(), { code: 'NODE_SETUP_BUSY' });
  gate.resolve(); await rejected;
  assert.equal(f.store.get(['nodeSetup']), undefined); assert.equal(f.calls.some(call => call.startsWith('start:')), false);
  assert.equal(f.manager.downloads.size, 0);
});

test('privacy transitions abort held downloads and prevent save even when installation ignores cancellation', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred(); f.gates.push(gate);
  f.behavior.install = async () => { entered.resolve(); await gate.promise; };
  const p = await f.preview(); const starting = f.manager.run({ action: 'easy-start', token: p.token });
  const rejected = assert.rejects(starting, { code: 'SOFTWARE_DOWNLOAD_BLOCKED' }); await entered.promise;
  await f.store.updateSettings({ localOnly: true }); f.manager.settingsChanged(f.store.get(['settings']));
  gate.resolve(); await rejected; assert.equal(f.store.get(['nodeSetup']), undefined);
});

test('download failure and wrong executable results cannot save or launch a setup', async t => {
  const f = await fixture(t); f.behavior.install = async () => { throw Object.assign(new Error('synthetic integrity mismatch'), { code: 'SOFTWARE_INTEGRITY_FAILED' }); };
  await assert.rejects(f.start(), { code: 'SOFTWARE_INTEGRITY_FAILED' }); assert.equal(f.store.get(['nodeSetup']), undefined);
  f.software.install = async () => ({ executable: process.execPath });
  await assert.rejects(f.start(), { code: 'EASY_NODE_CHANGED' }); assert.equal(f.store.get(['nodeSetup']), undefined);
});

test('space and collisions are rechecked after downloading but before creating node data', async t => {
  const f = await fixture(t); f.behavior.install = async () => { f.capacity.availableBytes = 1; };
  await assert.rejects(f.start(), { code: 'EASY_NODE_REVIEW_REQUIRED' }); assert.equal(f.store.get(['nodeSetup']), undefined);
  f.capacity.availableBytes = 100 * 1024 ** 3;
  f.behavior.install = async () => { await f.store.mutate(state => state.localServices.push({ id: 'guided-core-mainnet' })); };
  await assert.rejects(f.start(), { code: 'NODE_SETUP_COLLISION' }); assert.equal(f.store.get(['nodeSetup']), undefined);
});

test('startup failure retains a saved setup and supports status, normal start and stop without reinstall', async t => {
  const f = await fixture(t); f.behavior.failStart = true;
  const result = await f.start(); assert.equal(result.committed, true); assert.match(result.startWarning, /do not install again/);
  assert.equal(result.status, null); assert.equal(f.manager.saved(result.setupId).id, result.setupId);
  f.behavior.failStart = false; await f.manager.run({ action: 'start', setupId: result.setupId });
  await f.manager.run({ action: 'stop', setupId: result.setupId });
  assert.equal(f.calls.filter(call => call === 'install:core').length, 1); assert.ok(f.calls.includes('stop:guided-core-mainnet'));
});

test('postcommit refresh errors expose recovery identity and never start an unacknowledged setup', async t => {
  const f = await fixture(t); f.behavior.failRefresh = true;
  await assert.rejects(f.start(), cause => cause.code === 'NODE_SETUP_SAVED_REFRESH_FAILED' && cause.details.setupCommitted && Boolean(cause.details.setupId));
  assert.ok(f.store.get(['nodeSetup'])); assert.equal(f.calls.some(call => call.startsWith('start:')), false);
});

test('shutdown drains an admitted easy download and leaves no node to start', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred(); f.gates.push(gate);
  f.behavior.install = async () => { entered.resolve(); await gate.promise; };
  const p = await f.preview(); const starting = f.manager.run({ action: 'easy-start', token: p.token });
  const rejected = assert.rejects(starting, { code: 'APP_SHUTTING_DOWN' }); await entered.promise;
  let drained = false; const shutting = f.manager.shutdown().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
  gate.resolve(); await rejected; await shutting;
  assert.equal(f.store.get(['nodeSetup']), undefined); assert.equal(f.calls.some(call => call.startsWith('start:')), false);
});

test('cancellation after saving does not interrupt persistence or silently stop an approved startup', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred(); f.gates.push(gate);
  const original = f.services.start;
  f.services.start = async id => { entered.resolve(); await gate.promise; return original(id); };
  const p = await f.preview(); const starting = f.manager.run({ action: 'easy-start', token: p.token }); await entered.promise;
  assert.ok(f.store.get(['nodeSetup']));
  const value = await f.manager.run({ action: 'easy-cancel', token: p.token });
  assert.equal(value.cancelled, false); assert.equal(value.canCancel, false); assert.equal(value.phase, 'starting');
  gate.resolve(); const result = await starting; assert.equal(result.committed, true); assert.equal(result.services[0].status, 'running');
});

test('final service readback failure after startup still reports the durable recovery identity', async t => {
  const f = await fixture(t), original = f.services.list;
  let reads = 0;
  f.services.list = () => { reads += 1; if (reads > 1) throw new Error('synthetic final read failure'); return original(); };
  await assert.rejects(f.start(), cause => cause.code === 'NODE_SETUP_SAVED_REFRESH_FAILED' && cause.details.setupCommitted && Boolean(cause.details.setupId));
  assert.ok(f.store.get(['nodeSetup'])); assert.equal(f.calls.filter(call => call.startsWith('install:')).length, 1);
});
