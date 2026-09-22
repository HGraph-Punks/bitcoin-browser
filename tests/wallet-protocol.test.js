import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installWalletProtocol } from '../src/main/wallet-protocol.js';

test('wallet protocol serves only wallet assets on its reserved HTTPS origin and forwards other HTTPS requests', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-wallet-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src', 'wallet'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'wallet', 'index.html'), '<!doctype html><title>Wallet fixture</title>');
  let handler;
  const forwarded = [];
  const walletSession = {
    protocol: { handle(scheme, callback) { assert.equal(scheme, 'https'); handler = callback; } },
    async fetch(request, options) {
      forwarded.push({ url: request.url, options });
      return new Response('forwarded');
    }
  };
  installWalletProtocol(walletSession, root, null);

  const response = await handler(new Request('https://wallet.satoshi.invalid/index.html'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self' chrome-extension:/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self' https: wss:/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /Wallet fixture/);
  assert.equal((await handler(new Request('https://wallet.satoshi.invalid/index.html', { method: 'POST' }))).status, 405);
  assert.equal((await handler(new Request('https://wallet.satoshi.invalid/missing.js'))).status, 404);

  const external = await handler(new Request('https://wallet-backend.example/api'));
  assert.equal(await external.text(), 'forwarded');
  assert.deepEqual(forwarded, [{ url: 'https://wallet-backend.example/api', options: { bypassCustomProtocolHandlers: true } }]);
});
