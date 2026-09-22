import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { inscriptionReferences, RECURSION_LIMITS, RECURSIVE_CANDIDATES, recursiveSearchIntent, recursiveSearchAnswer } from '../src/main/ai-inscription-recursion.js';
import { executeBitcoinAiTool } from '../src/main/ai-bitcoin-tools.js';
import { LocalAiManager } from '../src/main/local-ai.js';
import { RecursiveResolver } from '../src/main/resolver.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { normalizeEntity } from '../src/main/providers/normalize.js';
import { DEFAULT_SETTINGS, DEFAULT_PROVIDERS } from '../src/shared/constants.js';
import { AI_DEFAULT_CONFIG } from '../src/shared/local-ai.js';

const id = n => `${n.toString(16).padStart(64, '0')}i0`;
const root = id(1), a = id(2), b = id(3), c = id(4);
const html = (...ids) => ids.map(value => `<script src="/content/${value}"></script>`).join('');
const text = value => ({ status: 200, headers: { 'content-type': 'text/html;charset=utf-8' }, data: Buffer.from(value) });
function fixture(t, overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const configs = DEFAULT_PROVIDERS.filter(p => ['ord-server', 'bitcoin-core'].includes(p.type)).map(p => ({ ...p, enabled: true }));
  const stateStore = { get: keys => structuredClone(keys[0] === 'settings' ? settings : keys[0] === 'providers' ? configs : []) };
  const providerManager = new ProviderManager(stateStore, { get: () => null }, null);
  const reads = [], bodies = new Map(), cacheEntries = new Map();
  for (const provider of providerManager.instances.values()) {
    provider.fetchPath = async (path, options) => {
      reads.push({ path, local: provider.config.local, options });
      assert.match(path, /^\/(?:content\/[a-f0-9]{64}i\d+|r\/sat\/\d+\/at\/-?\d+)$/);
      const value = bodies.get(path.startsWith('/content/') ? path.slice(9) : path);
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return value(options);
      return value ?? text('No dependencies');
    };
    provider.resolve = async (target, options) => { reads.push({ target: target.canonical, local: provider.config.local, options }); return normalizeEntity(target, { id: root, number: 127364571 }, provider); };
    provider.rpc = () => assert.fail('Inscription search must not invoke Core RPC');
  }
  const cache = { configure: async () => {}, get: async key => cacheEntries.get(key) ?? null,
    put: async (key, data, meta, _ttl, options) => { options?.validate?.(); cacheEntries.set(key, { data, meta, stale: false }); } };
  const resolver = new RecursiveResolver(providerManager, cache, stateStore);
  const controller = new AbortController();
  const context = { providerManager, resolver, settings, signal: controller.signal };
  const modelRequests = [];
  const request = async (url, options) => {
    const body = options.body && JSON.parse(options.body); modelRequests.push(body ?? { catalog: true });
    const response = !body ? { data: [{ id: 'test-chat', type: 'llm', state: 'loaded' }] }
      : { choices: [{ message: { role: 'assistant', content: 'Each inscription has at most one parent. Pick an inscription yourself.' } }] };
    return { ok: true, status: 200, data: Buffer.from(JSON.stringify(response)) };
  };
  const ai = new LocalAiManager({ stateStore, providerManager, resolver, request });
  t.after(() => providerManager.shutdown());
  return { ...context, context, controller, stateStore, ai, reads, bodies, cacheEntries, modelRequests,
    run: (name, args = {}) => executeBitcoinAiTool(name, args, context),
    chat: (prompt, extra = {}) => ai.run({ action: 'chat', config: { ...AI_DEFAULT_CONFIG, model: 'test-chat' }, prompt, history: [], allowLookups: true, ...extra }, controller.signal) };
}

test('literal content references are separate from provenance, numeric IDs and external URLs', () => {
  const source = `${html(a)} fetch('/content/${b}?variant=1'); url(/content/${c})
    <img src=/content/${a}> import('ord://content/${c}'); fetch('/r/blockheight');
    fetch('/r/children/${root}/0'); {"parents":["${id(5)}"],"children":["${id(6)}"]}
    fetch('https://evil.example/content/${id(7)}'); fetch('https://evil.example/?q=/content/${id(8)}');
    <img src="https://evil.example/?src=/content/${id(11)}"> <a href="https://evil.example/?href=/content/${id(12)}">
    fetch('//evil.example/content/${id(9)}'); fetch('/content/127364571'); fetch('/r/../../wallet');
    fetch('/content/${id(10)}/extra'); fetch('/content/' + someId); fetch('/r/sat/' + someSat);`;
  const found = inscriptionReferences(source);
  assert.deepEqual(new Set(found.ids), new Set([a, b, c]));
  assert.deepEqual(found.endpoints, ['/r/blockheight', `/r/children/${root}/0`]); assert.equal(found.limited, false);
  assert.deepEqual(inscriptionReferences(`{"parents":["${a}"],"children":["${b}"]}`).ids, []);
});

test('escaped root paths are handled, oversized and malformed references are not followed', () => {
  assert.deepEqual(inscriptionReferences(`"\\/content\\/${a}"`).ids, [a]);
  assert.equal(inscriptionReferences(html(...Array.from({ length: 100 }, (_, n) => id(n + 1)))).ids.length, RECURSION_LIMITS.references);
  assert.equal(inscriptionReferences(html(...Array.from({ length: 100 }, (_, n) => id(n + 1)))).limited, true);
  for (const path of [`/content/${a}/../secret`, `/content/${a}%2f..`, `/content/${'a'.repeat(64)}i12345678901`, `/r/not-a-tool/${a}`])
    assert.deepEqual(inscriptionReferences(`'${path}'`).ids, []);
});

test('static graph traces nested dependencies once, handles cycles, and never executes or fetches endpoints', async t => {
  const f = fixture(t);
  f.bodies.set(root, text(`${html(a, b)} fetch('/r/blockheight'); globalThis.__recursionExecuted = true;`));
  f.bodies.set(a, text(html(root, c))); f.bodies.set(b, text(html(c))); f.bodies.set(c, text('leaf'));
  const result = await f.run('inspect_inscription_recursion', { value: root, source: 'local', service: 'ord-server' });
  const graph = result.data.results[0];
  assert.equal(graph.contentReferences, 3); assert.equal(graph.directContentReferences, 2); assert.equal(graph.observedHops, 2);
  assert.equal(graph.resourcesRead, 4); assert.equal(graph.recursiveEndpointReferences, 1); assert.equal(graph.unresolvedResources, 0);
  assert.equal(f.reads.length, 4); assert.equal(globalThis.__recursionExecuted, undefined);
  assert.ok(f.reads.every(read => read.local && read.options.maxBytes <= RECURSION_LIMITS.resourceBytes));
  assert.match(result.note, /not parent\/child/); assert.match(result.note, /Nothing was executed/);
  assert.doesNotMatch(JSON.stringify(result), /__recursionExecuted|providerId|sha256|baseUrl|cookieFile/);
});

test('HTTP gzip and Brotli content is decoded before scanning and binary content is not interpreted', async t => {
  const f = fixture(t);
  f.bodies.set(root, { ...text(''), headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, data: gzipSync(html(a, b)) });
  f.bodies.set(a, { ...text(''), headers: { 'content-type': 'application/javascript', 'content-encoding': 'br' }, data: brotliCompressSync(Buffer.from(html(c))) });
  f.bodies.set(b, { ...text(html(id(99))), headers: { 'content-type': 'image/png' } });
  const graph = (await f.run('inspect_inscription_recursion', { value: root })).data.results[0];
  assert.equal(graph.contentReferences, 3); assert.equal(graph.textResourcesInspected, 3); assert.equal(graph.resourcesRead, 4);
  assert.ok(!f.reads.some(read => read.path === `/content/${id(99)}`));
});

test('exact and simple constant sat pointers resolve actual works without interpreting JavaScript or provenance', async t => {
  const f = fixture(t);
  f.bodies.set(root, text(`const bookOfBlob = 1749358685368819; fetch(\`/r/sat/\${bookOfBlob}/at/-1\`); fetch('/r/parents/${root}/0');`));
  f.bodies.set('/r/sat/1749358685368819/at/-1', { ...text(JSON.stringify({ id: a, parents: [b], credentials: 'PRIVATE_FIELD' })), headers: { 'content-type': 'application/json' } });
  f.bodies.set(a, text(html(b))); f.bodies.set(b, text('leaf'));
  const result = await f.run('inspect_inscription_recursion', { value: root, source: 'local' });
  const graph = result.data.results[0];
  assert.equal(result.cards[0].target, `inscription:${root}`, 'open the actual work, not its shared renderer');
  assert.equal(graph.contentReferences, 2); assert.equal(graph.satPointersRead, 1); assert.equal(graph.observedHops, 3);
  assert.equal(graph.recursiveEndpointReferences, 2); assert.equal(graph.unresolvedSatPointers, 0);
  assert.equal(f.reads.length, 4); assert.ok(f.reads.every(read => read.local)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIELD/);
  const pointer = f.reads.find(read => read.path.startsWith('/r/'));
  assert.equal(pointer.options.maxBytes, 128 * 1024); assert.equal(pointer.options.accept, 'application/json');
});

test('sat template expansion is deliberately narrow and never evaluates expressions or arbitrary paths', () => {
  for (const source of [
    'const sat = readSecret(); fetch(`/r/sat/${sat}/at/-1`)',
    'const sat = 12 + 3; fetch(`/r/sat/${sat}/at/-1`)',
    'const sat = 10; const sat = 20; fetch(`/r/sat/${sat}/at/-1`)',
    'const sat = 10; fetch(`/r/sat/${globalThis.secret}/at/-1`)',
    'fetch("/r/sat/2100000000000000/at/-1")',
    'fetch("/r/sat/1/at/9999999999")',
    'fetch("https://evil.example/r/sat/1/at/-1")'
  ]) assert.deepEqual(inscriptionReferences(source).satLookups, [], source);
});

test('bad or missing sat responses never fabricate IDs; unresolved pointers are disclosed', async t => {
  const f = fixture(t); f.bodies.set(root, text("fetch('/r/sat/1/at/-1')"));
  f.bodies.set('/r/sat/1/at/-1', text('{"id":"/private/arbitrary-path"}'));
  const result = await f.run('inspect_inscription_recursion', { value: root });
  assert.equal(result.data.results[0].unresolvedSatPointers, 1);
  assert.equal(result.data.results[0].contentReferences, 0); assert.equal(f.reads.length, 2);
  assert.match(recursiveSearchAnswer(result, false), /1 referenced resources were not inspected/);
  assert.doesNotMatch(JSON.stringify(result), /arbitrary-path/);
});

test('depth, resource count, byte and reference bounds produce honest partial results', async t => {
  const f = fixture(t, { maxRecursionDepth: 1, maxRecursionNodes: 2 });
  f.bodies.set(root, text(html(a, b))); f.bodies.set(a, text(html(c)));
  const graph = (await f.run('inspect_inscription_recursion', { value: root })).data.results[0];
  assert.equal(f.reads.length, 2); assert.equal(graph.scanLimited, true); assert.equal(graph.unresolvedResources, 2); assert.equal(graph.observedHops, 1);
  f.cacheEntries.clear(); f.settings.maxGraphBytes = Buffer.byteLength(html(a, b));
  const before = f.reads.length;
  const small = (await f.run('inspect_inscription_recursion', { value: root })).data.results[0];
  assert.equal(f.reads.length - before, 1); assert.equal(small.resourcesRead, 1); assert.equal(small.scanLimited, true);
});

test('oversized decompression, unreadable encodings, and failed children stay bounded and private', async t => {
  const f = fixture(t, { maxResourceBytes: 2048 });
  f.bodies.set(root, text(html(a, b, c)));
  f.bodies.set(a, { ...text(''), headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, data: gzipSync('x'.repeat(3000)) });
  f.bodies.set(b, Object.assign(new Error('SYNTHETIC_SECRET_URL_TOKEN'), { code: 'PROVIDER_NETWORK_ERROR' }));
  f.bodies.set(c, { ...text(''), headers: { 'content-type': 'text/plain;charset=not-a-real-encoding' } });
  const result = await f.run('inspect_inscription_recursion', { value: root });
  assert.equal(result.data.results[0].resourcesRead, 1); assert.equal(result.data.results[0].unresolvedResources, 3);
  assert.equal(result.data.results[0].scanLimited, true); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET|not-a-real-encoding/);
});

test('numbers resolve through real Ord entity routing before content inspection', async t => {
  const f = fixture(t); f.bodies.set(root, text(html(a)));
  const result = await f.run('inspect_inscription_recursion', { value: '127364571', source: 'local', service: 'ord-server' });
  assert.equal(f.reads[0].target, 'inscription:127364571'); assert.equal(f.reads[1].path, `/content/${root}`);
  assert.equal(result.cards[0].target, `inscription:${root}`); assert.equal(result.cards[0].title, 'Inscription #127364571');
  for (const provider of f.providerManager.instances.values()) provider.resolve = async target => normalizeEntity(target, { id: 'not-an-id' }, provider);
  await assert.rejects(f.run('inspect_inscription_recursion', { value: '127364571' }), { code: 'AI_TOOL_ARGUMENTS' });
});

test('the finder inspects candidate roots before descendants and ranks measured references, not catalog claims', async t => {
  const f = fixture(t);
  RECURSIVE_CANDIDATES.forEach((item, index) => f.bodies.set(item.id, text(html(...Array.from({ length: index + 1 }, (_, n) => id(n + 100))))));
  const result = await f.run('find_recursive_inscriptions');
  assert.equal(result.cards.length, 3); assert.equal(result.cards[0].target, `inscription:${RECURSIVE_CANDIDATES[2].id}`);
  assert.deepEqual(f.reads.slice(0, 3).map(read => read.path), RECURSIVE_CANDIDATES.map(item => `/content/${item.id}`));
  assert.equal(new Set(f.reads.map(read => read.path)).size, f.reads.length, 'shared dependencies are fetched once');
  assert.ok(result.cards.every(card => card.editorial === false && card.facts.length));
  assert.match(result.data.scope, /Three pinned/); assert.match(recursiveSearchAnswer(result, true), /not proof/);
});

test('unavailable roots never become verified examples; a plain inscription is not declared nonrecursive', async t => {
  const f = fixture(t);
  for (const candidate of RECURSIVE_CANDIDATES) f.bodies.set(candidate.id, Object.assign(new Error('PRIVATE_ERROR'), { code: 'PROVIDER_NETWORK_ERROR' }));
  const failed = await f.run('find_recursive_inscriptions'); assert.deepEqual(failed.cards, []); assert.match(failed.error, /No recursive example was confirmed/);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_ERROR/);
  const plain = await f.run('inspect_inscription_recursion', { value: root });
  assert.equal(plain.cards.length, 1); assert.match(recursiveSearchAnswer(plain, false), /dynamic references may still exist/);
});

test('local-only, service filters and selected network cannot fall through to public or mainnet data', async t => {
  const f = fixture(t);
  for (const p of f.providerManager.instances.values()) if (p.config.local && p.type === 'ord-server') p.config.enabled = false;
  await assert.rejects(f.run('find_recursive_inscriptions', { source: 'local' }), { code: 'AI_ORD_REQUIRED' });
  await assert.rejects(f.run('find_recursive_inscriptions', { service: 'bitcoin-core' }), { code: 'AI_ORD_REQUIRED' });
  f.settings.localOnly = true;
  await assert.rejects(f.run('find_recursive_inscriptions'), { code: 'AI_ORD_REQUIRED' });
  f.settings.network = 'signet';
  assert.match((await f.run('find_recursive_inscriptions')).error, /mainnet-only/); assert.equal(f.reads.length, 0);
});

test('offline cached graphs preserve stale provenance and never reuse public entries for strict local requests', async t => {
  const f = fixture(t); f.bodies.set(root, text(html(a)));
  for (const p of f.providerManager.instances.values()) if (p.config.local && p.type === 'ord-server') p.config.enabled = false;
  await f.run('inspect_inscription_recursion', { value: root });
  assert.ok(f.reads.every(read => !read.local));
  for (const entry of f.cacheEntries.values()) entry.stale = true;
  f.settings.offlineMode = true; const before = f.reads.length;
  const cached = await f.run('inspect_inscription_recursion', { value: root });
  assert.equal(cached.cards[0].cache, 'stale'); assert.equal(cached.data.results[0].cachedResources, 2);
  const local = await f.run('inspect_inscription_recursion', { value: root, source: 'local' });
  assert.equal(local.cards.length, 0); assert.equal(f.reads.length, before);
  f.settings.localOnly = true;
  assert.equal((await f.run('inspect_inscription_recursion', { value: root })).cards.length, 0, 'global local-only also isolates old public cache entries');
  assert.equal(f.reads.length, before);
});

test('cancellation, routing changes and shutdown do not publish stale graphs or leave operations active', async t => {
  const f = fixture(t); let release, captured;
  f.bodies.set(root, options => { captured = options.signal; return new Promise(resolve => { release = resolve; }); });
  const pending = f.run('inspect_inscription_recursion', { value: root });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.providerManager.invalidateRouting(); assert.equal(captured.aborted, true);
  let drained = false; const shutdown = f.providerManager.shutdown().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(text(html(a))); await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' }); await shutdown;
  assert.equal(f.providerManager.activeOperations.size, 0); assert.equal(f.reads.length, 1);
});

test('the scan deadline aborts an in-flight dependency and returns only completed evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); let waiting = false;
  f.bodies.set(root, text(html(a)));
  f.bodies.set(a, options => new Promise((_resolve, reject) => { waiting = true; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }));
  const pending = f.run('inspect_inscription_recursion', { value: root });
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(RECURSION_LIMITS.timeMs + 1);
  const result = await pending;
  assert.equal(result.cards.length, 1); assert.equal(result.data.results[0].scanLimited, true); assert.equal(result.data.results[0].resourcesRead, 1);
  assert.equal(f.providerManager.activeOperations.size, 0); assert.equal(f.reads.length, 2);
});

test('explicit user cancellation rejects instead of relabeling a stopped scan as complete', async t => {
  const f = fixture(t); let waiting = false;
  f.bodies.set(root, options => new Promise((_resolve, reject) => { waiting = true; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }));
  const pending = f.run('inspect_inscription_recursion', { value: root });
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  const reason = Object.assign(new Error('Stopped'), { code: 'NAVIGATION_CANCELLED' }); f.controller.abort(reason);
  await assert.rejects(pending, { code: 'NAVIGATION_CANCELLED' }); assert.equal(f.providerManager.activeOperations.size, 0);
});

test('closed recursion tools reject arbitrary URLs, fields, paths, limits and services before transport', async t => {
  const f = fixture(t);
  for (const args of [{ value: 'https://evil.example/content/' + root }, { value: root, url: 'http://127.0.0.1/private' }, { value: root, depth: 999 }, { value: root, service: 'shell' }, { value: root, source: 'internet' }])
    await assert.rejects(f.run('inspect_inscription_recursion', args));
  await assert.rejects(f.run('find_recursive_inscriptions', { candidates: [root] }));
  assert.equal(f.reads.length, 0);
});

test('action-first intent handles direct requests/IDs/numbers and defers conceptual, negative or ambiguous requests', () => {
  for (const prompt of ['Find a highly recursive inscription', 'Show me recursive art', 'I want a recursive ordinal to explore', 'Search for recursive inscriptions'])
    assert.equal(recursiveSearchIntent(prompt)?.name, 'find_recursive_inscriptions', prompt);
  for (const prompt of ['What is a recursive inscription?', 'Explain how to find recursive inscriptions', 'Do not search for recursive art', "Don't query recursive inscriptions", `Inspect recursive inscriptions ${root} and ${a}`, 'Find inscriptions', 'What is recursion?'])
    assert.equal(recursiveSearchIntent(prompt), null, prompt);
  assert.equal(recursiveSearchIntent(`Check recursion in inscription:${root}`).args.value, root);
  assert.equal(recursiveSearchIntent('Inspect recursion in inscription 127364571').args.value, '127364571');
  assert.equal(recursiveSearchIntent('Find recursive inscriptions without public sources').args.source, 'local');
  assert.equal(recursiveSearchIntent('Find recursive inscriptions using my Bitcoin Core').args.service, 'bitcoin-core');
  assert.equal(recursiveSearchIntent('Find recursive inscriptions offline').cacheOnly, true);
});

test('a model that would provide the reported false tutorial cannot skip a direct recursive search', async t => {
  const f = fixture(t);
  for (const candidate of RECURSIVE_CANDIDATES) f.bodies.set(candidate.id, text(html(a, b)));
  const result = await f.chat('Find a highly recursive inscription');
  assert.equal(result.cards.length, 3); assert.equal(result.answerOrigin, 'browser'); assert.equal(result.activity[0].state, 'complete');
  assert.match(result.answer, /2 distinct content references/); assert.doesNotMatch(result.answer, /at most one parent|Pick an inscription yourself/);
  assert.ok(f.modelRequests.every(request => request.catalog), 'direct searches need no model-generated facts or endpoint planning');
  assert.equal(f.providerManager.activeOperations.size, 0);
});

test('action-first workflow still requires enabled lookups and respects Core, local and offline restrictions', async t => {
  const f = fixture(t);
  const off = await f.chat('Find a highly recursive inscription', { allowLookups: false });
  assert.equal(f.reads.length, 0); assert.equal(off.answerOrigin, 'model');
  const body = f.modelRequests.find(request => request.messages);
  assert.equal(body.tools, undefined); assert.match(body.messages[0].content, /CAN have multiple parents/); assert.match(body.messages[0].content, /NUMBER/);
  const core = await f.chat('Find a highly recursive inscription using Bitcoin Core');
  assert.match(core.answer, /Core does not expose an Ord/); assert.equal(core.cards.length, 0); assert.equal(f.reads.length, 0);
  const offline = await f.chat('Find a highly recursive inscription offline');
  assert.match(offline.answer, /Offline mode is not enabled/); assert.equal(f.reads.length, 0);
  for (const p of f.providerManager.instances.values()) if (p.config.local && p.type === 'ord-server') p.config.enabled = false;
  const local = await f.chat('Find a highly recursive inscription using local sources only');
  assert.equal(local.cards.length, 0); assert.equal(local.activity[0].state, 'unavailable'); assert.equal(f.reads.length, 0);
});

test('model-led follow-ups can invoke the recursion tool with validated arguments and receive bounded evidence', async t => {
  const f = fixture(t); f.bodies.set(root, text(html(a, b))); const messages = [];
  f.ai.request = async (_url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (body) messages.push(body);
    const response = !body ? { data: [{ id: 'test-chat', type: 'llm' }] } : messages.length === 1
      ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'untrusted', type: 'function', function: { name: 'inspect_inscription_recursion', arguments: JSON.stringify({ value: root, source: 'local' }) } }] } }] }
      : { choices: [{ message: { role: 'assistant', content: 'Every inscription has at most one parent. This is the longest chain and above the network average.' } }] };
    return { ok: true, status: 200, data: Buffer.from(JSON.stringify(response)) };
  };
  const result = await f.chat(`Explain the recursion in inscription ${root}`);
  assert.equal(result.cards[0].facts[0].value, '2'); assert.equal(result.activity[0].label, 'Tracing inscription content references');
  const received = JSON.parse(messages[1].messages.find(message => message.role === 'tool').content);
  assert.equal(received.data.results[0].contentReferences, 2); assert.match(received.note, /not parent\/child/);
  assert.match(received.data.metricDefinitions.contentReferences, /Excludes.*Ord data endpoints/);
  assert.match(received.data.metricDefinitions.observedHops, /NOT a longest path/);
  assert.match(received.data.scope, /No other examples/);
  assert.ok(f.reads.every(read => read.local)); assert.equal(result.answerOrigin, 'browser'); assert.equal(result.inferenceResponded, true);
  assert.match(result.answer, /2 distinct content references/); assert.doesNotMatch(result.answer, /at most one parent|longest chain|network average/);
});

test('model-led comparisons retain evidence from multiple scans instead of substituting invented prose', async t => {
  const f = fixture(t); f.bodies.set(root, text(html(a))); f.bodies.set(b, text(html(a, c))); let rounds = 0;
  f.ai.request = async (_url, options) => {
    const response = !options.body ? { data: [{ id: 'test-chat', type: 'llm' }] } : ++rounds <= 2
      ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'untrusted', type: 'function', function: { name: 'inspect_inscription_recursion', arguments: JSON.stringify({ value: rounds === 1 ? root : b, source: 'local' }) } }] } }] }
      : { choices: [{ message: { role: 'assistant', content: 'INVENTED_COMPARISON' } }] };
    return { ok: true, status: 200, data: Buffer.from(JSON.stringify(response)) };
  };
  const result = await f.chat(`Compare recursive inscriptions ${root} and ${b}`);
  assert.equal(result.cards.length, 2); assert.match(result.answer, /1 distinct content references/); assert.match(result.answer, /2 distinct content references/);
  assert.doesNotMatch(result.answer, /INVENTED/); assert.equal(result.answerOrigin, 'browser');
});
