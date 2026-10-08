import { decodedContentBytes } from './content-decoding.js';
import { parseRange } from './resolver.js';
import { serializeError } from '../shared/errors.js';
import { resolveThumbnail } from './content-thumbnail.js';
import { resolveInscriptionText } from './content-text.js';
import { effectiveContentNetworkPolicy } from './content-network-policy.js';
import { resolveModelContent } from './content-model.js';
import { resolveDocumentContent } from './content-document.js';

export function contentCsp(settings) {
  const policy = typeof settings === 'string' ? settings : effectiveContentNetworkPolicy(settings);
  const external = policy === 'https-only' ? ' https: wss:' : '';
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:${external}`,
    `style-src 'self' 'unsafe-inline' blob: data:${external}`,
    `img-src 'self' blob: data:${external}`,
    `media-src 'self' blob: data:${external}`,
    `font-src 'self' data:${external}`,
    `connect-src 'self' blob: data:${external}`,
    `worker-src 'self' blob:${external}`,
    `child-src 'self' blob: data:${external}`,
    `frame-src 'self' blob: data:${external}`,
    "object-src 'none'",
    policy === 'https-only' ? 'form-action https:' : "form-action 'none'",
    "base-uri 'none'"
  ].join('; ');
}

function errorDocument(error) {
  const safe = serializeError(error);
  const title = String(safe.code).replace(/[<>&]/g, '');
  const message = String(safe.message).replace(/[<>&]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>${title}</title><style>html{font-family:system-ui;background:#0b0d10;color:#e8edf3}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{max-width:640px;margin:24px;padding:28px;border:1px solid #2d333b;border-radius:18px;background:#12161b}code{color:#ffb454}</style></head><body><div class="card"><code>${title}</code><h1>Could not load this on-chain resource</h1><p>${message}</p></div></body></html>`;
}

export function installContentProtocol(electronSession, resolver, stateStore, logger, creator) {
  electronSession.protocol.handle('ord', async (request) => {
    try {
      if(new URL(request.url).hostname.startsWith('draft-'))return creator ? await creator.resolveDraft(request) : new Response('Draft unavailable',{status:404});
      if (['document-viewer', 'document-data'].includes(new URL(request.url).hostname)) return await resolveDocumentContent(request, resolver);
      if (['model-viewer', 'model-data', 'model-resource'].includes(new URL(request.url).hostname)) return await resolveModelContent(request, resolver);
      if (new URL(request.url).hostname === 'thumbnail') return await resolveThumbnail(request, resolver);
      if (new URL(request.url).hostname === 'text') return await resolveInscriptionText(request, resolver);
      const range = request.headers.get('range');
      const accept = request.headers.get('accept') ?? '*/*';
      let result = await resolver.resolve(request.url, { range, accept, signal: request.signal });
      const encodedRange = range && !['', 'identity'].includes((new Headers(result.headers).get('content-encoding') ?? '').toLowerCase());
      if (encodedRange) result = await resolver.resolve(request.url, { accept, signal: request.signal });
      const headers = new Headers(result.headers);
      const type = headers.get('content-type') ?? '';
      if (/^(?:text\/html|image\/svg\+xml|application\/xhtml\+xml)/i.test(type)) {
        headers.set('content-security-policy', contentCsp(stateStore.get(['settings'])));
      }
      // Electron protocol.handle consumes Response bodies as supplied; it does
      // not perform HTTP Content-Encoding decompression. Cache keeps wire bytes,
      // but the native viewer needs bounded decoded bytes and matching headers.
      let body = await decodedContentBytes(result, stateStore.get(['settings']).maxResourceBytes ?? 64 * 1024 * 1024, request.signal);
      let status = result.status;
      headers.delete('content-encoding');
      if (encodedRange) {
        const parsed = parseRange(range, body.length), total = body.length;
        if (parsed?.invalid) return new Response(null, {status:416,headers:{'content-range':`bytes */${total}`}});
        if (parsed) { body=body.subarray(parsed.start,parsed.end+1); status=206; headers.set('content-range',`bytes ${parsed.start}-${parsed.end}/${total}`); }
      }
      headers.set('content-length', String(body.length));
      headers.set('x-content-type-options', 'nosniff');
      headers.set('referrer-policy', 'no-referrer');
      headers.set('permissions-policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()');
      return new Response(request.method==='HEAD'?null:body, { status, headers });
    } catch (error) {
      logger?.warn('protocol.ord_error', { url: request.url, code: error.code, message: error.message });
      if (['text', 'model-data', 'model-resource', 'document-data'].includes(new URL(request.url).hostname)) {
        return new Response(JSON.stringify({ code: serializeError(error).code }), {
          status: error.status && error.status >= 400 && error.status <= 599 ? error.status : 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*',
            'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
        });
      }
      const body = Buffer.from(errorDocument(error));
      return new Response(body, {
        status: error.status && error.status >= 400 && error.status <= 599 ? error.status : 500,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer'
        }
      });
    }
  });
}
