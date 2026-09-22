import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { popularAssets, popularAsset, POPULAR_REVIEWED_AT, POPULAR_VISIBLE_COUNT } from '../src/shared/popular-assets.js';
import { renderPopularAssets } from '../src/renderer/popular-assets.js';
import { popularLogo } from '../src/renderer/assets/popular-logos.js';
import { renderInscriptions, updateInscriptions } from '../src/renderer/inscriptions.js';
import { renderRunes, updateRunes } from '../src/renderer/runes.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

// Actual renderer + DOM helpers, with a bounded DOM collaborator. No native
// layout, image decoding, keyboard-default or screen-reader certification.
class TestNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag.toUpperCase(); this._text = text; this.children = [];
    this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.value = '';
    this.classList = { toggle() {} };
  }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { return this.listeners.click?.(); }
  focus() { document.activeElement = this; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  replaceWith(next) { const parent = this.parentElement; parent.children[parent.children.indexOf(this)] = next; next.parentElement = parent; this.parentElement = null; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? (node.className ?? '').split(/\s+/).includes(selector.slice(1)) : node.tagName === selector.toUpperCase();
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { activeElement: null, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const control = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label);
const cards = root => root.querySelectorAll('.popular-card');
const previews = root => root.querySelectorAll('.popular-content-preview');
function fixture(kind = 'inscriptions', settings = {}) {
  const calls = [], copies = [], references = [];
  const ctx = {
    model: { activeTabId: 'tab-a', settings: { network: 'mainnet', offlineMode: false, localOnly: false, privacyMode: 'balanced', ...settings }, bookmarks: [], history: [] },
    navigate: target => calls.push(target), copy: value => copies.push(value), openExternal: url => references.push(url), retry() {}
  };
  return { root: renderPopularAssets(kind, ctx), ctx, calls, copies, references };
}

test('catalogs are bounded, immutable and reject unknown kinds and non-mainnet networks', () => {
  assert.equal(POPULAR_VISIBLE_COUNT, 3); assert.match(POPULAR_REVIEWED_AT, /^\d{4}-\d{2}-\d{2}$/);
  for (const kind of ['runes', 'inscriptions']) {
    const entries = popularAssets(kind, 'mainnet'); assert.equal(entries.length, 6); assert.ok(Object.isFrozen(entries));
    for (const entry of entries) {
      assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.facts)); assert.equal(entry.facts.length, 2);
      assert.ok(entry.facts.every(Object.isFrozen));
      assert.equal(popularAsset(kind, entry.key, 'mainnet'), entry);
      assert.throws(() => { entry.target = 'javascript:alert(1)'; }, TypeError);
    }
    for (const network of ['testnet', 'testnet4', 'signet', 'regtest', '', undefined, null, 'MAINNET']) {
      assert.deepEqual(popularAssets(kind, network), []); assert.equal(popularAsset(kind, entries[0].key, network), null);
    }
  }
  for (const kind of ['constructor', '__proto__', 'toString', 'brc20', '', null, undefined, {}, ['runes']]) {
    assert.deepEqual(popularAssets(kind, 'mainnet'), []); assert.equal(popularAsset(kind, 'dog', 'mainnet'), null);
  }
  assert.equal(popularAsset('runes', 'https://untrusted.example', 'mainnet'), null);
});

test('every catalog target is an exact unique native asset, with a reviewed HTTPS reference', () => {
  for (const kind of ['runes', 'inscriptions']) {
    const entries = popularAssets(kind, 'mainnet');
    assert.equal(new Set(entries.map(entry => entry.key)).size, 6);
    assert.equal(new Set(entries.map(entry => entry.target)).size, 6);
    for (const entry of entries) {
      const parsed = parseNavigationInput(entry.target);
      assert.equal(parsed.canonical, entry.target); assert.equal(parsed.kind, kind === 'runes' ? 'rune' : 'inscription');
      if (kind === 'runes') assert.match(entry.runeId, /^\d+:\d+$/);
      else { assert.match(entry.inscriptionId, /^[0-9a-f]{64}i\d{1,10}$/); assert.match(entry.number, /^\d+$/); }
      const reference = new URL(entry.reference);
      assert.equal(reference.protocol, 'https:'); assert.equal(reference.hostname, kind === 'runes' ? 'ordinals.com' : 'ordiscan.com');
      for (const property of ['username', 'password', 'port', 'search', 'hash']) assert.equal(reference[property], '');
      assert.ok(['orange', 'green', 'violet'].includes(entry.tone));
      assert.equal(Object.keys(entry).some(key => /price|volume|owner|holders|floor|rank|balance/i.test(key)), false);
    }
  }
  assert.equal(popularAsset('inscriptions', 'quantum-cats', 'mainnet').preview, false);
  assert.equal(popularAsset('inscriptions', 'runestone', 'mainnet').preview, false);
  assert.equal(popularAsset('runes', 'uncommon-goods', 'mainnet').runeId, '1:0');
});

test('default panels show three curated picks and bundled logos, with no active embeds or remote image requests', () => {
  for (const kind of ['runes', 'inscriptions']) {
    const f = fixture(kind);
    assert.equal(cards(f.root).length, 3); assert.match(f.root.textContent, /Curated · Not live-ranked/);
    assert.match(f.root.textContent, /order is editorial/); assert.ok(f.root.textContent.includes(POPULAR_REVIEWED_AT));
    assert.match(f.root.textContent, /not endorsements or authenticity certificates/);
    assert.match(f.root.textContent, /system browser after confirmation/);
    for (const tag of ['iframe', 'webview', 'script', 'audio', 'video', 'a']) assert.equal(f.root.querySelectorAll(tag).length, 0);
    assert.equal(f.root.querySelectorAll('img').length, 3); assert.equal(previews(f.root).length, 0);
    for (const card of cards(f.root)) {
      const mark = card.querySelector('.popular-logo');
      assert.equal(mark.attributes.src, popularLogo(card.dataset.popularKey).src);
      assert.equal(mark.attributes.referrerpolicy, 'no-referrer'); assert.equal(mark.attributes.alt, '');
      assert.equal(card.querySelector('.popular-emblem').textContent, '');
    }
    assert.deepEqual([f.calls, f.copies, f.references], [[], [], []]);
    assert.equal(f.root.querySelector('.popular-method').attributes.open, undefined);
    assert.ok(cards(f.root).every(card => card.querySelector('.popular-card-details').attributes.open === undefined));
    const titleId = f.root.querySelector('h2').attributes.id;
    assert.equal(f.root.attributes['aria-labelledby'], titleId);
    assert.notEqual(titleId, fixture(kind).root.querySelector('h2').attributes.id);
    assert.equal(f.root.querySelector('.popular-status').attributes['aria-live'], 'polite');
  }
});

test('show-all disclosure is local, accessible and keeps its focused control', () => {
  const f = fixture('runes'); const more = control(f.root, 'Show all 6'); more.focus();
  assert.equal(more.attributes['aria-controls'], f.root.querySelector('.popular-grid').attributes.id);
  more.click(); assert.equal(cards(f.root).length, 6); assert.equal(more.textContent, 'Show fewer');
  assert.equal(more.attributes['aria-expanded'], 'true'); assert.equal(document.activeElement, more);
  assert.equal(f.root.querySelector('.popular-status').textContent, '6 of 6 curated picks');
  more.click(); assert.equal(cards(f.root).length, 3); assert.equal(more.attributes['aria-expanded'], 'false');
  assert.deepEqual([f.calls, f.copies, f.references], [[], [], []]);
});

test('open, copy and reference actions use the exact catalog target only on explicit activation', async () => {
  for (const kind of ['runes', 'inscriptions']) {
    const f = fixture(kind); control(f.root, 'Show all 6').click();
    for (const card of cards(f.root)) {
      const entry = popularAsset(kind, card.dataset.popularKey, 'mainnet');
      await card.querySelector('.popular-open').click();
      await control(card, kind === 'runes' ? 'Copy Rune ID' : 'Copy inscription ID').click();
      await control(card, 'View reference ↗').click();
      assert.equal(f.calls.at(-1), entry.target); assert.equal(f.copies.at(-1), entry.runeId ?? entry.inscriptionId);
      assert.equal(f.references.at(-1), entry.reference);
    }
    assert.equal(f.calls.length, 6); assert.equal(f.copies.length, 6); assert.equal(f.references.length, 6);
  }
});

test('optional artwork is bounded to eligible catalog raster routes and never runs recursive or 3D content', () => {
  const f = fixture(); const preview = control(f.root, 'Show safe artwork'); preview.click();
  assert.equal(preview.attributes['aria-pressed'], 'true'); assert.equal(previews(f.root).length, 2);
  assert.equal(preview.attributes['aria-describedby'], f.root.querySelector('.popular-context').attributes.id);
  control(f.root, 'Show all 6').click(); assert.equal(previews(f.root).length, 4);
  for (const card of cards(f.root)) {
    const entry = popularAsset('inscriptions', card.dataset.popularKey, 'mainnet'); const images = previews(card);
    assert.equal(card.querySelectorAll('.popular-logo').length, 1);
    assert.equal(images.length, entry.preview ? 1 : 0);
    for (const image of images) {
      assert.equal(image.attributes.src, `ord://thumbnail/${entry.inscriptionId}`);
      assert.equal(image.attributes.loading, 'lazy'); assert.equal(image.attributes.decoding, 'async');
      assert.equal(image.attributes.referrerpolicy, 'no-referrer'); assert.equal(image.attributes.alt, '');
      assert.equal(image.attributes.srcset, undefined);
    }
  }
  for (const tag of ['iframe', 'script', 'webview', 'video', 'audio']) assert.equal(f.root.querySelectorAll(tag).length, 0);
  preview.click(); assert.equal(preview.attributes['aria-pressed'], 'false'); assert.equal(previews(f.root).length, 0);
  assert.equal(f.root.querySelectorAll('.popular-logo').length, 6);
  assert.deepEqual([f.calls, f.references], [[], []]);
});

test('failed preview removes only the image, keeps the asset action and does not auto-retry', async () => {
  const f = fixture(); control(f.root, 'Show safe artwork').click();
  const card = cards(f.root)[0]; const mark = card.querySelector('.popular-logo'); const image = previews(card)[0]; image.listeners.error();
  assert.equal(previews(card).length, 0); assert.match(card.textContent, /Preview unavailable · open for details/);
  f.root.updatePopularAssets(); assert.equal(previews(card).length, 0); assert.equal(card.querySelector('.popular-logo'), mark);
  await card.querySelector('.popular-open').click(); assert.equal(f.calls.length, 1);
});

test('background updates preserve expanded picks, open details, artwork nodes and focus', () => {
  const f = fixture(); control(f.root, 'Show all 6').click(); control(f.root, 'Show safe artwork').click();
  const card = cards(f.root)[0]; const details = card.querySelector('details'); details.open = true;
  const image = previews(card)[0]; const mark = card.querySelector('.popular-logo'); const open = card.querySelector('.popular-open'); open.focus();
  f.root.updatePopularAssets();
  assert.equal(cards(f.root).length, 6); assert.equal(cards(f.root)[0], card); assert.equal(details.open, true);
  assert.equal(previews(card)[0], image); assert.equal(card.querySelector('.popular-logo'), mark); assert.equal(document.activeElement, open);
});

test('routing and privacy transitions reset artwork while preserving show-all intent and truthful guidance', () => {
  const f = fixture(); control(f.root, 'Show all 6').click();
  for (const [setting, value, pattern] of [['offlineMode', true, /cached images only/], ['offlineMode', false, /configured sources/], ['localOnly', true, /only your configured local sources/], ['privacyMode', 'strict', /local sources/]]) {
    control(f.root, 'Show safe artwork').click(); assert.equal(previews(f.root).length, 4);
    f.ctx.model.settings[setting] = value; f.root.updatePopularAssets();
    assert.equal(previews(f.root).length, 0); assert.equal(cards(f.root).length, 6);
    assert.equal(f.root.querySelectorAll('.popular-logo').length, 6);
    assert.equal(control(f.root, 'Show safe artwork').attributes['aria-pressed'], 'false');
    assert.match(f.root.querySelector('.popular-context').textContent, pattern);
  }
});

test('non-mainnet has no catalog actions or previews and does not change settings', () => {
  for (const network of ['testnet', 'testnet4', 'signet', 'regtest', undefined]) {
    const f = fixture('inscriptions', { network });
    assert.equal(cards(f.root).length, 0); assert.equal(f.root.querySelector('.popular-content').hidden, true);
    assert.equal(f.root.querySelector('.popular-network-note').hidden, false);
    control(f.root, 'Show safe artwork').click(); assert.equal(f.root.querySelectorAll('img').length, 0);
    assert.equal(f.ctx.model.settings.network, network); assert.deepEqual(f.calls, []);
  }
});

test('retained card actions and controls cannot act after a network or owning-tab change', async () => {
  for (const change of [ctx => { ctx.model.settings.network = 'signet'; }, ctx => { ctx.model.activeTabId = 'tab-b'; }]) {
    const f = fixture(); const card = cards(f.root)[0]; const more = control(f.root, 'Show all 6'); const preview = control(f.root, 'Show safe artwork');
    change(f.ctx);
    await card.querySelector('.popular-open').click(); await control(card, 'Copy inscription ID').click(); await control(card, 'View reference ↗').click();
    more.click(); preview.click();
    assert.deepEqual([f.calls, f.copies, f.references], [[], [], []]); assert.equal(previews(f.root).length, 0);
    assert.equal(more.attributes['aria-expanded'], 'false'); assert.equal(preview.attributes['aria-pressed'], 'false');
  }
});

test('published mainnet change hides cards and return does not restore artwork automatically', () => {
  const f = fixture(); control(f.root, 'Show all 6').click(); control(f.root, 'Show safe artwork').click();
  f.ctx.model.settings.network = 'signet'; f.root.updatePopularAssets();
  assert.equal(cards(f.root).length, 0); assert.equal(f.root.querySelector('.popular-content').hidden, true);
  f.ctx.model.settings.network = 'mainnet'; f.root.updatePopularAssets();
  assert.equal(cards(f.root).length, 6); assert.equal(f.root.querySelector('.popular-content').hidden, false);
  assert.equal(previews(f.root).length, 0); assert.equal(f.root.querySelectorAll('.popular-logo').length, 6);
});

test('rejected actions settle safely with bounded feedback, and stale failures cannot publish', async () => {
  const f = fixture('runes'); const card = cards(f.root)[0];
  f.ctx.openExternal = async () => { throw Object.assign(new Error('untrusted private diagnostic'), { code: 'USER_REJECTED' }); };
  await control(card, 'View reference ↗').click(); assert.equal(f.root.querySelector('.popular-status').textContent, 'Action canceled.');
  f.ctx.navigate = () => { throw new Error('<script>untrusted diagnostic</script>'); };
  await card.querySelector('.popular-open').click(); assert.match(f.root.querySelector('.popular-status').textContent, /could not be opened/);
  assert.doesNotMatch(f.root.textContent, /untrusted/);
  let reject;
  f.ctx.openExternal = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = control(card, 'View reference ↗').click(); const before = f.root.querySelector('.popular-status').textContent;
  f.ctx.model.activeTabId = 'tab-b'; reject(new Error('late failure')); await pending;
  assert.equal(f.root.querySelector('.popular-status').textContent, before);
});

test('real Inscriptions and Runes publication retain discovery state and existing lookup drafts', () => {
  for (const [kind, render, update] of [['inscriptions', renderInscriptions, updateInscriptions], ['runes', renderRunes, updateRunes]]) {
    const f = fixture(kind); const result = { target: parseNavigationInput(`satnav://${kind}`), entity: { data: { items: [] } } };
    const root = render(result, f.ctx); const form = root.querySelector('form'); const input = form.querySelector('input'); input.value = 'draft'; input.focus();
    const discovery = root.querySelector('.popular-discovery'); control(discovery, 'Show all 6').click();
    const details = cards(discovery)[0].querySelector('details'); details.open = true;
    assert.equal(update(root, { target: result.target, error: { code: 'NO_PROVIDER' } }, f.ctx), true);
    assert.equal(root.querySelector('form'), form); assert.equal(input.value, 'draft'); assert.equal(document.activeElement, input);
    assert.equal(root.querySelector('.popular-discovery'), discovery); assert.equal(cards(discovery).length, 6); assert.equal(details.open, true);
    f.ctx.model.settings.network = 'signet'; assert.equal(update(root, result, f.ctx), true); assert.equal(cards(discovery).length, 0);
    f.ctx.model.activeTabId = 'tab-b'; assert.equal(update(root, result, f.ctx), false);
  }
});

test('Rune detail is not crowded by discovery; collection examples do not promise collection browsing', () => {
  const f = fixture('runes'); const root = renderRunes({ target: parseNavigationInput('rune:UNCOMMON•GOODS'), error: { code: 'NO_PROVIDER' } }, f.ctx);
  assert.equal(root.querySelector('.popular-discovery'), null);
  const inscriptions = fixture().root; assert.match(inscriptions.textContent, /one identified example, not a complete collection/);
  assert.match(inscriptions.textContent, /Prices, floor listings, trading volume/);
});

test('shared styles are packaged in the shell and preserve contained artwork and responsive/focus rules', () => {
  const index = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/renderer/popular-assets.css', import.meta.url), 'utf8');
  assert.match(index, /href="\.\/popular-assets\.css"/); assert.doesNotMatch(css, /(?:https?:|@import|url\()/);
  assert.match(css, /object-fit:contain/); assert.match(css, /height:148px/); assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /max-width:760px/); assert.match(css, /focus-visible/); assert.match(css, /prefers-reduced-motion/);
});

function rasterDimensions(data, mime) {
  if (mime === 'image/png') {
    assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(data.toString('ascii', 12, 16), 'IHDR');
    let offset = 8, ended = false;
    while (offset < data.length) {
      const length = data.readUInt32BE(offset); const type = data.toString('ascii', offset + 4, offset + 8);
      assert.ok(offset + 12 + length <= data.length); assert.notEqual(type, 'acTL', 'bundled branding must not animate');
      offset += 12 + length;
      if (type === 'IEND') { ended = true; break; }
    }
    assert.ok(ended); assert.equal(offset, data.length);
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  assert.equal(mime, 'image/webp'); assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.toString('ascii', 8, 12), 'WEBP'); assert.equal(data.readUInt32LE(4) + 8, data.length);
  let offset = 12, dimensions;
  while (offset < data.length) {
    const type = data.toString('ascii', offset, offset + 4); const size = data.readUInt32LE(offset + 4); const begin = offset + 8;
    assert.ok(begin + size <= data.length); assert.ok(!['ANIM', 'ANMF'].includes(type), 'bundled branding must not animate');
    if (type === 'VP8X') { assert.equal(data[begin] & 2, 0); dimensions = [1 + data.readUIntLE(begin + 4, 3), 1 + data.readUIntLE(begin + 7, 3)]; }
    if (type === 'VP8 ') {
      assert.deepEqual([...data.subarray(begin + 3, begin + 6)], [157, 1, 42]);
      dimensions ??= [data.readUInt16LE(begin + 6) & 16383, data.readUInt16LE(begin + 8) & 16383];
    }
    if (type === 'VP8L') {
      assert.equal(data[begin], 47); const bits = data.readUInt32LE(begin + 1);
      dimensions ??= [1 + (bits & 16383), 1 + ((bits >>> 14) & 16383)];
    }
    offset = begin + size + (size & 1);
  }
  assert.equal(offset, data.length); assert.ok(dimensions); return dimensions;
}

test('all twelve bundled logos are real, static, bounded raster data with matching dimensions and provenance', () => {
  let total = 0;
  for (const entry of [...popularAssets('runes', 'mainnet'), ...popularAssets('inscriptions', 'mainnet')]) {
    const logo = popularLogo(entry.key); assert.ok(logo, entry.key); assert.ok(Object.isFrozen(logo));
    assert.equal(Object.hasOwn(entry, 'emblem'), false);
    assert.match(logo.src, /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
    assert.ok(logo.src.startsWith(`data:${logo.mime};base64,`));
    const data = Buffer.from(logo.src.slice(logo.src.indexOf(',') + 1), 'base64');
    assert.equal(data.length, logo.bytes); assert.ok(data.length > 0 && data.length <= 96 * 1024);
    assert.deepEqual(rasterDimensions(data, logo.mime), [logo.width, logo.height]);
    assert.ok(logo.width > 0 && logo.width <= 2048 && logo.height > 0 && logo.height <= 2048);
    for (const value of [logo.sourcePage, logo.sourceUrl]) {
      const url = new URL(value); assert.equal(url.protocol, 'https:'); assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '');
    }
    assert.match(logo.label, /logo|icon|artwork/); total += data.length;
  }
  assert.ok(total <= 256 * 1024, 'the complete reviewed raster set stays below 256 KiB');
});

test('logo lookup rejects arbitrary keys and cannot be used to build remote or active content sources', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'https://untrusted.example/logo.svg', 'javascript:alert(1)', {}, ['dog'], '', undefined, null]) assert.equal(popularLogo(key), null);
  const logo = popularLogo('dog'); assert.throws(() => { logo.src = 'https://untrusted.example'; }, TypeError);
  assert.equal(popularLogo('dog'), logo);
});

test('offline and local-only panels still display exact bundled logos without content or reference requests', () => {
  for (const kind of ['runes', 'inscriptions']) {
    const f = fixture(kind, { offlineMode: true, localOnly: true }); control(f.root, 'Show all 6').click();
    assert.equal(f.root.querySelectorAll('.popular-logo').length, 6); assert.equal(previews(f.root).length, 0);
    for (const card of cards(f.root)) assert.equal(card.querySelector('.popular-logo').attributes.src, popularLogo(card.dataset.popularKey).src);
    assert.deepEqual([f.calls, f.copies, f.references], [[], [], []]);
    assert.match(f.root.textContent, /display offline, without contacting image servers/);
  }
});

test('a broken bundled image reveals a neutral fallback with no letters, emoji, remote fallback or automatic retry', () => {
  const f = fixture(); const card = cards(f.root)[0]; const mark = card.querySelector('.popular-logo');
  const fallback = card.querySelector('.popular-image-fallback'); assert.equal(fallback.hidden, true);
  mark.listeners.error(); assert.equal(card.querySelector('.popular-logo'), null); assert.equal(fallback.hidden, false);
  assert.equal(card.querySelector('.popular-emblem').textContent, '');
  f.root.updatePopularAssets(); assert.equal(card.querySelector('.popular-logo'), null);
  assert.deepEqual([f.calls, f.references], [[], []]); assert.equal(previews(card).length, 0);
});

test('branding distinguishes collection icons, the exact example, protocol-independent community marks and historic artwork', () => {
  const f = fixture(); control(f.root, 'Show all 6').click();
  assert.match(cards(f.root)[0].querySelector('.popular-branding-note').textContent, /separate from this card’s exact inscription example/);
  const zero = cards(f.root).find(card => card.dataset.popularKey === 'inscription-zero');
  assert.match(zero.textContent, /Original inscription #0 artwork, not a separate project logo/);
  const runes = fixture('runes'); control(runes.root, 'Show all 6').click();
  const uncommon = cards(runes.root).find(card => card.dataset.popularKey === 'uncommon-goods');
  assert.match(uncommon.textContent, /not a logo defined by the Bitcoin or Runes protocol/);
  const index = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.ok(JSON.parse(index).build.files.includes('src/**/*'), 'bundled assets are included by the existing package file set');
});
