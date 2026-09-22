import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeAccounts, requestRpc, requestStyle } from '../src/wallet/adapters.js';

function element(tag = 'div') {
  return {
    tag, children: [], className: '', textContent: '', src: '',
    classList: { add() {}, remove() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, callback) { this[`on${type}`] = callback; }
  };
}

function loadWalletBridge(initialWallet) {
  const listeners = new Map();
  const elements = new Map(['wallets', 'bridge-status', 'request-panel', 'request-title', 'request-detail', 'extension-count', 'refresh'].map((id) => [id, element()]));
  const emitted = [];
  let requestSequence = 0;
  let commandHandler;
  const window = {
    walletHost: {
      emit: (event) => emitted.push(event),
      onCommand: (callback) => { commandHandler = callback; },
      ready() {}
    },
    addEventListener(type, callback) {
      const values = listeners.get(type) ?? [];
      values.push(callback); listeners.set(type, values);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) ?? []) callback(event);
    }
  };
  if (initialWallet) window.addEventListener('wallet-standard:app-ready', (event) => {
    assert.equal(Object.isFrozen(event.detail), true);
    window.initialUnregister = event.detail.register(initialWallet);
  });
  const document = { querySelector: (selector) => elements.get(selector.slice(1)), createElement: (tag) => element(tag) };
  let source = fs.readFileSync(new URL('../src/wallet/wallet.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, {
    window, document, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    normalizeAccounts, requestRpc, requestStyle,
    crypto: { randomUUID: () => 'fixture-request' }, Date, Promise, Error, Object, Map, WeakMap, Number, String, Boolean
  });
  const command = async (action, payload = {}) => {
    const requestId = `${action}-request-${++requestSequence}`;
    await commandHandler({ requestId, action, payload });
    return emitted.findLast((event) => event.type === 'result' && event.requestId === requestId);
  };
  const discovered = () => emitted.filter((event) => event.type === 'discovered').at(-1).wallets;
  return { window, elements, emitted, command, discovered };
}

function standardWallet(name, request) {
  return { name, icon: null, features: { 'sats-connect:': { version: '1.0.0', provider: { request } } } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function registerLate(bridge, wallet) {
  let unregister;
  bridge.window.dispatchEvent({ type: 'wallet-standard:register-wallet', detail: ({ register }) => { unregister = register(wallet); } });
  return unregister;
}

test('beta discovery is passive and connect/disconnect never request signing or broadcasting', async () => {
  const methods = [];
  const wallet = standardWallet('Connection-only fixture', async ({ method }) => {
    methods.push(method);
    if (method === 'getAccounts') return { addresses: [{ address: 'bc1qfixturepublicaddress' }] };
    if (method === 'wallet_disconnect') return true;
    throw new Error(`Unexpected wallet authority request: ${method}`);
  });
  const bridge = loadWalletBridge(wallet);
  await bridge.command('refresh');
  assert.deepEqual(methods, [], 'listing wallets must not request accounts or permissions');
  assert.equal((await bridge.command('connect', { walletId: bridge.discovered()[0].id })).ok, true);
  assert.deepEqual(methods, ['getAccounts']);
  await bridge.command('refresh');
  assert.deepEqual(methods, ['getAccounts'], 'refresh must not reconnect');
  assert.equal((await bridge.command('disconnect')).result.connected, false);
  assert.deepEqual(methods, ['getAccounts', 'wallet_disconnect']);
});

test('Wallet Standard feature-provider discovery retains initial and late registrations', async () => {
  const first = standardWallet('Fixture', async ({ method }) => method === 'getAccounts' ? { addresses: [{ address: 'bc1qfirst' }] } : true);
  const bridge = loadWalletBridge(first);
  assert.equal(bridge.discovered().length, 1);
  const firstId = bridge.discovered()[0].id;

  let unregisterLate;
  const late = standardWallet('Fixture', async () => ({ addresses: [{ address: 'bc1qlate' }] }));
  bridge.window.dispatchEvent({ type: 'wallet-standard:register-wallet', detail: ({ register }) => { unregisterLate = register(late); } });
  assert.equal(bridge.discovered().length, 2);
  assert.equal(new Set(bridge.discovered().map((wallet) => wallet.id)).size, 2);
  assert.equal((await bridge.command('connect', { walletId: firstId })).ok, true);

  unregisterLate();
  assert.equal(bridge.discovered().length, 1);
  assert.equal(bridge.discovered()[0].id, firstId);
});

test('duplicate registrations are no-ops and stale unregister callbacks cannot remove later registrations', () => {
  const wallet = standardWallet('x'.repeat(500), async () => ({ addresses: [] }));
  const bridge = loadWalletBridge(wallet);
  const id = bridge.discovered()[0].id;
  assert.ok(id.length <= 120);
  let duplicateUnregister;
  bridge.window.dispatchEvent({ type: 'wallet-standard:register-wallet', detail: ({ register }) => { duplicateUnregister = register(wallet); } });
  duplicateUnregister();
  assert.equal(bridge.discovered().length, 1);

  bridge.window.initialUnregister();
  assert.equal(bridge.discovered().length, 0);
  let currentUnregister;
  bridge.window.dispatchEvent({ type: 'wallet-standard:register-wallet', detail: ({ register }) => { currentUnregister = register(wallet); } });
  bridge.window.initialUnregister();
  assert.equal(bridge.discovered().length, 1);
  assert.equal(bridge.discovered()[0].id, id);
  currentUnregister();
  assert.equal(bridge.discovered().length, 0);
});

test('fake Wallet Standard connect rejection is returned and disconnect clears state', async () => {
  let reject = true;
  const wallet = standardWallet('Lifecycle', async ({ method }) => {
    if (method === 'getAccounts' && reject) throw Object.assign(new Error('User rejected'), { code: 'USER_REJECTED' });
    if (method === 'getAccounts') return { addresses: [{ address: 'bc1qlifecycle' }] };
    return true;
  });
  const bridge = loadWalletBridge(wallet);
  const walletId = bridge.discovered()[0].id;
  const denied = await bridge.command('connect', { walletId });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'USER_REJECTED');

  reject = false;
  const connected = await bridge.command('connect', { walletId });
  assert.equal(connected.ok, true);
  assert.equal(connected.result.accounts[0].address, 'bc1qlifecycle');
  assert.equal(bridge.emitted.some((event) => event.type === 'state'), false);
  assert.equal(bridge.elements.get('wallets').children[0].children[2].textContent, 'Connected');
  const disconnected = await bridge.command('disconnect');
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.result.connected, false);
  assert.equal(bridge.emitted.some((event) => event.type === 'state'), false);
  assert.equal(bridge.elements.get('wallets').children[0].children[2].textContent, 'Connect');
});

test('unregister revokes pending and established Wallet Standard connection authority', async () => {
  const held = deferred();
  const wallet = standardWallet('Revoked', async ({ method }) => method === 'getAccounts' ? held.promise : true);
  const bridge = loadWalletBridge();
  const unregister = registerLate(bridge, wallet);
  const walletId = bridge.discovered()[0].id;
  const pending = bridge.command('connect', { walletId });
  unregister();
  held.resolve({ addresses: [{ address: 'bc1qstale' }] });
  const stale = await pending;
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'WALLET_PROVIDER_CHANGED');
  assert.equal(bridge.emitted.some((event) => event.type === 'state' && event.state.connected), false);

  const activeWallet = standardWallet('Active', async () => ({ addresses: [{ address: 'bc1qactive' }] }));
  const unregisterActive = registerLate(bridge, activeWallet);
  const activeId = bridge.discovered()[0].id;
  assert.equal((await bridge.command('connect', { walletId: activeId })).ok, true);
  unregisterActive();
  assert.equal(bridge.emitted.filter((event) => event.type === 'state').at(-1).state.connected, false);
});

test('refresh and unrelated late registration retain pending and connected wallet authority', async () => {
  const held = deferred();
  const wallet = standardWallet('Stable', async () => held.promise);
  const bridge = loadWalletBridge(wallet);
  const walletId = bridge.discovered()[0].id;
  const pending = bridge.command('connect', { walletId });
  registerLate(bridge, standardWallet('Unrelated', async () => ({ addresses: [{ address: 'bc1qother' }] })));
  await bridge.command('refresh');
  held.resolve({ addresses: [{ address: 'bc1qstable' }] });
  assert.equal((await pending).ok, true);
  assert.equal(bridge.elements.get('wallets').children[0].children[2].textContent, 'Connected');

  await bridge.command('refresh');
  assert.equal(bridge.elements.get('wallets').children[0].children[2].textContent, 'Connected');
  assert.equal(bridge.emitted.some((event) => event.type === 'state'), false);
});

test('newer connect wins over an older deferred success or failure', async () => {
  for (const olderOutcome of ['success', 'failure']) {
    const oldRequest = deferred();
    const bridge = loadWalletBridge();
    registerLate(bridge, standardWallet(`Old ${olderOutcome}`, async () => oldRequest.promise));
    registerLate(bridge, standardWallet(`New ${olderOutcome}`, async () => ({ addresses: [{ address: `bc1qnew${olderOutcome}` }] })));
    const [oldWallet, newWallet] = bridge.discovered();
    const oldConnection = bridge.command('connect', { walletId: oldWallet.id });
    const newConnection = await bridge.command('connect', { walletId: newWallet.id });
    assert.equal(newConnection.ok, true);
    if (olderOutcome === 'success') oldRequest.resolve({ addresses: [{ address: 'bc1qold' }] });
    else oldRequest.reject(Object.assign(new Error('Old rejected'), { code: 'USER_REJECTED' }));
    assert.equal((await oldConnection).ok, false);
    assert.equal(newConnection.result.walletId, newWallet.id);
    assert.equal(bridge.elements.get('wallets').children[1].children[2].textContent, 'Connected');
  }
});

test('slow disconnect cannot clear a newer connection', async () => {
  const heldDisconnect = deferred();
  const bridge = loadWalletBridge();
  registerLate(bridge, standardWallet('First', async ({ method }) => method === 'wallet_disconnect'
    ? heldDisconnect.promise : { addresses: [{ address: 'bc1qfirst' }] }));
  registerLate(bridge, standardWallet('Second', async () => ({ addresses: [{ address: 'bc1qsecond' }] })));
  const [first, second] = bridge.discovered();
  await bridge.command('connect', { walletId: first.id });
  const disconnecting = bridge.command('disconnect');
  assert.equal(bridge.emitted.some((event) => event.type === 'state'), false);
  assert.equal(bridge.elements.get('wallets').children[0].children[2].textContent, 'Connect');
  assert.equal((await bridge.command('connect', { walletId: second.id })).ok, true);
  heldDisconnect.resolve(true);
  assert.equal((await disconnecting).ok, true);
  assert.equal(bridge.elements.get('wallets').children[1].children[2].textContent, 'Connected');
});

test('reconnect to the same provider waits for its older disconnect transport', async () => {
  const heldDisconnect = deferred();
  let accountRequests = 0;
  const wallet = standardWallet('Same provider', async ({ method }) => {
    if (method === 'wallet_disconnect') return heldDisconnect.promise;
    accountRequests += 1;
    return { addresses: [{ address: `bc1qsame${accountRequests}` }] };
  });
  const bridge = loadWalletBridge(wallet);
  const walletId = bridge.discovered()[0].id;
  await bridge.command('connect', { walletId });
  const disconnecting = bridge.command('disconnect');
  const reconnecting = bridge.command('connect', { walletId });
  await Promise.resolve();
  assert.equal(accountRequests, 1);
  heldDisconnect.resolve(true);
  await disconnecting;
  assert.equal((await reconnecting).ok, true);
  assert.equal(accountRequests, 2);
  assert.equal(bridge.elements.get('wallets').children[0].children[2].textContent, 'Connected');
});

test('queued same-provider reconnect cannot supersede a newer unrelated connection', async () => {
  const heldDisconnect = deferred();
  let firstAccountRequests = 0;
  const firstWallet = standardWallet('First queued', async ({ method }) => {
    if (method === 'wallet_disconnect') return heldDisconnect.promise;
    firstAccountRequests += 1;
    return { addresses: [{ address: 'bc1qfirstqueued' }] };
  });
  const bridge = loadWalletBridge(firstWallet);
  registerLate(bridge, standardWallet('New winner', async () => ({ addresses: [{ address: 'bc1qwinner' }] })));
  const [first, winner] = bridge.discovered();
  await bridge.command('connect', { walletId: first.id });
  const disconnecting = bridge.command('disconnect');
  const queuedReconnect = bridge.command('connect', { walletId: first.id });
  const winningConnect = await bridge.command('connect', { walletId: winner.id });
  assert.equal(winningConnect.ok, true);
  heldDisconnect.resolve(true);
  await disconnecting;
  const stale = await queuedReconnect;
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'WALLET_PROVIDER_CHANGED');
  assert.equal(firstAccountRequests, 1);
  assert.equal(bridge.elements.get('wallets').children[1].children[2].textContent, 'Connected');
});

test('direct wallet bridge button retains uncorrelated state events', async () => {
  const wallet = standardWallet('Direct', async () => ({ addresses: [{ address: 'bc1qdirect' }] }));
  const bridge = loadWalletBridge(wallet);
  const connectButton = bridge.elements.get('wallets').children[0].children[2];
  await connectButton.onclick();
  const state = bridge.emitted.filter((event) => event.type === 'state').at(-1);
  assert.equal(state.state.connected, true);
  assert.equal(state.state.walletId, bridge.discovered()[0].id);
  assert.equal(connectButton.textContent, 'Connect');
  assert.equal(bridge.elements.get('wallets').children[0].children[2].textContent, 'Connected');
});
