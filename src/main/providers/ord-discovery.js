import { AppError } from '../../shared/errors.js';
import { INSCRIPTION_ID_RE } from '../../shared/navigation.js';
import { DISCOVERY_MAX_PAGE, DISCOVERY_PAGE_SIZE, ORD_LISTING_PAGE_SIZE, discoveryCanonical, discoveryQuery } from '../../shared/discovery.js';
import { ordinalSatNumber, recognizedCharms } from '../../shared/ordinal-traits.js';

const LISTING_BYTES = 512 * 1024;
const METADATA_BYTES = 64 * 1024;
const WORKERS = 4;

function invalid(message = 'Ord returned an invalid inscription listing') {
  return new AppError('INVALID_PROVIDER_RESPONSE', message, { status: 502, retryable: true });
}

function ids(value) {
  if (!Array.isArray(value) || value.length > ORD_LISTING_PAGE_SIZE) throw invalid();
  const result = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || id.length > 80 || !INSCRIPTION_ID_RE.test(id)) throw invalid();
    const normalized = id.toLowerCase();
    if (seen.has(normalized)) throw invalid('Ord returned duplicate inscription IDs');
    seen.add(normalized); result.push(normalized);
  }
  return result;
}

function expectedPath(query, page = query.page) {
  return query.block === null ? `/inscriptions/${page}` : `/inscriptions/block/${query.block}/${page}`;
}

export function parseOrdListing(response, query) {
  const type = String(response.headers?.['content-type'] ?? '').toLowerCase();
  const text = response.data.toString('utf8');
  if (response.data.length > LISTING_BYTES) throw new AppError('RESOURCE_TOO_LARGE', 'Ord inscription listing is too large', { status: 413 });
  if (type.includes('json') || /^[\s]*[\[{]/.test(text)) {
    let body;
    try { body = JSON.parse(text); } catch { throw invalid(); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
    if (body.more !== undefined && typeof body.more !== 'boolean') throw invalid();
    if (body.page_index !== undefined && body.page_index !== query.page) throw invalid('Ord returned a mismatched page index');
    const listing = body.ids ?? body.inscriptions;
    const parsedIds = ids(listing);
    const more = body.more ?? false;
    return { ids: parsedIds, hasNextPage: more, listingFormat: 'json' };
  }
  if (!type.includes('text/html')) throw invalid();
  const heading = text.match(/<main(?:\s[^>]*)?>[\s\S]*?<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/i)?.[1];
  const expectedHeading = query.block === null
    ? /^\s*(?:All\s+)?Inscriptions\s*$/i
    : new RegExp(`^\\s*Inscriptions\\s+in\\s+<a\\s+href=(?:"/block/${query.block}"|'/block/${query.block}'|/block/${query.block})>\\s*Block\\s+${query.block}\\s*</a>\\s*$`, 'i');
  if (!heading || !expectedHeading.test(heading)
      || !/<div\s+class=(?:["'][^"']*\bthumbnails\b[^"']*["']|thumbnails)(?:\s|>)/i.test(text)) throw invalid();
  const thumbnailBody = text.match(/<div\s+class=(?:["'][^"']*\bthumbnails\b[^"']*["']|thumbnails)(?:\s[^>]*)?>([\s\S]*?)<\/div>/i)?.[1];
  if (thumbnailBody === undefined) throw invalid();
  const hrefs = [...thumbnailBody.matchAll(/\bhref\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi)].map((match) => match[1] ?? match[2]);
  const inscriptionHrefs = hrefs.filter((href) => href.startsWith('/inscription/'));
  if (hrefs.some((href) => href.includes('/inscription/') && !href.startsWith('/inscription/'))) throw invalid('Ord returned an unsafe inscription link');
  if (inscriptionHrefs.some((href) => !/^\/inscription\/[0-9a-f]{64}i\d+$/i.test(href))) throw invalid('Ord returned an unsafe inscription link');
  const parsedIds = ids(inscriptionHrefs.map((href) => href.slice('/inscription/'.length)));
  const nextLinks = [...text.matchAll(/<a\b([^>]*)>/gi)].filter((match) => /\bclass\s*=\s*(?:["'][^"']*\bnext\b[^"']*["']|next)(?:\s|$)/i.test(match[1])).map((match) => {
    const href = match[1].match(/\bhref\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    return href?.[1] ?? href?.[2] ?? '';
  });
  let hasNextPage = false;
  for (const href of nextLinks) {
    const adjacentBlock = query.block !== null && href === `/inscriptions/block/${query.block + 1}`;
    if (adjacentBlock) continue;
    if (query.page < DISCOVERY_MAX_PAGE && href === expectedPath(query, query.page + 1) && !hasNextPage) { hasNextPage = true; continue; }
    throw invalid('Ord returned an invalid next page');
  }
  return { ids: parsedIds, hasNextPage, listingFormat: 'html' };
}

function metadata(raw, id) {
  if (!raw || typeof raw !== 'object' || raw.id?.toLowerCase() !== id) throw invalid('Ord returned mismatched inscription metadata');
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    id,
    number: (Number.isSafeInteger(raw.number) || typeof raw.number === 'string' && /^-?\d{1,15}$/.test(raw.number)) && String(raw.number).length <= 16 ? String(raw.number) : null,
    contentType: typeof raw.content_type === 'string' ? raw.content_type.slice(0, 256) : null,
    contentLength: integer(raw.content_length),
    height: integer(raw.height),
    sat: ordinalSatNumber(raw.sat),
    charms: Array.isArray(raw.charms) ? recognizedCharms(raw.charms) : null,
    timestamp: integer(raw.timestamp),
    metadataUnavailable: false
  };
}

function isCancellation(error, signal) {
  return signal.aborted || ['ROUTING_INVALIDATED', 'PROVIDER_TIMEOUT', 'ABORT_ERR'].includes(error?.code) || error?.name === 'AbortError';
}

export async function discoverOrdInscriptions(provider, target, options = {}) {
  const query = discoveryQuery(target.value);
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 60_000));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new AppError('PROVIDER_TIMEOUT', 'Ord inscription discovery timed out', { status: 504, retryable: true })), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    if (signal.aborted) throw signal.reason;
    const listingPath = expectedPath(query);
    let listingResponse = await provider.fetchPath(listingPath, {
      accept: 'application/json', signal, timeoutMs,
      maxBytes: Math.min(options.maxBytes ?? LISTING_BYTES, LISTING_BYTES), allowExplorerPath: true, allowStatuses: [406]
    });
    if (signal.aborted) throw signal.reason;
    if (listingResponse.status === 406) {
      listingResponse = await provider.fetchPath(listingPath, {
        accept: 'text/html', signal, timeoutMs,
        maxBytes: Math.min(options.maxBytes ?? LISTING_BYTES, LISTING_BYTES), allowExplorerPath: true
      });
    }
    if (signal.aborted) throw signal.reason;
    const listing = parseOrdListing(listingResponse, query);
    const selected = listing.ids.slice(query.offset, query.offset + DISCOVERY_PAGE_SIZE);
    const items = new Array(selected.length);
    let cursor = 0;
    let cancellation = null;
    const worker = async () => {
      while (!cancellation) {
        // A fulfilled transport may ignore cancellation. Do not replenish the
        // worker pool after abort, even when its previous request succeeded.
        if (signal.aborted) { cancellation = signal.reason; return; }
        const index = cursor++;
        if (index >= selected.length) return;
        const id = selected[index];
        try {
          const response = await provider.fetchPath(`/r/inscription/${id}`, {
            accept: 'application/json', signal, timeoutMs, maxBytes: Math.min(options.maxBytes ?? METADATA_BYTES, METADATA_BYTES)
          });
          if (signal.aborted) throw signal.reason;
          items[index] = metadata(JSON.parse(response.data.toString('utf8')), id);
        } catch (error) {
          if (isCancellation(error, signal)) { cancellation = signal.reason ?? error; return; }
          items[index] = { id, number: null, contentType: null, contentLength: null, height: null, metadataUnavailable: true };
        }
      }
    };
    // Keep every admitted worker owned through settlement, including any
    // unexpected rejection while sibling transports are still draining.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(WORKERS, selected.length) }, worker));
    if (signal.aborted && !cancellation) cancellation = signal.reason;
    if (cancellation) throw cancellation;
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const remaining = query.offset + DISCOVERY_PAGE_SIZE < listing.ids.length;
    const next = remaining ? discoveryCanonical({ ...query, offset: query.offset + DISCOVERY_PAGE_SIZE })
      : listing.hasNextPage && query.page < DISCOVERY_MAX_PAGE ? discoveryCanonical({ page: query.page + 1, block: query.block }) : null;
    const previous = query.offset >= DISCOVERY_PAGE_SIZE
      ? discoveryCanonical({ ...query, offset: query.offset - DISCOVERY_PAGE_SIZE })
      : query.page > 0 ? discoveryCanonical({ page: query.page - 1, offset: 96, block: query.block }) : null;
    return { items, next, previous, page: query.page, offset: query.offset, block: query.block,
      listingFormat: listing.listingFormat, partial: items.some((item) => item.metadataUnavailable) };
  } finally { clearTimeout(timer); }
}

export function inscriptionIdFromHtml(response, expectedNumber) {
  const text = response.data.toString('utf8');
  if (response.data.length > LISTING_BYTES || !/<main(?:\s[^>]*)?>/i.test(text)) throw invalid();
  const ids = [...text.matchAll(/<dt(?:\s[^>]*)?>\s*id\s*<\/dt>\s*<dd(?:\s[^>]*)?>\s*([0-9a-f]{64}i\d+)\s*<\/dd>/gi)]
    .map((match) => match[1].toLowerCase()).filter((value) => value.length <= 80);
  const unique = [...new Set(ids)];
  if (unique.length !== 1) throw invalid('Ord inscription page did not identify one inscription');
  const number = text.match(/<h1(?:\s[^>]*)?>\s*Inscription\s+#?(-?\d{1,15})\s*<\/h1>/i)?.[1];
  if (number !== undefined && String(expectedNumber) !== number) throw invalid('Ord returned a different inscription number');
  return unique[0];
}
