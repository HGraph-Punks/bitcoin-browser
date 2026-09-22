import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { h, clear } from '../src/renderer/dom.js';
import { renderLoading, renderError, renderEntity } from '../src/renderer/views.js';

// Execute the real UI/controller functions with bounded DOM collaborators.
// This does not qualify native layout, screen-reader output or OS keyboard defaults.
class TestNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag.toUpperCase(); this._text = text; this.children = [];
    this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {};
    this.className = ''; this.value = ''; this.open = false; this.scrollCalls = [];
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => this.classList.toggle(name, true), remove: name => this.classList.toggle(name, false),
      toggle: (name, on) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (on ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      }
    };
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = null;
    this.children = []; this._text = ''; this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'open') this.open = true; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = null; }
  scrollIntoView(options) { this.scrollCalls.push(options); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) return this.attributes[attr[1]] !== undefined && (attr[2] === undefined || this.attributes[attr[1]] === attr[2]);
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { activeElement: null, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
function section(begin, end) {
  const a = source.indexOf(begin), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Source extraction bounds: ${begin}`); return source.slice(a, b);
}
function event(key, extra = {}) {
  return { key, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...extra };
}
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const parsed = (value, alternatives = []) => ({ kind: 'sat', canonical: `sat:${value}`, display: `Sat ${value}`, alternatives });
const tick = async () => { for (let n = 0; n < 4; n++) await Promise.resolve(); };

function suggestionsFixture(parse = async value => parsed(value)) {
  const model = { activeTabId: 'a', bookmarks: [], history: [], suggestionIndex: -1 };
  const elements = { omnibox: h('input', { 'aria-expanded': 'false' }), 'omnibox-suggestions': h('div', { className: 'hidden' }) };
  const calls = [], parseCalls = [], timers = [];
  const scope = {
    state: () => model, MODEL: { patch: values => Object.assign(model, values) }, elements, document, h, clear,
    api: { navigation: { parse: value => { parseCalls.push(value); return parse(value); } } },
    targetIcon: () => '·', navigate: value => calls.push(value), setTimeout: callback => timers.push(callback)
  };
  const controller = vm.runInNewContext(`(() => {
    let navigationReady = true, suggestionToken = 0;
    ${section('async function updateSuggestions()', '\nconst COMMANDS =')}
    ${section("  elements.omnibox.addEventListener('input'", "  elements['close-developer'].addEventListener")}
    return { updateSuggestions, moveSuggestion, chooseSuggestion, closeSuggestions, setReady(value) { navigationReady = value; } };
  })()`, scope);
  elements.omnibox.focus();
  return { ...controller, model, elements, input: elements.omnibox, popup: elements['omnibox-suggestions'], calls, parseCalls, timers,
    key(key, extra) { const e = event(key, extra); elements.omnibox.listeners.keydown(e); return e; } };
}

test('omnibox publishes accessible selected options while retaining input focus', async () => {
  const f = suggestionsFixture(async value => parsed(value, [parsed('2')]));
  f.input.value = '1'; await f.updateSuggestions();
  assert.equal(f.input.getAttribute('aria-expanded'), 'true'); assert.equal(f.popup.children.length, 2);
  for (const option of f.popup.children) { assert.equal(option.getAttribute('role'), 'option'); assert.equal(option.getAttribute('tabindex'), '-1'); }
  assert.equal(f.input.getAttribute('aria-activedescendant'), f.popup.children[0].getAttribute('id'));
  f.moveSuggestion(1);
  assert.deepEqual(f.popup.children.map(node => node.getAttribute('aria-selected')), ['false', 'true']);
  assert.equal(f.input.getAttribute('aria-activedescendant'), f.popup.children[1].getAttribute('id'));
  assert.equal(document.activeElement, f.input); assert.equal(f.popup.children[1].scrollCalls.length, 1);
  f.moveSuggestion(1); assert.equal(f.model.suggestionIndex, 0);
  f.moveSuggestion(-1); assert.equal(f.model.suggestionIndex, 1);
  assert.deepEqual(f.calls, []);
});

test('Escape closes the popup without discarding the query, focus or normal text-editing keys', async () => {
  const f = suggestionsFixture(); f.input.value = '840000'; await f.updateSuggestions();
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.equal(f.key(key).prevented, 0);
  const esc = f.key('Escape'); assert.equal(esc.prevented, 1); assert.equal(esc.stopped, 1);
  assert.equal(f.input.value, '840000'); assert.equal(document.activeElement, f.input);
  assert.equal(f.input.getAttribute('aria-expanded'), 'false'); assert.equal(f.input.getAttribute('aria-activedescendant'), null);
  assert.equal(f.popup.children.length, 0); assert.deepEqual(f.calls, []);
});

test('Tab dismisses suggestions without intercepting native focus traversal', async () => {
  const f = suggestionsFixture(); f.input.value = '1'; await f.updateSuggestions();
  assert.equal(f.key('Tab').prevented, 0); assert.equal(f.input.getAttribute('aria-expanded'), 'false'); assert.deepEqual(f.calls, []);
});

test('composition and modifier keys do not trigger premature navigation or selection', async () => {
  const f = suggestionsFixture(); f.input.value = '1'; await f.updateSuggestions();
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(f.key('Enter', extra).prevented, 0); assert.equal(f.key('ArrowDown', extra).prevented, 0);
  }
  assert.deepEqual(f.calls, []); assert.equal(f.model.suggestionIndex, 0);
  assert.equal(f.key('Enter').prevented, 1); assert.deepEqual(f.calls, ['sat:1']); assert.equal(f.popup.children.length, 0);
});

test('typing clears stale actionable options before awaiting the new parse', async () => {
  const pending = deferred(); const f = suggestionsFixture(value => value === '2' ? pending.promise : Promise.resolve(parsed(value)));
  f.input.value = '1'; await f.updateSuggestions();
  f.input.value = '2'; const work = f.updateSuggestions();
  assert.equal(f.popup.children.length, 0); assert.equal(f.model.suggestionIndex, -1);
  f.chooseSuggestion(); assert.deepEqual(f.calls, ['2'], 'Enter uses current text, not the preceding suggestion');
  pending.resolve(parsed('2')); await work;
  assert.equal(f.popup.children.length, 0, 'late reply after navigation must not reopen the popup');
});

for (const settlement of ['resolve', 'reject']) test(`stale ${settlement} cannot replace a newer suggestion publication`, async () => {
  const old = deferred(); const f = suggestionsFixture(value => value === 'old' ? old.promise : Promise.resolve(parsed(value)));
  f.input.value = 'old'; const work = f.updateSuggestions();
  f.input.value = 'new'; await f.updateSuggestions(); const selectedId = f.input.getAttribute('aria-activedescendant');
  old[settlement](settlement === 'resolve' ? parsed('old') : new Error('fixture failure')); await work;
  assert.equal(f.popup.children[0].dataset.canonical, 'sat:new'); assert.equal(f.input.getAttribute('aria-activedescendant'), selectedId);
});

for (const changed of ['close', 'tab', 'blur', 'text']) test(`pending suggestion respects ${changed} ownership changes`, async () => {
  const pending = deferred(); const f = suggestionsFixture(() => pending.promise);
  f.input.value = '1'; const work = f.updateSuggestions();
  if (changed === 'close') f.closeSuggestions();
  if (changed === 'tab') f.model.activeTabId = 'b';
  if (changed === 'blur') f.input.blur();
  if (changed === 'text') f.input.value = '2';
  pending.resolve(parsed('1')); await work;
  assert.equal(f.popup.children.length, 0); assert.equal(f.input.getAttribute('aria-expanded'), 'false');
});

test('a stale ArrowUp continuation cannot move a newer popup selection', async () => {
  const old = deferred(); const f = suggestionsFixture(value => value === 'old' ? old.promise : Promise.resolve(parsed(value, [parsed('alternative')])));
  f.input.value = 'old'; f.key('ArrowUp');
  f.input.value = 'new'; await f.updateSuggestions();
  old.reject(new Error('fixture stale request')); await tick(); assert.equal(f.model.suggestionIndex, 0);
  f.closeSuggestions(); f.key('ArrowUp'); await tick(); assert.equal(f.model.suggestionIndex, 1, 'opening with Up selects the last option');
});

test('old blur timers cannot dismiss a newer popup after refocus', async () => {
  const f = suggestionsFixture(); f.input.value = '1'; await f.updateSuggestions();
  f.input.blur(); f.input.listeners.blur(); f.input.focus(); await f.updateSuggestions();
  f.timers.shift()(); assert.equal(f.input.getAttribute('aria-expanded'), 'true');
  f.input.blur(); f.input.listeners.blur(); f.timers.shift()(); assert.equal(f.input.getAttribute('aria-expanded'), 'false');
});

test('suggestions are bounded, deduplicated, text-only and clearly scoped to saved items', async () => {
  const f = suggestionsFixture(async () => { throw new Error('fixture'); });
  f.input.value = '<img>';
  f.model.bookmarks = Array.from({ length: 12 }, (_, i) => ({ canonical: `sat:${i}`, title: `<img> ${i}` }));
  f.model.history = [...f.model.bookmarks]; await f.updateSuggestions();
  assert.equal(f.popup.children.length, 9); assert.equal(f.popup.querySelectorAll('img').length, 0);
  assert.match(f.popup.children[0].textContent, /On this device · history and bookmarks/);
  assert.equal(new Set(f.popup.children.map(node => node.dataset.canonical)).size, 9);
  const down = event(''); f.popup.children[1].listeners.mousedown(down); assert.equal(down.prevented, 1);
  f.popup.children[1].listeners.click(); assert.deepEqual(f.calls, ['sat:0']); assert.equal(f.popup.children.length, 0);
});

test('bootstrap and input bounds prevent suggestion IPC without changing normal navigation', async () => {
  const f = suggestionsFixture(); f.input.value = '1'; f.setReady(false);
  await f.updateSuggestions(); assert.equal(f.key('Enter').prevented, 0); assert.deepEqual(f.parseCalls, []); assert.deepEqual(f.calls, []);
  f.setReady(true);
  for (const value of ['', '  ', 'x'.repeat(4097)]) { f.input.value = value; await f.updateSuggestions(); }
  assert.deepEqual(f.parseCalls, []);
  f.input.value = 'x'.repeat(4096); await f.updateSuggestions(); assert.equal(f.parseCalls.length, 1);
});

function tabsFixture() {
  document.activeElement = null;
  const model = { activeTabId: 'a', tabs: [{ id: 'a', title: 'Start' }, { id: 'b', title: 'Inscription' }], results: {} };
  const elements = { tabs: h('div') }; const switches = [], closes = [], timers = [];
  const renderTabs = vm.runInNewContext(`(${section('function renderTabs()', '\nfunction routeName()')})`, {
    state: () => model, elements, document, h, clear, targetIcon: () => '·',
    switchTab: id => { switches.push(id); model.activeTabId = id; }, closeTab: id => closes.push(id), setTimeout: callback => timers.push(callback)
  });
  renderTabs(); return { model, tabs: elements.tabs, renderTabs, switches, closes, timers };
}

test('passive tab publication preserves DOM, keyboard focus and scroll position', () => {
  const f = tabsFixture(); const tab = f.tabs.children[0]; const close = tab.querySelector('button'); close.focus();
  f.tabs.scrollLeft = 173; f.model.results.a = { target: { kind: 'sat' } }; f.renderTabs();
  const replacement = f.tabs.children[0]; assert.notEqual(replacement, tab); assert.equal(document.activeElement, replacement.querySelector('button'));
  f.model.cache = { bytes: 123 }; f.renderTabs();
  assert.equal(f.tabs.children[0], replacement); assert.equal(document.activeElement, replacement.querySelector('button')); assert.equal(f.tabs.scrollLeft, 173);
});

test('tab labels, selected state and close buttons remain accessible; active changes scroll into view', () => {
  const f = tabsFixture();
  assert.equal(f.tabs.children[0].getAttribute('aria-label'), 'Start'); assert.equal(f.tabs.children[1].getAttribute('title'), 'Inscription');
  assert.deepEqual(f.tabs.children.map(node => node.getAttribute('aria-selected')), ['true', 'false']);
  assert.deepEqual(f.tabs.children.map(node => node.querySelector('button').getAttribute('tabindex')), ['0', '-1']);
  f.model.activeTabId = 'b'; f.renderTabs(); assert.equal(f.tabs.children[1].scrollCalls.length, 1);
  assert.equal(f.tabs.children[1].querySelector('button').getAttribute('aria-label'), 'Close Inscription');
});

test('close-button keyboard events are not swallowed by the surrounding tab', () => {
  const f = tabsFixture(); const tab = f.tabs.children[0], close = tab.querySelector('button');
  for (const key of ['Enter', ' ']) {
    const e = event(key, { target: close, currentTarget: tab }); tab.listeners.keydown(e); assert.equal(e.prevented, 0);
  }
  assert.deepEqual(f.switches, []);
  const click = event(''); close.listeners.click(click); assert.equal(click.stopped, 1); assert.deepEqual(f.closes, ['a']);
  const arrow = event('ArrowRight', { target: tab, currentTarget: tab }); tab.listeners.keydown(arrow);
  assert.equal(arrow.prevented, 1); assert.deepEqual(f.switches, ['b']);
  f.renderTabs(); f.timers.shift()(); assert.equal(document.activeElement, f.tabs.children[1]);
});

test('focused tab close falls back to the selected tab when its owner is removed', () => {
  const f = tabsFixture(); f.tabs.children[0].querySelector('button').focus();
  f.model.tabs.shift(); f.model.activeTabId = 'b'; f.renderTabs(); assert.equal(document.activeElement, f.tabs.children[0]);
});

test('sidebar preserves asset and local-setup navigation context', () => {
  let target;
  const routeName = vm.runInNewContext(`(${section('function routeName()', '\nfunction libraryPageNeedsRefresh')})`, { currentResult: () => ({ target }) });
  for (const kind of ['inscriptions', 'inscription', 'inscription-number', 'content', 'recursive']) { target = { kind }; assert.equal(routeName(), 'inscriptions'); }
  for (const kind of ['rune', 'runes']) { target = { kind }; assert.equal(routeName(), 'runes'); }
  target = { kind: 'internal', value: 'node-setup' }; assert.equal(routeName(), 'services');
  target = { kind: 'internal', value: 'ai' }; assert.equal(routeName(), 'ai');
  target = { kind: 'transaction' }; assert.equal(routeName(), null);
});

test('static shell has labelled collapsed-sidebar controls, a combobox and a skip target', () => {
  for (const control of html.match(/<button[^>]+data-route=[^>]+>/g)) { assert.match(control, /aria-label="[^"]+"/); assert.match(control, /title="[^"]+"/); }
  const input = html.match(/<input id="omnibox"[^>]+>/)[0];
  for (const attribute of ['role="combobox"', 'aria-expanded="false"', 'aria-controls="omnibox-suggestions"', 'maxlength="4096"']) assert.ok(input.includes(attribute));
  assert.match(html, /<button[^>]+data-command="skip-content"/);
  assert.match(html, /<main[^>]+id="main-stage"[^>]+tabindex="-1"/);
  assert.match(html, /href="\.\/release-ux\.css"/);
});

test('skip to content obeys bootstrap and modal boundaries', () => {
  const stage = h('main'), modal = h('div', { className: 'hidden' }), palette = h('div', { className: 'hidden' });
  const scope = { navigationReady: false, elements: { 'main-stage': stage, 'modal-backdrop': modal, 'palette-backdrop': palette }, reload() {}, toggleDeveloper() {}, openPalette() {} };
  const executeCommand = vm.runInNewContext(`(${section('function executeCommand(', '\nfunction handleShellDeepLink')})`, scope);
  document.activeElement = null; executeCommand('skip-content'); assert.equal(document.activeElement, null);
  scope.navigationReady = true; executeCommand('skip-content'); assert.equal(document.activeElement, stage);
  for (const overlay of [modal, palette]) {
    document.activeElement = null; overlay.classList.remove('hidden'); executeCommand('skip-content'); assert.equal(document.activeElement, null); overlay.classList.add('hidden');
  }
});

test('generic loading explains the wait and offers navigation without starting extra requests', () => {
  const calls = []; const root = renderLoading({ target: { display: 'Block 840000', canonical: 'block:840000' } }, { navigate: target => calls.push(target) });
  assert.match(root.textContent, /Getting this record/); assert.match(root.querySelector('[role="status"]').textContent, /another tab/);
  assert.equal(root.querySelector('.loading-grid').getAttribute('aria-hidden'), 'true'); assert.deepEqual(calls, []);
  button(root, 'Search something else').listeners.click(); assert.deepEqual(calls, ['satnav://home']);
});

test('error recovery retains diagnostics in a closed, text-only disclosure and keeps explicit retry', () => {
  const calls = []; let retries = 0;
  const root = renderError({ code: 'NOT_FOUND', message: '<img> fixture', details: { fixture: '<script>ignored</script>' } }, { display: 'Sat 1' }, { model: { settings: {} }, navigate: target => calls.push(target), retry: () => retries++ });
  assert.match(root.querySelector('h1').textContent, /No result from this data source/);
  const technical = root.querySelector('details'); assert.equal(technical.open, false); assert.match(technical.textContent, /NOT_FOUND: <img> fixture/);
  assert.match(technical.querySelector('pre').textContent, /<script>ignored/); assert.equal(root.querySelector('img'), null); assert.equal(root.querySelector('script'), null);
  assert.deepEqual(calls, []); assert.equal(retries, 0);
  button(root, 'Retry').listeners.click(); assert.equal(retries, 1);
  button(root, 'Review data sources').listeners.click(); button(root, 'Back to Start').listeners.click(); assert.deepEqual(calls, ['satnav://providers', 'satnav://home']);
});

test('generic record foregrounds key details without losing raw data, provenance or identifiers', () => {
  const calls = []; const result = { target: { kind: 'sat', canonical: 'sat:1', display: 'Sat 1' }, entity: { canonical: 'sat:1', summary: { number: 1 }, source: { name: 'Fixture source' } } };
  const root = renderEntity(result, { isBookmarked: () => false, copy: value => calls.push(value), openDeveloper: tab => calls.push(tab) });
  assert.match(root.textContent, /Key details/); assert.match(root.textContent, /Data sourceSNAPSHOT/);
  assert.match(root.textContent, /not an independent verification/); assert.doesNotMatch(root.textContent, /VERIFIABLE|undefined ms|1 source attempt/);
  assert.equal(root.querySelector('details').open, false);
  button(root, '⧉Copy identifier').listeners.click(); button(root, 'Open raw data').listeners.click(); button(root, 'View attempts').listeners.click();
  assert.deepEqual(calls, ['sat:1', 'raw', 'requests']);
});

test('real page dispatch uses a loading record, while galleries, previews and local search keep their own views', () => {
  const model = { bootstrap: {}, activeTabId: 'a', loading: { a: true } }; let result;
  const elements = { page: h('div'), 'main-stage': h('main') }; const scope = { state: () => model, currentResult: () => result, elements, context: {}, clear, updateInscriptions: () => false, updateRunes: () => false };
  for (const view of ['Loading', 'Entity', 'Error', 'Search', 'Inscriptions', 'Runes', 'Inscription']) scope[`render${view}`] = () => h('div', { text: view });
  const renderPage = vm.runInNewContext(`(${section('function renderPage()', '\nfunction renderDrawer()')})`, scope);
  for (const [kind, expected] of [['block', 'Loading'], ['address', 'Loading'], ['search', 'Search'], ['inscriptions', 'Inscriptions'], ['rune', 'Runes'], ['inscription', 'Inscription']]) {
    result = { target: { kind } }; renderPage(); assert.equal(elements.page.textContent, expected);
  }
  result = { target: { kind: 'block' }, entity: {} }; renderPage(); assert.equal(elements.page.textContent, 'Entity');
  result.error = { code: 'NOT_FOUND' }; renderPage(); assert.equal(elements.page.textContent, 'Error');
});
