import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOKUP_MODES, planLookup, renderLookup, searchSavedItems } from '../src/renderer/search.js';
import { renderHome, renderSearch } from '../src/renderer/views.js';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

const txid = 'ab'.repeat(32);
const inscription = `${txid}i0`;
const address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const entry = (canonical, title = canonical) => ({ canonical, title, kind: parseNavigationInput(canonical).kind });

test('explicit lookup types accept plain identifiers without requiring protocol syntax', () => {
  for (const [input, mode, target] of [
    ['12345', 'inscription', 'inscription:12345'], ['#-1', 'inscription', 'inscription:-1'],
    [inscription.toUpperCase(), 'inscription', `inscription:${inscription}`],
    ['840000', 'block', 'block:840000'], [txid.toUpperCase(), 'block', `block:${txid}`],
    [txid.toUpperCase(), 'transaction', `tx:${txid}`], [address, 'address', `address:${address}`],
    ['0', 'sat', 'sat:0'], ['satoshi', 'sat', 'sat:satoshi'], ['0°0′0″0‴', 'sat', 'sat:0°0′0″0‴']
  ]) assert.deepEqual(planLookup(` ${input} `, mode), { target, choices: [] });
});

test('explicit lookup types retain matching canonical/deep-link inputs and reject conflicting types', () => {
  assert.equal(planLookup('satnav://block/840000', 'block').target, 'block:840000');
  assert.equal(planLookup(`tx:${txid}`, 'transaction').target, `tx:${txid}`);
  for (const [input, mode] of [['sat:0', 'block'], ['#12345', 'transaction'], ['not an address', 'address'], ['tx:invalid', 'transaction']]) {
    assert.equal(planLookup(input, mode).target, undefined);
    assert.ok(planLookup(input, mode).error);
  }
});

test('auto mode exposes every integer/hash/name interpretation without choosing a destination', () => {
  for (const [input, canonicals] of [
    ['840000', ['sat:840000', 'block:840000', 'inscription:840000']],
    [txid, [`tx:${txid}`, `block:${txid}`]],
    ['satoshi', ['sat:satoshi', 'search:satoshi']]
  ]) {
    const plan = planLookup(input);
    assert.equal(plan.target, undefined);
    assert.deepEqual(plan.choices.map(item => item.canonical), canonicals);
  }
  assert.equal(planLookup('satoshi').choices[1].label, 'Search history and bookmarks');
});

test('auto lookup retains native exact routes, while unrecognized prose becomes saved-item search', () => {
  for (const input of [`${txid}:0`, `${txid}:0:1`, `content:${inscription}`, '/r/blockheight', 'rune:FOO', 'collection:art', '#12345', address]) {
    assert.equal(planLookup(input).target, parseNavigationInput(input).canonical);
  }
  assert.deepEqual(planLookup('orange pixel art'), { target: 'search:orange pixel art', choices: [] });
});

test('Bitcoin lookup does not dispatch web, payment or app navigation', () => {
  for (const input of ['https://example.test/', `bitcoin:${address}`, 'web:https://example.test/', 'satnav://settings', 'home', 'satnav://home']) {
    const plan = planLookup(input);
    assert.equal(plan.target, undefined);
    assert.match(plan.error, /address bar/);
  }
});

test('saved mode always treats input as text, even when it looks like a link or identifier', () => {
  for (const input of ['840000', '#12345', 'https://example.test/', `bitcoin:${address}`, 'satnav://settings']) {
    assert.deepEqual(planLookup(input, 'saved'), { target: `search:${input}`, choices: [] });
  }
});

test('empty, oversized, non-string, invalid-mode and malformed explicit input fail inline', () => {
  for (const input of ['', '  ', null, 3, {}, 'a'.repeat(2049)]) {
    assert.ok(planLookup(input).error);
    assert.equal(planLookup(input).target, undefined);
  }
  assert.ok(planLookup('sat:0', '__proto__').error);
  assert.ok(planLookup('block:not a block').error);
  assert.equal(planLookup('a'.repeat(2048), 'saved').target.length, 2055);
  assert.ok(Object.isFrozen(LOOKUP_MODES) && LOOKUP_MODES.every(Object.isFrozen));
});

test('saved matching is case-insensitive, multi-term, bookmark-first and exact-canonical deduplicated', () => {
  const model = {
    bookmarks: [entry('sat:1', 'Orange Pixel Art'), entry('sat:10', 'Orange pixels'), entry('sat:100', 'Blue Art')],
    history: [entry('sat:1', 'Orange pixel'), entry('sat:2', 'Pixel Orange')]
  };
  const before = JSON.stringify(model);
  assert.deepEqual(searchSavedItems(model, '  PIXEL   orange '), {
    items: [
      { ...entry('sat:1', 'Orange Pixel Art'), origins: ['Bookmark', 'History'] },
      { ...entry('sat:10', 'Orange pixels'), origins: ['Bookmark'] },
      { ...entry('sat:2', 'Pixel Orange'), origins: ['History'] }
    ], total: 3
  });
  assert.equal(JSON.stringify(model), before);
  assert.deepEqual(searchSavedItems(model, 'sat:100').items.map(item => item.canonical), ['sat:100']);
  assert.deepEqual(searchSavedItems(model, 'missing'), { items: [], total: 0 });
});

test('saved matching omits self-searches, malformed routes and external/payment targets but retains app bookmarks', () => {
  const model = { bookmarks: [
    null, {}, { canonical: '' }, { canonical: ' ' }, { canonical: 'a'.repeat(2049) },
    { canonical: 'block:nope' }, { canonical: 'not a canonical' },
    entry('search:art'), entry('https://example.test/'), entry(`bitcoin:${address}`),
    entry('satnav://settings', 'My settings'), { canonical: 'sat:42', kind: 'incorrect', title: 12 }
  ], history: 'malformed' };
  assert.deepEqual(searchSavedItems(model, ''), {
    items: [
      { ...entry('satnav://settings', 'My settings'), origins: ['Bookmark'] },
      { ...entry('sat:42'), origins: ['Bookmark'] }
    ], total: 2
  });
  assert.deepEqual(searchSavedItems(null, ''), { items: [], total: 0 });
});

test('saved matching bounds rendered rows, source entries and title size while reporting the matched total', () => {
  const bookmarks = Array.from({ length: 10001 }, (_, i) => entry(`sat:${i}`, i === 10000 ? 'beyond bound' : `Saved ${i}`));
  const result = searchSavedItems({ bookmarks }, 'Saved');
  assert.equal(result.total, 10000);
  assert.equal(result.items.length, 30);
  assert.equal(result.items[0].canonical, 'sat:0');
  assert.equal(result.items[29].canonical, 'sat:29');
  assert.deepEqual(searchSavedItems({ bookmarks }, 'beyond bound'), { items: [], total: 0 });
  assert.equal(searchSavedItems({ bookmarks: [entry('sat:0', 'x'.repeat(3000))] }, '').items[0].title.length, 2048);
});

// Actual views and DOM helpers, with only DOM operations represented by a bounded
// collaborator. No claim is made about browser layout, native form default actions,
// screen-reader output, or operating-system focus behavior.
class TestNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag.toUpperCase(); this._text = text; this.children = [];
    this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {};
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentElement = null;
    this.children = []; this._text = ''; this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { documentStub.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? (node.className ?? '').split(/\s+/).includes(selector.slice(1)) : node.tagName === selector.toUpperCase();
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const documentStub = {
  activeElement: null, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text))
};
globalThis.Node = TestNode;
globalThis.document = documentStub;
const controls = form => ({
  input: form.querySelector('input'), select: form.querySelector('select'),
  example: form.querySelectorAll('button').find(node => node.textContent === 'Try an example'),
  error: form.querySelector('.lookup-error'), choices: form.querySelector('.lookup-choices')
});
function submit(form) {
  let prevented = 0;
  form.listeners.submit({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
}
function model() { return { settings: { ...DEFAULT_SETTINGS }, providers: [], cache: {}, history: [], bookmarks: [] }; }

test('lookup form has distinct bound labels, help/error associations, a named search landmark and one submit control', () => {
  const form = renderLookup({ navigate() {} });
  const other = renderLookup({ navigate() {} });
  const { input, select, error, choices } = controls(form);
  assert.equal(form.attributes.role, 'search');
  assert.match(form.attributes['aria-label'], /Bitcoin/);
  assert.deepEqual(form.querySelectorAll('label').map(node => node.htmlFor), [select.attributes.id, input.attributes.id]);
  assert.equal(input.attributes['aria-describedby'], `${input.attributes.id}-help ${error.attributes.id}`);
  assert.equal(input.attributes.maxlength, '2048');
  assert.equal(input.attributes['aria-invalid'], 'false');
  assert.equal(error.attributes.role, 'alert');
  assert.equal(choices.attributes.role, 'group');
  assert.equal(choices.attributes['aria-label'], 'Choose what to open');
  assert.notEqual(input.attributes.id, controls(other).input.attributes.id);
  assert.deepEqual(form.querySelectorAll('button').filter(node => node.attributes.type === 'submit').map(node => node.textContent), ['Look up']);
  assert.equal(input.listeners.keydown, undefined, 'native form submission is not duplicated by a keydown handler');
});

test('empty/invalid UI submissions never navigate; edit clears the error and an explicit type submits once', () => {
  const calls = [];
  const form = renderLookup({ navigate: target => calls.push(target) });
  const { input, select, error } = controls(form);
  submit(form);
  assert.deepEqual(calls, []);
  assert.match(error.textContent, /Enter an identifier/);
  assert.equal(input.attributes['aria-invalid'], 'true');
  assert.equal(documentStub.activeElement, input);
  input.value = '840000'; input.listeners.input();
  assert.equal(error.textContent, '');
  assert.equal(input.attributes['aria-invalid'], 'false');
  select.value = 'block'; select.listeners.change();
  submit(form);
  assert.deepEqual(calls, ['block:840000']);
});

test('ambiguous UI submission presents focused choices and navigates only on explicit selection', () => {
  const calls = [];
  const form = renderLookup({ navigate: target => calls.push(target) }, { query: '840000' });
  const { choices, input } = controls(form);
  submit(form);
  assert.deepEqual(calls, []);
  const buttons = choices.querySelectorAll('button');
  assert.equal(buttons.length, 3);
  assert.equal(documentStub.activeElement, buttons[0]);
  buttons[1].listeners.click();
  assert.deepEqual(calls, ['block:840000']);
  input.value = '840001'; input.listeners.input();
  assert.deepEqual(choices.children, []);
});

test('example helpers fill and select input without navigation; changing type updates help and removes stale choices', () => {
  const calls = [];
  const form = renderLookup({ navigate: target => calls.push(target) }, { query: '840000' });
  const { input, select, example, choices } = controls(form);
  submit(form);
  select.value = 'inscription'; select.listeners.change();
  assert.match(form.querySelector('.help').textContent, /Ordinals data source/);
  assert.deepEqual(choices.children, []);
  example.listeners.click();
  assert.equal(input.value, '#12345');
  assert.equal(documentStub.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 6]);
  assert.deepEqual(calls, []);
  select.value = 'saved'; select.listeners.change();
  assert.equal(example.disabled, true);
  assert.match(form.querySelector('.help').textContent, /on this device/);
  example.listeners.click();
  assert.equal(input.value, '#12345');
});

test('UI refuses unrelated links in auto mode but saved mode searches the literal text', () => {
  const calls = [];
  const form = renderLookup({ navigate: target => calls.push(target) }, { query: 'https://example.test/' });
  submit(form);
  assert.deepEqual(calls, []);
  assert.match(controls(form).error.textContent, /address bar/);
  controls(form).select.value = 'saved'; controls(form).select.listeners.change();
  submit(form);
  assert.deepEqual(calls, ['search:https://example.test/']);
});

test('Home exposes guided lookup, honest source/privacy wording and existing quick navigation', () => {
  const calls = [];
  const view = renderHome(model(), { navigate: target => calls.push(target) });
  assert.equal(view.querySelector('h1').textContent, 'A whole world. Built on Bitcoin.');
  assert.equal(view.querySelectorAll('form').length, 1);
  assert.match(view.textContent, /Exact lookups use your configured data sources/);
  assert.match(view.textContent, /saved-item search stays on this device/);
  const chips = view.querySelectorAll('.chip');
  assert.equal(chips.length, 5);
  chips[0].listeners.click();
  assert.deepEqual(calls, ['sat:0']);
});

test('saved results render escaped matching text, provenance, navigation and explicit refresh without auto navigation', () => {
  const calls = [];
  const current = model();
  current.bookmarks = [entry('sat:1', '<img onerror=fixture> Orange Art')];
  current.history = [entry('sat:1', 'Orange Art'), entry('search:Orange')];
  const ctx = { model: current, navigate: (...args) => calls.push(args) };
  const view = renderSearch({ target: parseNavigationInput('search:Orange') }, ctx);
  assert.deepEqual(calls, []);
  assert.match(view.textContent, /No query is sent to a search service/);
  assert.match(view.textContent, /Explore the inscription gallery/);
  assert.match(view.textContent, /Global keyword search is not available/);
  assert.match(view.textContent, /1 matching item\./);
  assert.equal(view.querySelectorAll('img').length, 0);
  assert.match(view.textContent, /<img onerror=fixture>/);
  const rows = view.querySelectorAll('.list-row');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Bookmark · History/);
  rows[0].listeners.click();
  view.querySelectorAll('button').find(node => node.textContent === 'Refresh results').listeners.click();
  assert.deepEqual(calls, [['sat:1'], ['search:Orange', { record: false }]]);
  current.bookmarks = []; current.history = [];
  assert.equal(view.querySelectorAll('.list-row').length, 1, 'results are an explicit-refresh snapshot');
  const refreshed = renderSearch({ target: parseNavigationInput('search:Orange') }, ctx);
  assert.match(refreshed.textContent, /No saved matches/);
});

test('saved result view explains row limits and connects empty results to sources and help', () => {
  const current = model();
  current.history = Array.from({ length: 35 }, (_, i) => entry(`sat:${i}`, 'Orange'));
  const calls = [];
  const ctx = { model: current, navigate: (...args) => calls.push(args) };
  const view = renderSearch({ target: parseNavigationInput('search:Orange') }, ctx);
  assert.match(view.textContent, /35 matching items; showing the first 30/);
  assert.equal(view.querySelectorAll('.list-row').length, 30);
  const empty = renderSearch({ target: parseNavigationInput('search:unseen') }, ctx);
  assert.match(empty.textContent, /Try a shorter phrase/);
  for (const label of ['Data sources', 'Lookup help']) empty.querySelectorAll('button').find(node => node.textContent === label).listeners.click();
  assert.deepEqual(calls, [['satnav://providers'], ['satnav://documentation']]);
});
