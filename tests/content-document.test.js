import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolveDocumentContent, DOCUMENT_CSP } from '../src/main/content-document.js';
import { DOCUMENT_LIMITS } from '../src/shared/document-preview.js';
import { installContentProtocol } from '../src/main/content-protocol.js';
const id = `${'a'.repeat(64)}i0`, request = (path, init) => new Request(`ord://${path}`, init);
const result = (type = 'application/pdf', data = Buffer.from('%PDF-1.7')) => ({ status: 200, data, headers: { 'content-type': type, 'set-cookie': 'private', 'x-provider-secret': 'private', 'location': 'https://invalid.example' } });
test('document routes reject unapproved methods, authorities, IDs, parameters and assets before provider access', async () => {
  let calls = 0; const resolver = { resolve: async () => { calls++; return result(); } };
  for (const path of [`document-data/pdf/${id}?x=1`, `document-data/pdf/${id}#x`, `u@document-data/pdf/${id}`, `document-data:80/pdf/${id}`, `document-data/pdf/${id}/extra`, `document-data/html/${id}`, `document-data/pdf/not-id`, `content/pdf/${id}`,
    'document-viewer/assets/../../../package.json', 'document-viewer/assets/pdf.sandbox.mjs', 'document-viewer/assets/wasm/quickjs-eval.wasm', 'document-viewer/assets/jxl/encode.js', 'document-viewer/assets/%2e%2e/package.json', 'document-viewer/assets/standard_fonts/../../package.json']) await assert.rejects(resolveDocumentContent({ url: `ord://${path}`, method: 'GET' }, resolver));
  await assert.rejects(resolveDocumentContent(request(`document-data/pdf/${id}`, { method: 'POST' }), resolver), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(calls, 0);
});
test('document responses enforce actual MIME, status and per-kind byte budgets with inert headers', async () => {
  for (const [kind, type] of [['pdf', 'application/pdf'], ['font', 'font/woff2'], ['markdown', 'text/markdown'], ['jxl', 'image/jxl'], ['binary', 'application/cbor']]) {
    const calls = []; const abort = new AbortController(); const req = request(`document-data/${kind}/${id}`, { signal: abort.signal });
    const response = await resolveDocumentContent(req, { resolve: async (...args) => { calls.push(args); return result(type); } });
    assert.deepEqual(calls[0], [`ord://content/${id}`, { maxBytes: DOCUMENT_LIMITS[kind], accept: '*/*', signal: req.signal }]);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.equal(response.headers.get('x-satoshi-content-type'), type);
    for (const key of ['set-cookie', 'x-provider-secret', 'location']) assert.equal(response.headers.has(key), false);
    assert.equal(response.headers.get('access-control-allow-origin'), '*'); assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const head = await resolveDocumentContent(request(`document-data/${kind}/${id}`, { method: 'HEAD' }), { resolve: async () => result(type) }); assert.equal(await head.text(), '');
    await assert.rejects(resolveDocumentContent(req, { resolve: async () => ({ ...result(type), status: 206 }) }), { code: 'PREVIEW_UNAVAILABLE' });
    await assert.rejects(resolveDocumentContent(req, { resolve: async () => result(type, Buffer.alloc(DOCUMENT_LIMITS[kind] + 1)) }), { code: 'RESOURCE_TOO_LARGE' });
    if (kind !== 'binary') await assert.rejects(resolveDocumentContent(req, { resolve: async () => result('text/html') }), { code: 'PREVIEW_UNAVAILABLE' });
  }
});
test('Markdown charset conversion is explicit, bounded and never silently replaces invalid bytes', async () => {
  const response = await resolveDocumentContent(request(`document-data/markdown/${id}`), { resolve: async () => result('text/markdown;charset=windows-1252', Buffer.from([0x63, 0x61, 0x66, 0xe9])) });
  assert.equal(await response.text(), 'café');
  for (const fixture of [result('text/markdown', Buffer.from([255])), result('text/markdown;charset=unknown'), result('text/markdown;charset=windows-1252', Buffer.alloc(DOCUMENT_LIMITS.markdown, 233))]) await assert.rejects(resolveDocumentContent(request(`document-data/markdown/${id}`), { resolve: async () => fixture }));
});
test('every document shell is script-only opaque and fixed local assets are available without a provider', async () => {
  for (const kind of Object.keys(DOCUMENT_LIMITS)) {
    const response = await resolveDocumentContent(request(`document-viewer/${kind}/${id}`));
    assert.equal(response.headers.get('content-security-policy'), DOCUMENT_CSP); assert.match(await response.text(), /ord:\/\/document-viewer\/assets\/viewer.js/);
  }
  for (const directive of ["sandbox allow-scripts", "frame-src 'none'", "object-src 'none'", "worker-src blob:", 'frame-ancestors app://app']) assert.ok(DOCUMENT_CSP.includes(directive));
  assert.doesNotMatch(DOCUMENT_CSP, /https?:|wss?:|'unsafe-eval'|connect-src[^;]*app:/);
  for (const asset of ['viewer.js', 'viewer.css', 'markdown.js', 'pdf.js', 'bundled-worker.js', 'jxl.js', 'jxl-worker.js', 'document-preview.js', 'jxl-header.js', 'marked.mjs', 'pdf.mjs', 'pdf.worker.js', 'jxl.worker.js', 'jxl/decode.js', 'jxl/utils.js', 'jxl/codec/dec/jxl_dec.js', 'jxl/codec/dec/jxl_dec.wasm', 'cmaps/78-EUC-H.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'wasm/qcms_bg.wasm', 'iccs/CGATS001Compat-v2-micro.icc']) {
    const response = await resolveDocumentContent(request(`document-viewer/assets/${asset}`)); assert.equal(response.status, 200, asset); assert.ok(Number(response.headers.get('content-length')) > 0, asset);
  }
});
test('reader dependencies and production lockfile versions are exactly pinned with bundled licenses', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))), lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url)));
  for (const name of ['pdfjs-dist', 'marked', '@jsquash/jxl']) { assert.match(pkg.dependencies[name], /^\d+\.\d+\.\d+$/); assert.equal(lock.packages[`node_modules/${name}`].version, pkg.dependencies[name]); await fs.access(new URL(`../node_modules/${name}/LICENSE`, import.meta.url)); }
});
test('document cancellation cannot publish obsolete data and protocol errors stay inert', async () => {
  for (const before of [true, false]) {
    const abort = new AbortController(), reason = new Error('obsolete'); if (before) abort.abort(reason);
    await assert.rejects(resolveDocumentContent(request(`document-data/pdf/${id}`, { signal: abort.signal }), { resolve: async () => { abort.abort(reason); return result(); } }), error => error === reason);
  }
  let handler; installContentProtocol({ protocol: { handle: (_scheme, fn) => { handler = fn; } } }, { resolve: async () => result('text/html') }, { get: () => ({}) });
  const response = await handler(request(`document-data/pdf/${id}`)); assert.equal(response.status, 415); assert.equal(response.headers.get('access-control-allow-origin'), '*'); assert.deepEqual(await response.json(), { code: 'PREVIEW_UNAVAILABLE' });
});
