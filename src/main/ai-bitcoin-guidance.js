import { parseNavigationInput } from '../shared/navigation.js';

// Browser-owned protocol grounding. Keep this separate from provider text and
// model history, neither of which is trusted instruction or current evidence.
export const BITCOIN_AI_PRIMER = `Bitcoin transactions spend UTXOs and create new outputs; one BTC is 100,000,000 sats. A public address is not an entire wallet.
An inscription stores content in a Taproot script-path witness envelope. Ordinal theory tracks individual sats; an inscription is assigned to a single sat, not a group. Reinscription means another inscription on the SAME sat, NOT embedding/copying other content. Sat numbers are zero-based. An inscription ID is a 64-hex transaction ID followed by i and its inscription index (not :0). Its inscription NUMBER is a different identifier. OP_RETURN is a data carrier, not itself a smart-contract execution engine.
Runes are fungible tokens with balances assigned to Bitcoin outputs. Rune protocol messages (runestones) use an OP_RETURN output with OP_13, not inscription content, sat data fields, or witness envelopes. Etching creates a Rune; minting creates units under its terms; transfers allocate balances. A Rune ID is block height:transaction index. Divisibility describes base units per token. Prefer the browser's ALREADY FORMATTED token amounts and percentages; do not divide those again. Outstanding supply is created supply minus burns, NOT circulating or free-float supply. Remaining mint capacity is not proof minting is open. Postage is an output's BTC value, not an asset's price.
Inscription provenance uses explicit parent tags and proof of possession; it is NOT automatically inferred from transaction inputs, UTXO ancestry, shared sats or siblings. An inscription CAN have multiple parents. Content recursion is different: inscription content requests other inscriptions or on-chain data through allowed Ord endpoints. NO loop or cycle back to itself is required: A loading B is sufficient content reuse. Bare IDs, external URLs and many parents do not by themselves establish recursion. Static references do not prove execution. observedHops is a bounded traversal observation, NOT longest-chain or ancestry depth.
Sat rarity follows the sat's position in Bitcoin issuance; it is not artwork rarity, collection rank or market value. Supply and distribution alone do not establish a token's price or value. A sat's mined block differs from the inscription's creation block. Use collector.calculated/source attribution and reported conflicts; missing metadata means unknown, not common.
Bitcoin Core validates Bitcoin but has no Ord inscription or Rune index. Ord supplies those indexes. Source discovery is NOT a sync check: only a successful chain-status result supports a current node-status claim. Never infer synced from connectivity or height alone.`;

// These restrictions only narrow existing browser routing. They cannot enable
// a source, disable offline mode, install a node, or open a new destination.
export function bitcoinQuestionPolicy(prompt) {
  const text = String(prompt).toLowerCase();
  return {
    localOnly: /\b(?:local(?:[\s\w-]{0,35})?\s+only|only\s+(?:my\s+|the\s+)?local|no\s+(?:public|external)\s+(?:sources?|fallback|lookups?)|(?:do not|don't|without)\s+(?:use|using|query|querying)\s+(?:any\s+)?public)\b/.test(text),
    coreOnly: /\b(?:only\s+(?:use\s+)?(?:bitcoin\s+)?core|(?:bitcoin\s+)?core\s+only)\b/.test(text),
    cacheOnly: /\b(?:offline(?:[\s\w-]{0,20})?\s+only|cached?(?:[\s\w-]{0,20})?\s+only|without\s+(?:any\s+)?network\s+(?:requests?|access))\b/.test(text)
  };
}

export function bitcoinQuestionPlan(prompt) {
  const text = String(prompt);
  // Deliberately narrow action-first recognition. General explanations,
  // examples, negations and ambiguous numbers remain model-led.
  if (/\b(?:do not|don't|never)\s+(?:look\s*up|query|fetch|check)|\b(?:hypothetically|example prompt|how (?:do|can|would) (?:i|you))\b/i.test(text)) return null;
  if (/\b(?:check|show|is|how|what|which)\b/i.test(text) && /\b(?:sync(?:ed|ing|hronization)?|node status)\b/i.test(text) && /\b(?:my (?:local )?node|local (?:bitcoin )?(?:core|node)|my (?:bitcoin )?core)\b/i.test(text))
    return { name: 'get_bitcoin_status', args: { query: 'chain', source: 'local', service: 'bitcoin-core' }, summary: 'node' };
  if (/\b(?:recursi\w*|dependencies|parents?|children|provenance)\b/i.test(text)) return null;
  const ids = [...new Set(text.match(/(?<![a-z\d])[a-f\d]{64}i\d+(?![a-z\d])/gi) ?? [])];
  if (ids.length === 1 && /\b(?:look\s*up|inspect|show|explain|tell me|what|read)\b/i.test(text)) {
    try {
      const target = parseNavigationInput(`inscription:${ids[0]}`);
      if (target.kind === 'inscription') return { name: 'lookup_bitcoin', args: { kind: 'inscription', value: target.value } };
    } catch { /* Do not invent or repair an invalid identifier. */ }
  }
  return null;
}

export function bitcoinConceptQuestion(prompt) {
  // Explicit conceptual questions need a reference-grounded explanation, not
  // thousands of tokens of tool schemas or instructions for calling APIs.
  if (/\b(?:look\s*up|find|show|check|current|latest|my node|block\s+\d+|[a-f\d]{64}i\d+)\b/i.test(prompt)) return false;
  return /\b(?:difference between|how .*differ)\b/i.test(prompt) && /\b(?:bitcoin|inscriptions?|runes?|sats?)\b/i.test(prompt)
    || /^\s*what (?:is|are) (?:an? |the )?(?:bitcoin|inscriptions?|runes?|ordinals|content recursion|sat rarity)[?.!\s]*$/i.test(prompt)
    || /\b(?:can an inscription have (?:multiple|more than one) parents?|explain (?:uncommon|rare sats|sat rarity)|is (?:a|an) recursive inscription)\b/i.test(prompt);
}

export function nodeStatusAnswer(result) {
  if (result.error || !result.data) return `I couldn't check your local Bitcoin Core node. ${result.error ?? 'No usable status was returned.'}\n\nOpen Sources to check that a local Bitcoin Core connection is enabled for this network. Core alone cannot look up inscriptions or Runes; that needs an Ord index. No service was started or setting changed.`;
  const data = result.data;
  const state = data.initialBlockDownload === true ? 'Your local node is still doing its initial sync.'
    : data.initialBlockDownload === false ? 'Your local node reports that it has left initial block download. That alone does not prove it is at the latest network tip.'
    : 'Your local source returned a chain snapshot; it did not report initial-sync status.';
  const facts = result.cards[0]?.facts ?? [];
  return `${state}\n\n${facts.map(fact => `- **${fact.label}:** ${fact.value}`).join('\n')}\n\nThis is a snapshot from **${data.source}**, not a live feed or an independent check against the network tip.${data.pruned === true ? ' Compact storage is enabled: older block bodies may be unavailable.' : ''}\n\nBitcoin Core validates Bitcoin but does not index inscriptions or Runes. Connect an Ord source to browse those assets; a local Ord server needs suitable Bitcoin history to build its index. No service was started or setting changed.`;
}

export function runeSourceAnswer(result) {
  const card = result.cards?.find(card => card.kind === 'rune' && !card.editorial);
  const collector = result.data?.collector;
  if (!card || collector?.kind !== 'rune') return null;
  const facts = [];
  const add = (label, value, suffix = '') => { if (value != null) facts.push(`- **${label}:** ${value}${suffix}`); };
  add('Rune ID (block:transaction index)', result.data.id);
  add('Outstanding tokens', collector.tokens.outstanding);
  add('Total created', collector.tokens.supply);
  add('Maximum possible tokens', collector.tokens.maximum);
  add('Mint status', { fixed: 'No public mint', closed: 'Closed at this source snapshot', open: 'Open at this source snapshot', unknown: 'Unknown' }[collector.mintState]);
  add('Mint cap used', collector.mintProgress); add('Remaining mint slots', collector.remainingMints);
  add('Premine share of maximum', collector.premineShareOfMaximum);
  add('Burned tokens', collector.tokens.burned); add('Burned share of created tokens', collector.burnedShareOfCreated);
  add('Mint opens at block', collector.mintStart); add('Mint ends before block', collector.mintEndExclusive);
  const snapshot = card.cache === 'stale' ? 'a stale cached snapshot' : card.cache && card.cache !== 'miss' ? 'a cached snapshot' : 'a source snapshot';
  return `**${card.title}**\n\n${facts.join('\n')}\n\nThese are already divisibility-adjusted token amounts from ${snapshot} supplied by **${card.source}**. Outstanding means created minus burned, not circulating or freely tradable supply. Remaining mint slots alone do not mean minting is open.\n\nMarket price, trading volume and a holder list are not available from these sources. Open the result card for the full Rune details; a public address or output can be looked up separately for any balances its source provides.`;
}
