import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccounts, requestRpc, requestStyle } from '../src/wallet/adapters.js';

test('uses one explicit positional wallet RPC call', async () => {
  const calls = [];
  const provider = { request(method, params) { calls.push([method, params]); return Promise.resolve({ ok: true }); } };
  assert.equal(requestStyle(provider), 'positional');
  await requestRpc(provider, 'getAccounts', { purpose: 'payment' }, 'positional');
  assert.deepEqual(calls, [['getAccounts', { purpose: 'payment' }]]);
});

test('uses one explicit object-style wallet RPC call', async () => {
  const calls = [];
  const provider = { request(request) { calls.push(request); return Promise.resolve({ ok: true }); } };
  assert.equal(requestStyle(provider), 'object');
  await requestRpc(provider, 'getAccounts', { purpose: 'ordinals' }, 'object');
  assert.deepEqual(calls, [{ method: 'getAccounts', params: { purpose: 'ordinals' } }]);
});

test('does not retry an asynchronously rejected wallet request in another shape', async () => {
  let calls = 0;
  const provider = { request() { calls += 1; return Promise.reject(new Error('User rejected')); } };
  await assert.rejects(requestRpc(provider, 'wallet_connect', {}, 'positional'), /User rejected/);
  assert.equal(calls, 1);
});

test('normalizes common Bitcoin wallet account response shapes', () => {
  assert.deepEqual(normalizeAccounts({ result: ['bc1qexample'] }), [{ address: 'bc1qexample' }]);
  assert.deepEqual(normalizeAccounts({ addresses: [{ address: 'bc1ptest', public_key: '02aa' }] }), [{
    address: 'bc1ptest', publicKey: '02aa', purpose: null, addressType: null, network: null
  }]);
});

test('normalizes bounded nested result account containers and Leather addresses', () => {
  assert.deepEqual(normalizeAccounts({ result: { addresses: [
    null,
    { addresses: [{ address: 'bc1pleather' }], publicKey: '02bb', purpose: 'ordinals' }
  ] } }), [{
    address: 'bc1pleather', publicKey: '02bb', purpose: 'ordinals', addressType: null, network: null
  }]);
  assert.deepEqual(normalizeAccounts({ result: { accounts: ['bc1qaccount'] } }), [{ address: 'bc1qaccount' }]);
  assert.deepEqual(normalizeAccounts(['bc1qdirect']), [{ address: 'bc1qdirect' }]);
});

test('filters malformed account entries without dereferencing null or coercing public fields', () => {
  assert.deepEqual(normalizeAccounts({ accounts: [
    null, undefined, 42, [], {}, { address: null }, { address: 123 },
    { addresses: [null] }, { addresses: [{ address: 123 }] },
    { address: 'bc1qvalid', publicKey: 10, purpose: {}, addressType: [], network: false }
  ] }), [{ address: 'bc1qvalid', publicKey: null, purpose: null, addressType: null, network: null }]);
  assert.deepEqual(normalizeAccounts(null), []);
  assert.deepEqual(normalizeAccounts({ result: { malformed: true } }), []);
});

test('bounds account scanning, retained accounts, and public field lengths', () => {
  const source = Array.from({ length: 205 }, (_, index) => index < 180
    ? null
    : {
        address: `address-${index}`.padEnd(160, 'a'),
        public_key: 'p'.repeat(300), type: 't'.repeat(80),
        address_type: 'a'.repeat(80), network: 'n'.repeat(80)
      });
  const accounts = normalizeAccounts({ result: source });
  assert.equal(accounts.length, 20);
  assert.equal(accounts[0].address.length, 128);
  assert.equal(accounts[0].publicKey.length, 256);
  assert.equal(accounts[0].purpose.length, 50);
  assert.equal(accounts[0].addressType.length, 50);
  assert.equal(accounts[0].network.length, 50);
  assert.equal(accounts.at(-1).address.startsWith('address-199'), true);
  assert.equal(accounts.some((account) => account.address.startsWith('address-200')), false);
});
