import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { pdfFixture, JXL_CHECKER, STL_TRIANGLE } from './fixtures/document-formats.js';
import { fontSignature, pdfRenderSize } from '../src/shared/document-preview.js';
import { jxlDimensions } from '../src/shared/jxl-header.js';
import { validateStlDocument } from '../src/shared/model-inscription.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { resolveDocumentContent } from '../src/main/content-document.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.text = ''; this.listeners = {}; this.attributes = {}; this.style = {}; this.clientWidth = 800; }
  set textContent(value) { this.text = String(value); this.children = []; } get textContent() { return this.text + this.children.map(x => x.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; this.text = ''; }
  addEventListener(type, handler) { this.listeners[type] = handler; } setAttribute(key, value) { this.attributes[key] = value; }
  all(tag) { return this.children.flatMap(node => [...(node.tagName === tag ? [node] : []), ...node.all(tag)]); }
  getContext() { return {}; }
}
const doc = { createElement: tag => new Element(tag) };
async function documentModule(name, extra = {}) {
  let source = await fs.readFile(new URL(`../src/document-viewer/${name}.js`, import.meta.url), 'utf8');
  const aliases = { './document-preview.js': new URL('../src/shared/document-preview.js', import.meta.url).href, './marked.mjs': new URL('../node_modules/marked/lib/marked.esm.js', import.meta.url).href, ...extra };
  for (const [specifier, replacement] of Object.entries(aliases)) source = source.replaceAll(`from '${specifier}'`, `from '${replacement}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
test('real Markdown lexer renders headings, lists, tables and code through DOM text without active markup', async () => {
  const { renderMarkdown } = await documentModule('markdown'), links = [];
  const article = renderMarkdown('# A readable heading\n\nA **bold** and *italic* paragraph.\n\n- [x] Completed\n- Ordinary item\n\n| Name | Value |\n| --- | --- |\n| Test | 123 |\n\n```js\nalert("display only");\n```\n\n<script>globalThis.secret()</script>\n\n[Open](https://example.com) [Bad](javascript:alert%281%29)\n\n![Not fetched](https://example.com/tracker.png)', { document: doc, onLink: value => links.push(value) });
  assert.equal(article.all('h1')[0].textContent, 'A readable heading'); assert.equal(article.all('strong')[0].textContent, 'bold'); assert.equal(article.all('table').length, 1); assert.equal(article.all('li').length, 2);
  assert.match(article.all('pre')[0].textContent, /alert/); assert.equal(article.all('script').length, 0); assert.equal(article.all('img').length, 0); assert.match(article.textContent, /<script>/);
  const buttons = article.all('button'); assert.equal(buttons.length, 1); buttons[0].listeners.click(); assert.deepEqual(links, ['https://example.com/']);
  const reference = `${'a'.repeat(64)}i0`, image = renderMarkdown(`![On chain](/content/${reference})`, { document: doc }); assert.equal(image.all('img')[0].src, `ord://thumbnail/${reference}`);
});
test('Markdown complexity is capped before creating unbounded DOM trees', async () => {
  const { renderMarkdown } = await documentModule('markdown'); assert.throws(() => renderMarkdown('**x** '.repeat(8000), { document: doc }), { code: 'PREVIEW_INVALID' });
});
test('actual bundled PDF engine parses two pages, respects rotation, extracts text and paints real pixels without running OpenAction', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: pdfFixture(), verbosity: pdfjs.VerbosityLevel.ERRORS, enableXfa: false, disableAutoFetch: true, standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href });
  try {
    const pdf = await task.promise; assert.equal(pdf.numPages, 2);
    for (const number of [1, 2]) {
      const page = await pdf.getPage(number); assert.equal(page.rotate, number === 1 ? 0 : 90);
      const base = page.getViewport({ scale: 1 }), size = pdfRenderSize(base.width, base.height, 1), canvas = createCanvas(size.width, size.height), context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: page.getViewport({ scale: size.scale }), annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let colored = 0, light = 0;
      for (let i = 0; i < pixels.length; i += 4) { if (pixels[i] > 180 && pixels[i + 1] > 100 && pixels[i + 2] < 120) colored++; if (pixels[i] > 210 && pixels[i + 1] > 210 && pixels[i + 2] > 210) light++; }
      assert.ok(colored > 14000); assert.ok(light > 1000); const text = await page.getTextContent(); assert.match(text.items.map(item => item.str).join(' '), /Inscription format test/); page.cleanup();
    }
    assert.equal(globalThis.__pdfScriptMustNotRun, undefined);
  } finally { await task.destroy(); }
});
test('actual local JPEG XL WASM decoder reproduces an authored lossless 2x2 RGBA fixture', async () => {
  const { default: decode, init } = await import('@jsquash/jxl/decode.js');
  await init({ wasmBinary: new Uint8Array(await fs.readFile(new URL('../node_modules/@jsquash/jxl/codec/dec/jxl_dec.wasm', import.meta.url))), print() {}, printErr() {} });
  const bytes = new Uint8Array(Buffer.from(JXL_CHECKER, 'base64')); assert.deepEqual(jxlDimensions(bytes), { width: 2, height: 2 });
  const result = await decode(bytes.buffer); assert.equal(result.width, 2); assert.equal(result.height, 2);
  assert.deepEqual([...result.data], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
});
test('STL validation and the real Three.js loader agree for ASCII and binary geometry', () => {
  const binary = new Uint8Array(134), view = new DataView(binary.buffer); view.setUint32(80, 1, true);
  [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => view.setFloat32(84 + index * 4, value, true));
  for (const data of [new TextEncoder().encode(STL_TRIANGLE), binary]) { assert.equal(validateStlDocument(data).triangles, 1); const geometry = new STLLoader().parse(data.buffer); assert.equal(geometry.getAttribute('position').count, 3); geometry.dispose(); }
  assert.equal(validateStlDocument(new TextEncoder().encode(STL_TRIANGLE + '\n'.repeat(200) + STL_TRIANGLE)).triangles, 2);
  view.setFloat32(96, Infinity, true); assert.throws(() => validateStlDocument(binary));
  for (const value of ['solid empty\nendsolid empty', STL_TRIANGLE.replace('1 0 0', 'NaN 0 0'), STL_TRIANGLE.replace('endfacet', ''), STL_TRIANGLE + '<script>bad</script>']) assert.throws(() => validateStlDocument(new TextEncoder().encode(value)));
  const tooMany = new Uint8Array(84 + 250001 * 50); new DataView(tooMany.buffer).setUint32(80, 250001, true); assert.throws(() => validateStlDocument(tooMany), { code: 'MODEL_LIMIT' });
});
test('PDF reader wiring keeps executable services absent and owns resource cleanup', async () => {
  const pdf = await fs.readFile(new URL('../src/document-viewer/pdf.js', import.meta.url), 'utf8');
  assert.match(pdf, /enableXfa: false/); assert.match(pdf, /worker, verbosity/); assert.match(pdf, /useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory/);
  for (const name of ['port?.terminate()', 'worker?.destroy()', 'renderTask?.cancel()', 'loadingTask?.destroy()', 'bundled?.dispose()', 'selected.cleanup()']) assert.ok(pdf.includes(name));
  assert.doesNotMatch(pdf, /eval\(|innerHTML|AnnotationLayer|XfaLayer|ScriptingManager|pdf\.sandbox|window\.open|wallet\./);
  assert.match(pdf, /annotationMode: pdfjs.AnnotationMode.DISABLE/);
  const viewer = await fs.readFile(new URL('../src/document-viewer/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /fontSignature\(data\), font = new FontFace/); assert.match(viewer, /document\.fonts\.delete\(font\)/); assert.doesNotMatch(viewer, /innerHTML|eval\(|satBrowser\./);
});

test('worker preparation admits only exact generated local assets and revokes every owned URL', async () => {
  const { prepareBundledWorker } = await documentModule('bundled-worker');
  for (const entry of ['pdf.worker.mjs', 'jxl-worker.js']) {
    const blobs = new Map(), revoked = [], requests = [];
    const bundle = await prepareBundledWorker(entry, { fetcher: (url, options) => { requests.push(url); return resolveDocumentContent(new Request(url, options)); },
      createObjectURL: blob => { const url = `blob:fixture-${blobs.size}`; blobs.set(url, blob); return url; }, revokeObjectURL: url => revoked.push(url) });
    assert.ok(blobs.has(bundle.url)); assert.equal(requests.length, 1);
    for (const url of requests) assert.ok(url.startsWith('ord://document-viewer/assets/'));
    if (entry === 'jxl-worker.js') for (const blob of blobs.values()) assert.doesNotMatch(await blob.text(), /from '\.\//);
    bundle.dispose(); bundle.dispose(); assert.deepEqual(new Set(revoked), new Set(blobs.keys())); assert.equal(revoked.length, blobs.size);
  }
  await assert.rejects(prepareBundledWorker('https://evil.example/script.js'));
  const abort = new AbortController(); abort.abort(); await assert.rejects(prepareBundledWorker('pdf.worker.mjs', { signal: abort.signal }));
});

test('generated PDF worker executes as a classic script and announces its real message-handler readiness', async () => {
  const source = await fs.readFile(new URL('../src/document-viewer/generated/pdf.worker.js', import.meta.url), 'utf8'), messages = [];
  const scope = { onmessage: null, postMessage: value => messages.push(value), addEventListener() {}, removeEventListener() {}, TextDecoder, TextEncoder, URL, console, AbortController };
  scope.self = scope;
  new vm.Script(source).runInNewContext(scope, { timeout: 2000 });
  assert.ok(messages.some(value => value.sourceName === 'worker' && value.targetName === 'main' && value.action === 'ready'));
  assert.equal(typeof scope.pdfjsWorker.WorkerMessageHandler, 'function');
});

test('generated JPEG XL classic worker decodes transferred data without a network function', async () => {
  const source = await fs.readFile(new URL('../src/document-viewer/generated/jxl.worker.js', import.meta.url), 'utf8');
  let listener, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const scope = { onmessage: null, postMessage: value => finish(value), addEventListener: (_name, fn) => { listener = fn; }, TextDecoder, TextEncoder, URL, console, Uint8Array, Uint8ClampedArray, ArrayBuffer, WebAssembly, ImageData, setTimeout, clearTimeout,
    location: { href: 'blob:null/test-worker' }, importScripts() { throw new Error('No external scripts in this fixture'); } };
  scope.self = scope;
  new vm.Script(source).runInNewContext(scope, { timeout: 2000 });
  const data = new Uint8Array(Buffer.from(JXL_CHECKER, 'base64')), wasmBinary = new Uint8Array(await fs.readFile(new URL('../node_modules/@jsquash/jxl/codec/dec/jxl_dec.wasm', import.meta.url)));
  await listener({ data: { data, wasmBinary } }); const result = await done;
  assert.equal(result.width, 2); assert.equal(result.height, 2); assert.deepEqual([...result.pixels], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  for (const name of ['pdf', 'jxl']) {
    const viewer = await fs.readFile(new URL(`../src/document-viewer/${name}.js`, import.meta.url), 'utf8'); assert.match(viewer, /new Worker\(bundled.url, \{ type: 'classic'/); assert.doesNotMatch(viewer, /type: 'module'/);
  }
});

test('PDF controls exercise page navigation, zoom, rotation, text mode and cleanup through the real reader controller', async () => {
  const calls = [], pages = [], failures = []; let destroyed = 0;
  const api = {
    AnnotationMode: { DISABLE: 0 }, VerbosityLevel: { ERRORS: 0 }, PDFWorker: class { destroy() { destroyed++; } },
    getDocument(options) { calls.push(options); return { promise: Promise.resolve({ numPages: 2, getPage: async number => {
      pages.push(number); return { rotate: number === 2 ? 90 : 0, getViewport: ({ scale, rotation = 0 }) => ({ width: (rotation % 180 ? 792 : 612) * scale, height: (rotation % 180 ? 612 : 792) * scale }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }), getTextContent: async () => ({ items: [{ str: `Page ${number} text`, hasEOL: true }] }), cleanup() {} };
    } }), destroy: async () => { destroyed++; } }; }
  };
  globalThis.__pdfFixtureApi = api; globalThis.document = doc; let workersClosed = 0;
  globalThis.Worker = class { addEventListener() {} terminate() { workersClosed++; } };
  const pdfModule = `const api = globalThis.__pdfFixtureApi; export const {AnnotationMode, VerbosityLevel, PDFWorker, getDocument}=api;`;
  const workerModule = 'export async function prepareBundledWorker(){return {url:"blob:fixture",dispose(){}};}';
  try {
    const { createPdfPreview } = await documentModule('pdf', { './pdf.mjs': `data:text/javascript;base64,${Buffer.from(pdfModule).toString('base64')}`, './bundled-worker.js': `data:text/javascript;base64,${Buffer.from(workerModule).toString('base64')}` });
    const stage = new Element('div'), controls = new Element('div'), status = new Element('p'), abort = new AbortController();
    const preview = createPdfPreview(new Uint8Array([1]), { stage, controls, status, signal: abort.signal, onFailure: error => failures.push(error) }); await preview.ready;
    const click = async label => { controls.children.find(node => node.textContent === label).listeners.click(); await new Promise(resolve => setImmediate(resolve)); };
    assert.match(status.textContent, /Page 1 of 2/); const firstWidth = stage.children[0].width;
    await click('+'); assert.ok(stage.children[0].width > firstWidth); await click('Fit width'); assert.equal(stage.children[0].width, firstWidth);
    await click('Next'); assert.match(status.textContent, /Page 2 of 2/); await click('Rotate'); assert.ok(stage.children[0].height > stage.children[0].width);
    await click('Read text'); assert.match(stage.textContent, /Page 2 text/); await click('Page view'); assert.equal(stage.children[0].tagName, 'canvas');
    await click('Previous'); assert.match(status.textContent, /Page 1 of 2/);
    const input = controls.children.find(node => node.type === 'number'); input.value = '2'; input.listeners.change(); await new Promise(resolve => setImmediate(resolve)); assert.match(status.textContent, /Page 2 of 2/);
    input.value = '999'; input.listeners.change(); assert.equal(input.value, '2');
    assert.equal(calls[0].enableXfa, false); assert.equal(calls[0].useWorkerFetch, false); assert.deepEqual(failures, []);
    preview.dispose(); preview.dispose(); assert.equal(destroyed, 2); assert.equal(workersClosed, 1);
  } finally { delete globalThis.__pdfFixtureApi; delete globalThis.Worker; delete globalThis.document; }
});
