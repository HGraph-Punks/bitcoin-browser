import { AppError } from '../shared/errors.js';
import { aiRecord, aiString } from '../shared/local-ai.js';
import { INSCRIPTION_DISPLAY_ID, inscriptionMime } from '../shared/inscription-presentation.js';
import { parseNavigationInput } from '../shared/navigation.js';
import { decodedContentBytes } from './content-decoding.js';
import { sourceOptions, ensureLocalSnapshot } from './ai-bitcoin-data.js';

// Candidate identities, not precomputed claims about their graphs. Derived from
// https://docs.ordinals.com/inscriptions/examples.html, reviewed 2026-09-12.
// Link to the actual works, not library/renderer inscriptions that may require
// the owning work's metadata to display. Content is inspected afresh through
// browser sources, including narrowly validated sat-at-index indirection.
export const RECURSIVE_CANDIDATES = Object.freeze([
  Object.freeze({ id: '52b4ea10c2518c954c73594e403ccfb2d50044f5a3b09a224dfa3bf06dd1d499i0', title: 'Oscillations recursive art' }),
  Object.freeze({ id: 'b10b00bfb146fee3e86d6cbd8e8c954c485da41be480c0b21a6a63de7986892bi0', title: 'Blob #1 · recursive 3D art' }),
  Object.freeze({ id: 'aa43e0a7d229f460c6f9310e938ae8ec50a26f5b09df1f6d801d9e8a8741afc3i0', title: 'Chordinals generative music' })
]);
export const RECURSION_LIMITS = Object.freeze({ nodes: 36, depth: 5, references: 64, bytes: 4 * 1024 * 1024, resourceBytes: 1024 * 1024, timeMs: 45_000, requestMs: 10_000 });
const safeName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80) : '';
const safeTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const idOf = value => {
  const id = aiString(value, 'Inscription ID', 80).toLowerCase();
  if (!INSCRIPTION_DISPLAY_ID.test(id)) throw new AppError('AI_TOOL_ARGUMENTS', 'Use an exact inscription ID.', { status: 400 });
  return id;
};
const endpoint = /^\/r\/(?:blockheight|blocktime|blockhash(?:\/\d+)?|blockinfo\/(?:\d+|[a-f0-9]{64})|(?:inscription|metadata|undelegated-content|children|parents)\/[a-f0-9]{64}i\d{1,10}(?:\/\d+)?|sat\/\d+(?:\/(?:\d+|at\/-?\d+))?|tx\/[a-f0-9]{64})$/i;
function satLookup(path) {
  const match = /^\/r\/sat\/(\d{1,16})\/at\/(-?\d{1,10})$/.exec(path);
  // Ord's Sat::SUPPLY is 2_099_999_997_690_000 (zero-based numbering).
  if (!match || Number(match[1]) >= 2_099_999_997_690_000 || Math.abs(Number(match[2])) > 2_147_483_647) return false;
  try { return parseNavigationInput(`sat:${match[1]}`).kind === 'sat'; } catch { return false; }
}
const readable = mime => mime.startsWith('text/') || ['application/javascript', 'application/x-javascript', 'application/ecmascript', 'application/json', 'application/xhtml+xml', 'image/svg+xml'].includes(mime);

// Inert literal inspection, NOT a JS interpreter or proof of runtime loading.
// Only whole root-relative/ord content tokens are followed. An external URL
// containing /content/, arbitrary IDs, and parent/child JSON are not edges.
export function inscriptionReferences(text) {
  const ids = new Set(), endpoints = new Set();
  // Resolve only the common, inert `const sat = DECIMAL;` template form. No
  // expressions, property access, function calls or general JS evaluation.
  const constants = new Map();
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]{0,63})\s*=\s*(\d{1,16})\s*;/g))
    constants.set(match[1], constants.has(match[1]) ? null : match[2]);
  let limited = false;
  const add = value => {
    let path = value.replace(/^ord:\/\/content\//i, '/content/').replace(/^ord:\/\/r\//i, '/r/');
    path = path.replace(/^\/r\/sat\/\$\{([A-Za-z_$][\w$]{0,63})\}\/at\/(-?\d{1,10})$/, (original, name, index) =>
      constants.get(name) ? `/r/sat/${constants.get(name)}/at/${index}` : original);
    path = path.split(/[?#]/, 1)[0];
    const match = /^\/content\/([a-f0-9]{64}i\d{1,10})$/i.exec(path);
    const set = match ? ids : endpoint.test(path) ? endpoints : null;
    if (!set) return;
    const item = match ? match[1].toLowerCase() : path;
    if (set.has(item)) return;
    if (ids.size + endpoints.size >= RECURSION_LIMITS.references) { limited = true; return; }
    set.add(item);
  };
  const input = text.replace(/\\\//g, '/');
  for (const match of input.matchAll(/(['"`])([^'"`\r\n]{1,512})\1/g)) add(match[2]);
  for (const tag of input.matchAll(/<[a-z][^<>]{0,4096}>/gi)) {
    // Remove quoted attributes before looking for unquoted src/href. Otherwise
    // an external URL's ?src=/content/... could be mistaken for a local edge.
    const unquoted = tag[0].replace(/(['"])[^'"]*\1/g, '');
    for (const match of unquoted.matchAll(/\s(?:src|href)\s*=\s*(\/(?:content|r)\/[^\s'"`<>]+)/gi)) add(match[1]);
  }
  for (const match of input.matchAll(/\burl\(\s*(\/(?:content|r)\/[^)\s'"`]+)\s*\)/gi)) add(match[1]);
  return { ids: [...ids], endpoints: [...endpoints], satLookups: [...endpoints].filter(satLookup), limited };
}

const cap = (value, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
const note = 'Static content references and validated sat-at-index pointers, not parent/child provenance or a runtime rendering test. Counts exclude the starting inscription and can miss dynamic or encoded dependencies. Ord may serve delegated content, and sat pointers can change. Nothing was executed. “Highly recursive” has no protocol-defined threshold; these are not network-wide rankings.';
const metricDefinitions = Object.freeze({
  contentReferences: 'Count of distinct OTHER inscription IDs observed in content literals or validated sat-pointer replies. Excludes the starting inscription AND all Ord data endpoints. Some references may be unused; static inspection is not an execution trace.',
  directContentReferences: 'Distinct OTHER inscription IDs referenced by literal /content paths in the starting content, before following libraries or sat pointers.',
  observedHops: 'Deepest SUCCESSFULLY READ resource level in this bounded breadth-first traversal, including sat-pointer steps. NOT a longest path, leaf depth, ancestry generation, protocol recursion level, or proof the graph ends here.',
  recursiveEndpointReferences: 'Distinct Ord data endpoint paths observed separately. NOT included in contentReferences. Only validated sat-at-index paths are followed.',
  unresolvedResources: 'Referenced inscription contents not successfully inspected, including those beyond the scan budget. Do not claim they were loaded, valid, executed or verified.',
  scope: 'The source serves Ord data. The BROWSER chooses the three finder candidates from Handbook examples; an exact-ID inspection is not a curated-set comparison. There is no protocol-defined highly-recursive threshold.'
});

async function inspectCandidates(candidates, context, options) {
  const { providerManager, resolver, settings, signal: callerSignal } = context;
  if (!resolver) throw new AppError('AI_ORD_REQUIRED', 'An Ord content source is required.', { status: 503 });
  const operation = providerManager.beginOperation(callerSignal);
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), RECURSION_LIMITS.timeMs);
  const signal = AbortSignal.any([operation.signal, deadline.signal]);
  const maxNodes = cap(settings.maxRecursionNodes, RECURSION_LIMITS.nodes), maxDepth = cap(settings.maxRecursionDepth, RECURSION_LIMITS.depth);
  const maxBytes = cap(settings.maxGraphBytes, RECURSION_LIMITS.bytes);
  const nodes = new Map(); let usedBytes = 0, attempted = 0;
  const graphs = candidates.map(candidate => ({ ...candidate, visited: new Set(), references: new Set(), endpoints: new Set(), direct: 0, hops: 0, limited: false, root: null }));
  // Breadth-first across ALL roots: one large example cannot consume the
  // resource budget before another candidate's root has even been inspected.
  const queue = graphs.map(graph => ({ graph, path: `/content/${graph.id}`, depth: 0 }));
  const assertCurrent = () => { callerSignal.throwIfAborted(); providerManager.assertOperationCurrent(operation); };
  try {
    while (queue.length) {
      assertCurrent();
      if (deadline.signal.aborted) { for (const task of queue) task.graph.limited = true; break; }
      const { graph, path, depth } = queue.shift();
      if (graph.visited.has(path)) continue;
      graph.visited.add(path);
      let node = nodes.get(path);
      if (!node) {
        if (attempted >= maxNodes || usedBytes >= maxBytes) { graph.limited = true; continue; }
        attempted++;
        const isPointer = satLookup(path);
        const maxResource = Math.min(cap(settings.maxResourceBytes, isPointer ? 128 * 1024 : RECURSION_LIMITS.resourceBytes), maxBytes - usedBytes);
        let charged = 0;
        try {
          const resource = await resolver.resolve(path, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(RECURSION_LIMITS.requestMs)]), accept: isPointer ? 'application/json' : '*/*', maxBytes: maxResource });
          assertCurrent();
          charged = Math.min(resource.data?.byteLength ?? maxResource, maxResource);
          if (resource.status !== 200) throw new Error('Unavailable content');
          const mime = inscriptionMime(new Headers(resource.headers).get('content-type'));
          node = { ok: true, text: false, pointer: isPointer, ids: [], endpoints: [], satLookups: [], limited: false, source: safeName(resource.provenance?.providerName) || 'Configured Ord source', fetchedAt: safeTime(resource.provenance?.fetchedAt), cache: ['hit', 'stale'].includes(resource.cache) ? resource.cache : 'miss' };
          if (isPointer) {
            const bytes = await decodedContentBytes(resource, maxResource, signal);
            charged = Math.max(charged, bytes.length);
            const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, 'id')) throw new Error('Invalid pointer');
            node.ids = raw.id === null ? [] : [idOf(raw.id)];
          } else if (readable(mime)) {
            const bytes = await decodedContentBytes(resource, maxResource, signal);
            charged = Math.max(charged, bytes.length);
            const contentType = new Headers(resource.headers).get('content-type') ?? '';
            const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
            const text = new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8', { fatal: true }).decode(bytes);
            node = { ...node, text: true, ...inscriptionReferences(text) };
          }
        } catch (error) {
          assertCurrent();
          // Count failed reads conservatively, including oversized/decompression
          // failures, so retries cannot bypass the aggregate byte budget.
          charged = maxResource;
          node = { ok: false, limited: deadline.signal.aborted || error?.code === 'RESOURCE_TOO_LARGE' };
        }
        usedBytes += charged; nodes.set(path, node);
      }
      assertCurrent();
      if (path === `/content/${graph.id}`) graph.root = node;
      graph.limited ||= node.limited;
      if (!node.ok) continue;
      graph.hops = Math.max(graph.hops, depth);
      if (depth === 0) graph.direct = node.ids.filter(value => value !== graph.id).length;
      for (const path of node.endpoints) graph.endpoints.add(path);
      for (const next of node.ids) {
        if (next !== graph.id) graph.references.add(next);
      }
      for (const next of [...node.ids.map(id => `/content/${id}`), ...node.satLookups]) {
        if (graph.visited.has(next)) continue;
        if (depth >= maxDepth) { graph.limited = true; continue; }
        queue.push({ graph, path: next, depth: depth + 1 });
      }
    }
    assertCurrent();
    return graphs.map(graph => {
      const read = [...graph.visited].map(id => nodes.get(id)).filter(node => node?.ok);
      const unresolved = [...graph.references].filter(id => !graph.visited.has(`/content/${id}`) || !nodes.get(`/content/${id}`)?.ok).length;
      const unresolvedPointers = [...graph.endpoints].filter(satLookup).filter(path => !graph.visited.has(path) || !nodes.get(path)?.ok).length;
      const sources = [...new Set(read.map(node => node.source))];
      return { id: graph.id, title: graph.title, inspected: graph.root?.ok === true, directContentReferences: graph.direct,
        contentReferences: graph.references.size, resourcesRead: read.length, textResourcesInspected: read.filter(node => node.text).length,
        observedHops: graph.hops, recursiveEndpointReferences: graph.endpoints.size, satPointersRead: read.filter(node => node.pointer).length,
        unresolvedResources: unresolved, unresolvedSatPointers: unresolvedPointers,
        scanLimited: graph.limited, dependencyIds: [...graph.references].slice(0, 12), endpointExamples: [...graph.endpoints].slice(0, 6),
        sources: sources.slice(0, 3), cache: read.some(node => node.cache === 'stale') ? 'stale' : read.length && read.every(node => node.cache === 'hit') ? 'hit' : 'miss',
        cachedResources: read.filter(node => node.cache !== 'miss').length, fetchedAt: graph.root?.fetchedAt ?? null };
    });
  } finally { clearTimeout(timer); providerManager.finishOperation(operation); }
}

export async function inscriptionRecursion(args, context, find = false) {
  aiRecord(args, find ? ['source', 'service'] : ['value', 'source', 'service']);
  const options = sourceOptions(args.source, args.service);
  if (args.service && args.service !== 'ord-server') throw new AppError('AI_ORD_REQUIRED', 'Bitcoin Core does not expose an Ord inscription index.', { status: 400 });
  const { settings, providerManager, signal } = context;
  // A global local-only policy also selects the strict cache partition, not
  // merely local transports. Never satisfy it from an older public snapshot.
  if (settings.localOnly) options.localOnly = true;
  signal.throwIfAborted();
  let candidates;
  if (find) {
    if (settings.network !== 'mainnet') return { cards: [], error: 'The recursive example catalog is mainnet-only. Provide an exact inscription on the selected network to inspect; no mainnet source was queried.' };
    candidates = RECURSIVE_CANDIDATES;
  } else {
    const value = aiString(args.value, 'Inscription ID or number', 80);
    const target = parseNavigationInput(`inscription:${value}`);
    let id;
    if (target.kind === 'inscription') id = idOf(value);
    else if (target.kind === 'inscription-number') {
      const resolved = await providerManager.resolve(target, { ...options, network: settings.network, signal, timeoutMs: 10_000, maxBytes: Math.min(settings.maxResourceBytes ?? 128 * 1024, 128 * 1024) });
      signal.throwIfAborted();
      if (resolved.entity?.canonical !== target.canonical || resolved.entity?.network !== settings.network) throw new AppError('AI_SOURCE_MISMATCH', 'Wrong inscription number or network.', { status: 502 });
      if (resolved.entity.data?.number != null && String(resolved.entity.data.number) !== String(Number(value))) throw new AppError('AI_SOURCE_MISMATCH', 'Wrong inscription number.', { status: 502 });
      ensureLocalSnapshot(resolved, providerManager, target, options.localOnly ? 'local' : args.source, args.service);
      id = idOf(resolved.entity.data?.id ?? resolved.entity.summary?.id);
    } else throw new AppError('AI_TOOL_ARGUMENTS', 'Use an inscription ID or number.', { status: 400 });
    candidates = [{ id, title: target.kind === 'inscription-number' ? `Inscription #${value}` : `Inscription ${id.slice(0, 12)}…${id.slice(-6)}` }];
  }
  if (!settings.offlineMode && !providerManager.candidates('ord-recursion', { ...options, network: settings.network }).length)
    throw new AppError('AI_ORD_REQUIRED', 'No eligible Ord content source.', { status: 503 });
  const results = await inspectCandidates(candidates, context, options);
  const inspected = results.filter(result => result.inspected && (!find || result.contentReferences > 0 || result.recursiveEndpointReferences > 0))
    .sort((a, b) => b.contentReferences - a.contentReferences || b.observedHops - a.observedHops);
  const cards = inspected.map(result => ({ target: `inscription:${result.id}`, kind: 'inscription', title: result.title, network: settings.network,
    source: result.sources.join(' · '), fetchedAt: result.fetchedAt, cache: result.cache, editorial: false,
    facts: [
      { label: 'Observed content references', value: String(result.contentReferences) },
      { label: 'Observed dependency hops', value: String(result.observedHops) },
      { label: 'Direct content references', value: String(result.directContentReferences) },
      { label: 'Resources read', value: String(result.resourcesRead) },
      { label: 'Referenced Ord data endpoints', value: String(result.recursiveEndpointReferences) },
      { label: 'Unresolved references', value: String(result.unresolvedResources + result.unresolvedSatPointers) },
      { label: 'Inspection', value: result.scanLimited || result.unresolvedResources || result.unresolvedSatPointers ? 'Partial reference scan' : 'Reference scan; dynamic dependencies may be missed' }
    ] }));
  return { cards, data: { inspected: results.filter(result => result.inspected).length, candidates: candidates.length, results: inspected,
    metricDefinitions, scope: find ? 'Three pinned examples derived from the Ordinal Handbook, ordered only by observed references in this bounded inspection.' : 'User-requested inscription only. No other examples or ranked catalog were inspected.' },
    note, ...(!cards.length ? { error: 'I could not verify content references in the available Ord data. No recursive example was confirmed. Check Sources for an available Ord server or provide an exact inscription ID. Bitcoin Core alone does not supply this index.' } : {}) };
}

// Narrow, main-owned action-first path. A model that replies with a tutorial
// cannot skip the actual search. Explanation/negative/multi-target requests
// stay with the model's closed tools. No lookups run when the toggle is off.
export function recursiveSearchIntent(prompt) {
  if (prompt.length > 1000 || !/\brecurs(?:ive|ion)\b/i.test(prompt) || !/\b(?:inscription|inscriptions|ordinal|ordinals|art)\b/i.test(prompt)) return null;
  if (/\b(?:what|why|how|define|definition|means?|explain|tutorial)\b/i.test(prompt) || /\b(?:don['’]?t|do not|never|without)\s+(?:actually\s+)?(?:find|search|query|look\s?ups?|fetch|check)\b/i.test(prompt)) return null;
  if (!/\b(?:find|show|search|locate|inspect|check|looking for|give me|want|need)\b/i.test(prompt)) return null;
  const ids = [...new Set(prompt.match(/\b[a-f0-9]{64}i\d{1,10}\b/gi) ?? [])];
  if (ids.length > 1) return null;
  const number = /\binscription\s*(?:number\s*|#\s*|:\s*)?(-?\d{1,10})\b/i.exec(prompt)?.[1];
  const source = /\b(?:local|private)\b|\b(?:no|without|not|avoid)\s+(?:public|external|remote|internet)\b|\b(?:don['’]?t|do not|never)\s+use\s+(?:public|external|remote|the internet)\b/i.test(prompt) ? 'local' : 'auto';
  // Core-specific instructions are never silently routed to an Ord/public API.
  const service = /\b(?:bitcoin\s*core|core\s+(?:node|only))\b/i.test(prompt) ? 'bitcoin-core' : undefined;
  const value = ids[0] ?? number;
  return { name: value ? 'inspect_inscription_recursion' : 'find_recursive_inscriptions', args: { ...(value ? { value } : {}), source, ...(service ? { service } : {}) }, cacheOnly: /\boffline\b/i.test(prompt) };
}

export function recursiveSearchAnswer(result, find) {
  if (result.error) return result.error;
  const examples = [...result.data.results];
  if (find) examples.sort((a, b) => b.contentReferences - a.contentReferences || b.observedHops - a.observedHops);
  const lines = examples.map(item => `- **${item.title}**: ${item.contentReferences} distinct content references, ${item.directContentReferences} directly in the starting content, and ${item.observedHops} observed dependency hop${item.observedHops === 1 ? '' : 's'}.${item.satPointersRead ? ` Includes ${item.satPointersRead} resolved on-chain sat pointer${item.satPointersRead === 1 ? '' : 's'}.` : ''}${item.scanLimited || item.unresolvedResources || item.unresolvedSatPointers ? ` Partial scan; ${item.unresolvedResources + item.unresolvedSatPointers} referenced resources were not inspected successfully.` : ''}${item.cache === 'stale' ? ' Includes stale cached data.' : item.cachedResources ? ' Includes cached data.' : ''}`);
  return `${find ? 'Here are recursive examples I inspected using your configured Ord sources, ordered by the content references observed in this sample.' : 'I inspected this inscription’s content dependencies using your configured Ord sources.'}\n\n${lines.join('\n')}\n\nOpen a result below to explore it. Recursion means loading other inscriptions or on-chain data—not parent/child ancestry. These are static references, not proof that every resource executes or that an example is the most recursive on Bitcoin.${examples.every(item => !item.contentReferences && !item.recursiveEndpointReferences) ? ' No literal recursive references were found; dynamic references may still exist.' : ''}`;
}
