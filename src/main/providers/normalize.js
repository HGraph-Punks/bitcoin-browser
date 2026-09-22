import { sanitizeJson } from '../../shared/validation.js';

function stringOrNull(value) {
  return value === null || value === undefined ? null : String(value);
}

function linksFor(target, raw) {
  const links = [];
  const add = (rel, kind, value, title) => {
    if (value === null || value === undefined || value === '') return;
    links.push({ rel, kind, value: String(value), title });
  };
  if (target.kind === 'inscription' || target.kind === 'inscription-number') {
    add('content', 'content', raw.id ?? target.value, 'Open inscription content');
    add('sat', 'sat', raw.sat, 'Open sat');
    add('output', 'output', raw.output, 'Open current output');
    add('address', 'address', raw.address, 'Open owner address');
    add('block', 'block', raw.height, 'Open genesis block');
    add('delegate', 'inscription', raw.delegate, 'Open delegate');
  } else if (target.kind === 'block') {
    add('previous', 'block', raw.previous_block ?? raw.previousblockhash, 'Previous block');
    add('next', 'block', raw.next_block ?? raw.nextblockhash, 'Next block');
  } else if (target.kind === 'output') {
    for (const id of raw.inscriptions ?? []) add('inscription', 'inscription', id, `Inscription ${id}`);
  }
  return links;
}

function summaryFor(target, raw) {
  switch (target.kind) {
    case 'inscription':
    case 'inscription-number':
      return {
        id: stringOrNull(raw.id ?? (target.kind === 'inscription' ? target.value : null)),
        number: stringOrNull(raw.number ?? (target.kind === 'inscription-number' ? target.value : null)),
        contentType: raw.content_type ?? raw.contentType ?? null,
        contentLength: raw.content_length ?? raw.contentLength ?? null,
        sat: stringOrNull(raw.sat),
        address: stringOrNull(raw.address),
        output: stringOrNull(raw.output),
        height: raw.height ?? null,
        timestamp: raw.timestamp ?? null,
        charms: Array.isArray(raw.charms) ? raw.charms : []
      };
    case 'block':
      return {
        hash: raw.hash ?? raw.id ?? (String(target.value).length === 64 ? target.value : null),
        height: raw.height ?? (/^\d+$/.test(String(target.value)) ? Number(target.value) : null),
        timestamp: raw.timestamp ?? raw.time ?? null,
        transactionCount: raw.transaction_count ?? raw.tx_count ?? raw.nTx ?? null,
        size: raw.total_size ?? raw.size ?? null,
        weight: raw.total_weight ?? raw.weight ?? null
      };
    case 'transaction':
      return {
        txid: raw.txid ?? target.value,
        status: raw.status ?? null,
        fee: raw.fee ?? null,
        weight: raw.weight ?? null,
        size: raw.size ?? null,
        hex: typeof raw === 'string' ? raw : raw.hex ?? null
      };
    case 'address':
      return {
        address: target.value,
        funded: raw.chain_stats?.funded_txo_sum ?? raw.funded_txo_sum ?? null,
        spent: raw.chain_stats?.spent_txo_sum ?? raw.spent_txo_sum ?? null,
        transactionCount: raw.chain_stats?.tx_count ?? raw.tx_count ?? null
      };
    case 'output':
      return {
        outpoint: target.value,
        value: raw.value ?? null,
        inscriptions: Array.isArray(raw.inscriptions) ? raw.inscriptions.length : null,
        runes: raw.runes ? Object.keys(raw.runes).length : null,
        spent: raw.spent ?? null
      };
    case 'sat':
    case 'sat-name':
    case 'sat-degree':
    case 'satpoint':
      return {
        sat: stringOrNull(raw.number ?? raw.sat ?? target.value),
        name: stringOrNull(raw.name),
        rarity: stringOrNull(raw.rarity),
        inscriptions: Array.isArray(raw.inscriptions ?? raw.ids) ? (raw.inscriptions ?? raw.ids).length : null
      };
    case 'rune':
      return { rune: raw.name ?? target.value, id: raw.id ?? null, symbol: raw.symbol ?? null, divisibility: raw.divisibility ?? null,
        supply: raw.supply ?? null, outstanding: raw.outstanding ?? null, mintable: raw.mintable ?? null };
    default:
      return { id: target.value };
  }
}

export function normalizeEntity(target, raw, provider, timing = {}) {
  const safeRaw = sanitizeJson(raw, { maxDepth: 24, maxKeys: 50_000 });
  return {
    schemaVersion: 1,
    type: target.kind,
    id: String(target.value ?? target.canonical ?? 'home'),
    canonical: target.canonical,
    network: provider.network,
    summary: summaryFor(target, safeRaw),
    data: safeRaw,
    links: linksFor(target, safeRaw),
    source: {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      latencyMs: timing.latencyMs ?? null,
      endpoint: timing.endpoint ?? null
    },
    fetchedAt: new Date().toISOString()
  };
}
