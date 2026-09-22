import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createInscriptionDisplay } from '../src/renderer/inscription-display.js';
import { renderInscription } from '../src/renderer/views.js';
import { installContentProtocol } from '../src/main/content-protocol.js';
import { clear } from '../src/renderer/dom.js';
import { normalizeEntity } from '../src/main/providers/normalize.js';

// Exercises real view/protocol logic; this collaborator does not prove native
// image layout, decoding, accessibility, keyboard defaults or media playback.
class TestNode {
  constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this._text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.value = ''; this.clientWidth = 800; this.clientHeight = 600; this.classList = { toggle() {} }; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { this.listeners.click?.({ currentTarget: this }); }
  focus() { document.activeElement = this; }
  querySelectorAll(selector) { const match = node => selector.startsWith('.') ? (node.className ?? '').split(/\s+/).includes(selector.slice(1)) : node.tagName === selector.toUpperCase(); return this.children.flatMap(node => [...(match(node) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { activeElement: null, createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const id = `${'a'.repeat(64)}i0`;
const sourceUrl = `ord://content/${id}`;
const control = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
function context() {
  const calls = [], copies = [];
  const ctx = { model: { activeTabId: 'a', settings: { network: 'mainnet', offlineMode: false } },
    isBookmarked: () => false, toggleBookmark: () => calls.push('bookmark'), navigate: value => calls.push(value), saveContent: value => calls.push(`save:${value}`), openDeveloper: value => calls.push(value), copy: value => copies.push(value), refreshCacheStats() {} };
  return { ctx, calls, copies };
}
function fixture(type = 'image/png', extra = {}) {
  const f = context(); Object.assign(f.ctx, extra);
  return { ...f, view: createInscriptionDisplay({ inscriptionId: id, sourceUrl, contentType: type, title: 'Inscription #42' }, f.ctx) };
}
function loadImage(f, width = 32, height = 32) {
  const img = f.view.canvas.querySelector('img'); img.naturalWidth = width; img.naturalHeight = height; img.listeners.load(); return img;
}
const jsonResponse = text => new Response(JSON.stringify({ text, bytes: Buffer.byteLength(text), contentType: 'text/plain', cache: 'hit' }), { headers: { 'content-type': 'application/json' } });

test('raster preview uses a centered contain image with no document iframe and useful loading status', () => {
  const f = fixture(); const img = f.view.canvas.querySelector('img');
  assert.equal(img.attributes.src, sourceUrl); assert.equal(img.attributes.referrerpolicy, 'no-referrer'); assert.equal(img.attributes.alt, 'Inscription #42');
  assert.equal(f.view.canvas.querySelector('iframe'), null); assert.equal(f.view.canvas.attributes['aria-busy'], 'true');
  assert.equal(control(f.view.toolbar, 'Actual size').disabled, true);
  loadImage(f);
  assert.equal(img.style.width, '100%'); assert.equal(img.style.height, '100%'); assert.equal(img.style.imageRendering, 'pixelated');
  assert.equal(f.view.canvas.attributes['aria-busy'], 'false'); assert.match(f.view.canvas.textContent, /32 × 32 pixels/);
  assert.equal(control(f.view.toolbar, 'Fit').attributes['aria-pressed'], 'true');
});

test('image zoom, actual size, fit and crisp-pixel controls work without refetching or remounting', () => {
  const f = fixture(); const img = loadImage(f, 600, 400);
  assert.equal(img.style.imageRendering, 'auto');
  control(f.view.toolbar, 'Actual size').click(); assert.equal(img.style.width, '600px'); assert.equal(img.style.height, '400px');
  control(f.view.toolbar, '+').click(); assert.equal(img.style.width, '900px'); assert.match(f.view.toolbar.textContent, /150%/);
  control(f.view.toolbar, '−').click(); assert.equal(img.style.width, '600px');
  control(f.view.toolbar, 'Fit').click(); assert.equal(img.style.width, '100%');
  control(f.view.toolbar, 'Crisp pixels').click(); assert.equal(img.style.imageRendering, 'pixelated');
  assert.equal(f.view.canvas.querySelector('img'), img); assert.deepEqual(f.calls, []);
});

test('background choices only change canvas presentation and preserve the original source URL', () => {
  const f = fixture(); const img = loadImage(f); const select = f.view.toolbar.querySelector('select');
  assert.equal(select.attributes['aria-label'], 'Canvas background');
  for (const value of ['dark', 'light', 'checker', 'auto']) { select.value = value; select.listeners.change(); assert.equal(f.view.canvas.dataset.background, value); assert.equal(img.attributes.src, sourceUrl); }
  select.value = 'url(https://evil.example)'; select.listeners.change(); assert.equal(f.view.canvas.dataset.background, 'auto');
});

test('zooming in from Fit enlarges tiny artwork and extreme dimensions stay bounded', () => {
  const tiny = fixture(); const img = loadImage(tiny, 1, 1);
  control(tiny.view.toolbar, '+').click();
  assert.equal(img.style.width, '828px'); assert.equal(img.style.height, '828px');
  for (let i = 0; i < 30; i++) control(tiny.view.toolbar, '+').click();
  assert.ok(Number.parseInt(img.style.width) <= 32768);
  control(tiny.view.toolbar, 'Actual size').click(); assert.equal(img.style.width, '1px');
  const huge = fixture(); const hugeImg = loadImage(huge, 400000, 1);
  control(huge.view.toolbar, 'Actual size').click();
  assert.equal(hugeImg.style.width, '32768px');
  assert.equal(control(huge.view.toolbar, 'Actual size').attributes['aria-pressed'], 'false');
  tiny.view.dispose(); huge.view.dispose();
});

test('Original keeps the existing opaque sandbox and switching back retires its frame', () => {
  const f = fixture(); const image = loadImage(f);
  control(f.view.toolbar, 'Original').click(); assert.equal(image.attributes.src, undefined);
  const frame = f.view.canvas.querySelector('iframe');
  assert.equal(frame.attributes.src, sourceUrl); assert.equal(frame.attributes.sandbox, 'allow-scripts allow-forms allow-modals allow-pointer-lock');
  assert.equal(frame.attributes.allow, ''); assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
  assert.doesNotMatch(frame.attributes.sandbox, /allow-(same-origin|top-navigation|popups|downloads)/);
  frame.listeners.load(); assert.match(f.view.canvas.textContent, /Opaque sandbox/);
  control(f.view.toolbar, 'Preview').click(); assert.equal(frame.src, 'about:blank'); assert.ok(f.view.canvas.querySelector('img'));
});

test('only active documents default to Original; SVG has a passive preview and explicit original option', () => {
  for (const type of ['text/html', 'application/xhtml+xml']) {
    const f = fixture(type); assert.ok(f.view.canvas.querySelector('iframe')); assert.equal(control(f.view.toolbar, 'Preview').hidden, true); f.view.dispose();
  }
  const svg = fixture('image/svg+xml'); const img = loadImage(svg, 32, 32); assert.equal(img.style.imageRendering, 'auto');
  assert.match(svg.view.canvas.textContent, /choose Original for scripts or linked resources/); svg.view.dispose();
});

test('3D models open the dedicated viewer, preserve save/original recovery and dispose on mode changes', async () => {
  let listener; const f = fixture('model/gltf+json', { modelFrameOptions: {
    eventTarget: { addEventListener: (_name, fn) => { listener = fn; }, removeEventListener: () => { listener = null; } },
    schedule: () => 1, cancel() {}
  } });
  const frame = f.view.canvas.querySelector('iframe'); frame.contentWindow = { postMessage() {} };
  assert.equal(frame.attributes.src, `ord://model-viewer/${id}`); assert.equal(frame.attributes.sandbox, 'allow-scripts');
  frame.listeners.load(); assert.equal(f.view.canvas.attributes['aria-busy'], 'true');
  listener({ source: frame.contentWindow, origin: 'null', data: { type: 'satoshi:model-viewer', id, state: 'ready' } });
  await f.view.ready; assert.equal(f.view.canvas.attributes['aria-busy'], 'false'); assert.match(f.view.canvas.textContent, /Interactive 3D/);
  control(f.view.toolbar, 'Original').click(); assert.equal(frame.src, 'about:blank'); assert.equal(listener, null);
  assert.equal(f.view.canvas.querySelector('iframe'), null); assert.match(f.view.canvas.textContent, /original is a 3D model/);
  control(f.view.canvas, 'Save original').click(); assert.deepEqual(f.calls, [`save:${id}`]);
  control(f.view.toolbar, '3D view').click(); assert.ok(f.view.canvas.querySelector('iframe')); f.view.dispose();
});

test('failed 3D loading stops the spinner, offers retry and cannot replace newer content', async () => {
  let deadline; const f = fixture('model/gltf-binary', { modelFrameOptions: { eventTarget: { addEventListener() {}, removeEventListener() {} }, schedule: fn => { deadline = fn; return 1; }, cancel() {} } });
  deadline(); await f.view.ready;
  assert.equal(f.view.canvas.attributes['aria-busy'], 'false'); assert.match(f.view.canvas.textContent, /took too long/);
  assert.equal(f.view.canvas.querySelector('iframe'), null); control(f.view.canvas, 'Retry 3D view').click(); assert.ok(f.view.canvas.querySelector('iframe'));
  f.view.dispose();
});

test('PDF, font, Markdown, JPEG XL and binary views use the document sandbox with explicit Original/save recovery', async () => {
  for (const [type, kind] of [['application/pdf', 'pdf'], ['font/woff2', 'font'], ['text/markdown', 'markdown'], ['image/jxl', 'jxl'], ['application/protobuf', 'binary']]) {
    let listener;
    const f = fixture(type, { documentFrameOptions: { eventTarget: { addEventListener: (_key, fn) => { listener = fn; }, removeEventListener: () => { listener = null; } }, schedule: () => 1, cancel() {} } });
    const frame = f.view.canvas.querySelector('iframe'); frame.contentWindow = { postMessage() {} };
    assert.equal(frame.attributes.src, `ord://document-viewer/${kind}/${id}`); assert.equal(frame.attributes.sandbox, 'allow-scripts');
    frame.listeners.load(); assert.equal(f.view.canvas.attributes['aria-busy'], 'true');
    listener({ source: frame.contentWindow, origin: 'null', data: { type: 'satoshi:document-viewer', id, kind, state: 'ready' } }); await f.view.ready; assert.equal(f.view.canvas.attributes['aria-busy'], 'false');
    control(f.view.toolbar, 'Original').click(); assert.equal(frame.src, 'about:blank'); assert.equal(f.view.canvas.querySelector('iframe'), null); assert.match(f.view.canvas.textContent, /downloadable file/);
    control(f.view.canvas, 'Save original').click(); assert.deepEqual(f.calls, [`save:${id}`]); control(f.view.toolbar, 'Preview').click(); assert.ok(f.view.canvas.querySelector('iframe')); f.view.dispose();
  }
});

test('native image, media and original documents have deadlines, retry and stale-event protection', () => {
  for (const [type, tag] of [['image/apng', 'img'], ['audio/flac', 'audio'], ['video/webm', 'video'], ['text/html', 'iframe']]) {
    let timeout; const cancelled = [];
    const f = fixture(type, { previewTimers: { schedule: fn => { timeout = fn; return 123; }, cancel: token => cancelled.push(token) } });
    const node = f.view.canvas.querySelector(tag); timeout(); assert.equal(f.view.canvas.attributes['aria-busy'], 'false'); assert.match(f.view.canvas.textContent, /taking too long/);
    node.listeners.load?.(); node.listeners.loadedmetadata?.(); assert.match(f.view.canvas.textContent, /taking too long/);
    control(f.view.canvas, 'Retry preview').click(); const next = f.view.canvas.querySelector(tag); assert.notEqual(next, node); f.view.dispose(); assert.ok(cancelled.includes(123));
  }
});

test('successful native load cancels its deadline and late errors still offer recovery', () => {
  let pending = false;
  const f = fixture('image/png', { previewTimers: { schedule: () => { pending = true; return 123; }, cancel: token => { if (token === 123) pending = false; } } });
  const img = loadImage(f); assert.equal(pending, false); img.listeners.error(); assert.ok(control(f.view.canvas, 'Retry preview')); f.view.dispose();
});

test('failed native content releases its source and cannot publish late success over the recovery notice', () => {
  for (const [type, tag] of [['image/png', 'img'], ['audio/flac', 'audio'], ['video/mp4', 'video'], ['text/html', 'iframe']]) {
    const f = fixture(type), node = f.view.canvas.querySelector(tag);
    node.listeners.error(); const notice = f.view.canvas.textContent;
    assert.equal(f.view.canvas.querySelector(tag), null);
    if (tag === 'iframe') assert.equal(node.src, 'about:blank'); else assert.equal(node.attributes.src, undefined);
    node.naturalWidth = 32; node.naturalHeight = 32; node.listeners.load?.(); node.listeners.loadedmetadata?.();
    assert.equal(f.view.canvas.textContent, notice); f.view.dispose();
  }
});

test('a failed image never automatically executes replacement HTML', () => {
  const f = fixture(); const img = f.view.canvas.querySelector('img'); img.listeners.error();
  assert.equal(f.view.canvas.querySelector('iframe'), null); assert.match(f.view.canvas.textContent, /No replacement content was opened automatically/);
  control(f.view.canvas, 'Save original').click(); assert.deepEqual(f.calls, [`save:${id}`]);
});

test('late image failure disables sizing controls and malformed dimensions stop loading', () => {
  const f = fixture(); const img = loadImage(f); img.listeners.error();
  for (const label of ['Fit', 'Actual size', '+', '−', 'Crisp pixels']) assert.equal(control(f.view.toolbar, label).disabled, true);
  assert.equal(f.view.canvas.attributes['aria-busy'], 'false');
  const malformed = fixture(); loadImage(malformed, 0, 0);
  assert.equal(malformed.view.canvas.attributes['aria-busy'], 'false');
  assert.match(malformed.view.canvas.querySelector('.viewer-content-status').textContent, /preview unavailable/);
  f.view.dispose(); malformed.view.dispose();
});

test('readable JSON mode uses safe text nodes, preserves numeric tokens and copies the exact source', async () => {
  const source = '{"p":"brc-20","amt":340282366920938463463374607431768211455,"note":"<img src=x onerror=evil()>"}';
  const requests = [];
  const f = fixture('text/plain', { fetchContentPreview: async (...args) => { requests.push(args); return jsonResponse(source); } });
  await f.view.ready;
  assert.equal(requests[0][0], `ord://text/${id}`); assert.equal(requests[0][1].credentials, 'omit');
  assert.ok(requests[0][1].signal instanceof AbortSignal);
  assert.equal(f.view.canvas.querySelector('iframe'), null); assert.equal(f.view.canvas.querySelector('img'), null);
  assert.match(f.view.canvas.textContent, /340282366920938463463374607431768211455/); assert.match(f.view.canvas.textContent, /not a verified token balance/);
  assert.match(f.view.canvas.querySelector('pre').textContent, /\n  "p":/);
  control(f.view.toolbar, 'Source').click(); assert.equal(f.view.canvas.querySelector('pre').textContent, source);
  control(f.view.toolbar, 'Copy text').click(); assert.deepEqual(f.copies, [source]);
  control(f.view.toolbar, 'Formatted').click(); assert.equal(requests.length, 1); f.view.dispose();
});

test('actual registered protocol and renderer integrate for plain text, JSON and an empty document', async () => {
  for (const text of ['<h1>display as text</h1>\nA second line', '{"tick":"ordi","amt":"1000"}', '']) {
    let handler;
    installContentProtocol({ protocol: { handle: (_scheme, value) => { handler = value; } } }, { resolve: async () => ({ status: 200, data: Buffer.from(text), headers: { 'content-type': 'text/plain;charset=utf-8' }, cache: 'hit' }) }, { get: () => ({}) });
    const f = fixture('text/plain', { fetchContentPreview: (url, options) => handler(new Request(url, options)) });
    await f.view.ready;
    assert.equal(f.view.canvas.attributes['aria-busy'], 'false'); assert.match(f.view.canvas.textContent, /Cached/);
    if (text) assert.ok(f.view.canvas.querySelector('pre')); else assert.match(f.view.canvas.textContent, /empty text document/);
    assert.equal(f.view.canvas.querySelector('h1'), null); f.view.dispose();
  }
});

test('text errors, oversize content and unexpected responses retain explicit recovery actions', async () => {
  for (const response of [new Response('{}', { status: 413 }), new Response('HTML', { headers: { 'content-type': 'text/html' } }), jsonResponse('x'.repeat(262145))]) {
    const f = fixture('text/plain', { fetchContentPreview: async () => response }); await f.view.ready;
    assert.match(f.view.canvas.textContent, /Could not prepare this text/); assert.ok(control(f.view.canvas, 'Open Original')); assert.ok(control(f.view.canvas, 'Save original'));
    assert.equal(f.view.canvas.querySelector('iframe'), null); assert.equal(control(f.view.toolbar, 'Copy text').disabled, true); f.view.dispose();
  }
});

test('leaving text preview aborts its request and late completion cannot replace Original', async () => {
  let release, signal;
  const f = fixture('application/json', { fetchContentPreview: (_url, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); } });
  const pending = f.view.ready;
  control(f.view.toolbar, 'Original').click(); const frame = f.view.canvas.querySelector('iframe');
  assert.equal(signal.aborted, true);
  release(jsonResponse('{"stale":true}')); await pending;
  assert.equal(f.view.canvas.querySelector('iframe'), frame); assert.equal(f.view.canvas.querySelector('pre'), null);
  f.view.dispose(); assert.equal(frame.src, 'about:blank');
});

test('disposing a pending text document blocks late publication and is idempotent', async () => {
  let release, signal;
  const f = fixture('text/plain', { fetchContentPreview: (_url, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); } });
  f.view.dispose(); f.view.dispose(); assert.equal(signal.aborted, true);
  release(jsonResponse('late text')); await f.view.ready;
  assert.equal(f.view.canvas.querySelector('pre'), null);
});

test('audio/video use native controls without autoplay and stop loading on disposal', () => {
  for (const [type, tag] of [['audio/mpeg', 'audio'], ['video/mp4', 'video']]) {
    const f = fixture(type); const media = f.view.canvas.querySelector(tag); let paused = 0, unloaded = 0;
    media.pause = () => { paused++; }; media.load = () => { unloaded++; };
    assert.equal(media.attributes.controls, ''); assert.equal(media.attributes.autoplay, undefined); assert.equal(media.attributes.preload, 'metadata');
    media.listeners.loadedmetadata(); assert.match(f.view.canvas.textContent, /press Play/);
    f.view.dispose(); assert.equal(paused, 1); assert.equal(unloaded, 1); assert.equal(media.attributes.src, undefined);
  }
});

test('viewer hides metadata by default without removing Save, Record, Graph, Inspect or bookmarks', () => {
  const f = context(); const result = { target: { kind: 'inscription', value: id, canonical: `inscription:${id}` }, entity: { summary: { id, number: '42', contentType: 'image/png' }, source: { name: 'Fixture Ord' } } };
  const root = renderInscription(result, f.ctx); const info = root.querySelector('.viewer-info');
  assert.equal(info.attributes.hidden, ''); assert.match(root.querySelector('.viewer-title').textContent, /Inscription #42/);
  const image = root.querySelector('img');
  const details = root.querySelectorAll('button').find(node => node.textContent.endsWith('Details'));
  assert.equal(details.attributes['aria-controls'], info.attributes.id); details.click(); assert.equal(info.hidden, false); assert.equal(details.attributes['aria-expanded'], 'true');
  details.click(); assert.equal(info.hidden, true); assert.equal(root.querySelector('img'), image);
  for (const label of ['Save', 'Record', 'Graph', 'Inspect']) control(root, label).click();
  assert.deepEqual(f.calls, [`save:${id}`, `inscription:${id}`, 'graph', 'raw']); root.dispose();
});

test('inscription collector details integrate normalized facts, native links and art-preserving highlights', () => {
  const f = context(), address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', output = `${'b'.repeat(64)}:2`, parent = `${'c'.repeat(64)}i1`;
  const target = { kind: 'inscription', value: id, canonical: `inscription:${id}` };
  const entity = normalizeEntity(target, { id, number: -42, content_type: 'image/png', sat: 45000000000, height: 840123,
    timestamp: 1700000000, fee: 500, value: 546, address, output, charms: ['nineball', 'reinscription'], delegate: parent, parents: [parent] },
  { id: 'fixture', network: 'mainnet', name: 'Fixture Ord', type: 'ord-server' });
  const root = renderInscription({ target, entity }, f.ctx), strip = root.querySelector('.inscription-collector-strip'), details = root.querySelector('.collector-details');
  assert.match(strip.textContent, /Sat rarity: Uncommon.*Reinscription.*9ball/); assert.match(strip.textContent, /in Details/);
  assert.match(details.textContent, /Calculated locally/); assert.match(details.textContent, /Inscription fee500 sats.*Postage · output value546 sats/);
  assert.match(details.textContent, /Scheduled sats in this class: 6,926,535/);
  assert.match(details.textContent, /From negative inscription number/); assert.match(details.textContent, /not an asking price/);
  assert.match(details.textContent, /future sats/); assert.match(details.textContent, /not recursive content depth/);
  assert.match(details.textContent, /Sat mined in block9/); assert.match(details.textContent, /Inscription block840,123/);
  const guides = details.querySelectorAll('details'); assert.ok(guides.every(guide => guide.attributes.open === undefined));
  const technical = root.querySelector('.viewer-source-details'); assert.match(technical.textContent, /45,000,000,000|45000000000/);
  assert.equal(technical.attributes.open, undefined); assert.equal(root.querySelector('.viewer-info').attributes.hidden, '');
  const image = root.querySelector('img'); assert.equal(image.attributes.src, sourceUrl);
  for (const label of ['Reveal transaction', '45,000,000,000', '9', '840,123', 'Delegated content inscription']) control(details, label).click();
  const location = details.querySelectorAll('section').at(-1);
  location.querySelectorAll('button').filter(node => node.textContent !== 'Delegated content inscription').forEach(node => node.click());
  assert.deepEqual(f.calls, [`tx:${'a'.repeat(64)}`, 'sat:45000000000', 'block:9', 'block:840123', `inscription:${parent}`, `address:${address}`, `output:${output}`, `inscription:${parent}`]);
  assert.equal(root.querySelector('img'), image); root.dispose();
});

test('collector view treats missing rarity as unavailable and does not mislabel testnet sats', () => {
  for (const network of ['mainnet', 'regtest']) {
    const f = context(); f.ctx.model.settings.network = network;
    const root = renderInscription({ target: { kind: 'inscription', value: id, canonical: `inscription:${id}` }, entity: { network, summary: { id, contentType: 'image/png', ...(network === 'regtest' ? { sat: '0' } : {}) } } }, f.ctx);
    assert.equal(root.querySelector('.inscription-collector-strip').textContent, 'Sat rarity: Unavailable');
    assert.match(root.querySelector('.collector-details').textContent, /Missing data does not mean this is a common sat/);
    assert.match(root.querySelector('.collector-details').textContent, /Not supplied/);
    if (network === 'regtest') assert.doesNotMatch(root.querySelector('.collector-details').textContent, /6,926,535 sats/);
    root.dispose();
  }
});

test('collector view warns on source contradictions, bounds provenance, and never renders metadata markup', () => {
  const f = context(), parent = `${'c'.repeat(64)}i1`;
  const entity = { network: 'mainnet', summary: { id, contentType: 'image/png', sat: '2', charms: ['mythic', 'nineball', '<img>'] },
    data: { address: 'https://evil.example', output: `${'0'.repeat(64)}:4294967295`, delegate: 'javascript:alert(1)', parents: [...Array(40).fill(parent), 'https://evil.example'], fee: '<img>', value: -1 } };
  const root = renderInscription({ target: { kind: 'inscription', value: id, canonical: `inscription:${id}` }, entity }, f.ctx);
  const details = root.querySelector('.collector-details');
  assert.match(root.querySelector('.inscription-collector-strip').textContent, /Sat rarity: Common.*Source traits disagree/);
  assert.ok(details.querySelector('.collector-warning')); assert.equal(details.querySelectorAll('img').length, 0);
  assert.equal(details.querySelectorAll('a').length, 0); assert.equal(details.querySelectorAll('script').length, 0);
  assert.doesNotMatch(details.textContent, /evil.example|javascript:|<img>/);
  assert.equal(details.querySelector('.collector-parents').querySelectorAll('button').length, 1);
  assert.deepEqual(f.calls, []); root.dispose();
});

test('actual page routing preserves same-entity image state, but disposes on tab, entity and policy replacement', () => {
  const f = context(); f.ctx.model.bootstrap = true;
  const entity = { summary: { id, contentType: 'image/png' } };
  let result = { target: { kind: 'inscription', canonical: `inscription:${id}`, value: id }, entity };
  const page = new TestNode('div'), stage = new TestNode('main');
  const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderPage() {'), end = source.indexOf('\nfunction renderDrawer()', start);
  const scope = { state: () => f.ctx.model, currentResult: () => result, elements: { page, 'main-stage': stage }, context: f.ctx, renderInscription, clear, renderHome: () => new TestNode('home') };
  vm.runInNewContext(`${source.slice(start, end)}\nthis.publish=renderPage;`, scope);
  scope.publish(); let image = page.querySelector('img'); image.naturalWidth = 32; image.naturalHeight = 32; image.listeners.load();
  control(page, 'Actual size').click(); control(page, 'Actual size').focus(); stage.scrollTop = 30;
  scope.publish(); assert.equal(page.querySelector('img'), image); assert.equal(image.style.width, '32px'); assert.equal(stage.scrollTop, 30);
  f.ctx.model.activeTabId = 'b'; scope.publish(); assert.equal(image.attributes.src, undefined); assert.notEqual(page.querySelector('img'), image);
  image = page.querySelector('img'); f.ctx.model.settings.offlineMode = true; scope.publish(); assert.equal(image.attributes.src, undefined);
  image = page.querySelector('img'); result = { ...result, entity: { ...entity } }; scope.publish(); assert.equal(image.attributes.src, undefined);
  image = page.querySelector('img'); result = { target: { kind: 'home', canonical: 'satnav://home' } }; scope.publish(); assert.equal(image.attributes.src, undefined);
});

test('presentation stylesheet pairs foreground/background colors and centers contained images', () => {
  const css = fs.readFileSync(new URL('../src/renderer/inscription-viewer.css', import.meta.url), 'utf8');
  assert.match(css, /\.inscription-image\{[^}]*object-fit:contain;object-position:center/);
  assert.match(css, /\.inscription-image-space\{[^}]*align-items:center;justify-content:center/);
  assert.match(css, /\.inscription-text\{[^}]*background:var\(--document-bg\);color:var\(--canvas-fg\)/);
  assert.match(css, /data-background="light".*--canvas-bg:#eef1f5;--canvas-fg:#18212b/);
  assert.match(css, /max-width:650px/); assert.match(css, /\[hidden\]\{display:none!important\}/);
  assert.doesNotMatch(css, /url\(https?:/);
});
