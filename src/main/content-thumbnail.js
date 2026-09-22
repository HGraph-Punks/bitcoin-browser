import { AppError } from '../shared/errors.js';
import { decodedContentBytes } from './content-decoding.js';

export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const RASTER_TYPES = new Set(['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

// This route is only a bounded raster-image projection of existing content
// authority. It never returns HTML/SVG, provider headers, or active previews.
export async function resolveThumbnail(request, resolver) {
  const url = new URL(request.url);
  if (url.protocol !== 'ord:' || url.hostname !== 'thumbnail' || url.username || url.password || url.port || url.search || url.hash
    || !/^\/[0-9a-f]{64}i\d{1,10}$/i.test(url.pathname)) {
    throw new AppError('UNSAFE_ORD_PATH', 'Invalid inscription preview address', { status: 400 });
  }
  if (!['GET', 'HEAD'].includes(request.method)) throw new AppError('METHOD_NOT_ALLOWED', 'Preview requests must use GET or HEAD', { status: 405 });
  const result = await resolver.resolve(`ord://content${url.pathname.toLowerCase()}`, {
    maxBytes: MAX_THUMBNAIL_BYTES, accept: [...RASTER_TYPES].join(','), signal: request.signal
  });
  const type = new Headers(result.headers).get('content-type')?.toLowerCase().split(';')[0].trim();
  if (!RASTER_TYPES.has(type) || result.status !== 200) throw new AppError('PREVIEW_UNAVAILABLE', 'Open this inscription to view its content.', { status: 415 });
  if (!result.data?.byteLength || result.data.byteLength > MAX_THUMBNAIL_BYTES) throw new AppError('RESOURCE_TOO_LARGE', 'Image preview exceeds its size limit.', { status: 413 });
  const data = await decodedContentBytes(result, MAX_THUMBNAIL_BYTES, request.signal);
  return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers: {
    'content-type': type, 'content-length': String(data.byteLength),
    'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store'
  } });
}
