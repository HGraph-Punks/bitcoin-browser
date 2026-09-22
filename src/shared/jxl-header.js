// Read only the size header before entering the locally bundled libjxl decoder.
// Layout: libjxl SizeHeader::VisitFields (headers.cc), ISO/IEC 18181 codestream.
import { DOCUMENT_LIMITS, previewFailure } from './document-preview.js';
export const MAX_JXL_PIXELS = 16_777_216;
export function jxlDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > DOCUMENT_LIMITS.jxl) throw previewFailure('Invalid or oversized JPEG XL file.');
  let stream = bytes;
  if (bytes[0] !== 255 || bytes[1] !== 10) {
    const signature = [0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10];
    if (!signature.every((value, index) => bytes[index] === value)) throw previewFailure('Invalid JPEG XL signature.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), parts = [];
    let offset = 12, size = 0, sequence = 0, complete = false, boxes = 0;
    while (offset < bytes.length) {
      if (++boxes > 256 || offset + 8 > bytes.length) throw previewFailure('Invalid JPEG XL container.');
      let length = view.getUint32(offset), header = 8;
      const type = view.getUint32(offset + 4);
      if (length === 1) {
        if (offset + 16 > bytes.length || view.getUint32(offset + 8) !== 0) throw previewFailure('Oversized JPEG XL box.');
        length = view.getUint32(offset + 12); header = 16;
      } else if (length === 0) length = bytes.length - offset;
      if (length < header || offset + length > bytes.length) throw previewFailure('Invalid JPEG XL box.');
      if (type === 0x6a786c63 || type === 0x6a786c70) {
        if (complete) throw previewFailure('Duplicate JPEG XL codestream.');
        let start = offset + header;
        if (type === 0x6a786c70) {
          if (length < header + 4) throw previewFailure('Invalid JPEG XL fragment.');
          const index = view.getUint32(start); start += 4;
          if ((index & 0x7fffffff) !== sequence++) throw previewFailure('Unordered JPEG XL fragments.');
          complete = Boolean(index & 0x80000000);
        } else { if (sequence || parts.length) throw previewFailure('Duplicate JPEG XL codestream.'); complete = true; }
        const part = bytes.subarray(start, offset + length); parts.push(part); size += part.length;
      }
      offset += length;
    }
    if (!complete || size < 4) throw previewFailure('Missing JPEG XL codestream.');
    stream = new Uint8Array(size); let position = 0; for (const part of parts) { stream.set(part, position); position += part.length; }
    if (stream[0] !== 255 || stream[1] !== 10) throw previewFailure('Invalid JPEG XL codestream.');
  }
  let bit = 16;
  function bits(count) {
    if (bit + count > stream.length * 8) throw previewFailure('Incomplete JPEG XL size header.');
    let result = 0; for (let i = 0; i < count; i++, bit++) result += ((stream[bit >> 3] >> (bit & 7)) & 1) * 2 ** i;
    return result;
  }
  const small = bits(1), dimension = () => small ? (bits(5) + 1) * 8 : bits([9, 13, 18, 30][bits(2)]) + 1;
  const height = dimension(), ratio = bits(3);
  const ratios = [[1, 1], [12, 10], [4, 3], [3, 2], [16, 9], [5, 4], [2, 1]];
  const width = ratio ? Math.floor(height * ratios[ratio - 1][0] / ratios[ratio - 1][1]) : dimension();
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_JXL_PIXELS) throw previewFailure('JPEG XL previews are limited to 16 megapixels and 16,384 pixels per edge.');
  return { width, height };
}
