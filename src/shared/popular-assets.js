// Editorial discovery data, not a market feed or an authenticity certificate.
// References and selection notes: docs/POPULAR_DISCOVERY.md. Never fetch this
// catalog from a remote service or put current prices/owners/balances in it.
export const POPULAR_REVIEWED_AT = '2026-09-12';
export const POPULAR_VISIBLE_COUNT = 3;

function freezeEntry(entry) {
  return Object.freeze({ ...entry, facts: Object.freeze(entry.facts.map(fact => Object.freeze(fact))) });
}

const runes = Object.freeze([
  {
    key: 'dog', name: 'DOG', identity: 'DOG•GO•TO•THE•MOON', runeId: '840000:3', tone: 'orange',
    category: 'Bitcoin Rune', description: 'A dog-themed Rune created in Bitcoin’s 2024 halving block.',
    facts: [{ label: 'Initial allocation', value: '100 billion' }, { label: 'Created', value: '20 Apr 2024' }],
    detail: 'Rune #3. Five decimal places. The initial allocation is not the current circulating supply; open the Rune for created and burned amounts.',
    reference: 'https://ordinals.com/rune/DOG%E2%80%A2GO%E2%80%A2TO%E2%80%A2THE%E2%80%A2MOON'
  },
  {
    key: 'rsic', name: 'RSIC', identity: 'RSIC•GENESIS•RUNE', runeId: '840000:28', tone: 'violet',
    category: 'Bitcoin Rune', description: 'An early Rune from the first block of the Runes era.',
    facts: [{ label: 'Initial allocation', value: '21 billion' }, { label: 'Created', value: '20 Apr 2024' }],
    detail: 'Rune #8. Whole-token units with no decimal places. Open the Rune for the source’s latest supply and burn snapshot.',
    reference: 'https://ordinals.com/rune/RSIC%E2%80%A2GENESIS%E2%80%A2RUNE'
  },
  {
    key: 'pups', name: 'PUPS', identity: 'PUPS•WORLD•PEACE', runeId: '840000:41', tone: 'green',
    category: 'Bitcoin Rune', description: 'The World Peace Rune, also created in the 2024 halving block.',
    facts: [{ label: 'Initial allocation', value: '1 billion' }, { label: 'Created', value: '20 Apr 2024' }],
    detail: 'Rune #13. Eighteen decimal places. This is the Runes asset identified here, not another token with the same short name.',
    reference: 'https://ordinals.com/rune/PUPS%E2%80%A2WORLD%E2%80%A2PEACE'
  },
  {
    key: 'billion-dollar-cat', name: 'Billion Dollar Cat', identity: 'BILLION•DOLLAR•CAT', runeId: '845764:84', tone: 'violet',
    category: 'Bitcoin Rune', description: 'A cat-themed Rune with public mint rules and no initial allocation.',
    facts: [{ label: 'Maximum issuance', value: '1 billion' }, { label: 'Created', value: '30 May 2024' }],
    detail: 'The rules allow 40,000 mints of 25,000 whole tokens. This catalog does not show whether minting is currently available; open the Rune for a source snapshot.',
    reference: 'https://ordinals.com/rune/BILLION%E2%80%A2DOLLAR%E2%80%A2CAT'
  },
  {
    key: 'lobo', name: 'LOBO', identity: 'LOBO•THE•WOLF•PUP', runeId: '840000:35', tone: 'green',
    category: 'Bitcoin Rune', description: 'A wolf-pup-themed Rune from Bitcoin’s 2024 halving block.',
    facts: [{ label: 'Initial allocation', value: '21 billion' }, { label: 'Created', value: '20 Apr 2024' }],
    detail: 'Rune #9. Eight decimal places. Its project logo is branding, not an on-chain token symbol or an authenticity guarantee.',
    reference: 'https://ordinals.com/rune/LOBO%E2%80%A2THE%E2%80%A2WOLF%E2%80%A2PUP'
  },
  {
    key: 'uncommon-goods', name: 'Uncommon Goods', identity: 'UNCOMMON•GOODS', runeId: '1:0', tone: 'orange',
    category: 'Protocol-defined Rune', description: 'Rune #0: a useful starting point for understanding public mint rules.',
    facts: [{ label: 'Per mint', value: '1 token' }, { label: 'Origin', value: 'Protocol-defined' }],
    detail: 'The protocol defines this Rune; it was not created in 1970 or by a normal etching transaction. Its mint window runs from block 840,000 to before block 1,050,000. Open for current source data.',
    reference: 'https://ordinals.com/rune/UNCOMMON%E2%80%A2GOODS'
  }
].map(entry => freezeEntry({ ...entry, target: `rune:${entry.identity}` })));

const inscriptions = Object.freeze([
  {
    key: 'nodemonkes', name: 'NodeMonkes', inscriptionId: '8e530337416ff4b7ea893bb7d0376a4e79004726336213b9a50da56a9a2f0101i0', number: '83522',
    category: 'Pixel-art collection', tone: 'orange', preview: true,
    description: 'An early collection of pixel-art characters. Start with one on-chain example.',
    facts: [{ label: 'Collection snapshot', value: '10,000 items' }, { label: 'Example inscribed', value: '14 Feb 2023' }],
    detail: 'This opens inscription #83,522, a PNG example—not an entire collection or a marketplace listing. Collection membership comes from the referenced indexer.',
    reference: 'https://ordiscan.com/inscription/83522'
  },
  {
    key: 'bitcoin-puppets', name: 'Bitcoin Puppets', inscriptionId: '5491df2a36356cae4c0dddd7b72f5fdc90fc4ca45a0eb2db83169e39bf6d46dbi0', number: '53114151',
    category: 'Character-art collection', tone: 'green', preview: true,
    description: 'Expressive character art. This example is Bitcoin Puppet #3627.',
    facts: [{ label: 'Collection snapshot', value: '10,001 items' }, { label: 'Example inscribed', value: '3 Jan 2024' }],
    detail: 'The collection’s character number differs from the inscription number. This opens inscription #53,114,151, a WebP image. Membership is indexer-supplied.',
    reference: 'https://ordiscan.com/inscription/53114151'
  },
  {
    key: 'quantum-cats', name: 'Quantum Cats', inscriptionId: '4b31771df21656d2a77e6fa18720a6dd94b04510b9065a7c67250d5c89ad2079i0', number: '53785860',
    category: 'Recursive-art collection', tone: 'violet', preview: false,
    description: 'Taproot Wizards’ recursive cat art. Explore how an inscription can use other inscriptions.',
    facts: [{ label: 'Collection snapshot', value: '3,333 items' }, { label: 'Example inscribed', value: '8 Jan 2024' }],
    detail: 'This opens cat0000, inscription #53,785,860. Its HTML and recursive scripts do not run in this card; content opens only in the existing sandboxed viewer.',
    reference: 'https://ordiscan.com/inscription/53785860'
  },
  {
    key: 'bitcoin-frogs', name: 'Bitcoin Frogs', inscriptionId: '6f7db76f94fdfbba79be9af20befc936d7fcc53cc5b0911739b9ff377e793ba9i0', number: '395538',
    category: 'Generative-art collection', tone: 'green', preview: true,
    description: 'Colorful generative frogs on Bitcoin. This example is Bitcoin Frog #1.',
    facts: [{ label: 'Collection snapshot', value: '10,000 items' }, { label: 'Example inscribed', value: '10 Mar 2023' }],
    detail: 'This opens inscription #395,538, a WebP image. It is one example from the collection, not a live floor listing or an ownership claim.',
    reference: 'https://ordiscan.com/inscription/395538'
  },
  {
    key: 'runestone', name: 'Runestone', inscriptionId: 'ed76bf35918948b8b78be0e6397ad4916d926dd3d65679a8b7e67d8699a672a0i0', number: '63140674',
    category: '3D inscription project', tone: 'orange', preview: false,
    description: 'A recognizable 3D artifact from the Runestone project. This is an inscription, not a Rune token.',
    facts: [{ label: 'Collection snapshot', value: '112,384 items' }, { label: 'Example inscribed', value: '3 Mar 2024' }],
    detail: 'This opens inscription #63,140,674, a roughly 4 MB glTF artifact, in an interactive 3D view. Drag to rotate and scroll to zoom. The card itself does not download or run the model.',
    reference: 'https://ordiscan.com/inscription/63140674'
  },
  {
    key: 'inscription-zero', name: 'Inscription #0', inscriptionId: '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0', number: '0',
    category: 'Historic inscription', tone: 'violet', preview: true,
    description: 'The small pixel-art skull at inscription number zero. A starting point for Ordinals history.',
    facts: [{ label: 'Content', value: 'PNG · 793 bytes' }, { label: 'Inscribed', value: '14 Dec 2022' }],
    detail: 'A historical pick, not a market-popularity claim. It opens the exact inscription ID; no collection membership or current owner is asserted.',
    reference: 'https://ordiscan.com/inscription/0'
  }
].map(entry => freezeEntry({ ...entry, identity: `Inscription #${entry.number}`, target: `inscription:${entry.inscriptionId}` })));

const catalogs = Object.freeze({ runes, inscriptions });
const empty = Object.freeze([]);
export function popularAssets(kind, network) {
  return network === 'mainnet' && typeof kind === 'string' && Object.hasOwn(catalogs, kind) ? catalogs[kind] : empty;
}

// Actions accept catalog keys, never navigation targets or reference URLs from
// provider responses. Recheck the live network when a user activates a card.
export function popularAsset(kind, key, network) {
  return popularAssets(kind, network).find(entry => entry.key === key) ?? null;
}
