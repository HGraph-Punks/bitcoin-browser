import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, gzipSync, deflateSync } from 'node:zlib';
import { decodedContentBytes } from '../src/main/content-decoding.js';
import { installContentProtocol } from '../src/main/content-protocol.js';

const id = `${'a'.repeat(64)}i0`;
const encoders = { br: brotliCompressSync, gzip: gzipSync, deflate: deflateSync };
for (const [encoding, encode] of Object.entries(encoders)) {
  test(`${encoding}: preview decodes once, input remains unchanged and expansion is bounded`, async () => {
    const original = Buffer.from('Readable inscription\n'.repeat(100));
    const data = encode(original), copy = Buffer.from(data), result = { data, headers: { 'content-encoding': encoding } };
    assert.deepEqual(await decodedContentBytes(result, 4096), original); assert.deepEqual(data, copy);
    await assert.rejects(decodedContentBytes({ ...result, data: encode(Buffer.alloc(8192)) }, 1024), { code: 'RESOURCE_TOO_LARGE', status: 413 });
    await assert.rejects(decodedContentBytes({ ...result, data: Buffer.from('damaged') }, 1024), { code: 'CONTENT_DECODE_FAILED', status: 415 });
  });
  test(`${encoding}: text, image, model, document and binary projections decode without changing Original`, async () => {
    for (const [path, type, original] of [
      ['text', 'text/plain', Buffer.from('Hello compressed world')], ['thumbnail', 'image/apng', Buffer.from([1, 2, 3])],
      ['model-data', 'model/stl', Buffer.from('solid test\nendsolid test')], ['document-data/pdf', 'application/pdf', Buffer.from('%PDF-1.7')],
      ['document-data/markdown', 'text/markdown;charset=utf-8', Buffer.from('# Compressed heading')], ['document-data/binary', 'application/cbor', Buffer.from([0xa1, 0, 1])]
    ]) {
      let handler; const wire = encode(original);
      installContentProtocol({ protocol: { handle: (_scheme, fn) => { handler = fn; } } }, { resolve: async () => ({ status: 200, data: wire, headers: { 'content-type': type, 'content-encoding': encoding } }) }, { get: () => ({}) });
      const preview = await handler(new Request(`ord://${path}/${id}`)); assert.equal(preview.status, 200); assert.equal(preview.headers.has('content-encoding'), false);
      if (path === 'text') assert.equal((await preview.json()).text, original.toString()); else assert.deepEqual(Buffer.from(await preview.arrayBuffer()), original);
      const raw = await handler(new Request(`ord://content/${id}`)); assert.equal(raw.headers.get('content-encoding'), encoding); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), wire);
    }
  });
}
test('identity is not decoded; unknown/chained encoding, oversize bytes and invalid data fail closed', async () => {
  const data = Buffer.from('abc'); assert.equal(await decodedContentBytes({ data, headers: {} }, 10), data);
  assert.equal(await decodedContentBytes({ data, headers: { 'content-encoding': 'identity' } }, 10), data);
  for (const encoding of ['zstd', 'br,gzip', 'unknown']) await assert.rejects(decodedContentBytes({ data, headers: { 'content-encoding': encoding } }, 10), { code: 'CONTENT_ENCODING_UNSUPPORTED' });
  for (const invalid of ['abc', Buffer.alloc(11)]) await assert.rejects(decodedContentBytes({ data: invalid }, 10), { code: 'RESOURCE_TOO_LARGE' });
});
test('aborted previews preserve cancellation before and during bounded decoding', async () => {
  for (const before of [true, false]) {
    const abort = new AbortController(), reason = new Error('obsolete'); if (before) abort.abort(reason);
    const pending = decodedContentBytes({ data: brotliCompressSync(Buffer.alloc(10000)), headers: { 'content-encoding': 'br' } }, 20000, abort.signal);
    if (!before) abort.abort(reason); await assert.rejects(pending, error => error === reason);
  }
});
