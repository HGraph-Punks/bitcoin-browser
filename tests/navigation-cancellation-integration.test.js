import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/renderer/state.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { discoverOrdInscriptions } from '../src/main/providers/ord-discovery.js';
import { parseNavigationInput } from '../src/shared/navigation.js';
import { HOL_WEBSITE, SPONSORSHIP_INQUIRY_URL } from '../src/renderer/sponsors.js';

// Real renderer handlers, manager resolution/lifetime checks and Ord discovery.
// The facade, routing, cache and transport are controlled in-memory collaborators:
// these cases do NOT qualify the real preload/IPC registration handshake, native
// sockets, browser focus, or actual disk persistence. No native/network launch.
const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start); return source.slice(first, last);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const aborted = () => Object.assign(new Error('Controlled exact-request cancellation'), { code: 'ABORT_ERR' });
const galleryIds = Array.from({ length: 24 }, (_, index) => `${index.toString(16).padStart(64, '0')}i0`);
const response = body => ({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from(JSON.stringify(body)) });

function fixture(t, options = {}) {
  const h = { entries: [], works: [], calls: [], cancellations: [], cacheWrites: [], toasts: [], records: [],
    navigations: [], heldGates: [], pendingEntityRequests: new Map(), cancelGate: deferred(), admission: deferred(), closed: false };
  const home = () => ({ target: parseNavigationInput('satnav://home'), entity: null });
  const tab = id => ({ id, title: id, target: 'satnav://home', history: ['satnav://home'], historyIndex: 0 });
  const model = new Store({ tabs: options.onlyTab ? [tab('a')] : [tab('a'), tab('b')], activeTabId: 'a',
    results: options.onlyTab ? { a: home() } : { a: home(), b: home() }, requestSequence: {}, loading: {}, graphs: {} });
  const settings = { network: 'mainnet', offlineMode: false, localOnly: false, requestTimeoutMs: 1000, maxResourceBytes: 1048576 };
  const manager = new ProviderManager({ get: keys => keys[0] === 'settings' ? settings : [] }, {}, null, {
    async put(key, bytes, metadata, ttl, controls) { controls.validate(); h.cacheWrites.push({ key, bytes: bytes.length, closed: h.closed }); }
  });
  const provider = { id: 'controlled', async resolve(target, controls) {
    const work = { target, signal: controls.signal, gate: deferred(), calls: [] }; h.works.push(work);
    if (target.kind === 'inscriptions') {
      const data = await discoverOrdInscriptions({ async fetchPath(path, fetchOptions) {
        const call = { path, signal: fetchOptions.signal, closed: h.closed }; work.calls.push(call); h.calls.push(call);
        if (path.startsWith('/inscriptions/')) { await work.gate.promise; return response({ ids: galleryIds, more: false }); }
        return response({ id: path.slice('/r/inscription/'.length), number: 1, content_type: 'text/plain', content_length: 1 });
      } }, target, controls);
      return { kind: 'inscriptions', data };
    }
    await work.gate.promise;
    return { kind: target.kind, canonical: target.canonical, summary: {} };
  } };
  manager.candidates = () => [provider]; // Synthetic routing; no configured source or credential access.
  const active = new Map();
  const api = {
    app: { openExternal: async input => h.openExternal?.(input) },
    navigation: {
      parse: async input => h.parse ? h.parse(input) : parseNavigationInput(input),
      resolve(input, resolveOptions, requestId) {
        if (options.syncResolveFailure) throw new Error('Controlled synchronous resolution failure');
        const entry = { input, options: resolveOptions, requestId, controller: new AbortController() };
        h.entries.push(entry); const key = requestId ?? Symbol('legacy'); active.set(key, entry);
        const pending = (async () => {
          if (options.holdAdmission) await h.admission.promise;
          if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
          const target = parseNavigationInput(input);
          return { target, ...await manager.resolve(target, { ...resolveOptions, signal: entry.controller.signal }) };
        })();
        return pending.finally(() => { if (active.get(key) === entry) active.delete(key); });
      },
      cancelResolve(requestId) {
        h.cancellations.push(requestId);
        assert.equal([...h.pendingEntityRequests.values()].some(entry => entry.requestId === requestId), false,
          'retire local ownership synchronously before calling the facade');
        if (options.cancelFailure === 'sync') throw new Error('Controlled cancellation failure');
        if (options.cancelFailure === 'async') return Promise.reject(new Error('Controlled failure ' + 'x'.repeat(10000)));
        const entry = active.get(requestId);
        if (entry) entry.controller.abort(aborted());
        return options.holdCancel ? h.cancelGate.promise : Promise.resolve({ requested: Boolean(entry) });
      }
    }
  };
  let sequence = 0;
  const context = {
    forgetAiTab() {},
    navigationReady: true, navigationIntentSequence: 0, navigationIntents: new Map(),
    pendingEntityRequests: h.pendingEntityRequests,
    state: () => model.get(), activeTab: () => model.get().tabs.find(value => value.id === model.get().activeTabId),
    patch: update => model.patch(update), scheduleTabSave() {}, safeTab: value => value, id: () => `controlled-${++sequence}`,
    api, elements: { omnibox: { blur() {}, focus() {}, select() {} } }, closeSuggestions() {},
    refreshCacheStats: async () => {}, recordHistory: async result => { h.records.push(result); },
    toast: (...args) => h.toasts.push(args), normalizeError: error => error, Date, setTimeout
  };
  const helper = source.includes('function cancelTabResolution(')
    ? section('function cancelTabResolution(', '\nfunction patch(') : '';
  const actions = vm.runInNewContext(`(() => { ${helper}
    ${section('function closeTab(', '\nfunction titleFor(')}
    ${section('function titleFor(', '\nasync function recordHistory(')}
    return { navigate, closeTab, switchTab };
  })()`, context);
  h.model = model; h.manager = manager; h.api = api;
  h.hold = fallback => { const gate = deferred(); h.heldGates.push(() => gate.resolve(fallback)); return gate; };
  h.navigate = (...args) => { const operation = actions.navigate(...args); h.navigations.push(operation); return operation; };
  h.begin = async (input = 'satnav://inscriptions') => { const pending = h.navigate(input, { record: false }); await tick(); return { pending, work: h.works.at(-1), entry: h.entries.at(-1) }; };
  h.close = id => { actions.closeTab(id); h.closed = true; };
  h.switchTab = actions.switchTab;
  t.after(async () => {
    for (const release of h.heldGates) release();
    h.cancelGate.resolve({ requested: true }); h.admission.resolve();
    for (let round = 0; round < 3; round++) { for (const work of h.works) work.gate.resolve(); await tick(); }
    await Promise.allSettled(h.navigations); await manager.shutdown();
  });
  return h;
}

test('entity resolutions receive distinct bounded third-argument request IDs, not transport options', async t => {
  const f = fixture(t); await f.begin('sat:1'); f.switchTab('b'); await f.begin('sat:1');
  for (const entry of f.entries) { assert.match(entry.requestId, /^[A-Za-z0-9_-]{1,128}$/); assert.equal(entry.options, undefined); }
  assert.notEqual(f.entries[0].requestId, f.entries[1].requestId);
});

test('closing a held gallery aborts exactly its request before metadata fan-out or cache publication', async t => {
  const f = fixture(t); const { pending, work } = await f.begin();
  assert.equal(work.calls.length, 1); f.close('a');
  assert.equal(work.signal.aborted, true);
  work.gate.resolve(); await pending;
  assert.equal(work.calls.filter(call => call.path.startsWith('/r/inscription/')).length, 0);
  assert.equal(f.cacheWrites.length, 0);
  assert.equal(Object.hasOwn(f.model.get().results, 'a'), false);
  assert.equal(f.manager.activeOperations.size, 0);
});

test('committed internal navigation cancels old gallery work without waiting for its settlement', async t => {
  const f = fixture(t); const { pending, work } = await f.begin();
  await f.navigate('satnav://history', { record: false });
  assert.equal(f.model.get().results.a.target.canonical, 'satnav://history');
  assert.equal(work.signal.aborted, true); assert.equal(f.manager.activeOperations.size, 1);
  work.gate.resolve(); await pending;
  assert.equal(work.calls.length, 1); assert.equal(f.cacheWrites.length, 0);
  assert.equal(f.model.get().results.a.error, undefined);
});

test('invalid input leaves current request alive and able to publish', async t => {
  const f = fixture(t); const { pending, work } = await f.begin();
  f.parse = () => { throw new Error('Invalid controlled input'); };
  await f.navigate('invalid');
  assert.equal(work.signal.aborted, false); assert.deepEqual(f.cancellations, []);
  work.gate.resolve(); await pending;
  assert.equal(f.model.get().results.a.entity.data.items.length, 24);
  assert.equal(f.cacheWrites.length, 1);
});

test('pending parse does not cancel until its valid internal target is committed', async t => {
  const f = fixture(t); const old = await f.begin(); const parsed = f.hold(parseNavigationInput('satnav://home'));
  f.parse = () => parsed.promise;
  const next = f.navigate('satnav://history', { record: false }); await tick();
  assert.equal(old.work.signal.aborted, false); assert.deepEqual(f.cancellations, []);
  parsed.resolve(parseNavigationInput('satnav://history')); await next;
  assert.equal(old.work.signal.aborted, true);
});

test('external confirmation and rejection preserve the current page request', async t => {
  for (const rejected of [false, true]) {
    const f = fixture(t); const old = await f.begin(); const confirmation = f.hold(true);
    f.openExternal = () => confirmation.promise;
    const outside = f.navigate('https://example.invalid/'); await tick();
    assert.equal(old.work.signal.aborted, false); assert.deepEqual(f.cancellations, []);
    if (rejected) confirmation.reject(Object.assign(new Error('Declined'), { code: 'USER_REJECTED' }));
    else confirmation.resolve(true);
    await outside; old.work.gate.resolve(); await old.pending;
    assert.equal(f.model.get().results.a.target.canonical, 'satnav://inscriptions');
    assert.equal(f.cacheWrites.length, 1); assert.deepEqual(f.cancellations, []);
  }
});

test('Turtle Moon website approval, cancellation and errors preserve About without provider resolution', async t => {
  for (const outcome of ['approved', 'cancelled', 'failed']) {
    const f = fixture(t);
    await f.navigate('satnav://about', { record: false });
    const before = JSON.stringify(f.model.get());
    const requested = [];
    f.openExternal = async url => {
      requested.push(url);
      if (outcome === 'cancelled') throw Object.assign(new Error('Declined'), { code: 'USER_REJECTED' });
      if (outcome === 'failed') throw Object.assign(new Error('Unable to open browser'), { code: 'OPEN_FAILED' });
      return true;
    };
    await f.navigate('https://turtlemoon.io/');
    assert.deepEqual(requested, ['https://turtlemoon.io/']);
    assert.equal(JSON.stringify(f.model.get()), before, outcome);
    assert.equal(f.entries.length, 0);
    assert.equal(f.records.length, 0);
    assert.equal(f.toasts.length, outcome === 'failed' ? 1 : 0);
  }
});

test('sponsor website and inquiry approval, cancellation and errors preserve Sponsors without data resolution or history publication', async t => {
  for (const url of [HOL_WEBSITE, SPONSORSHIP_INQUIRY_URL]) for (const outcome of ['approved', 'cancelled', 'failed']) {
    const f = fixture(t);
    await f.navigate('satnav://sponsors', { record: false });
    const before = JSON.stringify(f.model.get()), requested = [];
    f.openExternal = async input => {
      requested.push(input);
      if (outcome === 'cancelled') throw Object.assign(new Error('Declined'), { code: 'USER_REJECTED' });
      if (outcome === 'failed') throw Object.assign(new Error('Unable to open browser'), { code: 'OPEN_FAILED' });
      return true;
    };
    await f.navigate(url);
    assert.deepEqual(requested, [url]);
    assert.equal(JSON.stringify(f.model.get()), before, outcome);
    assert.equal(f.entries.length, 0);
    assert.equal(f.records.length, 0);
    assert.equal(f.toasts.length, outcome === 'failed' ? 1 : 0);
  }
});

test('switching tabs keeps background work alive; closing one cannot cancel the other same-target request', async t => {
  const f = fixture(t); const a = await f.begin('sat:1'); f.switchTab('b'); const b = await f.begin('sat:1');
  assert.equal(a.work.signal.aborted, false); assert.equal(b.work.signal.aborted, false);
  const generation = f.manager.routingGeneration;
  f.close('a');
  assert.equal(a.work.signal.aborted, true); assert.equal(b.work.signal.aborted, false);
  assert.equal(f.manager.routingGeneration, generation);
  b.work.gate.resolve(); await b.pending;
  assert.equal(f.model.get().results.b.target.canonical, 'sat:1');
  assert.ok(f.model.get().results.b.entity); assert.equal(f.cacheWrites.length, 1);
});

test('late old settlement cannot retire a replacement handle or make its later close uncancellable', async t => {
  const f = fixture(t); const old = await f.begin('sat:1'); const next = await f.begin('sat:1');
  assert.equal(old.work.signal.aborted, true); assert.equal(next.work.signal.aborted, false);
  old.work.gate.resolve(); await old.pending;
  assert.equal(f.pendingEntityRequests.get('a')?.requestId, next.entry.requestId);
  f.close('a'); assert.equal(next.work.signal.aborted, true);
  assert.deepEqual(f.cancellations, [old.entry.requestId, next.entry.requestId]);
});

test('close during a pending replacement parse cancels now and rejects later resurrection', async t => {
  const f = fixture(t); const old = await f.begin(); const parsed = f.hold(parseNavigationInput('satnav://home')); f.parse = () => parsed.promise;
  const next = f.navigate('sat:2'); f.close('a');
  assert.equal(old.work.signal.aborted, true);
  parsed.resolve(parseNavigationInput('sat:2')); await next;
  assert.equal(f.entries.length, 1); assert.equal(Object.hasOwn(f.model.get().results, 'a'), false);
});

for (const cancelFailure of ['sync', 'async']) {
  test(`${cancelFailure} cancellation failure is bounded feedback, not navigation failure or stale publication`, async t => {
    const f = fixture(t, { cancelFailure }); const old = await f.begin();
    await f.navigate('satnav://history', { record: false }); await tick();
    assert.equal(f.model.get().results.a.target.canonical, 'satnav://history');
    const notices = f.toasts.filter(args => args[0] === 'Request cancellation unconfirmed');
    assert.equal(notices.length, 1); assert.ok(notices[0].join(' ').length < 512);
    assert.match(notices[0][1], /may still be running/i);
    old.work.gate.resolve(); await old.pending;
    assert.equal(f.model.get().results.a.target.canonical, 'satnav://history');
    assert.equal(f.model.get().results.a.error, undefined); assert.equal(f.pendingEntityRequests.size, 0);
  });
}

test('delayed cancellation acknowledgement cannot block close or committed navigation', async t => {
  const f = fixture(t, { holdCancel: true }); const old = await f.begin();
  let complete = false;
  const next = f.navigate('satnav://history', { record: false }).then(() => { complete = true; });
  await tick(); assert.equal(complete, true); assert.equal(old.work.signal.aborted, true);
  await next; assert.equal(f.pendingEntityRequests.size, 0);
});

test('close before controlled facade admission cannot start manager or discovery work later', async t => {
  const f = fixture(t, { holdAdmission: true }); const old = await f.begin();
  assert.equal(f.works.length, 0); f.close('a');
  assert.equal(old.entry.controller.signal.aborted, true);
  f.admission.resolve(); await old.pending;
  assert.equal(f.works.length, 0); assert.equal(f.cacheWrites.length, 0);
});

test('settled requests retire their handles and are not cancelled by later navigation', async t => {
  const f = fixture(t); const old = await f.begin('sat:1'); old.work.gate.resolve(); await old.pending;
  assert.equal(f.pendingEntityRequests.size, 0);
  await f.navigate('satnav://history', { record: false }); assert.deepEqual(f.cancellations, []);
});

test('synchronous resolve failure retires the handle and keeps the normal current-page error', async t => {
  const f = fixture(t, { syncResolveFailure: true });
  await f.navigate('sat:1');
  assert.match(f.model.get().results.a.error.message, /synchronous resolution failure/);
  assert.equal(f.pendingEntityRequests.size, 0); f.close('a'); assert.deepEqual(f.cancellations, []);
});

test('closing the final tab cancels its request without contaminating the replacement Home tab', async t => {
  const f = fixture(t, { onlyTab: true }); const old = await f.begin(); f.close('a');
  assert.equal(old.work.signal.aborted, true);
  assert.equal(f.model.get().tabs.length, 1); assert.notEqual(f.model.get().activeTabId, 'a');
  assert.equal(f.model.get().results[f.model.get().activeTabId].target.canonical, 'satnav://home');
  old.work.gate.resolve(); await old.pending;
  assert.equal(Object.hasOwn(f.model.get().results, 'a'), false); assert.equal(f.cacheWrites.length, 0);
});
