import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ProviderManager } from '../src/main/provider-manager.js';
import { StateStore } from '../src/main/state-store.js';
import { IPC, PROVIDER_CAPABILITIES, PROVIDER_CAPABILITIES_BY_TYPE, providerTypeSupportsCapability } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../src/shared/navigation.js';
import { assertString, validateProviderConfig, validateProviderMutation } from '../src/shared/validation.js';

function config(overrides = {}) {
  return { id: 'fixture', name: 'Fixture', type: 'mock', network: 'mainnet', baseUrl: '', enabled: true,
    priority: 1, local: true, capabilities: ['block'], ...overrides };
}

test('persistence normalization retains legacy empty providers while mutations reject enabled unusable configs', () => {
  assert.deepEqual(validateProviderConfig(config({ capabilities: [] })).capabilities, []);
  assert.deepEqual(validateProviderConfig(config({ capabilities: ['unknown'] })).capabilities, []);
  assert.doesNotThrow(() => validateProviderMutation(config({ enabled: false, capabilities: [] })));
  assert.throws(() => validateProviderMutation(config({ capabilities: [] })), (error) =>
    error.code === 'VALIDATION_ERROR' && error.status === 400 && error.details?.field === 'provider.capabilities');
  assert.throws(() => validateProviderMutation(config({ capabilities: ['unknown'] })), { code: 'VALIDATION_ERROR' });
});

test('mutation validation deduplicates supported values and explicitly rejects unknown or type-incompatible claims', () => {
  assert.deepEqual(validateProviderMutation(config({ capabilities: ['block', 'block', 'sat'] })).capabilities, ['block', 'sat']);
  assert.throws(() => validateProviderMutation(config({ capabilities: ['block', 'unknown'] })), (error) =>
    error.code === 'VALIDATION_ERROR' && error.details?.unknown?.[0] === 'unknown');
  assert.throws(() => validateProviderMutation(config({ enabled: false, capabilities: 'block' })), (error) =>
    error.code === 'VALIDATION_ERROR' && error.details?.field === 'provider.capabilities');
  assert.throws(() => validateProviderMutation(config({ type: 'mempool', baseUrl: 'http://127.0.0.1:1', capabilities: ['satpoint'] })), (error) =>
    error.code === 'VALIDATION_ERROR' && error.details?.type === 'mempool' && error.details?.incompatible?.[0] === 'satpoint');
});

test('manager candidate eligibility exhaustively enforces the shared type capability matrix for legacy claims', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PROVIDER_CAPABILITIES_BY_TYPE).map(([type, values]) => [type, [...values]])), {
    'ord-server': ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction-raw', 'output', 'satpoint', 'address', 'rune'],
    mempool: ['block', 'transaction', 'output', 'address'],
    'bitcoin-core': ['block', 'transaction', 'transaction-raw', 'output'],
    mock: ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction', 'transaction-raw', 'output', 'satpoint', 'address', 'rune']
  });
  for (const [type, supported] of Object.entries(PROVIDER_CAPABILITIES_BY_TYPE)) {
    for (const capability of PROVIDER_CAPABILITIES) {
      const provider = config({ id: `${type}-${capability}`, type, baseUrl: type === 'mock' ? '' : 'http://127.0.0.1:1', capabilities: [capability] });
      const state = { settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null,
        requestTimeoutMs: 5000, maxResourceBytes: 1024 }, providers: [provider] };
      const manager = new ProviderManager({ get: ([key]) => structuredClone(state[key]) }, { loadStatus: 'primary', get: () => null }, null);
      const expected = providerTypeSupportsCapability(type, capability);
      assert.equal(manager.candidates(capability).length === 1, expected, `${type}:${capability}`);
    }
    if (supported.includes('transaction-raw')) {
      const provider = config({ id: `${type}-raw-alias`, type, baseUrl: type === 'mock' ? '' : 'http://127.0.0.1:1', capabilities: ['transaction-raw'] });
      const state = { settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null,
        requestTimeoutMs: 5000, maxResourceBytes: 1024 }, providers: [provider] };
      const manager = new ProviderManager({ get: ([key]) => structuredClone(state[key]) }, { loadStatus: 'primary', get: () => null }, null);
      assert.equal(manager.candidates('transaction').length, 1, `${type}:transaction-raw alias`);
    }
  }
});

test('manager rejects unusable Add, Edit, and Enable before state, credentials, or routing side effects', async () => {
  const legacy = config({ id: 'legacy', enabled: false, capabilities: [] });
  const state = { settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null,
    requestTimeoutMs: 5000, maxResourceBytes: 1024 }, providers: [legacy] };
  const effects = { upserts: 0, secure: 0 };
  const store = { get: ([key]) => structuredClone(state[key]), async upsertProvider(provider) { effects.upserts += 1; state.providers = [provider]; } };
  const secureStore = { loadStatus: 'primary', get: () => null, async transaction() { effects.secure += 1; } };
  const manager = new ProviderManager(store, secureStore, null);
  const beforeRevision = manager.routingGeneration;
  for (const input of [
    config({ id: 'new', capabilities: [] }),
    config({ id: 'legacy', enabled: true, capabilities: ['unknown'] }),
    config({ id: 'legacy', enabled: true, capabilities: [] }),
    config({ id: 'legacy', enabled: true, capabilities: ['block', 'unknown'] }),
    config({ id: 'legacy', type: 'mempool', baseUrl: 'http://127.0.0.1:1', enabled: true, capabilities: ['satpoint'] })
  ]) await assert.rejects(manager.upsert({ provider: input, credentials: { password: 'not-written' } }), { code: 'VALIDATION_ERROR' });
  assert.equal(effects.upserts, 0);
  assert.equal(effects.secure, 0);
  assert.equal(manager.routingGeneration, beforeRevision);
  assert.deepEqual(state.providers, [legacy]);
  assert.equal(manager.list()[0].enabled, false);
  assert.deepEqual(manager.list()[0].capabilities, []);
});

test('legacy disabled provider remains repairable and can then be enabled', async () => {
  const legacy = config({ id: 'legacy', enabled: false, capabilities: [] });
  const state = { settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null,
    requestTimeoutMs: 5000, maxResourceBytes: 1024 }, providers: [legacy] };
  const store = { get: ([key]) => structuredClone(state[key]), async upsertProvider(provider) { state.providers = [provider]; } };
  const manager = new ProviderManager(store, { loadStatus: 'primary', get: () => null }, null);
  await manager.upsert(config({ id: 'legacy', enabled: false, capabilities: ['block'] }));
  await manager.upsert(config({ id: 'legacy', enabled: true, capabilities: ['block'] }));
  assert.equal(manager.list()[0].enabled, true);
  assert.deepEqual(manager.list()[0].capabilities, ['block']);
});

test('legacy enabled empty provider remains visible and can be repaired without first disabling it', async () => {
  const legacy = config({ id: 'legacy', enabled: true, capabilities: [] });
  const state = { settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null,
    requestTimeoutMs: 5000, maxResourceBytes: 1024 }, providers: [legacy] };
  const store = { get: ([key]) => structuredClone(state[key]), async upsertProvider(provider) { state.providers = [provider]; } };
  const manager = new ProviderManager(store, { loadStatus: 'primary', get: () => null }, null);
  assert.equal(manager.list()[0].id, 'legacy');
  assert.deepEqual(manager.list()[0].capabilities, []);
  await manager.upsert(config({ id: 'legacy', enabled: true, capabilities: ['block'] }));
  assert.deepEqual(manager.list()[0].capabilities, ['block']);
});

test('real StateStore retains empty and type-incompatible legacy providers across restart and persists repairs', async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'provider-capability-state-'));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const enabled = config({ id: 'legacy-enabled', enabled: true, capabilities: [] });
  const disabled = config({ id: 'legacy-disabled', enabled: false, capabilities: ['unknown'] });
  const incompatible = config({ id: 'legacy-mempool', type: 'mempool', baseUrl: 'http://127.0.0.1:1', enabled: true, capabilities: ['satpoint'] });
  await fsPromises.writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 3, settings: {}, providers: [enabled, disabled, incompatible] }));
  const first = new StateStore(directory, null);
  await first.init();
  assert.deepEqual(first.get(['providers']).map(({ id, enabled, capabilities }) => ({ id, enabled, capabilities })), [
    { id: 'legacy-enabled', enabled: true, capabilities: [] },
    { id: 'legacy-disabled', enabled: false, capabilities: [] },
    { id: 'legacy-mempool', enabled: true, capabilities: ['satpoint'] }
  ]);
  await first.mutate(() => {});
  const retained = new StateStore(directory, null);
  await retained.init();
  assert.deepEqual(retained.get(['providers']).map(({ id, enabled, capabilities }) => ({ id, enabled, capabilities })), [
    { id: 'legacy-enabled', enabled: true, capabilities: [] },
    { id: 'legacy-disabled', enabled: false, capabilities: [] },
    { id: 'legacy-mempool', enabled: true, capabilities: ['satpoint'] }
  ]);
  await retained.upsertProvider(validateProviderMutation({ ...enabled, capabilities: ['block'] }));
  await retained.upsertProvider(validateProviderMutation({ ...disabled, capabilities: ['sat'], enabled: false }));
  await retained.upsertProvider(validateProviderMutation({ ...incompatible, capabilities: ['block'] }));
  const restarted = new StateStore(directory, null);
  await restarted.init();
  assert.deepEqual(restarted.get(['providers']).map(({ id, enabled, capabilities }) => ({ id, enabled, capabilities })), [
    { id: 'legacy-enabled', enabled: true, capabilities: ['block'] },
    { id: 'legacy-disabled', enabled: false, capabilities: ['sat'] },
    { id: 'legacy-mempool', enabled: true, capabilities: ['block'] }
  ]);
});

function registerRealIpc(providerManager) {
  let source = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '').replace('export function registerIpc', 'function registerIpc');
  source += '\nmodule.exports = { registerIpc };';
  const handlers = new Map();
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(module, exports, injected) {
    const { fs, path, dialog, ipcMain, shell, IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString, inspectPsbt, buildDiagnostics, writeDiagnostics } = injected;
    ${source}
  })`, { URL, process, structuredClone, Date, Promise });
  wrapper(module, module.exports, {
    fs: { writeFile: async () => {} }, path, dialog: {}, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} }, shell: {},
    IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString,
    inspectPsbt: () => ({}), buildDiagnostics: async () => ({}), writeDiagnostics: async () => {}
  });
  module.exports.registerIpc({
    getMainWindow: () => null, app: { getName: () => 'test', getVersion: () => 'test', getPath: () => '/tmp', isPackaged: false },
    stateStore: providerManager.stateStore,
    providerManager, resolver: { resolve: async () => ({}), configure: async () => {}, inspectGraph: async () => ({}) },
    cache: { directory: '/tmp', stats: () => ({}), clear: async () => {} }, secureStore: { availabilityStatus: () => true },
    walletManager: { snapshot: () => ({}), discover: async () => {}, handleReady: () => {}, handleBridgeEvent: async () => {} },
    extensionManager: { list: () => [] }, localServiceManager: { list: () => [] }, dataDirectory: '/tmp', logDirectory: '/tmp'
  });
  return (payload) => handlers.get(IPC.PROVIDERS_UPSERT)({ senderFrame: { url: 'app://app/renderer/index.html' }, sender: { getURL: () => 'app://app/renderer/index.html' } }, payload);
}

test('real registered providers:upsert IPC serializes rejection without state, credential, or routing effects', async () => {
  const state = { settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null,
    requestTimeoutMs: 5000, maxResourceBytes: 1024 }, providers: [] };
  const effects = { state: 0, credentials: 0 };
  const manager = new ProviderManager({ get: ([key]) => structuredClone(state[key]), async upsertProvider() { effects.state += 1; } },
    { loadStatus: 'primary', get: () => null, async transaction() { effects.credentials += 1; } }, null);
  const revision = manager.routingGeneration;
  const invoke = registerRealIpc(manager);
  const response = await invoke({ provider: config({ id: 'ipc-empty', capabilities: [] }), credentials: { password: 'synthetic-not-written' } });
  assert.equal(JSON.stringify(response), JSON.stringify({ ok: false, error: { name: 'AppError', code: 'VALIDATION_ERROR',
    message: 'Enabled providers must have at least one supported capability', status: 400, retryable: false,
    details: { field: 'provider.capabilities', providerMutationCommitted: false, operation: 'upsert', providerId: 'ipc-empty',
      providers: [], settings: state.settings, cleanups: [] } } }));
  const incompatible = await invoke({ provider: config({ id: 'ipc-incompatible', type: 'mempool', baseUrl: 'http://127.0.0.1:1', capabilities: ['satpoint'] }) });
  assert.equal(incompatible.error.code, 'VALIDATION_ERROR');
  assert.equal(incompatible.error.details.type, 'mempool');
  assert.equal(JSON.stringify(incompatible.error.details.incompatible), JSON.stringify(['satpoint']));
  const unknown = await invoke({ provider: config({ id: 'ipc-unknown', capabilities: ['block', 'future-capability'] }) });
  assert.equal(unknown.error.code, 'VALIDATION_ERROR');
  assert.equal(JSON.stringify(unknown.error.details.unknown), JSON.stringify(['future-capability']));
  assert.equal(effects.state, 0);
  assert.equal(effects.credentials, 0);
  assert.equal(manager.routingGeneration, revision);
  assert.deepEqual(manager.list(), []);
});

test('real StateStore and IPC allow only an unchanged credential-free legacy disable transition', async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'provider-legacy-disable-'));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const legacy = config({ id: 'legacy-mempool', name: 'Legacy Mempool', type: 'mempool', baseUrl: 'http://127.0.0.1:1',
    enabled: true, capabilities: ['block', 'satpoint'] });
  await fsPromises.writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 3, settings: {}, providers: [legacy] }));
  const stateStore = new StateStore(directory, null);
  await stateStore.init();
  let credentialTransactions = 0;
  const manager = new ProviderManager(stateStore, { loadStatus: 'primary', get: () => null, async transaction() { credentialTransactions += 1; } }, null);
  const invoke = registerRealIpc(manager);
  assert.deepEqual(manager.candidates('block').map((item) => item.id), ['legacy-mempool']);
  assert.deepEqual(manager.candidates('satpoint'), []);
  const authoritative = manager.list()[0];
  const before = stateStore.get(['providers']);
  const rejected = [
    { provider: { ...authoritative, enabled: false, name: 'Changed while disabling' } },
    { provider: { ...authoritative, enabled: false, capabilities: ['satpoint'] } },
    { provider: { ...authoritative, enabled: false, capabilities: ['block', 'satpoint', 'unknown'] } },
    { provider: { ...authoritative, enabled: false, capabilities: 'block,satpoint' } },
    { provider: { ...authoritative, enabled: false, capabilities: null } },
    { provider: { ...authoritative, id: 'new-legacy', enabled: false } },
    { provider: { ...authoritative, enabled: false }, credentials: { password: '' } }
  ];
  for (const [index, payload] of rejected.entries()) {
    const response = await invoke(payload);
    assert.equal(response.ok, false, `legacy disable bypass ${index}`);
    assert.equal(response.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(stateStore.get(['providers']), before);
  }
  assert.equal(credentialTransactions, 0);

  const disabled = await invoke({ provider: { ...authoritative, enabled: false } });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.result.providerMutationCommitted, true);
  assert.equal(disabled.result.operation, 'upsert');
  assert.equal(disabled.result.providerId, legacy.id);
  assert.equal(disabled.result.providers.find((item) => item.id === legacy.id).enabled, false);
  assert.deepEqual(disabled.result.providers.find((item) => item.id === legacy.id).capabilities, ['block', 'satpoint']);
  assert.deepEqual(disabled.result.settings, stateStore.get(['settings']));
  assert.deepEqual(manager.candidates('block'), []);
  assert.equal(credentialTransactions, 0);

  const restartedStore = new StateStore(directory, null);
  await restartedStore.init();
  const persisted = restartedStore.get(['providers'])[0];
  assert.equal(persisted.enabled, false);
  assert.deepEqual(persisted.capabilities, ['block', 'satpoint']);
  const restartedManager = new ProviderManager(restartedStore, { loadStatus: 'primary', get: () => null }, null);
  assert.deepEqual(restartedManager.candidates('block'), []);
  const revision = restartedManager.routingGeneration;
  const reEnable = await registerRealIpc(restartedManager)({ provider: { ...persisted, enabled: true } });
  assert.equal(reEnable.ok, false);
  assert.equal(reEnable.error.code, 'VALIDATION_ERROR');
  assert.equal(restartedManager.routingGeneration, revision);
  assert.equal(restartedStore.get(['providers'])[0].enabled, false);
});

test('real IPC permits a valid legacy capability repair and disable in one mutation', async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'provider-legacy-repair-disable-'));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const legacy = config({ id: 'repair-mempool', type: 'mempool', baseUrl: 'http://127.0.0.1:1',
    enabled: true, capabilities: ['block', 'satpoint'] });
  await fsPromises.writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 3, settings: {}, providers: [legacy] }));
  const stateStore = new StateStore(directory, null);
  await stateStore.init();
  const manager = new ProviderManager(stateStore, { loadStatus: 'primary', get: () => null }, null);
  const response = await registerRealIpc(manager)({ provider: { ...manager.list()[0], enabled: false, capabilities: ['block'] } });
  assert.equal(response.ok, true);
  assert.equal(response.result.providerMutationCommitted, true);
  assert.equal(response.result.operation, 'upsert');
  assert.equal(response.result.providerId, legacy.id);
  assert.equal(response.result.providers.find((item) => item.id === legacy.id).enabled, false);
  assert.deepEqual(response.result.providers.find((item) => item.id === legacy.id).capabilities, ['block']);
  const restartedStore = new StateStore(directory, null);
  await restartedStore.init();
  assert.deepEqual(restartedStore.get(['providers'])[0].capabilities, ['block']);
  assert.equal(restartedStore.get(['providers'])[0].enabled, false);
});

test('actual migrated Ord descriptor can disable without persisting migration or discarding legacy claims', async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'provider-legacy-ord-disable-'));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const legacy = config({ id: 'legacy-ord', name: 'Legacy Ord', type: 'ord-server', baseUrl: 'http://127.0.0.1:1',
    enabled: true, capabilities: ['output', 'transaction'] });
  await fsPromises.writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 3, settings: {}, providers: [legacy] }));
  const stateStore = new StateStore(directory, null);
  await stateStore.init();
  const manager = new ProviderManager(stateStore, { loadStatus: 'primary', get: () => null }, null);
  const invoke = registerRealIpc(manager);
  const descriptor = manager.list()[0];
  assert.deepEqual(descriptor.capabilities, ['output', 'transaction', 'satpoint']);
  assert.deepEqual(manager.candidates('satpoint').map((item) => item.id), ['legacy-ord']);
  const before = stateStore.get(['providers']);
  for (const [index, payload] of [
    { provider: { ...descriptor, enabled: false, capabilities: ['output', 'transaction', 'satpoint', 'block'] } },
    { provider: { ...descriptor, enabled: false }, credentials: { username: '' } }
  ].entries()) {
    const response = await invoke(payload);
    assert.equal(response.ok, false, `Ord migration disable bypass ${index}`);
    assert.equal(response.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(stateStore.get(['providers']), before);
  }

  const disabled = await invoke({ provider: { ...descriptor, enabled: false } });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.result.providerMutationCommitted, true);
  assert.equal(disabled.result.operation, 'upsert');
  assert.equal(disabled.result.providerId, legacy.id);
  assert.equal(disabled.result.providers.find((item) => item.id === legacy.id).enabled, false);
  assert.deepEqual(disabled.result.providers.find((item) => item.id === legacy.id).capabilities, ['output', 'transaction', 'satpoint']);
  assert.deepEqual(stateStore.get(['providers'])[0].capabilities, ['output', 'transaction']);
  assert.deepEqual(manager.candidates('output'), []);
  assert.deepEqual(manager.candidates('satpoint'), []);

  const restartedStore = new StateStore(directory, null);
  await restartedStore.init();
  assert.deepEqual(restartedStore.get(['providers'])[0].capabilities, ['output', 'transaction']);
  const restartedManager = new ProviderManager(restartedStore, { loadStatus: 'primary', get: () => null }, null);
  assert.deepEqual(restartedManager.list()[0].capabilities, ['output', 'transaction', 'satpoint']);
  assert.deepEqual(restartedManager.candidates('output'), []);
  const reEnable = await registerRealIpc(restartedManager)({ provider: { ...restartedManager.list()[0], enabled: true } });
  assert.equal(reEnable.ok, false);
  assert.equal(reEnable.error.code, 'VALIDATION_ERROR');
  assert.equal(restartedStore.get(['providers'])[0].enabled, false);
});

test('renderer gives actionable empty-capability guidance only for enabled sources', () => {
  const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function providerCapabilityValidationMessage(');
  const end = source.indexOf('\nfunction refreshProviderMutationView(', begin);
  assert.ok(begin >= 0 && end > begin);
  const fnSource = source.slice(begin, source.indexOf('\n}', begin) + 2);
  const action = vm.runInNewContext(`(${fnSource})`);
  assert.match(action([], true), /Choose at least one supported capability/);
  assert.equal(action([], false), null);
  assert.equal(action(['block'], true), null);
});

test('renderer Enable path surfaces the actionable manager rejection without false refresh or success', async () => {
  const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function toggleProvider(provider) {');
  const end = source.indexOf('\nfunction modalHeader(', begin);
  const helperBegin = source.indexOf('function refreshProviderMutationView() {');
  const helperEnd = source.indexOf('\nfunction openProviderModal(', helperBegin);
  assert.ok(begin >= 0 && end > begin && helperBegin >= 0 && helperEnd > helperBegin);
  const effects = { upserts: [], lists: 0, patches: 0, reloads: 0, toasts: [] };
  const main = { providers: [config({ id: 'legacy', enabled: false, capabilities: [] })],
    settings: { network: 'mainnet', preferredProviderId: null } };
  const manager = new ProviderManager({ get: ([key]) => structuredClone(main[key]),
    upsertProvider: async () => assert.fail('invalid capability must not be written') }, { loadStatus: 'primary', get: () => null }, null);
  const invoke = registerRealIpc(manager);
  const model = { providers: manager.list(), settings: structuredClone(main.settings) };
  const action = vm.runInNewContext(`(() => { ${source.slice(helperBegin, helperEnd)}
    ${source.slice(begin, end)}; return toggleProvider; })()`, {
    providerRefreshSequence: 0,
    pendingProviderMutations: new Map(), providerCleanupRecovery: new Map(),
    providerOutcomeRecovery: null, providerSnapshotPending: false,
    routeName: () => 'providers', renderPage: () => {},
    queueAuthorityMutation: (task) => task(),
    state: () => model,
    api: { providers: {
      async upsert(value) {
        effects.upserts.push(value);
        const response = await invoke({ provider: value });
        if (!response.ok) throw response.error;
        return response.result;
      },
      async list() { effects.lists += 1; return []; }
    } },
    patch: (value) => { effects.patches += 1; Object.assign(model, value); },
    reloadResolvableTarget: () => { effects.reloads += 1; },
    toast: (...args) => effects.toasts.push(args)
  });
  await action(config({ id: 'legacy', enabled: false, capabilities: [] }));
  assert.equal(effects.upserts[0].enabled, true);
  assert.equal(effects.lists, 0);
  assert.equal(effects.patches, 1, 'the uncommitted rejection still publishes authoritative readback');
  assert.equal(model.providers[0].enabled, false);
  assert.equal(effects.reloads, 0);
  assert.deepEqual(effects.toasts[0], ['Could not update source', 'Enabled providers must have at least one supported capability', 'error']);
});
