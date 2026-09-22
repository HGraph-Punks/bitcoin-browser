import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/shared/errors.js';
import { MAX_THUMBNAIL_BYTES, resolveThumbnail } from '../src/main/content-thumbnail.js';
import { installContentProtocol } from '../src/main/content-protocol.js';

const upperId = `${'A'.repeat(64)}i12`;
const id = upperId.toLowerCase();
const url = `ord://thumbnail/${upperId}`;

function result(overrides = {}) {
  return {
    status: 200,
    headers: { 'content-type': 'image/png; charset=binary', 'x-provider-secret': 'remove-me', 'set-cookie': 'remove-me' },
    data: Buffer.from([1, 2, 3]),
    ...overrides
  };
}

function protocolFixture(resolve, logger = null) {
  let handler;
  installContentProtocol({ protocol: { handle(scheme, value) { assert.equal(scheme, 'ord'); handler = value; } } },
    { resolve }, { get: () => ({ contentNetworkPolicy: 'blocked', offlineMode: false }) }, logger);
  return handler;
}

test('thumbnail accepts only the exact ord thumbnail authority and canonical inscription path', async () => {
  const calls = [];
  const resolver = { resolve: async (...args) => { calls.push(args); return result(); } };
  const response = await resolveThumbnail(new Request(url), resolver);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0][0], `ord://content/${id}`);

  for (const invalid of [
    `ord://content/${id}`,
    `ord://thumbnail/${id}?page=1`,
    `ord://thumbnail/${id}#fragment`,
    `ord://user@thumbnail/${id}`,
    `ord://thumbnail/${id}/extra`,
    `ord://thumbnail/%2f${id}`,
    `ord://thumbnail/${'a'.repeat(63)}i0`,
    `ord://thumbnail/${'a'.repeat(64)}i12345678901`
  ]) {
    await assert.rejects(resolveThumbnail({ url: invalid, method: 'GET' }, resolver), { code: 'UNSAFE_ORD_PATH' }, invalid);
  }
  assert.equal(calls.length, 1);
});

test('GET and HEAD forward the fixed bound, raster accept list, and exact abort signal', async () => {
  const controller = new AbortController();
  const calls = [];
  const resolver = { resolve: async (_path, options) => { calls.push(options); return result(); } };
  const getRequest = new Request(url, { signal: controller.signal });
  const headRequest = new Request(url, { method: 'HEAD', signal: controller.signal });
  const get = await resolveThumbnail(getRequest, resolver);
  const head = await resolveThumbnail(headRequest, resolver);
  assert.deepEqual(calls.map(({ maxBytes }) => maxBytes), [MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_BYTES]);
  assert.equal(calls.every(({ accept }) => accept === 'image/png,image/apng,image/jpeg,image/gif,image/webp,image/avif,image/bmp'), true);
  assert.deepEqual(calls.map(({ signal }) => signal), [getRequest.signal, headRequest.signal]);
  assert.deepEqual([...new Uint8Array(await get.arrayBuffer())], [1, 2, 3]);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  await assert.rejects(resolveThumbnail({ url, method: 'POST' }, resolver), { code: 'METHOD_NOT_ALLOWED', status: 405 });
});

test('thumbnail allows only raster MIME and rejects non-200, empty, and oversized content', async () => {
  for (const type of ['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']) {
    const response = await resolveThumbnail({ url, method: 'GET' }, { resolve: async () => result({ headers: { 'content-type': type } }) });
    assert.equal(response.headers.get('content-type'), type);
  }
  for (const type of ['image/svg+xml', 'text/html', 'video/mp4', 'application/octet-stream']) {
    await assert.rejects(resolveThumbnail({ url, method: 'GET' }, { resolve: async () => result({ headers: { 'content-type': type } }) }),
      { code: 'PREVIEW_UNAVAILABLE', status: 415 }, type);
  }
  await assert.rejects(resolveThumbnail({ url, method: 'GET' }, { resolve: async () => result({ status: 206 }) }), { code: 'PREVIEW_UNAVAILABLE' });
  await assert.rejects(resolveThumbnail({ url, method: 'GET' }, { resolve: async () => result({ data: Buffer.alloc(0) }) }), { code: 'RESOURCE_TOO_LARGE' });
  await assert.rejects(resolveThumbnail({ url, method: 'GET' }, { resolve: async () => result({ data: Buffer.alloc(MAX_THUMBNAIL_BYTES + 1) }) }), { code: 'RESOURCE_TOO_LARGE' });
});

test('thumbnail rebuilds a minimal response header set and strips provider-controlled headers', async () => {
  const response = await resolveThumbnail({ url, method: 'GET' }, { resolve: async () => result() });
  assert.deepEqual(Object.fromEntries(response.headers), {
    'cache-control': 'no-store',
    'content-length': '3',
    'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    'content-type': 'image/png',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  });
  assert.equal(response.headers.has('x-provider-secret'), false);
  assert.equal(response.headers.has('set-cookie'), false);
});

test('resolver failures and abort reasons propagate unchanged from the helper', async () => {
  const primary = new AppError('PROVIDER_TIMEOUT', 'synthetic timeout', { status: 503, retryable: true });
  await assert.rejects(resolveThumbnail({ url, method: 'GET' }, { resolve: async () => { throw primary; } }), (error) => error === primary);
  const controller = new AbortController();
  const reason = new AppError('ROUTING_INVALIDATED', 'synthetic route change', { status: 409 });
  controller.abort(reason);
  await assert.rejects(resolveThumbnail({ url, method: 'GET', signal: controller.signal }, {
    resolve: async (_path, options) => { assert.equal(options.signal, controller.signal); throw options.signal.reason; }
  }), (error) => error === reason);
});

test('registered protocol converts thumbnail errors to inert CSP documents', async () => {
  const warnings = [];
  const handler = protocolFixture(async () => { throw new AppError('PREVIEW_UNAVAILABLE', '<unsafe>', { status: 415 }); },
    { warn: (...args) => warnings.push(args) });
  const response = await handler(new Request(`ord://thumbnail/${id}`));
  assert.equal(response.status, 415);
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.text();
  assert.equal(body.includes('&lt;unsafe&gt;'), true);
  assert.equal(body.includes('<unsafe>'), false);
  assert.equal(warnings[0][0], 'protocol.ord_error');
});

test('ordinary ord resources retain their resolver path, range, accept, status, body, and provider headers', async () => {
  const calls = [];
  const handler = protocolFixture(async (...args) => {
    calls.push(args);
    return result({ status: 206, headers: { 'content-type': 'text/plain', 'x-provider': 'fixture' }, data: Buffer.from('ordinary') });
  });
  const request = new Request(`ord://content/${id}`, { headers: { range: 'bytes=0-7', accept: 'text/plain' } });
  const response = await handler(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], request.url);
  assert.deepEqual(calls[0][1], { range: 'bytes=0-7', accept: 'text/plain', signal: request.signal });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'ordinary');
  assert.equal(response.headers.get('x-provider'), 'fixture');
  assert.equal(response.headers.get('content-length'), '8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.has('content-security-policy'), false);
});
