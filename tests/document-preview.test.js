import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { previewRoute, fontSignature, binaryPreview, previewLink, markdownImage, pdfRenderSize, fetchPreviewBytes } from '../src/shared/document-preview.js';
import { jxlDimensions } from '../src/shared/jxl-header.js';
const id = `${'a'.repeat(64)}i0`;
const jxl = () => Uint8Array.from(Buffer.from('/woIELASCAgQAHAASxiLFcIRbFzg7wOI6L9tOey/tiD9v391/fUHAA==', 'base64'));
test('preview routes accept only the explicit document kinds and canonical complete identifiers', () => {
  for (const kind of ['pdf', 'font', 'markdown', 'jxl', 'binary']) assert.deepEqual(previewRoute(`/${kind}/${id}`), { kind, id });
  for (const path of [`/html/${id}`, `/pdf/${id}/x`, '/pdf/1', `/pdf/${id}?x`, `/pdf/${id}#x`]) assert.equal(previewRoute(path), null);
});
test('font admission inspects table bounds, signatures and expanded sizes before FontFace', async () => {
  const ttf = new Uint8Array(await fs.readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));
  assert.equal(fontSignature(ttf), 'ttf');
  for (const signature of [0x774f4646, 0x774f4632]) {
    const bytes = new Uint8Array(100), view = new DataView(bytes.buffer); view.setUint32(0, signature); view.setUint32(8, 100); view.setUint16(12, 1); view.setUint32(16, 100);
    assert.equal(fontSignature(bytes), signature === 0x774f4646 ? 'woff' : 'woff2'); view.setUint32(16, 16 * 1024 * 1024 + 1); assert.throws(() => fontSignature(bytes));
  }
  const damaged = ttf.slice(); new DataView(damaged.buffer).setUint32(20, ttf.length); new DataView(damaged.buffer).setUint32(24, 100); assert.throws(() => fontSignature(damaged));
  for (const bytes of [new Uint8Array(), new Uint8Array(20), new Uint8Array(4 * 1024 * 1024 + 1), new TextEncoder().encode('<script>not a font</script>')]) assert.throws(() => fontSignature(bytes));
});
test('Markdown navigation and image references are separately restricted with no credential-bearing URLs', () => {
  for (const value of [`/content/${id}`, `ord://content/${id}`, `inscription:${id}`]) { assert.equal(previewLink(value), `inscription:${id}`); assert.equal(markdownImage(value), `ord://thumbnail/${id}`); }
  assert.equal(previewLink('https://example.com/article?q=1'), 'https://example.com/article?q=1');
  for (const value of ['javascript:alert(1)', 'data:text/html,evil', 'app://app/renderer/index.html', 'file:///etc/passwd', 'https://user:pass@example.com/', '//example.com/x', 'https://example.com/\n', 'https://example.com/a b', 'x'.repeat(2049), null]) assert.equal(previewLink(value), null);
  for (const value of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,AAAA', 'data:image/png;base64,' + 'A'.repeat(262145)]) assert.equal(markdownImage(value), null);
  assert.equal(markdownImage('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});
test('binary inspection is bounded and retains byte offsets without interpreting active content', () => {
  const result = binaryPreview(new TextEncoder().encode('<script>not executed</script>' + 'x'.repeat(5000)));
  assert.equal(result.shown, 4096); assert.equal(result.total, 5029); assert.ok(result.text.startsWith('00000000  3c 73 63 72 69 70 74 3e'));
  assert.equal(result.text.split('\n').length, 256); assert.deepEqual(binaryPreview(new Uint8Array()), { text: '', shown: 0, total: 0 });
});
test('PDF rendering bounds both edges and pixel area with finite geometry', () => {
  for (const [width, height, scale] of [[612, 792, 2], [1e6, 1e6, 4], [1, 1e6, 100], [1e6, 1, 100]]) { const size = pdfRenderSize(width, height, scale); assert.ok(size.width <= 8192 && size.height <= 8192 && size.width * size.height <= 8_388_608); }
  for (const args of [[0, 100, 1], [100, Infinity, 1], [1, 1, NaN], [1, 1, -1], [1e6 + 1, 10, 1]]) assert.throws(() => pdfRenderSize(...args));
});
test('JPEG XL raw and boxed codestreams are checked before decoding', () => {
  assert.deepEqual(jxlDimensions(jxl()), { width: 2, height: 2 });
  const box = (type, bytes) => { const result = Buffer.alloc(8 + bytes.length); result.writeUInt32BE(result.length); result.write(type, 4); result.set(bytes, 8); return result; };
  const signature = Buffer.from([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]);
  assert.deepEqual(jxlDimensions(Buffer.concat([signature, box('jxlc', jxl())])), { width: 2, height: 2 });
  const first = Buffer.concat([Buffer.from([0, 0, 0, 0]), jxl().subarray(0, 20)]), last = Buffer.concat([Buffer.from([128, 0, 0, 1]), jxl().subarray(20)]);
  assert.deepEqual(jxlDimensions(Buffer.concat([signature, box('jxlp', first), box('jxlp', last)])), { width: 2, height: 2 });
  for (const bad of [Buffer.alloc(20), jxl().subarray(0, 3), Buffer.concat([signature, box('jxlc', jxl()), box('jxlc', jxl())]), Buffer.concat([signature, box('jxlp', last)]), Buffer.concat([signature, box('jxlp', first)]), Buffer.concat([signature, Buffer.from([255, 255, 255, 255, 1, 2, 3, 4])])]) assert.throws(() => jxlDimensions(bad));
  // Long-form size header requests over a billion pixels: reject before WASM.
  const huge = new Uint8Array(20); huge[0] = 255; huge[1] = 10; huge.fill(255, 2); huge[2] = 254; assert.throws(() => jxlDimensions(huge));
});
test('preview downloads omit credentials, reject redirects, bound streamed bytes and respect cancellation', async () => {
  let options;
  const fetcher = async (_url, value) => { options = value; return new Response('abc', { headers: { 'x-satoshi-content-type': 'font/woff2' } }); };
  const response = await fetchPreviewBytes('ord://document-data/font/id', { fetcher, maxBytes: 3 }); assert.equal(response.type, 'font/woff2'); assert.equal(new TextDecoder().decode(response.data), 'abc');
  assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
  for (const fixture of [new Response('abcd'), new Response('abc', { headers: { 'content-length': '100' } }), new Response('bad', { status: 413 }), new Response('bad', { status: 500 })]) await assert.rejects(fetchPreviewBytes('x', { maxBytes: 3, fetcher: async () => fixture }));
  const abort = new AbortController(), reason = new Error('obsolete'); abort.abort(reason); await assert.rejects(fetchPreviewBytes('x', { signal: abort.signal, maxBytes: 3, fetcher }), error => error === reason);
  const late = new AbortController(); await assert.rejects(fetchPreviewBytes('x', { signal: late.signal, maxBytes: 3, fetcher: async () => { late.abort(reason); return new Response('abc'); } }), error => error === reason);
});
