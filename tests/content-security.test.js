import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { contentCsp, installContentProtocol } from '../src/main/content-protocol.js';

test('blocked inscription CSP denies external authority and active objects', () => {
  const policy = contentCsp('blocked');
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'self' blob: data:/);
  assert.doesNotMatch(policy, /connect-src[^;]*https:/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /form-action 'none'/);
});

test('compatible inscription CSP permits only explicit HTTPS external resources', () => {
  const policy = contentCsp('https-only');
  assert.match(policy, /connect-src[^;]*https: wss:/);
  assert.match(policy, /form-action https:/);
  assert.match(policy, /object-src 'none'/);
});

test('offline mode overrides a saved compatible inscription CSP policy', () => {
  const policy = contentCsp({ contentNetworkPolicy: 'https-only', offlineMode: true });
  assert.doesNotMatch(policy, /connect-src[^;]*https:/);
  assert.doesNotMatch(policy, /connect-src[^;]*wss:/);
  assert.match(policy, /form-action 'none'/);
});

test('ord protocol attaches CSP and defensive response headers to hostile HTML', async () => {
  let handler;
  const electronSession = { protocol: { handle(_scheme, callback) { handler = callback; } } };
  const body = await fs.readFile(new URL('./fixtures/hostile-inscription.html', import.meta.url));
  const resolver = { async resolve() { return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: body }; } };
  const stateStore = { get() { return 'blocked'; } };
  installContentProtocol(electronSession, resolver, stateStore, null);
  const response = await handler(new Request('ord://content/fixture'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /walletAuthority/);
});

test('ord protocol derives CSP from the effective live offline policy', async () => {
  let handler;
  const electronSession = { protocol: { handle(_scheme, callback) { handler = callback; } } };
  const resolver = { async resolve() { return { status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from('<p>fixture</p>') }; } };
  const stateStore = { get() { return { contentNetworkPolicy: 'https-only', offlineMode: true }; } };
  installContentProtocol(electronSession, resolver, stateStore, null);
  const response = await handler(new Request('ord://content/fixture'));
  assert.doesNotMatch(response.headers.get('content-security-policy'), /connect-src[^;]*https:/);
});
