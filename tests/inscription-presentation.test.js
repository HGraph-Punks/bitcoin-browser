import test from 'node:test';
import assert from 'node:assert/strict';
import { inscriptionPresentation, isReadableInscription, presentInscriptionText, MAX_INSCRIPTION_TEXT_BYTES } from '../src/shared/inscription-presentation.js';
import { resolveInscriptionText } from '../src/main/content-text.js';
import { installContentProtocol } from '../src/main/content-protocol.js';

const id = `${'a'.repeat(64)}i0`;
const url = `ord://text/${id}`;
const result = (data = '{"p":"brc-20","op":"mint","tick":"ordi","amt":"1000"}', type = 'text/plain;charset=utf-8') => ({ status: 200, data: Buffer.from(data), headers: { 'content-type': type, 'x-provider-secret': 'must-not-forward', 'set-cookie': 'must-not-forward' }, cache: 'hit' });

test('presentation classifies readable data and media without interpreting active markup as text', () => {
  for (const type of ['image/png', 'IMAGE/JPEG; charset=binary', 'image/gif', 'image/svg+xml', 'image/webp', 'image/avif']) assert.equal(inscriptionPresentation(type), 'image');
  for (const type of ['text/plain', 'application/json', 'application/ld+json', 'text/javascript', 'application/xml']) assert.equal(inscriptionPresentation(type), 'text');
  for (const type of ['text/html', 'application/xhtml+xml', 'text/html; charset=utf-8']) assert.equal(inscriptionPresentation(type), 'original');
  assert.equal(inscriptionPresentation('text/markdown'), 'markdown'); assert.equal(inscriptionPresentation('application/pdf'), 'pdf');
  for (const type of ['application/octet-stream', '']) assert.equal(inscriptionPresentation(type), 'binary');
  assert.equal(inscriptionPresentation('video/mp4'), 'video'); assert.equal(inscriptionPresentation('audio/mpeg'), 'audio');
  assert.equal(isReadableInscription('image/svg+xml'), false);
});

test('JSON presentation preserves large numbers, spelling, escapes, duplicate keys and source text', () => {
  const text = '{"n":340282366920938463463374607431768211455,"n":1e+30,"tiny":0.000000000000000001,"data":"<script>\\\"x\\\"</script>","empty":{},"array":[],"bool":false,"null":null}';
  const shown = presentInscriptionText(text);
  assert.equal(shown.isJson, true); assert.match(shown.formatted, /\n  "n": 340282366920938463463374607431768211455/);
  assert.match(shown.formatted, /"n": 1e\+30/); assert.match(shown.formatted, /0\.000000000000000001/);
  assert.equal((shown.formatted.match(/"n":/g) ?? []).length, 2);
  assert.match(shown.formatted, /"empty": \{\}/); assert.match(shown.formatted, /"array": \[\]/);
  assert.deepEqual(JSON.parse(shown.formatted), JSON.parse(text));
  for (const source of ['', 'hello\nworld', '<h1>do not execute</h1>', '{invalid}', '\t  plain text  \n']) assert.deepEqual(presentInscriptionText(source), { isJson: false, formatted: source });
  for (const source of ['123456789012345678901234567890', 'true', 'null', '"text"']) assert.equal(presentInscriptionText(source).formatted, source);
});

test('large/deep JSON formatting is bounded and returns the original rather than truncating', () => {
  const deep = '['.repeat(40) + '0' + ']'.repeat(40);
  assert.equal(presentInscriptionText(deep).formatted, deep);
  const many = JSON.stringify(Array(5001).fill(1));
  assert.equal(presentInscriptionText(many).formatted, many);
  assert.throws(() => presentInscriptionText('x'.repeat(MAX_INSCRIPTION_TEXT_BYTES + 1)));
});

test('text projection admits only exact inscription IDs and GET/HEAD before resolving', async () => {
  const calls = [];
  const resolver = { resolve: async (...args) => { calls.push(args); return result(); } };
  for (const invalid of [`ord://text/${id}?mode=x`, `ord://text/${id}#x`, `ord://user@text/${id}`, `ord://text/${id}/extra`, `ord://text/%2f${id}`, `ord://text/${'a'.repeat(64)}i12345678901`, `ord://content/${id}`]) await assert.rejects(resolveInscriptionText({ url: invalid, method: 'GET' }, resolver), { code: 'UNSAFE_ORD_PATH' });
  await assert.rejects(resolveInscriptionText({ url, method: 'POST' }, resolver), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  const response = await resolveInscriptionText({ url: `ord://text/${id.toUpperCase().replace('I', 'i')}`, method: 'GET', signal: controller.signal }, resolver);
  assert.equal(response.status, 200); assert.equal(calls[0][0], `ord://content/${id}`);
  assert.deepEqual(calls[0][1], { accept: '*/*', maxBytes: MAX_INSCRIPTION_TEXT_BYTES, signal: controller.signal });
  const head = await resolveInscriptionText({ url, method: 'HEAD' }, resolver); assert.equal(await head.text(), '');
});

test('text projection rebuilds inert JSON headers and preserves untrusted content as data only', async () => {
  const source = '<script>window.satBrowser.wallet.open()</script>\n& "quoted"';
  const response = await resolveInscriptionText(new Request(url), { resolve: async () => result(source) });
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(response.headers.has('set-cookie'), false); assert.equal(response.headers.has('x-provider-secret'), false);
  const body = await response.json(); assert.equal(body.text, source); assert.equal(body.bytes, Buffer.byteLength(source)); assert.equal(body.cache, 'hit');
});

test('actual response MIME wins over metadata: HTML, SVG, binary and partial responses cannot enter text preview', async () => {
  for (const type of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/octet-stream', 'image/png']) await assert.rejects(resolveInscriptionText(new Request(url), { resolve: async () => result('<script>x</script>', type) }), { code: 'TEXT_PREVIEW_UNAVAILABLE' });
  await assert.rejects(resolveInscriptionText(new Request(url), { resolve: async () => ({ ...result(), status: 206 }) }), { code: 'TEXT_PREVIEW_UNAVAILABLE' });
  await assert.rejects(resolveInscriptionText(new Request(url), { resolve: async () => ({ ...result(), data: Buffer.alloc(MAX_INSCRIPTION_TEXT_BYTES + 1) }) }), { code: 'RESOURCE_TOO_LARGE' });
  const empty = await resolveInscriptionText(new Request(url), { resolve: async () => result('') }); assert.equal((await empty.json()).text, '');
});

test('text preview decodes declared encodings without replacing invalid bytes silently', async () => {
  const latin = await resolveInscriptionText(new Request(url), { resolve: async () => ({ ...result('', 'text/plain; charset="windows-1252"'), data: Buffer.from([0x63, 0x61, 0x66, 0xe9]) }) });
  assert.equal((await latin.json()).text, 'café');
  for (const fixture of [{ ...result(), data: Buffer.from([0xff]) }, result('text', 'text/plain; charset=unknown-encoding')]) await assert.rejects(resolveInscriptionText(new Request(url), { resolve: async () => fixture }), { code: 'TEXT_PREVIEW_UNAVAILABLE' });
});

test('text preview enforces cancellation before admission, after data and after late transport rejection', async () => {
  for (const stage of ['before', 'after', 'reject']) {
    const controller = new AbortController(); const reason = new Error('obsolete viewer'); let calls = 0;
    if (stage === 'before') controller.abort(reason);
    await assert.rejects(resolveInscriptionText({ url, method: 'GET', signal: controller.signal }, { resolve: async () => {
      calls++; controller.abort(reason); if (stage === 'reject') throw new Error('late failure'); return result();
    } }), error => error === reason);
    assert.equal(calls, stage === 'before' ? 0 : 1);
  }
});

test('registered text projection returns safe CORS-readable errors and retains original content unchanged', async () => {
  let handler;
  const fixture = result();
  installContentProtocol({ protocol: { handle: (_scheme, value) => { handler = value; } } }, { resolve: async () => fixture }, { get: () => ({}) });
  const response = await handler(new Request(url)); assert.equal((await response.json()).text, fixture.data.toString());
  const original = await handler(new Request(`ord://content/${id}`)); assert.deepEqual(Buffer.from(await original.arrayBuffer()), fixture.data);
  fixture.data = Buffer.alloc(MAX_INSCRIPTION_TEXT_BYTES + 1);
  const error = await handler(new Request(url)); assert.equal(error.status, 413); assert.equal(error.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await error.json(), { code: 'RESOURCE_TOO_LARGE' });
});
