import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import { AppError } from '../shared/errors.js';

const decoders = new Map([['br', promisify(brotliDecompress)], ['gzip', promisify(gunzip)], ['deflate', promisify(inflate)]]);

// The resolver caches wire bytes. Native custom-protocol responses and inert
// projections decode once with an OUTPUT bound and rebuild response headers.
export async function decodedContentBytes(result, maxBytes, signal) {
  signal?.throwIfAborted();
  if (!(result.data instanceof Uint8Array) || result.data.byteLength > maxBytes) throw new AppError('RESOURCE_TOO_LARGE', 'Content exceeds the preview size limit.', { status: 413 });
  const encoding = (new Headers(result.headers).get('content-encoding') ?? '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return result.data;
  const decode = decoders.get(encoding);
  if (!decode) throw new AppError('CONTENT_ENCODING_UNSUPPORTED', 'This content encoding is not supported by the preview.', { status: 415 });
  try {
    const data = await decode(result.data, { maxOutputLength: maxBytes });
    signal?.throwIfAborted(); return data;
  } catch (error) {
    signal?.throwIfAborted();
    throw new AppError(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'RESOURCE_TOO_LARGE' : 'CONTENT_DECODE_FAILED',
      error.code === 'ERR_BUFFER_TOO_LARGE' ? 'Decoded content exceeds the preview size limit.' : 'The compressed content could not be decoded.', { status: error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 415 });
  }
}
