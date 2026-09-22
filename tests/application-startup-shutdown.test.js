import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { handleServiceBeforeQuit, shutdownApplicationManagers } from '../src/main/local-service-manager.js';
import { createStartupLifecycle } from '../src/main/startup-lifecycle.js';

const source = (await fs.readFile(new URL('../src/main/index.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function executeIndex({ singleInstance = true, holdAt = null, failAt = null, cleanupFail = null, packaged = true, env = {} } = {}) {
  const calls = [];
  const constructedOptions = new Map();
  const shutdownErrors = [];
  const ready = deferred();
  const initGate = deferred();
  const initEntered = deferred();
  const initialize = async (name) => {
    calls.push(`${name}.init`);
    if (holdAt === name) { initEntered.resolve(); await initGate.promise; }
    if (failAt === name) throw new Error(`${name} init failed`);
  };
  const app = new EventEmitter();
  Object.assign(app, {
    __servicesStopping: false, __servicesShutdownComplete: false,
    enableSandbox() {}, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => singleInstance,
    quit() { calls.push('app.quit'); }, exit(code) { calls.push(`app.exit:${code}`); }, whenReady: () => ready.promise,
    getAppPath: () => '/app', getPath: () => '/data', getVersion: () => 'test', setAsDefaultProtocolClient() {},
    isPackaged: packaged
  });
  class Logger {
    constructor() { calls.push('Logger'); }
    async init() { await initialize('logger'); }
    async info() {}
    async warn() {}
    async error(_event, fields) { calls.push(`logger.error:${fields.message}`); }
    async flush() { calls.push('logger.flush'); if (cleanupFail === 'logger') throw new Error('logger flush failed'); }
  }
  class StateStore {
    constructor() { calls.push('StateStore'); }
    async init() { await initialize('state'); }
    get() { return { cacheMaxBytes: 1, maxResourceBytes: 1 }; }
    async flush() { calls.push('state.flush'); if (cleanupFail === 'state') throw new Error('state flush failed'); }
  }
  const constructor = (name, methods = {}) => class {
    constructor(options) { calls.push(name); constructedOptions.set(name, options); Object.assign(this, methods); }
  };
  const sessionValue = () => ({
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
    webRequest: { onBeforeRequest() {} }, closeAllConnections: async () => {}
  });
  const shellWindows = { openDeepLink() {}, focusOrCreate() {}, initialize() { calls.push('shell.initialize'); }, activate() {}, beginShutdown() { calls.push('shell.shutdown'); } };
  const processFixture = new EventEmitter();
  Object.assign(processFixture, {
    argv: [], defaultApp: false, execPath: '/node', env, pid: 7,
    versions: { electron: 'fixture' }, platform: 'darwin'
  });
  const context = {
    dialog: {}, NodeSoftware: constructor('NodeSoftware'), createNodeSetupDialogs: () => ({}),
    NodeSetupManager: constructor('NodeSetupManager', { autoStart: async () => calls.push('setup.autostart'), shutdown: async () => calls.push('setup.shutdown') }),
    path, app, protocol: { registerSchemesAsPrivileged() {} }, safeStorage: {}, session: { fromPartition: (name) => { calls.push(`session:${name}`); return sessionValue(); } },
    APP_PARTITION: 'app', APP_SCHEME: 'app', CONTENT_SCHEME: 'ord', DEEP_LINK_SCHEME: 'satnav', IPC: { APP_COMMAND: 'command' }, WALLET_PARTITION: 'wallet',
    Logger, StateStore,
    LocalAiManager: constructor('LocalAiManager'),
    SecureStore: constructor('SecureStore', { init: async () => initialize('secure'), flush: async () => { calls.push('secure.flush'); if (cleanupFail === 'secure') throw new Error('secure flush failed'); } }),
    DiskCache: constructor('DiskCache', { init: async () => initialize('cache'), flush: async () => { calls.push('cache.flush'); if (cleanupFail === 'cache') throw new Error('cache flush failed'); } }),
    ProviderManager: constructor('ProviderManager', { healthAll: async () => { calls.push('health'); }, shutdown: async () => calls.push('provider.shutdown') }),
    RecursiveResolver: constructor('RecursiveResolver'), ExtensionManager: constructor('ExtensionManager', { init: async () => initialize('extension'), shutdown: async () => calls.push('extension.shutdown') }),
    WalletManager: constructor('WalletManager', { shutdown: async () => calls.push('wallet.shutdown') }), LocalServiceManager: constructor('LocalServiceManager', { autoStart: async () => { calls.push('autostart'); }, shutdown: async () => calls.push('service.shutdown') }),
    installAppProtocol() { calls.push('app.protocol'); }, installContentProtocol() { calls.push('content.protocol'); }, installWalletProtocol() { calls.push('wallet.protocol'); },
    CONTENT_NETWORK_REQUEST_FILTER: {}, createContentNetworkPolicyApplier: () => async () => {}, isContentRequestAllowed: () => false,
    createQuitWatchdog: () => ({ arm() {}, clear() {} }), createSignalShutdownHandler: () => () => {},
    handleServiceBeforeQuit: (event, options) => handleServiceBeforeQuit(event, {
      ...options,
      consoleTarget: { error: (_message, error) => shutdownErrors.push(error) }
    }),
    shutdownApplicationManagers, createStartupLifecycle,
    createMainWindow() {}, createShellWindowController: () => shellWindows, extractDeepLinkArgument: () => null,
    flushWindowBounds: async () => {}, installApplicationMenu() { calls.push('menu'); }, registerIpc: () => { calls.push('ipc'); return { shutdown: async () => {} }; },
    installRendererDiagnostics() {}, recordShellDocumentLoaded() {},
    process: processFixture, console: { error: (error) => calls.push(`console:${error.message}`) }, setInterval: () => { calls.push('timer'); return { unref() {} }; }, clearInterval() { calls.push('timer.clear'); }, Date, Promise, structuredClone,
    setTimeout, clearTimeout, setImmediate
  };
  vm.runInNewContext(source, context, { filename: 'src/main/index.js' });
  return { app, calls, ready, initGate, initEntered, shutdownErrors, constructedOptions };
}

test('real application startup keeps packaged wallet signing off even with a signing environment override', async () => {
  for (const [packaged, enabled, expected] of [[true, '1', false], [true, undefined, false], [false, undefined, false], [false, '1', true]]) {
    const f = executeIndex({ packaged, env: { SATOSHI_BROWSER_ENABLE_WALLET_SIGNING: enabled } });
    f.ready.resolve();
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.constructedOptions.get('WalletManager')?.signingEnabled, expected);
    f.app.emit('before-quit', { preventDefault() {} });
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
});

test('before-quit during logger initialization prevents later startup construction', async () => {
  const f = executeIndex({ holdAt: 'logger' });
  f.ready.resolve();
  await f.initEntered.promise;
  assert.deepEqual(f.calls, ['Logger', 'logger.init']);
  const event = { preventDefault() {} };
  f.app.emit('before-quit', event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('logger.flush'), false);
  assert.equal(f.calls.includes('app.quit'), false);
  f.initGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('StateStore'), false);
  assert.equal(f.calls.includes('SecureStore'), false);
  assert.equal(f.calls.includes('DiskCache'), false);
  assert.equal(f.calls.includes('ExtensionManager'), false);
});

test('secondary instance does not continue whenReady startup after lock denial', async () => {
  const f = executeIndex({ singleInstance: false });
  assert.deepEqual(f.calls, ['app.quit']);
  f.ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('Logger'), false);
  assert.equal(f.calls.includes('StateStore'), false);
});

test('every held initialization stage drains and blocks all later startup work', async () => {
  const forbidden = {
    logger: 'StateStore', state: 'SecureStore', secure: 'DiskCache', cache: 'ProviderManager', extension: 'menu'
  };
  for (const stage of Object.keys(forbidden)) {
    const f = executeIndex({ holdAt: stage });
    f.ready.resolve();
    await f.initEntered.promise;
    f.app.emit('before-quit', { preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.some((value) => value.endsWith('.flush')), false, `${stage} flushed before initialization settled`);
    assert.equal(f.calls.includes('app.quit'), false, `${stage} retried quit before initialization settled`);
    f.initGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.includes(forbidden[stage]), false, `${stage} admitted later startup`);
    assert.equal(f.calls.includes('ipc'), false, `${stage} installed IPC after stop`);
    assert.equal(f.calls.includes('shell.initialize'), false, `${stage} created a shell after stop`);
    assert.equal(f.calls.includes('timer'), false, `${stage} started health timer after stop`);
    assert.equal(f.calls.includes('autostart'), false, `${stage} started services after stop`);
    assert.equal(f.calls.includes('health'), false, `${stage} started provider health after stop`);
  }
});

test('stop before Electron readiness prevents all initialization and repeated quit is idempotent', async () => {
  const f = executeIndex();
  const event = { preventDefault() {} };
  f.app.emit('before-quit', event);
  f.app.emit('before-quit', event);
  f.ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('Logger'), false);
  assert.equal(f.calls.includes('session:app'), false);
  assert.equal(f.calls.includes('ipc'), false);
  assert.equal(f.calls.includes('timer'), false);
  assert.equal(f.calls.filter((value) => value === 'app.quit').length, 1);
});

test('fatal initialization drains only completed stores in persistence-before-logger order and exits nonzero', async () => {
  const f = executeIndex({ failAt: 'cache', cleanupFail: 'secure' });
  f.ready.resolve();
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.calls.includes('app.quit'), 'fatal initialization must request normal cleanup');
  f.app.emit('before-quit', { preventDefault() {} });
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('cache.flush'), false, 'failed cache initialization must not flush');
  const secure = f.calls.indexOf('secure.flush');
  const state = f.calls.indexOf('state.flush');
  const logger = f.calls.indexOf('logger.flush');
  assert.ok(secure >= 0 && state > secure && logger > state, f.calls.join(','));
  assert.ok(f.calls.includes('app.exit:1'), 'startup plus cleanup failure must remain nonzero');
  assert.equal(f.shutdownErrors.length, 1);
  assert.equal(f.shutdownErrors[0] instanceof AggregateError, true);
  assert.deepEqual(f.shutdownErrors[0].errors.map((error) => error.message), ['cache init failed', 'secure flush failed']);
  assert.ok(f.calls.some((value) => value.startsWith('logger.error:Application shutdown did not drain cleanly')));
  assert.equal(f.calls.includes('ProviderManager'), false);
  assert.equal(f.calls.includes('session:app'), false);
});

test('normal startup installs each reachable subsystem once and after-ready quit cleans it once', async () => {
  const f = executeIndex();
  f.ready.resolve();
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  for (const marker of [
    'session:app', 'session:wallet', 'app.protocol', 'content.protocol', 'wallet.protocol',
    'menu', 'WalletManager', 'LocalServiceManager', 'NodeSoftware', 'NodeSetupManager', 'setup.autostart', 'ipc', 'shell.initialize', 'autostart', 'health', 'timer'
  ]) assert.equal(f.calls.filter((value) => value === marker).length, 1, marker);

  const event = { preventDefault() {} };
  f.app.emit('before-quit', event);
  f.app.emit('before-quit', event);
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  for (const marker of ['timer.clear', 'provider.shutdown', 'wallet.shutdown', 'service.shutdown', 'extension.shutdown', 'secure.flush', 'cache.flush', 'state.flush', 'logger.flush']) {
    assert.equal(f.calls.filter((value) => value === marker).length, 1, marker);
  }
  assert.equal(f.calls.filter((value) => value === 'app.quit').length, 1);
});

test('Electron readiness rejection enters startup drain, cleans nothing uninitialized, and exits nonzero', async () => {
  const f = executeIndex();
  const readinessError = new Error('Electron readiness failed');
  f.ready.reject(readinessError);
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls.filter((value) => value === 'app.quit'), ['app.quit']);
  f.app.emit('before-quit', { preventDefault() {} });
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('Logger'), false);
  assert.equal(f.calls.some((value) => value.endsWith('.flush')), false);
  assert.equal(f.shutdownErrors.length, 1);
  assert.equal(f.shutdownErrors[0] instanceof AggregateError, true);
  assert.deepEqual(f.shutdownErrors[0].errors, [readinessError]);
  assert.ok(f.calls.includes('app.exit:1'));
});
