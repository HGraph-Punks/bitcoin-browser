import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceStatus } from '../src/renderer/source-status.js';

class FakeNode {
  constructor(tagName = '#fragment') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { this.listeners.get('click')?.({ currentTarget: this }); }
  focus() { document.activeElement = this; }
  get lastElementChild() { return [...this.children].reverse().find((child) => child instanceof FakeNode) ?? null; }
  matches(selector) {
    if (selector === '[data-bookmark-control]') return Object.hasOwn(this.dataset, 'bookmarkControl');
    if (selector === '[data-bookmark-icon]') return Object.hasOwn(this.dataset, 'bookmarkIcon');
    if (selector === '[data-bookmark-label]') return Object.hasOwn(this.dataset, 'bookmarkLabel');
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return selector.toUpperCase() === this.tagName;
  }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (!(child instanceof FakeNode)) continue;
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeText extends FakeNode {
  constructor(value) { super('#text'); this.textContent = String(value); }
}

globalThis.Node = FakeNode;
globalThis.document = {
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (value) => new FakeText(value),
  createDocumentFragment: () => new FakeNode()
};

const { bookmarkButton, updateBookmarkControls } = await import('../src/renderer/dom.js');
const { renderEntity, renderInscription } = await import('../src/renderer/views.js');

const first = 'sat:991001';
const collision = 'sat:9910010';

function context(bookmarks = []) {
  return {
    model: { bookmarks, history: [] },
    isBookmarked: (canonical) => bookmarks.some((entry) => entry.canonical === canonical),
    toggleBookmark() {}, copy() {}, openDeveloper() {}, navigate() {}, saveContent() {}, refreshCacheStats() {}
  };
}

test('bookmark controls update exact canonicals in place and preserve focus and listener identity', () => {
  let clicks = 0;
  const control = bookmarkButton(first, false, { onClick: () => { clicks += 1; } });
  const colliding = bookmarkButton(collision, false, { compact: true, onClick: () => { clicks += 10; } });
  const iframe = new FakeNode('iframe');
  const root = new FakeNode('main');
  root.append(control, colliding, iframe);
  const icon = control.querySelector('[data-bookmark-icon]');
  const label = control.querySelector('[data-bookmark-label]');
  assert.equal(root.querySelector('[data-bookmark-control]'), control);
  control.focus();

  assert.equal(updateBookmarkControls(root, [{ canonical: first }]), 2);
  assert.equal(control.getAttribute('aria-pressed'), 'true');
  assert.equal(control.querySelector('[data-bookmark-icon]').textContent, '★');
  assert.equal(control.querySelector('[data-bookmark-label]').textContent, 'Bookmarked');
  assert.equal(control.querySelector('[data-bookmark-icon]'), icon);
  assert.equal(control.querySelector('[data-bookmark-label]'), label);
  assert.equal(colliding.getAttribute('aria-pressed'), 'false');
  assert.equal(document.activeElement, control);
  assert.equal(root.querySelector('iframe'), iframe);
  control.click();
  assert.equal(clicks, 1);

  updateBookmarkControls(root, []);
  assert.equal(control.getAttribute('aria-pressed'), 'false');
  assert.equal(control.getAttribute('aria-label'), 'Toggle bookmark');
  assert.equal(control.querySelector('[data-bookmark-label]').textContent, 'Bookmark');
  assert.equal(root.querySelector('[data-bookmark-control]'), control);
  assert.equal(control.querySelector('[data-bookmark-icon]'), icon);
  assert.equal(control.querySelector('[data-bookmark-label]'), label);
  assert.equal(document.activeElement, control);
  assert.equal(root.querySelector('iframe'), iframe);
});

test('real entity and inscription views expose owned full and compact controls', () => {
  const entityRoot = renderEntity({
    target: { kind: 'sat', canonical: first, display: 'Sat 991001' },
    entity: { canonical: first, summary: { number: 991001 }, links: [], source: {} }, attempts: []
  }, context());
  const entityControl = entityRoot.querySelector('[data-bookmark-control]');
  assert.equal(entityControl.dataset.bookmarkCanonical, first);
  assert.equal(entityControl.querySelector('[data-bookmark-label]').children[0].textContent, 'Bookmark');

  const id = `${'a'.repeat(64)}i0`;
  const canonical = `inscription:${id}`;
  let toggles = 0;
  const inscriptionContext = context([{ canonical }]);
  inscriptionContext.toggleBookmark = () => { toggles += 1; };
  const inscriptionRoot = renderInscription({
    target: { kind: 'inscription', canonical, value: id, display: id },
    entity: { canonical, summary: { id }, source: {} }
  }, inscriptionContext);
  const compact = inscriptionRoot.querySelector('[data-bookmark-control]');
  const iframe = inscriptionRoot.querySelector('iframe');
  const compactIcon = compact.querySelector('[data-bookmark-icon]');
  assert.equal(compact.dataset.bookmarkCanonical, canonical);
  assert.equal(compact.getAttribute('aria-pressed'), 'true');
  assert.equal(compact.querySelector('[data-bookmark-label]'), null);
  compact.focus();
  compact.click();
  assert.equal(toggles, 1);
  updateBookmarkControls(inscriptionRoot, []);
  assert.equal(compact.getAttribute('aria-pressed'), 'false');
  assert.equal(inscriptionRoot.querySelector('[data-bookmark-control]'), compact);
  assert.equal(compact.querySelector('[data-bookmark-icon]'), compactIcon);
  assert.equal(document.activeElement, compact);
  compact.click();
  assert.equal(toggles, 2);
  assert.equal(inscriptionRoot.querySelector('iframe'), iframe);
});

test('updater ignores malformed bookmark collections and unrelated nodes', () => {
  const root = new FakeNode('main');
  const unrelated = new FakeNode('button');
  unrelated.textContent = '★';
  root.append(unrelated);
  assert.equal(updateBookmarkControls(root, null), 0);
  assert.equal(unrelated.textContent, '★');
  assert.equal(updateBookmarkControls(null, [{ canonical: first }]), 0);
});

test('real renderChrome refreshes the existing page bookmark control in place', async () => {
  const appSource = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8'));
  const begin = appSource.indexOf('function renderChrome() {');
  const end = appSource.indexOf('\nasync function refreshCacheStats()', begin);
  assert.ok(begin >= 0 && end > begin);
  const canonical = first;
  const control = bookmarkButton(canonical, false, { onClick() {} });
  const page = new FakeNode('main');
  page.append(control);
  control.focus();
  const model = {
    bootstrap: {}, settings: { network: 'mainnet', privacyMode: 'standard', offlineMode: false },
    providers: [], wallet: null, bookmarks: [{ canonical }], tabs: [{ id: 'a', target: canonical }], cache: {}, loading: {}, activeTabId: 'a', developerOpen: false
  };
  const result = { target: { kind: 'sat', canonical }, entity: null };
  const elements = new Proxy({ page }, { get(target, key) {
    if (!target[key]) target[key] = new FakeNode('div');
    return target[key];
  } });
  elements.omnibox = new FakeNode('input');
  elements['source-button'].append(Object.assign(new FakeNode('span'), { className: 'source-led' }));
  elements['wallet-pill'].append(new FakeNode('span'));
  elements['title-status'].append(Object.assign(new FakeNode('span'), { className: 'status-dot' }), new FakeNode('span'));
  const workspace = new FakeNode('div');
  const previousQuery = document.querySelector;
  const previousQueryAll = document.querySelectorAll;
  document.querySelector = (selector) => selector === '.workspace' ? workspace : null;
  document.querySelectorAll = () => [];
  try {
    const renderChrome = (await import('node:vm')).runInNewContext(`(() => { ${appSource.slice(begin, end)}; return renderChrome; })()`, {
      state: () => model, renderTabs() {}, activeTab: () => ({ id: 'a', target: canonical, history: [canonical], historyIndex: 0 }),
      currentResult: () => result, document, elements, MAX_TABS: 64, targetIcon: () => '·', formatCache: () => '0 B',
      routeName: () => null, updateBookmarkControls, sourceStatus
    });
    renderChrome();
  } finally {
    document.querySelector = previousQuery;
    document.querySelectorAll = previousQueryAll;
  }
  assert.equal(page.querySelector('[data-bookmark-control]'), control);
  assert.equal(control.getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, control);
});
