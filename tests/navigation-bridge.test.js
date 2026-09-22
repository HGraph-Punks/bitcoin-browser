import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { parseNavigationInput } from '../src/shared/navigation.js';
import { assertString } from '../src/shared/validation.js';
import { NavigationRequests } from '../src/main/navigation-requests.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { discoverOrdInscriptions } from '../src/main/providers/ord-discovery.js';

const ipcSource = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function registerIpc', 'function registerIpc');
const preloadSource = fs.readFileSync(new URL('../src/main/preload.cjs', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
function event() {
  const sender = new EventEmitter();
  sender.mainFrame = { url: 'app://app/renderer/index.html', processId: 11, routingId: 7, detached: false };
  sender.isDestroyed = () => false;
  sender.getURL = () => sender.mainFrame.url;
  return { sender, senderFrame: sender.mainFrame };
}
function fixture(t, providerManager) {
  const handlers = new Map(), calls = [], effects = [], releases = [];
  const owner = event();
  const options = { providerManager: providerManager ?? { async resolve(target, controls) { effects.push({ target, controls }); return { entity: { kind: target.kind } }; } } };
  const injected = { path, IPC, AppError, serializeError, parseNavigationInput, assertString, NavigationRequests,
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on() {} } };
  const register = vm.runInNewContext(`(injected => { const { path, IPC, AppError, serializeError, parseNavigationInput, assertString, NavigationRequests, ipcMain } = injected; ${ipcSource}; return registerIpc; })`, { URL, process, structuredClone })(injected);
  const lifecycle = register(options);
  const invoke = (channel, payload, sourceEvent = owner) => handlers.get(channel)(sourceEvent, structuredClone(payload));
  let api;
  vm.runInNewContext(preloadSource, { require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer: {
      invoke(channel, payload) { calls.push({ channel, payload: structuredClone(payload) }); return invoke(channel, payload); }, on() {}, removeListener() {}
    } };
  } });
  const hold = () => { let resolve; const promise = new Promise(r => { resolve = r; }); releases.push(resolve); return { promise, resolve }; };
  t.after(async () => { releases.forEach(release => release()); await lifecycle.shutdown(); await providerManager?.shutdown?.(); });
  return { api: api.navigation, owner, invoke, lifecycle, options, effects, calls, hold };
}

test('actual preload/IPC/registry preserve navigation result/options and hidden main-owned signal', async t => {
  const f = fixture(t);
  const options = { network: 'mainnet', preferredProviderId: 'source', localOnly: true, timeoutMs: 1250, maxBytes: 4096 };
  const result = await f.api.resolve('sat:1', options, 'one');
  assert.equal(result.target.canonical, 'sat:1');
  assert.deepEqual(copy(result.entity), { kind: 'sat' });
  assert.deepEqual(copy({ ...f.effects[0].controls, signal: undefined }), options);
  assert.equal(f.effects[0].controls.signal instanceof AbortSignal, true);
  assert.deepEqual(f.calls.map(c => c.channel), [IPC.ENTITY_RESOLVE_PREPARE, IPC.ENTITY_RESOLVE]);
  assert.equal(Object.hasOwn(f.calls[1].payload, 'input'), false);
  assert.deepEqual(copy(await f.api.cancelResolve('one')), { requested: false });
  assert.equal(f.owner.sender.eventNames().length, 0);
});

test('preparation binds synchronously at IPC delivery before cross-document navigation', async t => {
  const f = fixture(t);
  const preparation = f.invoke(IPC.ENTITY_RESOLVE_PREPARE, { input: 'sat:1' });
  assert.equal(f.owner.sender.listenerCount('did-start-navigation'), 1);
  f.owner.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  const { result } = await preparation;
  const resolution = await f.invoke(IPC.ENTITY_RESOLVE, { handle: result.handle });
  assert.equal(resolution.error.code, 'NAVIGATION_CANCELLED');
  assert.equal(f.effects.length, 0);
});

test('preparation and handle controls reject untrusted or different frame/window ownership', async t => {
  const f = fixture(t);
  const preparation = await f.invoke(IPC.ENTITY_RESOLVE_PREPARE, { input: 'sat:1' });
  const handle = preparation.result.handle;
  const stranger = event();
  for (const channel of [IPC.ENTITY_RESOLVE_CANCEL, IPC.ENTITY_RESOLVE]) {
    assert.equal((await f.invoke(channel, { handle }, stranger)).error.code, 'NAVIGATION_OWNER_INVALID');
    const child = { ...f.owner, senderFrame: { ...f.owner.senderFrame, routingId: 8 } };
    assert.equal((await f.invoke(channel, { handle }, child)).error.code, 'NAVIGATION_OWNER_INVALID');
    const untrusted = { ...f.owner, senderFrame: { url: 'https://attacker.invalid/' } };
    assert.equal((await f.invoke(channel, { handle }, untrusted)).error.code, 'UNTRUSTED_IPC_SENDER');
  }
  assert.equal((await f.invoke(IPC.ENTITY_RESOLVE, { handle })).ok, true);
  assert.equal(f.effects.length, 1);
});

test('tracked request schemas reject unsupported controls before provider admission', async t => {
  const f = fixture(t);
  for (const options of [[], 'bad', { signal: {} }, { handle: 1 }, { network: 'unknown' }, { preferredProviderId: 'x' },
    { localOnly: 1 }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { maxBytes: 0 }, { maxBytes: 1073741825 }, { timeoutMs: NaN }]) {
    const result = await f.invoke(IPC.ENTITY_RESOLVE_PREPARE, { input: 'sat:1', options });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await f.invoke(IPC.ENTITY_RESOLVE_PREPARE, { input: 'sat:1', handle: 1 })).error.code, 'VALIDATION_ERROR');
  const prepared = await f.invoke(IPC.ENTITY_RESOLVE_PREPARE, { input: 'sat:1' });
  assert.equal((await f.invoke(IPC.ENTITY_RESOLVE, { handle: prepared.result.handle, input: 'sat:2' })).error.code, 'VALIDATION_ERROR');
  assert.equal((await f.invoke(IPC.ENTITY_RESOLVE_CANCEL, { handle: prepared.result.handle, options: {} })).error.code, 'VALIDATION_ERROR');
  await f.invoke(IPC.ENTITY_RESOLVE_CANCEL, { handle: prepared.result.handle });
  assert.equal(f.effects.length, 0); assert.equal(f.owner.sender.eventNames().length, 0);
});

test('cancellation before prepare acknowledgment cannot start actual manager work', async t => {
  const f = fixture(t);
  const result = f.api.resolve('sat:1', undefined, 'early');
  const rejected = assert.rejects(result, e => e.code === 'NAVIGATION_CANCELLED');
  await f.api.cancelResolve('early'); await rejected;
  assert.equal(f.effects.length, 0);
  assert.deepEqual(f.calls.map(c => c.channel), [IPC.ENTITY_RESOLVE_PREPARE, IPC.ENTITY_RESOLVE_CANCEL]);
});

test('exact cancellation preserves another live request and shutdown owns ignored-abort work', async t => {
  const f = fixture(t), entered = f.hold(), held = f.hold();
  let firstSignal;
  f.options.providerManager.resolve = async (target, controls) => {
    if (target.value === '1') { firstSignal = controls.signal; entered.resolve(); await held.promise; }
    return { entity: { kind: target.kind } };
  };
  const first = f.api.resolve('sat:1', undefined, 'first');
  const rejected = assert.rejects(first, e => e.code === 'NAVIGATION_CANCELLED');
  await entered.promise;
  assert.deepEqual(copy(await f.api.cancelResolve('first')), { requested: true });
  assert.equal(firstSignal.aborted, true);
  assert.equal((await f.api.resolve('sat:2', undefined, 'second')).target.canonical, 'sat:2');
  let drained = false;
  const stopping = f.lifecycle.shutdown().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  held.resolve(); await rejected; await stopping;
  assert.equal(f.owner.sender.eventNames().length, 0);
  assert.equal((await f.invoke(IPC.ENTITY_RESOLVE_PREPARE, { input: 'sat:3' })).error.code, 'APP_SHUTTING_DOWN');
});

test('cross-document replacement aborts old work while allowing new document navigation', async t => {
  const f = fixture(t), entered = f.hold(), held = f.hold();
  let oldSignal;
  f.options.providerManager.resolve = async (target, controls) => {
    if (target.value === '1') { oldSignal = controls.signal; entered.resolve(); await held.promise; }
    return { entity: { kind: target.kind } };
  };
  const old = f.api.resolve('sat:1', undefined, 'old');
  const rejected = assert.rejects(old, e => e.code === 'NAVIGATION_CANCELLED');
  await entered.promise;
  f.owner.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal(oldSignal.aborted, false);
  f.owner.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(oldSignal.aborted, true);
  assert.equal((await f.api.resolve('sat:2', undefined, 'new')).target.canonical, 'sat:2');
  held.resolve(); await rejected;
  assert.equal(f.owner.sender.eventNames().length, 0);
});

test('real preload/IPC/registry/ProviderManager/Ord discovery stop post-abort metadata and cache publication', async t => {
  const settings = { network: 'mainnet', localOnly: false, offlineMode: false, requestTimeoutMs: 1000, maxResourceBytes: 1048576 };
  let writes = 0;
  const manager = new ProviderManager({ get: keys => keys[0] === 'settings' ? settings : [] }, {}, null, {
    async put(_key, _bytes, _metadata, _ttl, controls) { controls.validate(); writes++; }
  });
  const f = fixture(t, manager), entered = f.hold(), held = f.hold(), paths = [];
  const json = value => ({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from(JSON.stringify(value)) });
  manager.candidates = () => [{ id: 'controlled', async resolve(target, controls) {
    const data = await discoverOrdInscriptions({ async fetchPath(value) {
      paths.push(value); entered.resolve(); await held.promise;
      return value.startsWith('/inscriptions/') ? json({ ids: [`${'a'.repeat(64)}i0`], more: false })
        : json({ id: `${'a'.repeat(64)}i0`, number: 1, content_type: 'text/plain' });
    } }, target, controls);
    return { kind: 'inscriptions', data };
  } }];
  const result = f.api.resolve('satnav://inscriptions', undefined, 'gallery');
  const rejected = assert.rejects(result, e => e.code === 'NAVIGATION_CANCELLED');
  await entered.promise; await f.api.cancelResolve('gallery');
  assert.equal(manager.activeOperations.size, 1, 'ignored-abort listing remains owned');
  held.resolve(); await rejected;
  assert.equal(paths.length, 1); assert.equal(writes, 0); assert.equal(manager.activeOperations.size, 0);
});
