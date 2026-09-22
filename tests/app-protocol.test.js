import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installAppProtocol } from '../src/main/app-protocol.js';

test('app protocol serves only bounded application assets with defensive headers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-app-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src', 'renderer'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'renderer', 'index.html'), '<!doctype html><title>Fixture</title>');
  let handler;
  installAppProtocol({ protocol: { handle(_scheme, callback) { handler = callback; } } }, root, null);

  const response = await handler(new Request('app://app/renderer/index.html'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(response.headers.get('content-security-policy'), /frame-src ord:/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /Fixture/);

  const head = await handler(new Request('app://app/renderer/index.html', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await handler(new Request('app://app/renderer/index.html', { method: 'POST' }))).status, 405);
  assert.equal((await handler(new Request('app://other/renderer/index.html'))).status, 404);
  assert.equal((await handler(new Request('app://app/missing.js'))).status, 404);
});
