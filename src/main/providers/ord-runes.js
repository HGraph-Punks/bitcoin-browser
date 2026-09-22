import { AppError } from '../../shared/errors.js';
import { runeLookup, runeIdentity, runesQuery, runesCanonical, RUNE_U128_MAX, RUNES_MAX_PAGE, RUNES_PAGE_LIMIT } from '../../shared/runes.js';

const MAX_BYTES = 256 * 1024;
const U64 = (1n << 64n) - 1n;
const TXID = /^[0-9a-f]{64}$/;
const INSCRIPTION = /^[0-9a-f]{64}i\d{1,10}$/;
const invalid = () => new AppError('INVALID_PROVIDER_RESPONSE', 'This source returned incomplete or inconsistent Rune data. Try another Ord source.', { status: 502, retryable: true });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function uint(value, max = RUNE_U128_MAX) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid();
  const text = String(value);
  if (!/^\d{1,39}$/.test(text) || BigInt(text) > max) throw invalid();
  return BigInt(text).toString();
}
function optionalUint(value, max = U64) { return value == null ? null : uint(value, max); }
function name(value) {
  try {
    const parsed = runeLookup(value);
    if (parsed.includes(':') || parsed !== value) throw invalid();
    return parsed;
  } catch { throw invalid(); }
}
function id(value) {
  try { const parsed = runeLookup(value); if (!parsed.includes(':') || parsed !== value) throw invalid(); return parsed; } catch { throw invalid(); }
}
function symbol(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || [...value].length !== 1 || /^[\uD800-\uDFFF]$/.test(value)) throw invalid();
  // Protocol symbols may be non-printing scalars. Keep their code point in
  // metadata without allowing bidi/format controls to reorder the app UI.
  return /[\p{C}\p{Z}]/u.test(value) ? null : value;
}
function boolean(value) { if (typeof value !== 'boolean') throw invalid(); return value; }
function pair(value) {
  if (!Array.isArray(value) || value.length !== 2) throw invalid();
  return value.map(item => optionalUint(item));
}

export function parseRuneJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw invalid();
  try {
    return JSON.parse(text, (_key, value, context) => {
      if (typeof value !== 'number') return value;
      // Node 22+ supplies the original token, even for a u128 JSON number.
      // Refuse unsupported runtimes rather than quietly returning rounded data.
      if (!context?.source || !/^\d+$/.test(context.source)) throw invalid();
      return context.source;
    });
  } catch { throw invalid(); }
}

export function normalizeRune(raw, expected = null) {
  if (!object(raw) || !object(raw.entry)) throw invalid();
  const e = raw.entry;
  const rune = {
    runeVersion: 1, name: name(e.spaced_rune), id: id(raw.id),
    number: uint(e.number, U64), divisibility: Number(uint(e.divisibility, 38n)), symbol: symbol(e.symbol),
    symbolCodePoint: e.symbol == null ? null : `U+${e.symbol.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    premine: uint(e.premine), burned: uint(e.burned), mints: uint(e.mints),
    timestamp: Number(uint(e.timestamp, 0xffffffffn)), block: uint(e.block, U64),
    etching: e.etching, turbo: boolean(e.turbo),
    mintable: raw.mintable == null ? null : boolean(raw.mintable),
    parent: raw.parent ?? null, terms: null
  };
  if (!TXID.test(rune.etching) || (rune.parent !== null && !INSCRIPTION.test(rune.parent)) || rune.block !== rune.id.split(':')[0]) throw invalid();
  if (expected && (expected.includes(':') ? rune.id !== runeLookup(expected) : runeIdentity(rune.name) !== runeIdentity(expected))) throw invalid();
  if (e.terms !== null) {
    if (!object(e.terms)) throw invalid();
    rune.terms = { amount: optionalUint(e.terms.amount, RUNE_U128_MAX), cap: optionalUint(e.terms.cap, RUNE_U128_MAX), height: pair(e.terms.height), offset: pair(e.terms.offset) };
  }
  const amount = BigInt(rune.terms?.amount ?? '0');
  const supply = BigInt(rune.premine) + BigInt(rune.mints) * amount;
  if (supply > RUNE_U128_MAX || BigInt(rune.burned) > supply || (!rune.terms && rune.mints !== '0')) throw invalid();
  if (rune.terms && BigInt(rune.mints) > BigInt(rune.terms.cap ?? '0')) throw invalid();
  if (rune.mintable === true && (!rune.terms || BigInt(rune.terms.cap ?? '0') <= BigInt(rune.mints))) throw invalid();
  rune.supply = supply.toString();
  rune.outstanding = (supply - BigInt(rune.burned)).toString();
  const maximum = BigInt(rune.premine) + BigInt(rune.terms?.cap ?? '0') * amount;
  rune.maximum = maximum <= RUNE_U128_MAX ? maximum.toString() : null;
  const bound = (index, choose) => {
    const absolute = rune.terms?.height[index] ?? null;
    const offset = rune.terms?.offset[index] ?? null;
    const relative = offset === null ? null : (BigInt(rune.block) + BigInt(offset)).toString();
    if (absolute === null) return relative;
    if (relative === null) return absolute;
    return choose(BigInt(absolute), BigInt(relative)).toString();
  };
  rune.mintStart = bound(0, (a, b) => a > b ? a : b);
  rune.mintEnd = bound(1, (a, b) => a < b ? a : b);
  rune.predefined = rune.id === '1:0' && rune.name === 'UNCOMMON•GOODS' && /^0{64}$/.test(rune.etching);
  return rune;
}

// HTML is parsed only as bounded, inert data in the main process. No provider
// markup, links, scripts, styles, or images are forwarded into the app DOM.
function textOf(value) {
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    if (known[entity.toLowerCase()]) return known[entity.toLowerCase()];
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isSafeInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  }).trim();
}
function mainHtml(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw invalid();
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(text)?.[1];
  if (!main) throw invalid();
  return main;
}
function fieldsFromHtml(main) {
  const fields = Object.create(null);
  // Skip the outer mint <dd><dl> while collecting its leaf fields.
  for (const match of main.matchAll(/<dt\b[^>]*>([^<]+)<\/dt>\s*<dd\b[^>]*>((?:(?!<d[lt]\b)[\s\S])*?)<\/dd>/gi)) {
    const key = textOf(match[1]).toLowerCase();
    if (Object.hasOwn(fields, key)) throw invalid();
    fields[key] = textOf(match[2]);
  }
  return fields;
}
function htmlAmount(value, divisibility) {
  if (typeof value !== 'string' || value.length > 100) throw invalid();
  const match = /^(\d+)(?:\.(\d+))?(?:\s+\S+)?$/u.exec(value);
  if (!match || (match[2]?.length ?? 0) > divisibility) throw invalid();
  return uint(match[1] + (match[2] ?? '').padEnd(divisibility, '0'));
}

export function runeFromHtml(text, expected) {
  const main = mainHtml(text);
  const f = fieldsFromHtml(main);
  const runeName = textOf(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? '');
  const divisibility = Number(uint(f.divisibility, 38n));
  const mint = f.mint !== 'no';
  if (mint && !['true', 'false'].includes(f.mintable)) throw invalid();
  if (!/^(true|false)$/.test(f.turbo)) throw invalid();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(f.timestamp)) throw invalid();
  const timestamp = Date.parse(f.timestamp.replace(' ', 'T').replace(' UTC', 'Z')) / 1000;
  const rune = normalizeRune({ id: f.id, mintable: mint ? f.mintable === 'true' : false, parent: f.parent ?? null,
    entry: { spaced_rune: runeName, number: f.number, divisibility, symbol: f.symbol ?? null,
      premine: htmlAmount(f.premine, divisibility), burned: htmlAmount(f.burned, divisibility),
      mints: mint ? f.mints : '0', timestamp, block: f['etching block'], etching: f.etching, turbo: f.turbo === 'true',
      terms: mint ? { amount: f.amount == null ? null : htmlAmount(f.amount, divisibility), cap: f.cap ?? null,
        height: [f.start ?? null, f.end ?? null], offset: [null, null] } : null }
  }, expected);
  if (rune.supply !== htmlAmount(f.supply, divisibility)) throw invalid();
  // HTML publishes effective bounds, not the original relative offset terms.
  rune.format = 'html';
  rune.termsRepresentation = 'effective';
  return rune;
}

function pageNumber(value, expected) {
  if (value == null) return null;
  const n = Number(uint(value, BigInt(RUNES_MAX_PAGE)));
  if (n !== expected) throw invalid();
  return n;
}
export function runesFromJson(raw, page) {
  if (!object(raw) || !Array.isArray(raw.entries) || raw.entries.length > RUNES_PAGE_LIMIT || typeof raw.more !== 'boolean') throw invalid();
  const items = raw.entries.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) throw invalid();
    return normalizeRune({ id: pair[0], entry: pair[1] });
  });
  if (new Set(items.map(item => runeIdentity(item.name))).size !== items.length || new Set(items.map(item => item.id)).size !== items.length) throw invalid();
  const next = pageNumber(raw.next, page + 1);
  const previous = pageNumber(raw.prev, page - 1);
  if (raw.more !== (next !== null) || (page === 0 && previous !== null)) throw invalid();
  return { items, next: next === null ? null : runesCanonical(next), previous: previous === null ? null : runesCanonical(previous), format: 'json' };
}

export function runesFromHtml(text, page) {
  const main = mainHtml(text);
  if (!/<h1\b[^>]*>\s*Runes\s*<\/h1>/i.test(main)) throw invalid();
  const list = /<ul\b[^>]*>([\s\S]*?)<\/ul>/i.exec(main)?.[1];
  if (list == null) throw invalid();
  const items = [];
  for (const match of list.matchAll(/<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1] ?? match[2] ?? match[3];
    const runeName = name(textOf(match[4]));
    let linked;
    try { linked = decodeURIComponent(href.slice('/rune/'.length)); } catch { throw invalid(); }
    if (!href.startsWith('/rune/') || runeIdentity(linked) !== runeIdentity(runeName) || items.length >= RUNES_PAGE_LIMIT) throw invalid();
    items.push({ name: runeName, detailsOnOpen: true });
  }
  if ((list.match(/<li\b/gi) ?? []).length !== items.length || new Set(items.map(item => runeIdentity(item.name))).size !== items.length) throw invalid();
  const pagination = Object.create(null);
  for (const match of main.slice(main.indexOf('</ul>') + 5).matchAll(/<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*(prev|next)\s*<\/a>/gi)) {
    const key = match[4].toLowerCase();
    const path = /^\/runes\/(\d+)$/.exec(match[1] ?? match[2] ?? match[3]);
    if (!path || Object.hasOwn(pagination, key)) throw invalid();
    pagination[key] = pageNumber(path[1], page + (key === 'next' ? 1 : -1));
  }
  return { items, next: pagination.next == null ? null : runesCanonical(pagination.next), previous: pagination.prev == null ? null : runesCanonical(pagination.prev), format: 'html' };
}

export async function resolveOrdRunes(provider, target, options = {}) {
  const page = target.kind === 'runes' ? runesQuery(target.value).page : null;
  const lookup = page === null ? runeLookup(target.value) : null;
  const path = page === null ? `/rune/${encodeURIComponent(lookup)}` : `/runes/${page}`;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12_000, 60_000));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new AppError('PROVIDER_TIMEOUT', 'Ord Rune lookup timed out', { status: 504, retryable: true })), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const fetch = accept => provider.fetchPath(path, { accept, signal, timeoutMs,
    maxBytes: Math.min(options.maxBytes ?? MAX_BYTES, MAX_BYTES), allowExplorerPath: true, allowStatuses: accept === 'application/json' ? [406] : undefined });
  try {
    signal.throwIfAborted();
    let response = await fetch('application/json');
    signal.throwIfAborted();
    if (response.status === 406) response = await fetch('text/html');
    signal.throwIfAborted();
    const text = response.data.toString('utf8');
    const isHtml = /^\s*</.test(text);
    const data = page === null
      ? isHtml ? runeFromHtml(text, lookup) : { ...normalizeRune(parseRuneJson(text), lookup), format: 'json', termsRepresentation: 'original' }
      : isHtml ? runesFromHtml(text, page) : runesFromJson(parseRuneJson(text), page);
    signal.throwIfAborted();
    return { data, endpoint: path };
  } catch (error) { options.signal?.throwIfAborted(); signal.throwIfAborted(); throw error; }
  finally { clearTimeout(timer); }
}
