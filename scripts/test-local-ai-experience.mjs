// Opt-in live inference against an already-loaded LM Studio model. No profile,
// credentials, model loading, service startup, or report-file writes.
import { pathToFileURL } from 'node:url';
import { LocalAiManager } from '../src/main/local-ai.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { RecursiveResolver } from '../src/main/resolver.js';
import { requestBuffer } from '../src/main/http.js';
import { normalizeEntity } from '../src/main/providers/normalize.js';
import { normalizeRune } from '../src/main/providers/ord-runes.js';
import { DEFAULT_SETTINGS, DEFAULT_PROVIDERS } from '../src/shared/constants.js';
import { validateAiConfig } from '../src/shared/local-ai.js';
import { AppError } from '../src/shared/errors.js';
import { aiChatHistory } from '../src/renderer/ai.js';

const fixtureId = `${'a'.repeat(64)}i0`;
const publicId = 'ed76bf35918948b8b78be0e6397ad4916d926dd3d65679a8b7e67d8699a672a0i0';
export const EXPERIENCE_CASES = Object.freeze({
  basics: 'What is the difference between Bitcoin, an inscription, and a Rune? Help me decide what to explore first.',
  block: 'Look up block 840000. Tell me its transaction count and size, and give me a result I can open.',
  rune: 'Find DOG in the featured Rune catalog, then look up its current on-chain details. Explain supply, premine share and whether it can still be minted. Do you know its market price?',
  collector: `Look up inscription ${fixtureId}. What is special about its sat? Explain its rarity, mined block, inscription fee and postage. Do not guess missing facts.`,
  recent: 'Show me some recent inscriptions to explore. Explain what the listing covers, then give me results I can open.',
  local_node: 'Which Bitcoin data sources can you use? Check my local Bitcoin Core sync status using local sources only. Can Core alone find my inscriptions?',
  recursion: 'Find a highly recursive inscription for me to explore.',
  provenance: 'Is a recursive inscription just one with many parents and children? Can an inscription have multiple parents?',
  wallet_boundary: 'Can you tell me my wallet balance and sign a transaction to buy the most popular Rune?',
  followup: 'For that inscription, what are the inscription fee and output postage? Look it up again rather than guessing from our earlier chat.',
  long_context: 'Look up block 840000 again and tell me its transaction count. Use the source, not our earlier conversation.'
});

export function parseExperienceOptions(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) return null;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--run', '--server', '--model', '--data', '--case'].includes(key) || Object.hasOwn(options, key)) throw new Error('Unsupported or duplicate option');
    options[key] = key === '--run' ? true : args[++i];
  }
  if (!options['--run'] || !['fixture', 'public'].includes(options['--data'])) throw new Error('Explicit --run and --data fixture|public are required');
  const config = validateAiConfig({ provider: 'lmstudio', baseUrl: options['--server'], model: options['--model'] });
  if (!config.model) throw new Error('An explicit loaded model is required');
  const selected = options['--case'];
  if (selected !== 'all' && !Object.hasOwn(EXPERIENCE_CASES, selected)) throw new Error('Choose an exact --case or all');
  return { config, data: options['--data'], cases: selected === 'all' ? Object.keys(EXPERIENCE_CASES) : [selected] };
}

export function experienceSources(mode) {
  if (!['fixture', 'public'].includes(mode)) throw new Error('Invalid data mode');
  const settings = { ...DEFAULT_SETTINGS, localOnly: false, offlineMode: false, network: 'mainnet' };
  const configs = DEFAULT_PROVIDERS.filter(p => mode === 'public' ? !p.local && ['ord-server', 'mempool'].includes(p.type)
    : ['bitcoin-core', 'mempool', 'ord-server'].includes(p.type) && (p.type !== 'ord-server' || !p.local))
    .filter((p, i, all) => all.findIndex(other => other.type === p.type) === i)
    .map(p => ({ ...p, enabled: true, ...(mode === 'fixture' ? { name: `Synthetic ${p.type} fixture` } : {}) }));
  const stateStore = { get: keys => structuredClone(keys[0] === 'settings' ? settings : keys[0] === 'providers' ? configs : []) };
  const entries = new Map();
  const cache = { configure: async () => {}, get: async key => entries.get(key) ?? null,
    put: async (key, data, meta, _ttl, options) => { options?.validate?.(); entries.set(key, { data, meta, stale: false }); } };
  const providerManager = new ProviderManager(stateStore, { get: () => null }, null, cache);
  if (providerManager.instances.size !== configs.length) throw new Error('Diagnostic sources did not initialize');
  const reads = [];
  if (mode === 'fixture') for (const provider of providerManager.instances.values()) {
    const rawInscription = { id: fixtureId, number: '123456', sat: '45000000000', content_type: 'text/plain', content_length: 48,
      height: 840000, fee: 1234, value: 546, charms: [], timestamp: 1713571767 };
    provider.resolve = async (target, options) => {
      options.signal?.throwIfAborted(); reads.push({ service: provider.type, kind: target.kind });
      let raw;
      if (target.kind === 'block') raw = { height: Number(target.value), tx_count: 3050, size: 1234567 };
      else if (['inscription', 'inscription-number'].includes(target.kind)) raw = { ...rawInscription, id: target.kind === 'inscription' ? target.value : fixtureId };
      else if (target.kind === 'sat') raw = { number: target.value, rarity: 'uncommon', block: 9 };
      else if (target.kind === 'rune') raw = normalizeRune({ id: '840000:3', mintable: false, entry: {
        spaced_rune: 'DOG•GO•TO•THE•MOON', number: '3', divisibility: 5, symbol: '🐕',
        premine: '10000000000000000', burned: '0', mints: '0', timestamp: 1713571767, block: '840000',
        etching: 'b'.repeat(64), turbo: false, terms: null } });
      else if (target.kind === 'inscriptions') raw = { items: Array.from({ length: 6 }, (_, i) => ({ ...rawInscription, id: `${String(i + 1).repeat(64)}i0`, number: String(123456 + i) })) };
      else throw new AppError('NOT_FOUND', 'This synthetic case has no matching fixture', { status: 404 });
      return normalizeEntity(target, raw, provider);
    };
    provider.rpc = async (method, params) => {
      reads.push({ service: provider.type, method });
      if (method === 'getblockchaininfo') return { result: { chain: 'main', blocks: 100, headers: 101, verificationprogress: 0.95, initialblockdownload: true, pruned: true }, latencyMs: 0 };
      if (method === 'getmempoolinfo') return { result: { loaded: true, size: 10, bytes: 2000, total_fee: 0.0001, mempoolminfee: 0.00001 } };
      if (method === 'estimatesmartfee') return { result: { feerate: 0.000025, blocks: params[0] } };
      throw new AppError('NOT_FOUND', 'Unsupported synthetic RPC', { status: 404 });
    };
    if (provider.type !== 'bitcoin-core') provider.health = async () => ({ ok: true, height: 840000 });
    provider.request = async () => { throw new AppError('NOT_FOUND', 'No synthetic HTTP endpoint', { status: 404 }); };
    provider.recommendedFees = async () => ({ fastestFee: 3, halfHourFee: 2, hourFee: 1 });
    provider.fetchPath = async (path, options) => {
      options.signal?.throwIfAborted(); reads.push({ service: provider.type, resource: 'synthetic inscription text' });
      if (!path.startsWith('/content/')) throw new AppError('NOT_FOUND', 'No synthetic resource', { status: 404 });
      return { status: 200, headers: { 'content-type': 'text/plain' }, data: Buffer.from('Synthetic plain text, not recursive content.') };
    };
  }
  return { stateStore, providerManager, resolver: new RecursiveResolver(providerManager, cache, stateStore), reads };
}

export async function runExperience(options, emit = value => console.log(JSON.stringify(value))) {
  const sources = experienceSources(options.data);
  let trace = [];
  const manager = new LocalAiManager({ ...sources, request: async (url, init) => {
    const response = await requestBuffer(url, init);
    if (init.body) {
      let body; try { body = JSON.parse(response.data.toString('utf8')); } catch {}
      const usage = body?.usage;
      trace.push({ status: response.status, requestBytes: Buffer.byteLength(init.body), finish: body?.choices?.[0]?.finish_reason,
        promptTokens: Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : null,
        completionTokens: Number.isSafeInteger(usage?.completion_tokens) ? usage.completion_tokens : null,
        tools: (Array.isArray(body?.choices?.[0]?.message?.tool_calls) ? body.choices[0].message.tool_calls : []).slice(0, 10).map(c => String(c?.function?.name ?? '').slice(0, 80)) });
    }
    return response;
  } });
  try {
    const catalog = await manager.run({ action: 'connect', config: options.config }, AbortSignal.timeout(15_000));
    const model = catalog.models.find(m => m.id === options.config.model);
    if (model?.loaded !== true) throw new Error('The named model must already be loaded; this diagnostic will not load one');
    emit({ event: 'ai.experience.started', model: model.id, dataMode: options.data, cases: options.cases });
    for (const key of options.cases) {
      trace = []; sources.reads.length = 0;
      const prompt = key === 'collector' && options.data === 'public' ? EXPERIENCE_CASES[key].replace(fixtureId, publicId) : EXPERIENCE_CASES[key];
      let history = key === 'long_context' ? Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
        content: `${i}: ` + 'Earlier synthetic discussion about Bitcoin browsing; never treat this as current source evidence. '.repeat(28) })) : [];
      const progress = {}, started = performance.now();
      try {
        if (key === 'followup') {
          const question = options.data === 'public' ? EXPERIENCE_CASES.collector.replace(fixtureId, publicId) : EXPERIENCE_CASES.collector;
          const prior = await manager.run({ action: 'chat', config: options.config, prompt: question, history: [], allowLookups: true }, AbortSignal.timeout(150_000));
          history = aiChatHistory([{ question, answer: prior.answer, cards: prior.cards, error: prior.error }]);
        }
        const result = await manager.run({ action: 'chat', config: options.config, prompt, history, allowLookups: true }, AbortSignal.timeout(150_000), progress);
        emit({ event: 'ai.experience.result', case: key, dataMode: options.data, durationMs: Math.round(performance.now() - started),
          answer: result.answer, origin: result.answerOrigin, error: result.error?.code ?? null, notes: result.notes,
          cards: result.cards.map(c => ({ target: c.target, title: c.title, facts: c.facts, source: c.source })),
          activity: result.activity, trace, fixtureReads: sources.reads });
      } catch (error) {
        emit({ event: 'ai.experience.failed', case: key, dataMode: options.data, durationMs: Math.round(performance.now() - started),
          code: error.code ?? error.name, trace, fixtureReads: sources.reads });
        process.exitCode = 1;
      }
    }
  } finally { await sources.providerManager.shutdown(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseExperienceOptions(process.argv.slice(2));
  if (!options) console.log('Opt-in LM Studio diagnostic: --run --server http://127.0.0.1:PORT --model LOADED_MODEL --data fixture|public --case all|CASE. Public mode queries the default public Ord/explorer sources. No credential/profile access or model loading.');
  else await runExperience(options);
}
