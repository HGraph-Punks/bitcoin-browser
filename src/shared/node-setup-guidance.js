// Presentation advice is deliberately separate from the saved, hash-covered
// setup plan. Updating estimates must not invalidate ownership of old setups.
import { isQuickStart, SNAPSHOT_RECOMMENDED_FREE_BYTES } from './node-snapshot.js';
const GiB = 1024 ** 3;
export const NODE_SETUP_MIN_FREE_BYTES = 2 * GiB;
const LEGACY_COST_WARNINGS = new Set([
  'Initial blockchain synchronization downloads many gigabytes and can take hours or days; storage estimates are not guarantees.',
  'Ord indexing can take hours or days and require substantial additional disk space; the estimate is not a guarantee.'
]);

export function nodeSetupGuidance(draft = {}) {
  const coreManaged = ['both', 'core'].includes(draft?.choice) && draft.core?.mode === 'managed';
  const ordManaged = ['both', 'ord'].includes(draft?.choice) && draft.ord?.mode === 'managed';
  const managed = coreManaged || ordManaged;
  const minimumFreeBytes = managed ? NODE_SETUP_MIN_FREE_BYTES : 0;
  if (!managed) {
    const storageText = 'No new node data folders are created. Existing services continue using their own storage.';
    return { coreManaged, ordManaged, managed, recommendedBytes: 0, minimumFreeBytes, storageText, choiceText: storageText };
  }

  let recommendedBytes = null, storageText, choiceText;
  if (draft.network === 'mainnet') {
    recommendedBytes = (coreManaged ? (isQuickStart(draft) ? SNAPSHOT_RECOMMENDED_FREE_BYTES : (draft.core.storage === 'pruned' ? 30 : 1024) * GiB) : 0)
      + (ordManaged ? (draft.ord.indexSats ? 1024 : 512) * GiB : 0);
    const amount = recommendedBytes >= 1024 * GiB ? `${recommendedBytes / (1024 * GiB)} TiB` : `${recommendedBytes / GiB} GiB`;
    const names = coreManaged && ordManaged ? 'Bitcoin Core and Ord' : coreManaged ? 'Bitcoin Core' : 'Ord';
    storageText = `For mainnet, the conservative storage recommendation for managed ${names} is ${amount}.`;
    if (coreManaged && ordManaged && !draft.ord.indexSats) storageText += ' Optional sat indexing can raise the combined recommendation toward 2 TiB.';
    choiceText = storageText;
    storageText += ' Synchronization and indexing can take hours or days; these are not guaranteed capacity or completion estimates.';
  } else if (draft.network === 'regtest') {
    storageText = 'Regtest uses a local test chain. Storage and indexing time depend on the blocks supplied and selected indexes; no fixed capacity estimate is available.';
  } else {
    const network = draft.network === 'testnet' ? 'Testnet3' : 'Signet';
    storageText = `${network} storage and synchronization time depend on the test chain and selected indexes; no fixed capacity estimate is available.`;
  }
  choiceText ??= storageText;
  if (isQuickStart(draft)) storageText += ' Quick start needs a separately obtained snapshot plus temporary space for two chainstates. Snapshot size and actual disk growth vary; the snapshot file is never automatically deleted.';
  if (coreManaged && draft.core.storage === 'pruned') storageText += ' Compact mode targets about 10,000 MiB of block files, not total disk usage. It still downloads historical blocks; older local lookups become unavailable. Inscriptions and Runes need a separate source.';
  storageText += ' Managed startup requires at least 2 GiB of available space when free space can be checked. This safeguard does not guarantee enough room for synchronization or limit disk growth.';
  return { coreManaged, ordManaged, managed, recommendedBytes, minimumFreeBytes, storageText, choiceText };
}

export function nodeSetupDisplayWarnings(draft, warnings = []) {
  return warnings.filter(warning => draft?.network === 'mainnet' || !LEGACY_COST_WARNINGS.has(warning));
}
