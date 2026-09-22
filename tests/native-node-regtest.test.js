import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildNativeRegtestPlan, assertRegtestSnapshot, REGTEST_GENESIS,
  REGTEST_ISOLATION_FLAGS, REGTEST_RPC_METHODS, regtestDigest
} from '../scripts/native-node-regtest-plan.mjs';
import {
  parseRegtestArguments, executeNativeRegtest, runRegtestScenarios,
  measureRegtestDirectory, resolveRegtestBlock, assertRegtestProviderSet,
  retainRegtestAbort, verifyRegtestFinalIdentity, assertRegtestInstallation,
  closeRegtestAdmissions, confirmRegtestPlan, retainRegtestInterruption, publishRegtestEvidence
} from '../scripts/native-node-regtest.mjs';
import { ProviderManager } from '../src/main/provider-manager.js';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';

const SOURCE = 'a'.repeat(64);
const specification = () => ({ schemaVersion: 1, root: '/private/tmp/satoshi-browser-regtest-test-20260908',
  core: { path: '/not-installed/bitcoind', sha256: 'b'.repeat(64) },
  ord: { path: '/not-installed/ord', sha256: 'c'.repeat(64) },
  ports: { coreOnlyRpc: 28443, pairRpc: 28444, pairOrd: 28080, ordOnlyHttp: 28081 },
  maxRunMs: 1800000, maxGrowthBytes: 2147483648 });
const plan = () => buildNativeRegtestPlan(specification(), SOURCE);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('pure native plan fixes five scenarios, exact inactive peer flags, loopback paths and no autostart', () => {
  const value = plan();
  assert.deepEqual(value.scenarios.map(item => item.id), ['core-only', 'both', 'ord-only', 'existing-only', 'none']);
  assert.equal(value.sourceSha256, SOURCE);
  assert.equal(value.platform, 'darwin'); assert.equal(value.architecture, 'arm64');
  for (const item of value.scenarios) {
    assert.equal(item.plan.draft.autoStart, false); assert.equal(item.plan.draft.network, 'regtest');
    for (const service of item.plan.services) {
      assert.equal(service.autoStart, false);
      assert.ok(service.cwd.startsWith(`${value.spec.root}/`));
      if (service.id === 'guided-core-regtest') assert.deepEqual(service.args.slice(-5), [...REGTEST_ISOLATION_FLAGS]);
    }
  }
  const [core, both, ord, existing, none] = value.scenarios.map(item => item.plan);
  assert.equal(core.services.length, 1); assert.equal(both.services.length, 2);
  assert.equal(ord.services.length, 1); assert.equal(existing.services.length, 0); assert.equal(none.services.length, 0);
  assert.equal(ord.draft.core.cookieFile, both.draft.core.cookieFile);
  assert.equal(existing.draft.core.cookieFile, both.draft.core.cookieFile);
  assert.equal(ord.summary.coreUrl, both.summary.coreUrl);
  assert.notEqual(ord.summary.ordUrl, both.summary.ordUrl);
  assert.match(value.storagePolicy, /no hard filesystem quota/);
  assert.match(value.networkPolicy, /not an OS firewall/);
  assert.match(value.retentionPolicy, /no automatic data deletion/);
});

test('plan hash binds normalized input, generated commands, source identity and every limit', () => {
  const value = plan(); const { planSha256, ...payload } = value;
  assert.equal(planSha256, regtestDigest(payload));
  assert.deepEqual(plan(), value); assert.ok(Object.isFrozen(value.scenarios[0].plan.services[0].args));
  for (const change of [s => s.maxRunMs--, s => s.maxGrowthBytes--, s => s.ports.pairOrd += 2,
    s => s.core.sha256 = 'd'.repeat(64), s => s.root += '-next']) {
    const input = specification(); change(input);
    assert.notEqual(buildNativeRegtestPlan(input, SOURCE).planSha256, value.planSha256);
  }
  assert.notEqual(buildNativeRegtestPlan(specification(), 'd'.repeat(64)).planSha256, value.planSha256);
});

test('manifest rejects broad roots, traversal, credentials, external endpoints, arbitrary RPC and coercions', () => {
  for (const root of ['/', '/private/tmp', '/private/tmp/satoshi-browser-regtest-a', '/tmp/satoshi-browser-regtest-test-20260908',
    '/private/tmp/satoshi-browser-regtest-test-20260908/child', '/Users/patches', '/private/tmp/satoshi-browser-regtest-../../home']) {
    assert.throws(() => buildNativeRegtestPlan({ ...specification(), root }, SOURCE), { code: 'REGTEST_ROOT_INVALID' });
  }
  for (const mutate of [s => s.credentials = {}, s => s.rpcMethods = ['setnetworkactive'], s => s.url = 'https://example.com',
    s => s.core.username = 'never-a-credential', s => s.schemaVersion = 2, s => delete s.ports.pairOrd]) {
    const value = specification(); mutate(value);
    assert.throws(() => buildNativeRegtestPlan(value, SOURCE), { code: 'REGTEST_MANIFEST_INVALID' });
  }
  let accessed = false; const getter = specification();
  Object.defineProperty(getter, 'root', { get() { accessed = true; return specification().root; }, enumerable: true });
  assert.throws(() => buildNativeRegtestPlan(getter, SOURCE), { code: 'REGTEST_MANIFEST_INVALID' });
  assert.equal(accessed, false);
  assert.ok(!REGTEST_RPC_METHODS.includes('setnetworkactive'));
  assert.ok(!REGTEST_RPC_METHODS.includes('createwallet'));
  assert.ok(!REGTEST_RPC_METHODS.includes('sendtoaddress'));
});

test('manifest binary, port, time and storage limits reject malformed and unsafe values', () => {
  for (const executable of ['relative', '/', '/usr/../bin/bitcoind', '/path\n/bitcoind']) {
    const value = specification(); value.core.path = executable;
    assert.throws(() => buildNativeRegtestPlan(value, SOURCE), { code: 'REGTEST_BINARY_INVALID' });
  }
  for (const mutate of [s => s.core.sha256 = 'A'.repeat(64), s => s.ord.path = s.core.path,
    s => s.core.path = `${s.root}/bitcoind`]) {
    const value = specification(); mutate(value);
    assert.throws(() => buildNativeRegtestPlan(value, SOURCE), { code: 'REGTEST_BINARY_INVALID' });
  }
  for (const port of [0, 80, 65536, '28080', 1.5, 28443]) {
    const value = specification(); value.ports.pairOrd = port;
    assert.throws(() => buildNativeRegtestPlan(value, SOURCE), { code: 'REGTEST_PORT_INVALID' });
  }
  for (const maxRunMs of [0, 59999, 1800001, '1800000']) assert.throws(() => buildNativeRegtestPlan({ ...specification(), maxRunMs }, SOURCE), { code: 'REGTEST_DEADLINE_INVALID' });
  for (const maxGrowthBytes of [0, 1048575, 2147483649, '2147483648']) assert.throws(() => buildNativeRegtestPlan({ ...specification(), maxGrowthBytes }, SOURCE), { code: 'REGTEST_STORAGE_INVALID' });
});

test('CLI is help/plan only unless execute and an exact confirmation hash are both explicit', async () => {
  assert.deepEqual(parseRegtestArguments([]), { help: true });
  assert.equal(parseRegtestArguments(['--manifest', '/private/tmp/review.json']).execute, false);
  for (const args of [['--execute'], ['--manifest', 'relative'], ['--manifest', '/x', '--execute'],
    ['--manifest', '/x', '--approved-plan-sha256', SOURCE], ['--manifest', '/x', '--execute', '--approved-plan-sha256', 'yes'],
    ['--manifest', '/x', '--execute', '--execute'], ['--wallet'], ['--manifest', '/x', '--root', '/']]) {
    assert.throws(() => parseRegtestArguments(args), { code: 'REGTEST_ARGUMENT_INVALID' });
  }
  assert.equal(parseRegtestArguments(['--execute', '--manifest', '/x', '--approved-plan-sha256', SOURCE]).execute, true);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/native-node-regtest.mjs', '--help'], { timeout: 10000 });
  assert.match(stdout, /plan-only by default/); assert.equal(stderr, '');
});

test('execution rejects missing/mismatched approval and pre-aborted work before inspecting binaries or creating a run', async () => {
  const value = plan();
  for (const approved of [undefined, true, 'approved', SOURCE]) {
    await assert.rejects(executeNativeRegtest(value, approved), { code: 'REGTEST_EXECUTION_NOT_APPROVED' });
  }
  const controller = new AbortController(); controller.abort(Object.assign(new Error('cancelled'), { code: 'TEST_CANCELLED' }));
  await assert.rejects(executeNativeRegtest(value, value.planSha256, { signal: controller.signal }), { code: 'TEST_CANCELLED' });
});

const snapshot = () => ({ chain: 'regtest', blocks: 0, headers: 0, bestblockhash: REGTEST_GENESIS,
  initialblockdownload: true, pruned: false, unexpectedSecret: 'must-not-be-returned' });
const inactive = () => ({ networkactive: false, connections: 0, version: 310100, unexpectedSecret: 'must-not-be-returned' });

test('readiness snapshot enforces regtest, inactive P2P, exact tip, and only returns public fields', () => {
  const result = assertRegtestSnapshot(snapshot(), inactive(), REGTEST_GENESIS, 0);
  assert.deepEqual(Object.keys(result), ['chain', 'blocks', 'headers', 'bestblockhash', 'initialblockdownload', 'networkactive', 'connections', 'coreVersion']);
  assert.equal(JSON.stringify(result).includes('must-not-be-returned'), false);
  for (const patch of [{ chain: 'main' }, { pruned: true }, { blocks: '0' }, { headers: 1 },
    { initialblockdownload: 0 }, { bestblockhash: 'x' }, { blocks: -1 }]) {
    assert.throws(() => assertRegtestSnapshot({ ...snapshot(), ...patch }, inactive()), { code: 'REGTEST_CHAIN_INVALID' });
  }
  for (const patch of [{ networkactive: true }, { networkactive: 0 }, { connections: 1 }, { connections: '0' }]) {
    assert.throws(() => assertRegtestSnapshot(snapshot(), { ...inactive(), ...patch }), { code: 'REGTEST_PEER_POLICY_CHANGED' });
  }
  assert.throws(() => assertRegtestSnapshot(snapshot(), inactive(), SOURCE, 0), { code: 'REGTEST_TIP_CHANGED' });
  assert.throws(() => assertRegtestSnapshot(snapshot(), inactive(), REGTEST_GENESIS, 1), { code: 'REGTEST_TIP_CHANGED' });
  assert.throws(() => assertRegtestSnapshot(snapshot(), { ...inactive(), version: 310000 }), { code: 'REGTEST_CORE_VERSION_MISMATCH' });
});

function syntheticRuntime(failure) {
  const calls = [];
  return { calls, async open(id) {
    calls.push(`${id}:open`);
    return Object.fromEntries(['none', 'save', 'reopen', 'start', 'seed', 'ready', 'lookup', 'stop', 'assertStillRunning'].map(action => [action, async () => {
      calls.push(`${id}:${action}`);
      if (`${id}:${action}` === failure) throw Object.assign(new Error('synthetic failure'), { code: 'SYNTHETIC_FAILURE' });
    }]));
  } };
}

test('scenario driver proves required ordering and checks externally owned pair after every connected stop', async () => {
  const runtime = syntheticRuntime(); let checkpoints = 0;
  const result = await runRegtestScenarios(plan(), runtime, async () => { checkpoints++; });
  assert.deepEqual(result.map(item => item.id), ['none', 'core-only', 'ord-only', 'existing-only', 'both']);
  assert.equal(checkpoints, 5);
  assert.deepEqual(runtime.calls.filter(item => item.startsWith('core-only:')), [
    'core-only:open', 'core-only:save', 'core-only:reopen', 'core-only:start', 'core-only:seed',
    'core-only:ready', 'core-only:lookup', 'core-only:stop', 'core-only:reopen', 'core-only:start',
    'core-only:ready', 'core-only:lookup', 'core-only:stop'
  ]);
  assert.ok(runtime.calls.indexOf('both:ready') < runtime.calls.indexOf('ord-only:start'));
  assert.equal(runtime.calls.filter(item => item === 'both:assertStillRunning').length, 3);
  for (const id of ['ord-only', 'existing-only']) {
    for (const [index, action] of runtime.calls.entries()) if (action === `${id}:stop`) {
      assert.equal(runtime.calls[index + 1], 'both:assertStillRunning');
    }
  }
  assert.equal(runtime.calls.some(item => /(?:existing-only|ord-only):seed/.test(item)), false);
});

test('scenario driver never marks later cases passing or continues effects after a failed required operation', async () => {
  for (const failure of ['core-only:save', 'core-only:seed', 'both:ready', 'ord-only:stop', 'both:assertStillRunning']) {
    const runtime = syntheticRuntime(failure);
    await assert.rejects(runRegtestScenarios(plan(), runtime, async () => {}), { code: 'SYNTHETIC_FAILURE' });
    assert.equal(runtime.calls.at(-1), failure);
  }
  const runtime = syntheticRuntime();
  await assert.rejects(runRegtestScenarios(plan(), runtime, async () => { throw new Error('checkpoint failure'); }), /checkpoint failure/);
  assert.deepEqual(runtime.calls, ['none:open', 'none:none']);
});

test('block lookup unwraps real ProviderManager output and requests each exact provider without fallback substitution', async () => {
  const configs = ['first', 'second'].map(id => ({ id, name: id, type: 'mock', network: 'regtest', enabled: true, local: true, priority: 5, capabilities: ['block'], baseUrl: '' }));
  const settings = { network: 'regtest', localOnly: true, offlineMode: false, preferredProviderId: null, requestTimeoutMs: 100, maxResourceBytes: 65536 };
  const store = { get: ([key]) => key === 'settings' ? settings : configs, getProviderCleanups: () => [] };
  const manager = new ProviderManager(store, { has: () => false, get: () => null }, null);
  const calls = [];
  for (const provider of manager.instances.values()) provider.resolve = async target => {
    calls.push(provider.id); assert.equal(target.value, '1');
    return { network: 'regtest', source: { id: provider.id }, summary: { hash: SOURCE, height: 1 } };
  };
  for (const id of ['first', 'second']) assert.deepEqual(await resolveRegtestBlock(manager, id, { blockHash: SOURCE }, {}), { provider: id, blockHash: SOURCE });
  assert.deepEqual(calls, ['first', 'second']);
  manager.instances.get('first').resolve = async () => { throw Object.assign(new Error('unavailable'), { code: 'PROVIDER_NETWORK_ERROR' }); };
  await assert.rejects(resolveRegtestBlock(manager, 'first', { blockHash: SOURCE }, {}), { code: 'REGTEST_LOOKUP_MISMATCH' });
  await manager.shutdown();
});

test('required provider coverage rejects empty, missing, extra and changed instances instead of passing vacuously', () => {
  const expected = plan().scenarios.find(item => item.id === 'both').plan.providers;
  const instances = () => new Map(expected.map(config => [config.id, { config: structuredClone(config) }]));
  assert.doesNotThrow(() => assertRegtestProviderSet({ instances: instances() }, expected));
  const missing = instances(); missing.delete(expected[1].id);
  const extra = instances(); extra.set('unexpected', { config: { id: 'unexpected' } });
  const changed = instances(); changed.get(expected[0].id).config.baseUrl = 'http://127.0.0.1:30000';
  for (const value of [new Map(), missing, extra, changed]) {
    assert.throws(() => assertRegtestProviderSet({ instances: value }, expected), { code: 'REGTEST_PROVIDER_SET_MISMATCH' });
  }
});

test('late monitor or interruption remains a failure after a completed final checkpoint', async () => {
  for (const code of ['REGTEST_STORAGE_LIMIT', 'REGTEST_INTERRUPTED', 'REGTEST_DEADLINE']) {
    const controller = new AbortController(), report = { result: 'PASS', errors: [] };
    const monitor = Promise.resolve().then(() => controller.abort(Object.assign(new Error('not copied'), { code })));
    await monitor;
    retainRegtestAbort(report, controller.signal);
    controller.abort(Object.assign(new Error('normal drain'), { code: 'REGTEST_DRAINING' }));
    assert.equal(report.result, 'FAIL');
    assert.deepEqual(report.errors, [{ phase: 'abort', code }]);
  }
  const control = { result: 'PASS', errors: [] };
  retainRegtestAbort(control, new AbortController().signal);
  assert.deepEqual(control, { result: 'PASS', errors: [] });
});

test('final source/binary mismatch or unavailable readback prevents successful identity attribution', async () => {
  const identity = { binaries: [{ sha256: SOURCE }], sourceFiles: [{ path: 'source.js', sha256: SOURCE }] };
  for (const validate of [async () => { throw Object.assign(new Error('not copied'), { code: 'REGTEST_SOURCE_CHANGED' }); },
    async () => ({ ...identity, binaries: [] }), async () => ({ ...identity, sourceFiles: [] })]) {
    const report = { result: 'PASS', errors: [], ...structuredClone(identity) };
    await verifyRegtestFinalIdentity(report, plan(), validate);
    assert.equal(report.result, 'FAIL'); assert.equal(report.finalIdentityVerified, false);
    assert.equal(report.errors.length, 1);
  }
  const report = { result: 'PASS', errors: [], ...structuredClone(identity) };
  await verifyRegtestFinalIdentity(report, plan(), async () => structuredClone(identity));
  assert.equal(report.result, 'PASS'); assert.equal(report.finalIdentityVerified, true);
});

test('version attribution requires the exact catalog installation manifest and approved executable digest', () => {
  const value = plan();
  for (const expected of value.requiredInstallations) {
    const manifest = { kind: expected.kind, version: expected.version, sha256: expected.archiveSha256, executableSha256: SOURCE };
    assert.doesNotThrow(() => assertRegtestInstallation(manifest, expected, SOURCE));
    for (const patch of [{ version: 'unreviewed' }, { sha256: 'd'.repeat(64) }, { executableSha256: 'e'.repeat(64) },
      { kind: 'unknown' }, { unexpected: 'not copied' }]) {
      assert.throws(() => assertRegtestInstallation({ ...manifest, ...patch }, expected, SOURCE), { code: 'REGTEST_INSTALLATION_MISMATCH' });
    }
  }
  assert.equal(value.requiredInstallations.find(item => item.kind === 'core').version, '31.1');
  assert.equal(value.requiredInstallations.find(item => item.kind === 'ord').version, '0.29.0');
});

function admissionFixture() {
  const expected = plan().scenarios.find(item => item.id === 'both').plan;
  const state = { nodeSetup: { schemaVersion: 1, id: 'owned', plan: expected, planHash: regtestDigest(expected) },
    settings: { network: 'regtest', offlineMode: false }, providers: expected.providers, localServices: expected.services };
  const store = { get: keys => keys.reduce((value, key) => value[key], state) };
  const calls = [], services = { closed: false, shutdown() { this.closed = true; calls.push('services:shutdown'); return Promise.resolve(); },
    list: () => expected.services.map(service => ({ ...service, status: service.id === expected.core.serviceId ? 'running' : 'stopped' })),
    async start(id) { calls.push(`start:${id}`); } };
  const providers = { shutdown() { calls.push('providers:shutdown'); return Promise.resolve(); } };
  const setup = new NodeSetupManager({ stateStore: store, localServiceManager: services,
    providerManager: providers, software: { shutdown: async () => {} }, platform: 'darwin' });
  return { expected, context: { setup, services, providers }, setup, services, calls };
}

test('abort during confirmation validation closes actual coordinator admission before any fixture service start', async () => {
  const f = admissionFixture(), controller = new AbortController(), entered = deferred(), validation = deferred();
  f.setup.confirm = (action, value) => confirmRegtestPlan(action, value, f.expected, async () => {},
    async () => { entered.resolve(); await validation.promise; }, controller.signal);
  let drain;
  controller.signal.addEventListener('abort', () => { drain = closeRegtestAdmissions([f.context]); }, { once: true });
  const starting = f.setup.run({ action: 'start', setupId: 'owned' });
  const observed = starting.catch(cause => cause);
  await entered.promise;
  controller.abort(Object.assign(new Error('interrupted'), { code: 'REGTEST_INTERRUPTED' }));
  assert.equal(f.setup.stopping, true); assert.equal(f.services.closed, true);
  validation.resolve();
  assert.equal((await observed).code, 'REGTEST_INTERRUPTED'); await drain;
  assert.equal(f.calls.some(call => call.startsWith('start:')), false);
  await assert.rejects(f.setup.run({ action: 'start', setupId: 'owned' }), { code: 'APP_SHUTTING_DOWN' });
});

test('abort during admitted actual readiness prevents deferred Ord start and drains the tracked operation', async () => {
  const f = admissionFixture(), controller = new AbortController(), entered = deferred(), readiness = deferred();
  f.setup.desired = 'owned';
  f.setup.coreFactory = () => ({ rpc: async method => {
    if (method === 'getblockchaininfo') { entered.resolve(); await readiness.promise; return { result: {
      chain: 'regtest', blocks: 1, headers: 1, initialblockdownload: false, verificationprogress: 1, pruned: false
    } }; }
    return { result: { txindex: { synced: true } } };
  } });
  f.setup.restProbe = async () => ({ chain: 'regtest' });
  let drain, settled = false;
  controller.signal.addEventListener('abort', () => { drain = closeRegtestAdmissions([f.context]); void drain.then(() => { settled = true; }); });
  const advancing = f.setup.track(() => f.setup.advance(f.setup.saved('owned'))).catch(cause => cause);
  await entered.promise; controller.abort();
  assert.equal(f.setup.desired, null); assert.equal(f.setup.stopping, true);
  await Promise.resolve(); assert.equal(settled, false);
  readiness.resolve(); assert.equal((await advancing).code, 'APP_SHUTTING_DOWN'); await drain;
  assert.equal(f.calls.some(call => call.startsWith('start:')), false);
});

test('external interruption during final identity validation invalidates an otherwise matching result', async () => {
  const controller = new AbortController(), entered = deferred(), validation = deferred();
  const identity = { binaries: [], sourceFiles: [] }, report = { result: 'PASS', errors: [], ...identity };
  const verifying = verifyRegtestFinalIdentity(report, plan(), async () => { entered.resolve(); await validation.promise; return identity; }, controller.signal);
  await entered.promise; controller.abort(); validation.resolve(); await verifying;
  assert.equal(report.finalIdentityVerified, true);
  assert.equal(report.result, 'FAIL'); assert.deepEqual(report.errors, [{ phase: 'external-interruption', code: 'REGTEST_INTERRUPTED' }]);
  retainRegtestInterruption(report, controller.signal); assert.equal(report.errors.length, 1);
});

async function publicationFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-regtest-publication-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = { schemaVersion: 1, nativeExecution: false, qualification: 'Synthetic publication fixture only',
    planSha256: SOURCE, result: 'PASS', errors: [] };
  return { root, report, resultFile: path.join(root, 'result.json'), markerFile: path.join(root, 'result-invalidated.json') };
}

test('evidence publication preserves an uninterrupted result in an exclusive private file', async t => {
  const f = await publicationFixture(t), original = structuredClone(f.report);
  assert.equal(await publishRegtestEvidence(f.root, f.report, new AbortController().signal), f.report);
  assert.deepEqual(f.report, original);
  assert.deepEqual(JSON.parse(await fs.readFile(f.resultFile, 'utf8')), original);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.resultFile)).mode & 0o777, 0o600);
  await assert.rejects(fs.lstat(f.markerFile), { code: 'ENOENT' });
});

test('already-interrupted evidence serializes failure without copying the interruption message', async t => {
  const f = await publicationFixture(t), controller = new AbortController();
  controller.abort(new Error('synthetic private diagnostic must not be copied'));
  await publishRegtestEvidence(f.root, f.report, controller.signal);
  const bytes = await fs.readFile(f.resultFile, 'utf8');
  assert.equal(f.report.result, 'FAIL');
  assert.deepEqual(f.report.errors, [{ phase: 'external-interruption', code: 'REGTEST_INTERRUPTED' }]);
  assert.deepEqual(JSON.parse(bytes), f.report);
  assert.doesNotMatch(bytes, /synthetic private diagnostic/);
  await assert.rejects(fs.lstat(f.markerFile), { code: 'ENOENT' });
});

for (const phase of ['before physical write', 'after physical write']) {
  test(`interruption ${phase} but before write completion invalidates an immutable earlier PASS snapshot`, { timeout: 3000 }, async t => {
    const f = await publicationFixture(t), controller = new AbortController(), entered = deferred(), release = deferred();
    const writeFile = fs.writeFile.bind(fs), writes = []; let settled = false;
    t.mock.method(fs, 'writeFile', async (file, data, options) => {
      writes.push({ file, data, options });
      if (file === f.resultFile) {
        if (phase === 'after physical write') await writeFile(file, data, options);
        entered.resolve(); await release.promise;
        if (phase === 'before physical write') await writeFile(file, data, options);
      } else await writeFile(file, data, options);
    });
    t.after(() => release.resolve());
    const publishing = publishRegtestEvidence(f.root, f.report, controller.signal).then(value => { settled = true; return value; });
    await entered.promise;
    assert.equal(JSON.parse(writes[0].data).result, 'PASS');
    assert.equal(settled, false);
    if (phase === 'after physical write') assert.equal(await fs.readFile(f.resultFile, 'utf8'), writes[0].data);
    controller.abort(); release.resolve();
    assert.equal(await publishing, f.report);
    assert.equal(f.report.result, 'FAIL');
    assert.deepEqual(f.report.errors, [{ phase: 'external-interruption', code: 'REGTEST_INTERRUPTED' }]);
    assert.deepEqual(writes.map(value => value.file), [f.resultFile, f.markerFile]);
    assert.equal(await fs.readFile(f.resultFile, 'utf8'), writes[0].data);
    assert.deepEqual(JSON.parse(await fs.readFile(f.markerFile, 'utf8')),
      { result: 'FAIL', code: 'REGTEST_INTERRUPTED', planSha256: SOURCE });
    for (const write of writes) assert.deepEqual(write.options, { flag: 'wx', mode: 0o600 });
  });
}

for (const failure of ['write error', 'existing result']) {
  test(`evidence ${failure} returns failure and never replaces acknowledged data`, async t => {
    const f = await publicationFixture(t), existing = 'existing synthetic evidence\n';
    if (failure === 'existing result') await fs.writeFile(f.resultFile, existing, { flag: 'wx' });
    else t.mock.method(fs, 'writeFile', async () => { throw Object.assign(new Error('synthetic private filesystem detail'), { code: 'EIO' }); });
    await publishRegtestEvidence(f.root, f.report, new AbortController().signal);
    assert.equal(f.report.result, 'FAIL');
    assert.deepEqual(f.report.errors, [{ phase: 'evidence', code: failure === 'existing result' ? 'EEXIST' : 'EIO' }]);
    assert.doesNotMatch(JSON.stringify(f.report), /synthetic private filesystem/);
    if (failure === 'existing result') assert.equal(await fs.readFile(f.resultFile, 'utf8'), existing);
    else await assert.rejects(fs.lstat(f.resultFile), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(f.markerFile), { code: 'ENOENT' });
  });
}

for (const failure of ['marker write error', 'existing marker']) {
  test(`${failure} cannot restore PASS or overwrite the earlier evidence snapshot`, async t => {
    const f = await publicationFixture(t), controller = new AbortController(), writeFile = fs.writeFile.bind(fs);
    const existing = 'existing synthetic invalidation\n';
    if (failure === 'existing marker') await writeFile(f.markerFile, existing, { flag: 'wx' });
    let resultBytes;
    t.mock.method(fs, 'writeFile', async (file, data, options) => {
      if (file === f.resultFile) {
        resultBytes = data; await writeFile(file, data, options); controller.abort(); return;
      }
      if (failure === 'marker write error') throw Object.assign(new Error('synthetic private disk detail'), { code: 'ENOSPC' });
      return writeFile(file, data, options);
    });
    await publishRegtestEvidence(f.root, f.report, controller.signal);
    assert.equal(f.report.result, 'FAIL');
    assert.deepEqual(f.report.errors, [{ phase: 'external-interruption', code: 'REGTEST_INTERRUPTED' },
      { phase: 'evidence', code: failure === 'existing marker' ? 'EEXIST' : 'ENOSPC' }]);
    assert.doesNotMatch(JSON.stringify(f.report), /synthetic private disk/);
    assert.equal(JSON.parse(resultBytes).result, 'PASS');
    assert.equal(await fs.readFile(f.resultFile, 'utf8'), resultBytes);
    if (failure === 'existing marker') assert.equal(await fs.readFile(f.markerFile, 'utf8'), existing);
    else await assert.rejects(fs.lstat(f.markerFile), { code: 'ENOENT' });
  });
}

test('publication retains an existing failure without manufacturing an interruption or PASS', async t => {
  const f = await publicationFixture(t);
  f.report.result = 'FAIL'; f.report.errors.push({ phase: 'run', code: 'SYNTHETIC_FAILURE' });
  const original = structuredClone(f.report);
  await publishRegtestEvidence(f.root, f.report);
  assert.deepEqual(f.report, original);
  assert.deepEqual(JSON.parse(await fs.readFile(f.resultFile, 'utf8')), original);
  await assert.rejects(fs.lstat(f.markerFile), { code: 'ENOENT' });
});

test('admission closure attempts every manager synchronously and retains sibling failures', async () => {
  const calls = [], primary = new Error('synthetic drain failure');
  const operations = closeRegtestAdmissions([{ setup: { shutdown() { calls.push('setup'); throw primary; } },
    providers: { shutdown() { calls.push('providers'); return Promise.reject(primary); } },
    services: { shutdown() { calls.push('services'); return Promise.resolve(); } } }]);
  assert.deepEqual(calls, ['setup', 'providers', 'services']);
  const results = await operations;
  assert.deepEqual(results.map(item => item.status), ['rejected', 'rejected', 'fulfilled']);
  assert.equal(results[0].reason, primary); assert.equal(results[1].reason, primary);
});

test('directory monitor counts sizes without reading content and rejects changed root, symlinks and excessive entries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-regtest-monitor-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const canonical = await fs.realpath(root), identity = await fs.lstat(root);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'fixture.txt'), 'synthetic private text is not read');
  const result = await measureRegtestDirectory(canonical, identity);
  assert.deepEqual(result, { entries: 2, bytes: 34 });
  await assert.rejects(measureRegtestDirectory(canonical, { ...identity, ino: identity.ino === 0 ? 1 : 0 }), { code: 'REGTEST_ROOT_CHANGED' });
  await assert.rejects(measureRegtestDirectory(canonical, identity, 1), { code: 'REGTEST_STORAGE_ENTRY_LIMIT' });
  await fs.symlink(path.join(root, 'nested'), path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(measureRegtestDirectory(canonical, identity), { code: 'REGTEST_STORAGE_SYMLINK' });
});
