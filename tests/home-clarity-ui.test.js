import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderHome, renderHomeLibrarySection } from '../src/renderer/views.js';
import { renderLookup, LOOKUP_MODES } from '../src/renderer/search.js';
import { clear } from '../src/renderer/dom.js';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';

// Real renderer functions, with bounded DOM collaborators. Native layout,
// details keyboard defaults, platform window controls and AT remain unqualified.
class TestNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag.toUpperCase(); this._text = text; this.children = [];
    this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {};
    this.className = ''; this.value = ''; this.disabled = false; this.open = false;
    this.classList = { toggle: (name, on) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on ?? !names.has(name)) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    } };
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = null;
    this.children = []; this._text = ''; this.append(...nodes);
  }
  replaceWith(next) {
    const parent = this.parentElement; parent.children[parent.children.indexOf(this)] = next;
    next.parentElement = parent; this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'open') this.open = true; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { document.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) {
      const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = attr[1].startsWith('data-') ? this.dataset[key] : this.attributes[attr[1]];
      return value !== undefined && (attr[2] === undefined || value === attr[2]);
    }
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { activeElement: null, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function model(options = {}) {
  return { activeTabId: 'tab-a', requestSequence: { 'tab-a': 1 }, bootstrap: {},
    settings: { ...DEFAULT_SETTINGS }, cache: { bytes: 2048, entries: 2 }, history: [], bookmarks: [],
    providers: [{ id: 'main', enabled: true, network: 'mainnet', health: { ok: true } }], ...options };
}
const homeResult = () => ({ target: { kind: 'home', canonical: 'satnav://home' } });
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
function submit(form) { let prevented = 0; form.listeners.submit({ preventDefault() { prevented++; } }); assert.equal(prevented, 1); }
function visible(node) {
  if (node.className.split(/\s+/).includes('hidden')) return false;
  if (!node.parentElement) return true;
  if (node.parentElement.tagName === 'DETAILS' && !node.parentElement.open && node.tagName !== 'SUMMARY') return false;
  return visible(node.parentElement);
}

test('Start has one visible primary action, one search form and three native optional disclosures', () => {
  const calls = []; const root = renderHome(model(), { navigate: target => calls.push(target) });
  assert.equal(root.className, 'home-page');
  assert.equal(root.children[0].className, 'home-hero');
  assert.equal(root.querySelectorAll('form').length, 1);
  assert.equal(root.querySelector('form').attributes.role, 'search');
  assert.deepEqual(root.querySelectorAll('.primary').filter(visible).map(node => node.textContent), ['Search']);
  const details = root.querySelectorAll('details');
  assert.equal(details.length, 3); assert.ok(details.every(node => !node.open));
  assert.deepEqual(details.map(node => node.querySelector('summary').children[0].textContent), ['Search options & examples', 'Tools & setup', 'Browser status']);
  assert.equal(visible(root.querySelector('select')), false);
  assert.equal(visible(root.querySelector('input')), true);
  assert.equal(visible(button(root, '◈Explore inscriptions')), true);
  assert.equal(visible(button(root, 'ᚱExplore Runes')), true);
  assert.equal(visible(root.querySelector('.home-source-notice')), false);
  assert.equal(root.querySelectorAll('.empty-state').length, 0, 'empty libraries are concise, not oversized empty panels');
  assert.deepEqual(calls, []);
});

test('all previous Home destinations, metrics and every lookup type remain reachable', () => {
  const calls = []; const root = renderHome(model(), { navigate: target => calls.push(target) });
  assert.deepEqual(root.querySelector('select').children.map(option => option.value), LOOKUP_MODES.map(mode => mode.value));
  for (const node of root.querySelectorAll('details')) node.open = true;
  const destinations = [
    ['◈Explore inscriptions', 'satnav://inscriptions'], ['ᚱExplore Runes', 'satnav://runes'],
    ['⛁Set up a local node', 'satnav://node-setup'], ['Genesis sat', 'sat:0'], ['Block height', '/r/blockheight'],
    ['Latest block hash', '/r/blockhash'], ['Wallet', 'satnav://wallet'], ['Local sources', 'satnav://providers'],
    ['All history', 'satnav://history'], ['All bookmarks', 'satnav://bookmarks'], ['Browsing help', 'satnav://documentation']
  ];
  for (const [label, target] of destinations) {
    const control = button(root, label); assert.ok(control, label); assert.ok(visible(control), label);
    control.listeners.click(); assert.equal(calls.at(-1), target);
  }
  const metrics = root.querySelector('.home-system-grid').querySelectorAll('.card');
  assert.equal(metrics.length, 3);
  for (const metric of metrics) metric.listeners.click();
  assert.deepEqual(calls.slice(-3), ['satnav://providers', 'satnav://settings', 'satnav://settings']);
});

test('Start introduces browsing without a wallet or node and resumes the existing AI owner only on click', () => {
  const calls = []; let resumed = 0;
  const root = renderHome(model(), { navigate: target => calls.push(target), openAiWorkspace: () => resumed++ });
  assert.match(root.querySelector('.home-reassurance').textContent, /No wallet required.*node is optional/);
  assert.equal(root.querySelectorAll('.home-destination').length, 3);
  const ai = button(root, '✧Ask Bitcoin'); assert.ok(visible(ai)); assert.equal(resumed, 0); assert.deepEqual(calls, []);
  ai.listeners.click(); assert.equal(resumed, 1); assert.deepEqual(calls, [], 'Do not navigate away from or replace the existing chat owner');
});

test('simple lookup retains bound labels, unique IDs, visible privacy scope and error/choice associations', () => {
  const form = renderLookup({ navigate() {} }, { simple: true });
  const other = renderLookup({ navigate() {} }, { simple: true });
  const input = form.querySelector('input'), select = form.querySelector('select');
  assert.deepEqual(form.querySelectorAll('label').map(node => node.htmlFor), [input.attributes.id, select.attributes.id]);
  assert.notEqual(input.attributes.id, other.querySelector('input').attributes.id);
  assert.equal(input.attributes['aria-describedby'], `${input.attributes.id}-hint ${input.attributes.id}-help ${input.attributes.id}-error`);
  assert.equal(input.attributes.maxlength, '2048'); assert.equal(input.listeners.keydown, undefined);
  assert.equal(form.querySelectorAll('button').filter(node => node.attributes.type === 'submit').length, 1);
  assert.match(form.querySelector('.lookup-hint').textContent, /configured data sources; saved-item search stays on this device/);
  assert.equal(form.querySelector('.lookup-error').attributes.role, 'alert');
  assert.equal(form.querySelector('.lookup-choices').attributes['aria-live'], 'polite');
});

test('simple search never navigates on typing or invalid input, and ambiguity requires an explicit choice', () => {
  const calls = []; const form = renderLookup({ navigate: target => calls.push(target) }, { simple: true });
  const input = form.querySelector('input'); input.value = ''; submit(form);
  assert.equal(input.attributes['aria-invalid'], 'true'); assert.equal(document.activeElement, input);
  assert.ok(visible(form.querySelector('.lookup-error')));
  input.value = '840000'; input.listeners.input(); assert.deepEqual(calls, []); submit(form);
  const choices = form.querySelector('.lookup-choices').querySelectorAll('button');
  assert.equal(choices.length, 3); assert.ok(visible(choices[0])); assert.equal(document.activeElement, choices[0]);
  assert.deepEqual(calls, []); choices[1].listeners.click(); assert.deepEqual(calls, ['block:840000']);
  input.value = 'https://example.test/'; input.listeners.input(); submit(form);
  assert.equal(calls.length, 1); assert.equal(input.attributes['aria-invalid'], 'true');
});

test('disclosed search types keep their selected-mode cue and examples fill without submitting', () => {
  const calls = []; const form = renderLookup({ navigate: target => calls.push(target) }, { simple: true });
  const details = form.querySelector('details'), select = form.querySelector('select'), input = form.querySelector('input');
  details.open = true; select.value = 'block'; select.listeners.change();
  button(form, 'Try an example').listeners.click();
  assert.equal(input.value, '840000'); assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 6]); assert.deepEqual(calls, []);
  details.open = false; assert.match(details.querySelector('summary').textContent, /Block/);
  submit(form); assert.deepEqual(calls, ['block:840000']);
  details.open = true; select.value = 'saved'; select.listeners.change();
  assert.equal(button(form, 'Try an example').disabled, true);
  input.value = 'my saved art'; details.open = false; submit(form);
  assert.deepEqual(calls, ['block:840000', 'search:my saved art']);
});

test('offline and failed-source recovery stay outside collapsed technical status', () => {
  const calls = [];
  const offline = model({ settings: { ...DEFAULT_SETTINGS, offlineMode: true } });
  const root = renderHome(offline, { navigate: target => calls.push(target) });
  const notice = root.querySelector('.home-source-notice');
  assert.equal(notice.attributes.role, 'status'); assert.ok(visible(notice)); assert.match(notice.textContent, /Only previously cached/);
  button(root, 'Review offline mode').listeners.click(); assert.deepEqual(calls, ['satnav://settings']);
  const failed = model({ providers: [{ network: 'mainnet', enabled: true, health: { ok: false } }] });
  root.retainHome(homeResult(), failed); assert.ok(visible(notice)); assert.match(notice.textContent, /None passed their last health check/);
  button(root, 'Review data sources').listeners.click(); assert.equal(calls.at(-1), 'satnav://providers');
  root.retainHome(homeResult(), model()); assert.equal(visible(notice), false);
});

test('Home source status is network-specific and never turns an unchecked source into ready', () => {
  const root = renderHome(model({ providers: [
    { enabled: true, network: 'signet', health: { ok: true } },
    { enabled: true, network: 'mainnet' }, { enabled: false, network: 'mainnet', health: { ok: true } }
  ] }), { navigate() {} });
  const sourceCard = root.querySelector('.home-system-grid').querySelector('.card');
  assert.match(sourceCard.textContent, /0\/1/); assert.match(sourceCard.textContent, /no successful health check yet/);
  assert.doesNotMatch(sourceCard.textContent, /ready/);
  const network = model({ settings: { ...DEFAULT_SETTINGS, network: 'signet' } });
  root.retainHome(homeResult(), network);
  assert.match(root.querySelector('.home-source-notice').textContent, /SIGNET, not Bitcoin mainnet/);
  assert.ok(visible(root.querySelector('.home-source-notice')));
  root.retainHome(homeResult(), model({ settings: { ...DEFAULT_SETTINGS, localOnly: true } }));
  assert.match(root.querySelector('.home-source-notice').textContent, /Remote data sources will not be used/);
});

test('background Home publication retains query, native disclosures, controls and focused selection', () => {
  const initial = model(); const root = renderHome(initial, { navigate() {} });
  const form = root.querySelector('form'), input = root.querySelector('input'), cards = root.querySelectorAll('.card');
  const details = root.querySelectorAll('details'); details.forEach(node => { node.open = true; });
  input.value = 'block:840'; input.selectionStart = 3; input.selectionEnd = 8; input.focus();
  const next = model({ cache: { bytes: 4096, entries: 4 }, providers: [] });
  assert.equal(root.retainHome(homeResult(), next), true);
  assert.equal(root.querySelector('form'), form); assert.equal(root.querySelector('input'), input);
  assert.equal(input.value, 'block:840'); assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 8]);
  assert.equal(document.activeElement, input); assert.ok(details.every(node => node.open));
  assert.deepEqual(root.querySelectorAll('.card'), cards);
  assert.equal(root.querySelector('[data-cache-value="bytes"]').textContent, '4.00 KB');
  assert.match(root.querySelector('.home-source-notice').textContent, /No data sources/);
});

test('Home retention rejects replacement tabs, explicit navigation revisions, routes and errors', () => {
  const root = renderHome(model(), { navigate() {} });
  assert.equal(root.retainHome(homeResult(), model({ activeTabId: 'tab-b' })), false);
  assert.equal(root.retainHome(homeResult(), model({ requestSequence: { 'tab-a': 2 } })), false);
  assert.equal(root.retainHome({ target: { kind: 'inscriptions' } }, model()), false);
  assert.equal(root.retainHome({ ...homeResult(), error: { message: 'fixture' } }, model()), false);
});

test('actual page publication preserves Start on passive status but resets it for explicit navigation', () => {
  const current = model(); const ctx = { navigate() {} }; const page = new TestNode('main'); const stage = new TestNode('main'); stage.scrollTop = 0;
  const begin = source.indexOf('function renderPage() {'), end = source.indexOf('\nfunction renderDrawer()', begin);
  assert.ok(begin >= 0 && end > begin);
  const renderPage = vm.runInNewContext(`(${source.slice(begin, end)})`, {
    state: () => current, currentResult: homeResult, elements: { page, 'main-stage': stage }, context: ctx, renderHome, clear
  });
  renderPage(); const root = page.querySelector('.home-page'), input = page.querySelector('input');
  input.value = 'a draft'; input.focus(); stage.scrollTop = 142; page.querySelector('.home-tools').open = true;
  current.providers = []; renderPage();
  assert.equal(page.querySelector('.home-page'), root); assert.equal(input.value, 'a draft');
  assert.equal(document.activeElement, input); assert.equal(stage.scrollTop, 142); assert.equal(page.querySelector('.home-tools').open, true);
  current.requestSequence['tab-a']++; renderPage();
  assert.notEqual(page.querySelector('.home-page'), root); assert.equal(page.querySelector('input').value, ''); assert.equal(stage.scrollTop, 0);
});

test('compact libraries retain six rows, full-library actions and safe titles without replacing the search', () => {
  const calls = []; const current = model();
  current.history = Array.from({ length: 8 }, (_, n) => ({ canonical: `sat:${n}`, kind: 'sat', title: `<img> ${n}` }));
  const root = renderHome(current, { navigate: target => calls.push(target) }); const input = root.querySelector('input'); input.value = 'draft'; input.focus();
  const recent = root.querySelector('[data-home-library="history"]'); assert.equal(recent.querySelectorAll('.list-row').length, 6);
  assert.equal(recent.querySelectorAll('img').length, 0); recent.querySelector('.list-row').listeners.click(); assert.deepEqual(calls, ['sat:0']);
  const next = renderHomeLibrarySection('history', { ...current, history: [] }, { navigate: target => calls.push(target) }); recent.replaceWith(next);
  assert.equal(root.querySelector('input'), input); assert.equal(input.value, 'draft'); assert.equal(document.activeElement, input);
  assert.match(next.textContent, /No browsing history yet/); button(next, 'All history').listeners.click(); assert.equal(calls.at(-1), 'satnav://history');
});

test('window-control inset is non-shrinking before bootstrap and non-Mac release uses trusted platform data', async () => {
  const styles = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(styles, /\.window-spacer\{display:block;flex:0 0 76px;/);
  assert.match(styles, /\.app-shell\[data-platform="win32"\] \.window-spacer,\.app-shell\[data-platform="linux"\] \.window-spacer\{display:none\}/);
  assert.doesNotMatch(styles, /data-platform="darwin"[^}]*display:none/);
  assert.match(html, /class="window-spacer" aria-hidden="true"[\s\S]*?class="brand no-drag"/);
  assert.match(html, /href="\.\/home\.css"/);
  const begin = source.indexOf('    const bootstrapData = await api.app.bootstrap();');
  const end = source.indexOf('    const savedTabs =', begin); assert.ok(begin >= 0 && end > begin);
  for (const [platform, expected] of [['darwin', 'darwin'], ['win32', 'win32'], ['linux', 'linux'], [null, 'unknown'], ['untrusted', 'unknown']]) {
    const elements = { app: { dataset: {} } };
    const run = vm.runInNewContext(`(async () => {${source.slice(begin, end)}})`, { elements, api: { app: { bootstrap: async () => ({ application: { platform } }) } } });
    await run(); assert.equal(elements.app.dataset.platform, expected);
  }
});
