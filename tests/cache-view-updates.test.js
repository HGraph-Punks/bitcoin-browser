import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';

// Real views, DOM helpers and formatters with a bounded DOM collaborator.
// These assertions do not establish browser layout, native focus or selection.
class FakeNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag === '#text' ? null : tag.toUpperCase();
    this._text = text;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textWrites = 0;
    this.scrollTop = 0;
  }
  get textContent() { return this.children.length ? this.children.map(node => node.textContent).join('') : this._text; }
  set textContent(value) { this.textWrites += 1; this.replaceChildren(); this._text = String(value); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) {
    if (this.children.some(node => node.contains(documentStub.activeElement))) documentStub.activeElement = null;
    for (const node of this.children) node.parentElement = null;
    this.children = []; this._text = ''; this.scrollTop = 0;
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { documentStub.activeElement = this; }
  querySelectorAll(selector) {
    const matches = node => {
      if (!node.tagName) return false;
      if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
      const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attr) {
        const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        const value = attr[1].startsWith('data-') ? node.dataset[key] : node.attributes[attr[1]];
        return value !== undefined && (attr[2] === undefined || value === attr[2]);
      }
      return node.tagName === selector.toUpperCase();
    };
    const found = [];
    const walk = node => { for (const child of node.children) { if (matches(child)) found.push(child); walk(child); } };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const documentStub = {
  activeElement: null,
  createElement: tag => new FakeNode(tag),
  createTextNode: value => new FakeNode('#text', String(value))
};
globalThis.Node = FakeNode;
globalThis.document = documentStub;
const { renderHome, renderSettings, updateCacheViews } = await import('../src/renderer/views.js');

function model(cache = { bytes: 4096, entries: 4 }) {
  return { settings: { ...DEFAULT_SETTINGS }, providers: [], history: [], bookmarks: [], cache };
}
function metrics(root) { return Object.fromEntries(root.querySelectorAll('[data-cache-value]').map(node => [node.dataset.cacheValue, node])); }

test('real Home cache metrics update while search, card actions and library sections retain identity', () => {
  const navigations = [];
  const view = renderHome(model(), { navigate: target => navigations.push(target) });
  const search = view.querySelector('input');
  const values = metrics(view);
  const card = values.bytes.parentElement.parentElement;
  const sections = view.querySelectorAll('[data-home-library]');
  assert.deepEqual(Object.keys(values), ['bytes', 'entries']);
  assert.equal(values.bytes.textContent, '4.00 KB');
  assert.equal(values.entries.textContent, '4 cached resources');
  search.value = 'block:840000';
  Object.assign(search, { selectionStart: 6, selectionEnd: 12, selectionDirection: 'backward' });
  search.focus(); view.scrollTop = 183;
  assert.equal(updateCacheViews(view, { bytes: 0, entries: 0 }), 2);
  assert.equal(metrics(view).bytes, values.bytes);
  assert.equal(metrics(view).entries, values.entries);
  assert.equal(values.bytes.textContent, '0 B');
  assert.equal(values.entries.textContent, '0 cached resources');
  assert.equal(values.bytes.parentElement.parentElement, card);
  assert.deepEqual(view.querySelectorAll('[data-home-library]'), sections);
  assert.equal(view.querySelector('input'), search);
  assert.equal(documentStub.activeElement, search);
  assert.equal(search.value, 'block:840000');
  assert.deepEqual([search.selectionStart, search.selectionEnd, search.selectionDirection], [6, 12, 'backward']);
  assert.equal(view.scrollTop, 183);
  card.listeners.click();
  assert.deepEqual(navigations, ['satnav://settings']);
});

test('real Settings updates only used-capacity text and preserves edited controls and handlers', () => {
  const changes = [];
  const view = renderSettings(model(), { updateSettings: value => changes.push(value) });
  const controls = [...view.querySelectorAll('input'), ...view.querySelectorAll('select')];
  const input = view.querySelector('[aria-label="Request timeout"]');
  const capacity = view.querySelector('[aria-label="Cache capacity"]');
  const values = metrics(view);
  assert.deepEqual(Object.keys(values), ['used']);
  assert.equal(values.used.textContent, '4.00 KB currently used.');
  input.value = '7500'; capacity.value = String(5 * 1024 ** 3);
  input.focus(); view.scrollTop = 377;
  assert.equal(updateCacheViews(view, { bytes: 2048, entries: 2 }), 1);
  assert.equal(values.used.textContent, '2.00 KB currently used.');
  assert.equal(metrics(view).used, values.used);
  assert.deepEqual([...view.querySelectorAll('input'), ...view.querySelectorAll('select')], controls);
  assert.equal(input.value, '7500'); assert.equal(capacity.value, String(5 * 1024 ** 3));
  assert.equal(documentStub.activeElement, input); assert.equal(view.scrollTop, 377);
  input.listeners.change({ currentTarget: input });
  capacity.listeners.change({ currentTarget: capacity });
  assert.deepEqual(changes, [{ requestTimeoutMs: 7500 }, { cacheMaxBytes: 5 * 1024 ** 3 }]);
});

test('unchanged cache replies do not replace metric text children or write textContent', () => {
  const cache = { bytes: 4096, entries: 4 };
  const view = renderHome(model(cache), { navigate() {} });
  const nodes = Object.values(metrics(view));
  const textChildren = nodes.map(node => node.children[0]);
  assert.equal(updateCacheViews(view, cache), 2);
  assert.deepEqual(nodes.map(node => node.textWrites), [0, 0]);
  assert.deepEqual(nodes.map(node => node.children[0]), textChildren);
});

test('cache updates ignore unrelated roots and unknown markers without touching content', () => {
  assert.equal(updateCacheViews(null, {}), 0);
  assert.equal(updateCacheViews({}, {}), 0);
  const page = new FakeNode('main');
  const frame = new FakeNode('iframe');
  const unknown = new FakeNode('span');
  unknown.dataset.cacheValue = 'unknown'; unknown.textContent = 'retain';
  page.append(frame, unknown); frame.focus(); page.scrollTop = 93;
  assert.equal(updateCacheViews(page, { bytes: 0, entries: 0 }), 0);
  assert.deepEqual(page.children, [frame, unknown]);
  assert.equal(unknown.textContent, 'retain'); assert.equal(unknown.textWrites, 1);
  assert.equal(documentStub.activeElement, frame); assert.equal(page.scrollTop, 93);
});

test('missing and malformed cache values retain formatter behavior and use safe text, not markup', () => {
  const view = renderHome(model(), { navigate() {} });
  const bundledLogo = view.querySelectorAll('img');
  assert.equal(bundledLogo.length, 1);
  updateCacheViews(view, undefined);
  assert.equal(metrics(view).bytes.textContent, '0 B');
  assert.equal(metrics(view).entries.textContent, '0 cached resources');
  updateCacheViews(view, { bytes: -1, entries: '<img onerror=fixture>' });
  assert.equal(metrics(view).bytes.textContent, '—');
  assert.equal(metrics(view).entries.textContent, '<img onerror=fixture> cached resources');
  assert.deepEqual(view.querySelectorAll('img'), bundledLogo, 'untrusted cache text must not add an image');
  assert.equal(metrics(view).entries.children.length, 0, 'textContent assignment never parses HTML in this collaborator');
});
