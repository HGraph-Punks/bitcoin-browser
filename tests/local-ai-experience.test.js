import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAiManager, normalizeAiModels, publicAiError } from '../src/main/local-ai.js';
import { executeBitcoinAiTool } from '../src/main/ai-bitcoin-tools.js';
import { bitcoinQuestionPlan, bitcoinQuestionPolicy, bitcoinConceptQuestion, nodeStatusAnswer } from '../src/main/ai-bitcoin-guidance.js';
import { fitAiContext } from '../src/main/ai-context.js';
import { aiCollectorDetails, aiCollectorFacts } from '../src/main/ai-collector-data.js';
import { normalizeRune } from '../src/main/providers/ord-runes.js';
import { EXPERIENCE_CASES, experienceSources, parseExperienceOptions } from '../scripts/test-local-ai-experience.mjs';

const id = `${'a'.repeat(64)}i0`;
const signal = () => new AbortController().signal;
const config = { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:11434', model: 'fixture-model' };
const response = (value, status = 200) => ({ ok: status === 200, status, data: Buffer.from(JSON.stringify(value)) });
function fixture(t, answers = [{ content: 'A bounded explanation.' }], options = {}) {
  const sources = experienceSources('fixture'), requests = [];
  t.after(() => sources.providerManager.shutdown());
  const ai = new LocalAiManager({ ...sources, request: async (_url, init) => {
    if (!init.body) return response({ data: [{ id: config.model, state: 'loaded', type: 'llm', loaded_context_length: options.capacity ?? 8192, max_context_length: 131072 }] });
    requests.push(JSON.parse(init.body));
    const answer = answers.shift();
    assert.ok(answer, 'Unexpected extra inference');
    return answer.httpError ? response({ error: answer.httpError }, 400) : response({ choices: [{ message: { role: 'assistant', ...answer }, finish_reason: 'stop' }] });
  } });
  return { ...sources, ai, requests, chat: (prompt, overrides = {}) => ai.run({ action: 'chat', config, prompt, history: [], allowLookups: true, ...overrides }, signal()) };
}
const call = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('live diagnostic is explicit, loopback-only, synthetic by default only when selected, and inert without --run', () => {
  assert.equal(parseExperienceOptions([]), null); assert.equal(parseExperienceOptions(['--help']), null);
  const args = ['--run', '--server', config.baseUrl, '--model', config.model, '--data', 'fixture', '--case', 'basics'];
  assert.deepEqual(parseExperienceOptions(args), { config, data: 'fixture', cases: ['basics'] });
  for (const invalid of [args.slice(1), [...args, '--run'], [...args, '--token', 'SYNTHETIC'],
    args.map(v => v === 'fixture' ? 'profile' : v), args.map(v => v === config.baseUrl ? 'http://example.com:11434' : v),
    args.map(v => v === 'basics' ? 'private_chats' : v)]) assert.throws(() => parseExperienceOptions(invalid));
  assert.equal(parseExperienceOptions(args.map(v => v === 'basics' ? 'all' : v)).cases.length, Object.keys(EXPERIENCE_CASES).length);
});

test('diagnostic public sources exclude local nodes and synthetic sources actually initialize', async t => {
  const f = fixture(t);
  assert.equal(f.providerManager.instances.size, 3);
  const other = experienceSources('public'); t.after(() => other.providerManager.shutdown());
  assert.ok(other.providerManager.instances.size > 0);
  assert.ok([...other.providerManager.instances.values()].every(p => !p.config.local && p.type !== 'bitcoin-core'));
  const result = await executeBitcoinAiTool('lookup_bitcoin', { kind: 'block', value: '840000' }, { ...f, settings: f.stateStore.get(['settings']), signal: signal() });
  assert.equal(result.cards[0].facts.find(fact => fact.label === 'Transactions').value, '3050');
  assert.equal(f.reads.length, 1);
});

test('only actual loaded context metadata is used, not an advertised model maximum or private metadata', () => {
  const entry = { id: 'model', state: 'loaded', loaded_context_length: 8192, max_context_length: 131072, path: 'PRIVATE_PATH', secret: 'PRIVATE_SECRET' };
  assert.deepEqual(normalizeAiModels({ data: [entry] }, 'lmstudio').models, [{ id: 'model', loaded: true, contextLength: 8192 }]);
  for (const length of [null, 0, 1024, '8192', 1.5, 999999999]) assert.equal(normalizeAiModels({ data: [{ ...entry, loaded_context_length: length }] }, 'lmstudio').models[0].contextLength, undefined);
  assert.equal(normalizeAiModels({ data: [{ ...entry, state: 'not-loaded' }] }, 'lmstudio').models[0].contextLength, undefined);
});

test('action-first planner validates exact inscription IDs, defers ambiguity and never pretends source discovery checked sync', () => {
  assert.deepEqual(bitcoinQuestionPlan(`Look up inscription ${id}. What is its sat rarity?`).args, { kind: 'inscription', value: id });
  const plan = bitcoinQuestionPlan(EXPERIENCE_CASES.local_node);
  assert.deepEqual(plan.args, { query: 'chain', source: 'local', service: 'bitcoin-core' });
  for (const text of [`Don't look up ${id}`, `How can I look up ${id}?`, `Look up ${id} and ${'b'.repeat(64)}i0`,
    `Explain the recursion in inscription ${id}`, 'Look up 123456', 'What does node sync mean?']) assert.equal(bitcoinQuestionPlan(text), null, text);
});

test('concept routing removes irrelevant tool schemas without swallowing factual asset lookups', () => {
  for (const text of [EXPERIENCE_CASES.basics, EXPERIENCE_CASES.provenance, 'What is a Rune?', 'Explain sat rarity']) assert.equal(bitcoinConceptQuestion(text), true, text);
  for (const text of [EXPERIENCE_CASES.rune, EXPERIENCE_CASES.collector, 'What is the supply of DOG?', 'What is the latest block?',
    'What is inscription 12345?', 'What is my wallet balance?', 'Explain block 840000']) assert.equal(bitcoinConceptQuestion(text), false, text);
});

test('local node question uses actual Core status with no inference, no public fallback and no invented synchronized claim', async t => {
  const f = fixture(t, []);
  const result = await f.chat(EXPERIENCE_CASES.local_node);
  assert.equal(result.answerOrigin, 'browser'); assert.equal(result.inferenceResponded, false);
  assert.deepEqual(f.reads, [{ service: 'bitcoin-core', method: 'getblockchaininfo' }]);
  assert.equal(f.requests.length, 0); assert.match(result.answer, /still doing its initial sync/);
  assert.match(result.answer, /95\.00%/); assert.match(result.answer, /Compact storage is enabled/);
  assert.match(result.answer, /does not index inscriptions or Runes/);
  assert.doesNotMatch(result.answer, /833000|fully synced|up to date/);
  assert.equal(f.providerManager.activeOperations.size, 0);
});

test('unavailable local Core does not query the explorer or claim a successful status check', async t => {
  const f = fixture(t, []);
  for (const provider of f.providerManager.instances.values()) if (provider.type === 'bitcoin-core') provider.config.enabled = false;
  const result = await f.chat(EXPERIENCE_CASES.local_node);
  assert.equal(result.cards.length, 0); assert.equal(result.activity[0].state, 'unavailable'); assert.equal(f.reads.length, 0);
  assert.match(result.answer, /couldn't check/); assert.match(result.answer, /Open Sources/);
});

test('leaving initial block download is not reported as independently verified at tip', () => {
  assert.match(nodeStatusAnswer({ data: { initialBlockDownload: false, source: 'Fixture' }, cards: [] }), /does not prove it is at the latest network tip/);
  assert.match(nodeStatusAnswer({ data: { source: 'Fixture' }, cards: [] }), /did not report initial-sync status/);
});

test('exact inscription lookup runs before a weak model can ask for the already supplied ID, preserving all collector facts', async t => {
  const f = fixture(t);
  const result = await f.chat(EXPERIENCE_CASES.collector);
  assert.equal(f.reads.length, 1); assert.equal(result.cards[0].target, `inscription:${id}`);
  const sent = f.requests[0].messages;
  assert.equal(sent.at(-1).role, 'tool');
  assert.equal(JSON.parse(sent.at(-2).tool_calls[0].function.arguments).value, id);
  const received = JSON.parse(sent.at(-1).content);
  assert.equal(received.data.collector.outputPostageSats, '546');
  assert.equal(received.data.collector.inscriptionFeeSats, '1234');
  assert.equal(received.data.collector.sat.block, '9');
  assert.equal(received.data.collector.rarity.key, 'uncommon');
  assert.equal(result.notes.some(note => /shortened/.test(note)), false);
});

test('general explanations are reference-grounded, read-only and have no tool schemas', async t => {
  const f = fixture(t);
  await f.chat(EXPERIENCE_CASES.provenance);
  assert.equal(f.requests[0].tools, undefined); assert.equal(f.reads.length, 0);
  assert.match(f.requests[0].messages[0].content, /explicit parent tags/);
  assert.match(f.requests[0].messages[0].content, /NO loop or cycle/);
  assert.match(f.requests[0].messages[0].content, /OP_RETURN output with OP_13/);
});

test('lookups-off cannot be bypassed by action-first detection or model calls', async t => {
  const f = fixture(t, [{ content: 'Explanation only.' }, { tool_calls: [call('lookup_bitcoin', { kind: 'inscription', value: id })] }]);
  await f.chat(EXPERIENCE_CASES.collector, { allowLookups: false });
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.chat(EXPERIENCE_CASES.collector, { allowLookups: false }), { code: 'AI_TOOL_DENIED' });
  assert.equal(f.reads.length, 0);
});

test('explicit per-question local, Core-only and cached-only restrictions narrow the authority even when the model asks for auto', async t => {
  const f = fixture(t, [{ tool_calls: [call('lookup_bitcoin', { kind: 'block', value: '840000', source: 'auto', service: 'mempool' })] }, { content: 'Checked.' }]);
  await f.chat('Look up block 840000 using local sources only and Bitcoin Core only.');
  assert.deepEqual(f.reads, [{ service: 'bitcoin-core', kind: 'block' }]);
  const policy = bitcoinQuestionPolicy('Use only local sources; no public fallback.'); assert.equal(policy.localOnly, true);
  const context = { ...f, settings: f.stateStore.get(['settings']), signal: signal(), questionPolicy: policy };
  const discovered = await executeBitcoinAiTool('get_bitcoin_sources', {}, context);
  assert.ok(discovered.data.sources.every(source => source.local));
  await assert.rejects(executeBitcoinAiTool('browse_runes', [], context), { code: 'AI_TOOL_ARGUMENTS' });
  await assert.rejects(executeBitcoinAiTool('browse_runes', { source: 'public' }, context), { code: 'AI_TOOL_ARGUMENTS' });
  const before = f.reads.length;
  const offline = await executeBitcoinAiTool('lookup_bitcoin', { kind: 'block', value: '1' }, { ...context, questionPolicy: { cacheOnly: true } });
  assert.match(offline.error, /Enable Offline mode/); assert.equal(f.reads.length, before);
});

test('formatted Rune collector data keeps precision, mint state and supply distinctions', () => {
  const raw = normalizeRune({ id: '840000:3', mintable: false, entry: { spaced_rune: 'DOG•GO•TO•THE•MOON', number: '3', divisibility: 5,
    symbol: 'D', premine: '10000000000000000', burned: '0', mints: '0', timestamp: 1713571767, block: '840000', etching: 'b'.repeat(64), turbo: false, terms: null } });
  const entity = { type: 'rune', data: raw, network: 'mainnet' };
  const details = aiCollectorDetails(entity);
  assert.equal(details.tokens.outstanding, '100,000,000,000'); assert.equal(details.tokens.maximum, '100,000,000,000');
  assert.equal(details.premineShareOfMaximum, '100%'); assert.equal(details.remainingMints, '0'); assert.equal(details.mintState, 'fixed');
  assert.match(details.explanation, /not circulating/);
  assert.ok(aiCollectorFacts(entity).some(fact => fact.label === 'Mint status (source snapshot)' && fact.value === 'No public mint'));
});

test('Rune summaries preserve exact source amounts and cannot be overwritten with model arithmetic or invented holder tools', async t => {
  const f = fixture(t, [{ tool_calls: [call('lookup_bitcoin', { kind: 'rune', value: 'DOG•GO•TO•THE•MOON' })] },
    { content: 'The supply is ten trillion. Call get_ord_relationships to find Rune holders.' }]);
  const result = await f.chat(EXPERIENCE_CASES.rune);
  assert.equal(result.answerOrigin, 'browser'); assert.equal(result.inferenceResponded, true);
  assert.match(result.answer, /100,000,000,000/); assert.match(result.answer, /No public mint/);
  assert.match(result.answer, /not circulating/); assert.match(result.answer, /holder list are not available/);
  assert.doesNotMatch(result.answer, /ten trillion|get_ord_relationships/);
  assert.equal(result.cards[0].target, 'rune:DOG•GO•TO•THE•MOON');
});

test('copied canonical targets work for the matching kind, while wrong kinds and URLs are rejected before lookup', async t => {
  const f = fixture(t), context = { ...f, settings: f.stateStore.get(['settings']), signal: signal() };
  const result = await executeBitcoinAiTool('lookup_bitcoin', { kind: 'rune', value: 'rune:DOG•GO•TO•THE•MOON' }, context);
  assert.equal(result.cards[0].target, 'rune:DOG•GO•TO•THE•MOON');
  for (const value of ['inscription:' + id, 'https://example.com/rune/DOG', 'satnav://settings', 'rune:rune:DOG'])
    await assert.rejects(executeBitcoinAiTool('lookup_bitcoin', { kind: 'rune', value }, context));
  assert.equal(f.reads.length, 1);
});

test('failed asset lookups with editorial-only results cannot become a fabricated on-chain answer', async t => {
  const f = fixture(t, [{ tool_calls: [call('search_featured', { asset: 'runes', query: 'DOG' }), call('lookup_bitcoin', { kind: 'rune', value: 'DOG•GO•TO•THE•MOON', source: 'local' })] },
    { content: 'The current supply is ten trillion and minting is open. I verified it.' }]);
  const result = await f.chat(EXPERIENCE_CASES.rune);
  assert.equal(result.answerOrigin, 'browser'); assert.ok(result.cards.every(card => card.editorial));
  assert.match(result.answer, /curated examples only/); assert.match(result.answer, /No current supply/);
  assert.doesNotMatch(result.answer, /ten trillion|I verified it/);
});

test('unknown metadata and non-mainnet sats cannot become fabricated collector rarity', () => {
  const entity = { type: 'inscription', network: 'mainnet', data: {} };
  assert.equal(aiCollectorDetails(entity).rarity, null); assert.equal(aiCollectorDetails(entity).outputPostageSats, null);
  assert.equal(aiCollectorDetails({ ...entity, data: { sat: '45000000000', metadataUnavailable: true } }).rarity, null);
  assert.equal(aiCollectorDetails({ ...entity, network: 'testnet', data: { sat: '45000000000' } }).sat, null);
  const conflict = aiCollectorDetails({ ...entity, data: { sat: '45000000000', charms: ['common'] } });
  assert.equal(conflict.conflict, true); assert.equal(conflict.rarity.key, 'uncommon');
  assert.equal(aiCollectorDetails({ ...entity, data: { value: -1, fee: '99999999999999999' } }).inscriptionFeeSats, null);
});

test('context fitting retains the current question, complete call pairs and all visible chat/card objects', () => {
  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ` + 'history '.repeat(370) }));
  const messages = [{ role: 'system', content: 'Trusted policy' }, ...history, { role: 'user', content: 'CURRENT_QUESTION' }];
  const original = structuredClone(messages);
  const result = fitAiContext(messages, [], 4096);
  assert.equal(result.shortened, true); assert.equal(result.messages.at(-1).content, 'CURRENT_QUESTION');
  assert.equal(result.messages[0].content, 'Trusted policy'); assert.equal(result.messages[1].role, 'user');
  assert.deepEqual(messages, original);
  assert.throws(() => fitAiContext([{ role: 'system', content: 'x'.repeat(100000) }, { role: 'user', content: 'Current' }], [], 2048), { code: 'AI_CONTEXT_LIMIT' });
});

test('context trimming removes whole old tool rounds and preserves valid JSON with exact fact strings', () => {
  const messages = [{ role: 'system', content: 'Policy' }, { role: 'user', content: 'Current' }];
  for (let i = 0; i < 3; i++) messages.push({ role: 'assistant', content: '', tool_calls: [{ ...call('lookup_bitcoin', { kind: 'block', value: String(i) }), id: `call_${i}` }] },
    { role: 'tool', tool_call_id: `call_${i}`, content: JSON.stringify({ cards: [{ target: `block:${i}`, facts: [{ label: 'Exact', value: '100,000,000,000' }] }], data: { text: 'x'.repeat(15000) } }) });
  const result = fitAiContext(messages, [], 4096);
  assert.equal(result.shortened, true);
  const ids = result.messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id));
  for (const message of result.messages.filter(message => message.role === 'tool')) {
    assert.ok(ids.includes(message.tool_call_id));
    assert.equal(JSON.parse(message.content).cards[0].facts[0].value, '100,000,000,000');
  }
  assert.equal(messages.length, 8);
});

test('server context rejections use actionable fixed text and preserve completed cards without raw server diagnostics', async t => {
  const f = fixture(t, [{ httpError: 'context length exceeded PRIVATE_PROMPT_TOKEN_AND_PATH' }]);
  const result = await f.chat(EXPERIENCE_CASES.collector);
  assert.equal(result.error.code, 'AI_CONTEXT_LIMIT'); assert.equal(result.cards.length, 1);
  assert.match(result.error.message, /one result at a time/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT_TOKEN_AND_PATH/);
  assert.doesNotMatch(publicAiError({ code: 'AI_CONTEXT_LIMIT', message: 'SECRET' }).message, /SECRET/);
});
