import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { AppError } from '../src/shared/errors.js';

const source = fs.readFileSync(new URL('../src/main/wallet-manager.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export class WalletManager', 'class WalletManager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, { heldLoad = false, autoReady = true, autoResult = true } = {}) {
  const windows = [];
  const load = deferred();
  const notifications = [];
  let manager;
  let failure = null;
  let loadFailure = null;
  let persistenceGate = null;
  let mutationCalls = 0;
  let persisted = { wallet: { connected: false, accounts: [] } };
  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.showCalls = 0;
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.id = windows.length + 100;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_channel, message) => {
        this.sent.push(message);
        if (message.requestId && autoResult) queueMicrotask(() => manager.handleBridgeEvent(this.webContents, {
          type: 'result', requestId: message.requestId, ok: true, result: {}
        }));
      };
      this.webContents.reload = () => manager.handleReady(this.webContents);
      windows.push(this);
    }
    async loadURL() {
      if (heldLoad && windows[0] === this) await load.promise;
      if (loadFailure) { const error = loadFailure; loadFailure = null; throw error; }
      if (autoReady) manager.handleReady(this.webContents);
    }
    isDestroyed() { return this.destroyed; }
    show() { this.showCalls++; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const context = {
    BrowserWindow: FakeBrowserWindow, dialog: {}, path: {},
    crypto: { randomUUID: () => `request-${Math.random()}` }, AppError,
    IPC: { WALLET_BRIDGE_COMMAND: 'command', WALLET_STATE: 'state' },
    WALLET_ORIGIN: 'https://synthetic-wallet.invalid', WALLET_PARTITION: 'synthetic-wallet',
    inspectPsbt: () => ({}), sanitizeJson: (value) => value, setTimeout, clearTimeout
  };
  const WalletManager = vm.runInNewContext(`${source}\nWalletManager`, context);
  const stateStore = {
    get: () => 'mainnet',
    async mutate(mutator) {
      mutationCalls++;
      const draft = structuredClone(persisted);
      await mutator(draft);
      const gate = persistenceGate;
      persistenceGate = null;
      if (gate) await gate.promise;
      if (failure) { const error = failure; failure = null; throw error; }
      persisted = draft;
    }
  };
  manager = new WalletManager({ stateStore, preloadPath: '/synthetic/preload.js',
    walletSession: {}, extensionManager: { list: () => [] }, logger: null,
    mainWindow: () => ({ isDestroyed: () => false, webContents: {
      send: (_channel, snapshot) => notifications.push(structuredClone(snapshot))
    } })
  });
  t.after(() => { for (const window of windows) if (!window.isDestroyed()) window.destroy(); });
  return { manager, windows, notifications, releaseLoad: load.resolve,
    failNext(error) { failure = error; }, persisted: () => structuredClone(persisted),
    failLoad(error) { loadFailure = error; },
    holdPersistence() { const gate = deferred(); persistenceGate = gate; return gate; },
    mutationCalls: () => mutationCalls };
}

const connected = { connected: true, walletId: 'synthetic-wallet', walletName: 'Synthetic',
  accounts: [{ address: 'synthetic-account' }], connectedAt: '2026-01-01T00:00:00.000Z' };

test('extension-change persistence failure cannot let the old bridge reconnect authority', async (t) => {
  const f = fixture(t);
  await f.manager.open(false);
  const old = f.windows[0];
  await f.manager.handleBridgeEvent(old.webContents, { type: 'state', state: connected });
  const failure = new Error('synthetic clear-state save failed');
  f.failNext(failure);
  await assert.rejects(f.manager.extensionsChanged(), (error) => error === failure || error.cause === failure);
  await f.manager.handleBridgeEvent(old.webContents, { type: 'state', state: connected });
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.equal(old.isDestroyed(), true);
  assert.equal(f.manager.snapshot().bridgeOpen, false);
});

test('open continuation cannot show a bridge destroyed while loadURL is pending', async (t) => {
  const f = fixture(t, { heldLoad: true });
  const opening = f.manager.open(true);
  const old = f.windows[0];
  old.destroy();
  f.releaseLoad();
  await assert.rejects(opening, (error) => /^WALLET_/.test(error.code));
  assert.equal(old.showCalls, 0);
  assert.equal(f.manager.snapshot().bridgeOpen, false);
});

test('begin extension change synchronously revokes authority, discoveries and pending approvals', async (t) => {
  const f = fixture(t, { autoResult: false });
  await f.manager.open(false);
  const old = f.windows[0];
  await f.manager.handleBridgeEvent(old.webContents, { type: 'state', state: connected });
  await f.manager.handleBridgeEvent(old.webContents, { type: 'discovered', wallets: [{ id: 'synthetic-wallet', name: 'Synthetic' }] });
  const pending = deferred();
  const rejected = assert.rejects(pending.promise, { code: 'WALLET_EXTENSIONS_CHANGED' });
  f.manager.pending.set('synthetic-approval', { action: 'signMessage', reject: pending.reject, resolve: pending.resolve, timer: setTimeout(() => {}, 1000) });
  const lease = f.manager.beginExtensionChange();
  assert.equal(f.manager.snapshot().extensionsChanging, true);
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.equal(f.manager.snapshot().discovered.length, 0);
  assert.equal(f.manager.pending.size, 0);
  assert.equal(old.isDestroyed(), true);
  assert.equal(f.manager.window, null);
  await rejected;
  assert.equal(await f.manager.handleBridgeEvent(old.webContents, { type: 'state', state: connected }), false);
  await f.manager.endExtensionChange(lease, { refresh: false });
  assert.equal(f.windows.length, 1);
});

test('single extension-change lease rejects concurrent admission and foreign completion', async (t) => {
  const f = fixture(t);
  const lease = f.manager.beginExtensionChange();
  assert.throws(() => f.manager.beginExtensionChange(), { code: 'WALLET_EXTENSIONS_CHANGED' });
  await assert.rejects(f.manager.endExtensionChange({}), (error) => /^WALLET_/.test(error.code));
  assert.equal(f.manager.snapshot().extensionsChanging, true);
  const result = await f.manager.endExtensionChange(lease, { refresh: false });
  assert.equal(result.extensionsChanging, false);
  assert.equal(result.extensionRecovery, null);
  assert.equal(f.windows.length, 0);
});

test('failed clear-state persistence releases lease and discover retries recovery without extension mutation', async (t) => {
  const f = fixture(t);
  await f.manager.open(false);
  const old = f.windows[0];
  await f.manager.handleBridgeEvent(old.webContents, { type: 'state', state: connected });
  const lease = f.manager.beginExtensionChange();
  const failure = new AppError('SYNTHETIC_SAVE_FAILED', 'Synthetic persistence unavailable');
  f.failNext(failure);
  await assert.rejects(f.manager.endExtensionChange(lease, { refresh: true }));
  assert.equal(f.manager.snapshot().extensionsChanging, false);
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.equal(typeof f.manager.snapshot().extensionRecovery.message, 'string');
  assert.equal(old.isDestroyed(), true);
  assert.equal(f.persisted().wallet.connected, true);
  const recovered = await f.manager.discover();
  assert.equal(recovered.extensionRecovery, null);
  assert.equal(recovered.state.connected, false);
  assert.equal(recovered.bridgeOpen, true);
  assert.equal(f.persisted().wallet.connected, false);
  assert.equal(f.windows.length, 2);
  assert.notEqual(f.manager.window, old);
});

test('failed replacement bridge load leaves recovery visible and discover retries a new bridge', async (t) => {
  const f = fixture(t);
  const lease = f.manager.beginExtensionChange();
  f.failLoad(new Error('Synthetic load failed'));
  await assert.rejects(f.manager.endExtensionChange(lease, { refresh: true }));
  assert.equal(f.manager.snapshot().extensionsChanging, false);
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.ok(f.manager.snapshot().extensionRecovery);
  const recovered = await f.manager.discover();
  assert.equal(recovered.extensionRecovery, null);
  assert.equal(recovered.bridgeOpen, true);
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows[0].isDestroyed(), true);
});

test('extension change invalidates discover waiting on old bridge readiness', async (t) => {
  const f = fixture(t, { autoReady: false });
  const discovering = f.manager.discover();
  const rejected = assert.rejects(discovering, (error) => /^WALLET_/.test(error.code));
  await new Promise((resolve) => setImmediate(resolve));
  const old = f.windows[0];
  const lease = f.manager.beginExtensionChange();
  assert.equal(f.manager.handleReady(old.webContents), false);
  await f.manager.endExtensionChange(lease, { refresh: false });
  await rejected;
  assert.equal(old.showCalls, 0);
  assert.equal(old.sent.length, 0);
  assert.equal(f.windows.length, 1);
});

test('shutdown invalidates held open and permanently prevents replacement bridge admission', async (t) => {
  const f = fixture(t, { heldLoad: true });
  const opening = f.manager.open(true);
  const rejected = assert.rejects(opening, (error) => /^WALLET_/.test(error.code));
  const old = f.windows[0];
  await f.manager.shutdown();
  f.releaseLoad();
  await rejected;
  await assert.rejects(f.manager.open(), (error) => /^WALLET_/.test(error.code));
  await assert.rejects(f.manager.discover(), (error) => /^WALLET_/.test(error.code));
  await assert.rejects(f.manager.connect('synthetic-wallet'), (error) => /^WALLET_/.test(error.code));
  assert.throws(() => f.manager.beginExtensionChange(), (error) => /^WALLET_/.test(error.code));
  assert.equal(old.showCalls, 0);
  assert.equal(old.isDestroyed(), true);
  assert.equal(f.windows.length, 1);
});

test('shutdown during held recovery persistence cannot create a new wallet window', async (t) => {
  const f = fixture(t);
  const lease = f.manager.beginExtensionChange();
  const gate = f.holdPersistence();
  const ending = f.manager.endExtensionChange(lease, { refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = f.manager.shutdown();
  let settled = false;
  void shutdown.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve();
  const result = await ending;
  await shutdown;
  assert.equal(result.state.connected, false);
  assert.equal(result.bridgeOpen, false);
  assert.equal(f.windows.length, 0);
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.equal(f.manager.snapshot().extensionsChanging, false);
});

test('failed old-bridge destruction releases admission but requires successful cleanup before recovery', async (t) => {
  const f = fixture(t);
  await f.manager.open(false);
  const old = f.windows[0];
  await f.manager.handleBridgeEvent(old.webContents, { type: 'state', state: connected });
  const destroy = old.destroy.bind(old);
  old.destroy = () => { throw new Error('Synthetic destruction failure'); };
  assert.throws(() => f.manager.beginExtensionChange(), { code: 'WALLET_BRIDGE_DISPOSAL_FAILED' });
  assert.equal(f.manager.snapshot().extensionsChanging, false);
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.equal(f.manager.snapshot().extensionRecovery.code, 'WALLET_BRIDGE_DISPOSAL_FAILED');
  assert.equal(f.manager.window, null);
  assert.equal(await f.manager.handleBridgeEvent(old.webContents, { type: 'state', state: connected }), false);
  await assert.rejects(f.manager.open(), { code: 'WALLET_RECOVERY_REQUIRED' });
  await assert.rejects(f.manager.discover(), { code: 'WALLET_BRIDGE_DISPOSAL_FAILED' });
  assert.equal(f.windows.length, 1);
  old.destroy = destroy;
  const result = await f.manager.discover();
  assert.equal(old.isDestroyed(), true);
  assert.equal(result.extensionRecovery, null);
  assert.equal(f.windows.length, 2);
});

test('duplicate end cannot release a settling lease or duplicate persistence and bridge creation', async (t) => {
  const f = fixture(t);
  const lease = f.manager.beginExtensionChange();
  const gate = f.holdPersistence();
  const ending = f.manager.endExtensionChange(lease, { refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const calls = f.mutationCalls();
  await assert.rejects(f.manager.endExtensionChange(lease), { code: 'WALLET_EXTENSIONS_CHANGED' });
  assert.equal(f.manager.snapshot().extensionsChanging, true);
  assert.equal(f.mutationCalls(), calls);
  assert.equal(f.windows.length, 0);
  gate.resolve();
  const result = await ending;
  assert.equal(result.extensionsChanging, false);
  assert.equal(result.extensionRecovery, null);
  assert.equal(f.windows.length, 1);
  await assert.rejects(f.manager.endExtensionChange(lease), { code: 'WALLET_EXTENSIONS_CHANGED' });
  assert.equal(f.windows.length, 1);
});

test('shutdown-owned cancellation of an already-started refresh preserves committed result and clean drain', async (t) => {
  const f = fixture(t, { heldLoad: true });
  const lease = f.manager.beginExtensionChange();
  const ending = f.manager.endExtensionChange(lease, { refresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.windows.length, 1);
  const old = f.windows[0];
  const shutdown = f.manager.shutdown();
  assert.equal(f.manager.shutdown(), shutdown);
  const [result] = await Promise.all([ending, shutdown]);
  assert.equal(result.state.connected, false);
  assert.equal(result.bridgeOpen, false);
  assert.equal(result.extensionRecovery, null);
  f.releaseLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(old.isDestroyed(), true);
  assert.equal(old.showCalls, 0);
  assert.equal(f.manager.snapshot().extensionsChanging, false);
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.equal(f.manager.snapshot().bridgeOpen, false);
  assert.equal(f.windows.length, 1);
});

test('shutdown does not suppress a distinct persistence failure with the same cancellation code', async (t) => {
  const f = fixture(t);
  const lease = f.manager.beginExtensionChange();
  const gate = f.holdPersistence();
  const external = new AppError('WALLET_SHUTTING_DOWN', 'Synthetic independent persistence failure');
  const ending = f.manager.endExtensionChange(lease, { refresh: true });
  const endRejected = assert.rejects(ending, (error) => error === external);
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = f.manager.shutdown();
  const shutdownRejected = assert.rejects(shutdown, (error) => error === external || error.errors?.includes(external));
  gate.reject(external);
  await Promise.all([endRejected, shutdownRejected]);
  assert.equal(f.manager.snapshot().extensionsChanging, false);
  assert.equal(f.manager.snapshot().state.connected, false);
  assert.ok(f.manager.snapshot().extensionRecovery);
  assert.equal(f.windows.length, 0);
});
