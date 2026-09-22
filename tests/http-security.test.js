import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { addressClass, requestBuffer, resolveSafeAddresses } from '../src/main/http.js';

test('classifies prohibited IPv4 and IPv6 destination ranges', () => {
  assert.equal(addressClass('127.0.0.1'), 'loopback');
  assert.equal(addressClass('10.0.0.1'), 'private');
  assert.equal(addressClass('169.254.169.254'), 'link-local');
  assert.equal(addressClass('224.0.0.1'), 'multicast');
  assert.equal(addressClass('8.8.8.8'), 'public');
  assert.equal(addressClass('::1'), 'loopback');
  assert.equal(addressClass('fc00::1'), 'private');
  assert.equal(addressClass('fe80::1'), 'link-local');
  assert.equal(addressClass('2001:4860:4860::8888'), 'public');
  assert.equal(addressClass('::ffff:127.0.0.1'), 'loopback');
});

test('remote policy rejects DNS answers containing private destinations', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(resolveSafeAddresses('https://provider.example', { lookup, networkPolicy: 'remote' }), {
    code: 'UNSAFE_PROVIDER_DESTINATION'
  });
});

test('local policy permits private providers but rejects public destinations', async () => {
  const privateLookup = async () => [{ address: '192.168.1.20', family: 4 }];
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal((await resolveSafeAddresses('http://node.internal', { lookup: privateLookup, networkPolicy: 'local' }))[0].address, '192.168.1.20');
  await assert.rejects(resolveSafeAddresses('https://provider.example', { lookup: publicLookup, networkPolicy: 'local' }), {
    code: 'UNSAFE_PROVIDER_DESTINATION'
  });
});

test('pinned local requests work and redirect policy is bounded', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await requestBuffer(`http://127.0.0.1:${port}/`, { networkPolicy: 'local', maxBytes: 32 });
  assert.equal(response.data.toString(), 'ok');
  await assert.rejects(requestBuffer(`http://127.0.0.1:${port}/loop`, { networkPolicy: 'local', maxRedirects: 2, maxBytes: 32 }), {
    code: 'PROVIDER_REDIRECT_ERROR'
  });
});

test('remote requests cannot target loopback literals', async () => {
  await assert.rejects(requestBuffer('http://127.0.0.1:1/', { networkPolicy: 'remote', timeoutMs: 1000 }), {
    code: 'UNSAFE_PROVIDER_DESTINATION'
  });
});

test('redirect bounds reject malformed values instead of becoming unbounded', async () => {
  await assert.rejects(requestBuffer('https://example.com', { maxRedirects: Number.NaN }), { code: 'VALIDATION_ERROR', status: 400 });
  await assert.rejects(requestBuffer('https://example.com', { maxRedirects: 11 }), { code: 'VALIDATION_ERROR', status: 400 });
  await assert.rejects(requestBuffer('https://example.com', { maxRedirects: -1 }), { code: 'VALIDATION_ERROR', status: 400 });
});
