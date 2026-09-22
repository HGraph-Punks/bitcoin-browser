import { AppError } from '../shared/errors.js';
import { parseNavigationInput, targetCapability } from '../shared/navigation.js';
import { aiResultTarget } from '../shared/local-ai.js';
import { PROVIDER_CAPABILITIES, providerTypeSupportsCapability } from '../shared/constants.js';
import { aiCollectorDetails } from './ai-collector-data.js';

export const AI_DATA_PAGE_SIZE = 12;
export const AI_SOURCE_CHOICES = ['auto', 'local'];
export const AI_SERVICE_CHOICES = ['bitcoin-core', 'ord-server', 'mempool'];
const unavailable = () => new AppError('AI_DATA_UNAVAILABLE', 'The configured sources cannot provide this data.', { status: 503 });

// Explicit field projections, never a recursive dump of provider/config data.
export function dataScalar(value, max = 180) {
  if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value === 'boolean') return value;
  return null;
}
function fields(raw, names) {
  const out = {};
  for (const name of names) { const value = dataScalar(raw?.[name]); if (value !== null) out[name] = value; }
  return out;
}
export function bitcoinToSats(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
  // Core JSON amounts are BTC. Decimal expansion avoids floating point sums
  // and never labels an explorer's satoshi integer as a BTC amount.
  const text = typeof value === 'number' ? value.toFixed(8) : value;
  if (typeof value === 'number' && Number(text) !== value) return null;
  const match = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) return null;
  const sats = BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? '').padEnd(8, '0'));
  return sats <= 2_100_000_000_000_000n ? sats.toString() : null;
}
const satAmount = (value, core) => core ? bitcoinToSats(value) :
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^\d{1,16}$/.test(value)) ? String(value) : null;

export function sourceOptions(source, service) {
  if (source !== undefined && !AI_SOURCE_CHOICES.includes(source)) throw new AppError('AI_TOOL_ARGUMENTS', 'Choose automatic or local Bitcoin sources.', { status: 400 });
  if (service !== undefined && !AI_SERVICE_CHOICES.includes(service)) throw new AppError('AI_TOOL_ARGUMENTS', 'Choose a configured Core, Ord or explorer service.', { status: 400 });
  return { ...(source === 'local' ? { localOnly: true } : {}), ...(service === undefined ? {} : { providerType: service }) };
}
export function ensureLocalSnapshot(resolved, providerManager, target, source, service) {
  if ((source !== 'local' && service === undefined) || !resolved.cache) return;
  // Entity cache is shared with normal browsing. A strict local request must
  // not quietly receive an old public-provider snapshot while offline.
  const eligible = providerManager.candidates(targetCapability(target), sourceOptions(source, service));
  if (source === 'local' && resolved.cacheSource?.local !== true) throw unavailable();
  if (service !== undefined && resolved.cacheSource?.type !== service) throw unavailable();
  if (!eligible.some(provider => provider.id === resolved.entity?.source?.id)) throw unavailable();
}

export function bitcoinSources(providerManager, settings, questionPolicy) {
  const all = providerManager.candidates(null, { ...(questionPolicy?.localOnly ? { localOnly: true } : {}), ...(questionPolicy?.coreOnly ? { providerType: 'bitcoin-core' } : {}) });
  const sources = all.slice(0, 20).map(provider => {
    const health = providerManager.healthState.get(provider.id);
    return {
      name: dataScalar(provider.name, 80), type: provider.type, local: provider.config.local === true,
      capabilities: PROVIDER_CAPABILITIES.filter(capability => providerTypeSupportsCapability(provider.type, capability) && provider.supports(capability)),
      lastCheck: health ? fields(health, ['ok', 'height', 'headers', 'verificationProgress', 'initialBlockDownload', 'pruned', 'checkedAt', 'lastSuccessAt']) : null
    };
  });
  return { cards: [], data: { network: settings.network, offline: settings.offlineMode === true, localOnly: settings.localOnly === true || questionPolicy?.localOnly === true, sources, totalSources: all.length },
    note: 'These are enabled, eligible browser sources, not a live health check. Automatic routing follows browser preferences; source=local forbids public fallback. Use service=bitcoin-core for Core sync/decoded transactions, ord-server for Ord indexed assets, or mempool for explorer data; this forbids fallback to a different service type. Core does not provide a general address, inscription, or Rune index. Pruning, synchronization, txindex and Ord indexes can limit available history. Disabled or unconfigured services are not started by the AI.' };
}

function pageOf(raw, offset, project) {
  if (!Array.isArray(raw)) return null;
  return { items: raw.slice(offset, offset + AI_DATA_PAGE_SIZE).map(project), offset, total: raw.length,
    nextOffset: offset + AI_DATA_PAGE_SIZE < raw.length ? offset + AI_DATA_PAGE_SIZE : null };
}
function publicTarget(kind, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try { const target = parseNavigationInput(`${kind}:${value}`); return aiResultTarget(target.canonical) ? target.canonical : null; } catch { return null; }
}
function txOutput(raw, core) {
  return { ...fields(raw, ['n', 'scriptpubkey_type']), valueSats: satAmount(raw?.value, core),
    address: dataScalar(raw?.scriptpubkey_address ?? raw?.scriptPubKey?.address),
    scriptType: dataScalar(raw?.scriptPubKey?.type) };
}
function tokenBalance(pair) {
  const [name, entry] = Array.isArray(pair) ? pair : [null, null];
  return { name: dataScalar(name, 100), ...(entry && typeof entry === 'object'
    ? fields(entry, ['amount', 'balance', 'divisibility', 'symbol']) : { amount: dataScalar(entry) }) };
}
function networkFacts(data) {
  const labels = { height: 'Indexed height', headers: 'Headers', verificationProgress: 'Verification progress', initialBlockDownload: 'Still syncing', pruned: 'Compact storage', chain: 'Core network',
    loaded: 'Mempool loaded', size: 'Transactions', count: 'Transactions', bytes: 'Virtual size (vB)', vsize: 'Virtual size (vB)', usage: 'Memory (bytes)', maxmempool: 'Memory limit (bytes)',
    unbroadcastcount: 'Not yet broadcast', fullrbf: 'Full RBF', minimumFeeSatVb: 'Minimum fee (sat/vB)', totalFeesSats: 'Total fees (sats)', total_fee: 'Total fees (sats)',
    targetBlocks: 'Target blocks', estimatedForBlocks: 'Estimated for blocks', conservativeSatVb: 'Conservative fee (sat/vB)', fastestFee: 'Fastest (sat/vB)', halfHourFee: 'About 30 min (sat/vB)',
    hourFee: 'About 1 hour (sat/vB)', economyFee: 'Economy (sat/vB)', minimumFee: 'Minimum (sat/vB)' };
  return Object.entries(data).filter(([key, value]) => Object.hasOwn(labels, key) && value !== null).slice(0, 12).map(([key, value]) => ({
    label: labels[key], value: key === 'verificationProgress' && typeof value === 'number' ? `${(value * 100).toFixed(2)}%`
      : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value)
  }));
}

export function bitcoinEntityDetails(entity, offset = 0) {
  const raw = entity.data, core = entity.source?.type === 'bitcoin-core';
  const details = { amountUnit: 'satoshis unless a Rune amount explicitly uses base units', missingFields: 'Unknown or unsupported; not zero.' };
  const summary = fields(entity.summary, ['id', 'number', 'hash', 'height', 'timestamp', 'sat', 'name', 'rarity', 'contentType', 'contentLength', 'address', 'output']);
  details.summary = summary;
  switch (entity.type) {
    case 'block':
      Object.assign(details, fields(raw, ['hash', 'height', 'time', 'timestamp', 'mediantime', 'confirmations', 'nTx', 'tx_count', 'transaction_count', 'difficulty', 'bits', 'nonce', 'version', 'size', 'weight', 'total_size', 'total_weight', 'previousblockhash', 'previous_block', 'nextblockhash', 'next_block', 'feerate_percentiles']));
      details.transactions = pageOf(raw?.tx, offset, tx => ({ target: publicTarget('transaction', typeof tx === 'string' ? tx : tx?.txid) }));
      break;
    case 'transaction':
      Object.assign(details, fields(raw, ['txid', 'hash', 'version', 'locktime', 'size', 'vsize', 'weight', 'confirmations', 'blockhash', 'blocktime', 'time']));
      details.status = fields(raw?.status, ['confirmed', 'block_height', 'block_hash', 'block_time']);
      details.feeSats = satAmount(raw?.fee, core);
      details.inputs = pageOf(raw?.vin, offset, input => ({ ...fields(input, ['txid', 'vout', 'sequence', 'is_coinbase']),
        coinbase: typeof input?.coinbase === 'string' || input?.is_coinbase === true,
        previousOutput: txOutput(input?.prevout, false), target: publicTarget('transaction', input?.txid) }));
      details.outputs = pageOf(raw?.vout, offset, (output, index) => ({ ...txOutput(output, core),
        target: publicTarget('output', `${raw.txid ?? entity.id}:${output?.n ?? offset + index}`) }));
      if (typeof raw === 'string') details.note = 'This source supplies raw transaction bytes only. Use a configured Core or explorer source for decoded inputs and outputs.';
      break;
    case 'address':
      details.confirmed = fields(raw?.chain_stats ?? raw, ['funded_txo_count', 'funded_txo_sum', 'spent_txo_count', 'spent_txo_sum', 'tx_count']);
      details.unconfirmed = fields(raw?.mempool_stats, ['funded_txo_count', 'funded_txo_sum', 'spent_txo_count', 'spent_txo_sum', 'tx_count']);
      details.outputs = pageOf(raw?.outputs, offset, value => ({ target: publicTarget('output', value) }));
      details.inscriptions = pageOf(raw?.inscriptions, offset, value => ({ target: publicTarget('inscription', value) }));
      details.runes = pageOf(Array.isArray(raw?.runes) ? raw.runes : Object.entries(raw?.runes ?? {}), offset, tokenBalance);
      break;
    case 'output':
      Object.assign(details, txOutput(raw, core), fields(raw, ['spent', 'confirmations', 'coinbase', 'indexed', 'satpoint']));
      details.inscriptions = pageOf(raw?.inscriptions, offset, id => ({ target: publicTarget('inscription', id) }));
      details.runes = pageOf(Array.isArray(raw?.runes) ? raw.runes : Object.entries(raw?.runes ?? {}), offset, tokenBalance);
      details.satRanges = pageOf(raw?.sat_ranges, offset, range => Array.isArray(range) ? range.slice(0, 2).map(value => dataScalar(value)) : null);
      break;
    case 'inscription': case 'inscription-number':
      Object.assign(details, fields(raw, ['id', 'number', 'height', 'timestamp', 'fee', 'value', 'sat', 'satpoint', 'output', 'address', 'delegate', 'content_type', 'content_length']));
      details.charms = pageOf(raw?.charms, offset, value => dataScalar(value, 60));
      details.parents = pageOf(raw?.parents, offset, id => ({ target: publicTarget('inscription', id) }));
      details.children = pageOf(raw?.children, offset, id => ({ target: publicTarget('inscription', id) }));
      break;
    case 'rune':
      Object.assign(details, fields(raw, ['name', 'id', 'number', 'symbol', 'divisibility', 'supply', 'outstanding', 'premine', 'burned', 'mints', 'mintable', 'etching', 'block', 'timestamp', 'turbo', 'parent']));
      details.amountUnit = 'Use collector.tokens and card facts: already formatted token amounts, NOT BTC or satoshis. Do not divide again. Raw integer amounts below are source base units, not display amounts.';
      details.terms = { ...fields(raw?.terms, ['amount', 'cap']),
        height: Array.isArray(raw?.terms?.height) ? raw.terms.height.slice(0, 2).map(value => dataScalar(value)) : null,
        offset: Array.isArray(raw?.terms?.offset) ? raw.terms.offset.slice(0, 2).map(value => dataScalar(value)) : null };
      break;
    default:
      Object.assign(details, fields(raw, ['number', 'sat', 'name', 'decimal', 'degree', 'percentile', 'rarity', 'epoch', 'cycle', 'period', 'block', 'offset', 'timestamp', 'satpoint']));
      details.inscriptions = pageOf(raw?.inscriptions ?? raw?.ids, offset, id => ({ target: publicTarget('inscription', id) }));
  }
  details.related = pageOf(entity.links, offset, link => ({ relation: dataScalar(link?.rel, 40), target: publicTarget(link?.kind, link?.value) }));
  const collector = aiCollectorDetails(entity);
  if (collector) details.collector = collector;
  return details;
}

export async function bitcoinNetworkData(query, source, blocks, { providerManager, settings, signal }, service) {
  if (settings.offlineMode) throw unavailable();
  const options = { ...sourceOptions(source, service), network: settings.network };
  const candidates = providerManager.candidates(query === 'chain' ? 'block' : 'transaction', options)
    .filter(provider => query === 'chain' || ['bitcoin-core', 'mempool'].includes(provider.type)).slice(0, 3);
  const operation = providerManager.beginOperation(signal);
  try {
    for (const provider of candidates) {
      providerManager.assertOperationCurrent(operation);
      const transport = { signal: operation.signal, timeoutMs: 10_000, maxBytes: 128 * 1024 };
      try {
        let data;
        if (query === 'chain') {
          const health = await provider.health(transport);
          providerManager.assertOperationCurrent(operation);
          if (!health.ok || !Number.isSafeInteger(health.height) || health.height < 0) throw unavailable();
          const chains = { mainnet: 'main', testnet: 'test', signet: 'signet', regtest: 'regtest' };
          if (provider.type === 'bitcoin-core' && health.chain !== chains[settings.network]) throw unavailable();
          data = fields(health, ['height', 'headers', 'verificationProgress', 'initialBlockDownload', 'pruned', 'chain']);
        } else if (provider.type === 'bitcoin-core') {
          // Closed literal methods/parameters. Model input never selects RPC.
          const raw = query === 'mempool' ? (await provider.rpc('getmempoolinfo', [], transport)).result
            : (await provider.rpc('estimatesmartfee', [blocks, 'CONSERVATIVE'], transport)).result;
          providerManager.assertOperationCurrent(operation);
          if (query === 'mempool') {
            if (!Number.isSafeInteger(raw?.size) || raw.size < 0) throw unavailable();
            data = fields(raw, ['loaded', 'size', 'bytes', 'usage', 'maxmempool', 'unbroadcastcount', 'fullrbf']);
            data.minimumFeeSatVb = bitcoinToSats(raw?.mempoolminfee) === null ? null : Number(bitcoinToSats(raw.mempoolminfee)) / 1000;
            data.totalFeesSats = bitcoinToSats(raw?.total_fee);
          } else {
            data = { targetBlocks: blocks, estimatedForBlocks: dataScalar(raw?.blocks),
              conservativeSatVb: bitcoinToSats(raw?.feerate) === null ? null : Number(bitcoinToSats(raw.feerate)) / 1000 };
          }
        } else if (query === 'fees') {
          data = fields(await provider.recommendedFees(transport), ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee']);
          for (const key of Object.keys(data)) if (typeof data[key] !== 'number' || data[key] < 0) delete data[key];
          if (!Object.keys(data).length) throw unavailable();
          data.unit = 'sat/vB';
        } else {
          const response = await provider.request('/mempool', transport);
          if (!response.ok || response.data.length > transport.maxBytes) throw unavailable();
          const raw = JSON.parse(response.data.toString('utf8'));
          if (!Number.isSafeInteger(raw?.count) || raw.count < 0) throw unavailable();
          data = fields(raw, ['count', 'vsize', 'total_fee']);
          data.totalFeeUnit = 'satoshis';
        }
        providerManager.assertOperationCurrent(operation);
        const sourceName = dataScalar(provider.name, 80) || 'Configured Bitcoin source';
        const fetchedAt = new Date().toISOString();
        return { cards: [{ key: `network:${query}:${provider.type}:${provider.config.local === true}`, kind: 'network', title: { chain: 'Chain & node status', mempool: 'Mempool snapshot', fees: 'Fee estimates' }[query],
          network: settings.network, source: sourceName, fetchedAt, editorial: false,
          facts: networkFacts(data) }],
        data: { ...data, source: sourceName, network: settings.network, local: provider.config.local === true, fetchedAt },
        note: query === 'fees' ? 'Fees are estimates, not a payment recommendation or a confirmation guarantee. A null estimate means the source has insufficient data.'
          : 'A source snapshot, not network consensus or a live feed. A syncing node may be behind the network.' };
      } catch {
        providerManager.assertOperationCurrent(operation);
      }
    }
    throw unavailable();
  } finally { providerManager.finishOperation(operation); }
}
