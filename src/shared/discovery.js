import { AppError } from './errors.js';
import { inscriptionPresentation } from './inscription-presentation.js';

export const DISCOVERY_PAGE_SIZE = 24;
export const ORD_LISTING_PAGE_SIZE = 100;
export const DISCOVERY_MAX_PAGE = 10_000_000;
export const DISCOVERY_MAX_BLOCK = 10_000_000;

function invalid() {
  return new AppError('INVALID_TARGET', 'Choose a valid inscription page or Bitcoin block height.', { status: 400 });
}

export function discoveryQuery(value = '') {
  if (typeof value !== 'string' || value.length > 256) throw invalid();
  const params = new URLSearchParams(value);
  for (const key of params.keys()) {
    if (!['page', 'offset', 'block'].includes(key) || params.getAll(key).length !== 1) throw invalid();
  }
  const integer = (key, max, fallback) => {
    if (!params.has(key)) return fallback;
    const text = params.get(key);
    if (!/^\d{1,8}$/.test(text)) throw invalid();
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n > max) throw invalid();
    return n;
  };
  const page = integer('page', DISCOVERY_MAX_PAGE, 0);
  const offset = integer('offset', 99, 0);
  if (offset % DISCOVERY_PAGE_SIZE !== 0) throw invalid();
  return { page, offset, block: integer('block', DISCOVERY_MAX_BLOCK, null) };
}

export function discoveryCanonical({ page = 0, offset = 0, block = null } = {}) {
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(offset)
      || (block !== null && !Number.isSafeInteger(block))) throw invalid();
  const params = new URLSearchParams();
  if (page) params.set('page', String(page));
  if (offset) params.set('offset', String(offset));
  if (block !== null) params.set('block', String(block));
  discoveryQuery(params.toString());
  return `satnav://inscriptions${params.size ? `?${params}` : ''}`;
}

export function discoveryTarget(value = '') {
  const query = discoveryQuery(value);
  const canonical = discoveryCanonical(query);
  return {
    kind: 'inscriptions', value: canonical.split('?')[1] ?? '', canonical,
    display: query.block === null ? 'Explore inscriptions' : `Inscriptions in block ${query.block}`,
    confidence: 'high', ambiguous: false, alternatives: []
  };
}

export function inscriptionMediaType(contentType) {
  const type = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  const presentation = inscriptionPresentation(type);
  if (presentation === 'model') return 'models';
  if (presentation === 'pdf') return 'documents';
  if (presentation === 'font') return 'fonts';
  if (type.startsWith('image/')) return 'images';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'interactive';
  if (['text', 'markdown'].includes(presentation)) return 'text';
  if (presentation === 'audio' || type.startsWith('audio/')) return 'audio';
  if (presentation === 'video' || type.startsWith('video/')) return 'video';
  return 'other';
}
