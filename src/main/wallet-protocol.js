import fs from 'node:fs/promises';
import path from 'node:path';
import { WALLET_ORIGIN } from '../shared/constants.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const WALLET_CSP = [
  "default-src 'self'",
  "script-src 'self' chrome-extension:",
  "style-src 'self' 'unsafe-inline' chrome-extension:",
  "img-src 'self' data: blob: chrome-extension: https:",
  "connect-src 'self' https: wss: chrome-extension:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

export function installWalletProtocol(walletSession, appRoot, logger) {
  walletSession.protocol.handle('https', async (request) => {
    const url = new URL(request.url);
    if (url.origin !== WALLET_ORIGIN) {
      return walletSession.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
      if (pathname.includes('\0') || pathname.includes('\\')) return new Response('Bad request', { status: 400 });
      if (pathname === '/') pathname = '/index.html';
      const root = path.resolve(appRoot, 'src', 'wallet');
      const file = path.resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) return new Response('Not found', { status: 404 });
      const stat = await fs.stat(file);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const data = request.method === 'HEAD' ? Buffer.alloc(0) : await fs.readFile(file);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(request.method === 'HEAD' ? stat.size : data.length),
          'content-security-policy': WALLET_CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-origin',
          'cache-control': process.env.SATOSHI_BROWSER_DEV === '1' ? 'no-store' : 'no-cache'
        }
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn('protocol.wallet_error', { message: error.message, url: request.url });
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  });
}
