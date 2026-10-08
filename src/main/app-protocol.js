import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: ord:",
  "media-src 'self' blob: ord:",
  "font-src 'self' data:",
  "connect-src 'self' ord:",
  "frame-src ord:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

export function installAppProtocol(electronSession, appRoot, logger, creator) {
  electronSession.protocol.handle('app', async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      if(url.pathname.startsWith('/creator-assets/'))return creator ? await creator.resolveAsset(request) : new Response('Not found',{status:404});
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
      if (pathname.includes('\0') || pathname.includes('\\')) return new Response('Bad request', { status: 400 });
      if (pathname === '/') pathname = '/renderer/index.html';
      const root = path.resolve(appRoot, 'src');
      const file = path.resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new AppError('UNSAFE_PATH', 'Path traversal blocked', { status: 400 });
      const data = request.method === 'HEAD' ? Buffer.alloc(0) : await fs.readFile(file);
      const stat = await fs.stat(file);
      const headers = {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(request.method === 'HEAD' ? stat.size : data.length),
        'content-security-policy': APP_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': process.env.SATOSHI_BROWSER_DEV === '1' ? 'no-store' : 'no-cache'
      };
      return new Response(data, { status: 200, headers });
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn('protocol.app_error', { message: error.message, url: request.url });
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  });
}
