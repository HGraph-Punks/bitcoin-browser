import fs from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import { inscriptionPresentation } from '../shared/inscription-presentation.js';
import { DOCUMENT_LIMITS, previewRoute } from '../shared/document-preview.js';
import { decodedContentBytes } from './content-decoding.js';

const assetFiles = new Map([
  ['viewer.js', new URL('../document-viewer/viewer.js', import.meta.url)],
  ['viewer.css', new URL('../document-viewer/viewer.css', import.meta.url)],
  ['markdown.js', new URL('../document-viewer/markdown.js', import.meta.url)],
  ['pdf.js', new URL('../document-viewer/pdf.js', import.meta.url)],
  ['bundled-worker.js', new URL('../document-viewer/bundled-worker.js', import.meta.url)],
  ['jxl.js', new URL('../document-viewer/jxl.js', import.meta.url)],
  ['jxl-worker.js', new URL('../document-viewer/jxl-worker.js', import.meta.url)],
  ['document-preview.js', new URL('../shared/document-preview.js', import.meta.url)],
  ['jxl-header.js', new URL('../shared/jxl-header.js', import.meta.url)],
  ['marked.mjs', new URL('../../node_modules/marked/lib/marked.esm.js', import.meta.url)],
  ['pdf.mjs', new URL('../../node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url)],
  ['pdf.worker.js', new URL('../document-viewer/generated/pdf.worker.js', import.meta.url)],
  ['jxl.worker.js', new URL('../document-viewer/generated/jxl.worker.js', import.meta.url)],
  ['jxl/decode.js', new URL('../../node_modules/@jsquash/jxl/decode.js', import.meta.url)],
  ['jxl/utils.js', new URL('../../node_modules/@jsquash/jxl/utils.js', import.meta.url)],
  ['jxl/codec/dec/jxl_dec.js', new URL('../../node_modules/@jsquash/jxl/codec/dec/jxl_dec.js', import.meta.url)],
  ['jxl/codec/dec/jxl_dec.wasm', new URL('../../node_modules/@jsquash/jxl/codec/dec/jxl_dec.wasm', import.meta.url)]
]);
const headers = {
  'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store',
  'access-control-expose-headers': 'x-satoshi-content-type',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), xr-spatial-tracking=()'
};
export const DOCUMENT_CSP = [
  "default-src 'none'", "script-src ord://document-viewer/assets/ blob: 'wasm-unsafe-eval'",
  "style-src ord://document-viewer/assets/ 'unsafe-inline'", 'connect-src ord://document-data/ ord://document-viewer/assets/ blob:',
  'img-src blob: data: ord://thumbnail/', 'font-src blob: data:', "worker-src blob:",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", 'frame-ancestors app://app', 'sandbox allow-scripts'
].join('; ');

export async function resolveDocumentContent(request, resolver) {
  const url = new URL(request.url);
  if (url.protocol !== 'ord:' || !['document-viewer', 'document-data'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) throw new AppError('UNSAFE_ORD_PATH', 'Invalid document preview address', { status: 400 });
  if (!['GET', 'HEAD'].includes(request.method)) throw new AppError('METHOD_NOT_ALLOWED', 'Document previews require GET or HEAD', { status: 405 });
  request.signal?.throwIfAborted();
  let data, type, csp = headers['content-security-policy'], originalType;
  if (url.hostname === 'document-viewer' && url.pathname.startsWith('/assets/')) {
    const name = url.pathname.slice(8);
    let file = assetFiles.get(name);
    // Passive PDF support tables only: no pdf.sandbox, QuickJS, executable
    // attachments, arbitrary dependency files, or user-selected filesystem paths.
    if (!file && /^(?:cmaps\/[A-Za-z0-9_-]+\.bcmap|standard_fonts\/[A-Za-z0-9_-]+\.(?:pfb|ttf)|wasm\/(?:openjpeg|jbig2|qcms_bg)\.wasm|iccs\/CGATS001Compat-v2-micro\.icc)$/.test(name)) file = new URL(`../../node_modules/pdfjs-dist/${name}`, import.meta.url);
    if (!file) throw new AppError('NOT_FOUND', 'Unknown preview asset', { status: 404 });
    try { data = await fs.readFile(file); } catch { throw new AppError('NOT_FOUND', 'Preview asset unavailable', { status: 404 }); }
    type = /\.m?js$/.test(name) ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  } else {
    const route = previewRoute(url.pathname);
    if (!route) throw new AppError('UNSAFE_ORD_PATH', 'Invalid document kind or inscription ID', { status: 400 });
    if (url.hostname === 'document-viewer') {
      data = await fs.readFile(new URL('../document-viewer/index.html', import.meta.url)); type = 'text/html; charset=utf-8'; csp = DOCUMENT_CSP;
    } else {
      const maxBytes = DOCUMENT_LIMITS[route.kind];
      const result = await resolver.resolve(`ord://content/${route.id}`, { maxBytes, accept: '*/*', signal: request.signal });
      request.signal?.throwIfAborted();
      originalType = new Headers(result.headers).get('content-type') ?? 'application/octet-stream';
      if (result.status !== 200 || (route.kind !== 'binary' && inscriptionPresentation(originalType) !== route.kind)) throw new AppError('PREVIEW_UNAVAILABLE', 'This source did not return the requested document format', { status: 415 });
      data = await decodedContentBytes(result, maxBytes, request.signal);
      if (route.kind === 'markdown') {
        const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(originalType);
        try { data = Buffer.from(new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8', { fatal: true }).decode(data)); } catch { throw new AppError('PREVIEW_UNAVAILABLE', 'Unsupported Markdown text encoding', { status: 415 }); }
        if (data.length > maxBytes) throw new AppError('RESOURCE_TOO_LARGE', 'Decoded Markdown exceeds the preview limit', { status: 413 });
      }
      type = 'application/octet-stream';
    }
  }
  request.signal?.throwIfAborted();
  return new Response(request.method === 'HEAD' ? null : data, { headers: { ...headers, 'content-type': type, 'content-length': String(data.length),
    'content-security-policy': csp, ...(originalType ? { 'x-satoshi-content-type': originalType.slice(0, 200) } : {}) } });
}
