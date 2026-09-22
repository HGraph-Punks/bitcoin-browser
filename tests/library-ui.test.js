import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseNavigationInput } from '../src/shared/navigation.js';
import { planLookup } from '../src/renderer/search.js';

const appSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');

function cancellationContext(context) {
  context.forgetAiTab = () => {};
  const begin = appSource.indexOf('function cancelTabResolution(');
  const end = appSource.indexOf('\nfunction patch(', begin);
  assert.ok(begin >= 0 && end > begin);
  context.pendingEntityRequests ??= new Map();
  context.cancelTabResolution = vm.runInNewContext(`(${appSource.slice(begin, end)})`, context);
  return context;
}

function navigationFixture() {
  const begin = appSource.indexOf('function titleFor(');
  const end = appSource.indexOf('\nasync function recordHistory(', begin);
  assert.ok(begin >= 0 && end > begin);
  const model = {
    tabs: [
      { id: 'a', title: 'A', target: 'satnav://home', history: ['satnav://home'], historyIndex: 0 },
      { id: 'b', title: 'B', target: 'satnav://home', history: ['satnav://home'], historyIndex: 0 }
    ],
    activeTabId: 'a', requestSequence: {}, results: {}, loading: {}, graphs: { a: { data: 'obsolete' }, b: { data: 'preserved' } }
  };
  const parses = [];
  const resolutions = [];
  const records = [];
  const toasts = [];
  const patchOptions = [];
  let nextRequestId = 0;
  let blurs = 0;
  const context = {
    state: () => model,
    activeTab: () => model.tabs.find((tab) => tab.id === model.activeTabId),
    navigationIntentSequence: 0,
    navigationReady: true,
    navigationIntents: new Map(),
    id: () => `library-request-${++nextRequestId}`,
    api: { navigation: {
      parse: () => new Promise((resolve, reject) => parses.push({ resolve, reject })),
      resolve: () => new Promise((resolve, reject) => resolutions.push({ resolve, reject })),
      // Intent acknowledgement deliberately leaves controlled completions held
      // so these original stale success/error publication assertions still run.
      cancelResolve: async () => ({ requested: true })
    } },
    patch(value, options) { Object.assign(model, typeof value === 'function' ? value(model) : value); patchOptions.push(options); },
    scheduleTabSave: () => Promise.resolve(), closeSuggestions() {},
    elements: { omnibox: { blur() { blurs += 1; }, focus() {}, select() {} } },
    setTimeout, toast: (...args) => toasts.push(args), newTab: assert.fail, refreshCacheStats: async () => {},
    recordHistory: async (result) => { records.push(result); }, normalizeError: (error) => error
  };
  const navigate = vm.runInNewContext(`(() => { ${appSource.slice(begin, end)}; return navigate; })()`, cancellationContext(context));
  return { model, parses, resolutions, records, navigate, toasts, patchOptions, context, get blurs() { return blurs; } };
}

const internalTarget = (value) => ({ kind: 'internal', value, canonical: `satnav://${value}`, display: value });
const providerTarget = (value) => ({ kind: 'sat', value, canonical: `sat:${value}`, display: `Sat ${value}` });

async function reachResolution(fixture, parseIndex, target) {
  fixture.parses[parseIndex].resolve(target);
  while (fixture.resolutions.length <= parseIndex) await Promise.resolve();
}

test('saved lookup uses real navigation without provider resolution or external-open dispatch', async () => {
  for (const query of ['orange art', '840000', 'https://example.test/', 'bitcoin:fixture']) {
    const fixture = navigationFixture();
    fixture.context.api.app = { openExternal: assert.fail };
    const plan = planLookup(query, 'saved');
    const pending = fixture.navigate(plan.target);
    fixture.parses[0].resolve(parseNavigationInput(plan.target));
    await pending;
    assert.equal(fixture.model.results.a.target.kind, 'search');
    assert.equal(fixture.model.results.a.target.value, query);
    assert.deepEqual(fixture.resolutions, []);
    assert.equal(fixture.records.length, 1, 'search navigation can be recorded locally');
    const refresh = fixture.navigate(plan.target, { record: false });
    fixture.parses[1].resolve(parseNavigationInput(plan.target));
    await refresh;
    assert.equal(fixture.records.length, 1, 'explicit refresh does not record another visit');
    assert.deepEqual(fixture.resolutions, []);
  }
});

test('guided exact lookup retains real navigation provider resolution for the chosen type', async () => {
  const fixture = navigationFixture();
  const plan = planLookup('840000', 'block');
  const pending = fixture.navigate(plan.target);
  const target = parseNavigationInput(plan.target);
  await reachResolution(fixture, 0, target);
  assert.equal(fixture.resolutions.length, 1);
  fixture.resolutions[0].resolve({ target, entity: { summary: { height: 840000 } }, attempts: [] });
  await pending;
  assert.equal(fixture.model.results.a.target.canonical, 'block:840000');
  assert.equal(fixture.records.length, 1);
});

test('navigation stays attached to its originating tab without rerendering or blurring the active tab', async () => {
  const fixture = navigationFixture();
  const { model, parses, navigate, patchOptions } = fixture;
  const pending = navigate('satnav://history', { record: false });
  model.activeTabId = 'b';
  parses[0].resolve(internalTarget('history'));
  await pending;
  assert.equal(model.tabs[0].target, 'satnav://history');
  assert.equal(model.tabs[1].target, 'satnav://home');
  assert.equal(Object.hasOwn(model.graphs, 'a'), false);
  assert.equal(model.graphs.b.data, 'preserved');
  assert.equal(patchOptions.some((options) => options?.page), false);
  assert.equal(fixture.blurs, 0);
});

test('an older parse result cannot replace a newer navigation intent', async () => {
  const { model, parses, navigate } = navigationFixture();
  const older = navigate('satnav://history', { record: false });
  const newer = navigate('satnav://bookmarks', { record: false });
  parses[1].resolve(internalTarget('bookmarks'));
  await newer;
  parses[0].resolve(internalTarget('history'));
  await older;
  assert.equal(model.tabs[0].target, 'satnav://bookmarks');
});

test('a stale parse failure does not show an error for the newer page', async () => {
  const { model, parses, navigate, toasts } = navigationFixture();
  const older = navigate('bad target', { record: false });
  const newer = navigate('satnav://bookmarks', { record: false });
  parses[1].resolve(internalTarget('bookmarks'));
  await newer;
  parses[0].reject(new Error('obsolete parse failure'));
  await older;
  assert.equal(model.tabs[0].target, 'satnav://bookmarks');
  assert.deepEqual(toasts, []);
});

test('late provider success cannot replace a newer same-tab result or record obsolete history', async () => {
  const fixture = navigationFixture();
  const older = fixture.navigate('sat:1');
  await reachResolution(fixture, 0, providerTarget(1));
  const newer = fixture.navigate('satnav://bookmarks', { record: false });
  fixture.parses[1].resolve(internalTarget('bookmarks'));
  await newer;
  fixture.resolutions[0].resolve({ target: providerTarget(1), entity: { summary: {} }, attempts: [] });
  await older;
  assert.equal(fixture.model.results.a.target.canonical, 'satnav://bookmarks');
  assert.deepEqual(fixture.records, []);
});

test('late provider rejection cannot replace a newer same-tab result', async () => {
  const fixture = navigationFixture();
  const older = fixture.navigate('sat:1');
  await reachResolution(fixture, 0, providerTarget(1));
  const newer = fixture.navigate('satnav://history', { record: false });
  fixture.parses[1].resolve(internalTarget('history'));
  await newer;
  fixture.resolutions[0].reject(new Error('obsolete provider failure'));
  await older;
  assert.equal(fixture.model.results.a.target.canonical, 'satnav://history');
  assert.equal(fixture.model.results.a.error, undefined);
});

test('late provider completion cannot resurrect a closed tab or record its history', async () => {
  const fixture = navigationFixture();
  const pending = fixture.navigate('sat:1');
  await reachResolution(fixture, 0, providerTarget(1));
  const begin = appSource.indexOf('function closeTab(');
  const end = appSource.indexOf('\nfunction switchTab(', begin);
  Object.assign(fixture.context, {
    scheduleTabSave: () => Promise.resolve(), safeTab: assert.fail, id: assert.fail,
    activeTab: () => fixture.model.tabs.find((tab) => tab.id === fixture.model.activeTabId), navigate: assert.fail
  });
  fixture.model.results.b = {};
  const closeTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, cancellationContext(fixture.context));
  closeTab('a');
  fixture.resolutions[0].resolve({ target: providerTarget(1), entity: { summary: {} }, attempts: [] });
  await pending;
  assert.equal(fixture.model.tabs.some((tab) => tab.id === 'a'), false);
  assert.equal(Object.hasOwn(fixture.model.results, 'a'), false);
  assert.deepEqual(fixture.records, []);
});

test('late provider rejection cannot resurrect a closed tab error', async () => {
  const fixture = navigationFixture();
  const pending = fixture.navigate('sat:1');
  await reachResolution(fixture, 0, providerTarget(1));
  const begin = appSource.indexOf('function closeTab(');
  const end = appSource.indexOf('\nfunction switchTab(', begin);
  Object.assign(fixture.context, {
    scheduleTabSave: () => Promise.resolve(), safeTab: assert.fail, id: assert.fail,
    activeTab: () => fixture.model.tabs.find((tab) => tab.id === fixture.model.activeTabId), navigate: assert.fail
  });
  fixture.model.results.b = {};
  const closeTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, cancellationContext(fixture.context));
  closeTab('a');
  fixture.resolutions[0].reject(new Error('obsolete provider failure'));
  await pending;
  assert.equal(Object.hasOwn(fixture.model.results, 'a'), false);
});

test('closing a tab removes its request sequence so late resolution is stale', () => {
  const begin = appSource.indexOf('function closeTab(');
  const end = appSource.indexOf('\nfunction switchTab(', begin);
  assert.ok(begin >= 0 && end > begin);
  const model = {
    tabs: [{ id: 'a' }, { id: 'b' }], activeTabId: 'a', requestSequence: { a: 7, b: 2 },
    results: { a: {}, b: {} }, loading: { a: true }, graphs: { a: {} }
  };
  const context = {
    state: () => model, navigationIntents: new Map([['a', 1]]),
    activeTab: () => model.tabs.find((tab) => tab.id === model.activeTabId), navigate: assert.fail,
    patch(value) { Object.assign(model, typeof value === 'function' ? value(model) : value); },
    scheduleTabSave: () => Promise.resolve(), safeTab: assert.fail, id: assert.fail
  };
  const closeTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, cancellationContext(context));
  closeTab('a');
  assert.equal(Object.hasOwn(model.requestSequence, 'a'), false);
  assert.equal(model.requestSequence.b, 2);
  assert.equal(context.navigationIntents.has('a'), false);
});

test('closing the final tab clears loading and graph state belonging to the removed tab', () => {
  const begin = appSource.indexOf('function closeTab(');
  const end = appSource.indexOf('\nfunction switchTab(', begin);
  const model = {
    tabs: [{ id: 'a' }], activeTabId: 'a', requestSequence: { a: 7 },
    results: { a: {} }, loading: { a: true }, graphs: { a: {} }
  };
  const context = {
    state: () => model, navigationIntents: new Map([['a', 1]]),
    activeTab: () => model.tabs.find((tab) => tab.id === model.activeTabId), navigate: assert.fail,
    patch(value) { Object.assign(model, typeof value === 'function' ? value(model) : value); },
    scheduleTabSave: () => Promise.resolve(),
    safeTab: () => ({ id: 'replacement', target: 'satnav://home' }), id: () => 'replacement'
  };
  const closeTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, cancellationContext(context));
  closeTab('a');
  assert.deepEqual(Object.keys(model.loading), []);
  assert.deepEqual(Object.keys(model.graphs), []);
  assert.deepEqual(Object.keys(model.requestSequence), []);
});

test('inscription-number title falls back safely before an entity is resolved', () => {
  const begin = appSource.indexOf('function titleFor(');
  const end = appSource.indexOf('\nfunction updateTabNavigation(', begin);
  const titleFor = vm.runInNewContext(`(${appSource.slice(begin, end)})`);
  const target = { kind: 'inscription-number', display: 'Inscription 123', canonical: 'inscription-number:123' };
  assert.equal(titleFor(target), 'Inscription 123');
  assert.equal(titleFor(target, { summary: { number: 123 } }), 'Inscription #123');
});

test('renderer history projection preserves non-adjacent visits and coalesces only rapid adjacent repeats', async () => {
  const begin = appSource.indexOf('async function recordHistory(');
  const end = appSource.indexOf('\nfunction goHistory(', begin);
  const now = Date.parse('2026-09-04T12:00:04.000Z');
  const model = { history: [
    { id: 'second', canonical: 'sat:2', visitedAt: '2026-09-04T12:00:02.000Z' },
    { id: 'first', canonical: 'sat:1', visitedAt: '2026-09-04T12:00:00.000Z' }
  ] };
  const responses = [
    { id: 'third', canonical: 'sat:1', title: 'Third', visitedAt: new Date(now).toISOString() },
    { id: 'fourth', canonical: 'sat:1', title: 'Fourth', visitedAt: new Date(now + 1000).toISOString() }
  ];
  const context = {
    api: { history: { record: async () => responses.shift() } },
    patch(value) { Object.assign(model, typeof value === 'function' ? value(model) : value); },
    titleFor: () => 'fixture', refreshLibraryPage() {}
  };
  const recordHistory = vm.runInNewContext(`(${appSource.slice(begin, end)})`, context);
  const result = { target: { kind: 'sat', canonical: 'sat:1' }, entity: null };
  await recordHistory(result);
  assert.deepEqual([...model.history.map((entry) => entry.id)], ['third', 'second', 'first']);
  await recordHistory(result);
  assert.deepEqual([...model.history.map((entry) => entry.id)], ['fourth', 'second', 'first']);
});
