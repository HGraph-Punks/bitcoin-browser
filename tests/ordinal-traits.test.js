import test from 'node:test';
import assert from 'node:assert/strict';
import { ORDINAL_SAT_SUPPLY, SAT_RARITIES, ordinalSatNumber, ordinalSatDetails, recognizedCharms, inscriptionCollectorProfile, matchesCollectorFilter } from '../src/shared/ordinal-traits.js';

const details = sat => ordinalSatDetails(sat, 'mainnet');
// Independent height-to-sat projection for boundary fixtures, not a reverse
// call into the implementation under test. Subsidies truncate at each halving.
function firstSat(height) {
  let total = 0n;
  for (let epoch = 0; height > 0; epoch++) {
    const blocks = Math.min(height, 210000);
    total += BigInt(blocks) * (5000000000n >> BigInt(epoch));
    height -= blocks;
  }
  return total.toString();
}

test('sat input is bounded, exact and preserves zero without accepting coercible data', () => {
  assert.equal(ordinalSatNumber(0), '0');
  assert.equal(ordinalSatNumber('000123'), '123');
  assert.equal(ordinalSatNumber(Number(ORDINAL_SAT_SUPPLY - 1n)), String(ORDINAL_SAT_SUPPLY - 1n));
  for (const value of [null, undefined, {}, [], 1n, false, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '1e3', '+1', '-0', ' 1', '1.0', '1'.repeat(100000), ORDINAL_SAT_SUPPLY.toString()]) assert.equal(ordinalSatNumber(value), null);
});

for (const [height, rarity] of [[0, 'mythic'], [1, 'uncommon'], [9, 'uncommon'], [2016, 'rare'], [210000, 'epic'], [840000, 'epic'], [1260000, 'legendary'], [2520000, 'legendary']]) {
  test(`block ${height} first sat has ${rarity} rarity and exact block/offset`, () => {
    const sat = firstSat(height);
    const actual = details(sat);
    assert.equal(actual.block, String(height)); assert.equal(actual.offset, '0'); assert.equal(actual.rarity, rarity);
    assert.equal(actual.decimal, `${height}.0`);
    assert.equal(details((BigInt(sat) + 1n).toString()).rarity, 'common');
    if (height) assert.equal(details((BigInt(sat) - 1n).toString()).block, String(height - 1));
  });
}

test('all halving epochs, final subsidy and full-schedule supply remain exact', () => {
  for (let epoch = 0; epoch <= 32; epoch++) {
    const height = epoch * 210000;
    const actual = details(firstSat(height));
    assert.equal(actual.epoch, String(epoch)); assert.equal(actual.cycle, String(Math.floor(epoch / 6)));
    assert.equal(actual.block, String(height)); assert.equal(actual.period, String(Math.floor(height / 2016)));
    assert.equal(actual.degree, `${Math.floor(epoch / 6)}°0′${height % 2016}″0‴`);
  }
  const last = details((ORDINAL_SAT_SUPPLY - 1n).toString());
  assert.equal(last.block, '6929999'); assert.equal(last.offset, '0'); assert.equal(last.rarity, 'uncommon');
  assert.equal(Object.values(SAT_RARITIES).reduce((sum, rarity) => sum + BigInt(rarity.supply), 0n), ORDINAL_SAT_SUPPLY);
  assert.equal(firstSat(6930000), ORDINAL_SAT_SUPPLY.toString());
});

test('sat names match the upstream ord reference vectors including terminal names', () => {
  for (const [sat, name] of [['0', 'nvtdijuwxlp'], ['1', 'nvtdijuwxlo'], ['26', 'nvtdijuwxkp'], ['27', 'nvtdijuwxko'], [(ORDINAL_SAT_SUPPLY - 1n).toString(), 'a'], [(ORDINAL_SAT_SUPPLY - 27n).toString(), 'aa']]) assert.equal(details(sat).name, name);
});

test('9ball, palindrome and coin-boundary tests describe sats, not token balances', () => {
  assert.ok(details('45000000000').traits.includes('nineball'));
  assert.ok(details('49999999999').traits.includes('nineball'));
  for (const sat of ['44999999999', '50000000000']) assert.ok(!details(sat).traits.includes('nineball'));
  assert.ok(details('123454321').traits.includes('palindrome'));
  assert.ok(!details('123454322').traits.includes('palindrome'));
  assert.ok(details('100000000').traits.includes('coin'));
  assert.ok(!details('100000001').traits.includes('coin'));
  assert.deepEqual(details('0').traits, ['palindrome', 'coin']);
});

test('other networks never receive mainnet calculations and source rarity stays attributed', () => {
  for (const network of ['regtest', 'testnet', 'signet', '', null, undefined]) {
    assert.equal(ordinalSatDetails('0', network), null);
    const absent = inscriptionCollectorProfile({ sat: '0', charms: [] }, network);
    assert.equal(absent.rarity, null); assert.equal(absent.sat, null);
    const source = inscriptionCollectorProfile({ sat: '0', charms: ['uncommon'] }, network);
    assert.equal(source.rarity.origin, 'source'); assert.equal(source.rarity.key, 'uncommon');
  }
});

test('charms are allowlisted, deduplicated and bounded without evaluating arbitrary keys', () => {
  assert.deepEqual(recognizedCharms(['__proto__', 'constructor', '<img>', {}, 'rare', 'rare', 'nineball']), ['rare', 'nineball']);
  assert.deepEqual(recognizedCharms([...Array(32).fill('unknown'), 'mythic']), []);
  for (const value of ['rare', { rare: true }, null, 1]) assert.deepEqual(recognizedCharms(value), []);
});

test('collector projections distinguish missing, source-reported, calculated and conflicting facts', () => {
  assert.equal(inscriptionCollectorProfile({}, 'mainnet').rarity, null);
  assert.equal(inscriptionCollectorProfile({ sat: '0', metadataUnavailable: true }, 'mainnet').rarity, null);
  assert.deepEqual(inscriptionCollectorProfile({ sat: '0', metadataUnavailable: true, charms: ['mythic', 'cursed'], number: '-1' }, 'mainnet'), { sat: null, rarity: null, traits: [], conflict: false });
  const reported = inscriptionCollectorProfile({ charms: ['epic', 'reinscription', 'vindicated'] }, 'mainnet');
  assert.equal(reported.rarity.key, 'epic'); assert.equal(reported.rarity.origin, 'source');
  assert.deepEqual(reported.traits.map(trait => trait.key), ['reinscription', 'vindicated']);
  const conflict = inscriptionCollectorProfile({ sat: '2', charms: ['mythic', 'nineball'] }, 'mainnet');
  assert.equal(conflict.rarity.key, 'common'); assert.equal(conflict.rarity.origin, 'calculated'); assert.equal(conflict.conflict, true);
  assert.ok(!conflict.traits.some(trait => trait.key === 'nineball'));
  const ambiguous = inscriptionCollectorProfile({ charms: ['rare', 'epic'] }, 'mainnet');
  assert.equal(ambiguous.rarity, null); assert.equal(ambiguous.conflict, true);
  const cursed = inscriptionCollectorProfile({ number: '-1' }, 'mainnet');
  assert.equal(cursed.traits[0].key, 'cursed'); assert.equal(cursed.traits[0].origin, 'number');
  assert.equal(inscriptionCollectorProfile({ number: -1 }, 'mainnet').traits[0].key, 'cursed');
  assert.equal(inscriptionCollectorProfile({ number: '-1', charms: ['cursed'] }, 'mainnet').traits.length, 1);
  assert.equal(inscriptionCollectorProfile({ number: '1', height: 900000 }, 'mainnet').traits.length, 0);
});

test('collector filters do not silently classify unknown data as common or uncommon', () => {
  const missing = inscriptionCollectorProfile({}, 'mainnet'), common = inscriptionCollectorProfile({ sat: '2' }, 'mainnet');
  const rare = inscriptionCollectorProfile({ charms: ['rare', 'cursed'] }, 'mainnet');
  assert.equal(matchesCollectorFilter(missing, 'all'), true); assert.equal(matchesCollectorFilter(missing, 'unknown'), true);
  assert.equal(matchesCollectorFilter(missing, 'non-common'), false); assert.equal(matchesCollectorFilter(common, 'non-common'), false);
  assert.equal(matchesCollectorFilter(rare, 'non-common'), true); assert.equal(matchesCollectorFilter(rare, 'cursed'), true);
  assert.equal(matchesCollectorFilter(rare, 'unknown'), false); assert.equal(matchesCollectorFilter(rare, 'reinscription'), false);
});
