import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProviderManager } from '../src/main/provider-manager.js';
import { DiskCache } from '../src/main/cache.js';
import { AppError } from '../src/shared/errors.js';
import { discoveryTarget } from '../src/shared/discovery.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const reason = () => new AppError('REQUEST_ABORTED', 'Controlled exact navigation cancellation', { status: 499 });
const inscriptionId = n => `${n.toString(16).padStart(64, '0')}i0`;
const response = (body, status = 200, type = 'application/json') => ({
  status, headers: { 'content-type': type }, latencyMs: 1,
  data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
});
const config = (id, priority, type = 'mock') => ({
  id, name: id, type, network: 'mainnet', baseUrl: type === 'mock' ? '' : 'http://127.0.0.1:1',
  enabled: true, local: true, priority, capabilities: ['block', 'inscription', 'inscription-number']
});

function fixture(t, { ord = false, cache = null, offline = false } = {}) {
  const providers = [config('first', 1, ord ? 'ord-server' : 'mock'), config('fallback', 2)];
  const state = { providers, settings: { network: 'mainnet', localOnly: false, offlineMode: offline,
    preferredProviderId: null, requestTimeoutMs: 1000, maxResourceBytes: 1024 * 1024 } };
  const store = { get: keys => structuredClone(state[keys[0]]) };
  const warnings = [], releases = [];
  const manager = new ProviderManager(store, { get: () => null }, { warn: (...args) => warnings.push(args) }, cache);
  t.after(async () => { for (const release of releases) release(); await manager.shutdown(); });
  return { manager, first: manager.instances.get('first'), fallback: manager.instances.get('fallback'), warnings, releases };
}

test('exact caller pre-abort prevents provider and offline cache admission without changing global routing', async t => {
  for (const offline of [false, true]) {
    const controller = new AbortController(), cancelled = reason(); controller.abort(cancelled);
    const f = fixture(t, { offline, cache: { get: () => assert.fail('aborted read'), put: () => assert.fail('aborted write') } });
    f.first.resolve = () => assert.fail('aborted provider');
    const revision = f.manager.routingGeneration;
    await assert.rejects(f.manager.resolve(parseNavigationInput('block:840000'), { signal: controller.signal }), error => error === cancelled);
    assert.equal(f.manager.routingGeneration, revision);
    assert.equal(f.manager.activeOperations.size, 0); assert.equal(f.manager.pendingWork.size, 0);
  }
});

test('exact abort suppresses ignored late success, cache, health and fallback without cancelling a different request', async t => {
  const controller = new AbortController(), cancelled = reason(), held = deferred(), entered = deferred();
  const writes = [];
  const f = fixture(t, { cache: { async put(key, _data, _meta, _ttl, options) { options.validate(); writes.push(key); } } });
  f.releases.push(() => held.resolve({ type: 'block', source: { id: 'first' } }));
  let oldSignal;
  f.first.resolve = async (target, options) => {
    if (target.value === '840000') { oldSignal = options.signal; entered.resolve(); return held.promise; }
    return { type: 'block', source: { id: 'first' }, current: true };
  };
  f.fallback.resolve = () => assert.fail('cancelled request must not fail over');
  const pending = f.manager.resolve(parseNavigationInput('block:840000'), { signal: controller.signal });
  const outcome = pending.catch(error => error); await entered.promise;
  const revision = f.manager.routingGeneration; controller.abort(cancelled);
  assert.equal(oldSignal.aborted, true); assert.equal(oldSignal.reason, cancelled);
  assert.equal(f.manager.activeOperations.size, 1);
  const current = await f.manager.resolve(parseNavigationInput('block:840001'));
  assert.equal(current.entity.current, true); assert.equal(f.manager.routingGeneration, revision);
  const health = structuredClone(f.manager.healthState.get('first'));
  held.resolve({ type: 'block', source: { id: 'first' }, obsolete: true });
  assert.equal(await outcome, cancelled);
  assert.deepEqual(writes, ['v1|entity|mainnet|block:840001']);
  assert.deepEqual(f.manager.healthState.get('first'), health); assert.equal(f.warnings.length, 0);
  assert.equal(f.manager.activeOperations.size, 0); assert.equal(f.manager.pendingWork.size, 0);
});

test('discovery cancellation must stop new metadata admission even when existing transport ignores abort', { timeout: 2000 }, async t => {
  const controller = new AbortController(), cancelled = reason();
  const held = Array.from({ length: 4 }, deferred), entered = deferred();
  const calls = []; let active = 0, maximum = 0, cacheWrites = 0;
  const f = fixture(t, { ord: true, cache: { put: () => { cacheWrites++; } } });
  f.releases.push(() => { for (const gate of held) gate.resolve(); });
  f.fallback.resolve = () => assert.fail('cancelled gallery must not fail over');
  f.first.fetchPath = async (requestPath, options) => {
    if (requestPath === '/inscriptions/0') return response({ ids: Array.from({ length: 24 }, (_, n) => inscriptionId(n)), more: false });
    const id = requestPath.slice('/r/inscription/'.length);
    const index = calls.length; calls.push({ id, admittedAfterAbort: options.signal.aborted });
    active++; maximum = Math.max(maximum, active);
    try {
      if (calls.length === 4) entered.resolve();
      if (index < 4) await held[index].promise;
      // Deliberately ignore the aborted signal, as a transport already near
      // completion can do. Admission of later IDs still belongs to discovery.
      return response({ id, number: index, content_type: 'image/png' });
    } finally { active--; }
  };
  const pending = f.manager.resolve(discoveryTarget(''), { signal: controller.signal });
  const outcome = pending.catch(error => error); await entered.promise;
  controller.abort(cancelled);
  for (const gate of held.slice(1)) gate.resolve();
  await nextTurn();
  assert.equal(f.manager.activeOperations.size, 1, 'Already admitted ignored-abort work stays owned until settlement');
  held[0].resolve(); assert.equal(await outcome, cancelled);
  t.diagnostic(JSON.stringify({ nativeExecuted: false, metadataCalls: calls.length,
    callsAfterAbort: calls.filter(call => call.admittedAfterAbort).length, maximum, cacheWrites }));
  assert.equal(active, 0); assert.ok(maximum <= 4); assert.equal(cacheWrites, 0);
  assert.equal(f.manager.healthState.has('first'), false);
  assert.equal(calls.length, 4, 'Abort must not replenish the four metadata workers');
  assert.equal(calls.some(call => call.admittedAfterAbort), false);
});

test('discovery listing cancellation blocks HTML fallback and metadata after ignored late listing success', async t => {
  const controller = new AbortController(), cancelled = reason();
  const f = fixture(t, { ord: true }); const calls = [];
  f.first.fetchPath = async (requestPath) => { calls.push(requestPath); controller.abort(cancelled); return response('JSON disabled', 406, 'text/plain'); };
  f.fallback.resolve = () => assert.fail('cancelled listing must not fail over');
  await assert.rejects(f.manager.resolve(discoveryTarget(''), { signal: controller.signal }), error => error === cancelled);
  assert.deepEqual(calls, ['/inscriptions/0']);
});

test('cancelled discovery retains operation and shutdown ownership until every admitted ignored-abort worker settles', { timeout: 2000 }, async t => {
  const controller = new AbortController(), cancelled = reason();
  const held = Array.from({ length: 4 }, deferred), entered = deferred();
  const f = fixture(t, { ord: true }); let metadataCalls = 0;
  f.releases.push(() => { for (const gate of held) gate.resolve(); });
  f.first.fetchPath = async requestPath => {
    if (requestPath === '/inscriptions/0') return response({ ids: Array.from({ length: 24 }, (_, n) => inscriptionId(n)), more: false });
    const index = metadataCalls++;
    if (metadataCalls === 4) entered.resolve();
    await held[index].promise;
    return response({ id: requestPath.slice('/r/inscription/'.length), number: index });
  };
  const pending = f.manager.resolve(discoveryTarget(''), { signal: controller.signal });
  let operationSettled = false, shutdownSettled = false;
  const outcome = pending.then(value => { operationSettled = true; return value; }, error => { operationSettled = true; return error; });
  await entered.promise; controller.abort(cancelled); held[0].resolve(); await nextTurn();
  assert.equal(operationSettled, false); assert.equal(f.manager.activeOperations.size, 1);
  assert.equal(f.manager.pendingWork.size, 1); assert.equal(metadataCalls, 4);
  const shutdown = f.manager.shutdown().then(() => { shutdownSettled = true; });
  await nextTurn(); assert.equal(shutdownSettled, false);
  for (const gate of held.slice(1)) gate.resolve();
  assert.equal(await outcome, cancelled); await shutdown;
  assert.equal(operationSettled, true); assert.equal(shutdownSettled, true);
  assert.equal(f.manager.activeOperations.size, 0); assert.equal(f.manager.pendingWork.size, 0);
  assert.equal(metadataCalls, 4);
});

test('inscription-number cancellation must block later HTML and recursive metadata admission', async t => {
  const controller = new AbortController(), cancelled = reason(); const calls = [];
  const f = fixture(t, { ord: true });
  f.first.fetchPath = async (requestPath, options) => {
    calls.push({ requestPath, admittedAfterAbort: options.signal.aborted });
    if (calls.length === 1) { controller.abort(cancelled); return response('JSON disabled', 406, 'text/plain'); }
    if (requestPath === '/inscription/123') return response(`<main><h1>Inscription 123</h1><dl><dt>id</dt><dd>${inscriptionId(7)}</dd></dl></main>`, 200, 'text/html');
    return response({ id: inscriptionId(7), number: 123 });
  };
  f.fallback.resolve = () => assert.fail('cancelled number lookup must not fail over');
  await assert.rejects(f.manager.resolve(parseNavigationInput('inscription:123'), { signal: controller.signal }), error => error === cancelled);
  t.diagnostic(JSON.stringify({ nativeExecuted: false, requestCalls: calls.length,
    callsAfterAbort: calls.filter(call => call.admittedAfterAbort).length }));
  assert.equal(calls.length, 1);
});

test('Ord resolve entry rejects the exact pre-abort reason before any adapter request', async t => {
  const f = fixture(t, { ord: true }); const controller = new AbortController(), cancelled = reason();
  controller.abort(cancelled); let calls = 0;
  f.first.fetchPath = async () => { calls++; return response({ id: inscriptionId(7), number: 123 }); };
  for (const target of [parseNavigationInput('inscription:123'), discoveryTarget('')]) {
    await assert.rejects(f.first.resolve(target, { signal: controller.signal }), error => error === cancelled);
  }
  assert.equal(calls, 0);
});

test('Ord number lookup preserves exact cancellation at each late success/error transport boundary', async t => {
  for (const boundary of ['listing', 'html', 'metadata']) for (const outcome of ['success', 'error']) {
    await t.test(`${boundary}-${outcome}`, async t => {
      const f = fixture(t, { ord: true }); const controller = new AbortController(), cancelled = reason();
      const transportError = new AppError('PROVIDER_NETWORK_ERROR', 'Controlled late transport error', { status: 503 });
      const selected = ['listing', 'html', 'metadata'].indexOf(boundary);
      const calls = [];
      f.first.fetchPath = async (requestPath, options) => {
        const index = calls.length; calls.push({ requestPath, aborted: options.signal.aborted });
        if (index === selected) {
          controller.abort(cancelled);
          if (outcome === 'error') throw transportError;
        }
        if (index === 0) return response('JSON disabled', 406, 'text/plain');
        if (index === 1) return response(`<main><h1>Inscription 123</h1><dl><dt>id</dt><dd>${inscriptionId(7)}</dd></dl></main>`, 200, 'text/html');
        return response({ id: inscriptionId(7), number: 123 });
      };
      // Direct adapter invocation proves the adapter's own boundary, rather
      // than relying on ProviderManager's later cancellation recheck.
      await assert.rejects(f.first.resolve(parseNavigationInput('inscription:123'), { signal: controller.signal }), error => error === cancelled);
      assert.equal(calls.length, selected + 1);
      assert.equal(calls.some(call => call.aborted), false);
    });
  }
});

test('ordinary Ord transport errors retain their original identity when no cancellation occurred', async t => {
  const f = fixture(t, { ord: true }); const controller = new AbortController();
  const transportError = new AppError('PROVIDER_NETWORK_ERROR', 'Controlled current transport error', { status: 503 });
  let calls = 0; f.first.fetchPath = async () => { calls++; throw transportError; };
  await assert.rejects(f.first.resolve(parseNavigationInput('inscription:123'), { signal: controller.signal }), error => error === transportError);
  assert.equal(calls, 1); assert.equal(controller.signal.aborted, false);
});

async function diskFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-navigation-cache-cancel-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 * 1024 });
  await cache.init();
  t.after(async () => { try { await cache.flush(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { cache, directory };
}

test('actual cache rolls back exact-request abort during object or index publication', async t => {
  for (const boundary of ['object', 'index']) await t.test(boundary, async t => {
    const { cache } = await diskFixture(t);
    const controller = new AbortController(), cancelled = reason();
    const target = parseNavigationInput('block:840000'), key = `v1|entity|mainnet|${target.canonical}`;
    const previous = Buffer.from(JSON.stringify({ type: 'block', version: 'previous' }));
    await cache.put(key, previous);
    const object = path.join(cache.dataDirectory, crypto.createHash('sha256').update(key).digest('hex'));
    const destination = boundary === 'object' ? object : cache.indexFile;
    const originalRename = fs.rename.bind(fs); let injected = false;
    t.mock.method(fs, 'rename', async (from, to) => {
      await originalRename(from, to);
      if (!injected && to === destination) { injected = true; controller.abort(cancelled); }
    });
    const f = fixture(t, { cache });
    f.first.resolve = async () => ({ type: 'block', version: 'replacement' });
    f.fallback.resolve = () => assert.fail('cancelled cache write must not fail over');
    await assert.rejects(f.manager.resolve(target, { signal: controller.signal }), error => error === cancelled);
    assert.equal(injected, true); assert.equal(f.manager.healthState.has('first'), false);
    assert.deepEqual((await cache.get(key)).data, previous);
    const reopened = new DiskCache(cache.directory); await reopened.init();
    assert.deepEqual((await reopened.get(key)).data, previous); await reopened.flush();
  });
});

test('cancellation after cache commit suppresses resolution but does not undo already validated cache data', async t => {
  const { cache } = await diskFixture(t);
  const controller = new AbortController(), cancelled = reason();
  const target = parseNavigationInput('block:840000'), key = `v1|entity|mainnet|${target.canonical}`;
  await cache.put(key, Buffer.from(JSON.stringify({ type: 'block', version: 'previous' })));
  const originalRm = fs.rm.bind(fs); let injected = false;
  t.mock.method(fs, 'rm', async (file, options) => {
    if (!injected && path.dirname(file) === cache.dataDirectory && file.endsWith('.previous')) {
      injected = true; controller.abort(cancelled);
    }
    return originalRm(file, options);
  });
  const f = fixture(t, { cache });
  f.first.resolve = async () => ({ type: 'block', version: 'committed-before-abort' });
  f.fallback.resolve = () => assert.fail('cancelled completed cache write must not fail over');
  await assert.rejects(f.manager.resolve(target, { signal: controller.signal }), error => error === cancelled);
  assert.equal(injected, true); assert.equal(f.manager.healthState.has('first'), false);
  assert.equal(JSON.parse((await cache.get(key)).data).version, 'committed-before-abort');
});
