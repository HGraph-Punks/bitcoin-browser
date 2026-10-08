import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { StateStore as RealStateStore } from '../src/main/state-store.js';
import { createStartupLifecycle } from '../src/main/startup-lifecycle.js';
import { handleServiceBeforeQuit, shutdownApplicationManagers } from '../src/main/local-service-manager.js';

const indexSource = (await fs.readFile(new URL('../src/main/index.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');
// Exact included copy of release/application-startup-before-index-20260906.js;
// both source snapshots have SHA-256 9efb84392fd5cca229acb7786e48777db63015f8dfdadbb2d041f21b4d267723.
const legacyIndexSource = (await fs.readFile(new URL('./fixtures/startup-before-index.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise, message, timeoutMs = 1_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

async function seededState(t) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-startup-persistence-'));
  const store = new RealStateStore(path.join(userData, 'state'), null);
  await store.init();
  await store.updateSettings({ network: 'signet', offlineMode: true, theme: 'light' });
  return { userData, file: path.join(userData, 'state', 'state.json') };
}

function executeIndex({ userData, failStateInit = false, source = indexSource }) {
  const calls = [];
  const shutdownErrors = [];
  const ready = deferred();
  const initEntered = deferred();
  const initGate = deferred();
  const startupSettled = deferred();
  const quitRetried = deferred();
  const exited = deferred();
  let stateFlushes = 0;
  const app = new EventEmitter();
  Object.assign(app, {
    __servicesStopping: false, __servicesShutdownComplete: false, isPackaged: true,
    enableSandbox() {}, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    quit() {
      calls.push('app.quit');
      quitRetried.resolve();
      if (!this.__servicesStopping && !this.__servicesShutdownComplete) {
        queueMicrotask(() => this.emit('before-quit', { preventDefault() { calls.push('prevent'); } }));
      }
    },
    exit(code) { calls.push(`app.exit:${code}`); exited.resolve(code); },
    whenReady: () => ({
      then(onFulfilled, onRejected) {
        const admitted = ready.promise.then(onFulfilled, onRejected);
        void admitted.then(startupSettled.resolve, startupSettled.resolve);
        return admitted;
      }
    }),
    getAppPath: () => '/fixture/app', getPath: () => userData, getVersion: () => 'test', setAsDefaultProtocolClient() {}
  });
  class Logger {
    async init() { calls.push('logger.init'); }
    async info() {}
    async warn() {}
    async error(event, fields) { calls.push(`logger.error:${event}:${fields?.message ?? ''}`); }
    async flush() { calls.push('logger.flush'); }
  }
  class HeldStateStore extends RealStateStore {
    async init() {
      calls.push('state.init.enter');
      initEntered.resolve();
      await initGate.promise;
      if (failStateInit) throw new Error('fixture state initialization failed');
      const result = await super.init();
      calls.push('state.init.done');
      return result;
    }
    async flush() {
      stateFlushes += 1;
      calls.push('state.flush');
      return super.flush();
    }
  }
  const unexpected = (name) => class { constructor() { calls.push(name); assert.fail(`${name} must not be constructed after startup stop`); } };
  const shellWindows = { openDeepLink() {}, focusOrCreate() {}, initialize() {}, activate() {}, beginShutdown() { calls.push('shell.shutdown'); } };
  const processFixture = new EventEmitter();
  Object.assign(processFixture, { argv: [], defaultApp: false, execPath: '/node', env: {}, pid: 17, versions: { electron: 'fixture' }, platform: 'darwin' });
  const context = {
    createCreatorIntegration: () => assert.fail('creator integration must not initialize after startup stop'),
    path, app, process: processFixture, console: { error(message, error) { shutdownErrors.push({ message, error: error ?? message }); } },
    protocol: { registerSchemesAsPrivileged() {} }, safeStorage: {}, session: { fromPartition: () => assert.fail('session must not initialize') },
    APP_PARTITION: 'app', APP_SCHEME: 'app', CONTENT_SCHEME: 'ord', DEEP_LINK_SCHEME: 'satnav', IPC: { APP_COMMAND: 'command' }, WALLET_PARTITION: 'wallet',
    Logger, StateStore: HeldStateStore, SecureStore: unexpected('SecureStore'), DiskCache: unexpected('DiskCache'), ProviderManager: unexpected('ProviderManager'),
    RecursiveResolver: unexpected('RecursiveResolver'), ExtensionManager: unexpected('ExtensionManager'), WalletManager: unexpected('WalletManager'), LocalServiceManager: unexpected('LocalServiceManager'),
    installAppProtocol() {}, installContentProtocol() {}, installWalletProtocol() {}, CONTENT_NETWORK_REQUEST_FILTER: {}, createContentNetworkPolicyApplier: () => async () => {}, isContentRequestAllowed: () => false,
    createStartupLifecycle, createQuitWatchdog: () => ({ arm() {}, clear() {} }), createSignalShutdownHandler: () => () => {},
    handleServiceBeforeQuit: (event, options) => handleServiceBeforeQuit(event, {
      ...options,
      consoleTarget: { error(message, error) { shutdownErrors.push({ message, error: error ?? message }); } }
    }),
    shutdownApplicationManagers, createMainWindow() {}, createShellWindowController: () => shellWindows,
    extractDeepLinkArgument: () => null, flushWindowBounds: async () => {}, installApplicationMenu() {}, registerIpc: () => ({ shutdown: async () => {} }),
    installRendererDiagnostics() {}, recordShellDocumentLoaded() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    setTimeout, clearTimeout, setImmediate, queueMicrotask, Date, Promise, structuredClone
  };
  vm.runInNewContext(source, context, { filename: 'src/main/index.js' });
  return { app, calls, ready, initEntered, initGate, startupSettled, quitRetried, exited, shutdownErrors, stateFlushes: () => stateFlushes };
}

function ownFixtureLifetime(t, seeded, fixture) {
  t.after(async () => {
    fixture.initGate.resolve();
    await bounded(fixture.startupSettled.promise, 'startup continuation did not settle during cleanup');
    await new Promise((resolve) => setImmediate(resolve));
    await fs.rm(seeded.userData, { recursive: true, force: true });
  });
}

test('early quit drains held real StateStore initialization before flushing and preserves persisted nondefaults', { timeout: 3_000 }, async (t) => {
  const seeded = await seededState(t);
  const before = await fs.readFile(seeded.file, 'utf8');
  const fixture = executeIndex({ userData: seeded.userData });
  ownFixtureLifetime(t, seeded, fixture);
  fixture.ready.resolve();
  await bounded(fixture.initEntered.promise, 'state initialization did not start');

  fixture.app.emit('before-quit', { preventDefault() { fixture.calls.push('prevent'); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.stateFlushes(), 0, 'constructor defaults are not flushed while init is held');
  assert.equal(await fs.readFile(seeded.file, 'utf8'), before);

  fixture.initGate.resolve();
  await bounded(fixture.quitRetried.promise, 'shutdown did not retry quit');
  assert.equal(fixture.stateFlushes(), 1);
  assert.equal(fixture.calls.includes('SecureStore'), false);

  const reopened = new RealStateStore(path.join(seeded.userData, 'state'), null);
  await reopened.init();
  assert.deepEqual(reopened.get(['settings']).network, 'signet');
  assert.equal(reopened.get(['settings']).offlineMode, true);
  assert.equal(reopened.get(['settings']).theme, 'light');
});

test('failed StateStore initialization skips its flush, attempts initialized logger cleanup, and exits nonzero', { timeout: 3_000 }, async (t) => {
  const seeded = await seededState(t);
  const before = await fs.readFile(seeded.file, 'utf8');
  const fixture = executeIndex({ userData: seeded.userData, failStateInit: true });
  ownFixtureLifetime(t, seeded, fixture);
  fixture.ready.resolve();
  await bounded(fixture.initEntered.promise, 'state initialization did not start');
  fixture.initGate.resolve();

  assert.equal(await bounded(fixture.exited.promise, 'startup failure did not complete nonzero cleanup'), 1);
  assert.equal(fixture.stateFlushes(), 0);
  assert.equal(fixture.calls.filter((call) => call === 'logger.flush').length, 1);
  assert.equal(fixture.calls.includes('SecureStore'), false);
  const shutdownFailure = fixture.shutdownErrors.find(({ message }) => String(message).includes('Application shutdown failed'));
  assert.ok(shutdownFailure);
  const aggregate = shutdownFailure.error;
  assert.equal(aggregate instanceof AggregateError, true);
  assert.equal(aggregate.errors.some((error) => error.message === 'fixture state initialization failed'), true);
  assert.equal(fixture.calls.some((call) => call.includes('logger.error:service.shutdown_failed')), true);
  assert.equal(await fs.readFile(seeded.file, 'utf8'), before);

  const reopened = new RealStateStore(path.join(seeded.userData, 'state'), null);
  await reopened.init();
  assert.equal(reopened.get(['settings']).network, 'signet');
  assert.equal(reopened.get(['settings']).offlineMode, true);
});

test('preserved pre-fix index flushes constructor defaults before held real StateStore initialization completes', { timeout: 3_000 }, async (t) => {
  const seeded = await seededState(t);
  const before = await fs.readFile(seeded.file, 'utf8');
  const fixture = executeIndex({ userData: seeded.userData, source: legacyIndexSource });
  ownFixtureLifetime(t, seeded, fixture);
  fixture.ready.resolve();
  await bounded(fixture.initEntered.promise, 'legacy state initialization did not start');

  fixture.app.emit('before-quit', { preventDefault() { fixture.calls.push('prevent'); } });
  await bounded(fixture.quitRetried.promise, 'legacy shutdown did not retry quit');
  assert.equal(fixture.stateFlushes(), 1);
  const overwritten = await fs.readFile(seeded.file, 'utf8');
  assert.notEqual(overwritten, before);

  const reopened = new RealStateStore(path.join(seeded.userData, 'state'), null);
  await reopened.init();
  assert.equal(reopened.get(['settings']).network, 'mainnet');
  assert.equal(reopened.get(['settings']).offlineMode, false);
  assert.equal(reopened.get(['settings']).theme, 'system');
});
