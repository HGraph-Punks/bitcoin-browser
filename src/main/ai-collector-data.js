import { inscriptionCollectorProfile, ordinalSatDetails, SAT_RARITIES } from '../shared/ordinal-traits.js';
import { formatRuneAmount, runeCollectorStats, runeMintState } from '../shared/runes.js';

const sats = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2100000000000000 ? String(value)
  : typeof value === 'string' && /^\d{1,16}$/.test(value) && BigInt(value) <= 2100000000000000n ? value : null;
const amount = (value, divisibility) => { const text = formatRuneAmount(value, divisibility); return text === '—' ? null : text; };

// Use the same bounded math as the browser, not LLM arithmetic or a second
// index. Only explicit collector fields are projected into model context.
export function aiCollectorDetails(entity) {
  const raw = entity.data ?? {}, summary = entity.summary ?? {};
  if (entity.type === 'rune') {
    const stats = runeCollectorStats(raw);
    return {
      kind: 'rune', mintState: runeMintState(raw),
      tokens: Object.fromEntries(['supply', 'outstanding', 'maximum', 'premine', 'burned'].map(key => [key, amount(raw[key], raw.divisibility)])),
      mintProgress: stats?.mintProgress?.text ?? null, remainingMints: stats?.remainingMints ?? null,
      mintedTokens: amount(stats?.minted, raw.divisibility), unissuedTokens: amount(stats?.unissued, raw.divisibility),
      premineShareOfMaximum: stats?.premineShare?.text ?? null, burnedShareOfCreated: stats?.burnedShare?.text ?? null,
      mintStart: sats(raw.mintStart), mintEndExclusive: sats(raw.mintEnd),
      explanation: 'supply is total created (premine plus mints); outstanding is created minus burns, not circulating/free-float supply. tokens are already divisibility-adjusted; do not divide them again. Remaining mint capacity alone does not mean minting is open. No price, holder count or market ranking is available.'
    };
  }
  if (['sat', 'sat-name', 'sat-degree', 'satpoint'].includes(entity.type)) {
    const sat = ordinalSatDetails(summary.sat, entity.network);
    if (!sat) return null;
    return { kind: 'sat', sat, rarity: { ...SAT_RARITIES[sat.rarity], origin: 'calculated' },
      explanation: 'Rarity is calculated from the supplied sat number and the mainnet issuance schedule, not an artwork ranking or price estimate. Class supply is scheduled across the complete issuance schedule, not a count of currently minted or available sats.' };
  }
  if (!['inscription', 'inscription-number'].includes(entity.type)) return null;
  const profile = inscriptionCollectorProfile({ sat: summary.sat ?? raw.sat, number: summary.number ?? raw.number,
    charms: summary.charms ?? raw.charms, metadataUnavailable: raw.metadataUnavailable }, entity.network);
  return { kind: 'inscription', ...profile, inscriptionFeeSats: sats(raw.fee), outputPostageSats: sats(raw.value),
    explanation: 'Sat rarity is not artwork rarity, a collection rank, authenticity or market value. Calculated traits use the supplied sat number and mainnet schedule; source-reported charms remain attributed. Class supply is the scheduled total across issuance, not current availability. The mined block is when the sat originated, not when this inscription was created. Fee is paid to inscribe; postage is BTC value in the current output, not the inscription price. Missing data is unknown, not common or zero.' };
}

export function aiCollectorFacts(entity) {
  const details = aiCollectorDetails(entity);
  if (!details) return [];
  const facts = [];
  const add = (label, value) => { if (value != null) facts.push({ label, value: String(value) }); };
  if (details.kind === 'rune') {
    add('Mint status (source snapshot)', { open: 'Open at source snapshot', closed: 'Closed at source snapshot', fixed: 'No public mint', unknown: null }[details.mintState]);
    add('Mint cap used', details.mintProgress); add('Remaining mint slots', details.remainingMints);
    add('Premine share of maximum supply', details.premineShareOfMaximum); add('Burned share of created supply', details.burnedShareOfCreated);
    add('Maximum tokens', details.tokens.maximum);
  } else {
    add('Sat rarity', details.rarity ? `${details.rarity.label} · ${details.rarity.origin === 'calculated' ? 'calculated' : 'source-reported'}` : null);
    add('Sat mined in block', details.sat?.block);
    if (details.traits?.length) add('Collector traits', details.traits.map(trait => trait.label).join(' · '));
    if (details.conflict) add('Metadata caution', 'Source charms conflict with the supplied sat number');
    add('Inscription fee', details.inscriptionFeeSats == null ? null : `${details.inscriptionFeeSats} sats`);
    add('Output postage', details.outputPostageSats == null ? null : `${details.outputPostageSats} sats`);
  }
  return facts;
}
