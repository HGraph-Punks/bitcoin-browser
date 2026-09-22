import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { BitcoinCoreProvider } from '../src/main/providers/bitcoin-core.js';

// All credentials below are synthetic. No real cookie or credential store is
// read; the file reader is mocked at the adapter boundary.
const cookieFile = '/synthetic/core/auth.cookie';
const config = { id: 'core-fixture', name: 'Core fixture', type: 'bitcoin-core', network: 'mainnet',
  baseUrl: 'http://127.0.0.1:1', local: true, enabled: true, capabilities: ['block'], cookieFile };

function cookieReader(t, read) {
  t.mock.method(fs, 'readFile', async (file, encoding) => {
    assert.equal(file, cookieFile); assert.equal(encoding, 'utf8');
    return read();
  });
}

async function fixture(t) {
  const requests = [];
  const response = { status: 200, body: { result: { chain: 'main', blocks: 123, headers: 456,
    verificationprogress: 0.42, initialblockdownload: true, pruned: true }, error: null } };
  const server = http.createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    reply.writeHead(response.status, { 'content-type': 'application/json' });
    reply.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const provider = new BitcoinCoreProvider({ ...config, baseUrl: `http://127.0.0.1:${server.address().port}` });
  return { provider, requests, response };
}

for (const [nativeCode, code, status, retryable] of [
  ['ENOENT', 'PROVIDER_COOKIE_UNAVAILABLE', 503, true],
  ['EACCES', 'PROVIDER_COOKIE_ACCESS_DENIED', 403, false],
  ['EPERM', 'PROVIDER_COOKIE_ACCESS_DENIED', 403, false],
  ['EISDIR', 'PROVIDER_COOKIE_READ_FAILED', 503, false]
]) test(`cookie ${nativeCode} is not mislabeled as a rejected password`, async t => {
  cookieReader(t, () => { throw Object.assign(new Error('synthetic native details must stay private'), { code: nativeCode }); });
  await assert.rejects(new BitcoinCoreProvider(config).health(), error => {
    assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.retryable, retryable);
    assert.doesNotMatch(error.message, /synthetic native|\/synthetic\/|PROVIDER_AUTH_ERROR/);
    return true;
  });
});

test('an empty startup cookie does not send an unauthenticated RPC request', async t => {
  const f = await fixture(t); cookieReader(t, () => ' \n');
  await assert.rejects(f.provider.health(), { code: 'PROVIDER_COOKIE_UNAVAILABLE', retryable: true });
  assert.equal(f.requests.length, 0);
});

test('startup failure recovers with the generated cookie and rereads it after a node restart', async t => {
  const f = await fixture(t); let current = null;
  cookieReader(t, () => { if (current === null) throw Object.assign(new Error('not created'), { code: 'ENOENT' }); return current; });
  await assert.rejects(f.provider.health(), { code: 'PROVIDER_COOKIE_UNAVAILABLE' });
  current = '__cookie__:synthetic-first\n';
  assert.equal((await f.provider.health()).ok, true);
  current = '__cookie__:synthetic-restarted\n';
  const health = await f.provider.health();
  assert.equal(health.ok, true); assert.equal(health.initialBlockDownload, true); assert.equal(health.verificationProgress, 0.42);
  assert.deepEqual(f.requests.map(row => row.body.method), ['getblockchaininfo', 'getblockchaininfo']);
  assert.deepEqual(f.requests.map(row => row.authorization), [
    `Basic ${Buffer.from('__cookie__:synthetic-first').toString('base64')}`,
    `Basic ${Buffer.from('__cookie__:synthetic-restarted').toString('base64')}`
  ]);
  assert.doesNotMatch(JSON.stringify(health), /synthetic-first|synthetic-restarted|authorization|cookieFile/);
});

for (const status of [401, 403]) test(`real HTTP ${status} remains an authentication failure, even with a misleading RPC body`, async t => {
  const f = await fixture(t); cookieReader(t, () => '__cookie__:synthetic-invalid');
  f.response.status = status; f.response.body = { error: { code: -28, message: 'Loading block index' } };
  await assert.rejects(f.provider.health(), error => error.code === 'PROVIDER_AUTH_ERROR' && error.details.providerStatus === status);
});

for (const status of [200, 500]) test(`Core warmup over HTTP ${status} is retryable startup, not an authentication failure`, async t => {
  const f = await fixture(t); cookieReader(t, () => '__cookie__:synthetic');
  f.response.status = status; f.response.body = { error: { code: -28, message: 'Loading block index' } };
  await assert.rejects(f.provider.health(), { code: 'PROVIDER_WARMING_UP', retryable: true });
});

test('non-JSON HTTP failures retain their HTTP classification', async t => {
  const f = await fixture(t); cookieReader(t, () => '__cookie__:synthetic');
  f.response.status = 500; f.response.body = 'Synthetic server failure';
  await assert.rejects(f.provider.health(), { code: 'PROVIDER_HTTP_ERROR' });
});

test('absent secure-store values never fabricate undefined credentials', async () => {
  const provider = new BitcoinCoreProvider({ ...config, cookieFile: '' });
  assert.equal(await provider.authorizationHeader(), null);
});
