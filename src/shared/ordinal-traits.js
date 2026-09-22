// Local, bounded collector projections. Definitions and reference vectors:
// docs/COLLECTOR_INSIGHTS.md. No indexer request, price estimate or rarity rank.
export const ORDINAL_SAT_SUPPLY = 2099999997690000n;
const HALVING = 210000n;
const DIFFICULTY = 2016n;

export const SAT_RARITIES = Object.freeze(Object.fromEntries([
  ['common', 'Common', 'A sat that is not first in its mined block.', '2099999990760000'],
  ['uncommon', 'Uncommon', 'The first sat of a block, outside the rarer boundaries below.', '6926535'],
  ['rare', 'Rare', 'The first sat at a difficulty-adjustment boundary, outside rarer boundaries.', '3432'],
  ['epic', 'Epic', 'The first sat of a halving epoch, outside a cycle boundary.', '27'],
  ['legendary', 'Legendary', 'The first sat where a halving and difficulty period align every six halvings, after genesis.', '5'],
  ['mythic', 'Mythic', 'The first sat of the genesis block.', '1']
].map(([key, label, description, supply]) => [key, Object.freeze({ key, label, description, supply })])));

const TRAITS = Object.freeze(Object.fromEntries([
  ['nineball', '9ball', 'A sat mined in Bitcoin block 9.'],
  ['palindrome', 'Palindrome', 'The sat number reads the same forwards and backwards.'],
  ['coin', 'Coin boundary', 'The sat number is a multiple of 100,000,000. This is a sat trait, not a one-BTC balance.'],
  ['cursed', 'Cursed', 'A historically cursed inscription, assigned a negative inscription number.'],
  ['vindicated', 'Vindicated', 'An inscription recognized under the jubilee rules that would previously have been cursed.'],
  ['reinscription', 'Reinscription', 'An additional inscription on an already-inscribed sat; it does not replace the earlier inscription.'],
  ['unbound', 'Unbound', 'The indexer reports no sat binding for this inscription.'],
  ['lost', 'Lost', 'The indexer marks this inscription as lost to unclaimed block rewards.'],
  ['burned', 'Burned', 'The indexer marks this inscription as sent to an unspendable output.']
].map(([key, label, description]) => [key, Object.freeze({ key, label, description })])));
const SAT_TRAITS = new Set(['nineball', 'palindrome', 'coin']);

export function ordinalSatNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const number = BigInt(value);
  return number < ORDINAL_SAT_SUPPLY ? number.toString() : null;
}

export function recognizedCharms(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 32).filter(key => typeof key === 'string'
    && (Object.hasOwn(SAT_RARITIES, key) || Object.hasOwn(TRAITS, key))))];
}

export function ordinalSatDetails(value, network) {
  const number = ordinalSatNumber(value);
  // Do not apply the mainnet issuance schedule to a different/unknown chain.
  if (number === null || network !== 'mainnet') return null;
  const sat = BigInt(number);
  let remaining = sat, subsidy = 5000000000n, epoch = 0n;
  while (epoch < 33n && remaining >= HALVING * subsidy) {
    remaining -= HALVING * subsidy;
    subsidy >>= 1n;
    epoch++;
  }
  if (subsidy === 0n) return null;
  const block = epoch * HALVING + remaining / subsidy;
  const offset = remaining % subsidy;
  const rarity = sat === 0n ? 'mythic' : offset !== 0n ? 'common'
    : block % (HALVING * 6n) === 0n ? 'legendary' : block % HALVING === 0n ? 'epic'
      : block % DIFFICULTY === 0n ? 'rare' : 'uncommon';
  let rest = ORDINAL_SAT_SUPPLY - sat, name = '';
  while (rest > 0n) {
    rest--;
    name = String.fromCharCode(97 + Number(rest % 26n)) + name;
    rest /= 26n;
  }
  const traits = [];
  if (block === 9n) traits.push('nineball');
  if (number === [...number].reverse().join('')) traits.push('palindrome');
  if (sat % 100000000n === 0n) traits.push('coin');
  return {
    number, name, block: block.toString(), offset: offset.toString(), epoch: epoch.toString(),
    cycle: (epoch / 6n).toString(), period: (block / DIFFICULTY).toString(),
    decimal: `${block}.${offset}`, degree: `${epoch / 6n}°${block % HALVING}′${block % DIFFICULTY}″${offset}‴`,
    rarity, traits
  };
}

export function inscriptionCollectorProfile(record = {}, network) {
  if (record?.metadataUnavailable === true) return { sat: null, rarity: null, traits: [], conflict: false };
  const charms = recognizedCharms(record?.charms);
  const sat = ordinalSatDetails(record?.sat, network);
  const reportedRarities = charms.filter(key => Object.hasOwn(SAT_RARITIES, key));
  const conflict = reportedRarities.length > 1
    || Boolean(sat && reportedRarities.some(key => key !== sat.rarity))
    || Boolean(sat && charms.some(key => SAT_TRAITS.has(key) && !sat.traits.includes(key)));
  const rarityKey = sat?.rarity ?? (reportedRarities.length === 1 ? reportedRarities[0] : null);
  const traits = charms.filter(key => Object.hasOwn(TRAITS, key) && (!sat || !SAT_TRAITS.has(key)))
    .map(key => ({ ...TRAITS[key], origin: 'source' }));
  if (sat) traits.push(...sat.traits.map(key => ({ ...TRAITS[key], origin: 'calculated' })));
  const number = typeof record?.number === 'number' && Number.isSafeInteger(record.number) ? String(record.number) : record?.number;
  if (typeof number === 'string' && /^-[1-9]\d{0,14}$/.test(number) && !traits.some(trait => trait.key === 'cursed')) {
    traits.push({ ...TRAITS.cursed, origin: 'number' });
  }
  return {
    sat, rarity: rarityKey ? { ...SAT_RARITIES[rarityKey], origin: sat ? 'calculated' : 'source' } : null,
    traits, conflict
  };
}

export const COLLECTOR_FILTERS = Object.freeze([
  ['all', 'All collector traits'], ['non-common', 'Non-common sats'], ['unknown', 'Sat rarity unavailable'],
  ['cursed', 'Cursed inscriptions'], ['vindicated', 'Vindicated inscriptions'], ['reinscription', 'Reinscriptions'],
  ['nineball', '9ball sats'], ['palindrome', 'Palindrome sats'], ['coin', 'Coin-boundary sats']
].map(entry => Object.freeze(entry)));

export function matchesCollectorFilter(profile, filter) {
  if (filter === 'all') return true;
  if (filter === 'non-common') return Boolean(profile.rarity && profile.rarity.key !== 'common');
  if (filter === 'unknown') return !profile.rarity;
  return profile.traits.some(trait => trait.key === filter);
}
