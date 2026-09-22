import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultNodeSetupDraft, buildNodeSetupPlan } from '../src/main/node-setup-plan.js';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';
import { StateStore } from '../src/main/state-store.js';
import { inspectSnapshotFile } from '../src/main/node-snapshot-file.js';
import { CORE_SNAPSHOT_BASES, parseCoreChainstates, isQuickStart } from '../src/shared/node-snapshot.js';
import { nodeSetupGuidance } from '../src/shared/node-setup-guidance.js';
import { createNodeSetupDialogs } from '../src/main/node-setup-dialogs.js';

const base = CORE_SNAPSHOT_BASES[0], tip = 'a'.repeat(64), tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const header = () => {
  // Metadata-only fixture. NOT a valid UTXO snapshot; cryptographic validation
  // belongs to native Core and is not simulated as qualification here.
  const b = Buffer.alloc(52); Buffer.from([0x75, 0x74, 0x78, 0x6f, 0xff]).copy(b);
  b.writeUInt16LE(2, 5); Buffer.from('f9beb4d9', 'hex').copy(b, 7); Buffer.from(base.hash, 'hex').reverse().copy(b, 11); b.writeBigUInt64LE(2n, 43); return b;
};
const chain = (blocks = 100, validated = true, snapshot = false) => ({ blocks, validated, bestblockhash: tip, verificationprogress: blocks / 1000000, ...(snapshot ? { snapshot_blockhash: base.hash } : {}) });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-snapshot-'));
  let manager;
  t.after(async () => { await manager?.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const store = new StateStore(path.join(root, 'state'), null); await store.init();
  await store.mutate(s => { s.providers = []; s.localServices = []; s.settings.network = 'mainnet'; s.settings.offlineMode = false; });
  const file = path.join(root, 'fixture.dat'); await fs.writeFile(file, header(), { flag: 'wx' });
  const calls = [], processes = new Map();
  const b = { confirm: true, pid: 32100, pick: file, version: 310100, headers: 1000000, blocks: 100, pruned: true, network: 'main', chains: [chain()], load: null, rpc: null };
  const services = { processes, editing: new Map(), starting: new Map(), stopping: new Map(), removing: new Map(),
    list: () => store.get(['localServices']).map(s => ({ ...s, status: processes.has(s.id) ? 'running' : 'stopped', pid: processes.get(s.id)?.pid })),
    start: async id => { processes.set(id, { pid: b.pid }); calls.push(['start', id]); }, stop: async id => { processes.delete(id); calls.push(['stop', id]); } };
  const core = { rpc: async (method, params, options) => {
    calls.push([method, params]); if (b.rpc) await b.rpc(method);
    if (method === 'loadtxoutset') { if (b.load) return { result: await b.load(options) }; return { result: { tip_hash: base.hash, base_height: base.height, coins_loaded: 2 } }; }
    const result = method === 'getnetworkinfo' ? { version: b.version }
      : method === 'getblockchaininfo' ? { chain: b.network, blocks: b.blocks, headers: b.headers, initialblockdownload: b.blocks < b.headers, verificationprogress: .4, pruned: b.pruned }
      : method === 'getchainstates' ? { headers: b.headers, chainstates: b.chains }
      : method === 'getblockheader' ? { hash: base.hash, height: base.height } : assert.fail(method);
    return { result };
  } };
  manager = new NodeSetupManager({ stateStore: store, rootDirectory: path.join(root, 'nodes'), localServiceManager: services,
    providerManager: { providerMutations: new Set(), blockedProviders: new Set(), assertNoPendingCleanup() {}, invalidateRouting() {}, refresh() {}, list: () => store.get(['providers']) },
    software: { catalog: () => ({}), discover: async () => ({}), shutdown: async () => {} }, coreFactory: () => core,
    pick: async kind => { calls.push(['pick', kind]); return { path: b.pick }; }, confirm: async (action, value) => { calls.push(['confirm', action]); return typeof b.confirm === 'function' ? b.confirm(action, value) : b.confirm; } });
  const draft = defaultNodeSetupDraft({ rootDirectory: path.join(root, 'nodes') });
  draft.choice = 'core'; Object.assign(draft.core, { executable: process.execPath, storage: 'pruned', sync: 'snapshot' });
  const preview = await manager.run({ action: 'preview', draft });
  const saved = await manager.run({ action: 'apply', token: preview.token });
  const id = saved.setupId;
  const start = () => manager.run({ action: 'start', setupId: id });
  const select = () => manager.run({ action: 'snapshot-select', setupId: id });
  const load = token => manager.run({ action: 'snapshot-load', setupId: id, token });
  return { root, store, manager, file, calls, b, draft, id, start, select, load, services };
}

test('quick-start plan is explicit, compact, mainnet-only and does not change witness validation flags', () => {
  const d = defaultNodeSetupDraft({ rootDirectory: '/tmp/fixture' }); d.choice = 'core'; d.core.executable = '/fixture/core'; d.core.storage = 'pruned';
  const standard = buildNodeSetupPlan(d); d.core.sync = 'snapshot'; const quick = buildNodeSetupPlan(d);
  assert.deepEqual(quick.services, standard.services); assert.deepEqual(quick.providers, standard.providers);
  assert.ok(quick.services[0].args.includes('-prune=10000')); assert.ok(quick.services[0].args.includes('-txindex=0'));
  assert.doesNotMatch(quick.services[0].args.join(' '), /assumevalid|witness|loadtxoutset/);
  assert.equal(nodeSetupGuidance(d).recommendedBytes, 60 * 1024 ** 3);
  assert.equal(isQuickStart(d), true);
  for (const change of [x => { x.network = 'signet'; }, x => { x.core.mode = 'existing'; }, x => { x.core.storage = 'archive'; }, x => { x.choice = 'both'; }, x => { x.choice = 'none'; }]) {
    const invalid = structuredClone(d); change(invalid); assert.throws(() => buildNodeSetupPlan(invalid), { code: 'INVALID_NODE_SETUP' });
  }
  const invalid = structuredClone(d); invalid.core.sync = 'witness-free'; assert.throws(() => buildNodeSetupPlan(invalid));
});

test('bounded file inspection recognizes only reviewed mainnet metadata and never claims UTXO verification', async t => {
  const f = await fixture(t); const value = await inspectSnapshotFile(f.file);
  assert.equal(value.baseHash, base.hash); assert.equal(value.baseHeight, base.height); assert.equal(value.coins, '2'); assert.equal(value.bytes, 52);
  for (const mutate of [b => b.fill(0, 0, 5), b => b.writeUInt16LE(1, 5), b => b.fill(0, 7, 11), b => b.fill(0, 11, 43), b => b.writeBigUInt64LE(0n, 43), b => b.writeBigUInt64LE(2n ** 64n - 1n, 43)]) {
    const body = header(); mutate(body); await fs.writeFile(f.file, body); await assert.rejects(inspectSnapshotFile(f.file), { code: 'NODE_SNAPSHOT_FILE_INVALID' });
  }
  await fs.writeFile(f.file, header().subarray(0, 30)); await assert.rejects(inspectSnapshotFile(f.file));
  await assert.rejects(inspectSnapshotFile(f.root)); await assert.rejects(inspectSnapshotFile('relative.dat'));
  const link = path.join(f.root, 'link.dat'); await fs.symlink(f.file, link); await assert.rejects(inspectSnapshotFile(link), { code: 'NODE_SNAPSHOT_FILE_INVALID' });
});

test('chainstate validation distinguishes current snapshot, background chain and historical completion', () => {
  const value = { headers: 1000000, chainstates: [chain(600000), chain(1000000, false, true)] };
  const parsed = parseCoreChainstates(value); assert.equal(parsed.active.blocks, 1000000); assert.equal(parsed.historicalValidated, false); assert.equal(parsed.background.blocks, 600000);
  assert.equal(parseCoreChainstates({ ...value, chainstates: [chain(1000000, true, true)] }).historicalValidated, true);
  for (const bad of [null, {}, { ...value, headers: '1000000' }, { ...value, chainstates: [] }, { ...value, chainstates: [chain(1000000, false, true)] }, { ...value, chainstates: [chain(1000001)] }, { ...value, chainstates: [{ ...chain(), validated: 'true' }] }, { ...value, chainstates: [{ ...chain(), verificationprogress: NaN }] }]) assert.throws(() => parseCoreChainstates(bad));
});

test('selection requires exact setup and owned running process, rejects arbitrary IPC paths and cancellation is inert', async t => {
  const f = await fixture(t);
  await assert.rejects(f.select(), { code: 'NODE_SNAPSHOT_CORE_STOPPED' });
  await assert.rejects(f.manager.run({ action: 'snapshot-select' }), { code: 'NODE_SNAPSHOT_SETUP_REQUIRED' });
  await assert.rejects(f.manager.run({ action: 'snapshot-load', setupId: f.id, path: f.file }), { code: 'INVALID_NODE_SETUP_ACTION' });
  await assert.rejects(f.manager.run({ action: 'pick', kind: 'snapshot' }), { code: 'INVALID_NODE_SETUP_ACTION' });
  await f.start(); f.b.pick = null; assert.deepEqual(await f.select(), { selection: null });
  assert.equal(f.calls.some(c => c[0] === 'loadtxoutset'), false);
});

test('select, confirm and import are separate; dispatch persists once and leaves the selected file untouched', async t => {
  const f = await fixture(t); await f.start(); const selected = await f.select();
  assert.equal(selected.selection.baseHeight, base.height); assert.equal('path' in selected.selection, false); assert.match(selected.selection.message, /Header recognized only/);
  assert.equal(f.calls.some(c => c[0] === 'loadtxoutset'), false);
  const gate = deferred(); f.b.load = async options => { assert.equal(options.timeoutMs, 1800000); assert.equal(options.maxBytes, 65536); assert.equal(f.store.get(['nodeSetup']).snapshotAttempt.phase, 'loading'); await Promise.race([gate.promise, new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))]); return { tip_hash: base.hash, base_height: base.height, coins_loaded: 2 }; };
  const response = await f.load(selected.selection.token); assert.equal(response.snapshot.phase, 'loading');
  assert.equal((await f.manager.run({ action: 'status', setupId: f.id })).core.phase, 'snapshot-loading');
  await assert.rejects(f.load(selected.selection.token), { code: 'NODE_SNAPSHOT_BUSY' });
  gate.resolve(); await f.manager.snapshots.operation;
  assert.equal(f.store.get(['nodeSetup']).snapshotAttempt.phase, 'accepted');
  assert.equal(f.calls.filter(c => c[0] === 'loadtxoutset').length, 1); assert.deepEqual(f.calls.find(c => c[0] === 'loadtxoutset')[1], [await fs.realpath(f.file)]);
  assert.equal(f.calls.filter(c => c[0] === 'confirm' && c[1] === 'snapshot').length, 1);
  assert.deepEqual(await fs.readFile(f.file), header()); assert.doesNotMatch(JSON.stringify(f.store.get(['nodeSetup']).snapshotAttempt), /fixture.dat/);
  assert.equal(f.manager.saved(f.id).id, f.id);
});

test('native rejection, changed files and expired selections cannot dispatch import', async t => {
  const f = await fixture(t); await f.start(); let selected = await f.select();
  f.b.confirm = false; await assert.rejects(f.load(selected.selection.token), { code: 'USER_REJECTED' }); f.b.confirm = true;
  await fs.writeFile(f.file, Buffer.concat([header(), Buffer.from('changed')]));
  await assert.rejects(f.load(selected.selection.token), { code: 'NODE_SNAPSHOT_FILE_CHANGED' });
  selected = await f.select(); f.manager.now = () => Date.now() + 20 * 60_000;
  await assert.rejects(f.load(selected.selection.token), { code: 'NODE_SNAPSHOT_SELECTION_EXPIRED' });
  assert.equal(f.calls.some(c => c[0] === 'loadtxoutset'), false);
});

test('post-confirmation privacy, file and process changes recheck before mutating RPC', async t => {
  for (const kind of ['offline', 'file', 'process', 'ownership']) await t.test(kind, async t => {
    const f = await fixture(t); await f.start(); const selected = await f.select();
    f.b.confirm = async action => {
      if (action === 'snapshot') {
        if (kind === 'offline') await f.store.updateSettings({ offlineMode: true });
        if (kind === 'file') await fs.writeFile(f.file, Buffer.concat([header(), Buffer.from('changed')]));
        if (kind === 'process') f.services.processes.clear();
        if (kind === 'ownership') await f.store.mutate(s => { s.localServices[0].args.push('-user-edited'); });
      }
      return true;
    };
    await assert.rejects(f.load(selected.selection.token)); assert.equal(f.calls.some(c => c[0] === 'loadtxoutset'), false);
  });
});

test('preflight refuses unsupported versions, wrong mode, missing headers, loaded snapshot and already-passed base', async t => {
  for (const kind of ['version', 'network', 'pruning', 'headers', 'loaded', 'passed']) await t.test(kind, async t => {
    const f = await fixture(t); await f.start(); const selected = await f.select();
    if (kind === 'version') f.b.version = 300000;
    if (kind === 'network') f.b.network = 'signet';
    if (kind === 'pruning') f.b.pruned = false;
    if (kind === 'headers') f.b.headers = 1000;
    if (kind === 'loaded') f.b.chains = [chain(100), chain(960000, false, true)];
    if (kind === 'passed') f.b.chains = [chain(base.height)];
    await assert.rejects(f.load(selected.selection.token)); assert.equal(f.calls.some(c => c[0] === 'loadtxoutset'), false);
  });
});

test('failed intent persistence prevents dispatch and insufficient workspace cannot import', async t => {
  const f = await fixture(t); await f.start(); const selected = await f.select();
  const stat = t.mock.method(fs, 'statfs', async () => ({ bavail: 1, bsize: 1024 ** 3 }));
  await assert.rejects(f.load(selected.selection.token), { code: 'NODE_SNAPSHOT_DISK_LOW' }); stat.mock.restore();
  const original = f.store.mutate.bind(f.store); f.store.mutate = async () => { throw new Error('synthetic save failure'); };
  await assert.rejects(f.load(selected.selection.token), /synthetic save failure/); f.store.mutate = original;
  assert.equal(f.calls.some(c => c[0] === 'loadtxoutset'), false);
});

test('RPC failure is unknown, persists across reopening and cannot be retried on the same process', async t => {
  const f = await fixture(t); await f.start(); const selected = await f.select();
  f.b.load = async () => { throw new Error('synthetic transport failure containing private diagnostic'); };
  await f.load(selected.selection.token); await f.manager.snapshots.operation;
  assert.equal(f.store.get(['nodeSetup']).snapshotAttempt.phase, 'unknown');
  const reopened = new StateStore(f.store.directory, null); await reopened.init();
  assert.equal(reopened.get(['nodeSetup']).snapshotAttempt.phase, 'unknown');
  assert.doesNotMatch(JSON.stringify(f.manager.snapshots.feedback), /private diagnostic/);
  const next = await f.select(); await assert.rejects(f.load(next.selection.token), { code: 'NODE_SNAPSHOT_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.filter(c => c[0] === 'loadtxoutset').length, 1);
  await f.manager.run({ action: 'stop', setupId: f.id }); f.b.pid++; await f.start();
  f.b.load = null; await f.load((await f.select()).selection.token); await f.manager.snapshots.operation;
  assert.equal(f.calls.filter(c => c[0] === 'loadtxoutset').length, 2);
});

test('mismatched import response never claims acceptance', async t => {
  const f = await fixture(t); await f.start();
  f.b.load = async () => ({ tip_hash: tip, base_height: base.height, coins_loaded: 2 });
  await f.load((await f.select()).selection.token); await f.manager.snapshots.operation;
  assert.equal(f.store.get(['nodeSetup']).snapshotAttempt.phase, 'unknown');
});

for (const action of ['offline', 'stop', 'shutdown']) test(`${action} cancels RPC observation without claiming cancellation of Core import`, async t => {
  const f = await fixture(t); await f.start(); const entered = deferred(); let observedSignal;
  f.b.load = options => { observedSignal = options.signal; entered.resolve(); return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }); };
  await f.load((await f.select()).selection.token); await entered.promise;
  const pending = f.manager.snapshots.operation;
  if (action === 'offline') { await f.store.updateSettings({ offlineMode: true }); f.manager.settingsChanged(f.store.get(['settings'])); }
  if (action === 'stop') await f.manager.run({ action: 'stop', setupId: f.id });
  if (action === 'shutdown') await f.manager.shutdown();
  await pending;
  assert.equal(observedSignal.aborted, true); assert.equal(f.store.get(['nodeSetup']).snapshotAttempt.phase, 'unknown');
  assert.match(f.manager.snapshots.feedback.message, /Core may still be working/);
});

test('actual status separates network tip from historical validation and fails closed on malformed chainstates', async t => {
  const f = await fixture(t); await f.start(); f.b.blocks = f.b.headers;
  f.b.chains = [chain(600000), chain(1000000, false, true)];
  let value = await f.manager.run({ action: 'status', setupId: f.id });
  assert.equal(value.core.phase, 'current-validating'); assert.equal(value.core.current, true); assert.equal(value.core.historicalValidated, false); assert.equal(value.core.backgroundBlocks, 600000);
  f.b.chains = [chain(1000000, true, true)]; value = await f.manager.run({ action: 'status', setupId: f.id });
  assert.equal(value.core.phase, 'ready'); assert.equal(value.core.historicalValidated, true);
  f.b.chains = []; value = await f.manager.run({ action: 'status', setupId: f.id });
  assert.notEqual(value.core.phase, 'ready'); assert.equal(value.core.historicalValidated, undefined);
});

test('automatic startup never imports a snapshot or opens a file picker', async t => {
  const f = await fixture(t); await f.store.mutate(s => { s.nodeSetup.autoStart = true; });
  await f.manager.autoStart(); await tick();
  assert.equal(f.calls.some(c => ['pick', 'loadtxoutset'].includes(c[0])), false);
});

test('native snapshot picker and confirmation are cancel-default, explicit and do not imply verified header data', async () => {
  const calls = [];
  const dialog = createNodeSetupDialogs({ showOpenDialog: async (_window, options) => { calls.push(options); return { canceled: true }; }, showMessageBox: async (_window, options) => { calls.push(options); return { response: 0 }; } }, () => null);
  assert.deepEqual(await dialog.pick('snapshot'), { path: null });
  assert.equal(await dialog.confirm('snapshot', { path: '/fixture/snapshot.dat', baseHeight: base.height, baseHash: base.hash }), false);
  const review = calls.at(-1); assert.equal(review.defaultId, 0); assert.deepEqual(review.buttons, ['Cancel', 'Import snapshot']);
  assert.match(review.detail, /Only the file header/); assert.match(review.detail, /does not cancel/); assert.match(review.detail, /No funds/);
});
