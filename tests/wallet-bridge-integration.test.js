import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { AppError } from '../src/shared/errors.js';
import { IPC, WALLET_ORIGIN, WALLET_PARTITION } from '../src/shared/constants.js';
import { sanitizeJson } from '../src/shared/validation.js';
import { normalizeAccounts, requestRpc, requestStyle } from '../src/wallet/adapters.js';

const managerSource = fs.readFileSync(new URL('../src/main/wallet-manager.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export class WalletManager', 'class WalletManager');
const bridgeSource = fs.readFileSync(new URL('../src/wallet/wallet.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');

function element() {
  return {
    children: [], classList: { add() {}, remove() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, callback) { this[`on${type}`] = callback; }
  };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function standardWallet(name, request) {
  return { name, features: { 'sats-connect:': { provider: { request } } } };
}

function fixture(t, wallets) {
  let manager;
  let bridgeWindow;
  let commandHandler;
  const events = [];
  const eventErrors = [];
  const unregistrations = new Map();
  const nodes = new Map(['wallets', 'bridge-status', 'request-panel', 'request-title', 'request-detail', 'extension-count', 'refresh'].map((key) => [key, element()]));
  const persisted = [];
  const stateStore = {
    get: () => 'mainnet',
    async mutate(callback) { const draft = {}; await callback(draft); persisted.push(structuredClone(draft.wallet)); }
  };
  class MockWindow {
    constructor() {
      const listeners = new Map();
      this.on = (type, callback) => listeners.set(type, callback);
      this.webContents = {
        id: 1, setWindowOpenHandler() {}, on() {},
        send(_channel, command) { void commandHandler(command); },
        reload() {}
      };
      this.isDestroyed = () => false;
      this.show = () => {};
    }
    async loadURL() {
      const listeners = new Map();
      bridgeWindow = {
        walletHost: {
          emit: (event) => {
            events.push(event);
            void Promise.resolve().then(() => manager.handleBridgeEvent(this.webContents, event)).catch((error) => eventErrors.push(error));
          },
          onCommand: (callback) => { commandHandler = callback; },
          ready: () => manager.handleReady(this.webContents)
        },
        addEventListener(type, callback) { const list = listeners.get(type) ?? []; list.push(callback); listeners.set(type, list); },
        dispatchEvent(event) { for (const callback of listeners.get(event.type) ?? []) callback(event); }
      };
      bridgeWindow.addEventListener('wallet-standard:app-ready', ({ detail: { register } }) => {
        for (const wallet of wallets) unregistrations.set(wallet.name, register(wallet));
      });
      vm.runInNewContext(bridgeSource, {
        window: bridgeWindow,
        document: { querySelector: (selector) => nodes.get(selector.slice(1)), createElement: element },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        normalizeAccounts, requestRpc, requestStyle, crypto
      });
    }
  }
  const Manager = vm.runInNewContext(`(() => { ${managerSource}; return WalletManager; })()`, {
    BrowserWindow: MockWindow, crypto, AppError, IPC, WALLET_ORIGIN, WALLET_PARTITION, sanitizeJson,
    dialog: { showMessageBox: assert.fail }, inspectPsbt: assert.fail,
    setTimeout, clearTimeout
  });
  manager = new Manager({
    stateStore, logger: null, extensionManager: { list: () => [] }, mainWindow: () => null, signingEnabled: false
  });
  t.after(() => {
    for (const pending of manager.pending.values()) clearTimeout(pending.timer);
    manager.pending.clear();
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const open = async () => { await manager.open(false); await settle(); };
  const walletId = (name) => manager.discovered.find((wallet) => wallet.name === name)?.id;
  return { manager, open, settle, walletId, nodes, events, eventErrors, persisted, unregistrations, get bridgeWindow() { return bridgeWindow; } };
}

test('real main/bridge protocol connects with correlated results and refresh preserves live authority', { timeout: 3000 }, async (t) => {
  const setup = fixture(t, [standardWallet('Fixture', async () => ({ result: { addresses: [{ address: 'bc1qfixture' }] } }))]);
  await setup.open();
  const result = await setup.manager.connect(setup.walletId('Fixture'));
  assert.equal(result.connected, true);
  assert.equal(result.accounts[0].address, 'bc1qfixture');
  assert.equal(setup.events.some((event) => event.type === 'state' && event.state.connected), false);
  await setup.manager.discover();
  await setup.settle();
  assert.equal(setup.manager.state.connected, true);
  assert.equal(setup.nodes.get('wallets').children[0].children[2].textContent, 'Connected');
  assert.deepEqual(setup.eventErrors, []);
});

test('real main/bridge disconnect cancels a pending connect and ignores the late provider approval', { timeout: 3000 }, async (t) => {
  const approval = deferred();
  const setup = fixture(t, [standardWallet('Deferred', () => approval.promise)]);
  await setup.open();
  const pending = setup.manager.connect(setup.walletId('Deferred'));
  const rejected = assert.rejects(pending, (error) => /WALLET_/.test(error.code));
  await setup.settle();
  await setup.manager.disconnect();
  await rejected;
  approval.resolve({ addresses: [{ address: 'bc1qobsolete' }] });
  await setup.settle();
  assert.equal(setup.manager.state.connected, false);
  assert.equal(setup.events.some((event) => event.type === 'state' && event.state.connected), false);
  assert.equal(setup.persisted.at(-1).connected, false);
  assert.deepEqual(setup.eventErrors, []);
});

test('real main/bridge latest selection wins across out-of-order provider approvals', { timeout: 3000 }, async (t) => {
  const older = deferred();
  const setup = fixture(t, [
    standardWallet('Older', () => older.promise),
    standardWallet('Newer', async () => ({ addresses: [{ address: 'bc1qnewer' }] }))
  ]);
  await setup.open();
  const first = setup.manager.connect(setup.walletId('Older'));
  const rejected = assert.rejects(first, (error) => /WALLET_/.test(error.code));
  await setup.settle();
  const second = await setup.manager.connect(setup.walletId('Newer'));
  await rejected;
  older.resolve({ addresses: [{ address: 'bc1qolder' }] });
  await setup.settle();
  assert.equal(second.walletId, setup.walletId('Newer'));
  assert.equal(setup.manager.state.accounts[0].address, 'bc1qnewer');
  assert.equal(setup.persisted.at(-1).accounts[0].address, 'bc1qnewer');
  assert.deepEqual(setup.eventErrors, []);
});

test('direct Bridge Connect still publishes state and unregister revokes it in main', { timeout: 3000 }, async (t) => {
  const setup = fixture(t, [standardWallet('Direct', async () => ({ accounts: ['bc1qdirect'] }))]);
  await setup.open();
  const button = setup.nodes.get('wallets').children[0].children[2];
  await button.onclick();
  await setup.settle();
  assert.equal(setup.manager.state.connected, true);
  assert.equal(setup.events.some((event) => event.type === 'state' && event.state.connected), true);
  setup.unregistrations.get('Direct')();
  await setup.settle();
  assert.equal(setup.manager.state.connected, false);
  assert.equal(setup.manager.discovered.length, 0);
  assert.deepEqual(setup.eventErrors, []);
});

test('a stale disconnect response cannot tell the shell to overwrite a newer wallet connection', { timeout: 3000 }, async (t) => {
  const transport = deferred();
  const setup = fixture(t, [
    standardWallet('Previous', ({ method }) => method === 'getAccounts' ? { addresses: ['bc1qprevious'] } : transport.promise),
    standardWallet('Current', async () => ({ addresses: ['bc1qcurrent'] }))
  ]);
  await setup.open();
  await setup.manager.connect(setup.walletId('Previous'));
  const closing = setup.manager.disconnect();
  const rejected = assert.rejects(closing, { code: 'WALLET_CONNECTION_CHANGED' });
  await setup.settle();
  await setup.manager.connect(setup.walletId('Current'));
  await rejected;
  transport.resolve(true);
  await setup.settle();
  assert.equal(setup.manager.state.walletId, setup.walletId('Current'));
  assert.equal(setup.persisted.at(-1).accounts[0].address, 'bc1qcurrent');
  assert.deepEqual(setup.eventErrors, []);
});

test('unregister promptly cancels a main-originated pending connect before provider response', { timeout: 3000 }, async (t) => {
  const approval = deferred();
  const setup = fixture(t, [standardWallet('Removed', () => approval.promise)]);
  await setup.open();
  const pending = setup.manager.connect(setup.walletId('Removed'));
  const rejected = assert.rejects(pending, (error) => /WALLET_/.test(error.code));
  await setup.settle();
  setup.unregistrations.get('Removed')();
  await setup.settle();
  await rejected;
  approval.resolve({ addresses: [{ address: 'bc1qremoved' }] });
  await setup.settle();
  assert.equal(setup.manager.state.connected, false);
  assert.deepEqual(setup.eventErrors, []);
});
