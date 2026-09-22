import test from 'node:test';
import assert from 'node:assert/strict';
import { OrdServerProvider } from '../src/main/providers/ord-server.js';
import { MempoolProvider } from '../src/main/providers/mempool.js';
import { BitcoinCoreProvider } from '../src/main/providers/bitcoin-core.js';
import { DEFAULT_PROVIDERS } from '../src/shared/constants.js';
import { validateProviderConfig } from '../src/shared/validation.js';

const TXID = 'a'.repeat(64);

function config(type, capabilities) {
  return {
    id: `${type}-fixture`, name: `${type} fixture`, type, network: 'mainnet',
    baseUrl: 'http://127.0.0.1:1', enabled: true, priority: 1, local: true, capabilities
  };
}

function target(kind, value) {
  return { kind, value, canonical: `${kind}:${value}` };
}

test('default capabilities advertise routed features and validation retains satpoint', () => {
  const ordDefaults = DEFAULT_PROVIDERS.filter((provider) => provider.type === 'ord-server');
  assert.ok(ordDefaults.every((provider) => provider.capabilities.includes('satpoint')));
  assert.ok(DEFAULT_PROVIDERS.every((provider) => !provider.capabilities.includes('fees')));
  const validated = validateProviderConfig(config('ord-server', ['output', 'satpoint']));
  assert.deepEqual(validated.capabilities, ['output', 'satpoint']);
  assert.deepEqual(validateProviderConfig(config('mempool', ['output', 'fees'])).capabilities, ['output']);
});

test('Ord adapter uses documented JSON-capable routes for every declared entity target', async () => {
  const provider = new OrdServerProvider(config('ord-server', [
    'inscription', 'inscription-number', 'sat', 'block', 'transaction-raw', 'output', 'satpoint', 'address', 'rune'
  ]));
  const cases = [
    [target('inscription', `${TXID}i0`), `/r/inscription/${TXID}i0`],
    [target('inscription-number', '12345'), '/inscription/12345'],
    [target('sat', '0'), '/r/sat/0'],
    [target('block', '840000'), '/r/blockinfo/840000'],
    [target('transaction', TXID), `/r/tx/${TXID}`],
    [target('output', `${TXID}:0`), `/r/utxo/${TXID}:0`],
    [target('satpoint', `${TXID}:0:42`), `/satpoint/${TXID}:0:42`],
    [target('address', 'bc1qfixture'), '/address/bc1qfixture'],
    [target('rune', 'UNCOMMON•GOODS'), '/rune/UNCOMMON%E2%80%A2GOODS']
  ];

  for (const [input, expectedPath] of cases) {
    let call;
    provider.fetchPath = async (requestPath, options) => {
      call = { requestPath, options };
      return {
        headers: { 'content-type': 'application/json' },
        data: Buffer.from(JSON.stringify(input.kind === 'rune'
          ? { id: '1:0', entry: { spaced_rune: input.value, number: 0, block: 1, divisibility: 0, symbol: 'X', premine: 0, burned: 0, mints: 0, timestamp: 0, etching: '0'.repeat(64), turbo: true, terms: null }, mintable: false, parent: null }
          : { id: input.value, hash: input.value, number: input.kind === 'satpoint' ? 42 : input.value, symbol: 'X' })),
        latencyMs: 2
      };
    };
    const entity = await provider.resolve(input, { timeoutMs: 50, maxBytes: 4096 });
    assert.equal(call.requestPath, expectedPath, input.kind);
    assert.equal(call.options.accept, 'application/json', input.kind);
    assert.equal(entity.type, input.kind);
    assert.equal(entity.source.id, provider.id);
    if (input.kind === 'satpoint') assert.equal(entity.summary.sat, '42');
  }
});

test('saved Ord output capability migrates to dedicated satpoint support only on Ord', () => {
  const legacyOrd = new OrdServerProvider(config('ord-server', ['output']));
  const mempool = new MempoolProvider(config('mempool', ['output']));
  const core = new BitcoinCoreProvider(config('bitcoin-core', ['output']));
  assert.equal(legacyOrd.supports('satpoint'), true);
  assert.equal(legacyOrd.descriptor().capabilities.includes('satpoint'), true);
  assert.equal(mempool.supports('satpoint'), false);
  assert.equal(core.supports('satpoint'), false);
});

test('Mempool adapter maps declared targets and performs height-to-hash lookup', async () => {
  const provider = new MempoolProvider(config('mempool', ['block', 'transaction', 'output', 'address']));
  const calls = [];
  provider.request = async (requestPath, options = {}) => {
    calls.push([requestPath, options.accept]);
    if (requestPath === '/block-height/840000') return { data: Buffer.from(TXID), latencyMs: 1 };
    const body = requestPath === `/tx/${TXID}`
      ? { txid: TXID, vout: [{ value: 5000 }], status: { confirmed: true } }
      : requestPath.startsWith('/address/')
        ? { chain_stats: { funded_txo_sum: 10, spent_txo_sum: 2, tx_count: 1 } }
        : { id: TXID, height: 840000 };
    return { data: Buffer.from(JSON.stringify(body)), latencyMs: 1 };
  };

  const block = await provider.resolve(target('block', '840000'));
  assert.deepEqual(calls.slice(0, 2).map(([requestPath]) => requestPath), ['/block-height/840000', `/block/${TXID}`]);
  assert.equal(block.summary.height, 840000);
  const transaction = await provider.resolve(target('transaction', TXID));
  assert.equal(transaction.summary.txid, TXID);
  const output = await provider.resolve(target('output', `${TXID}:0`));
  assert.equal(output.summary.value, 5000);
  const address = await provider.resolve(target('address', 'bc1qfixture'));
  assert.equal(address.summary.funded, 10);
});

test('Bitcoin Core adapter maps declared targets including spent-output fallback', async () => {
  const provider = new BitcoinCoreProvider(config('bitcoin-core', ['block', 'transaction', 'transaction-raw', 'output']), { secureStore: { get: () => null } });
  const calls = [];
  provider.rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'getblockhash') return { result: TXID, latencyMs: 1 };
    if (method === 'getblock') return { result: { hash: TXID, height: 840000 }, latencyMs: 1 };
    if (method === 'gettxout') return { result: null, latencyMs: 1 };
    return { result: { txid: TXID, vout: [{ value: 0.00005 }] }, latencyMs: 1 };
  };

  const block = await provider.resolve(target('block', '840000'));
  assert.deepEqual(calls.slice(0, 2).map(([method]) => method), ['getblockhash', 'getblock']);
  assert.equal(block.summary.height, 840000);
  const transaction = await provider.resolve(target('transaction', TXID));
  assert.equal(transaction.summary.txid, TXID);
  const output = await provider.resolve(target('output', `${TXID}:0`));
  assert.deepEqual(calls.slice(-2).map(([method]) => method), ['gettxout', 'getrawtransaction']);
  assert.equal(output.summary.spent, true);
});
