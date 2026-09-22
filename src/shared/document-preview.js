export const DOCUMENT_KINDS = Object.freeze(['pdf', 'font', 'markdown', 'jxl', 'binary']);
export const DOCUMENT_LIMITS = Object.freeze({ pdf: 32 * 1024 * 1024, font: 4 * 1024 * 1024, markdown: 256 * 1024, jxl: 8 * 1024 * 1024, binary: 8 * 1024 * 1024 });
export const PREVIEW_DEADLINE_MS = 45_000;
export const INSCRIPTION_PREVIEW_ID = /^[0-9a-f]{64}i\d{1,10}$/i;
export function previewRoute(pathname) {
  const match = /^\/(pdf|font|markdown|jxl|binary)\/([0-9a-f]{64}i\d{1,10})$/i.exec(pathname);
  return match ? { kind: match[1].toLowerCase(), id: match[2].toLowerCase() } : null;
}
export function previewFailure(message) { const error = new Error(message); error.code = 'PREVIEW_INVALID'; return error; }
export function previewDiagnosticCode(error) {
  if (['PREVIEW_TIMEOUT', 'PREVIEW_WORKER', 'PREVIEW_PASSWORD'].includes(error?.code)) return error.code;
  const codes = { SecurityError: 'PREVIEW_SECURITY', TypeError: 'PREVIEW_TYPE', InvalidStateError: 'PREVIEW_STATE', DataCloneError: 'PREVIEW_CLONE', InvalidPDFException: 'PREVIEW_PDF_INVALID', PasswordException: 'PREVIEW_PASSWORD' };
  return Object.hasOwn(codes, error?.name) ? codes[error.name] : 'PREVIEW_INVALID';
}
export function fontSignature(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > DOCUMENT_LIMITS.font) throw previewFailure('The font file is empty, incomplete or too large.');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), signature = data.getUint32(0);
  if ([0x774f4646, 0x774f4632].includes(signature)) {
    if (bytes.length < (signature === 0x774f4632 ? 48 : 44) || data.getUint32(8) !== bytes.length || !data.getUint16(12) || data.getUint16(12) > 256 || data.getUint32(16) < 12 || data.getUint32(16) > 16 * 1024 * 1024) throw previewFailure('This web font exceeds the safe preview bounds or has a damaged header.');
    return signature === 0x774f4632 ? 'woff2' : 'woff';
  }
  if ([0x00010000, 0x4f54544f, 0x74727565].includes(signature)) {
    const tables = data.getUint16(4); if (!tables || tables > 256 || bytes.length < 12 + tables * 16) throw previewFailure('The font table directory is invalid.');
    for (let i = 0; i < tables; i++) { const offset = 12 + i * 16; if (data.getUint32(offset + 8) + data.getUint32(offset + 12) > bytes.length) throw previewFailure('A font table is outside the file.'); }
    return signature === 0x4f54544f ? 'otf' : 'ttf';
  }
  throw previewFailure('This is not a supported OpenType, TrueType, WOFF or WOFF2 font.');
}
export function binaryPreview(bytes, maxBytes = 4096) {
  const shown = bytes.subarray(0, maxBytes), lines = [];
  for (let offset = 0; offset < shown.length; offset += 16) {
    const row = shown.subarray(offset, offset + 16);
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${Array.from(row, x => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')}  ${Array.from(row, x => x >= 32 && x <= 126 ? String.fromCharCode(x) : '.').join('')}`);
  }
  return { text: lines.join('\n'), shown: shown.length, total: bytes.length };
}
export function previewLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  const inscription = /^(?:\/content\/|ord:\/\/content\/|inscription:)([0-9a-f]{64}i\d{1,10})$/i.exec(value);
  if (inscription) return `inscription:${inscription[1].toLowerCase()}`;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function markdownImage(value) {
  const link = previewLink(value);
  if (link?.startsWith('inscription:')) return `ord://thumbnail/${link.slice(12)}`;
  if (typeof value === 'string' && value.length <= 256 * 1024 && /^data:image\/(?:png|jpeg|gif|webp|avif|apng);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  return null;
}
export function pdfRenderSize(width, height, scale = 1) {
  if (![width, height, scale].every(Number.isFinite) || width <= 0 || height <= 0 || width > 1e6 || height > 1e6 || scale <= 0) throw previewFailure('This PDF page has invalid dimensions.');
  const bounded = Math.min(scale, 8192 / width, 8192 / height, Math.sqrt(8_388_608 / (width * height)));
  return { scale: bounded, width: Math.max(1, Math.floor(width * bounded)), height: Math.max(1, Math.floor(height * bounded)) };
}
export async function fetchPreviewBytes(url, { maxBytes, signal, fetcher = globalThis.fetch } = {}) {
  signal?.throwIfAborted();
  const response = await fetcher(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (!response.ok) throw previewFailure(response.status === 413 ? 'This file exceeds the preview size limit. Save the original for the complete file.' : 'The selected source or offline cache could not supply this file.');
  if (!response.body?.getReader || Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw previewFailure('This file exceeds the preview size limit.'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) { signal?.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw previewFailure('This file exceeds the preview size limit.'); chunks.push(value); }
    signal?.throwIfAborted();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return { data, type: response.headers.get('x-satoshi-content-type') ?? 'application/octet-stream' };
}
