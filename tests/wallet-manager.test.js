import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let source = fs.readFileSync(new URL('../src/main/wallet-manager.js', import.meta.url), 'utf8');
source = source.replace(/^import .*;\n/gm, '');
source = source.replace('export class WalletManager', 'class WalletManager');
source += '\nmodule.exports = { WalletManager };';

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.code = code;
    Object.assign(this, options);
  }
}

class Emitter {
  constructor() { this.listeners = new Map(); }
  on(name, handler) { this.listeners.set(name, handler); }
  emit(name, ...args) { this.listeners.get(name)?.(...args); }
}

function loadWalletManager(BrowserWindow, showMessageBox = async () => ({ response: 0 })) {
  let requestSequence = 0;
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function (module, exports, injected) {
    const { path, crypto, BrowserWindow, dialog, IPC, WALLET_ORIGIN, WALLET_PARTITION, AppError, inspectPsbt, sanitizeJson } = injected;
    ${source}
  })`, { setTimeout, clearTimeout, Promise });
  wrapper(module, module.exports, {
    path: { join: (...parts) => parts.join('/') },
    crypto: { randomUUID: () => `request-${++requestSequence}` },
    BrowserWindow,
    dialog: { showMessageBox },
    IPC: { WALLET_BRIDGE_COMMAND: 'bridge-command', WALLET_STATE: 'wallet-state' },
    WALLET_ORIGIN: 'https://wallet.invalid',
    WALLET_PARTITION: 'persist:wallet',
    AppError,
    inspectPsbt: () => ({}),
    sanitizeJson: (value) => value
  });
  return module.exports.WalletManager;
}

function fixture({ autoResult = true, autoReady = true } = {}) {
  const windows = [];
  const dialogs = [];
  let manager;
  class MockBrowserWindow extends Emitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.shown = false;
      this.webContents = new Emitter();
      this.webContents.id = 42 + windows.length;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, message) => {
        this.sent.push([channel, message]);
        if (!message.requestId || !autoResult) return;
        queueMicrotask(() => manager.handleBridgeEvent(this.webContents, {
          type: 'result',
          requestId: message.requestId,
          ok: true,
          result: message.action === 'connect'
            ? { connected: true, walletId: 'wallet-one', walletName: 'Wallet One', accounts: [{ address: 'bc1qaccount' }] }
            : {}
        }));
      };
      this.webContents.reload = () => queueMicrotask(() => manager.handleReady(this.webContents));
      this.sent = [];
      windows.push(this);
    }
    async loadURL() { if (autoReady) manager.handleReady(this.webContents); }
    isDestroyed() { return this.destroyed; }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    show() { this.shown = true; }
  }
  const persisted = [];
  let nextPersistence = null;
  const notifications = [];
  const extensionState = [{ id: 'extension-one', loaded: true }];
  const stateStore = {
    get: () => 'mainnet',
    async mutate(mutator) {
      const draft = {};
      await mutator(draft);
      const gate = nextPersistence;
      nextPersistence = null;
      if (gate) await gate.promise;
      persisted.push(structuredClone(draft.wallet));
    }
  };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (_channel, snapshot) => notifications.push(structuredClone(snapshot)) }
  };
  const WalletManager = loadWalletManager(MockBrowserWindow, async (...args) => { dialogs.push(args); return { response: 0 }; });
  manager = new WalletManager({
    walletSession: {},
    preloadPath: '/preload.js',
    iconPath: '/fixture/bitcoin-browser-logo.png',
    stateStore,
    logger: null,
    extensionManager: { list: () => structuredClone(extensionState) },
    mainWindow: () => mainWindow,
    signingEnabled: false
  });
  return {
    manager, windows, persisted, notifications, extensionState, dialogs,
    holdNextPersistence() {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      nextPersistence = { promise };
      return release;
    }
  };
}

async function connectedFixture(options) {
  const value = fixture(options);
  await value.manager.connect('wallet-one');
  const window = value.windows[0];
  await value.manager.handleBridgeEvent(window.webContents, {
    type: 'discovered', wallets: [{ id: 'wallet-one', name: 'Wallet One' }]
  });
  return value;
}

test('Wallet Bridge uses the supplied local application icon while retaining its isolated sandbox', async () => {
  const { manager, windows } = fixture();
  await manager.open();
  const options = windows[0].options;
  assert.equal(options.icon, '/fixture/bitcoin-browser-logo.png');
  assert.equal(options.webPreferences.partition, 'persist:wallet');
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
});

test('disabled signing rejects before input parsing, approval dialogs, or wallet transport', async () => {
  for (const connected of [false, true]) {
    const { manager, windows, dialogs } = connected ? await connectedFixture() : fixture();
    const windowCount = windows.length;
    const sentBefore = windows.flatMap((window) => window.sent).length;
    const input = new Proxy({}, { get() { throw new Error('Signing gate must run before payload access'); } });
    for (const method of ['signPsbt', 'signMessage']) {
      await assert.rejects(manager[method](input), (error) => error.code === 'FEATURE_DISABLED' && error.status === 403);
    }
    assert.equal(manager.snapshot().signingEnabled, false);
    assert.equal(dialogs.length, 0);
    assert.equal(windows.length, windowCount);
    assert.equal(windows.flatMap((window) => window.sent).length, sentBefore);
  }
});

test('wallet connection state is backed by a live bridge', async () => {
  const { manager } = await connectedFixture();
  const snapshot = manager.snapshot();
  assert.equal(snapshot.bridgeOpen, true);
  assert.equal(snapshot.state.connected, true);
  assert.equal(snapshot.state.accounts[0].address, 'bc1qaccount');
  assert.equal(snapshot.discovered[0].id, 'wallet-one');
});

test('malformed bridge state cannot establish authority or expose accounts', async () => {
  const { manager, windows, persisted } = await connectedFixture();
  const malformed = Array.from({ length: 25 }, () => null);
  const handled = await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'state',
    state: {
      connected: true,
      walletId: ['not-a-string'],
      walletName: { malformed: true },
      connectedAt: 42,
      accounts: [...malformed, { address: 'bc1qvalid', publicKey: 10, purpose: 'payment' }]
    }
  });

  assert.equal(handled, true);
  assert.deepEqual(structuredClone(manager.snapshot().state), { connected: false, walletId: null, walletName: null, accounts: [], connectedAt: null });
  assert.deepEqual(persisted.at(-1), structuredClone(manager.snapshot().state));
});

test('malformed and overlong discovered descriptors are rejected without id rewriting', async () => {
  const { manager, windows } = await connectedFixture();
  const exact = 'wallet-'.padEnd(120, 'x');
  const handled = await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'discovered',
    wallets: [
      null,
      42,
      {},
      { id: ['bad'] },
      { id: exact, name: 'Exact', kind: 1, icon: 'https://invalid/icon.png' },
      { id: `${exact}one`, name: 'Overlong collision' },
      { id: `${exact}two`, name: 'Another overlong collision' },
      { id: 'wallet-valid', name: null, kind: 'browser', icon: 'data:image/png;base64,fixture' }
    ]
  });

  assert.equal(handled, true);
  assert.deepEqual(structuredClone(manager.snapshot().discovered), [
    { id: exact, name: 'Exact', kind: 'unknown', icon: null },
    { id: 'wallet-valid', name: 'wallet-valid', kind: 'browser', icon: 'data:image/png;base64,fixture' }
  ]);
});

test('connect rejects malformed and overlong opaque ids before opening the bridge', async () => {
  const { manager, windows } = fixture();
  await assert.rejects(manager.connect(null), (error) => error.code === 'VALIDATION_ERROR' && error.status === 400);
  await assert.rejects(manager.connect('x'.repeat(121)), (error) => error.code === 'VALIDATION_ERROR' && error.status === 400);
  assert.equal(windows.length, 0);
});

for (const lifecycle of ['closed', 'render-process-gone']) {
  test(`${lifecycle} revokes wallet and account authority`, async () => {
    const { manager, windows, persisted, notifications } = await connectedFixture();
    const window = windows[0];
    if (lifecycle === 'closed') window.emit('closed');
    else window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = manager.snapshot();
    assert.equal(snapshot.bridgeOpen, false);
    assert.equal(snapshot.state.connected, false);
    assert.equal(snapshot.state.accounts.length, 0);
    assert.equal(snapshot.discovered.length, 0);
    assert.equal(persisted.at(-1).connected, false);
    assert.equal(notifications.at(-1).state.connected, false);
    if (lifecycle === 'render-process-gone') assert.equal(window.isDestroyed(), true);
  });
}

for (const [lifecycle, code] of [['closed', 'WALLET_BRIDGE_CLOSED'], ['render-process-gone', 'WALLET_BRIDGE_CRASHED']]) {
  test(`${lifecycle} rejects pending wallet commands`, async () => {
    const { manager, windows } = fixture({ autoResult: false });
    const command = manager.connect('wallet-one');
    while (!windows[0]?.sent.some(([, message]) => message.requestId)) await new Promise((resolve) => setTimeout(resolve, 0));
    if (lifecycle === 'closed') windows[0].emit('closed');
    else windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await assert.rejects(command, (error) => error.code === code);
  });
}

test('extension removal clears connected and discovered wallet state', async () => {
  const { manager, extensionState } = await connectedFixture();
  extensionState.length = 0;
  const snapshot = await manager.extensionsChanged();
  assert.equal(snapshot.state.connected, false);
  assert.equal(snapshot.state.accounts.length, 0);
  assert.equal(snapshot.discovered.length, 0);
  assert.equal(snapshot.extensions.length, 0);
});

for (const lifecycle of ['closed', 'render-process-gone']) {
  test(`${lifecycle} between a result and connect continuation cannot restore authority`, async () => {
    const { manager, windows, persisted } = fixture({ autoResult: false });
    const connection = manager.connect('wallet-one');
    while (!windows[0]?.sent.some(([, message]) => message.requestId)) await new Promise((resolve) => setTimeout(resolve, 0));
    const window = windows[0];
    const requestId = window.sent.find(([, message]) => message.requestId)?.[1].requestId;
    manager.handleBridgeEvent(window.webContents, {
      type: 'result',
      requestId,
      ok: true,
      result: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qrace' }] }
    });
    if (lifecycle === 'closed') window.emit('closed');
    else window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });

    await assert.rejects(connection, (error) => error.code === 'WALLET_BRIDGE_UNAVAILABLE');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(manager.snapshot().state.connected, false);
    assert.equal(persisted.at(-1).connected, false);
  });
}

test('a late close from a crashed window does not revoke its replacement', async () => {
  const { manager, windows } = await connectedFixture();
  const crashedWindow = windows[0];
  crashedWindow.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await manager.connect('wallet-one');
  assert.equal(windows.length, 2);
  assert.equal(manager.snapshot().state.connected, true);

  crashedWindow.emit('closed');
  assert.equal(manager.snapshot().state.connected, true);
  assert.equal(manager.snapshot().bridgeOpen, true);
});

test('extension removal promptly rejects an in-flight connect and cannot restore authority', async () => {
  const { manager, windows, extensionState, persisted } = fixture({ autoResult: false });
  const connection = manager.connect('wallet-one');
  while (!windows[0]?.sent.some(([, message]) => message.requestId)) await new Promise((resolve) => setTimeout(resolve, 0));
  extensionState.length = 0;

  let rejection;
  connection.catch((error) => { rejection = error; });
  const snapshot = await manager.extensionsChanged();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(rejection?.code, 'WALLET_EXTENSIONS_CHANGED');
  assert.equal(snapshot.state.connected, false);
  assert.equal(snapshot.state.accounts.length, 0);
  assert.equal(manager.snapshot().state.connected, false);
  assert.equal(persisted.at(-1).connected, false);
});

test('extension refresh blocks new connection authority until final revocation', async () => {
  const { manager, windows, extensionState, holdNextPersistence } = await connectedFixture();
  extensionState.length = 0;
  const release = holdNextPersistence();
  const refresh = manager.extensionsChanged();
  await assert.rejects(manager.connect('wallet-one'), (error) => error.code === 'WALLET_EXTENSIONS_CHANGED');
  assert.equal(await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'state', state: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qstale' }] }
  }), false);
  release();
  const snapshot = await refresh;
  assert.equal(snapshot.state.connected, false);
  assert.equal(manager.snapshot().state.connected, false);
});

test('disconnect synchronously invalidates a pending connect and ignores its late result', async () => {
  const { manager, windows } = fixture({ autoResult: false });
  const connection = manager.connect('wallet-one');
  while (!windows[0]?.sent.some(([, message]) => message.action === 'connect' && message.requestId)) await new Promise((resolve) => setTimeout(resolve, 0));
  const connectRequest = windows[0].sent.find(([, message]) => message.action === 'connect')[1].requestId;

  const disconnection = manager.disconnect();
  await assert.rejects(connection, (error) => error.code === 'WALLET_CONNECTION_CHANGED');
  assert.equal(manager.snapshot().state.connected, false);
  while (!windows[0].sent.some(([, message]) => message.action === 'disconnect' && message.requestId)) await new Promise((resolve) => setTimeout(resolve, 0));
  const disconnectRequest = windows[0].sent.find(([, message]) => message.action === 'disconnect')[1].requestId;
  await manager.handleBridgeEvent(windows[0].webContents, { type: 'result', requestId: disconnectRequest, ok: true, result: { connected: false } });
  await disconnection;

  assert.equal(await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: connectRequest, ok: true,
    result: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qlate' }] }
  }), false);
  assert.equal(manager.snapshot().state.connected, false);
});

test('a superseded slow disconnect rejects instead of returning stale disconnected state', async () => {
  const { manager, windows } = fixture({ autoResult: false });
  await manager.open(false);
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'state', state: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qone' }] }
  });
  const disconnection = manager.disconnect();
  const disconnectionRejection = assert.rejects(disconnection, (error) => error.code === 'WALLET_CONNECTION_CHANGED');
  while (!windows[0].sent.some(([, message]) => message.action === 'disconnect')) await new Promise((resolve) => setTimeout(resolve, 0));
  const disconnectRequest = windows[0].sent.find(([, message]) => message.action === 'disconnect')[1].requestId;
  const connection = manager.connect('wallet-two');
  while (!windows[0].sent.some(([, message]) => message.action === 'connect')) await new Promise((resolve) => setTimeout(resolve, 0));
  const connectRequest = windows[0].sent.find(([, message]) => message.action === 'connect')[1].requestId;
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: connectRequest, ok: true,
    result: { connected: true, walletId: 'wallet-two', accounts: [{ address: 'bc1qtwo' }] }
  });
  assert.equal((await connection).walletId, 'wallet-two');
  await disconnectionRejection;
  assert.equal(await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: disconnectRequest, ok: true, result: { connected: false }
  }), false);
  assert.equal(manager.snapshot().state.walletId, 'wallet-two');
});

test('bridge close during connect persistence prevents a stale successful return', async () => {
  const { manager, windows, holdNextPersistence } = fixture({ autoResult: false });
  const connection = manager.connect('wallet-one');
  while (!windows[0]?.sent.some(([, message]) => message.action === 'connect')) await new Promise((resolve) => setTimeout(resolve, 0));
  const requestId = windows[0].sent.find(([, message]) => message.action === 'connect')[1].requestId;
  const release = holdNextPersistence();
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId, ok: true,
    result: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qone' }] }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  windows[0].emit('closed');
  release();
  await assert.rejects(connection, (error) => error.code === 'WALLET_CONNECTION_CHANGED');
  assert.equal(manager.snapshot().state.connected, false);
});

test('a newer connect invalidates an older connect in either completion outcome', async () => {
  const { manager, windows } = fixture({ autoResult: false });
  const older = manager.connect('wallet-one');
  while (!windows[0]?.sent.some(([, message]) => message.action === 'connect')) await new Promise((resolve) => setTimeout(resolve, 0));
  const olderRequest = windows[0].sent.find(([, message]) => message.action === 'connect')[1].requestId;
  const newer = manager.connect('wallet-two');
  await assert.rejects(older, (error) => error.code === 'WALLET_CONNECTION_CHANGED');
  while (windows[0].sent.filter(([, message]) => message.action === 'connect').length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  const newerRequest = windows[0].sent.filter(([, message]) => message.action === 'connect')[1][1].requestId;

  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: newerRequest, ok: true,
    result: { connected: true, walletId: 'wallet-two', accounts: [{ address: 'bc1qnew' }] }
  });
  assert.equal((await newer).walletId, 'wallet-two');
  assert.equal(await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: olderRequest, ok: true,
    result: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qold' }] }
  }), false);
  assert.equal(manager.snapshot().state.walletId, 'wallet-two');
});

test('a failed newer connect cannot make an older late success authoritative', async () => {
  const { manager, windows } = fixture({ autoResult: false });
  const older = manager.connect('wallet-one');
  while (!windows[0]?.sent.some(([, message]) => message.action === 'connect')) await new Promise((resolve) => setTimeout(resolve, 0));
  const olderRequest = windows[0].sent.find(([, message]) => message.action === 'connect')[1].requestId;
  const newer = manager.connect('wallet-two');
  await assert.rejects(older, (error) => error.code === 'WALLET_CONNECTION_CHANGED');
  while (windows[0].sent.filter(([, message]) => message.action === 'connect').length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  const newerRequest = windows[0].sent.filter(([, message]) => message.action === 'connect')[1][1].requestId;

  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: newerRequest, ok: false,
    error: { code: 'USER_REJECTED', message: 'Rejected' }
  });
  await assert.rejects(newer, (error) => error.code === 'USER_REJECTED');
  assert.equal(await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: olderRequest, ok: true,
    result: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qold' }] }
  }), false);
  assert.equal(manager.snapshot().state.connected, false);
});

test('direct bridge state is accepted as a new connection intent', async () => {
  const { manager, windows } = fixture();
  await manager.open(false);
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'state',
    state: { connected: true, walletId: 'wallet-direct', accounts: [{ address: 'bc1qdirect' }] }
  });
  assert.equal(manager.snapshot().state.walletId, 'wallet-direct');
});

test('a connect invalidated while waiting for ready is never admitted', async () => {
  const { manager, windows } = fixture({ autoResult: false, autoReady: false });
  const older = manager.connect('wallet-one');
  while (!windows[0]) await new Promise((resolve) => setTimeout(resolve, 0));
  const newer = manager.connect('wallet-two');
  manager.handleReady(windows[0].webContents);
  await assert.rejects(older, (error) => error.code === 'WALLET_CONNECTION_CHANGED');
  while (!windows[0].sent.some(([, message]) => message.action === 'connect')) await new Promise((resolve) => setTimeout(resolve, 0));
  const connectMessages = windows[0].sent.filter(([, message]) => message.action === 'connect');
  assert.equal(connectMessages.length, 1);
  assert.equal(connectMessages[0][1].payload.walletId, 'wallet-two');
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId: connectMessages[0][1].requestId, ok: true,
    result: { connected: true, walletId: 'wallet-two', accounts: [{ address: 'bc1qnew' }] }
  });
  assert.equal((await newer).walletId, 'wallet-two');
});

test('discovery removal rejects only a pending connect for the removed exact wallet', async () => {
  const { manager, windows } = fixture({ autoResult: false });
  await manager.open(false);
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'discovered', wallets: [{ id: 'wallet-one' }, { id: 'wallet-other' }]
  });
  const connection = manager.connect('wallet-one');
  while (!windows[0].sent.some(([, message]) => message.action === 'connect')) await new Promise((resolve) => setTimeout(resolve, 0));

  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'discovered', wallets: [{ id: 'wallet-other' }]
  });
  await assert.rejects(connection, (error) => error.code === 'WALLET_PROVIDER_CHANGED' && error.status === 409);
  assert.equal(manager.snapshot().state.connected, false);
});

test('initial discovery and unrelated removal do not invalidate an admitted connect', async () => {
  const { manager, windows } = fixture({ autoResult: false });
  const connection = manager.connect('wallet-one');
  while (!windows[0]?.sent.some(([, message]) => message.action === 'connect')) await new Promise((resolve) => setTimeout(resolve, 0));
  const requestId = windows[0].sent.find(([, message]) => message.action === 'connect')[1].requestId;

  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'discovered', wallets: [{ id: 'wallet-one' }, { id: 'wallet-other' }]
  });
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'discovered', wallets: [{ id: 'wallet-one' }]
  });
  await manager.handleBridgeEvent(windows[0].webContents, {
    type: 'result', requestId, ok: true,
    result: { connected: true, walletId: 'wallet-one', accounts: [{ address: 'bc1qone' }] }
  });
  assert.equal((await connection).walletId, 'wallet-one');
});
