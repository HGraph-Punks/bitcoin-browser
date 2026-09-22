import { AppError } from '../shared/errors.js';
import { INSCRIPTION_DISPLAY_ID, MAX_INSCRIPTION_TEXT_BYTES, isReadableInscription } from '../shared/inscription-presentation.js';
import { decodedContentBytes } from './content-decoding.js';

// A bounded, inert projection of existing /content authority. No markup or
// provider-controlled headers are exposed to the trusted renderer as HTML.
export async function resolveInscriptionText(request, resolver) {
  const url = new URL(request.url);
  if (url.protocol !== 'ord:' || url.hostname !== 'text' || url.username || url.password || url.port || url.search || url.hash
      || !INSCRIPTION_DISPLAY_ID.test(url.pathname.slice(1)) || url.pathname.slice(1).includes('/')) {
    throw new AppError('UNSAFE_ORD_PATH', 'Invalid inscription text preview address', { status: 400 });
  }
  if (!['GET', 'HEAD'].includes(request.method)) throw new AppError('METHOD_NOT_ALLOWED', 'Text previews require GET or HEAD', { status: 405 });
  const signal = request.signal;
  signal?.throwIfAborted();
  let result;
  try {
    result = await resolver.resolve(`ord://content/${url.pathname.slice(1).toLowerCase()}`, { accept: '*/*', maxBytes: MAX_INSCRIPTION_TEXT_BYTES, signal });
  } catch (error) { signal?.throwIfAborted(); throw error; }
  signal?.throwIfAborted();
  const contentType = new Headers(result.headers).get('content-type') ?? '';
  if (result.status !== 200 || !isReadableInscription(contentType)) throw new AppError('TEXT_PREVIEW_UNAVAILABLE', 'Open Original to view this content in its own format.', { status: 415 });
  if (!(result.data instanceof Uint8Array) || result.data.byteLength > MAX_INSCRIPTION_TEXT_BYTES) throw new AppError('RESOURCE_TOO_LARGE', 'Text previews are limited to 256 KiB. Save or open the original for the complete content.', { status: 413 });
  const data = await decodedContentBytes(result, MAX_INSCRIPTION_TEXT_BYTES, signal);
  const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  let text;
  try { text = new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8', { fatal: true }).decode(data); }
  catch { throw new AppError('TEXT_PREVIEW_UNAVAILABLE', 'This text encoding could not be displayed. Save or open the original instead.', { status: 415 }); }
  const body = Buffer.from(JSON.stringify({ text, contentType, bytes: data.byteLength, cache: result.cache ?? null }));
  signal?.throwIfAborted();
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: {
    'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length),
    'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin',
    'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store'
  } });
}
