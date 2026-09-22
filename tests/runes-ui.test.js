import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderRunes, updateRunes, runeSearchPlan } from '../src/renderer/runes.js';
import { parseNavigationInput } from '../src/shared/navigation.js';
import { runeFromHtml } from '../src/main/providers/ord-runes.js';
import { clear } from '../src/renderer/dom.js';

// Real view functions with a bounded DOM collaborator, not layout/a11y certification.
class TestNode {
  constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this._text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.value = ''; this.classList = { toggle() {} }; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { document.activeElement = this; }
  querySelectorAll(selector) { const matches = node => selector.startsWith('.') ? (node.className ?? '').split(/\s+/).includes(selector.slice(1)) : selector.startsWith('[data-') ? Object.hasOwn(node.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())) : node.tagName === selector.toUpperCase(); return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { activeElement: null, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const html = JSON.parse(fs.readFileSync(new URL('./fixtures/runes-public-html.json', import.meta.url), 'utf8'));
const rune = runeFromHtml(html[1].body, '1:0');
const source = { source: { name: 'Test Ord' }, network: 'mainnet', fetchedAt: '2026-09-09T01:00:00Z' };
function fixture({ target = 'satnav://runes', data = { items: [{ name: 'ALPHA' }, { name: 'BETA•TOKEN' }], next: 'satnav://runes?page=1' }, error, loading = false, offline = false } = {}) {
  const calls = [], retries = [], copies = [], bookmarks = [];
  const ctx = { model: { activeTabId: 'tab-a', settings: { offlineMode: offline, network: 'mainnet' } }, navigate: (...args) => calls.push(args), retry: () => retries.push(true), copy: value => copies.push(value), isBookmarked: () => false, toggleBookmark: () => bookmarks.push(true) };
  const result = { target: parseNavigationInput(target), ...(error ? { error } : loading ? {} : { entity: { ...source, data } }) };
  return { root: renderRunes(result, ctx), result, ctx, calls, retries, copies, bookmarks };
}
const control = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
function submit(form) { let count = 0; form.listeners.submit({ preventDefault() { count++; } }); assert.equal(count, 1); }

test('Rune search accepts names, spaces, IDs and links without opening a remote website', () => {
  for (const [input, canonical] of [['uncommon goods', 'UNCOMMON•GOODS'], ['1:0', '1:0'], ['rune:TEST.RUNE', 'TEST•RUNE'], ['https://ordinals.com/rune/UNCOMMON%E2%80%A2GOODS', 'UNCOMMON•GOODS'], ['satnav://rune/TEST', 'TEST']]) assert.equal(runeSearchPlan(input).target, `rune:${canonical}`);
  for (const input of ['', 'x'.repeat(2049), 'https://user:pass@ordinals.com/rune/TEST', 'https://example.com/', 'javascript:alert(1)', '<img>', null, 'rune:1:4294967296']) assert.ok(runeSearchPlan(input).error);
});

test('accessible Rune form binds labels, validates inline and submits once', () => {
  const f = fixture(); const form = f.root.querySelector('form'); const input = form.querySelector('input');
  assert.equal(form.attributes['aria-label'], 'Find a Rune');
  assert.equal(form.querySelector('label').htmlFor, input.attributes.id);
  assert.equal(input.attributes['aria-describedby'], `${input.attributes.id}-help ${input.attributes.id}-error`);
  input.value = 'bad/target'; submit(form); assert.deepEqual(f.calls, []); assert.equal(document.activeElement, input);
  assert.equal(input.attributes['aria-invalid'], 'true');
  input.value = 'uncommon goods'; input.listeners.input(); submit(form);
  assert.equal(input.attributes['aria-invalid'], 'false'); assert.deepEqual(f.calls, [['rune:UNCOMMON•GOODS']]);
});

test('page filters are local, retain focus and drafts, and recover from empty matches', () => {
  const f = fixture(); const form = f.root.querySelector('form'); form.querySelector('input').value = 'draft';
  const filter = f.root.querySelector('.rune-page-filter').querySelector('input'); filter.value = 'beta token'; filter.focus(); filter.listeners.input();
  assert.equal(f.root.querySelectorAll('.rune-card').length, 1); assert.equal(document.activeElement, filter); assert.deepEqual(f.calls, []);
  assert.equal(f.root.querySelector('form'), form); assert.equal(form.querySelector('input').value, 'draft');
  filter.value = 'missing'; filter.listeners.input(); assert.match(f.root.textContent, /No matching names/);
  control(f.root, 'Clear filter').listeners.click(); assert.equal(filter.value, ''); assert.equal(f.root.querySelectorAll('.rune-card').length, 2);
  f.root.querySelector('.rune-card').listeners.click(); assert.deepEqual(f.calls, [['rune:ALPHA']]);
});

test('listing ignores duplicate and invalid names, bounds results and never embeds source markup', () => {
  const f = fixture({ data: { items: [{ name: 'ALPHA' }, { name: 'ALPHA' }, { name: '<script>' }, { name: 'ALPHA', symbol: '<img>' }] } });
  assert.equal(f.root.querySelectorAll('.rune-card').length, 1);
  for (const tag of ['script', 'iframe', 'video', 'audio']) assert.equal(f.root.querySelectorAll(tag).length, 0);
  assert.equal(f.root.querySelector('.rune-results').querySelectorAll('img').length, 0);
  assert.equal(f.root.querySelectorAll('.popular-logo').length, 3);
  assert.ok(f.root.querySelectorAll('img').every(image => /^data:image\/(?:png|webp);base64,/.test(image.attributes.src)));
  const many = fixture({ data: { items: Array.from({ length: 110 }, (_, i) => ({ name: `RUNE${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}` })) } });
  assert.equal(many.root.querySelectorAll('.rune-card').length, 100);
});

test('pagination accepts only exact sequential app routes', () => {
  const f = fixture(); control(f.root, 'Older →').listeners.click(); assert.deepEqual(f.calls, [['satnav://runes?page=1']]);
  assert.equal(control(f.root, '← Newer').disabled, true);
  for (const next of ['https://evil.example', 'satnav://runes?page=8', 'satnav://runes?page=1&address=x']) {
    const bad = fixture({ data: { items: [], next } }); assert.equal(control(bad.root, 'Older →').disabled, true);
    control(bad.root, 'Older →').listeners.click(); assert.deepEqual(bad.calls, []);
  }
});

test('loading, offline miss, source failure and empty states retain search and retry', () => {
  for (const options of [{ loading: true }, { error: { code: 'NO_PROVIDER' } }, { offline: true, error: { code: 'OFFLINE_CACHE_MISS' } }, { data: { items: [] } }]) {
    const f = fixture(options); assert.ok(f.root.querySelector('form'));
    if (options.error) { control(f.root, 'Try again').listeners.click(); assert.equal(f.retries.length, 1); assert.deepEqual(f.calls, []); }
    if (options.loading) assert.equal(f.root.querySelector('.rune-results').attributes['aria-busy'], 'true');
    if (options.offline) assert.match(f.root.textContent, /unavailable offline/);
  }
});

test('detail shows exact supply, mint rules, source and predefined origin without fake creation links', () => {
  const f = fixture({ target: 'rune:UNCOMMON•GOODS', data: rune });
  assert.match(f.root.textContent, /147,660,605/); assert.match(f.root.textContent, /147,684,423/);
  assert.match(f.root.textContent, /340,282,366,920,938,463,463,374,607,431,768,211,455/);
  assert.match(f.root.textContent, /Predefined by the Runes protocol/); assert.doesNotMatch(f.root.querySelector('.rune-facts').textContent, /1970/);
  assert.match(f.root.textContent, /Mint open at retrieval/); assert.match(f.root.textContent, /Test Ord · mainnet/);
  assert.equal(control(f.root, 'Creation transaction'), undefined);
  control(f.root, 'Copy Rune ID').listeners.click(); assert.deepEqual(f.copies, ['1:0']);
  f.root.querySelectorAll('button').find(node => node.attributes['aria-label'] === 'Toggle bookmark').listeners.click(); assert.equal(f.bookmarks.length, 1);
  assert.match(f.root.textContent, /do not provide market prices/);
});

test('normal creation links remain native and technical fields are progressively disclosed', () => {
  const txid = 'a'.repeat(64);
  const f = fixture({ target: 'rune:TEST', data: { ...rune, name: 'TEST', id: '840000:2', block: '840000', predefined: false, etching: txid, parent: `${txid}i0` } });
  for (const label of ['Creation transaction', 'Block 840,000', 'Linked inscription']) control(f.root, label).listeners.click();
  assert.deepEqual(f.calls, [[`tx:${txid}`], ['block:840000'], [`inscription:${txid}i0`]]);
  assert.equal(f.root.querySelector('.rune-technical').tagName, 'DETAILS');
});

test('detail distinguishes fixed supply, unknown mint state and cached snapshots', () => {
  const fixed = fixture({ target: 'rune:TEST', data: { ...rune, name: 'TEST', terms: null, mintable: false } });
  assert.match(fixed.root.textContent, /Fixed supply/); assert.match(fixed.root.textContent, /No public mint was defined/);
  const unknown = fixture({ target: 'rune:TEST', data: { ...rune, name: 'TEST', mintable: null }, offline: true });
  assert.match(unknown.root.textContent, /Mint status unavailable/); assert.match(unknown.root.textContent, /Cached snapshot/);
});

const collectorRune = { ...rune, name: 'COLLECTOR', premine: '10000', supply: '12500', outstanding: '12400', burned: '100', mints: '25', divisibility: 2,
  terms: { ...rune.terms, amount: '100', cap: '100' }, maximum: '20000', mintable: false };

test('Rune detail explains cap progress, exact unissued units, premine share and burns without implying an open mint', () => {
  const f = fixture({ target: 'rune:COLLECTOR', data: collectorRune });
  const insights = f.root.querySelector('.rune-insights');
  assert.match(insights.textContent, /Mint progress25.00%/); assert.match(insights.textContent, /75 mint slots remain/);
  assert.match(insights.textContent, /Initial allocation share50.00%/); assert.match(insights.textContent, /Burned share0.80%/);
  assert.match(insights.textContent, /does not mean the mint is open/); assert.match(insights.textContent, /not the creator’s current holdings/);
  assert.match(f.root.textContent, /Mint not open at retrieval/);
  assert.match(f.root.textContent, /Units created by minting25/); assert.match(f.root.textContent, /Unissued units under the cap75/);
  const progress = insights.querySelector('progress'); assert.equal(progress.value, 2500); assert.equal(progress.attributes.max, '10000');
  assert.equal(progress.attributes['aria-valuetext'], '25.00% of the mint cap used'); assert.deepEqual(f.calls, []);
});

test('zero and fixed supply omit meaningless progress percentages and keep technical details', () => {
  const f = fixture({ target: 'rune:COLLECTOR', data: { ...collectorRune, terms: null, mints: '0', supply: '10000', outstanding: '10000', burned: '0' } });
  assert.match(f.root.querySelector('.rune-insights').textContent, /Fixed at creation.*Initial allocation share100%/);
  assert.equal(f.root.querySelector('progress'), null); assert.ok(f.root.querySelector('.rune-technical'));
  const empty = fixture({ target: 'rune:COLLECTOR', data: { ...collectorRune, terms: { amount: null, cap: null }, mints: '0', supply: '0', premine: '0', outstanding: '0', burned: '0' } });
  assert.match(empty.root.querySelector('.rune-insights').textContent, /No mint capacity.*Initial allocation shareUnavailable.*No supply created/);
  assert.equal(empty.root.querySelector('progress'), null);
});

test('Rune listing filters combine names and snapshot mint states with honest name-only unknowns', () => {
  const f = fixture({ data: { items: [
    { ...collectorRune, name: 'ALPHA', mintable: true }, { ...collectorRune, name: 'BETA', mintable: false },
    { ...collectorRune, name: 'GAMMA', terms: null, mints: '0', supply: '10000', outstanding: '10000', burned: '0' }, { name: 'DELTA' }
  ] } });
  const select = f.root.querySelector('.rune-mint-filter').querySelector('select'), name = f.root.querySelector('.rune-page-filter').querySelector('input');
  assert.equal(f.root.querySelector('.rune-mint-filter').querySelector('label').htmlFor, select.attributes.id);
  assert.match(f.root.querySelector('.rune-card').textContent, /Available supply: 124.*25.00% of mint cap used.*75 slots remaining/);
  select.value = 'unknown'; select.focus(); select.listeners.change();
  assert.equal(f.root.querySelectorAll('.rune-card').length, 1); assert.match(f.root.querySelector('.rune-card').textContent, /DELTA.*View supply & mint details/);
  assert.doesNotMatch(f.root.querySelector('.rune-card').textContent, /Fixed supply/); assert.equal(document.activeElement, select);
  select.value = 'open'; select.listeners.change(); assert.match(f.root.querySelector('.rune-card').textContent, /ALPHA/);
  name.value = 'beta'; name.listeners.input(); assert.equal(f.root.querySelectorAll('.rune-card').length, 0);
  control(f.root, 'Clear filter').listeners.click(); assert.equal(name.value, ''); assert.equal(select.value, 'all'); assert.equal(f.root.querySelectorAll('.rune-card').length, 4);
  for (const [state, expected] of [['closed', 'BETA'], ['fixed', 'GAMMA']]) { select.value = state; select.listeners.change(); assert.equal(f.root.querySelectorAll('.rune-card').length, 1); assert.match(f.root.querySelector('.rune-card').textContent, new RegExp(expected)); }
  assert.deepEqual(f.calls, []);
});

test('same-snapshot publications retain Rune disclosures and focus while updating bookmarks', () => {
  const f = fixture({ target: 'rune:COLLECTOR', data: collectorRune });
  const technical = f.root.querySelector('.rune-technical'); technical.open = true;
  const copy = control(f.root, 'Copy Rune ID'); copy.focus();
  const bookmark = f.root.querySelector('[data-bookmark-control]');
  f.ctx.model.bookmarks = [{ canonical: f.result.target.canonical }];
  assert.equal(updateRunes(f.root, { ...f.result }, f.ctx), true);
  assert.equal(f.root.querySelector('.rune-technical'), technical); assert.equal(technical.open, true); assert.equal(document.activeElement, copy);
  assert.equal(bookmark.attributes['aria-pressed'], 'true'); assert.match(bookmark.textContent, /Bookmarked/);
  f.ctx.model.settings.offlineMode = true; updateRunes(f.root, { ...f.result }, f.ctx);
  assert.match(f.root.querySelector('.rune-source').textContent, /Cached snapshot/);
});

test('actual app publication retains Rune search/filter state, focus and scroll through delayed results', () => {
  const f = fixture({ loading: true });
  const page = new TestNode('div'); const stage = new TestNode('main');
  let result = f.result; f.ctx.model.bootstrap = true;
  const sourceText = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const code = sourceText.slice(sourceText.indexOf('function renderPage() {'), sourceText.indexOf('\nfunction renderDrawer()', sourceText.indexOf('function renderPage() {')));
  const sandbox = { state: () => f.ctx.model, currentResult: () => result, elements: { page, 'main-stage': stage }, context: f.ctx, renderRunes, updateRunes, clear };
  vm.runInNewContext(`${code}\nthis.publish = renderPage;`, sandbox);
  sandbox.publish();
  const form = page.querySelector('form'); const input = form.querySelector('input'); input.value = 'partial'; input.focus(); stage.scrollTop = 80;
  result = { target: f.result.target, entity: { ...source, data: { items: [{ name: 'ALPHA' }] } } }; sandbox.publish();
  assert.equal(page.querySelector('form'), form); assert.equal(input.value, 'partial'); assert.equal(document.activeElement, input); assert.equal(stage.scrollTop, 80);
  const filter = page.querySelector('.rune-page-filter').querySelector('input'); filter.value = 'missing'; filter.listeners.input(); sandbox.publish();
  assert.match(page.textContent, /No matching names/); assert.equal(filter.value, 'missing');
  result = { target: f.result.target, error: { code: 'NO_PROVIDER' } }; sandbox.publish(); assert.equal(page.querySelector('form'), form);
  f.ctx.model.activeTabId = 'tab-b'; sandbox.publish(); assert.notEqual(page.querySelector('form'), form);
});

test('sidebar, palette, home and lookup remain Runes-only without a BRC-20 entry', () => {
  const index = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(index, /data-route="runes"/); assert.match(index, /\.\/runes\.css/); assert.doesNotMatch(index, /brc.?20/i);
  const app = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  assert.match(app, /id: 'runes', label: 'Explore Runes'/);
  const route = app.slice(app.indexOf('function routeName() {'), app.indexOf('\nfunction libraryPageNeedsRefresh'));
  for (const kind of ['rune', 'runes']) assert.equal(vm.runInNewContext(`${route}\nrouteName()`, { currentResult: () => ({ target: { kind } }) }), 'runes');
});
