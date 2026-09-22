import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { APP_NAME, IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../src/shared/navigation.js';
import { assertString } from '../src/shared/validation.js';
import { DONATION } from '../src/shared/donation.js';
import { buildDiagnostics as realBuildDiagnostics, writeDiagnostics as realWriteDiagnostics } from '../src/main/diagnostics.js';

let source = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8');
source = source.replace(/^import .*;\n/gm, '');
source = source.replace('export function registerIpc', 'function registerIpc');
source += '\nmodule.exports = { registerIpc };';

function fixture(overrides = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const effects = { external: 0, fileWrites: 0, installs: 0, diagnosticsBuilds: 0, diagnosticsWrites: 0, removes: 0, routingInvalidations: 0 };
  const dialog = {
    showMessageBox: async () => ({ response: 0 }),
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    ...overrides.dialog
  };
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => listeners.set(channel, handler)
  };
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function (module, exports, injected) {
    const { path, dialog, ipcMain, shell, APP_NAME, IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString, inspectPsbt, buildDiagnostics, writeDiagnostics, writeContentFile } = injected;
    ${source}
  })`, { URL, process, structuredClone, Date, Promise });
  wrapper(module, module.exports, {
    path,
    dialog,
    ipcMain,
    shell: {
      openExternal: async () => { effects.external += 1; },
      openPath: async () => ''
    },
    APP_NAME, IPC,
    AppError,
    serializeError,
    INSCRIPTION_ID_RE,
    parseNavigationInput,
    assertString,
    inspectPsbt: () => ({}),
    buildDiagnostics: overrides.buildDiagnostics ?? (async () => { effects.diagnosticsBuilds += 1; return {}; }),
    writeDiagnostics: overrides.writeDiagnostics ?? (async () => { effects.diagnosticsWrites += 1; }),
    writeContentFile: overrides.writeContentFile ?? (async (file, data) => {
      effects.fileWrites += 1;
      return { filePath: file, bytes: data.length, sha256: 'fixture-content-hash' };
    })
  });
  const providerAttempts = [{ providerId: 'first', ok: false, error: serializeError(new AppError('PROVIDER_TIMEOUT', 'timed out', { status: 503, retryable: true })) }];
  let settingsState = { network: 'mainnet' };
  const options = {
    getMainWindow: () => null,
    app: { getName: () => 'Bitcoin Browser', getVersion: () => 'test', getPath: (kind) => `/mock/${kind}`, isPackaged: false },
    stateStore: {
      recoveryStatus: null,
      snapshot: () => ({}), get: ([key]) => key === 'settings' ? structuredClone(settingsState) : [],
      updateSettings: async (value) => (settingsState = { ...settingsState, ...value }),
      saveTabs: async () => {}, recordHistory: async (value) => value, mutate: async () => {}, toggleBookmark: async (value) => value
    },
    providerManager: {
      cleanupList: () => [],
      list: () => [{ id: 'fixture' }], healthAll: async () => [], upsert: async (value) => value,
      invalidateRouting: () => { effects.routingInvalidations += 1; },
      remove: async () => { effects.removes += 1; },
      resolve: async () => ({ entity: { kind: 'block' }, attempts: providerAttempts })
    },
    resolver: {
      configure: async () => {}, inspectGraph: async () => ({}),
      resolve: async () => ({ data: Buffer.from('content'), headers: { 'content-type': 'text/plain' }, provenance: { sha256: 'hash' } })
    },
    cache: { directory: '/mock/cache', stats: () => ({}), clear: async () => {} },
    secureStore: { availabilityStatus: () => true },
    walletManager: { snapshot: () => ({}), discover: async () => {}, handleReady: () => {}, handleBridgeEvent: async () => {} },
    extensionManager: { list: () => [], install: async () => { effects.installs += 1; } },
    localServiceManager: { list: () => [] },
    applyContentNetworkPolicy: async () => {},
    dataDirectory: '/mock/data', logDirectory: '/mock/logs'
  };
  const lifecycle = module.exports.registerIpc(options);
  const event = (url = 'app://app/renderer/index.html') => ({ senderFrame: { url }, sender: { getURL: () => url } });
  const invoke = (channel, payload = {}, url) => handlers.get(channel)(event(url), payload);
  return { invoke, effects, options, lifecycle, listeners, event };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('IPC handlers return successful envelopes from real parsing and service handlers', async () => {
  const { invoke } = fixture();
  const parsed = await invoke(IPC.NAV_PARSE, { input: 'block:840000' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.kind, 'block');
  const listed = await invoke(IPC.PROVIDERS_LIST);
  assert.equal(JSON.stringify(listed), JSON.stringify({ ok: true, result: [{ id: 'fixture' }] }));
  const snapshot = await invoke(IPC.PROVIDERS_SNAPSHOT);
  assert.deepEqual(plain(snapshot), { ok: true, result: { providers: [{ id: 'fixture' }], cleanups: [], settings: { network: 'mainnet' } } });
});

test('provider mutation handlers return strict committed snapshots without changing list compatibility', async () => {
  const { invoke } = fixture();
  for (const [channel, payload, operation, providerId] of [
    [IPC.PROVIDERS_UPSERT, { provider: { id: 'fixture' } }, 'upsert', 'fixture'],
    [IPC.PROVIDERS_REMOVE, { id: 'fixture' }, 'remove', 'fixture'],
    [IPC.PROVIDERS_PREFERRED, { id: null }, 'preferred', null]
  ]) {
    const response = await invoke(channel, payload);
    assert.deepEqual(plain(response), { ok: true, result: {
      providerMutationCommitted: true, operation, providerId,
      providers: [{ id: 'fixture' }], cleanups: [], settings: operation === 'preferred' ? { network: 'mainnet', preferredProviderId: null } : { network: 'mainnet' }
    } });
  }
  assert.deepEqual(plain(await invoke(IPC.PROVIDERS_LIST)), { ok: true, result: [{ id: 'fixture' }] });
});

test('committed provider mutation remains successful with explicit null snapshots and serialized read errors', async () => {
  const { invoke, options } = fixture();
  options.providerManager.list = () => { throw new AppError('PROVIDER_READ_FAILED', 'provider snapshot failed', { status: 500 }); };
  options.stateStore.get = () => { throw new AppError('SETTINGS_READ_FAILED', 'settings snapshot failed', { status: 500 }); };
  const response = await invoke(IPC.PROVIDERS_UPSERT, { provider: { id: 'fixture' } });
  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.result), {
    providerMutationCommitted: true, operation: 'upsert', providerId: 'fixture', providers: null, settings: null, cleanups: [],
    stateReadErrors: {
      providers: serializeError(new AppError('PROVIDER_READ_FAILED', 'provider snapshot failed', { status: 500 })),
      settings: serializeError(new AppError('SETTINGS_READ_FAILED', 'settings snapshot failed', { status: 500 }))
    }
  });
});

test('provider mutation errors preserve the primary contract and attach authoritative outcome details', async () => {
  const { invoke, options } = fixture();
  options.providerManager.upsert = async () => { throw new AppError('PROVIDER_SAVE_FAILED', 'save failed', { status: 409, retryable: true, details: { field: 'provider.name' } }); };
  const failed = await invoke(IPC.PROVIDERS_UPSERT, { provider: { id: 'fixture' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'PROVIDER_SAVE_FAILED');
  assert.equal(failed.error.message, 'save failed');
  assert.equal(failed.error.status, 409);
  assert.equal(failed.error.retryable, true);
  assert.deepEqual(plain(failed.error.details), {
    field: 'provider.name', providerMutationCommitted: false, operation: 'upsert', providerId: 'fixture',
    providers: [{ id: 'fixture' }], cleanups: [], settings: { network: 'mainnet' }
  });

  options.providerManager.remove = async () => { throw new AppError('PROVIDER_CREDENTIAL_CLEANUP_FAILED', 'cleanup failed', {
    status: 500, retryable: true, details: { id: 'fixture', providerRemoved: true }
  }); };
  const committed = await invoke(IPC.PROVIDERS_REMOVE, { id: 'fixture' });
  assert.equal(committed.error.code, 'PROVIDER_CREDENTIAL_CLEANUP_FAILED');
  assert.equal(committed.error.details.providerMutationCommitted, true);
  assert.equal(committed.error.details.operation, 'remove');
  assert.equal(committed.error.details.providerId, 'fixture');
});

test('IPC shutdown gates new requests and drains an admitted persistence operation', async () => {
  const { invoke, options, lifecycle } = fixture();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  options.stateStore.saveTabs = async () => { await held; writes += 1; };
  const admitted = invoke(IPC.TABS_SAVE, { tabs: [] });
  let drained = false;
  const shutdown = lifecycle.shutdown().then(() => { drained = true; });
  const denied = await invoke(IPC.TABS_SAVE, { tabs: [] });
  assert.equal(denied.error.code, 'APP_SHUTTING_DOWN');
  assert.equal(denied.error.status, 503);
  assert.equal(drained, false);
  const untrusted = await invoke(IPC.TABS_SAVE, {}, 'ord://content/r/blockheight');
  assert.equal(untrusted.error.code, 'UNTRUSTED_IPC_SENDER');
  release();
  assert.equal((await admitted).ok, true);
  await shutdown;
  assert.equal(writes, 1);
  assert.equal(drained, true);
  await lifecycle.shutdown();
});

test('IPC shutdown drains admitted wallet events and ignores later bridge events', async () => {
  const { options, lifecycle, listeners, event } = fixture();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let received = 0;
  options.walletManager.handleBridgeEvent = async () => { received += 1; await held; };
  listeners.get(IPC.WALLET_BRIDGE_EVENT)(event(), {});
  let drained = false;
  const shutdown = lifecycle.shutdown().then(() => { drained = true; });
  listeners.get(IPC.WALLET_BRIDGE_EVENT)(event(), {});
  await Promise.resolve();
  assert.equal(received, 1);
  assert.equal(drained, false);
  release();
  await shutdown;
});

test('cache maintenance failure reports committed settings without implying rollback', async () => {
  const { invoke, effects, options } = fixture();
  let persisted;
  options.stateStore.updateSettings = async (patch) => (persisted = { network: 'mainnet', ...patch });
  options.resolver.configure = async () => { throw new AppError('CACHE_IO_FAILED', 'fixture disk failure', { status: 500 }); };
  const response = await invoke(IPC.SETTINGS_UPDATE, { offlineMode: true });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SETTINGS_CACHE_MAINTENANCE_FAILED');
  assert.equal(response.error.retryable, true);
  assert.equal(response.error.details.settingsCommitted, true);
  assert.deepEqual(response.error.details.settings, persisted);
  assert.equal(response.error.details.cause.code, 'CACHE_IO_FAILED');
  assert.equal(effects.routingInvalidations, 2);
});

test('failed settings persistence never reports a committed change or starts cache maintenance', async () => {
  const { invoke, options } = fixture();
  let configured = false;
  let policyApplied = false;
  options.stateStore.updateSettings = async () => { throw new AppError('STATE_IO_FAILED', 'fixture write failure', { status: 500 }); };
  options.resolver.configure = async () => { configured = true; };
  options.applyContentNetworkPolicy = async () => { policyApplied = true; };
  const response = await invoke(IPC.SETTINGS_UPDATE, { offlineMode: true });
  assert.equal(response.error.code, 'STATE_IO_FAILED');
  assert.equal(response.error.details?.settingsCommitted, undefined);
  assert.equal(configured, false);
  assert.equal(policyApplied, false);
});

test('settings success waits for browser content network cutoff after persistence', async () => {
  const { invoke, options } = fixture();
  const previous = { offlineMode: false, contentNetworkPolicy: 'https-only' };
  const committed = { offlineMode: true, contentNetworkPolicy: 'https-only' };
  options.stateStore.get = () => previous;
  options.stateStore.updateSettings = async () => committed;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let markInvoked;
  const invoked = new Promise((resolve) => { markInvoked = resolve; });
  let received;
  options.applyContentNetworkPolicy = async (oldSettings, newSettings) => {
    received = [oldSettings, newSettings];
    markInvoked();
    await held;
  };
  let settled = false;
  const responsePromise = invoke(IPC.SETTINGS_UPDATE, { offlineMode: true }).then((value) => { settled = true; return value; });
  await invoked;
  assert.equal(settled, false);
  assert.deepEqual(received, [previous, committed]);
  release();
  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, committed);
});

test('network cutoff failure reports committed settings after still attempting cache maintenance', async () => {
  const { invoke, options } = fixture();
  const committed = { offlineMode: true, contentNetworkPolicy: 'https-only' };
  let configured = false;
  options.stateStore.updateSettings = async () => committed;
  options.resolver.configure = async () => { configured = true; };
  options.applyContentNetworkPolicy = async () => { throw new AppError('CONNECTION_CLOSE_FAILED', 'fixture close failure'); };
  const response = await invoke(IPC.SETTINGS_UPDATE, { offlineMode: true });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SETTINGS_NETWORK_CUTOFF_FAILED');
  assert.equal(response.error.details.settingsCommitted, true);
  assert.deepEqual(response.error.details.settings, committed);
  assert.equal(response.error.details.maintenance, 'content-network');
  assert.equal(response.error.details.cause.code, 'CONNECTION_CLOSE_FAILED');
  assert.equal(configured, true);
});

test('settings transactions serialize capture, persistence, and maintenance across concurrent updates', async () => {
  const { invoke, options } = fixture();
  let current = { offlineMode: false, contentNetworkPolicy: 'blocked' };
  options.stateStore.get = () => structuredClone(current);
  options.stateStore.updateSettings = async (patch) => {
    current = { ...current, ...patch };
    return structuredClone(current);
  };
  let releaseFirstMaintenance;
  const held = new Promise((resolve) => { releaseFirstMaintenance = resolve; });
  let configureCalls = 0;
  options.resolver.configure = async () => {
    configureCalls += 1;
    if (configureCalls === 1) await held;
  };
  const transitions = [];
  options.applyContentNetworkPolicy = async (previous, next) => transitions.push([previous, next]);

  const enableExternal = invoke(IPC.SETTINGS_UPDATE, { contentNetworkPolicy: 'https-only' });
  while (configureCalls === 0) await Promise.resolve();
  const goOffline = invoke(IPC.SETTINGS_UPDATE, { offlineMode: true });
  await Promise.resolve();
  assert.equal(configureCalls, 1);
  assert.equal(current.offlineMode, false);

  releaseFirstMaintenance();
  assert.equal((await enableExternal).ok, true);
  assert.equal((await goOffline).ok, true);
  assert.equal(configureCalls, 2);
  assert.deepEqual(transitions[1], [
    { offlineMode: false, contentNetworkPolicy: 'https-only' },
    { offlineMode: true, contentNetworkPolicy: 'https-only' }
  ]);
});

test('failed settings maintenance does not poison the serialized update queue', async () => {
  const { invoke, options } = fixture();
  let current = { offlineMode: false, contentNetworkPolicy: 'https-only' };
  options.stateStore.get = () => structuredClone(current);
  options.stateStore.updateSettings = async (patch) => (current = { ...current, ...patch });
  let cutoffCalls = 0;
  options.applyContentNetworkPolicy = async () => {
    cutoffCalls += 1;
    if (cutoffCalls === 1) throw new AppError('CONNECTION_CLOSE_FAILED', 'fixture failure');
  };
  const failed = await invoke(IPC.SETTINGS_UPDATE, { offlineMode: true });
  assert.equal(failed.error.code, 'SETTINGS_NETWORK_CUTOFF_FAILED');
  const recovered = await invoke(IPC.SETTINGS_UPDATE, { theme: 'dark' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.result.theme, 'dark');
  assert.equal(cutoffCalls, 2);
});

test('untrusted senders are denied before handler side effects', async () => {
  const { invoke, effects } = fixture();
  const response = await invoke(IPC.PROVIDERS_REMOVE, { id: 'fixture' }, 'https://attacker.invalid/');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'UNTRUSTED_IPC_SENDER');
  assert.equal(effects.removes, 0);
});

test('nested provider attempts remain serializable inside IPC envelopes', async () => {
  const { invoke } = fixture();
  const response = await invoke(IPC.ENTITY_RESOLVE, { input: 'block:840000' });
  assert.equal(response.ok, true);
  assert.equal(response.result.attempts[0].error.code, 'PROVIDER_TIMEOUT');
  assert.doesNotThrow(() => JSON.stringify(response));
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(response))), JSON.stringify(response));
});

test('mocked native dialog cancellations return USER_REJECTED before writes or external actions', async () => {
  const { invoke, effects } = fixture();
  const inscriptionId = `${'a'.repeat(64)}i0`;
  const cases = [
    [IPC.APP_OPEN_EXTERNAL, { url: 'https://example.com' }],
    [IPC.APP_OPEN_EXTERNAL, { url: DONATION.uri }],
    [IPC.CONTENT_SAVE, { inscriptionId }],
    [IPC.EXTENSIONS_INSTALL, {}],
    [IPC.DIAGNOSTICS_EXPORT, {}]
  ];
  for (const [channel, payload] of cases) {
    const response = await invoke(channel, payload);
    assert.equal(response.ok, false, channel);
    assert.equal(response.error.code, 'USER_REJECTED', channel);
  }
  assert.deepEqual(effects, { external: 0, fileWrites: 0, installs: 0, diagnosticsBuilds: 0, diagnosticsWrites: 0, removes: 0, routingInvalidations: 0 });
});

test('donation wallet handoff waits for Cancel-default native consent and displays the exact recipient URI', async () => {
  for (const response of [0, 1]) {
    let complete;
    const confirmation = new Promise(resolve => { complete = resolve; });
    const dialogs = [];
    const { invoke, effects } = fixture({ dialog: { showMessageBox: async (_window, options) => {
      dialogs.push(plain(options)); return confirmation;
    } } });
    const pending = invoke(IPC.APP_OPEN_EXTERNAL, { url: DONATION.uri });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(effects.external, 0, 'No wallet launch before confirmation');
    assert.equal(dialogs.length, 1);
    assert.deepEqual(dialogs[0].buttons, ['Cancel', 'Open externally']);
    assert.equal(dialogs[0].defaultId, 0); assert.equal(dialogs[0].cancelId, 0);
    assert.equal(dialogs[0].detail, DONATION.uri);
    assert.match(dialogs[0].message, /payment request in your system wallet/);
    complete({ response });
    const result = await pending;
    assert.equal(result.ok, response === 1);
    assert.equal(effects.external, response === 1 ? 1 : 0);
    if (response === 0) assert.equal(result.error.code, 'USER_REJECTED');
    assert.equal(effects.fileWrites + effects.installs + effects.removes, 0);
  }
});

test('accepted diagnostics export uses real bounded writer and cached availability without leaking fixture secrets', async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'satoshi-ipc-diagnostics-'));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'diagnostics.json');
  let builds = 0;
  let writes = 0;
  const { invoke, options } = fixture({
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) },
    buildDiagnostics: async (value) => { builds += 1; return realBuildDiagnostics(value); },
    writeDiagnostics: async (file, value) => { writes += 1; return realWriteDiagnostics(file, value); }
  });
  const secret = 'fixture-diagnostics-secret';
  options.stateStore.snapshot = () => ({
    wallet: { accounts: [{ address: 'bc1qfixturecompleteaddress', publicKey: secret }] },
    extensions: [],
    localServices: [{ id: 'fixture', executable: '/fixture/private/node', cwd: '/fixture/private', args: [`--token=${secret}`] }]
  });
  options.providerManager.list = () => [];
  options.cache.stats = () => ({ entries: 0, bytes: 0, directory: '/fixture/private/cache' });
  options.localServiceManager.list = () => [{
    id: 'fixture', executable: '/fixture/private/node', cwd: '/fixture/private', args: [`--password=${secret}`],
    logs: [{ stream: 'stderr', text: `authorization: bearer ${secret}` }]
  }];
  let activeAvailabilityChecks = 0;
  options.secureStore = {
    availabilityStatus: () => true,
    available: () => { activeAvailabilityChecks += 1; return true; }
  };

  const response = await invoke(IPC.DIAGNOSTICS_EXPORT);
  assert.equal(response.ok, true);
  assert.equal(response.result, destination);
  assert.equal(builds, 1);
  assert.equal(writes, 1);
  assert.equal(activeAvailabilityChecks, 0);
  const serialized = await fsPromises.readFile(destination, 'utf8');
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.equal(serialized.includes(secret), false);
  if (process.platform === 'win32') {
    t.diagnostic('Windows DACL privacy requires separate native qualification; POSIX mode bits are not an ACL assertion.');
  } else {
    assert.equal((await fsPromises.stat(destination)).mode & 0o777, 0o600);
  }
});

test('diagnostics cancellation and untrusted senders stop before real build or write', async () => {
  let dialogs = 0;
  let builds = 0;
  let writes = 0;
  const setup = fixture({
    dialog: { showSaveDialog: async () => { dialogs += 1; return { canceled: true }; } },
    buildDiagnostics: async () => { builds += 1; return {}; },
    writeDiagnostics: async () => { writes += 1; }
  });
  const canceled = await setup.invoke(IPC.DIAGNOSTICS_EXPORT);
  assert.equal(canceled.error.code, 'USER_REJECTED');
  assert.deepEqual({ dialogs, builds, writes }, { dialogs: 1, builds: 0, writes: 0 });

  const untrusted = await setup.invoke(IPC.DIAGNOSTICS_EXPORT, {}, 'https://attacker.invalid/');
  assert.equal(untrusted.error.code, 'UNTRUSTED_IPC_SENDER');
  assert.deepEqual({ dialogs, builds, writes }, { dialogs: 1, builds: 0, writes: 0 });
});

test('routing-relevant settings and preferred-provider changes invalidate before and after persistence', async () => {
  const { invoke, effects } = fixture();
  const settings = await invoke(IPC.SETTINGS_UPDATE, { offlineMode: true });
  assert.equal(settings.ok, true);
  assert.equal(effects.routingInvalidations, 2);

  await invoke(IPC.SETTINGS_UPDATE, { theme: 'dark' });
  assert.equal(effects.routingInvalidations, 2);

  const preferred = await invoke(IPC.PROVIDERS_PREFERRED, { id: 'fixture' });
  assert.equal(preferred.ok, true);
  assert.equal(preferred.result.providerMutationCommitted, true);
  assert.equal(preferred.result.operation, 'preferred');
  assert.equal(preferred.result.providerId, 'fixture');
  assert.equal(effects.routingInvalidations, 4);
});
