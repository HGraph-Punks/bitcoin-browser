import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/renderer/state.js';
import { sourceStatus } from '../src/renderer/source-status.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

const appSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const viewsSource = fs.readFileSync(new URL('../src/renderer/views.js', import.meta.url), 'utf8');
const searchSource = fs.readFileSync(new URL('../src/renderer/search.js', import.meta.url), 'utf8');
const home = { kind: 'home', canonical: 'satnav://home', display: 'Home' };
const target = { kind: 'sat', canonical: 'sat:4100', display: 'Sat 4100', value: '4100' };
const internal = (value) => ({ kind: 'internal', canonical: `satnav://${value}`, value, display: value });
const collection = { kind: 'collection', canonical: 'collection:4100', value: '4100' };

function extract(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source boundaries: ${start}`);
  return source.slice(from, to);
}

function fixture() {
  const model = new Store({
    bootstrap: {}, settings: { network: 'mainnet', privacyMode: 'balanced' },
    providers: [], cache: {}, history: [], bookmarks: [],
    tabs: [{ id: 'a' }, { id: 'b' }], activeTabId: 'a',
    results: { a: { target }, b: { target: home } }
  });
  const requests = { record: [], toggle: [], clear: [] };
  const enqueue = (kind, input) => new Promise((resolve, reject) => requests[kind].push({ input, resolve, reject }));
  const document = { activeElement: null };
  const find = (node, selector) => {
    if (!node || typeof node !== 'object') return null;
    const library = /^\[data-home-library="(history|bookmarks)"\]$/.exec(selector)?.[1];
    if (library ? node.dataset?.homeLibrary === library : node.tag === selector) return node;
    for (const child of node.children ?? []) { const match = find(child, selector); if (match) return match; }
    return null;
  };
  const page = { classList: { toggle() {} }, view: null, renders: 0, querySelector(selector) { return find(this.view, selector); } };
  const toasts = [];
  let chromeRenders = 0;
  const h = (tag, attributes = {}, ...children) => {
    const node = {
      tag, attributes, value: attributes.value, dataset: { ...attributes.dataset }, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined),
      setAttribute(name, value) { this.attributes[name] = String(value); },
      append(...nodes) {
        for (const child of nodes) { if (child && typeof child === 'object') child.parentNode = this; this.children.push(child); }
      },
      replaceChildren(...nodes) {
        for (const child of this.children) if (child && typeof child === 'object') child.parentNode = null;
        this.children = []; this.append(...nodes);
      },
      querySelector(selector) { return find(this, selector); },
      focus() { document.activeElement = this; },
      select() { this.selectionStart = 0; this.selectionEnd = String(this.value ?? '').length; },
      replaceWith(next) {
        const index = this.parentNode.children.indexOf(this);
        assert.ok(index >= 0);
        this.parentNode.children[index] = next;
        next.parentNode = this.parentNode;
        this.parentNode = null;
      }
    };
    for (const child of node.children) if (child && typeof child === 'object') child.parentNode = node;
    return node;
  };
  const scope = {
    MODEL: model, state: () => model.get(), document, parseNavigationInput, sourceStatus,
    api: { history: { record: (entry) => enqueue('record', entry), clear: () => enqueue('clear') }, bookmarks: { toggle: (entry) => enqueue('toggle', entry) } },
    elements: { page, 'main-stage': { scrollTop: 0, classList: { toggle() {} } } },
    renderChrome() { chromeRenders += 1; }, renderDrawer() {},
    clear(node, view) { node.view = view; node.renders += 1; },
    toast: (...args) => toasts.push(args),
    // Particle GPU lifecycle is qualified in the native harness. This bounded
    // library fixture supplies only its decorative DOM/platform boundary.
    createHomeIntro: () => Object.assign(h('div'), { dispose() {} }),
    h, button: (label, options) => h('button', options, label),
    badge: (text) => h('badge', {}, text),
    emptyState: (...text) => h('empty', {}, text),
    listRow: (attributes) => h('route-row', attributes),
    pageHeader: (...parts) => h('header', {}, parts),
    formatBytes: String, formatNumber: String, targetIcon: String, timeAgo: String
  };
  const context = {
    get model() { return model.get(); }, navigate() {}, clearHistory() {}
  };
  scope.context = context;
  // Real action/Store/patch/page routing and library views, with only DOM/platform
  // collaborators replaced by a bounded virtual tree. This is not native evidence.
  vm.runInNewContext([
    searchSource.replace(/^import .*;\n/gm, '').replaceAll('export function ', 'function ').replaceAll('export const ', 'const '),
    viewsSource.slice(viewsSource.indexOf('function section(')).replaceAll('export function ', 'function '),
    extract(appSource, 'function activeTab(', '\nfunction id('),
    extract(appSource, 'function patch(', '\nfunction normalizeError('),
    extract(appSource, 'function titleFor(', '\nfunction updateTabNavigation('),
    extract(appSource, 'async function recordHistory(', '\nfunction goHistory('),
    extract(appSource, 'function routeName(', '\nfunction renderChrome('),
    extract(appSource, 'function renderPage(', '\nfunction renderDrawer('),
    extract(appSource, 'async function toggleBookmark(', '\nasync function clearCache('),
    'Object.assign(globalThis, { recordHistory, toggleBookmark, clearHistory, renderPage });'
  ].join('\n'), scope);
  // Non-library views are opaque fixtures: replacement is observable, without
  // pretending this virtual tree implements iframe lifecycle or keyboard focus.
  for (const name of ['renderEntity', 'renderInscription', 'renderError', 'renderSettings']) {
    scope[name] = () => h('unrelated-view');
  }
  function show(next, tabId = model.get().activeTabId) {
    const current = model.get();
    model.patch({ activeTabId: tabId, results: { ...current.results, [tabId]: { target: next } } });
    scope.renderPage();
  }
  function canonicals() {
    const visit = (node) => !node || typeof node !== 'object' ? [] : [
      ...(node.tag === 'route-row' ? [node.attributes.subtitle] : []),
      ...(node.children ?? []).flatMap(visit)
    ];
    return visit(page.view);
  }
  show(target);
  return { model, requests, page, scope, show, canonicals, toasts, document, get chromeRenders() { return chromeRenders; } };
}

function entry(canonical = target.canonical) {
  return { id: `entry-${canonical}`, canonical, kind: 'sat', title: canonical, visitedAt: '2026-09-06T00:00:00.000Z' };
}

for (const [name, destination] of [['Home', home], ['History', internal('history')], ['Collection', collection]]) {
  test(`delayed history publication refreshes the currently displayed ${name} after a tab switch`, async () => {
    const f = fixture();
    const pending = f.scope.recordHistory({ target, entity: null });
    assert.equal(f.requests.record.length, 1, 'history dispatch is immediate');
    f.show(destination, 'b');
    assert.deepEqual(f.canonicals(), []);
    f.requests.record[0].resolve(entry());
    await pending;
    assert.deepEqual(f.canonicals(), [target.canonical]);
    assert.equal(f.model.get().results.a.target.canonical, target.canonical);
    assert.equal(f.model.get().activeTabId, 'b');
  });
}

for (const [name, destination] of [['Home', home], ['Bookmarks', internal('bookmarks')], ['Collection', collection]]) {
  test(`delayed bookmark add/remove refreshes current ${name} while retaining the requested canonical`, async () => {
    const f = fixture();
    const pending = f.scope.toggleBookmark();
    f.show(destination, 'b');
    assert.equal(f.requests.toggle[0].input.canonical, target.canonical);
    f.requests.toggle[0].resolve({ bookmarked: true, bookmarks: [entry()] });
    await pending;
    assert.deepEqual(f.canonicals(), [target.canonical]);
    f.show(target, 'a');
    const removing = f.scope.toggleBookmark();
    f.show(destination, 'b');
    f.requests.toggle[1].resolve({ bookmarked: false, bookmarks: [] });
    await removing;
    assert.deepEqual(f.canonicals(), []);
    assert.equal(f.toasts[1][0], 'Bookmark removed');
  });
}

test('library publication does not replace unrelated or inscription page state', async () => {
  for (const destination of [internal('settings'), target, { kind: 'inscription', canonical: 'inscription:fixture' }]) {
    const f = fixture();
    const history = f.scope.recordHistory({ target, entity: null });
    const bookmark = f.scope.toggleBookmark();
    f.show(destination, 'b');
    const visible = f.page.view;
    const renders = f.page.renders;
    f.requests.record[0].resolve(entry());
    f.requests.toggle[0].resolve({ bookmarked: true, bookmarks: [entry()] });
    await Promise.all([history, bookmark]);
    assert.equal(f.page.view, visible);
    assert.equal(f.page.renders, renders);
    assert.equal(f.chromeRenders, 2, 'normal chrome publication still occurs');
    assert.equal(f.model.get().bookmarks[0].canonical, target.canonical);
  }
});

test('a failed bookmark update preserves the view and authority; a later success refreshes it', async () => {
  const f = fixture();
  const failed = f.scope.toggleBookmark();
  f.show(home, 'b');
  const original = f.page.view;
  f.requests.toggle[0].reject(new Error('fixture persistence failure'));
  await failed;
  assert.equal(f.page.view, original);
  assert.deepEqual(f.model.get().bookmarks, []);
  assert.equal(f.toasts[0][0], 'Bookmark failed');
  f.show(target, 'a');
  const retry = f.scope.toggleBookmark();
  f.show(home, 'b');
  f.requests.toggle[1].resolve({ bookmarked: true, bookmarks: [entry()] });
  await retry;
  assert.deepEqual(f.canonicals(), [target.canonical]);
});

test('a failed history update does not publish an unacknowledged entry or replace the view', async () => {
  const f = fixture();
  const pending = f.scope.recordHistory({ target, entity: null });
  f.show(collection, 'b');
  const original = f.page.view;
  const rejected = assert.rejects(pending, /fixture write failure/);
  f.requests.record[0].reject(new Error('fixture write failure'));
  await rejected;
  assert.equal(f.page.view, original);
  assert.deepEqual(f.model.get().history, []);
});

test('Collection refresh uses both library sources and preserves exact-canonical deduplication', async () => {
  const f = fixture();
  f.model.patch({ bookmarks: [entry(), entry('sat:41000')] });
  const pending = f.scope.recordHistory({ target, entity: null });
  f.show(collection);
  f.requests.record[0].resolve(entry());
  await pending;
  assert.deepEqual(f.canonicals(), ['sat:4100', 'sat:41000']);
  const clear = f.scope.clearHistory();
  f.requests.clear[0].resolve([]);
  await clear;
  assert.deepEqual(f.canonicals(), ['sat:4100', 'sat:41000']);
  assert.deepEqual(f.model.get().history, []);
});

test('Home and internal history targets remain excluded before persistence dispatch', async () => {
  const f = fixture();
  await f.scope.recordHistory({ target: home });
  await f.scope.recordHistory({ target: internal('history') });
  f.show(home);
  await f.scope.toggleBookmark();
  assert.deepEqual(f.requests.record, []);
  assert.deepEqual(f.requests.toggle, []);
});

test('passive Home library updates preserve a typed focused search and scroll position', async () => {
  const f = fixture();
  const history = f.scope.recordHistory({ target, entity: null });
  const bookmark = f.scope.toggleBookmark();
  f.show(home, 'b');
  const search = f.page.querySelector('input');
  search.value = 'block:840000';
  Object.assign(search, { selectionStart: 6, selectionEnd: 12, selectionDirection: 'forward' });
  search.focus();
  const hero = search.parentNode.parentNode;
  const initialRecent = f.page.querySelector('[data-home-library="history"]');
  const initialBookmarks = f.page.querySelector('[data-home-library="bookmarks"]');
  f.scope.elements['main-stage'].scrollTop = 350;
  f.requests.record[0].resolve(entry());
  await history;
  assert.equal(f.page.querySelector('input'), search);
  assert.equal(search.value, 'block:840000');
  assert.equal(f.document.activeElement, search);
  assert.equal(search.parentNode.parentNode, hero);
  assert.deepEqual([search.selectionStart, search.selectionEnd, search.selectionDirection], [6, 12, 'forward']);
  assert.notEqual(f.page.querySelector('[data-home-library="history"]'), initialRecent);
  assert.equal(f.page.querySelector('[data-home-library="bookmarks"]'), initialBookmarks);
  assert.equal(f.scope.elements['main-stage'].scrollTop, 350);
  const publishedRecent = f.page.querySelector('[data-home-library="history"]');
  f.requests.toggle[0].resolve({ bookmarked: true, bookmarks: [entry()] });
  await bookmark;
  assert.equal(f.page.querySelector('input'), search);
  assert.equal(f.document.activeElement, search);
  assert.equal(f.page.querySelector('[data-home-library="history"]'), publishedRecent);
  assert.notEqual(f.page.querySelector('[data-home-library="bookmarks"]'), initialBookmarks);
  assert.equal(f.scope.elements['main-stage'].scrollTop, 350);
  assert.deepEqual(f.canonicals(), [target.canonical, target.canonical]);
});

test('passive dedicated-library updates preserve scroll instead of behaving like navigation', async () => {
  for (const destination of [internal('history'), collection]) {
    const f = fixture();
    const pending = f.scope.recordHistory({ target, entity: null });
    f.show(destination, 'b');
    f.scope.elements['main-stage'].scrollTop = 200;
    f.requests.record[0].resolve(entry());
    await pending;
    assert.equal(f.scope.elements['main-stage'].scrollTop, 200);
    assert.deepEqual(f.canonicals(), [target.canonical]);
  }
});

test('delayed Clear history updates the real Home Recent section without replacing its search or Bookmarks', async () => {
  const f = fixture();
  f.model.patch({ history: [entry()], bookmarks: [entry('sat:41000')] });
  f.show(internal('history'));
  const pending = f.scope.clearHistory();
  f.show(home, 'b');
  const page = f.page.view;
  const search = f.page.querySelector('input');
  const bookmarks = f.page.querySelector('[data-home-library="bookmarks"]');
  const recent = f.page.querySelector('[data-home-library="history"]');
  search.value = 'block:840000';
  Object.assign(search, { selectionStart: 6, selectionEnd: 12, selectionDirection: 'backward' });
  search.focus();
  f.scope.elements['main-stage'].scrollTop = 350;
  f.requests.clear[0].resolve([]);
  await pending;
  assert.equal(f.page.view, page);
  assert.equal(f.page.querySelector('input'), search);
  assert.equal(f.document.activeElement, search);
  assert.equal(search.value, 'block:840000');
  assert.deepEqual([search.selectionStart, search.selectionEnd, search.selectionDirection], [6, 12, 'backward']);
  assert.equal(f.page.querySelector('[data-home-library="bookmarks"]'), bookmarks);
  assert.notEqual(f.page.querySelector('[data-home-library="history"]'), recent);
  assert.deepEqual(f.canonicals(), ['sat:41000']);
  assert.equal(f.scope.elements['main-stage'].scrollTop, 350);
  assert.equal(f.chromeRenders, 0);
  assert.deepEqual(f.toasts, [['History cleared', '', 'success']]);
});

test('Clear history renders the real current History or Collection projection and preserves bookmarks and scroll', async () => {
  for (const destination of [internal('history'), collection]) {
    const f = fixture();
    const bookmarks = [entry('sat:41000')];
    f.model.patch({ history: [entry(), entry('sat:41000')], bookmarks });
    f.show(destination);
    const page = f.page.view;
    f.scope.elements['main-stage'].scrollTop = 200;
    const pending = f.scope.clearHistory();
    f.requests.clear[0].resolve([]);
    await pending;
    assert.notEqual(f.page.view, page);
    assert.deepEqual(f.canonicals(), destination === collection ? ['sat:41000'] : []);
    assert.equal(f.model.get().bookmarks, bookmarks);
    assert.deepEqual(f.model.get().history, []);
    assert.equal(f.scope.elements['main-stage'].scrollTop, 200);
    assert.equal(f.chromeRenders, 0);
    assert.deepEqual(f.toasts, [['History cleared', '', 'success']]);
  }
});
