import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/renderer/state.js';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const viewsSource = fs.readFileSync(new URL('../src/renderer/views.js', import.meta.url), 'utf8');

function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source boundaries: ${start}`);
  return source.slice(from, to);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture(kind = 'history') {
  const historyRequest = deferred();
  const cacheRequest = deferred();
  const initialHistory = [{ canonical: 'sat:1', title: 'Sat 1' }];
  const initialCache = { entries: 4, bytes: 4096 };
  const initialTarget = kind === 'home' ? { kind: 'home', canonical: 'satnav://home' }
    : ['history', 'settings'].includes(kind) ? { kind: 'internal', value: kind, canonical: `satnav://${kind}` }
    : { kind, canonical: `${kind}:fixture` };
  const model = new Store({
    bootstrap: {}, settings: { network: 'mainnet' }, providers: [], wallet: null,
    cache: initialCache, history: initialHistory, bookmarks: [], services: [],
    tabs: [{ id: 'tab', target: `satnav://${kind}` }], activeTabId: 'tab',
    results: { tab: { target: initialTarget } },
    loading: {}
  });
  const homeHistory = { replaceWith(next) { page.homeHistory = next; } };
  const cacheNodes = [
    { dataset: { cacheValue: 'bytes' }, textContent: '4.0 KB' },
    { dataset: { cacheValue: 'entries' }, textContent: '4 cached resources' },
    { dataset: { cacheValue: 'used' }, textContent: '4.0 KB currently used.' }
  ];
  const page = {
    identity: { kind }, content: kind === 'history' || kind === 'collection' ? [...initialHistory] : null,
    homeHistory,
    querySelector(selector) { return selector === '[data-home-library="history"]' && scope.routeName() === 'home' ? this.homeHistory : null; },
    querySelectorAll(selector) { return selector === '[data-cache-value]' ? cacheNodes : []; }
  };
  const mainStage = { scrollTop: 137 };
  const omnibox = {
    value: 'typed value', selectionStart: 2, selectionEnd: 7,
    focus() { document.activeElement = this; }
  };
  const settingsInput = {
    value: '7500', selectionStart: 1, selectionEnd: 3,
    focus() { document.activeElement = this; }
  };
  const homeSearch = {
    value: 'rare sat', selectionStart: 1, selectionEnd: 5,
    focus() { document.activeElement = this; }
  };
  const document = { activeElement: null };
  const effects = { pageRenders: 0, chromeRenders: 0, drawerRenders: 0, historyRefreshes: 0, toasts: [] };
  const scope = {
    MODEL: model,
    state: () => model.get(),
    context: {},
    document,
    elements: { page, 'main-stage': mainStage, omnibox, 'cache-status': { textContent: 'Cache 4.0 KB' } },
    api: {
      history: { clear: () => historyRequest.promise },
      cache: { clear: () => cacheRequest.promise, stats: () => cacheRequest.promise }
    },
    renderPage() {
      effects.pageRenders += 1;
      const route = scope.routeName();
      scope.elements.page.identity = { kind: route, render: effects.pageRenders };
      if (route === 'history' || route === 'collection') page.content = [...model.get().history];
      mainStage.scrollTop = 0;
      if (document.activeElement === homeSearch || document.activeElement === settingsInput) document.activeElement = null;
    },
    renderChrome() { effects.chromeRenders += 1; },
    renderDrawer() { effects.drawerRenders += 1; },
    toast: (...args) => effects.toasts.push(args),
    routeName() {
      const target = model.get().results[model.get().activeTabId]?.target;
      return target?.kind === 'internal' ? target.value : target?.kind;
    },
    renderHomeLibrarySection(library) {
      effects.historyRefreshes += 1;
      return { library, items: [...model.get().history] };
    },
    formatBytes(value) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; },
    formatNumber: String
  };
  vm.runInNewContext([
    viewsSource.slice(viewsSource.indexOf('function cacheDisplayValue('), viewsSource.indexOf('\nfunction routeList(')).replaceAll('export function ', 'function '),
    extract('function activeTab(', '\nfunction id('),
    extract('function patch(', '\nfunction normalizeError('),
    extract('function libraryPageNeedsRefresh(', '\nfunction renderChrome('),
    extract('function formatCache(', '\nconst MAX_CLIPBOARD_TEXT_LENGTH'),
    extract('async function clearHistory(', '\nasync function refreshProviders('),
    'Object.assign(globalThis, { clearHistory, clearCache, refreshCacheStats });'
  ].join('\n'), scope);

  function navigate(nextKind) {
    const target = nextKind === 'home' ? { kind: 'home', canonical: 'satnav://home' }
      : ['settings', 'history', 'bookmarks'].includes(nextKind) ? { kind: 'internal', value: nextKind, canonical: `satnav://${nextKind}` }
      : { kind: nextKind, canonical: `${nextKind}:fixture` };
    model.patch({ results: { tab: { target } }, tabs: [{ id: 'tab', target: target.canonical }] });
    page.identity = { kind: nextKind };
  }
  return { scope, model, page, cacheNodes, mainStage, document, settingsInput, homeSearch, historyRequest, cacheRequest, effects, navigate };
}

for (const destination of ['settings', 'entity', 'inscription']) {
  test(`delayed Clear history does not repaint unrelated ${destination}`, async () => {
    const f = fixture('history');
    const pending = f.scope.clearHistory();
    f.navigate(destination);
    f.mainStage.scrollTop = 211;
    const identity = f.page.identity;
    const tabs = f.model.get().tabs;
    f.historyRequest.resolve([]);
    await pending;
    assert.equal(f.page.identity, identity);
    assert.equal(f.mainStage.scrollTop, 211);
    assert.deepEqual(f.model.get().history, []);
    assert.equal(f.model.get().tabs, tabs);
    assert.equal(f.effects.historyRefreshes, 0);
    assert.equal(f.effects.pageRenders, 0);
    assert.equal(f.effects.chromeRenders, 0);
    assert.equal(f.effects.drawerRenders, 0);
    assert.equal(f.effects.toasts[0][0], 'History cleared');
  });
}

test('delayed Clear history preserves Home search value, selection, focus, and unrelated Bookmarks section', async () => {
  const f = fixture('history');
  const pending = f.scope.clearHistory();
  f.navigate('home');
  f.page.bookmarks = { identity: 'bookmarks-section' };
  const bookmarks = f.page.bookmarks;
  f.document.activeElement = f.homeSearch;
  f.historyRequest.resolve([]);
  await pending;
  assert.equal(f.homeSearch.value, 'rare sat');
  assert.equal(f.homeSearch.selectionStart, 1);
  assert.equal(f.homeSearch.selectionEnd, 5);
  assert.equal(f.document.activeElement, f.homeSearch);
  assert.equal(f.page.bookmarks, bookmarks);
  assert.equal(f.effects.historyRefreshes, 1);
  assert.equal(f.effects.pageRenders, 0);
  assert.equal(f.effects.chromeRenders, 0);
  assert.equal(f.effects.drawerRenders, 0);
  assert.equal(f.effects.toasts[0][0], 'History cleared');
});

for (const destination of ['history', 'collection']) {
  test(`Clear history refreshes current ${destination} contents without losing scroll`, async () => {
    const f = fixture(destination);
    const identity = f.page.identity;
    const pending = f.scope.clearHistory();
    f.historyRequest.resolve([]);
    await pending;
    assert.notEqual(f.page.identity, identity);
    assert.deepEqual(f.page.content, []);
    assert.equal(f.mainStage.scrollTop, 137);
    assert.equal(f.effects.pageRenders, 1);
    assert.equal(f.effects.chromeRenders, 0);
    assert.equal(f.effects.drawerRenders, 0);
    assert.equal(f.effects.toasts[0][0], 'History cleared');
  });
}

test('delayed Clear cache updates model and cache chrome text without repainting an unrelated page', async () => {
  const f = fixture('settings');
  const pending = f.scope.clearCache();
  f.navigate('inscription');
  f.mainStage.scrollTop = 319;
  const identity = f.page.identity;
  f.cacheRequest.resolve({ entries: 0, bytes: 0 });
  await pending;
  assert.equal(f.page.identity, identity);
  assert.equal(f.mainStage.scrollTop, 319);
  assert.deepEqual(f.model.get().cache, { entries: 0, bytes: 0 });
  assert.equal(f.effects.chromeRenders, 0);
  assert.equal(f.effects.drawerRenders, 0);
  assert.equal(f.scope.elements['cache-status'].textContent, 'Cache 0 B');
  assert.equal(f.effects.pageRenders, 0);
});

test('Clear cache refreshes Settings cache statistics without replacing typed input', async () => {
  const f = fixture('settings');
  const identity = f.page.identity;
  f.document.activeElement = f.settingsInput;
  const pending = f.scope.clearCache();
  f.cacheRequest.resolve({ entries: 0, bytes: 0 });
  await pending;
  assert.equal(f.page.identity, identity);
  assert.deepEqual(f.cacheNodes.map((node) => node.textContent), ['0 B', '0 cached resources', '0 B currently used.']);
  assert.equal(f.settingsInput.value, '7500');
  assert.equal(f.settingsInput.selectionStart, 1);
  assert.equal(f.settingsInput.selectionEnd, 3);
  assert.equal(f.document.activeElement, f.settingsInput);
  assert.equal(f.effects.pageRenders, 0);
});

test('delayed cache stats reuse the same in-place publication contract', async () => {
  const f = fixture('settings');
  f.document.activeElement = f.settingsInput;
  const pending = f.scope.refreshCacheStats();
  f.cacheRequest.resolve({ entries: 2, bytes: 2048 });
  assert.deepEqual(await pending, { entries: 2, bytes: 2048 });
  assert.deepEqual(f.cacheNodes.map((node) => node.textContent), ['2.0 KB', '2 cached resources', '2.0 KB currently used.']);
  assert.equal(f.document.activeElement, f.settingsInput);
  assert.equal(f.effects.pageRenders, 0);
});

test('rejected cache stats do not publish cache state or repaint', async () => {
  const f = fixture('settings');
  const before = f.model.get().cache;
  const pending = f.scope.refreshCacheStats();
  f.cacheRequest.reject(new Error('stats denied'));
  await assert.rejects(pending, /stats denied/);
  assert.equal(f.model.get().cache, before);
  assert.equal(f.effects.pageRenders, 0);
  assert.equal(f.effects.chromeRenders, 0);
  assert.equal(f.effects.drawerRenders, 0);
  assert.deepEqual(f.cacheNodes.map((node) => node.textContent), ['4.0 KB', '4 cached resources', '4.0 KB currently used.']);
});

for (const action of ['history', 'cache']) {
  test(`rejected Clear ${action} does not publish or repaint`, async () => {
    const f = fixture(action === 'history' ? 'history' : 'settings');
    const before = f.model.get()[action];
    const pending = f.scope[action === 'history' ? 'clearHistory' : 'clearCache']();
    f[`${action}Request`].reject(new Error('denied'));
    await pending;
    assert.equal(f.model.get()[action], before);
    assert.equal(f.effects.pageRenders, 0);
    assert.equal(f.effects.chromeRenders, 0);
    assert.equal(f.effects.drawerRenders, 0);
    assert.equal(f.effects.historyRefreshes, 0);
    assert.match(f.effects.toasts[0][0], /^Could not clear/);
  });
}

test('committed Clear recovery publishes verified metrics without replacing Settings input or reporting success', async () => {
  const f = fixture('settings');
  const identity = f.page.identity;
  f.document.activeElement = f.settingsInput;
  const pending = f.scope.clearCache();
  f.cacheRequest.reject(Object.assign(new Error('Cache storage could not be reinitialized'), {
    details: { cacheClearCommitted: true, cacheReady: false, cache: { entries: 0, bytes: 0 } }
  }));
  await pending;
  assert.deepEqual(f.model.get().cache, { entries: 0, bytes: 0 });
  assert.deepEqual(f.cacheNodes.map(node => node.textContent), ['0 B', '0 cached resources', '0 B currently used.']);
  assert.equal(f.page.identity, identity);
  assert.equal(f.settingsInput.value, '7500');
  assert.equal(f.settingsInput.selectionStart, 1);
  assert.equal(f.settingsInput.selectionEnd, 3);
  assert.equal(f.document.activeElement, f.settingsInput);
  assert.equal(f.mainStage.scrollTop, 137);
  assert.deepEqual([f.effects.pageRenders, f.effects.chromeRenders, f.effects.drawerRenders], [0, 0, 0]);
  assert.equal(f.effects.toasts.length, 1);
  assert.equal(f.effects.toasts[0][0], 'Cache removed; recovery incomplete');
  assert.match(f.effects.toasts[0][1], /retry initialization/);
  assert.equal(f.effects.toasts[0][2], 'error');
});

test('committed Clear with absent or malformed snapshots never fabricates zero statistics or retries automatically', async () => {
  for (const cache of [null, undefined, [], {}, { entries: -1, bytes: 0 }, { entries: 0, bytes: NaN }, { entries: 0.5, bytes: 0 }, { entries: 0, bytes: '0' }]) {
    const f = fixture('settings');
    const before = f.model.get().cache;
    let clearCalls = 0;
    let statsCalls = 0;
    f.scope.api.cache.clear = () => { clearCalls++; return f.cacheRequest.promise; };
    f.scope.api.cache.stats = () => { statsCalls++; throw new Error('No automatic stats retry expected'); };
    const pending = f.scope.clearCache();
    f.cacheRequest.reject(Object.assign(new Error('Statistics unavailable'), {
      details: { cacheClearCommitted: true, cacheReady: true, cache }
    }));
    await pending;
    assert.equal(f.model.get().cache, before);
    assert.deepEqual(f.cacheNodes.map(node => node.textContent), ['4.0 KB', '4 cached resources', '4.0 KB currently used.']);
    assert.deepEqual([clearCalls, statsCalls], [1, 0]);
    assert.match(f.effects.toasts[0][1], /Displayed statistics have not been refreshed/);
    assert.equal(f.effects.toasts[0][2], 'error');
    assert.equal(f.effects.pageRenders, 0);
  }
});

test('unknown Clear completion does not publish a supplied snapshot and warns about possible partial removal', async () => {
  const f = fixture('settings');
  const before = f.model.get().cache;
  const pending = f.scope.clearCache();
  f.cacheRequest.reject(Object.assign(new Error('Removal denied'), {
    details: { cacheClearCommitted: null, cacheReady: null, cache: { entries: 0, bytes: 0 } }
  }));
  await pending;
  assert.equal(f.model.get().cache, before);
  assert.equal(f.effects.toasts[0][0], 'Could not clear cache');
  assert.match(f.effects.toasts[0][1], /Some cached files may already have been removed/);
  assert.equal(f.effects.toasts[0][2], 'error');
  assert.deepEqual([f.effects.pageRenders, f.effects.chromeRenders, f.effects.drawerRenders], [0, 0, 0]);
});
