// Reviewed against Bitcoin Core v31.1 src/kernel/chainparams.cpp. These are
// block identifiers, NOT snapshot-file checksums. Core verifies the UTXO hash.
export const CORE_SNAPSHOT_BASES = Object.freeze([
  { height: 935000, hash: '0000000000000000000147034958af1652b2b91bba607beacc5e72a56f0fb5ee' },
  { height: 910000, hash: '0000000000000000000108970acb9522ffd516eae17acddcb1bd16469194a821' },
  { height: 880000, hash: '000000000000000000010b17283c3c400507969a9c2afd1dcf2082ec5cca2880' },
  { height: 840000, hash: '0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5' }
].map(Object.freeze));
export const SNAPSHOT_GUIDE_URL = 'https://github.com/bitcoin/bitcoin/blob/v31.1/doc/assumeutxo.md';
export const SNAPSHOT_RECOMMENDED_FREE_BYTES = 60 * 1024 ** 3;
export function isQuickStart(draft) {
  return ['both', 'core'].includes(draft?.choice) && draft.core?.mode === 'managed' && draft.core?.sync === 'snapshot';
}

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function parseCoreChainstates(value) {
  if (!value || !Number.isSafeInteger(value.headers) || value.headers < 0 || !Array.isArray(value.chainstates)
    || value.chainstates.length < 1 || value.chainstates.length > 2) throw new Error('Core returned incomplete chainstate information.');
  const chains = value.chainstates.map(entry => {
    if (!entry || !Number.isSafeInteger(entry.blocks) || entry.blocks < 0 || entry.blocks > value.headers || !hash(entry.bestblockhash)
      || typeof entry.validated !== 'boolean' || !Number.isFinite(entry.verificationprogress) || entry.verificationprogress < 0 || entry.verificationprogress > 1
      || (entry.snapshot_blockhash !== undefined && !hash(entry.snapshot_blockhash)) || (!entry.validated && !entry.snapshot_blockhash)) throw new Error('Core returned invalid chainstate information.');
    return { blocks: entry.blocks, bestblockhash: entry.bestblockhash, validated: entry.validated,
      progress: entry.verificationprogress, ...(entry.snapshot_blockhash ? { snapshotHash: entry.snapshot_blockhash } : {}) };
  });
  const active = chains.at(-1), background = chains.length === 2 ? chains[0] : null;
  if (background && (!active.snapshotHash || background.snapshotHash || !background.validated || background.blocks > active.blocks)) throw new Error('Core returned inconsistent chainstates.');
  if (!active.validated && !background) throw new Error('Snapshot historical validation status is incomplete.');
  return { headers: value.headers, active, background, hasSnapshot: Boolean(active.snapshotHash), historicalValidated: active.validated };
}
