import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalServiceManager } from '../src/main/local-service-manager.js';

class FakeNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag === '#text' ? undefined : tag.toUpperCase();
    this._textContent = text;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.listeners = {};
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
  }
  get textContent() { return this.tagName ? this.children.map((child) => child.textContent).join('') || this._textContent : this._textContent; }
  set textContent(value) { this._textContent = String(value); for (const node of this.children ?? []) node.parentElement = null; this.children = []; }
  append(...nodes) { for (const node of nodes) { if (node == null) continue; node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.scrollTop = 0; this.scrollLeft = 0; this.append(...nodes); }
  insertBefore(node, before) {
    if (node.parentElement) node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1);
    const index = before ? this.children.indexOf(before) : this.children.length;
    node.parentElement = this; this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }
  remove() { if (!this.parentElement) return; this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  matches(selector) { return matches(this, selector); }
  querySelectorAll(selector) { const found = []; const walk = (node) => { for (const child of node.children) { if (matches(child, selector)) found.push(child); walk(child); } }; walk(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function dataKey(name) { return name.replace(/^data-/, '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()); }
function matches(node, selector) {
  if (!node.tagName) return false;
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const data = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
  if (data) {
    const key = dataKey(data[1]);
    return Object.hasOwn(node.dataset, key) && (data[2] === undefined || node.dataset[key] === data[2]);
  }
  return node.tagName === selector.toUpperCase();
}

const documentStub = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (value) => new FakeNode('#text', String(value)),
  createDocumentFragment: () => new FakeNode('fragment')
};
globalThis.Node = FakeNode;
globalThis.document = documentStub;
const { renderServices, updateServicesView, renderProviders, updateProviderHealthViews } = await import('../src/renderer/views.js');

function service(id, overrides = {}) {
  return { id, name: `Service ${id}`, executable: `/owned/${id}`, enabled: true, autoStart: false, status: 'stopped', pid: null, error: null, logs: [], ...overrides };
}
function context(overrides = {}) {
  return { openServiceModal() {}, startService() {}, stopService() {}, serviceActionPending: () => null, ...overrides };
}

test('background Core health recovery retains provider cards, controls, disclosure state, and scroll', () => {
  const provider = { id: 'guided-core-mainnet', name: 'My Bitcoin Core', type: 'bitcoin-core', enabled: true, local: true,
    network: 'mainnet', baseUrl: 'http://127.0.0.1:8332', priority: 5, capabilities: ['block'],
    health: { ok: false, error: { code: 'PROVIDER_COOKIE_UNAVAILABLE' } } };
  const view = renderProviders({ providers: [provider], settings: { network: 'mainnet' } }, {});
  const card = view.querySelector('[data-provider-card]'); const controls = card.querySelectorAll('button');
  const disclosure = view.querySelector('details'); disclosure.open = true; view.scrollTop = 123;
  const health = card.querySelector('[data-provider-health]'); const help = card.querySelector('[data-provider-health-help]');
  assert.equal(health.textContent, 'STOPPED OR STARTING'); assert.match(help.textContent, /no password change/);
  updateProviderHealthViews(view, [{ ...provider, health: { ok: true, initialBlockDownload: true, verificationProgress: 0.91 } }]);
  assert.equal(health.textContent, 'SYNCING · 91.0%'); assert.match(help.textContent, /Connected to Bitcoin Core/);
  assert.equal(view.querySelector('[data-provider-card]'), card); assert.deepEqual(card.querySelectorAll('button'), controls);
  assert.equal(card.querySelector('[data-provider-health]'), health); assert.equal(card.querySelector('[data-provider-health-help]'), help);
  assert.equal(disclosure.open, true); assert.equal(view.scrollTop, 123);
  updateProviderHealthViews(view, [{ ...provider, health: { ok: false, error: { code: 'PROVIDER_AUTH_ERROR' } } }]);
  assert.equal(health.textContent, 'SIGN-IN REJECTED'); assert.equal(health.title, 'PROVIDER_AUTH_ERROR');
  assert.match(help.textContent, /same running node/);
});

test('updates same-id cards and controls in place while handlers use the latest descriptor', () => {
  const edits = []; const starts = []; const first = service('a');
  const view = renderServices({ services: [first] }, context({ openServiceModal: (value) => edits.push(value), startService: (id) => starts.push(id) }));
  const card = view.querySelector('[data-service-card]');
  const edit = card.querySelectorAll('button')[0];
  const lifecycle = card.querySelector('[data-service-lifecycle]');
  const updated = service('a', { name: 'Latest', executable: '/new/path' });
  const latestContext = context({ openServiceModal: (value) => edits.push(value), startService: (id) => starts.push(`new:${id}`) });
  assert.equal(updateServicesView(view, { services: [updated] }, latestContext), true);
  assert.equal(view.querySelector('[data-service-card]'), card);
  assert.equal(card.querySelectorAll('button')[0], edit);
  assert.equal(card.querySelector('[data-service-lifecycle]'), lifecycle);
  edit.listeners.click(); lifecycle.listeners.click();
  assert.equal(edits[0], updated); assert.deepEqual(starts, ['new:a']);
  assert.equal(card.querySelector('[data-service-name]').textContent, 'Latest');
});

test('pending and lifecycle statuses update the retained action without invoking it', () => {
  let calls = 0;
  const view = renderServices({ services: [service('a')] }, context({ startService: () => { calls += 1; } }));
  const lifecycle = view.querySelector('[data-service-lifecycle]');
  updateServicesView(view, { services: [service('a')] }, context({ serviceActionPending: () => 'start', startService: () => { calls += 1; } }));
  assert.equal(lifecycle.textContent, 'Starting…'); assert.equal(lifecycle.disabled, true); lifecycle.listeners.click(); assert.equal(calls, 0);
  updateServicesView(view, { services: [service('a', { status: 'stopping' })] }, context());
  assert.equal(lifecycle.textContent, 'Stopping…'); assert.equal(lifecycle.disabled, true);
  updateServicesView(view, { services: [service('a', { status: 'running' })] }, context());
  assert.equal(lifecycle.textContent, 'Stop'); assert.equal(lifecycle.disabled, false); assert.equal(lifecycle.className.includes('danger'), true);
  updateServicesView(view, { services: [service('a', { status: 'failed', error: 'exited' })] }, context());
  assert.equal(lifecycle.textContent, 'Start'); assert.equal(view.querySelector('[data-service-status]').className.includes('fail'), true);
  updateServicesView(view, { services: [service('a', { status: 'failed', error: 'termination timed out', pid: 4321 })] }, context());
  assert.equal(lifecycle.textContent, 'Stop'); assert.equal(lifecycle.disabled, false); assert.equal(lifecycle.dataset.serviceAction, 'stop');
  updateServicesView(view, { services: [service('a', { status: 'failed', error: 'exited', pid: null })] }, context());
  assert.equal(lifecycle.textContent, 'Start'); assert.equal(lifecycle.dataset.serviceAction, 'start');
  updateServicesView(view, { services: [service('a', { enabled: false })] }, context()); assert.equal(lifecycle.disabled, true);
  updateServicesView(view, { services: [service('a', { executable: '' })] }, context()); assert.equal(lifecycle.disabled, true);
  assert.equal(view.querySelector('[data-service-badges]').className, 'badges');
});

test('updates bounded safe-text logs without replacing the card, control, or log scroller', () => {
  const initial = service('a', { logs: [{ time: 't0', stream: 'stdout', text: 'first' }] });
  const view = renderServices({ services: [initial] }, context());
  const card = view.querySelector('[data-service-card]'); const control = card.querySelector('[data-service-lifecycle]'); const log = card.querySelector('[data-service-log]');
  log.scrollTop = 37; log.scrollLeft = 11;
  const firstRow = log.children[0];
  updateServicesView(view, { services: [service('a', { name: 'Unrelated change', logs: initial.logs })] }, context());
  assert.equal(log.children[0], firstRow);
  const logs = Array.from({ length: 65 }, (_, index) => ({ time: `t${index}`, stream: 'stdout', text: index === 64 ? '<img onerror=secret>' : String(index) }));
  updateServicesView(view, { services: [service('a', { logs })] }, context());
  assert.equal(view.querySelector('[data-service-card]'), card); assert.equal(card.querySelector('[data-service-lifecycle]'), control);
  assert.equal(card.querySelector('[data-service-log]'), log); assert.equal(log.scrollTop, 37); assert.equal(log.scrollLeft, 11); assert.equal(log.children.length, 60);
  assert.equal(log.children.at(-1).textContent, '[t64] <img onerror=secret>'); assert.equal(log.children.at(-1).children.length, 1);
});

test('adds, removes, and reorders keyed cards without moving already ordered nodes', () => {
  const view = renderServices({ services: [service('a'), service('b')] }, context());
  const a = view.querySelector('[data-service-card][data-service-id="a"]') ?? view.querySelectorAll('[data-service-card]')[0];
  const b = view.querySelectorAll('[data-service-card]')[1];
  updateServicesView(view, { services: [service('a'), service('b'), service('c')] }, context());
  let cards = view.querySelectorAll('[data-service-card]'); assert.equal(cards[0], a); assert.equal(cards[1], b);
  const c = cards[2];
  updateServicesView(view, { services: [service('c'), service('a')] }, context());
  cards = view.querySelectorAll('[data-service-card]'); assert.deepEqual(cards, [c, a]); assert.equal(b.parentElement, null);
});

test('returns false outside a rendered Services view and retains Add service with latest context', () => {
  assert.equal(updateServicesView(new FakeNode('main'), { services: [] }, context()), false);
  const calls = []; const view = renderServices({ services: [] }, context({ openServiceModal: () => calls.push('old'), refreshServices: () => calls.push('old-refresh') }));
  updateServicesView(view, { services: [] }, context({ openServiceModal: () => calls.push('new'), refreshServices: () => calls.push('refresh'), serviceRefreshPending: () => true }));
  const refresh = view.querySelector('[data-services-refresh]');
  assert.equal(refresh.disabled, true); refresh.listeners.click();
  view.querySelectorAll('button').find(node => node.textContent.includes('Add service')).listeners.click(); assert.deepEqual(calls, ['refresh', 'new']);
});

test('autostart pre-spawn failure publishes into the retained real service card', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-service-view-autostart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configured = {
    id: 'missing', name: 'Missing fixture', executable: path.join(directory, 'missing-node'),
    args: [], cwd: directory, enabled: true, autoStart: true
  };
  const state = { localServices: [configured] };
  const store = {
    get(parts) { return structuredClone(state[parts[0]]); },
    async mutate(callback) { callback(state); }
  };
  const edits = []; const starts = [];
  const ctx = context({ openServiceModal: (value) => edits.push(value), startService: (id) => starts.push(id) });
  let view;
  const publications = [];
  const updateResults = [];
  const manager = new LocalServiceManager(store, { warn() {}, info() {} }, (services) => {
    publications.push(services);
    updateResults.push(updateServicesView(view, { services }, ctx));
  });
  view = renderServices({ services: manager.list() }, ctx);
  const card = view.querySelector('[data-service-card]');
  const edit = card.querySelectorAll('button')[0];
  const lifecycle = card.querySelector('[data-service-lifecycle]');

  await manager.autoStart();

  assert.equal(manager.processes.size, 0, 'missing-path validation never creates a child');
  assert.equal(publications.length, 1);
  assert.deepEqual(updateResults, [true]);
  assert.equal(view.querySelector('[data-service-card]'), card);
  assert.equal(card.querySelectorAll('button')[0], edit);
  assert.equal(card.querySelector('[data-service-lifecycle]'), lifecycle);
  assert.equal(card.querySelector('[data-service-status]').className.includes('fail'), true);
  assert.equal(card.querySelector('[data-service-status]').textContent, '!');
  assert.match(card.querySelector('[data-service-summary]').textContent, /executable does not exist/i);
  assert.equal(card.querySelector('[data-service-badges]').textContent.includes('FAILED'), true);
  assert.equal(lifecycle.textContent, 'Start');
  assert.equal(lifecycle.dataset.serviceAction, 'start');
  assert.equal(lifecycle.disabled, false);
  assert.equal(card.textContent.includes('PID'), false);
  edit.listeners.click(); lifecycle.listeners.click();
  assert.equal(edits.length, 1);
  assert.equal(edits[0].status, 'failed');
  assert.deepEqual(starts, ['missing']);
});
