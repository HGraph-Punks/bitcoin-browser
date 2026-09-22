import { AppError } from './errors.js';

export const RUNE_U128_MAX = (1n << 128n) - 1n;
export const RUNES_MAX_PAGE = 10_000_000;
export const RUNES_PAGE_LIMIT = 100;

function invalid(message = 'Enter a Rune name or an ID such as 840000:1.') {
  return new AppError('INVALID_TARGET', message, { status: 400 });
}

// Names are modified base-26 u128 values. Spacers do not change identity.
export function runeLookup(value) {
  if (typeof value !== 'string' || value.length > 100) throw invalid();
  const input = value.trim();
  if (/^\d{1,20}:\d{1,10}$/.test(input)) {
    const [block, tx] = input.split(':').map(BigInt);
    if (block > (1n << 64n) - 1n || tx > (1n << 32n) - 1n || (!block && tx)) throw invalid();
    return `${block}:${tx}`;
  }
  if (!/^[a-zA-Z]+(?:[•. ][a-zA-Z]+)*$/.test(input)) throw invalid();
  const name = input.toUpperCase().replace(/[. ]/g, '•');
  const letters = name.replaceAll('•', '');
  if (letters.length > 28) throw invalid();
  let n = -1n;
  for (const c of letters) {
    n = (n + 1n) * 26n + BigInt(c.charCodeAt(0) - 65);
    if (n > RUNE_U128_MAX) throw invalid();
  }
  return name;
}

export function runeIdentity(value) { return runeLookup(value).replaceAll('•', ''); }

export function runesQuery(value = '') {
  if (typeof value !== 'string' || value.length > 32) throw invalid('Choose a valid Rune page.');
  const params = new URLSearchParams(value);
  for (const key of params.keys()) if (key !== 'page' || params.getAll(key).length !== 1) throw invalid('Choose a valid Rune page.');
  const page = params.get('page') ?? '0';
  if (!/^\d{1,8}$/.test(page) || Number(page) > RUNES_MAX_PAGE) throw invalid('Choose a valid Rune page.');
  return { page: Number(page) };
}

export function runesCanonical(page = 0) {
  if (!Number.isSafeInteger(page)) throw invalid('Choose a valid Rune page.');
  runesQuery(`page=${page}`);
  return `satnav://runes${page ? `?page=${page}` : ''}`;
}

export function runesTarget(value = '') {
  const { page } = runesQuery(value);
  return { kind: 'runes', value: page ? `page=${page}` : '', canonical: runesCanonical(page), display: 'Explore Runes', confidence: 'high', ambiguous: false, alternatives: [] };
}

// Never round token balances through Number, including fractional units.
export function formatRuneAmount(value, divisibility = 0) {
  if (typeof value !== 'string' || !/^\d{1,39}$/.test(value) || BigInt(value) > RUNE_U128_MAX
      || !Number.isInteger(divisibility) || divisibility < 0 || divisibility > 38) return '—';
  const digits = BigInt(value).toString().padStart(divisibility + 1, '0');
  const whole = divisibility ? digits.slice(0, -divisibility) : digits;
  const fraction = divisibility ? digits.slice(-divisibility).replace(/0+$/, '') : '';
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}

function runeInteger(value) {
  return typeof value === 'string' && /^\d{1,39}$/.test(value) && BigInt(value) <= RUNE_U128_MAX ? BigInt(value) : null;
}

// Percentage text is truncated to two decimals, never rounded to a false 100%.
// Only the bounded progress-bar value is converted to Number; amounts stay exact.
export function runeProportion(numerator, denominator) {
  const n = runeInteger(numerator), d = runeInteger(denominator);
  if (n === null || d === null || d === 0n || n > d) return null;
  const basisPoints = n * 10000n / d;
  const text = n === 0n ? '0%' : n === d ? '100%' : basisPoints === 0n ? '<0.01%'
    : `${basisPoints / 100n}.${String(basisPoints % 100n).padStart(2, '0')}%`;
  return { text, basisPoints: Number(basisPoints) };
}

export function runeCollectorStats(rune) {
  if (rune?.runeVersion !== 1) return null;
  const premine = runeInteger(rune.premine), mints = runeInteger(rune.mints);
  const supply = runeInteger(rune.supply), burned = runeInteger(rune.burned);
  const amount = runeInteger(rune.terms?.amount ?? '0'), cap = runeInteger(rune.terms?.cap ?? '0');
  if ([premine, mints, supply, burned, amount, cap].includes(null)
      || burned > supply || mints > cap || premine + mints * amount !== supply) return null;
  const maximum = premine + cap * amount;
  const remainingMints = cap - mints;
  const unissued = remainingMints * amount;
  return {
    minted: (mints * amount).toString(), remainingMints: remainingMints.toString(),
    unissued: unissued <= RUNE_U128_MAX ? unissued.toString() : null,
    mintProgress: rune.terms ? runeProportion(rune.mints, cap.toString()) : null,
    premineShare: maximum <= RUNE_U128_MAX ? runeProportion(rune.premine, maximum.toString()) : null,
    burnedShare: runeProportion(rune.burned, rune.supply)
  };
}

export function runeMintState(rune) {
  if (rune?.runeVersion !== 1) return 'unknown';
  if (rune.terms === null) return 'fixed';
  return rune.mintable === true ? 'open' : rune.mintable === false ? 'closed' : 'unknown';
}
