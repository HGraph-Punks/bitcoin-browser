import test from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_RE, canonicalToDeepLink, parseNavigationInput } from '../src/shared/navigation.js';
import { planLookup } from '../src/renderer/search.js';

// Public BIP173 examples, not wallet-owned addresses. This suite covers lookup
// recognition and case handling, not checksum or spend-destination validation.
const addresses = [
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
];

for (const address of addresses) {
  test(`${address.slice(0, 3)} uppercase address lookup preserves the lowercase destination`, () => {
    for (const input of [address.toUpperCase(), `address:${address.toUpperCase()}`, `addr:${address.toUpperCase()}`, `satnav://address/${address.toUpperCase()}`]) {
      const target = parseNavigationInput(input);
      assert.equal(target.kind, 'address');
      assert.equal(target.value, address);
      assert.equal(target.canonical, `address:${address}`);
      assert.equal(target.ambiguous, false);
      assert.equal(canonicalToDeepLink(target), `satnav://address/${address}`);
    }
    assert.equal(ADDRESS_RE.test(address.toUpperCase()), true);
  });

  test(`${address.slice(0, 3)} guided lookup accepts uppercase without becoming saved search`, () => {
    for (const mode of ['auto', 'address']) {
      assert.deepEqual(planLookup(address.toUpperCase(), mode), { target: `address:${address}`, choices: [] });
    }
  });

  test(`${address.slice(0, 3)} mixed case is never silently repaired as an address`, () => {
    for (const input of [address.slice(0, 2).toUpperCase() + address.slice(2), address.slice(0, 3) + address[3].toUpperCase() + address.slice(4)]) {
      assert.equal(ADDRESS_RE.test(input), false);
      assert.throws(() => parseNavigationInput(`address:${input}`), { code: 'INVALID_TARGET' });
      assert.notEqual(parseNavigationInput(input).kind, 'address');
      assert.ok(planLookup(input, 'address').error);
    }
  });
}

test('legacy Base58 lookup preserves its case-sensitive destination', () => {
  for (const address of ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy']) {
    assert.equal(parseNavigationInput(address).value, address);
    assert.equal(parseNavigationInput(`address:${address}`).canonical, `address:${address}`);
    assert.equal(planLookup(address, 'address').target, `address:${address}`);
  }
});

test('regtest address recognition follows the same single-case rule', () => {
  // Shape fixture only; the existing parser does not validate checksums.
  const address = 'bcrt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
  assert.equal(parseNavigationInput(address.toUpperCase()).canonical, `address:${address}`);
  assert.equal(ADDRESS_RE.test('BCRT1' + address.slice(5)), false);
});
