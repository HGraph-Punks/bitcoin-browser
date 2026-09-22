import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/renderer/state.js';
import { renderInscriptions } from '../src/renderer/inscriptions.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

// Actual gallery action and extracted actual navigation/history/reload functions.
// In-memory state, bounded existing DOM collaborator, synthetic parse/resolve IPC.
// No native browser, service, network, credentials, or profile access.
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('src/renderer/app.js', root), 'utf8');
const domSource = fs.readFileSync(new URL('tests/inscriptions-ui.test.js', root), 'utf8');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
const document = { activeElement: null };
const domBegin = domSource.indexOf('class TestNode {');
const domEnd = domSource.indexOf('\nglobalThis.Node = TestNode;', domBegin);
assert.ok(domBegin >= 0 && domEnd > domBegin);
const TestNode = vm.runInNewContext(domSource.slice(domBegin, domEnd) + '\nTestNode', { document });
document.createElement = tag => new TestNode(tag);
document.createTextNode = text => new TestNode('#text', String(text));
globalThis.document = document;
globalThis.Node = TestNode;
test.after(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  if (originalNode) Object.defineProperty(globalThis, 'Node', originalNode);
  else delete globalThis.Node;
});
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const gallery = 'satnav://inscriptions';
const initialHistory = ['satnav://home', gallery, 'satnav://inscriptions?offset=24', 'inscription:1'];
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { atEnd = false, target = gallery } = {}) {
  const completeHistory = initialHistory.map(value => value === gallery ? target : value);
  const history = atEnd ? completeHistory.slice(0, 2) : completeHistory;
  const model = new Store({ tabs: [{ id: 'a', title: 'A', target: history.at(-1), history, historyIndex: history.length - 1 }],
    activeTabId: 'a', results: {}, loading: {}, requestSequence: {}, graphs: {}, settings: {}, bookmarks: [] });
  const h = { model, recover: false, resolves: [], saved: [], navigations: [], pending: [], toasts: [], records: [] };
  t.after(async () => { await Promise.allSettled(h.pending); });
  const activeTab = () => model.get().tabs[0];
  const api = { navigation: {
    parse: async input => parseNavigationInput(input),
    async resolve(input) {
      h.resolves.push(input);
      if (!h.recover) throw Object.assign(new Error('Controlled source unavailable'), { code: 'ALL_PROVIDERS_FAILED' });
      return { target: parseNavigationInput(input), entity: { data: { items: [] }, source: { name: 'Controlled source' } } };
    },
    cancelResolve: async () => ({ requested: true })
  } };
  let sequence = 0;
  const context = { observed: h, state: () => model.get(), activeTab, navigationReady: true, navigationIntentSequence: 0,
    navigationIntents: new Map(), pendingEntityRequests: new Map(), api,
    patch: update => model.patch(update), id: () => 'request-' + (++sequence),
    scheduleTabSave: () => h.saved.push(structuredClone(activeTab())),
    elements: { omnibox: { blur() {} } }, closeSuggestions() {},
    refreshCacheStats: async () => {}, recordHistory: async result => { h.records.push(result); },
    toast: (...args) => h.toasts.push(args), normalizeError: error => error, Date, setTimeout };
  const actions = vm.runInNewContext(`(() => {
    ${section('function cancelTabResolution(', '\nfunction patch(')}
    ${section('function titleFor(', '\nasync function recordHistory(')}
    ${section('function goHistory(', '\nfunction renderTabs(')}
    // Observe admission/settlement without replacing the actual function bodies.
    const originalNavigate = navigate;
    navigate = (...args) => {
      observed.navigations.push(args);
      const pending = originalNavigate(...args);
      observed.pending.push(pending);
      return pending;
    };
    return { navigate, goHistory, reload };
  })()`, context);
  h.retry = () => {
    assert.match(source, /\bretry:\s*reload,/, 'actual application context supplies the existing reload action');
    const ctx = { model: model.get(), navigate: actions.navigate, retry: actions.reload };
    const view = renderInscriptions(model.get().results.a, ctx);
    const button = view.querySelectorAll('button').find(node => node.textContent === 'Try again');
    assert.ok(button, 'actual error UI exposes Try again');
    button.click();
  };
  h.backToGallery = async () => {
    if (atEnd) await actions.navigate(target, { fromHistory: true, historyIndex: 1, record: false });
    else { actions.goHistory(-2); await tick(); }
    assert.equal(activeTab().historyIndex, 1);
    assert.equal(model.get().results.a.error.code, 'ALL_PROVIDERS_FAILED');
  };
  h.assertRetryContract = () => {
    assert.equal(activeTab().target, target);
    assert.equal(activeTab().historyIndex, 1);
    assert.deepEqual(h.resolves, [target, target]);
    assert.equal(h.navigations.length, 2, 'one Back/load and one retry');
    assert.equal(h.navigations[1][1].record, false);
    assert.deepEqual(h.records, [], 'retry does not add a global history record');
  };
  h.actions = actions;
  return h;
}

test('gallery Try again preserves forward history after Back, on recovered success', async t => {
  const h = fixture(t); await h.backToGallery(); h.recover = true;
  h.retry(); await Promise.all(h.pending);
  h.assertRetryContract();
  const tab = h.model.get().tabs[0];
  console.log(JSON.stringify({ case: 'gallery-retry-success', history: tab.history, historyIndex: tab.historyIndex,
    navigations: h.navigations, resolves: h.resolves, error: h.model.get().results.a.error?.code ?? null }));
  assert.deepEqual([...tab.history], initialHistory);
  assert.equal(tab.historyIndex, 1);
});

test('toolbar Reload control preserves forward history on the same failed gallery', async t => {
  const h = fixture(t); await h.backToGallery(); h.recover = true;
  h.actions.reload(); await tick();
  h.assertRetryContract();
  const tab = h.model.get().tabs[0];
  assert.deepEqual([...tab.history], initialHistory);
  assert.equal(tab.historyIndex, 1);
  assert.equal(h.model.get().results.a.error, undefined);
});

test('gallery Try again control recovers at end of history without duplicate entries', async t => {
  const h = fixture(t, { atEnd: true }); await h.backToGallery(); h.recover = true;
  h.retry(); await Promise.all(h.pending);
  h.assertRetryContract();
  const tab = h.model.get().tabs[0];
  assert.deepEqual([...tab.history], initialHistory.slice(0, 2));
  assert.equal(tab.historyIndex, 1);
  assert.equal(h.model.get().results.a.error, undefined);
});

test('gallery Try again preserves forward history even when the source remains unavailable', async t => {
  const h = fixture(t); await h.backToGallery();
  h.retry(); await Promise.all(h.pending);
  h.assertRetryContract();
  const tab = h.model.get().tabs[0];
  console.log(JSON.stringify({ case: 'gallery-retry-failure', history: tab.history, historyIndex: tab.historyIndex,
    error: h.model.get().results.a.error.code }));
  assert.deepEqual([...tab.history], initialHistory);
  assert.equal(tab.historyIndex, 1);
  assert.equal(h.model.get().results.a.error.code, 'ALL_PROVIDERS_FAILED');
});

test('gallery retry retains the exact block, upstream page and offset target without recording history', async t => {
  const target = 'satnav://inscriptions?page=2&offset=48&block=840000';
  const h = fixture(t, { atEnd: true, target }); await h.backToGallery(); h.recover = true;
  h.retry(); await Promise.all(h.pending);
  h.assertRetryContract();
  const tab = h.model.get().tabs[0];
  assert.deepEqual([...tab.history], ['satnav://home', target]);
  assert.equal(h.model.get().results.a.target.canonical, target);
  assert.equal(h.model.get().results.a.error, undefined);
});
