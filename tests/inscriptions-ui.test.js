import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { inscriptionSearchPlan, renderInscriptions, updateInscriptions } from '../src/renderer/inscriptions.js';
import { clear } from '../src/renderer/dom.js';
import { renderHome } from '../src/renderer/views.js';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { discoveryTarget } from '../src/shared/discovery.js';

// Actual renderer + DOM helpers with a bounded DOM collaborator. These tests do
// not qualify browser layout, native keyboard defaults, or screen-reader output.
class TestNode {
  constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this._text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.value = ''; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { this.listeners.click?.(); }
  replaceWith(next) { const parent = this.parentElement; parent.children[parent.children.indexOf(this)] = next; next.parentElement = parent; this.parentElement = null; }
  focus() { document.activeElement = this; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  querySelectorAll(selector) { const matches = node => selector.startsWith('.') ? (node.className ?? '').split(/\s+/).includes(selector.slice(1)) : node.tagName === selector.toUpperCase(); return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { activeElement: null, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const id = n => `${n.toString(16).padStart(64, '0')}i0`;
const items = ['image/png', 'text/plain', 'text/html', 'audio/mpeg', 'video/mp4', 'image/svg+xml', 'image/png'].map((contentType, n) => ({ id: id(n), number: String(n), contentType, contentLength: n === 6 ? 3 * 1024 * 1024 : 512 }));
function fixture({ query = '', data = {}, error, loading = false, offline = false } = {}) {
  const calls = [];
  const retryCalls = [];
  const model = { settings: { ...DEFAULT_SETTINGS, offlineMode: offline }, bookmarks: [{ canonical: `inscription:${id(0)}` }], history: [], providers: [], cache: {} };
  const ctx = { model, navigate: (...args) => calls.push(args), retry: (...args) => retryCalls.push(args) };
  const result = { target: discoveryTarget(query), ...(error ? { error } : loading ? {} : { entity: { data: { items, next: 'satnav://inscriptions?offset=24', ...data }, source: { name: 'Test source' } } }) };
  return { view: renderInscriptions(result, ctx), result, calls, retryCalls, ctx, model };
}
function submit(form) { let count = 0; form.listeners.submit({ preventDefault() { count += 1; } }); assert.equal(count, 1); }
const control = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);

test('easy search accepts numbers, IDs and public links but never dispatches an external URL', () => {
  for (const [input, target] of [['#12345', 'inscription:12345'], ['#-1', 'inscription:-1'], ['0', 'inscription:0'], [id(1), `inscription:${id(1)}`], [`https://ord.io/${id(1)}?source=x`, `inscription:${id(1)}`], ['https://ordinals.com/inscription/42', 'inscription:42']]) {
    assert.equal(inscriptionSearchPlan(input).target, target);
  }
  for (const input of ['orange art', '', null, 'a'.repeat(2049), 'javascript:alert(1)', 'https://example.com/', 'https://user:pass@ordinals.com/inscription/1']) {
    assert.ok(inscriptionSearchPlan(input).error); assert.equal(inscriptionSearchPlan(input).target, undefined);
  }
});

test('search form has bound labels, unique help, one native submit and inline validation', () => {
  const f = fixture(); const form = f.view.querySelector('form'); const input = form.querySelector('input');
  assert.equal(form.attributes.role, 'search'); assert.equal(form.attributes['aria-label'], 'Find an inscription');
  assert.equal(form.querySelector('label').htmlFor, input.attributes.id);
  assert.equal(input.attributes['aria-describedby'], `${input.attributes.id}-help ${input.attributes.id}-error`);
  assert.notEqual(input.attributes.id, fixture().view.querySelector('input').attributes.id);
  assert.equal(form.querySelectorAll('button').filter(node => node.attributes.type === 'submit').length, 1);
  assert.equal(input.listeners.keydown, undefined);
  input.value = 'art'; submit(form); assert.deepEqual(f.calls, []); assert.equal(document.activeElement, input);
  assert.equal(input.attributes['aria-invalid'], 'true'); assert.match(form.textContent, /Name and collection-keyword search/);
  input.value = '#12345'; input.listeners.input(); assert.equal(input.attributes['aria-invalid'], 'false');
  assert.equal(form.querySelector('.lookup-error').textContent, ''); submit(form);
  assert.deepEqual(f.calls, [['inscription:12345']]);
});

test('gallery renders bounded raster previews only, inert provider text and canonical open actions', () => {
  const f = fixture({ data: { items: [...items, { ...items[0] }, { id: '<script>' }, { ...items[0], id: id(20), number: '<img onerror=x>', contentType: '<script>' }] } });
  const tiles = f.view.querySelectorAll('.inscription-tile'); assert.equal(tiles.length, 8);
  const results = f.view.querySelector('.inscription-results');
  const images = results.querySelectorAll('img'); assert.equal(images.length, 1);
  assert.equal(f.view.querySelectorAll('.popular-logo').length, 3);
  assert.equal(images[0].attributes.src, `ord://thumbnail/${id(0)}`);
  assert.equal(images[0].attributes.loading, 'lazy'); assert.equal(images[0].attributes.referrerpolicy, 'no-referrer');
  for (const tag of ['iframe', 'audio', 'video', 'script']) assert.equal(f.view.querySelectorAll(tag).length, 0);
  assert.equal(f.view.querySelectorAll('.inscription-saved').length, 1);
  assert.match(tiles[0].attributes['aria-label'], /Open inscription #0, Images/);
  tiles[0].listeners.click(); assert.deepEqual(f.calls, [[`inscription:${id(0)}`]]);
  images[0].listeners.error(); assert.equal(results.querySelectorAll('img').length, 0);
  const many = fixture({ data: { items: Array.from({ length: 50 }, (_, n) => ({ ...items[1], id: id(n) })) } });
  assert.equal(many.view.querySelectorAll('.inscription-tile').length, 24);
});

test('page filters preserve form and focus, make no requests, and expose recoverable empty results', () => {
  const f = fixture(); const form = f.view.querySelector('form'); const input = form.querySelector('input'); input.value = 'draft'; input.focus();
  control(f.view, 'Text 1').listeners.click();
  assert.equal(f.view.querySelectorAll('.inscription-tile').length, 1); assert.equal(f.view.querySelector('form'), form);
  assert.equal(document.activeElement, input); assert.equal(input.value, 'draft'); assert.deepEqual(f.calls, []);
  assert.equal(control(f.view, 'Text 1').attributes['aria-pressed'], 'true');
  assert.equal(control(f.view, 'All 7').attributes['aria-pressed'], 'false');
  assert.match(f.view.querySelector('.inscription-result-count').textContent, /1 of 7.*Text/);
  assert.equal(f.view.querySelector('.inscription-result-count').attributes['aria-live'], 'polite');
  control(f.view, 'Other 0').listeners.click(); assert.match(f.view.textContent, /No matches on this page/);
  control(f.view, 'Show all types').listeners.click(); assert.equal(f.view.querySelectorAll('.inscription-tile').length, 7);
  assert.deepEqual(f.calls, []); assert.match(f.view.textContent, /Content-type filters apply to this page/);
  assert.match(f.view.textContent, /Global name, collection-keyword, and content-text search.*not available/);
});

test('collector badges, coverage and trait filters combine with media without extra navigation', () => {
  const rich = [
    { ...items[0], sat: '45000000000', charms: ['reinscription'] },
    { ...items[1], sat: '2', number: '-1' },
    { ...items[2], charms: ['rare'] },
    { ...items[3], sat: null, charms: [] }
  ];
  const f = fixture({ data: { items: rich } });
  assert.match(f.view.querySelector('.inscription-rarity-summary').textContent, /2 inscriptions on known non-common sats.*3 of 4/);
  assert.match(f.view.querySelector('.inscription-tile').textContent, /Uncommon sat.*Reinscription.*9ball/);
  const select = f.view.querySelector('.inscription-trait-filter');
  assert.ok(f.view.querySelectorAll('label').some(label => label.htmlFor === select.attributes.id));
  select.value = 'non-common'; select.focus(); select.listeners.change();
  assert.equal(f.view.querySelectorAll('.inscription-tile').length, 2); assert.equal(document.activeElement, select);
  assert.equal(control(f.view, 'Images 1').attributes['aria-pressed'], 'false'); control(f.view, 'Images 1').click();
  assert.equal(f.view.querySelectorAll('.inscription-tile').length, 1);
  select.value = 'cursed'; select.listeners.change(); assert.match(f.view.textContent, /No matches on this page/);
  control(f.view, 'Clear filters').click(); assert.equal(select.value, 'all'); assert.equal(f.view.querySelectorAll('.inscription-tile').length, 4);
  select.value = 'unknown'; select.listeners.change();
  assert.equal(f.view.querySelectorAll('.inscription-tile').length, 1);
  assert.doesNotMatch(f.view.querySelector('.inscription-tile').textContent, /Common sat/);
  assert.deepEqual(f.calls, []);
});

test('collector filter and focus survive data refresh; identical publications do not remount cards', () => {
  const f = fixture({ data: { items: [{ ...items[0], sat: '45000000000' }, { ...items[1], sat: '3' }] } });
  const select = f.view.querySelector('.inscription-trait-filter'); select.value = 'nineball'; select.listeners.change(); select.focus();
  const tile = f.view.querySelector('.inscription-tile'), form = f.view.querySelector('form');
  assert.equal(updateInscriptions(f.view, { ...f.result }, f.ctx), true);
  assert.equal(f.view.querySelector('.inscription-tile'), tile); assert.equal(document.activeElement, select);
  const next = { ...f.result, entity: { ...f.result.entity, fetchedAt: '2026-09-19T00:00:00Z' } };
  assert.equal(updateInscriptions(f.view, next, f.ctx), true);
  const replacement = f.view.querySelector('.inscription-trait-filter');
  assert.notEqual(replacement, select); assert.equal(replacement.value, 'nineball'); assert.equal(document.activeElement, replacement);
  assert.equal(f.view.querySelector('form'), form); assert.equal(f.view.querySelectorAll('.inscription-tile').length, 1);
  control(f.view, 'Images 1').click();
  updateInscriptions(f.view, { target: f.result.target }, f.ctx);
  assert.equal(control(f.view, 'Images 0').attributes['aria-pressed'], 'true');
  assert.equal(f.view.querySelector('.inscription-trait-filter').disabled, true);
  updateInscriptions(f.view, next, f.ctx);
  assert.equal(f.view.querySelector('.inscription-trait-filter').value, 'nineball');
  assert.equal(control(f.view, 'Images 1').attributes['aria-pressed'], 'true');
  assert.equal(f.view.querySelectorAll('.inscription-tile').length, 1);
  assert.deepEqual(f.calls, []);
});

test('missing metadata and non-mainnet sat numbers remain explicitly unavailable in gallery coverage', () => {
  const f = fixture({ data: { items: [{ ...items[0], sat: '0', metadataUnavailable: true }] } });
  assert.match(f.view.querySelector('.inscription-rarity-summary').textContent, /0 inscriptions on known non-common sats.*0 of 1/);
  f.model.settings.network = 'regtest';
  const root = renderInscriptions({ ...f.result, entity: { data: { items: [{ ...items[0], sat: '0' }] } } }, f.ctx);
  assert.match(root.querySelector('.inscription-rarity-summary').textContent, /0 of 1/);
  assert.equal(root.querySelectorAll('.collector-badge').length, 0);
});

test('loading, empty, partial and offline errors retain useful search and recovery controls', () => {
  const loading = fixture({ loading: true }); assert.equal(loading.view.querySelector('.inscription-results').attributes['aria-busy'], 'true');
  assert.equal(loading.view.querySelectorAll('.inscription-skeleton').length, 8);
  assert.ok(loading.view.querySelector('.inscription-filters').querySelectorAll('button').every(node => node.disabled));
  const input = loading.view.querySelector('input'); input.value = '1'; submit(loading.view.querySelector('form')); assert.deepEqual(loading.calls, [['inscription:1']]);
  const empty = fixture({ data: { items: [], next: null } }); assert.match(empty.view.textContent, /No inscriptions on this page/);
  const partial = fixture({ data: { partial: true } }); assert.match(partial.view.textContent, /Some details are temporarily unavailable/);
  const failed = fixture({ offline: true, error: { code: 'OFFLINE_CACHE_MISS', message: '<script>bad</script>' } });
  assert.match(failed.view.textContent, /This page is not saved offline/); assert.equal(failed.view.querySelectorAll('script').length, 0);
  control(failed.view, 'Try again').listeners.click(); control(failed.view, 'Data sources').listeners.click();
  assert.deepEqual(failed.retryCalls, [[]]);
  assert.deepEqual(failed.calls, [['satnav://providers']]);
});

test('pagination only dispatches canonical same-block gallery links and preserves query scope', () => {
  const f = fixture({ query: 'page=1&block=840000', data: { next: 'satnav://inscriptions?page=1&offset=24&block=840000', previous: 'satnav://inscriptions?offset=96&block=840000' } });
  control(f.view, 'Older →').listeners.click(); control(f.view, '← Newer').listeners.click();
  assert.deepEqual(f.calls, [['satnav://inscriptions?page=1&offset=24&block=840000'], ['satnav://inscriptions?offset=96&block=840000']]);
  assert.match(f.view.querySelector('.inscription-pagination').textContent, /Page 6/);
  for (const next of ['https://example.com', 'satnav://inscriptions?block=1', 'satnav://inscriptions?offset=25', 'satnav://inscriptions?offset=24#x', 'satnav://inscriptions?page=0&offset=24']) {
    const invalid = fixture({ data: { next } }); assert.equal(control(invalid.view, 'Older →').disabled, true); control(invalid.view, 'Older →').listeners.click(); assert.deepEqual(invalid.calls, []);
  }
});

test('block helper is progressively disclosed and rejects invalid heights before navigation', () => {
  const f = fixture(); const details = f.view.querySelector('.inscription-block-disclosure');
  assert.equal(details.tagName, 'DETAILS'); assert.equal(details.attributes.open, undefined);
  const form = details.querySelector('form'); const input = form.querySelector('input');
  assert.equal(form.querySelector('label').htmlFor, input.attributes.id);
  input.value = '1.5'; submit(form); assert.deepEqual(f.calls, []); assert.equal(document.activeElement, input);
  input.value = '10000001'; submit(form); assert.deepEqual(f.calls, []);
  input.value = '840000'; submit(form); assert.deepEqual(f.calls, [['satnav://inscriptions?block=840000']]);
});

test('Home has a primary gallery shortcut while retaining guided Bitcoin lookup', () => {
  const f = fixture(); const home = renderHome(f.model, f.ctx);
  control(home, '◈Explore inscriptions').listeners.click(); assert.deepEqual(f.calls, [['satnav://inscriptions']]);
  assert.match(home.textContent, /A whole world\. Built on Bitcoin/); assert.ok(home.querySelector('form')); assert.ok(home.querySelector('select'));
});

test('actual page publication preserves search/block drafts, disclosure and focus through delayed success and error', async () => {
  const f = fixture({ loading: true }); f.model.bootstrap = {}; f.model.activeTabId = 'tab-a';
  const page = new TestNode('main'); page.classList = { toggle() {} };
  let result = { target: discoveryTarget(), entity: null };
  const stage = { scrollTop: 0, classList: { toggle() {} } };
  const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function renderPage() {'); const end = source.indexOf('\nfunction renderDrawer()', begin);
  assert.ok(begin >= 0 && end > begin);
  const renderPage = vm.runInNewContext(`(${source.slice(begin, end)})`, { state: () => f.model, currentResult: () => result, elements: { page, 'main-stage': stage }, context: f.ctx, renderInscriptions, updateInscriptions, clear });
  renderPage(); const form = page.querySelector('form'); const input = form.querySelector('input');
  const details = page.querySelector('.inscription-block-disclosure'); details.open = true;
  const block = details.querySelector('input'); block.value = '840'; input.value = 'partial inscription'; input.focus(); stage.scrollTop = 75;
  await Promise.resolve(); result = { target: discoveryTarget(), entity: { data: { items } } }; renderPage();
  assert.equal(page.querySelector('form'), form); assert.equal(input.value, 'partial inscription'); assert.equal(document.activeElement, input);
  assert.equal(details.open, true); assert.equal(block.value, '840'); assert.equal(stage.scrollTop, 75);
  control(page, 'Text 1').click(); renderPage(); assert.equal(page.querySelectorAll('.inscription-tile').length, 1);
  result = { target: discoveryTarget(), error: { code: 'EIO', message: 'Synthetic read error' } }; f.model.settings.offlineMode = true; renderPage();
  assert.equal(page.querySelector('form'), form); assert.equal(document.activeElement, input);
  assert.match(page.textContent, /saved page could not be read/); assert.doesNotMatch(page.textContent, /This page is not saved offline/);
  f.model.activeTabId = 'tab-b'; renderPage(); assert.notEqual(page.querySelector('form'), form); assert.equal(page.querySelector('input').value, '');
  const otherForm = page.querySelector('form'); result = { target: discoveryTarget('block=1'), entity: { data: { items: [] } } }; renderPage();
  assert.notEqual(page.querySelector('form'), otherForm);
});
