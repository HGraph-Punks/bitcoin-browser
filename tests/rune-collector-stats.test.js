import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNE_U128_MAX, runeCollectorStats, runeProportion, runeMintState } from '../src/shared/runes.js';

const rune = { runeVersion: 1, premine: '100', mints: '3', supply: '130', burned: '13', terms: { amount: '10', cap: '10' } };

test('Rune percentages never round tiny or almost-complete u128 quantities to false endpoints', () => {
  const max = RUNE_U128_MAX.toString();
  assert.deepEqual(runeProportion('0', max), { text: '0%', basisPoints: 0 });
  assert.deepEqual(runeProportion('1', max), { text: '<0.01%', basisPoints: 0 });
  assert.deepEqual(runeProportion((RUNE_U128_MAX - 1n).toString(), max), { text: '99.99%', basisPoints: 9999 });
  assert.deepEqual(runeProportion(max, max), { text: '100%', basisPoints: 10000 });
  assert.deepEqual(runeProportion('1', '3'), { text: '33.33%', basisPoints: 3333 });
  for (const [n, d] of [['0', '0'], ['2', '1'], ['-1', '2'], ['1e2', '200'], [1, '2'], ['1', (RUNE_U128_MAX + 1n).toString()], ['1'.repeat(5000), '2'], [null, '2'], [{}, '2']]) assert.equal(runeProportion(n, d), null);
});

test('Rune supply insights retain exact minted units, remaining mints and the correct percentage denominators', () => {
  assert.deepEqual(runeCollectorStats(rune), {
    minted: '30', remainingMints: '7', unissued: '70',
    mintProgress: { text: '30.00%', basisPoints: 3000 },
    premineShare: { text: '50.00%', basisPoints: 5000 },
    burnedShare: { text: '10.00%', basisPoints: 1000 }
  });
  const complete = runeCollectorStats({ ...rune, mints: '10', supply: '200' });
  assert.equal(complete.remainingMints, '0'); assert.equal(complete.unissued, '0'); assert.equal(complete.mintProgress.text, '100%');
});

test('Rune insights preserve maximum u128 amounts and refuse overflow percentages', () => {
  const huge = runeCollectorStats({ ...rune, premine: '0', mints: (RUNE_U128_MAX - 1n).toString(), supply: (RUNE_U128_MAX - 1n).toString(), burned: '0', terms: { amount: '1', cap: RUNE_U128_MAX.toString() } });
  assert.equal(huge.remainingMints, '1'); assert.equal(huge.unissued, '1'); assert.equal(huge.mintProgress.text, '99.99%');
  const overflow = runeCollectorStats({ ...rune, premine: '0', mints: '1', supply: RUNE_U128_MAX.toString(), burned: '0', terms: { amount: RUNE_U128_MAX.toString(), cap: '3' } });
  assert.equal(overflow.premineShare, null); assert.equal(overflow.unissued, null); assert.equal(overflow.mintProgress.text, '33.33%');
});

test('zero capacity, zero supply and fixed supply do not fabricate percentages', () => {
  const empty = { runeVersion: 1, premine: '0', mints: '0', supply: '0', burned: '0', terms: { amount: null, cap: null } };
  const stats = runeCollectorStats(empty);
  for (const key of ['mintProgress', 'premineShare', 'burnedShare']) assert.equal(stats[key], null);
  const fixed = runeCollectorStats({ ...empty, premine: '100', supply: '100', terms: null });
  assert.equal(fixed.mintProgress, null); assert.equal(fixed.premineShare.text, '100%'); assert.equal(fixed.minted, '0');
});

test('malformed or inconsistent amounts never yield plausible collector statistics', () => {
  for (const change of [{ runeVersion: 0 }, { supply: '131' }, { burned: '131' }, { mints: '11' }, { premine: -1 }, { supply: {} }, { mints: '0'.repeat(40) }, { terms: { cap: '10', amount: '-1' } }]) assert.equal(runeCollectorStats({ ...rune, ...change }), null);
  assert.equal(runeCollectorStats(null), null);
});

test('mint states distinguish explicit fixed supply from bare listing names and unknown snapshots', () => {
  assert.equal(runeMintState({ name: 'ALPHA' }), 'unknown');
  assert.equal(runeMintState({ ...rune, mintable: null }), 'unknown');
  assert.equal(runeMintState({ ...rune, mintable: false }), 'closed');
  assert.equal(runeMintState({ ...rune, mintable: true }), 'open');
  assert.equal(runeMintState({ ...rune, terms: null, mintable: false }), 'fixed');
});
