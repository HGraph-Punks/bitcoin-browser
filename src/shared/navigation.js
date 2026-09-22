import { AppError } from './errors.js';
import { discoveryTarget } from './discovery.js';
import { runeLookup, runesTarget } from './runes.js';

export const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d+$/i;
export const TXID_RE = /^[0-9a-f]{64}$/i;
export const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/i;
export const SATPOINT_RE = /^[0-9a-f]{64}:\d+:\d+$/i;
export const INTEGER_RE = /^\d+$/;
// Lookup recognition, not checksum/spend validation. Separate Bech32 case
// branches accept uppercase presentation without admitting mixed-case input.
export const ADDRESS_RE = /^(?:bc1|tb1|bcrt1)[ac-hj-np-z02-9]{6,87}$|^(?:BC1|TB1|BCRT1)[AC-HJ-NP-Z02-9]{6,87}$|^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^[mn2][a-km-zA-HJ-NP-Z1-9]{25,40}$/;
export const SAT_NAME_RE = /^[a-z]{1,20}$/;

const PREFIXES = new Map([
  ['inscription', 'inscription'],
  ['insc', 'inscription'],
  ['i', 'inscription'],
  ['sat', 'sat'],
  ['satoshi', 'sat'],
  ['block', 'block'],
  ['height', 'block'],
  ['tx', 'transaction'],
  ['transaction', 'transaction'],
  ['output', 'output'],
  ['outpoint', 'output'],
  ['satpoint', 'satpoint'],
  ['address', 'address'],
  ['addr', 'address'],
  ['rune', 'rune'],
  ['collection', 'collection'],
  ['search', 'search'],
  ['web', 'external-web'],
  ['content', 'content'],
  ['recursive', 'recursive']
]);

function result(kind, value, canonical, display, options = {}) {
  return {
    kind,
    value,
    canonical,
    display: display ?? canonical,
    confidence: options.confidence ?? 'high',
    ambiguous: Boolean(options.ambiguous),
    alternatives: options.alternatives ?? []
  };
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseDeepLink(url) {
  const route = url.hostname.toLowerCase();
  const value = decodePart(url.pathname.replace(/^\/+/, ''));
  if (!route || route === 'home') return result('home', null, 'satnav://home', 'Home');
  if (['bookmarks', 'history', 'wallet', 'providers', 'services', 'node-setup', 'settings', 'about', 'sponsors', 'documentation', 'ai'].includes(route)) return result('internal', route, `satnav://${route}`, route === 'ai' ? 'Ask Bitcoin' : route === 'node-setup' ? 'Set up a local node' : route[0].toUpperCase() + route.slice(1));
  if (route === 'inscription') return parsePrefixed('inscription', value);
  if (route === 'sat') return parsePrefixed('sat', value);
  if (route === 'block') return parsePrefixed('block', value);
  if (route === 'tx' || route === 'transaction') return parsePrefixed('transaction', value);
  if (route === 'output') return parsePrefixed('output', value);
  if (route === 'address') return parsePrefixed('address', value);
  if (route === 'rune') return parsePrefixed('rune', value);
  if (route === 'collection') return parsePrefixed('collection', value);
  if (route === 'content') return parsePrefixed('content', value);
  return result('search', `${route}/${value}`.replace(/\/$/, ''), `search:${route}/${value}`, `${route}/${value}`, { confidence: 'low' });
}

function parseOrdUrl(url) {
  const host = url.hostname;
  let path = url.pathname;
  if (host === 'content' && !path.startsWith('/content/') && !path.startsWith('/r/')) path = `/content${path}`;
  else if (host === 'r' && !path.startsWith('/r/')) path = `/r${path}`;
  else if (host && host !== 'content' && host !== 'r') path = `/${host}${path}`;
  if (path.startsWith('/content/')) {
    const id = path.slice('/content/'.length).split('/')[0];
    if (INSCRIPTION_ID_RE.test(id)) return result('content', id.toLowerCase(), `ord://content/${id.toLowerCase()}`, `Content ${id}`);
  }
  return result('recursive', path + url.search, `ord://${host}${url.pathname}${url.search}`, path + url.search);
}

function parsePrefixed(prefix, rawValue) {
  const kind = PREFIXES.get(prefix.toLowerCase()) ?? prefix.toLowerCase();
  const value = rawValue.trim();
  if (!value && kind !== 'search') throw new AppError('INVALID_TARGET', `${prefix}: requires a value`, { status: 400 });
  switch (kind) {
    case 'inscription':
      if (INSCRIPTION_ID_RE.test(value)) return result('inscription', value.toLowerCase(), `inscription:${value.toLowerCase()}`, value);
      if (/^#?-?\d+$/.test(value)) {
        const number = value.replace(/^#/, '');
        return result('inscription-number', number, `inscription:${number}`, `Inscription #${number}`);
      }
      throw new AppError('INVALID_TARGET', 'Invalid inscription ID or number', { status: 400 });
    case 'sat':
      if (INTEGER_RE.test(value)) return result('sat', value, `sat:${value}`, `Sat ${value}`);
      if (SAT_NAME_RE.test(value)) return result('sat-name', value, `sat:${value}`, `Sat ${value}`);
      if (/^[0-9]+°[0-9]+′[0-9]+″[0-9]+‴$/.test(value)) return result('sat-degree', value, `sat:${value}`, `Sat ${value}`);
      throw new AppError('INVALID_TARGET', 'Invalid sat number, name, or degree notation', { status: 400 });
    case 'block':
      if (INTEGER_RE.test(value)) return result('block', value, `block:${value}`, `Block ${value}`);
      if (TXID_RE.test(value)) return result('block', value.toLowerCase(), `block:${value.toLowerCase()}`, `Block ${value}`);
      throw new AppError('INVALID_TARGET', 'Invalid block height or hash', { status: 400 });
    case 'transaction':
      if (!TXID_RE.test(value)) throw new AppError('INVALID_TARGET', 'Invalid transaction ID', { status: 400 });
      return result('transaction', value.toLowerCase(), `tx:${value.toLowerCase()}`, `Transaction ${value}`);
    case 'output':
      if (!OUTPOINT_RE.test(value)) throw new AppError('INVALID_TARGET', 'Invalid outpoint; expected txid:vout', { status: 400 });
      return result('output', value.toLowerCase(), `output:${value.toLowerCase()}`, `Output ${value}`);
    case 'satpoint':
      if (!SATPOINT_RE.test(value)) throw new AppError('INVALID_TARGET', 'Invalid satpoint; expected txid:vout:offset', { status: 400 });
      return result('satpoint', value.toLowerCase(), `satpoint:${value.toLowerCase()}`, `Satpoint ${value}`);
    case 'address': {
      if (!ADDRESS_RE.test(value)) throw new AppError('INVALID_TARGET', 'Invalid or unsupported Bitcoin address', { status: 400 });
      const address = /^(?:bc1|tb1|bcrt1)/i.test(value) ? value.toLowerCase() : value;
      return result('address', address, `address:${address}`, address);
    }
    case 'rune': {
      const rune = runeLookup(value);
      return result('rune', rune, `rune:${rune}`, `Rune ${rune}`);
    }
    case 'collection':
      return result('collection', value, `collection:${value}`, `Collection ${value}`);
    case 'external-web': {
      let url;
      try { url = new URL(value); } catch { throw new AppError('INVALID_TARGET', 'Invalid web URL', { status: 400 }); }
      if (!['https:', 'http:'].includes(url.protocol)) throw new AppError('INVALID_TARGET', 'Only HTTP(S) web URLs are supported', { status: 400 });
      return result('external-web', url.toString(), `web:${url.toString()}`, url.toString());
    }
    case 'content':
      if (!INSCRIPTION_ID_RE.test(value)) throw new AppError('INVALID_TARGET', 'Invalid inscription content ID', { status: 400 });
      return result('content', value.toLowerCase(), `ord://content/${value.toLowerCase()}`, `Content ${value}`);
    case 'recursive': {
      const path = value.startsWith('/') ? value : `/${value}`;
      if (!path.startsWith('/r/') && !path.startsWith('/content/')) throw new AppError('INVALID_TARGET', 'Recursive paths must start with /r/ or /content/', { status: 400 });
      const [root, ...segments] = path.slice(1).split('/');
      return result('recursive', path, `ord://${root}/${segments.join('/')}`, path);
    }
    case 'search':
    default:
      return result('search', value, `search:${value}`, value, { confidence: 'low' });
  }
}

export function parseNavigationInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw === 'home' || raw === 'satnav://home') return result('home', null, 'satnav://home', 'Home');
  if (/^satnav:\/\/runes(?:[/?#]|$)/i.test(raw)) {
    const url = new URL(raw);
    if ((url.pathname && url.pathname !== '/') || url.hash || url.username || url.password || url.port) {
      throw new AppError('INVALID_TARGET', 'Invalid Rune browsing address', { status: 400 });
    }
    return runesTarget(url.search.slice(1));
  }
  if (/^satnav:\/\/inscriptions(?:[/?#]|$)/i.test(raw)) {
    const url = new URL(raw);
    if ((url.pathname && url.pathname !== '/') || url.hash || url.username || url.password || url.port) {
      throw new AppError('INVALID_TARGET', 'Invalid inscription discovery address', { status: 400 });
    }
    return discoveryTarget(url.search.slice(1));
  }

  if (raw.startsWith('/r/') || raw.startsWith('/content/')) return parsePrefixed('recursive', raw);

  try {
    const url = new URL(raw);
    if (url.protocol === 'satnav:') return parseDeepLink(url);
    if (url.protocol === 'ord:') return parseOrdUrl(url);
    if (url.protocol === 'bitcoin:') return result('payment', url.toString(), url.toString(), url.toString());
    if (url.protocol === 'https:' || url.protocol === 'http:') return result('external-web', url.toString(), `web:${url.toString()}`, url.toString());
  } catch {
    // Continue with native target parsing.
  }

  const prefixMatch = raw.match(/^([a-zA-Z]+):(.*)$/s);
  if (prefixMatch && PREFIXES.has(prefixMatch[1].toLowerCase())) {
    return parsePrefixed(prefixMatch[1], prefixMatch[2]);
  }

  if (INSCRIPTION_ID_RE.test(raw)) return parsePrefixed('inscription', raw);
  if (/^#-?\d+$/.test(raw)) return parsePrefixed('inscription', raw);
  if (SATPOINT_RE.test(raw)) return parsePrefixed('satpoint', raw);
  if (OUTPOINT_RE.test(raw)) return parsePrefixed('output', raw);
  if (/^\d+:\d+$/.test(raw)) return parsePrefixed('rune', raw);
  if (ADDRESS_RE.test(raw)) return parsePrefixed('address', raw);
  if (TXID_RE.test(raw)) {
    const id = raw.toLowerCase();
    return result('transaction', id, `tx:${id}`, `Transaction ${id}`, {
      ambiguous: true,
      alternatives: [{ kind: 'block', value: id, canonical: `block:${id}`, display: `Block ${id}` }]
    });
  }
  if (INTEGER_RE.test(raw)) {
    return result('sat', raw, `sat:${raw}`, `Sat ${raw}`, {
      ambiguous: true,
      confidence: 'medium',
      alternatives: [
        { kind: 'block', value: raw, canonical: `block:${raw}`, display: `Block ${raw}` },
        { kind: 'inscription-number', value: raw, canonical: `inscription:${raw}`, display: `Inscription #${raw}` }
      ]
    });
  }
  if (/^[A-Z][A-Z•.\- ]{1,40}$/.test(raw)) return parsePrefixed('rune', raw);
  if (SAT_NAME_RE.test(raw)) {
    return result('sat-name', raw, `sat:${raw}`, `Sat ${raw}`, {
      ambiguous: true,
      confidence: 'medium',
      alternatives: [{ kind: 'search', value: raw, canonical: `search:${raw}`, display: `Search “${raw}”` }]
    });
  }
  return result('search', raw, `search:${raw}`, raw, { confidence: 'low' });
}

export function targetCapability(target) {
  const kind = typeof target === 'string' ? target : target?.kind;
  return ({
    inscription: 'inscription',
    // Discovery is a bounded read-only use of the existing inscription source
    // authority, not permission to contact an additional search/indexing service.
    inscriptions: 'inscription',
    'inscription-number': 'inscription-number',
    sat: 'sat',
    'sat-name': 'sat',
    'sat-degree': 'sat',
    block: 'block',
    transaction: 'transaction',
    output: 'output',
    satpoint: 'satpoint',
    address: 'address',
    rune: 'rune',
    runes: 'rune',
    content: 'ord-recursion',
    recursive: 'ord-recursion'
  })[kind] ?? null;
}

export function canonicalToDeepLink(target) {
  const parsed = typeof target === 'string' ? parseNavigationInput(target) : target;
  switch (parsed.kind) {
    case 'inscriptions': return parsed.canonical;
    case 'runes': return parsed.canonical;
    case 'home': return 'satnav://home';
    case 'inscription': return `satnav://inscription/${encodeURIComponent(parsed.value)}`;
    case 'inscription-number': return `satnav://inscription/${encodeURIComponent(parsed.value)}`;
    case 'sat':
    case 'sat-name':
    case 'sat-degree': return `satnav://sat/${encodeURIComponent(parsed.value)}`;
    case 'block': return `satnav://block/${encodeURIComponent(parsed.value)}`;
    case 'transaction': return `satnav://tx/${encodeURIComponent(parsed.value)}`;
    case 'output': return `satnav://output/${encodeURIComponent(parsed.value)}`;
    case 'address': return `satnav://address/${encodeURIComponent(parsed.value)}`;
    case 'rune': return `satnav://rune/${encodeURIComponent(parsed.value)}`;
    case 'collection': return `satnav://collection/${encodeURIComponent(parsed.value)}`;
    case 'content': return `satnav://content/${encodeURIComponent(parsed.value)}`;
    default: return `satnav://search/${encodeURIComponent(parsed.display ?? parsed.canonical)}`;
  }
}
