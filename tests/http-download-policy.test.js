import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { requestBuffer } from '../src/main/http.js';

const origins = ['https://github.com', 'https://release-assets.githubusercontent.com'];
const publicAddress = [{ address: '93.184.216.34', family: 4 }];

function network(t, route, lookup = async () => publicAddress) {
  const requests = [], lookups = [], responses = [];
  t.mock.method(dns, 'lookup', async (host, options) => { lookups.push(host); return lookup(host, options); });
  const request = (url, options, callback) => {
    requests.push({ url: url.href, options });
    const req = new EventEmitter(); req.write = () => {};
    req.end = () => queueMicrotask(() => {
      if (options.signal.aborted) { req.emit('error', options.signal.reason); return; }
      const value = route(url, requests.length);
      const response = Readable.from([Buffer.from(value.body ?? 'fixture')]);
      Object.assign(response, { statusCode: value.status ?? 200, statusMessage: 'fixture', headers: value.headers ?? {} });
      responses.push(response); callback(response);
    });
    return req;
  };
  t.mock.method(http, 'request', request); t.mock.method(https, 'request', request);
  return { requests, lookups, responses };
}

test('allowed HTTPS redirects preserve transient signed queries and emit only immutable origin/status observations', async t => {
  const f = network(t, (_url, number) => number === 1
    ? { status: 302, headers: { location: '//release-assets.githubusercontent.com/download?token=synthetic-sensitive-value#fragment' } }
    : { body: 'verified fixture bytes' });
  const observations = [];
  const result = await requestBuffer('https://GITHUB.com:443/source', {
    allowedOrigins: origins, onResponse: value => { assert.equal(Object.isFrozen(value), true); observations.push(value); }
  });
  assert.equal(result.data.toString(), 'verified fixture bytes');
  assert.match(f.requests[1].url, /token=synthetic-sensitive-value/);
  assert.deepEqual(observations, [{ origin: origins[0], status: 302 }, { origin: origins[1], status: 200 }]);
  assert.doesNotMatch(JSON.stringify(observations), /token|fragment|download|synthetic-sensitive/);
  assert.equal(f.responses[0].destroyed, true);
});

test('relative redirect resolves against the current allowed origin without granting another origin', async t => {
  const f = network(t, (_url, count) => count === 1 ? { status: 307, headers: { location: '../asset?signature=synthetic' } } : {});
  const result = await requestBuffer('https://github.com/releases/start', { allowedOrigins: origins });
  assert.equal(result.ok, true);
  assert.equal(f.requests[1].url, 'https://github.com/asset?signature=synthetic');
});

test('unapproved initial origins and aliases are rejected before DNS or connection', async t => {
  const f = network(t, () => ({}));
  for (const url of ['https://outside.example/file', 'http://github.com/file', 'https://github.com:444/file',
    'https://github.com./file', 'https://github.com.outside.example/file', 'https://sub.github.com/file', 'https://127.0.0.1/file']) {
    await assert.rejects(requestBuffer(url, { allowedOrigins: origins }), { code: 'UNSAFE_PROVIDER_ORIGIN' });
  }
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.requests, []);
});

test('userinfo and unsupported schemes remain rejected independently of the origin policy', async t => {
  const f = network(t, () => ({}));
  for (const url of ['https://user:synthetic@github.com/file', 'file:///private/tmp/fixture', 'data:text/plain,fixture']) {
    await assert.rejects(requestBuffer(url, { allowedOrigins: origins }), { code: 'UNSAFE_URL' });
  }
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.requests, []);
});

test('redirect to a disallowed public origin is denied before its DNS lookup and closes the first response', async t => {
  const f = network(t, () => ({ status: 302, headers: { location: 'https://outside.example/file?token=synthetic' } }));
  await assert.rejects(requestBuffer('https://github.com/source', { allowedOrigins: origins }), { code: 'UNSAFE_PROVIDER_ORIGIN' });
  assert.deepEqual(f.lookups, ['github.com']); assert.equal(f.requests.length, 1);
  assert.equal(f.responses[0].destroyed, true);
});

test('HTTPS downgrade redirect is denied before any HTTP connection', async t => {
  const f = network(t, () => ({ status: 301, headers: { location: 'http://github.com/file' } }));
  await assert.rejects(requestBuffer('https://github.com/source', { allowedOrigins: origins }), { code: 'UNSAFE_PROVIDER_ORIGIN' });
  assert.equal(f.requests.length, 1); assert.deepEqual(f.lookups, ['github.com']);
  assert.equal(f.responses[0].destroyed, true);
});

test('supplied origin policies reject malformed and noncanonical entries before network effects', async t => {
  const f = network(t, () => ({}));
  for (const allowedOrigins of [null, [], 'https://github.com', {}, ['https://github.com/path'],
    ['https://github.com/'], ['https://github.com?token=synthetic'], ['https://user:pass@github.com'],
    ['HTTPS://GITHUB.COM'], [3], Array(17).fill('https://github.com')]) {
    await assert.rejects(requestBuffer('https://github.com', { allowedOrigins }), { code: 'VALIDATION_ERROR' });
  }
  await assert.rejects(requestBuffer('https://github.com', { allowedOrigins: origins, onResponse: 'invalid' }), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.requests, []);
});

test('origin list mutation during DNS cannot widen an admitted request policy', async t => {
  let enter, release, lookupCount = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const allowedOrigins = [...origins];
  const f = network(t, () => ({ status: 302, headers: { location: 'https://outside.example/file' } }),
    async () => { if (lookupCount++ > 0) return publicAddress; enter(); return new Promise(resolve => { release = resolve; }); });
  const pending = requestBuffer('https://github.com/source', { allowedOrigins });
  const observed = pending.then(value => ({ value }), error => ({ error }));
  await entered; allowedOrigins.push('https://outside.example'); release(publicAddress);
  const result = await observed;
  assert.equal(result.error?.code, 'UNSAFE_PROVIDER_ORIGIN');
  assert.equal(f.requests.length, 1); assert.deepEqual(f.lookups, ['github.com']);
});

test('already-aborted requests never admit DNS or a connection', async t => {
  const f = network(t, () => ({})); const controller = new AbortController(); const reason = new Error('synthetic caller cancellation');
  controller.abort(reason);
  await assert.rejects(requestBuffer('https://github.com/source', { allowedOrigins: origins, signal: controller.signal }), error => error === reason);
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.requests, []);
});

test('cancellation settles during deferred DNS and late resolution cannot create a connection', async t => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  const f = network(t, () => ({}), () => { enter(); return new Promise(resolve => { release = resolve; }); });
  const controller = new AbortController(), reason = new Error('synthetic DNS-stage cancel'); let settled = false;
  const observed = requestBuffer('https://github.com/source', { allowedOrigins: origins, signal: controller.signal })
    .then(value => ({ value }), error => ({ error })).then(result => { settled = true; return result; });
  await entered; controller.abort(reason); await new Promise(setImmediate); const settledBeforeRelease = settled;
  release(publicAddress); const result = await observed; await new Promise(setImmediate);
  assert.equal(settledBeforeRelease, true); assert.equal(result.error, reason); assert.deepEqual(f.requests, []);
});

test('response observer cancellation prevents admission of a following redirect', async t => {
  const f = network(t, () => ({ status: 302, headers: { location: '/again' } }));
  const controller = new AbortController(), reason = new Error('synthetic observer-stage cancellation');
  await assert.rejects(requestBuffer('https://github.com/source', {
    allowedOrigins: origins, signal: controller.signal, onResponse: () => controller.abort(reason)
  }), error => error === reason);
  assert.equal(f.requests.length, 1); assert.equal(f.responses[0].destroyed, true);
});

test('software-policy response bounds and redirect limits close the admitted response', async t => {
  const f = network(t, url => url.pathname === '/large'
    ? { headers: { 'content-length': '999' } }
    : { status: 302, headers: { location: '/loop' } });
  await assert.rejects(requestBuffer('https://github.com/large', { allowedOrigins: origins, maxBytes: 8 }), { code: 'RESOURCE_TOO_LARGE' });
  assert.equal(f.responses[0].destroyed, true);
  await assert.rejects(requestBuffer('https://github.com/loop', { allowedOrigins: origins, maxRedirects: 1 }), { code: 'PROVIDER_REDIRECT_ERROR' });
  assert.equal(f.requests.length, 3); assert.equal(f.responses.every(response => response.destroyed), true);
});

test('ordinary providers without an origin policy retain HTTP redirects and credential-header removal', async t => {
  const f = network(t, (_url, count) => count === 1 ? { status: 303, headers: { location: 'https://outside.example/result' } } : {});
  const result = await requestBuffer('http://custom.example:18443/rpc', {
    method: 'POST', body: 'synthetic body', headers: { authorization: 'fixture', cookie: 'fixture', 'proxy-authorization': 'fixture', accept: 'application/json' }
  });
  assert.equal(result.ok, true); assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].options.method, 'GET');
  assert.deepEqual(f.requests[1].options.headers, { accept: 'application/json' });
});

for (const failure of ['redirect', 'declared length']) {
  test(`origin-constrained ${failure} rejection closes the real loopback response`, { timeout: 3000 }, async t => {
    let closeResponse, requests = 0;
    const closed = new Promise(resolve => { closeResponse = resolve; });
    const server = http.createServer((_request, response) => {
      requests++;
      response.once('close', closeResponse);
      response.writeHead(failure === 'redirect' ? 302 : 200, failure === 'redirect'
        ? { location: 'http://outside.invalid/denied', 'content-length': '999999' }
        : { 'content-length': '999999' });
      response.flushHeaders(); // Deliberately leave the body unfinished.
    });
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(requestBuffer(`${origin}/fixture`, {
      networkPolicy: 'local', allowedOrigins: [origin], timeoutMs: 1000, maxBytes: 8
    }), { code: failure === 'redirect' ? 'UNSAFE_PROVIDER_ORIGIN' : 'RESOURCE_TOO_LARGE' });
    let timer;
    try {
      await Promise.race([closed, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Response did not close')), 1000); })]);
    } finally { clearTimeout(timer); }
    assert.equal(requests, 1);
  });
}
