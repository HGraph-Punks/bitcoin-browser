import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { executeBitcoinAiTool, aiEntityCard } from '../src/main/ai-bitcoin-tools.js';
import { bitcoinEntityDetails, bitcoinToSats } from '../src/main/ai-bitcoin-data.js';
import { LocalAiManager, boundedAiToolContext } from '../src/main/local-ai.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { RecursiveResolver } from '../src/main/resolver.js';
import { normalizeEntity } from '../src/main/providers/normalize.js';
import { parseNavigationInput } from '../src/shared/navigation.js';
import { DEFAULT_SETTINGS, DEFAULT_PROVIDERS } from '../src/shared/constants.js';
import { AI_LIMITS, AI_DEFAULT_CONFIG } from '../src/shared/local-ai.js';

const id = `${'a'.repeat(64)}i0`, txid = 'b'.repeat(64);
const signal = () => new AbortController().signal;
const entity = (target, data, type = 'bitcoin-core') => normalizeEntity(parseNavigationInput(target), data, { id: 'fixture', name: 'Test source', type, network: 'mainnet' });
function fixture(t, overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const configs = DEFAULT_PROVIDERS.filter(provider => ['bitcoin-core', 'mempool', 'ord-server'].includes(provider.type))
    .filter(provider => provider.type !== 'ord-server' || !provider.local)
    .filter((provider, index, all) => all.findIndex(item => item.type === provider.type) === index)
    .map(provider => ({ ...provider, enabled: true }));
  const stateStore = { get: keys => structuredClone(keys[0] === 'settings' ? settings : keys[0] === 'providers' ? configs : []) };
  const providerManager = new ProviderManager(stateStore, { get: () => null }, null);
  const reads = [], cached = new Map();
  for (const provider of providerManager.instances.values()) {
    provider.resolve = async (target, options) => {
      reads.push({ type: provider.type, target, options });
      return normalizeEntity(target, { height: 123, value: provider.type === 'bitcoin-core' ? 0.00000003 : 3 }, provider);
    };
    provider.health = async () => { reads.push({ type: provider.type, query: 'health' }); return { ok: true, height: 123, headers: 124, chain: 'main', pruned: true, initialBlockDownload: true, verificationProgress: 0.9 }; };
    provider.rpc = async (method, params, options) => { reads.push({ type: provider.type, method, params, options }); return { result: method === 'estimatesmartfee'
      ? { feerate: 0.000025, blocks: params[0], errors: ['PRIVATE_SERVER_ERROR'] }
      : { loaded: true, size: 10, bytes: 2000, total_fee: 0.0001, mempoolminfee: 0.00001, credentials: 'PRIVATE_SERVER_FIELD' } }; };
    provider.recommendedFees = async options => { reads.push({ type: provider.type, query: 'fees', options }); return { fastestFee: 3, halfHourFee: 2, hourFee: 1, arbitrary: 'DO_NOT_SHARE' }; };
    provider.request = async (path, options) => { reads.push({ type: provider.type, path, options }); return { ok: true, data: Buffer.from(JSON.stringify({ count: 12, vsize: 3000, total_fee: 400, credentials: 'DO_NOT_SHARE' })) }; };
    provider.fetchPath = async (path, options) => { reads.push({ type: provider.type, path, options }); return { status: 200, headers: { 'content-type': 'text/plain' }, data: Buffer.from('fixture text') }; };
  }
  const cache = { configure: async () => {}, get: async key => cached.get(key) ?? null,
    put: async (key, data, meta, _ttl, options) => { options?.validate?.(); cached.set(key, { data, meta, stale: false }); } };
  const resolver = new RecursiveResolver(providerManager, cache, stateStore);
  const context = { providerManager, resolver, settings, signal: signal() };
  t.after(() => providerManager.shutdown());
  return { ...context, configs, stateStore, cached, reads, core: [...providerManager.instances.values()].find(provider => provider.type === 'bitcoin-core'),
    explorer: [...providerManager.instances.values()].find(provider => provider.type === 'mempool'),
    ord: [...providerManager.instances.values()].find(provider => provider.type === 'ord-server'),
    run: (name, args = {}) => executeBitcoinAiTool(name, args, context) };
}

test('source discovery uses actual provider eligibility without probing or exposing configuration/secrets', async t => {
  const f = fixture(t);
  f.core.config.cookieFile = '/SYNTHETIC_PRIVATE_PATH';
  f.providerManager.healthState.set(f.core.id, { ok: true, height: 12, error: { message: 'SYNTHETIC_PRIVATE_ERROR' } });
  const result = await f.run('get_bitcoin_sources');
  assert.equal(result.data.sources.length, 3); assert.equal(f.reads.length, 0);
  assert.equal(result.data.sources.find(source => source.type === 'bitcoin-core').local, true);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|baseUrl|cookieFile|username|password/);
  f.settings.localOnly = true;
  assert.deepEqual((await f.run('get_bitcoin_sources')).data.sources.map(source => source.type), ['bitcoin-core']);
  f.settings.network = 'signet'; assert.equal((await f.run('get_bitcoin_sources')).data.sources.length, 0);
});

test('expanded entity reads use normal routing, exact identifiers, bounds and stricter local selection', async t => {
  const f = fixture(t);
  const result = await f.run('lookup_bitcoin', { kind: 'output', value: `${txid}:0`, source: 'local' });
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].type, 'bitcoin-core');
  assert.equal(f.reads[0].options.maxBytes, 8 * 1024 * 1024);
  assert.equal(result.data.valueSats, '3'); assert.equal(result.cards[0].facts[0].value, '3 sats');
  await assert.rejects(f.run('lookup_bitcoin', { kind: 'inscription', value: id, source: 'local' }));
  assert.equal(f.reads.length, 1, 'local request never falls back to remote Ord');
  f.settings.localOnly = true;
  await assert.rejects(f.run('lookup_bitcoin', { kind: 'inscription', value: id, source: 'auto' }));
  assert.equal(f.reads.length, 1);
});

test('strict-local offline entity reads reject public cache snapshots', async t => {
  const f = fixture(t, { offlineMode: true });
  const target = parseNavigationInput('block:1');
  const cached = normalizeEntity(target, { height: 1 }, f.explorer);
  const meta = { providerLocal: false, providerType: 'mempool' };
  f.providerManager.cache = { get: async () => ({ data: Buffer.from(JSON.stringify(cached)), meta, stale: true }) };
  const automatic = await f.run('lookup_bitcoin', { kind: 'block', value: '1' });
  assert.equal(automatic.cards[0].cache, 'stale');
  await assert.rejects(f.run('lookup_bitcoin', { kind: 'block', value: '1', source: 'local' }));
  assert.equal(f.reads.length, 0);
  cached.source.id = f.core.id; cached.source.type = 'bitcoin-core';
  await assert.rejects(f.run('lookup_bitcoin', { kind: 'block', value: '1', source: 'local' }), 'current provider identity alone does not prove an old cache entry was local');
  meta.providerLocal = true; meta.providerType = 'bitcoin-core';
  assert.equal((await f.run('lookup_bitcoin', { kind: 'block', value: '1', source: 'local' })).cards.length, 1);
});

test('explicit service selection reaches Core despite preferred Ord and never falls back across service types', async t => {
  const f = fixture(t); f.ord.config.local = true; f.settings.preferredProviderId = f.ord.id;
  const first = await f.run('lookup_bitcoin', { kind: 'transaction', value: txid, source: 'local', service: 'bitcoin-core' });
  assert.equal(first.cards[0].source, f.core.name); assert.equal(f.reads.at(-1).type, 'bitcoin-core');
  const status = await f.run('get_bitcoin_status', { query: 'chain', source: 'local', service: 'bitcoin-core' });
  assert.equal(status.data.pruned, true); assert.equal(f.reads.at(-1).type, 'bitcoin-core');
  const before = f.reads.length;
  await assert.rejects(f.run('lookup_bitcoin', { kind: 'inscription', value: id, service: 'bitcoin-core' }));
  await assert.rejects(f.run('read_inscription', { id, service: 'bitcoin-core' }));
  await assert.rejects(f.run('get_bitcoin_status', { query: 'mempool', service: 'ord-server' }));
  assert.equal(f.reads.length, before);
});

test('Core status uses only closed read-only methods and normalizes BTC fees precisely', async t => {
  const f = fixture(t);
  const chain = await f.run('get_bitcoin_status', { query: 'chain', source: 'local' });
  assert.equal(chain.data.pruned, true); assert.equal(chain.data.height, 123); assert.equal(chain.cards[0].target, undefined);
  const mempool = await f.run('get_bitcoin_status', { query: 'mempool', source: 'local' });
  assert.equal(mempool.data.totalFeesSats, '10000'); assert.equal(mempool.data.minimumFeeSatVb, 1);
  const fees = await f.run('get_bitcoin_status', { query: 'fees', source: 'local', blocks: 3 });
  assert.equal(fees.data.conservativeSatVb, 2.5); assert.equal(fees.data.targetBlocks, 3);
  assert.deepEqual(f.reads.filter(read => read.method).map(read => [read.method, read.params]), [['getmempoolinfo', []], ['estimatesmartfee', [3, 'CONSERVATIVE']]]);
  assert.ok(f.reads.filter(read => read.method).every(read => read.options.signal && read.options.maxBytes === 128 * 1024));
  assert.doesNotMatch(JSON.stringify([mempool, fees]), /PRIVATE_SERVER/); assert.equal(f.providerManager.activeOperations.size, 0);
});

test('network data respects preferred explorer routing, fixed endpoints and unknown fee estimates', async t => {
  const f = fixture(t); f.settings.preferredProviderId = f.explorer.id;
  const fees = await f.run('get_bitcoin_status', { query: 'fees' }); assert.equal(fees.data.fastestFee, 3);
  const mempool = await f.run('get_bitcoin_status', { query: 'mempool' }); assert.equal(mempool.data.count, 12);
  assert.equal(f.reads.at(-1).path, '/mempool'); assert.doesNotMatch(JSON.stringify([fees, mempool]), /DO_NOT_SHARE/);
  f.core.rpc = async () => ({ result: { errors: ['PRIVATE_RPC_ERROR'], blocks: 6 } });
  assert.equal((await f.run('get_bitcoin_status', { query: 'fees', source: 'local' })).data.conservativeSatVb, null);
});

test('offline, wrong network, blocked credentials and failed local sources never gain public fallback', async t => {
  const f = fixture(t, { offlineMode: true });
  await assert.rejects(f.run('get_bitcoin_status', { query: 'fees' })); assert.equal(f.reads.length, 0);
  f.settings.offlineMode = false; f.settings.network = 'signet';
  await assert.rejects(f.run('get_bitcoin_status', { query: 'chain' })); assert.equal(f.reads.length, 0);
  f.settings.network = 'mainnet'; f.providerManager.blockedProviders.add(f.core.id);
  await assert.rejects(f.run('get_bitcoin_status', { query: 'mempool', source: 'local' })); assert.equal(f.reads.length, 0);
  f.providerManager.blockedProviders.delete(f.core.id);
  f.core.health = async () => ({ ok: true, chain: 'test', height: 200 });
  await assert.rejects(f.run('get_bitcoin_status', { query: 'chain', source: 'local' }));
  assert.equal(f.reads.length, 0);
});

test('malformed live status responses cannot become empty or misleading success cards', async t => {
  const f = fixture(t);
  f.core.health = async () => ({ ok: true, chain: 'main', height: 'fake' });
  f.core.rpc = async () => ({ result: { size: -1 } });
  f.explorer.recommendedFees = async () => ({ fastestFee: 'private text', hourFee: -1 });
  f.explorer.request = async () => ({ ok: true, data: Buffer.from('{}') });
  for (const [query, service] of [['chain', 'bitcoin-core'], ['mempool', 'bitcoin-core'], ['fees', 'mempool'], ['mempool', 'mempool']])
    await assert.rejects(f.run('get_bitcoin_status', { query, service }));
});

test('routing invalidation and shutdown own ignored-abort network reads until settlement', async t => {
  const f = fixture(t); let release, captured;
  f.core.rpc = async (_method, _params, options) => { captured = options.signal; return new Promise(resolve => { release = resolve; }); };
  const pending = f.run('get_bitcoin_status', { query: 'mempool', source: 'local' });
  f.settings.localOnly = true; f.providerManager.invalidateRouting(); assert.equal(captured.aborted, true);
  let drained = false; const shutdown = f.providerManager.shutdown().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release({ result: { size: 10 } }); await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' }); await shutdown;
  assert.equal(f.providerManager.activeOperations.size, 0); assert.equal(f.reads.length, 0);
});

test('transaction details expose paginated relationships, not raw scripts, witnesses, or unknown fields', () => {
  const raw = { txid, fee: 0.00000003, vin: [{ txid: 'c'.repeat(64), vout: 0, scriptSig: 'NO_SCRIPT', txinwitness: ['NO_WITNESS'] }],
    vout: Array.from({ length: 30 }, (_, n) => ({ n, value: 0.00000003, scriptPubKey: { type: 'witness_v1_taproot', address: 'public-address', hex: 'NO_HEX' } })), hex: 'NO_RAW', credentials: 'NO_CREDENTIAL' };
  const details = bitcoinEntityDetails(entity(`tx:${txid}`, raw), 12);
  assert.equal(details.outputs.items.length, 12); assert.equal(details.outputs.nextOffset, 24); assert.equal(details.outputs.total, 30);
  assert.equal(details.outputs.items[0].valueSats, '3'); assert.equal(details.outputs.items[0].target, `output:${txid}:12`); assert.equal(details.feeSats, '3');
  assert.doesNotMatch(JSON.stringify(details), /NO_SCRIPT|NO_WITNESS|NO_HEX|NO_RAW|NO_CREDENTIAL/);
  assert.equal(bitcoinEntityDetails(entity(`tx:${txid}`, { txid, vout: [{ value: 3 }] }, 'mempool')).outputs.items[0].valueSats, '3');
});

test('Rune terms and large integer units remain exact, and Core BTC is not mislabeled as sats', () => {
  const rune = entity('rune:DOG', { name: 'DOG', supply: '99999999999999999999999', divisibility: 18,
    terms: { amount: '123456789123456789123', cap: '99999', height: ['840000', null], offset: [null, '210000'] } }, 'ord-server');
  const details = bitcoinEntityDetails(rune); assert.equal(details.supply, '99999999999999999999999');
  assert.deepEqual(details.terms.height, ['840000', null]); assert.match(details.amountUnit, /base units/);
  for (const [btc, sats] of [[0.00000001, '1'], [0.29, '29000000'], ['1.23456789', '123456789'], [21_000_000, '2100000000000000'], [0, '0']]) assert.equal(bitcoinToSats(btc), sats);
  for (const bad of [null, undefined, -1, Infinity, '1.123456789', {}, 'x', 21_000_001]) assert.equal(bitcoinToSats(bad), null);
  const target = parseNavigationInput(`output:${txid}:0`), output = entity(target.canonical, { value: 0.29 });
  assert.equal(aiEntityCard(target, { entity: output }, 'mainnet').facts[0].value, '29000000 sats');
});

function resource(data, type = 'text/plain', encoding) {
  return { status: 200, data: Buffer.isBuffer(data) ? data : Buffer.from(data), headers: { 'content-type': type, ...(encoding ? { 'content-encoding': encoding } : {}) },
    provenance: { providerName: 'Ord fixture', providerId: 'hidden-id', endpoint: 'DO_NOT_SHARE_ENDPOINT', fetchedAt: '2026-09-12T12:00:00Z' }, cache: 'hit' };
}
test('inscription excerpts read/decode inert content with bounded paging and source provenance', async t => {
  const f = fixture(t), reads = []; const text = '<script>INERT</script>\n{"p":"brc-20"}\n' + 'x'.repeat(7000);
  const context = { ...f, resolver: { resolve: async (path, options) => { reads.push({ path, options }); return resource(gzipSync(text), 'text/html; charset=utf-8', 'gzip'); } } };
  const first = await executeBitcoinAiTool('read_inscription', { id, source: 'local' }, context);
  assert.equal(first.data.text.length, 6000); assert.equal(first.data.nextOffset, 6000); assert.match(first.data.text, /<script>INERT/);
  assert.equal(reads[0].path, `/content/${id}`); assert.equal(reads[0].options.localOnly, true); assert.equal(reads[0].options.maxBytes, 256 * 1024);
  assert.equal(first.cards[0].source, 'Ord fixture'); assert.equal(first.cards[0].cache, 'hit');
  assert.doesNotMatch(JSON.stringify(first), /DO_NOT_SHARE_ENDPOINT|hidden-id/);
  const second = await executeBitcoinAiTool('read_inscription', { id, offset: 6000 }, context);
  assert.equal(first.data.text + second.data.text, text); assert.equal(second.data.nextOffset, null);
});

test('binary, malformed encodings, oversize and decompression bombs never reach model text', async t => {
  const f = fixture(t);
  for (const data of [resource('GLB', 'model/gltf-binary'), resource(Buffer.from([255]), 'text/plain'), resource('x'.repeat(256 * 1024 + 1)),
    resource(gzipSync('x'.repeat(256 * 1024 + 1)), 'text/plain', 'gzip')]) {
    await assert.rejects(executeBitcoinAiTool('read_inscription', { id }, { ...f, resolver: { resolve: async () => data } }));
  }
});

test('Ord relationship endpoints, identifiers and excerpt pagination are main-owned and bounded', async t => {
  const f = fixture(t); const paths = [];
  const ids = Array.from({ length: 30 }, (_, n) => `${'a'.repeat(64)}i${n}`);
  const context = { ...f, resolver: { resolve: async path => { paths.push(path); return resource(JSON.stringify({ ids, more: true, page_index: 2 }), 'application/json'); } } };
  for (const relation of ['parents', 'children', 'sat_inscriptions']) {
    const value = relation === 'sat_inscriptions' ? '123' : id;
    const result = await executeBitcoinAiTool('get_ord_relationships', { relation, value, page: 2, offset: 12 }, context);
    assert.equal(paths.at(-1), `/r/${relation === 'sat_inscriptions' ? 'sat' : relation}/${value}/2`);
    assert.equal(result.cards.length, 12); assert.equal(result.data.nextOffset, 24); assert.equal(result.data.nextPage, 3);
    assert.equal(result.cards[0].target, `inscription:${ids[12]}`);
  }
  await assert.rejects(executeBitcoinAiTool('get_ord_relationships', { relation: 'children', value: id },
    { ...f, resolver: { resolve: async () => resource(JSON.stringify({ ids: ['https://evil.example'], more: false })) } }));
});

test('local recursive reads partition the actual resolver cache and cannot reuse public cache while offline', async t => {
  const f = fixture(t);
  const publicRead = await f.run('read_inscription', { id }); assert.equal(publicRead.data.text, 'fixture text');
  f.settings.offlineMode = true;
  await assert.rejects(f.run('read_inscription', { id, source: 'local' }), { code: 'OFFLINE_CACHE_MISS' });
  assert.equal(f.reads.length, 1);
  f.settings.offlineMode = false;
  await assert.rejects(f.run('read_inscription', { id, source: 'local' })); assert.equal(f.reads.length, 1);
  f.ord.config.local = true;
  await f.run('read_inscription', { id, source: 'local' }); assert.equal(f.reads.length, 2);
  f.settings.offlineMode = true;
  assert.equal((await f.run('read_inscription', { id, source: 'local' })).cards[0].cache, 'hit');
});

test('unsupported parameters, paths, RPCs, services, URLs and private targets fail before any data read', async t => {
  const f = fixture(t);
  for (const [name, args] of [
    ['get_bitcoin_sources', { credentials: true }], ['get_bitcoin_status', { query: 'getwalletinfo' }],
    ['get_bitcoin_status', { query: 'fees', blocks: 1009 }], ['get_bitcoin_status', { query: 'mempool', blocks: 3 }],
    ['get_bitcoin_status', { query: 'chain', source: 'http://127.0.0.1:8332' }],
    ['lookup_bitcoin', { kind: 'address', value: 'file:///tmp/private' }], ['lookup_bitcoin', { kind: 'block', value: '1', source: 'public' }],
    ['read_inscription', { id: `${id}/../secret` }], ['read_inscription', { id, offset: -1 }], ['read_inscription', { id, execute: true }],
    ['get_ord_relationships', { relation: 'metadata', value: id }], ['get_ord_relationships', { relation: 'parents', value: id, page: -1 }],
    ['get_ord_relationships', { relation: 'sat_inscriptions', value: '123/../../secret' }], ['start_node', {}], ['rpc', { method: 'sendtoaddress' }]
  ]) await assert.rejects(f.run(name, args), `${name} ${JSON.stringify(args)}`);
  assert.equal(f.reads.length, 0); assert.equal(f.cached.size, 0);
});

test('tool-result and cumulative context ceilings cannot be expanded by large data or repeated cards', () => {
  const result = { cards: Array.from({ length: 24 }, () => ({ title: 'x'.repeat(1000), facts: [] })), data: { text: 'x'.repeat(100000) } };
  for (const max of [0, 1, 2, 100, 500, AI_LIMITS.toolChars, AI_LIMITS.toolContextChars]) {
    const content = boundedAiToolContext(result, max);
    assert.ok(content.length <= Math.min(max, AI_LIMITS.toolChars));
    if (content) assert.doesNotThrow(() => JSON.parse(content));
  }
});

test('real manager chains source discovery, local status and details with bounded activity, no raw provider context', async t => {
  const f = fixture(t), sent = [], activity = {};
  const calls = [['get_bitcoin_sources', {}], ['get_bitcoin_status', { query: 'mempool', source: 'local' }],
    ['get_bitcoin_status', { query: 'fees', source: 'local' }], ['lookup_bitcoin', { kind: 'output', value: `${txid}:0`, source: 'local' }]];
  const ai = new LocalAiManager({ ...f, request: async (_url, options) => {
    if (!options.body) return { ok: true, data: Buffer.from(JSON.stringify({ data: [{ id: 'fixture' }] })) };
    sent.push(JSON.parse(options.body)); const next = calls.shift();
    return { ok: true, data: Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: next ? '' : '**Read-only** results are ready.',
      ...(next ? { tool_calls: [{ type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : {}) } }] })) };
  } });
  const result = await ai.run({ action: 'chat', config: { ...AI_DEFAULT_CONFIG, model: 'fixture' }, prompt: 'Check my node and this output', history: [], allowLookups: true }, signal(), activity);
  assert.equal(result.cards.length, 3, 'distinct mempool and fee cards must not deduplicate as undefined targets');
  assert.equal(result.activity.length, 4); assert.ok(result.activity.every(step => step.state === 'complete'));
  assert.match(result.activity[0].label, /sources/); assert.equal(result.answer, '**Read-only** results are ready.');
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_SERVER_FIELD|PRIVATE_SERVER_ERROR/);
  assert.equal(f.providerManager.activeOperations.size, 0);
});
