import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runeLookup, runeIdentity, runesTarget, runesCanonical, formatRuneAmount, RUNE_U128_MAX } from '../src/shared/runes.js';
import { parseNavigationInput, canonicalToDeepLink, targetCapability } from '../src/shared/navigation.js';
import { parseRuneJson, normalizeRune, runeFromHtml, runesFromHtml, runesFromJson } from '../src/main/providers/ord-runes.js';
import { OrdServerProvider } from '../src/main/providers/ord-server.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { planLookup } from '../src/renderer/search.js';

const publicHtml = JSON.parse(fs.readFileSync(new URL('./fixtures/runes-public-html.json', import.meta.url), 'utf8'));
const txid = 'a'.repeat(64);
function raw(overrides = {}) {
  return { id: '840000:1', mintable: true, parent: `${txid}i0`, entry: {
    spaced_rune: 'TEST•RUNE', block: 840000, number: 100, divisibility: 2, symbol: '⧉', premine: '100', burned: '1', mints: '2',
    timestamp: 1713571767, etching: txid, turbo: false,
    terms: { amount: '1000', cap: '100', height: ['840010', null], offset: ['20', '100'] }, ...overrides
  } };
}
function provider(respond) {
  const p = new OrdServerProvider({ id: 'rune-fixture', name: 'Rune fixture', type: 'ord-server', network: 'mainnet', baseUrl: 'http://127.0.0.1:1', local: true, capabilities: ['rune'] });
  const calls = [];
  p.fetchPath = async (path, options) => { calls.push({ path, options }); return respond(path, options, calls.length); };
  return { p, calls };
}
const response = body => ({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });

test('Rune names, spacers, maximum protocol name and numeric identity round-trip', () => {
  for (const input of ['uncommon goods', 'UNCOMMON.GOODS', 'UNCOMMON•GOODS']) assert.equal(runeLookup(input), 'UNCOMMON•GOODS');
  assert.equal(runeIdentity('uncommon goods'), 'UNCOMMONGOODS');
  assert.equal(runeLookup('A'), 'A');
  assert.equal(runeLookup('BCGDENLQRQWDSLRUGSNLBTMFIJAV'), 'BCGDENLQRQWDSLRUGSNLBTMFIJAV');
  assert.equal(runeLookup('000840000:01'), '840000:1');
  assert.equal(runeLookup('18446744073709551615:4294967295'), '18446744073709551615:4294967295');
  for (const value of ['Z'.repeat(28), 'A'.repeat(29), '•ABC', 'ABC•', 'AB..CD', 'A-B', '0:1', '18446744073709551616:0', '1:4294967296', '1:-1', 'A/B', '../runes', '<script>', 'ß', 'ＡＢＣ', null, '']) assert.throws(() => runeLookup(value), { code: 'INVALID_TARGET' });
});

test('Rune browsing routes are bounded and preserve existing capabilities and deep links', () => {
  for (const page of [0, 1, 10000000]) {
    const target = parseNavigationInput(runesCanonical(page));
    assert.equal(target.kind, 'runes'); assert.equal(targetCapability(target), 'rune');
    assert.equal(canonicalToDeepLink(target), runesCanonical(page));
  }
  for (const suffix of ['?page=-1', '?page=1.1', '?page=10000001', '?page=1&page=2', '?address=x', '/1', '#x']) assert.throws(() => parseNavigationInput(`satnav://runes${suffix}`));
  assert.equal(parseNavigationInput('840000:1').canonical, 'rune:840000:1');
  assert.equal(parseNavigationInput('rune:uncommon goods').canonical, 'rune:UNCOMMON•GOODS');
  assert.equal(parseNavigationInput(canonicalToDeepLink('rune:TEST•RUNE')).canonical, 'rune:TEST•RUNE');
  assert.equal(planLookup('uncommon goods', 'rune').target, 'rune:UNCOMMON•GOODS');
  assert.equal(parseNavigationInput(`${txid}:1`).kind, 'output');
});

test('Rune decimal formatting preserves every atomic digit including u128 and divisibility 38', () => {
  assert.equal(formatRuneAmount('900719925474099312345', 6), '900,719,925,474,099.312345');
  assert.equal(formatRuneAmount('1', 38), `0.${'0'.repeat(37)}1`);
  assert.equal(formatRuneAmount('100', 2), '1');
  assert.equal(formatRuneAmount('0', 38), '0');
  assert.equal(formatRuneAmount(RUNE_U128_MAX.toString(), 0), '340,282,366,920,938,463,463,374,607,431,768,211,455');
  for (const [value, div] of [[-1, 0], ['1e3', 0], [9007199254740992, 0], ['1', 39], ['-1', 2], [(RUNE_U128_MAX + 1n).toString(), 0], [null, 0]]) assert.equal(formatRuneAmount(value, div), '—');
});

test('lossless JSON rejects unsupported numeric encodings instead of rounding balances', () => {
  assert.equal(parseRuneJson(`{"cap":${RUNE_U128_MAX}}`).cap, RUNE_U128_MAX.toString());
  assert.equal(parseRuneJson('{"n":0}').n, '0');
  for (const value of ['{"n":1.5}', '{"n":1e30}', '{"n":-1}', 'not json', ' '.repeat(262145)]) assert.throws(() => parseRuneJson(value), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('Rune normalization computes supply, burned subtraction and effective mint bounds exactly', () => {
  const rune = normalizeRune(raw(), 'testrune');
  assert.equal(rune.supply, '2100'); assert.equal(rune.outstanding, '2099'); assert.equal(rune.maximum, '100100');
  assert.equal(rune.mintStart, '840020'); assert.equal(rune.mintEnd, '840100');
  assert.equal(rune.parent, `${txid}i0`); assert.equal(rune.predefined, false);
  const closed = raw({ terms: null, mints: '0', burned: '100' }); closed.mintable = false;
  assert.equal(normalizeRune(closed).outstanding, '0');
  const cap = raw({ premine: '0', burned: '0', mints: '0', terms: { amount: '1', cap: RUNE_U128_MAX.toString(), height: [null, null], offset: [null, null] } });
  assert.equal(normalizeRune(cap).maximum, RUNE_U128_MAX.toString());
  const nonprinting = normalizeRune(raw({ symbol: '\u202e' }));
  assert.equal(nonprinting.symbol, null); assert.equal(nonprinting.symbolCodePoint, 'U+202E');
});

test('Rune schemas reject mismatched identities, malformed data and impossible amounts', () => {
  for (const input of [null, {}, { entry: {} }, raw({ premine: 9007199254740992 }), raw({ divisibility: 39 }), raw({ symbol: '<img>' }), raw({ burned: '2101' }), raw({ mints: '101' }), raw({ block: 840001 }), raw({ etching: 'x' }), raw({ terms: {} }), raw({ spaced_rune: '<script>' }), raw({ turbo: 'false' }), raw({ premine: RUNE_U128_MAX.toString() })]) assert.throws(() => normalizeRune(input), { code: 'INVALID_PROVIDER_RESPONSE' });
  assert.throws(() => normalizeRune(raw(), 'OTHER'), { code: 'INVALID_PROVIDER_RESPONSE' });
  assert.throws(() => normalizeRune(raw(), '840000:2'), { code: 'INVALID_PROVIDER_RESPONSE' });
  assert.throws(() => normalizeRune({ ...raw(), mintable: 'false' }), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('real public Ord HTML fixture yields Rune listing and accurate predefined Rune detail', () => {
  const list = runesFromHtml(publicHtml[0].body, 0);
  assert.equal(list.items.length, 51); assert.equal(list.next, 'satnav://runes?page=1'); assert.equal(list.previous, null);
  assert.equal(list.items[0].name, 'RUNES•BIZ');
  const rune = runeFromHtml(publicHtml[1].body, '1:0');
  assert.equal(rune.name, 'UNCOMMON•GOODS'); assert.equal(rune.predefined, true);
  assert.equal(rune.terms.cap, RUNE_U128_MAX.toString()); assert.equal(rune.supply, '147684423'); assert.equal(rune.outstanding, '147660605');
  assert.equal(rune.termsRepresentation, 'effective');
});

test('HTML parser rejects wrong pages, wrong identities, injected paths and duplicate fields', () => {
  for (const body of ['<html>maintenance</html>', publicHtml[0].body.replace('href=/rune/RUNES•BIZ', 'href=https://evil.example/rune/RUNES•BIZ'), publicHtml[0].body.replace('href=/runes/1', 'href=/runes/2'), publicHtml[0].body.replace('<h1>Runes</h1>', '<h1>Transactions</h1>')]) assert.throws(() => runesFromHtml(body, 0));
  assert.throws(() => runeFromHtml(publicHtml[1].body, 'OTHER'));
  assert.throws(() => runeFromHtml(publicHtml[1].body.replace('<dt>number</dt>', '<dt>number</dt><dd>4</dd><dt>number</dt>'), '1:0'));
  assert.throws(() => runeFromHtml(publicHtml[1].body.replace('<dd>0</dd>', '<dd><script>alert(1)</script></dd>'), '1:0'));
});

test('JSON list pagination is bounded, unique, sequential and does not infer current mint availability', () => {
  const data = runesFromJson({ entries: [[raw().id, raw().entry]], more: true, prev: null, next: 1 }, 0);
  assert.equal(data.items[0].mintable, null); assert.equal(data.next, runesCanonical(1));
  for (const input of [{ entries: [], more: true, next: 2 }, { entries: [], more: false, next: 1 }, { entries: Array(101).fill([raw().id, raw().entry]), more: false }, { entries: Array(2).fill([raw().id, raw().entry]), more: false, prev: null, next: null }]) assert.throws(() => runesFromJson(input, 0));
});

test('actual Ord adapter uses only its configured Rune endpoints with bounded HTML fallback', async () => {
  for (const [target, fixture] of [[runesTarget(), publicHtml[0]], [parseNavigationInput('rune:UNCOMMON•GOODS'), publicHtml[1]]]) {
    const { p, calls } = provider((_path, _options, n) => n === 1 ? { status: 406, data: Buffer.from('JSON API disabled') } : response(fixture.body));
    const entity = await p.resolve(target, { timeoutMs: 5000, maxBytes: 1000000 });
    assert.equal(entity.type, target.kind); assert.equal(entity.network, 'mainnet'); assert.equal(entity.source.id, p.id);
    assert.equal(calls.length, 2); assert.equal(calls[0].path, calls[1].path);
    assert.deepEqual(calls.map(call => call.options.accept), ['application/json', 'text/html']);
    assert.ok(calls.every(call => call.options.maxBytes === 262144 && call.options.allowExplorerPath));
  }
});

test('JSON adapter produces serializable exact normalized Rune metadata and summary', async () => {
  const { p, calls } = provider(() => response(raw()));
  const entity = await p.resolve(parseNavigationInput('rune:TEST•RUNE'));
  assert.equal(entity.summary.rune, 'TEST•RUNE'); assert.equal(entity.summary.supply, '2100'); assert.equal(entity.data.format, 'json');
  assert.doesNotThrow(() => JSON.stringify(entity)); assert.equal(calls.length, 1);
});

test('caller cancellation before work admits zero source reads', async () => {
  const controller = new AbortController(); const reason = new Error('obsolete Rune tab'); controller.abort(reason);
  const { p, calls } = provider(() => response(raw()));
  await assert.rejects(p.resolve(runesTarget(), { signal: controller.signal }), error => error === reason);
  assert.equal(calls.length, 0);
});

test('cancellation at the JSON/HTML boundary does not admit fallback or publish an entity', async () => {
  const controller = new AbortController(); const reason = new Error('network changed');
  const { p, calls } = provider(() => { controller.abort(reason); return { status: 406, data: Buffer.from('disabled') }; });
  await assert.rejects(p.resolve(runesTarget(), { signal: controller.signal }), error => error === reason);
  assert.equal(calls.length, 1);
});

test('late transport rejection retains exact caller cancellation reason', async () => {
  const controller = new AbortController(); const reason = new Error('closed tab');
  const { p } = provider(() => { controller.abort(reason); throw new Error('late transport failure'); });
  await assert.rejects(p.resolve(runesTarget(), { signal: controller.signal }), error => error === reason);
});

test('Rune fallback shares one total deadline and does not admit a late second request', async () => {
  const { p, calls } = provider(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { status: 406, data: Buffer.from('disabled') }; });
  await assert.rejects(p.resolve(runesTarget(), { timeoutMs: 5 }), { code: 'PROVIDER_TIMEOUT', status: 504 });
  assert.equal(calls.length, 1);
});

function managerFixture() {
  const settings = { network: 'mainnet', localOnly: false, offlineMode: false, requestTimeoutMs: 5000, maxResourceBytes: 262144 };
  const providers = [
    { id: 'remote', type: 'ord-server', network: 'mainnet', local: false, capabilities: ['rune'] },
    { id: 'local', type: 'ord-server', network: 'mainnet', local: true, capabilities: ['rune'] },
    { id: 'testnet', type: 'ord-server', network: 'testnet', local: true, capabilities: ['rune'] },
    { id: 'mempool', type: 'mempool', network: 'mainnet', local: false, capabilities: ['address'] }
  ].map((item, index) => ({ ...item, name: item.id, baseUrl: item.local ? 'http://127.0.0.1:1' : 'https://ordinals.com', priority: index, enabled: true }));
  const state = { settings, providers };
  const entries = new Map();
  const cache = { get: async key => entries.has(key) ? { data: entries.get(key), stale: false } : null,
    put: async (key, value, _meta, _ttl, options) => { options.validate(); entries.set(key, value); }, delete: async key => entries.delete(key) };
  // Existing routing checks credential-binding metadata. This is an in-memory
  // empty collaborator, never the OS Keychain or a credential-bearing profile.
  const manager = new ProviderManager({ get: keys => structuredClone(state[keys[0]]) }, { get: () => null }, null, cache);
  return { manager, settings, entries };
}

test('Rune routes respect selected network, Rune capability and local-only routing', async () => {
  const { manager, settings } = managerFixture();
  assert.deepEqual(manager.candidates('rune').map(p => p.id), ['remote', 'local']);
  settings.localOnly = true;
  assert.deepEqual(manager.candidates('rune').map(p => p.id), ['local']);
  settings.network = 'testnet';
  assert.deepEqual(manager.candidates('rune').map(p => p.id), ['testnet']);
  for (const [id, instance] of manager.instances) instance.fetchPath = () => { assert.equal(id, 'testnet'); return response({ entries: [], more: false, prev: null, next: null }); };
  const result = await manager.resolve(runesTarget()); assert.equal(result.entity.network, 'testnet'); assert.equal(result.entity.source.id, 'testnet');
  manager.shutdown();
});

test('Rune lists and details cache offline without source requests or cross-network reuse', async () => {
  const { manager, settings, entries } = managerFixture(); let requests = 0;
  for (const instance of manager.instances.values()) instance.fetchPath = path => { requests++; return response(path.startsWith('/runes/') ? { entries: [[raw().id, raw().entry]], more: false, prev: null, next: null } : raw()); };
  const targets = [runesTarget(), parseNavigationInput('rune:TEST•RUNE')];
  for (const target of targets) await manager.resolve(target);
  assert.equal(requests, 2); assert.equal(entries.size, 2);
  settings.offlineMode = true;
  for (const target of targets) assert.equal((await manager.resolve(target)).cache, 'hit');
  assert.equal(requests, 2);
  settings.network = 'testnet';
  await assert.rejects(manager.resolve(runesTarget()), { code: 'OFFLINE_CACHE_MISS' });
  assert.equal(requests, 2); manager.shutdown();
});

test('cancelled Rune resolution cannot populate cache, mark healthy or fall through to another source', async () => {
  const { manager, entries } = managerFixture(); const controller = new AbortController(); const reason = new Error('tab replaced'); let calls = 0;
  for (const instance of manager.instances.values()) instance.fetchPath = () => { calls++; controller.abort(reason); return response(raw()); };
  await assert.rejects(manager.resolve(parseNavigationInput('rune:TEST•RUNE'), { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1); assert.equal(entries.size, 0); assert.equal(manager.healthState.size, 0); assert.equal(manager.activeOperations.size, 0);
  manager.shutdown();
});
