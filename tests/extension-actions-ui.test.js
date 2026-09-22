import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function extract(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} extraction boundary`);
  return app.slice(from, to);
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(route = 'wallet') {
  let currentRoute = route;
  let model = { wallet: { state: { connected: true, walletId: 'old' }, discovered: [{ id: 'old' }], extensions: [] } };
  const renders = [];
  const toasts = [];
  const calls = [];
  const install = deferred();
  const remove = deferred();
  const lists = [];
  const discoveries = [];
  const api = {
    extensions: {
      install: () => { calls.push(['install']); return install.promise; },
      remove: (id) => { calls.push(['remove', id]); return remove.promise; },
      list: () => { calls.push(['list']); return lists.shift()?.promise ?? Promise.resolve([]); }
    },
    wallet: { discover: () => { calls.push(['discover']); return discoveries.shift()?.promise ?? Promise.resolve({ state: {}, extensions: [] }); } }
  };
  const scope = {
    api,
    MODEL: { patch(value) { model = { ...model, ...value }; } },
    state: () => model,
    routeName: () => currentRoute,
    renderPage: () => renders.push(currentRoute),
    toast: (...args) => toasts.push(args)
  };
  const actions = vm.runInNewContext(`(() => {
    let pendingExtensionAction = null;
    ${extract('async function installExtension(', '\nasync function inspectPsbt(')}
    return { installExtension, removeExtension, refreshExtensions, pending: () => pendingExtensionAction, recovery: () => extensionOutcomeRecovery };
  })()`, scope);
  return {
    ...actions, install, remove, calls, renders, toasts,
    model: () => structuredClone(model), setRoute: (value) => { currentRoute = value; },
    nextList() { const value = deferred(); lists.push(value); return value; },
    nextDiscovery() { const value = deferred(); discoveries.push(value); return value; }
  };
}

const wallet = (extensions, extra = {}) => ({
  state: { connected: false }, discovered: [], extensions, extensionsChanging: false, extensionRecovery: null, ...extra
});

test('v2 install publishes its authoritative wallet snapshot without duplicate discovery', async () => {
  const f = fixture();
  const pending = f.installExtension();
  f.install.resolve({ extensionMutationCommitted: true, operation: 'install', extensions: [{ id: 'one' }], wallet: wallet([]), walletRefreshPending: false });
  await pending;
  assert.deepEqual(f.calls, [['install']]);
  assert.deepEqual(f.model().wallet.extensions, [{ id: 'one' }]);
  assert.equal(f.model().wallet.state.connected, false);
  assert.equal(f.toasts.at(-1)[0], 'Wallet extension installed');
});

test('committed maintenance failure publishes manager and revoked-wallet truth with recovery', async () => {
  const f = fixture();
  const pending = f.removeExtension('owned');
  const managerRecovery = { code: 'WALLET_PERSISTENCE_FAILED', message: 'wallet persistence failed' };
  const error = Object.assign(new Error('wallet persistence failed'), { code: 'EXTENSION_WALLET_REFRESH_FAILED', details: {
    extensionMutationCommitted: true, operation: 'remove', extensions: [], wallet: wallet([], { extensionRecovery: managerRecovery }), walletRefreshPending: true, recovery: 'wallet:discover'
  } });
  f.remove.reject(error);
  await pending;
  assert.deepEqual(f.model().wallet.extensions, []);
  assert.equal(f.model().wallet.state.connected, false, 'revoked wallet snapshot replaces stale connected state');
  assert.deepEqual(f.model().wallet.extensionRecovery, managerRecovery);
  assert.equal(f.toasts.at(-1)[0], 'Extension removed, but wallet refresh failed');
});

test('mutation rejection with authoritative partial state publishes truth without claiming commit', async () => {
  const f = fixture();
  const pending = f.installExtension();
  const extensions = [{ id: 'unsaved', loaded: true, persisted: false, error: { code: 'EXTENSION_ROLLBACK_FAILED', message: 'cleanup failed' }, recovery: 'Remove it.' }];
  f.install.reject(Object.assign(new Error('cleanup failed'), { code: 'EXTENSION_ROLLBACK_FAILED', details: {
    extensionMutationCommitted: false, operation: 'install', extensions, wallet: wallet(extensions), walletRefreshPending: false
  } }));
  await pending;
  assert.deepEqual(f.model().wallet.extensions, extensions);
  assert.equal(f.toasts.at(-1)[0], 'Extension installation failed');
});

test('shared pending ownership suppresses duplicate and cross-kind extension mutations', async () => {
  const f = fixture();
  const first = f.installExtension();
  await Promise.all([f.installExtension(), f.removeExtension('other'), f.refreshExtensions()]);
  assert.deepEqual(f.calls, [['install']]);
  assert.equal(f.pending(), 'install');
  f.install.resolve({ extensionMutationCommitted: true, operation: 'install', extensions: [], wallet: wallet([]), walletRefreshPending: false });
  await first;
  assert.equal(f.pending(), null);
});

test('navigation while pending publishes state without repainting an unrelated page', async () => {
  const f = fixture('wallet');
  const pending = f.removeExtension('owned');
  const rendersBeforeCompletion = f.renders.length;
  f.setRoute('settings');
  f.remove.resolve({ extensionMutationCommitted: true, operation: 'remove', extensions: [], wallet: wallet([]), walletRefreshPending: false });
  await pending;
  assert.equal(f.renders.length, rendersBeforeCompletion);
  assert.deepEqual(f.model().wallet.extensions, []);
});

test('recovery retries list and wallet maintenance only, never the mutation', async () => {
  const f = fixture();
  const list = f.nextList();
  const discovery = f.nextDiscovery();
  const pending = f.refreshExtensions();
  list.resolve([{ id: 'retained' }]);
  discovery.resolve(wallet([]));
  await pending;
  assert.deepEqual(f.calls, [['list'], ['discover']]);
  assert.deepEqual(f.model().wallet.extensions, [{ id: 'retained' }]);
  assert.equal(f.model().wallet.extensionRecovery, null);
});

test('failed recovery discovery retains the freshly listed manager truth and retry warning', async () => {
  const f = fixture();
  const list = f.nextList();
  const discovery = f.nextDiscovery();
  const pending = f.refreshExtensions();
  list.resolve([{ id: 'runtime-off', loaded: false, error: { code: 'EXTENSION_REMOVE_SAVE_FAILED', message: 'save failed' } }]);
  discovery.reject(new Error('wallet still unavailable'));
  await pending;
  assert.deepEqual(f.calls, [['list'], ['discover']]);
  assert.equal(f.model().wallet.extensions[0].id, 'runtime-off');
  assert.equal(f.model().wallet.extensionRecovery.operation, 'refresh');
  assert.equal(f.toasts.at(-1)[0], 'Could not refresh wallet extensions');
});

test('legacy success reconciles by listing and discovering without resubmitting', async () => {
  const f = fixture();
  const list = f.nextList();
  const discovery = f.nextDiscovery();
  const pending = f.installExtension();
  f.install.resolve({ id: 'legacy-result' });
  list.resolve([{ id: 'legacy-result' }]);
  discovery.resolve(wallet([]));
  await pending;
  assert.deepEqual(f.calls, [['install'], ['list'], ['discover']]);
});

test('malformed or wrong-operation v2 success never publishes or reports success', async () => {
  for (const result of [
    { extensionMutationCommitted: true, operation: 'remove', extensions: [], wallet: wallet([]), walletRefreshPending: false },
    { extensionMutationCommitted: true, operation: 'install', extensions: null, wallet: wallet([]), walletRefreshPending: false },
    { extensionMutationCommitted: true, operation: 'install', extensions: [], wallet: { state: {} }, walletRefreshPending: false },
    { extensionMutationCommitted: true, operation: 'install', extensions: [], wallet: wallet([]), walletRefreshPending: true },
    { extensionMutationCommitted: true, operation: 'install', extensions: [], wallet: wallet([], { extensionsChanging: true }), walletRefreshPending: false },
    { extensionMutationCommitted: true, operation: 'install', extensions: [], wallet: wallet([], { extensionRecovery: { code: 'BAD', message: 'bad' } }), walletRefreshPending: false },
    { extensionMutationCommitted: false, operation: 'install', extensions: [], wallet: wallet([]), walletRefreshPending: false },
    { extensionMutationCommitted: true, operation: 'install', extensions: null, wallet: null, walletRefreshPending: false, stateReadErrors: [{ source: 'extensions' }] }
  ]) {
    const f = fixture();
    const before = f.model();
    const pending = f.installExtension();
    f.install.resolve(result);
    await pending;
    assert.deepEqual(f.model(), before);
    assert.equal(f.toasts.at(-1)[0], 'Extension outcome unconfirmed');
    assert.match(f.toasts.at(-1)[1], /Refresh extensions and wallets/);
    assert.equal(f.recovery().code, 'EXTENSION_OUTCOME_UNCONFIRMED');
    assert.deepEqual(f.calls, [['install']], 'malformed v2 does not discover, list, or replay mutation');
  }
});

test('wrong-operation or malformed error details cannot overwrite current wallet authority', async () => {
  for (const details of [
    { extensionMutationCommitted: true, operation: 'install', extensions: [], wallet: wallet([], { extensionRecovery: { code: 'FAIL', message: 'failed' } }), walletRefreshPending: true },
    { extensionMutationCommitted: true, operation: 'remove', extensions: [], wallet: { state: {} }, walletRefreshPending: true },
    { extensionMutationCommitted: true, operation: 'remove', extensions: [], wallet: wallet([]), walletRefreshPending: 'yes' },
    { extensionMutationCommitted: true, operation: 'remove', extensions: [], wallet: wallet([]), walletRefreshPending: true }
  ]) {
    const f = fixture();
    const before = f.model();
    const pending = f.removeExtension('owned');
    f.remove.reject(Object.assign(new Error('malformed response'), { code: 'EXTENSION_WALLET_REFRESH_FAILED', details }));
    await pending;
    assert.deepEqual(f.model(), before);
    assert.equal(f.toasts.at(-1)[0], 'Extension outcome unconfirmed');
    assert.equal(f.recovery().code, 'EXTENSION_OUTCOME_UNCONFIRMED');
  }
});

test('settled success preserves the explicit safe manager lifecycle fields', async () => {
  const f = fixture();
  const pending = f.installExtension();
  f.install.resolve({
    extensionMutationCommitted: true, operation: 'install', extensions: [{ id: 'one' }],
    wallet: wallet([]), walletRefreshPending: false
  });
  await pending;
  assert.equal(f.model().wallet.extensionRecovery, null);
  assert.equal(f.model().wallet.extensionsChanging, false);
});

test('wallet view exposes partial manager recovery and disables mutations under shared pending ownership', async () => {
  class NodeStub {
    constructor(tag = '#text', value = '') { this.tagName = tag === '#text' ? undefined : tag.toUpperCase(); this.textContent = value; this.children = []; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.className = ''; this.disabled = false; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'disabled') this.disabled = Boolean(value); }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'disabled') this.disabled = false; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    querySelectorAll(selector) { const found = []; const walk = (node) => { for (const child of node.children ?? []) { if (child.tagName === selector.toUpperCase()) found.push(child); walk(child); } }; walk(this); return found; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  globalThis.Node = NodeStub;
  globalThis.document = {
    createElement: (tag) => new NodeStub(tag), createTextNode: (value) => new NodeStub('#text', String(value)), createDocumentFragment: () => new NodeStub('fragment')
  };
  const { renderWallet } = await import('../src/renderer/views.js');
  const calls = [];
  const root = renderWallet({ wallet: {
    state: { connected: false }, discovered: [], signingEnabled: false,
    extensionRecovery: { operation: 'install', message: 'Wallet refresh did not finish.' },
    extensions: [{ id: 'unsaved', name: 'Unsaved', version: '1', path: '/owned/fixture', loaded: true, persisted: false,
      error: { code: 'EXTENSION_ROLLBACK_FAILED', message: 'Cleanup failed' }, recovery: 'Remove the still-loaded extension.' }]
  } }, new Proxy({
    extensionActionPending: () => 'refresh', refreshExtensions: () => calls.push('refresh'), removeExtension: () => calls.push('remove')
  }, { get(target, key) { return key in target ? target[key] : () => {}; } }));
  const content = (node) => `${node.textContent ?? ''}${(node.children ?? []).map(content).join('')}`;
  assert.match(content(root), /Loaded · not saved/);
  assert.match(content(root), /EXTENSION_ROLLBACK_FAILED: Cleanup failed/);
  assert.match(content(root), /Remove the still-loaded extension/);
  assert.match(content(root), /Wallet refresh did not finish/);
  const buttons = root.querySelectorAll('button');
  assert.ok(buttons.some((button) => content(button) === 'Refreshing…' && button.disabled));
  assert.ok(buttons.some((button) => content(button) === 'Remove' && button.disabled));
  assert.deepEqual(calls, [], 'rendering performs no extension or wallet action');
});

test('wallet manager transition snapshot disables extension controls without eager actions', async () => {
  const { renderWallet } = await import('../src/renderer/views.js');
  const calls = [];
  const root = renderWallet({ wallet: {
    state: { connected: false }, discovered: [], extensions: [{ id: 'one', name: 'One', version: '1', path: '/owned/one', loaded: true }],
    extensionsChanging: true, extensionRecovery: null, signingEnabled: false
  } }, new Proxy({
    extensionActionPending: () => null,
    extensionActionRecovery: () => ({ code: 'EXTENSION_OUTCOME_UNCONFIRMED', message: 'Refresh extensions and wallets before trying another change.' }),
    refreshExtensions: () => calls.push('refresh'), installExtension: () => calls.push('install'), removeExtension: () => calls.push('remove')
  }, { get(target, key) { return key in target ? target[key] : () => {}; } }));
  const content = (node) => `${node.textContent ?? ''}${(node.children ?? []).map(content).join('')}`;
  assert.match(content(root), /Extension controls are temporarily unavailable/);
  assert.match(content(root), /Refresh extensions and wallets before trying another change/);
  const extensionButtons = root.querySelectorAll('button').filter((button) => ['Remove', 'Refresh extensions', 'Install extension'].includes(content(button)));
  assert.equal(extensionButtons.length, 3);
  assert.ok(extensionButtons.every((button) => button.disabled));
  assert.deepEqual(calls, []);
});
