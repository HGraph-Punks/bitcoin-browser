import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { assertString } from '../src/shared/validation.js';
import { ExtensionManager } from '../src/main/extension-manager.js';

const walletSource = (await fs.readFile(new URL('../src/main/wallet-manager.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export class WalletManager', 'class WalletManager');

class Emitter {
  constructor() { this.listeners = new Map(); }
  on(name, handler) { this.listeners.set(name, handler); }
  emit(name, ...args) { this.listeners.get(name)?.(...args); }
}

function loadWalletManager(options = {}) {
  const module = { exports: {} };
  const windows = [];
  let manager;
  class BrowserWindow extends Emitter {
    constructor() {
      super();
      this.webContents = new Emitter();
      this.webContents.id = 71;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
      this.webContents.reload = () => queueMicrotask(() => this.manager?.handleReady(this.webContents));
      this.destroyed = false;
      windows.push(this);
    }
    async loadURL() {
      options.loadEntered?.();
      if (options.loadGate) await options.loadGate;
      manager.handleReady(this.webContents);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!options.destroyFails) { this.destroyed = true; this.emit('closed'); } }
    show() {}
  }
  const wrapper = vm.runInNewContext(`(function(module, injected) {
    const { path, crypto, BrowserWindow, dialog, IPC, WALLET_ORIGIN, WALLET_PARTITION, AppError, inspectPsbt, sanitizeJson } = injected;
    ${walletSource}\nmodule.exports = { WalletManager };
  })`, { setTimeout, clearTimeout, queueMicrotask, Promise });
  wrapper(module, {
    path, crypto, BrowserWindow, dialog: { showMessageBox: async () => ({ response: 0 }) },
    IPC, WALLET_ORIGIN: 'https://wallet.invalid', WALLET_PARTITION: 'persist:wallet', AppError,
    inspectPsbt: () => ({}), sanitizeJson: (value) => value
  });
  return { WalletManager: module.exports.WalletManager, windows, setManager(value) { manager = value; } };
}

const ipcSource = (await fs.readFile(new URL('../src/main/ipc.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export function registerIpc', 'function registerIpc');

async function integrationFixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-wallet-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Integrated fixture', version: '1' }));
  const state = { extensions: [], wallet: { connected: false, accounts: [] } };
  let storeQueue = Promise.resolve();
  const store = {
    get(keys) {
      let value = state;
      for (const key of keys) value = value?.[key];
      return structuredClone(value);
    },
    mutate(action) {
      const operation = storeQueue.then(async () => {
        if (overrides.beforeMutate) await overrides.beforeMutate(structuredClone(state));
        const draft = structuredClone(state);
        await action(draft);
        if (overrides.afterMutate) await overrides.afterMutate(draft);
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, draft);
      });
      storeQueue = operation.catch(() => {});
      return operation;
    }
  };
  let extensionLoads = 0;
  const runtime = {
    extensions: {
      async loadExtension(real) {
        extensionLoads += 1;
        if (overrides.loadError) throw overrides.loadError;
        return { id: 'integrated-extension', name: 'Integrated fixture', version: '1', path: real, manifest: { manifest_version: 3 } };
      },
      removeExtension() {}, getExtension() { return null; }
    }
  };
  const extensionManager = new ExtensionManager(runtime, store, null);
  const loadedWallet = loadWalletManager({
    destroyFails: overrides.destroyFails,
    loadEntered: overrides.loadEntered,
    loadGate: overrides.loadGate
  });
  const { WalletManager } = loadedWallet;
  const walletManager = new WalletManager({
    walletSession: {}, preloadPath: '/unused/preload.cjs', stateStore: store, logger: null,
    extensionManager, mainWindow: () => null, signingEnabled: false
  });
  loadedWallet.setManager(walletManager);
  Object.assign(walletManager, overrides.walletManager);
  const handlers = new Map();
  const registerIpc = vm.runInNewContext(`${ipcSource}\nregisterIpc`, {
    IPC, AppError, serializeError, assertString, Promise,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: { showOpenDialog: async () => overrides.selection ?? ({ canceled: false, filePaths: [directory] }) }
  });
  const lifecycle = registerIpc({ getMainWindow: () => null, extensionManager, walletManager });
  const event = { senderFrame: { url: 'app://app/renderer/index.html' } };
  return { directory, state, extensionManager, walletManager, lifecycle, windows: loadedWallet.windows, get extensionLoads() { return extensionLoads; }, invoke: (channel, payload) => handlers.get(channel)(event, payload) };
}

test('actual WalletManager and ExtensionManager complete an IPC installation lease', async (t) => {
  const f = await integrationFixture(t);
  const response = await f.invoke(IPC.EXTENSIONS_INSTALL);
  assert.equal(response.ok, true, response.error?.message);
  assert.equal(response.result.extensionMutationCommitted, true);
  assert.equal(response.result.extensionId, 'integrated-extension');
  assert.equal(response.result.wallet.extensionsChanging, false);
  assert.equal(response.result.wallet.extensionRecovery, null);
  assert.equal(f.state.extensions.length, 1);
});

test('committed extension with failed real wallet settlement exposes recovery without stale authority', async (t) => {
  let mutations = 0;
  const f = await integrationFixture(t, {
    afterMutate() {
      mutations += 1;
      if (mutations === 2) throw new AppError('WALLET_STATE_SAVE_FAILED', 'wallet state unavailable', { status: 503 });
    }
  });
  const response = await f.invoke(IPC.EXTENSIONS_INSTALL);
  assert.equal(response.error.code, 'EXTENSION_WALLET_REFRESH_FAILED');
  assert.equal(response.error.details.extensionMutationCommitted, true);
  assert.equal(response.error.details.walletRefreshPending, true);
  assert.equal(response.error.details.wallet.extensionsChanging, false);
  assert.equal(response.error.details.wallet.extensionRecovery.code, 'WALLET_STATE_SAVE_FAILED');
  assert.equal(response.error.details.wallet.state.connected, false);
  assert.equal(response.error.details.wallet.discovered.length, 0);
  assert.equal(f.state.extensions.length, 1);
});

test('wallet discover retries pending maintenance without resubmitting the extension mutation', async (t) => {
  let failWalletSave = true;
  let mutations = 0;
  const f = await integrationFixture(t, {
    afterMutate() {
      mutations += 1;
      if (mutations === 2 && failWalletSave) throw new AppError('WALLET_STATE_SAVE_FAILED', 'wallet state unavailable', { status: 503 });
    }
  });
  const committed = await f.invoke(IPC.EXTENSIONS_INSTALL);
  assert.equal(committed.error.code, 'EXTENSION_WALLET_REFRESH_FAILED');
  assert.equal(f.extensionLoads, 1);
  failWalletSave = false;

  const recovered = await f.invoke(IPC.WALLET_DISCOVER);

  assert.equal(recovered.ok, true);
  assert.equal(recovered.result.extensionRecovery, null);
  assert.equal(recovered.result.extensionsChanging, false);
  assert.equal(recovered.result.extensions[0].id, 'integrated-extension');
  assert.equal(f.extensionLoads, 1, 'recovery must not install the extension again');
  assert.equal(f.state.extensions.length, 1);
});

test('failed mutation still settles real wallet lease and reports secondary recovery failure', async (t) => {
  const f = await integrationFixture(t, {
    loadError: new AppError('INVALID_EXTENSION', 'fixture load rejected', { status: 400 }),
    afterMutate() { throw new AppError('WALLET_STATE_SAVE_FAILED', 'wallet state unavailable', { status: 503 }); }
  });
  const response = await f.invoke(IPC.EXTENSIONS_INSTALL);
  assert.equal(response.error.code, 'INVALID_EXTENSION');
  assert.equal(response.error.details.extensionMutationCommitted, false);
  assert.equal(response.error.details.walletRefreshPending, true);
  assert.equal(response.error.details.refreshError.code, 'WALLET_STATE_SAVE_FAILED');
  assert.equal(response.error.details.wallet.extensionsChanging, false);
  assert.equal(response.error.details.wallet.extensionRecovery.code, 'WALLET_STATE_SAVE_FAILED');
  assert.deepEqual(f.state.extensions, []);
});

test('picker cancellation does not enter real wallet extension authority', async (t) => {
  const f = await integrationFixture(t, { selection: { canceled: true, filePaths: [] } });
  const before = f.walletManager.snapshot();
  const response = await f.invoke(IPC.EXTENSIONS_INSTALL);
  assert.equal(response.error.code, 'USER_REJECTED');
  assert.deepEqual(f.walletManager.snapshot(), before);
  assert.deepEqual(f.state.extensions, []);
  assert.equal(f.windows.length, 0);
});

test('real bridge disposal admission failure returns current revoked authority without mutation', async (t) => {
  const f = await integrationFixture(t, { destroyFails: true });
  await f.walletManager.open(false);
  assert.equal(f.windows.length, 1);
  const response = await f.invoke(IPC.EXTENSIONS_INSTALL);
  assert.equal(response.error.code, 'WALLET_BRIDGE_DISPOSAL_FAILED');
  assert.equal(response.error.details.extensionMutationCommitted, false);
  assert.equal(response.error.details.operation, 'install');
  assert.equal(response.error.details.walletRefreshPending, true);
  assert.equal(response.error.details.recovery, 'wallet:discover');
  assert.equal(response.error.details.wallet.state.connected, false);
  assert.equal(response.error.details.wallet.extensionsChanging, false);
  assert.equal(response.error.details.wallet.extensionRecovery.code, 'WALLET_BRIDGE_DISPOSAL_FAILED');
  assert.deepEqual(f.state.extensions, []);
});

test('shutdown settles an admitted committed mutation without opening a new bridge', { timeout: 2_000 }, async (t) => {
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let mutation = 0;
  const f = await integrationFixture(t, {
    async beforeMutate() {
      mutation += 1;
      if (mutation === 1) { entered(); await held; }
    }
  });
  const install = f.invoke(IPC.EXTENSIONS_INSTALL);
  await enteredPromise;
  const ipcShutdown = f.lifecycle.shutdown();
  const walletShutdown = f.walletManager.shutdown();
  release();
  const response = await install;
  await Promise.all([ipcShutdown, walletShutdown]);
  assert.equal(response.ok, true);
  assert.equal(response.result.extensionMutationCommitted, true);
  assert.equal(response.result.walletRefreshPending, false);
  assert.equal(response.result.wallet.state.connected, false);
  assert.equal(response.result.wallet.extensionsChanging, false);
  assert.equal(f.windows.length, 0, 'shutdown settlement must not create a Wallet Bridge');
  assert.equal(f.state.extensions.length, 1);
});

test('shutdown cancellation of an already-started refresh returns committed disconnected success', { timeout: 2_000 }, async (t) => {
  let loadEntered;
  let releaseLoad;
  const entered = new Promise((resolve) => { loadEntered = resolve; });
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const f = await integrationFixture(t, { loadEntered, loadGate });
  const install = f.invoke(IPC.EXTENSIONS_INSTALL);
  await entered;
  const walletShutdown = f.walletManager.shutdown();
  releaseLoad();
  const response = await install;
  await walletShutdown;
  assert.equal(response.ok, true, response.error?.message);
  assert.equal(response.result.extensionMutationCommitted, true);
  assert.equal(response.result.walletRefreshPending, false);
  assert.equal(response.result.wallet.state.connected, false);
  assert.equal(response.result.wallet.extensionsChanging, false);
  assert.equal(response.result.wallet.extensionRecovery, null);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].isDestroyed(), true);
  assert.equal(f.state.extensions.length, 1);
});
