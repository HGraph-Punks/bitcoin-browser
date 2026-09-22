import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { APP_NAME, IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../src/shared/navigation.js';
import { assertString } from '../src/shared/validation.js';
import { DONATION } from '../src/shared/donation.js';

let source = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8');
source = source.replace(/^import .*;\n/gm, '').replace('export function registerIpc', 'function registerIpc');
source += '\nmodule.exports = { registerIpc };';

function fixture() {
  const handlers = new Map();
  const calls = [];
  const tagged = (name, result = { from: name }) => async (...args) => { calls.push([name, ...args]); return result; };
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(module, injected) {
    const { path, dialog, ipcMain, shell, APP_NAME, IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString, inspectPsbt, buildDiagnostics, writeDiagnostics, writeContentFile } = injected;
    ${source}
  })`, { URL, process, structuredClone, Date, Promise, Buffer });
  wrapper(module, {
    path,
    dialog: {
      showMessageBox: tagged('dialog.message', { response: 1 }),
      showSaveDialog: tagged('dialog.save', { canceled: false, filePath: '/fixture/output.bin' }),
      showOpenDialog: tagged('dialog.open', { canceled: false, filePaths: ['/fixture/extension'] })
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    shell: { openExternal: tagged('shell.external'), openPath: tagged('shell.path', '') },
    APP_NAME, IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString,
    inspectPsbt: (value, network) => ({ value, network }), buildDiagnostics: tagged('diagnostics.build'), writeDiagnostics: tagged('diagnostics.write'),
    writeContentFile: tagged('content.write', { filePath: '/fixture/output.bin', bytes: 4, sha256: 'sha' })
  });
  const options = {
    getMainWindow: () => null,
    app: { getName: () => 'satoshi-browser', getVersion: () => '1', getPath: () => '/fixture', isPackaged: true },
    stateStore: {
      recoveryStatus: null, snapshot: () => ({ restored: true }),
      get: (keys) => keys[0] === 'settings' ? (keys[1] === 'network' ? 'mainnet' : { network: 'mainnet' }) : [{ from: keys[0] }],
      updateSettings: tagged('settings.update', { network: 'mainnet', preferredProviderId: 'provider' }),
      saveTabs: tagged('tabs.save'), recordHistory: tagged('history.record'),
      mutate: async (mutation) => { const draft = { history: [{ id: 1 }] }; mutation(draft); calls.push(['history.clear', draft]); },
      toggleBookmark: tagged('bookmarks.toggle')
    },
    providerManager: {
      cleanupList: () => [], reviewCleanup: tagged('providers.cleanup-review'), cleanup: tagged('providers.cleanup'),
      list: () => [{ id: 'provider' }], healthAll: tagged('providers.health', [{ healthy: true }]), upsert: tagged('providers.upsert'), recover: tagged('providers.recover'),
      remove: tagged('providers.remove'), resolve: tagged('providers.resolve'), invalidateRouting() {}
    },
    resolver: {
      resolve: tagged('content.resolve', { data: Buffer.from('body'), headers: { 'content-type': 'text/plain' }, provenance: { sha256: 'sha' } }),
      inspectGraph: tagged('resolver.graph'), configure: tagged('resolver.configure')
    },
    cache: { directory: '/fixture/cache', stats: () => ({ entries: 1 }), clear: tagged('cache.clear') },
    secureStore: { availabilityStatus: () => true },
    extensionManager: { list: () => [{ id: 'extension' }], install: tagged('extensions.install'), remove: tagged('extensions.remove', [{ id: 'remaining' }]) },
    walletManager: {
      snapshot: () => ({ open: true }), beginExtensionChange: () => { calls.push(['wallet.beginExtensionChange']); return 'lease'; },
      endExtensionChange: tagged('wallet.endExtensionChange'), open: tagged('wallet.open'), discover: tagged('wallet.discover'), connect: tagged('wallet.connect'),
      disconnect: tagged('wallet.disconnect'), signPsbt: tagged('wallet.signPsbt'), signMessage: tagged('wallet.signMessage'), extensionsChanged: tagged('wallet.extensionsChanged')
    },
    localServiceManager: {
      list: () => [{ id: 'service' }], upsert: tagged('services.upsert'), remove: tagged('services.remove'),
      start: tagged('services.start'), stop: tagged('services.stop')
    },
    nodeSetup: { run: tagged('nodeSetup.run') },
    applyContentNetworkPolicy: tagged('network.policy'), dataDirectory: '/fixture/data', logDirectory: '/fixture/logs'
  };
  module.exports.registerIpc(options);
  const event = { senderFrame: { url: 'app://app/renderer/index.html' }, sender: { getURL: () => 'app://app/renderer/index.html' } };
  return { calls, invoke: (channel, payload = {}) => handlers.get(channel)(event, payload) };
}

const inscriptionId = `${'a'.repeat(64)}i0`;

test('approved donation handoff opens exactly the static bitcoin URI and does not call the wallet bridge', async () => {
  const { invoke, calls } = fixture();
  const result = await invoke(IPC.APP_OPEN_EXTERNAL, { url: DONATION.uri });
  assert.equal(result.ok, true); assert.equal(result.result, true);
  assert.deepEqual(calls.map(call => call[0]), ['dialog.message', 'shell.external']);
  const external = calls.find(call => call[0] === 'shell.external');
  assert.equal(external[1], DONATION.uri); assert.equal(external[2].activate, true);
});

test('previously uncovered read and maintenance handlers expose successful envelopes', async () => {
  const { invoke, calls } = fixture();
  const cases = [
    [IPC.APP_BOOTSTRAP, {}, { application: { name: 'Bitcoin Browser', version: '1', platform: process.platform, arch: process.arch, packaged: true }, state: { restored: true }, stateRecovery: null, providerCleanup: { cleanups: [] }, providers: [{ id: 'provider' }], cache: { entries: 1 }, wallet: { open: true }, extensions: [{ id: 'extension' }], services: [{ id: 'service' }], secureStorageAvailable: true }],
    [IPC.APP_REVEAL_PATH, { kind: 'cache' }, '/fixture/cache'],
    [IPC.PROVIDERS_SNAPSHOT, {}, { providers: [{ id: 'provider' }], cleanups: [], settings: { network: 'mainnet' } }],
    [IPC.PROVIDERS_CLEANUP_REVIEW, { id: 'provider' }, { from: 'providers.cleanup-review' }],
    [IPC.PROVIDERS_CLEANUP, { id: 'provider', token: 'synthetic-reviewed-token' }, {
      providerMutationCommitted: true, operation: 'cleanup', providerId: 'provider',
      providers: [{ id: 'provider' }], cleanups: [], settings: { network: 'mainnet' }
    }],
    [IPC.PROVIDERS_HEALTH, {}, [{ healthy: true }]], [IPC.PROVIDERS_UPSERT, { id: 'provider' }, {
      providerMutationCommitted: true, operation: 'upsert', providerId: 'provider',
      providers: [{ id: 'provider' }], cleanups: [], settings: { network: 'mainnet' }
    }],
    [IPC.PROVIDERS_REMOVE, { id: 'provider' }, {
      providerMutationCommitted: true, operation: 'remove', providerId: 'provider',
      providers: [{ id: 'provider' }], cleanups: [], settings: { network: 'mainnet' }
    }],
    [IPC.PROVIDERS_RECOVER, { id: 'provider', token: 'synthetic-reviewed-token', mode: 'clear-stored' }, {
      providerMutationCommitted: true, operation: 'recover', providerId: 'provider',
      providers: [{ id: 'provider' }], cleanups: [], settings: { network: 'mainnet' }
    }],
    [IPC.HISTORY_LIST, {}, [{ from: 'history' }]], [IPC.HISTORY_RECORD, { canonical: 'block:1' }, { from: 'history.record' }],
    [IPC.HISTORY_CLEAR, {}, []], [IPC.BOOKMARKS_LIST, {}, [{ from: 'bookmarks' }]],
    [IPC.BOOKMARKS_TOGGLE, { canonical: 'block:1' }, { from: 'bookmarks.toggle' }],
    [IPC.CACHE_STATS, {}, { entries: 1 }], [IPC.CACHE_CLEAR, {}, { entries: 1 }],
    [IPC.RESOLVER_GRAPH, { inscriptionId: `${'A'.repeat(64)}i0`, options: { depth: 2 } }, { from: 'resolver.graph' }],
    [IPC.PSBT_INSPECT, { psbt: 'fixture' }, { value: 'fixture', network: 'mainnet' }],
    [IPC.EXTENSIONS_LIST, {}, [{ id: 'extension' }]], [IPC.LOCAL_SERVICES_LIST, {}, [{ id: 'service' }]]
  ];
  for (const [channel, payload, expected] of cases) {
    const response = await invoke(channel, payload);
    assert.equal(response.ok, true, `${channel}: ${response.error?.code}`);
    assert.deepEqual(JSON.parse(JSON.stringify(response.result)), expected, channel);
  }
  assert.deepEqual(calls.find(([name]) => name === 'providers.upsert').slice(1), [{ id: 'provider' }]);
  assert.deepEqual(calls.find(([name]) => name === 'providers.health').slice(1), []);
  assert.deepEqual(calls.find(([name]) => name === 'providers.remove').slice(1), ['provider']);
  assert.deepEqual(calls.find(([name]) => name === 'providers.recover').slice(1), [{ id: 'provider', token: 'synthetic-reviewed-token', mode: 'clear-stored' }]);
  assert.deepEqual(calls.find(([name]) => name === 'shell.path').slice(1), ['/fixture/cache']);
  assert.deepEqual(calls.find(([name]) => name === 'history.record').slice(1), [{ canonical: 'block:1' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([name]) => name === 'history.clear')[1].history)), []);
  assert.deepEqual(calls.find(([name]) => name === 'bookmarks.toggle').slice(1), [{ canonical: 'block:1' }]);
  assert.deepEqual(calls.find(([name]) => name === 'cache.clear').slice(1), []);
  assert.deepEqual(calls.find(([name]) => name === 'resolver.graph').slice(1), [`${'a'.repeat(64)}i0`, { depth: 2 }]);
});

test('previously cancellation-only native-dialog paths expose accepted mocked contracts', async () => {
  const { invoke, calls } = fixture();
  for (const [channel, payload] of [
    [IPC.APP_OPEN_EXTERNAL, { url: 'HTTPS://example.test/path' }],
    [IPC.CONTENT_SAVE, { inscriptionId }],
    [IPC.EXTENSIONS_INSTALL]
  ]) {
    const response = await invoke(channel, payload);
    assert.equal(response.ok, true, channel);
    if (channel === IPC.APP_OPEN_EXTERNAL) assert.equal(response.result, true);
    if (channel === IPC.EXTENSIONS_INSTALL) assert.deepEqual(JSON.parse(JSON.stringify(response.result)), {
      extensionMutationCommitted: true, operation: 'install', extensionId: null,
      extensions: [{ id: 'extension' }], wallet: { open: true }, walletRefreshPending: false
    });
  }
  assert.equal(calls.some(([name]) => name === 'shell.external'), true);
  assert.equal(calls.some(([name]) => name === 'content.write'), true);
  assert.equal(calls.some(([name]) => name === 'extensions.install'), true);
  assert.equal(calls.some(([name]) => name === 'wallet.endExtensionChange'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([name]) => name === 'shell.external').slice(1))), ['https://example.test/path', { activate: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([name]) => name === 'content.resolve').slice(1))), [`/content/${inscriptionId}`, { accept: '*/*' }]);
  assert.deepEqual(calls.find(([name]) => name === 'extensions.install').slice(1), ['/fixture/extension']);
  const write = calls.find(([name]) => name === 'content.write');
  assert.equal(write[1], '/fixture/output.bin');
  assert.equal(Buffer.from(write[2]).toString(), 'body');
  assert.equal(write.length, 3);
  const saved = await invoke(IPC.CONTENT_SAVE, { inscriptionId });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.result)), { filePath: '/fixture/output.bin', bytes: 4, mime: 'text/plain', sha256: 'sha' });
  const installIndex = calls.findIndex(([name]) => name === 'extensions.install');
  const refreshIndex = calls.findIndex(([name]) => name === 'wallet.endExtensionChange');
  assert.ok(installIndex >= 0 && refreshIndex > installIndex);
});

test('wallet, extension, and local-service mutation handlers forward validated values', async () => {
  const { invoke, calls } = fixture();
  const cases = [
    [IPC.EXTENSIONS_REMOVE, { id: 'extension-id' }, {
      extensionMutationCommitted: true, operation: 'remove', extensionId: 'extension-id',
      extensions: [{ id: 'extension' }], wallet: { open: true }, walletRefreshPending: false
    }],
    [IPC.WALLET_OPEN, {}, { open: true }], [IPC.WALLET_DISCOVER, {}, { from: 'wallet.discover' }],
    [IPC.WALLET_CONNECT, { walletId: 'wallet-id' }, { from: 'wallet.connect' }],
    [IPC.WALLET_DISCONNECT, {}, { from: 'wallet.disconnect' }],
    [IPC.WALLET_SIGN_PSBT, { psbt: 'psbt' }, { from: 'wallet.signPsbt' }],
    [IPC.WALLET_SIGN_MESSAGE, { message: 'hello' }, { from: 'wallet.signMessage' }],
    [IPC.LOCAL_SERVICES_UPSERT, { id: 'service-id' }, { from: 'services.upsert' }],
    [IPC.LOCAL_SERVICES_REMOVE, { id: 'service-id' }, [{ id: 'service' }]],
    [IPC.LOCAL_SERVICES_START, { id: 'service-id' }, { from: 'services.start' }],
    [IPC.LOCAL_SERVICES_STOP, { id: 'service-id' }, { from: 'services.stop' }],
    [IPC.NODE_SETUP, { action: 'inspect' }, { from: 'nodeSetup.run' }]
  ];
  for (const [channel, payload, expected] of cases) {
    const response = await invoke(channel, payload);
    assert.equal(response.ok, true, channel);
    assert.deepEqual(JSON.parse(JSON.stringify(response.result)), expected, channel);
  }
  assert.deepEqual(calls.find(([name]) => name === 'wallet.open').slice(1), [true]);
  assert.deepEqual(calls.find(([name]) => name === 'wallet.discover').slice(1), []);
  assert.deepEqual(calls.find(([name]) => name === 'wallet.disconnect').slice(1), []);
  assert.deepEqual(calls.find(([name]) => name === 'wallet.connect').slice(1), ['wallet-id']);
  assert.deepEqual(calls.find(([name]) => name === 'extensions.remove').slice(1), ['extension-id']);
  assert.deepEqual(calls.find(([name]) => name === 'services.upsert').slice(1), [{ id: 'service-id' }]);
  assert.deepEqual(calls.find(([name]) => name === 'services.remove').slice(1), ['service-id']);
  assert.deepEqual(calls.find(([name]) => name === 'services.start').slice(1), ['service-id']);
  assert.deepEqual(calls.find(([name]) => name === 'services.stop').slice(1), ['service-id']);
  assert.ok(calls.findIndex(([name]) => name === 'extensions.remove') < calls.findIndex(([name]) => name === 'wallet.endExtensionChange'));
  assert.deepEqual(calls.find(([name]) => name === 'wallet.signPsbt').slice(1), [{ psbt: 'psbt' }], 'IPC transport delegation only; signing policy is qualified separately');
  assert.deepEqual(calls.find(([name]) => name === 'wallet.signMessage').slice(1), [{ message: 'hello' }], 'IPC transport delegation only; signing policy is qualified separately');
});

test('channel-local validation failures are serialized and stop collaborator effects', async () => {
  const { invoke, calls } = fixture();
  const cases = [
    [IPC.APP_OPEN_EXTERNAL, { url: 'file:///private/data' }, 'UNSAFE_URL'],
    [IPC.APP_REVEAL_PATH, { kind: 'unknown' }, 'VALIDATION_ERROR'],
    [IPC.CONTENT_SAVE, { inscriptionId: 'bad' }, 'VALIDATION_ERROR'],
    [IPC.PROVIDERS_REMOVE, { id: 'x' }, 'VALIDATION_ERROR'],
    [IPC.PROVIDERS_PREFERRED, { id: 'x' }, 'VALIDATION_ERROR'],
    [IPC.RESOLVER_GRAPH, { inscriptionId: 'bad' }, 'VALIDATION_ERROR'],
    [IPC.EXTENSIONS_REMOVE, { id: 'x' }, 'VALIDATION_ERROR'],
    [IPC.WALLET_CONNECT, { walletId: '' }, 'VALIDATION_ERROR'],
    [IPC.LOCAL_SERVICES_REMOVE, { id: '' }, 'VALIDATION_ERROR'],
    [IPC.LOCAL_SERVICES_START, { id: '' }, 'VALIDATION_ERROR'],
    [IPC.LOCAL_SERVICES_STOP, { id: '' }, 'VALIDATION_ERROR']
  ];
  cases.push(
    [IPC.APP_OPEN_EXTERNAL, { url: 42 }, 'VALIDATION_ERROR'],
    [IPC.APP_OPEN_EXTERNAL, { url: 'not a url' }, 'INVALID_URL'],
    [IPC.APP_OPEN_EXTERNAL, { url: `https://${'a'.repeat(4090)}` }, 'VALIDATION_ERROR'],
    [IPC.PROVIDERS_REMOVE, { id: 'a'.repeat(81) }, 'VALIDATION_ERROR'],
    [IPC.EXTENSIONS_REMOVE, { id: 'a'.repeat(161) }, 'VALIDATION_ERROR'],
    [IPC.WALLET_CONNECT, { walletId: 'a'.repeat(121) }, 'VALIDATION_ERROR'],
    [IPC.LOCAL_SERVICES_START, { id: 'a'.repeat(81) }, 'VALIDATION_ERROR']
  );
  for (const [channel, payload, code] of cases) {
    const before = calls.length;
    const response = await invoke(channel, payload);
    assert.equal(response.ok, false, channel);
    assert.equal(response.error.code, code, channel);
    assert.equal(calls.length, before, `${channel} must reject before effects`);
  }
});

test('behavior inventory plus documented IPC suites partitions all 48 request channels', () => {
  const coveredHere = new Set([
    IPC.APP_BOOTSTRAP, IPC.APP_OPEN_EXTERNAL, IPC.APP_REVEAL_PATH, IPC.CONTENT_SAVE,
    IPC.PROVIDERS_SNAPSHOT, IPC.PROVIDERS_HEALTH, IPC.PROVIDERS_UPSERT, IPC.PROVIDERS_REMOVE, IPC.PROVIDERS_RECOVER, IPC.PROVIDERS_CLEANUP_REVIEW, IPC.PROVIDERS_CLEANUP,
    IPC.HISTORY_LIST, IPC.HISTORY_RECORD, IPC.HISTORY_CLEAR, IPC.BOOKMARKS_LIST, IPC.BOOKMARKS_TOGGLE,
    IPC.CACHE_STATS, IPC.CACHE_CLEAR, IPC.RESOLVER_GRAPH, IPC.PSBT_INSPECT,
    IPC.EXTENSIONS_LIST, IPC.EXTENSIONS_INSTALL, IPC.EXTENSIONS_REMOVE,
    IPC.WALLET_OPEN, IPC.WALLET_DISCOVER, IPC.WALLET_CONNECT, IPC.WALLET_DISCONNECT, IPC.WALLET_SIGN_PSBT, IPC.WALLET_SIGN_MESSAGE,
    IPC.LOCAL_SERVICES_LIST, IPC.LOCAL_SERVICES_UPSERT, IPC.LOCAL_SERVICES_REMOVE, IPC.LOCAL_SERVICES_START, IPC.LOCAL_SERVICES_STOP,
    IPC.NODE_SETUP
  ]);
  const documentedExistingSuiteChannels = new Set([
    IPC.NAV_PARSE, IPC.ENTITY_RESOLVE, IPC.PROVIDERS_LIST, IPC.PROVIDERS_PREFERRED,
    IPC.SETTINGS_UPDATE, IPC.TABS_SAVE, IPC.DIAGNOSTICS_EXPORT,
    // navigation-bridge.test.js exercises the real preload/main/registry routes.
    IPC.ENTITY_RESOLVE_PREPARE, IPC.ENTITY_RESOLVE_CANCEL,
    // local-ai-ipc.test.js exercises all document-owned AI channels.
    IPC.AI_PREPARE, IPC.AI_RUN, IPC.AI_PROGRESS, IPC.AI_CANCEL
  ]);
  const eventOnly = new Set([IPC.APP_COMMAND, IPC.APP_DEEP_LINK, IPC.WALLET_STATE, IPC.WALLET_BRIDGE_READY, IPC.WALLET_BRIDGE_EVENT, IPC.WALLET_BRIDGE_COMMAND]);
  const requestChannels = Object.values(IPC).filter((channel) => !eventOnly.has(channel));
  assert.equal(requestChannels.length, 48);
  assert.equal([...coveredHere].some((channel) => documentedExistingSuiteChannels.has(channel)), false);
  assert.deepEqual([...new Set([...coveredHere, ...documentedExistingSuiteChannels])].sort(), requestChannels.sort());
});
