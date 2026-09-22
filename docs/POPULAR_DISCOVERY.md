# Popular asset discovery

The Inscriptions and Runes tabs include **Popular to explore**: a small, bundled editorial catalog for mainnet. Three cards appear initially, with **Show all 6** for the rest. Exact search, latest listings, block browsing, page filters, pagination, bookmarks and existing detail views remain available. Rune detail pages do not show this discovery section.

This is **curated discovery, not a live popularity ranking**. The current Ord providers expose on-chain data, not market-wide popularity or trading statistics. Picks introduce recognizable projects and notable artifacts; their order is editorial and does not claim these are the six most traded, most owned or highest-value assets. Inscription #0 and Uncommon Goods are educational picks. No investment recommendation or authenticity guarantee is made.

## What users can see

- Rune cards show the full unambiguous name, creation date or protocol-defined origin, and initial allocation or mint rules. **Explore Rune** opens existing source-backed supply, burned amounts, mint status, decimals and creation links. Initial allocation and maximum issuance are not circulating supply.
- Inscription cards show a project name, art category, one exact example number, its inscription date, and an attributed collection-size snapshot where available. **Open example** opens that inscription's existing viewer and source-supplied metadata; it does not open a complete collection or a marketplace listing. The source may be missing, offline, unsynced or unable to serve the example.
- **Asset details** reveals the exact ID, explanatory caveats, Copy and a reference link. References open in the system browser through the existing native confirmation, not an embedded marketplace. That browser has its own network/privacy settings.
- Project logos and collection icons display automatically from bundled raster assets, including offline. They identify the project, not necessarily the card's exact inscription example. Sources, distinctions and third-party rights notes are recorded in [Popular asset logos](POPULAR_ASSET_LOGOS.md).
- Prices, market cap, floor listings, volume, holder rankings, portfolios, trading and live popularity are intentionally absent. Adding them requires a separately reviewed source, freshness/ranking definitions, privacy policy and any required credentials; no silent third-party integration is made.

## Catalog references

Reviewed **2026-09-12 UTC** (September 11 local time). Creation facts are historical; collection size and membership are indexer snapshots, not consensus facts or ongoing verification. Short names are display labels, never the navigation authority. Exact identifiers are in [`src/shared/popular-assets.js`](../src/shared/popular-assets.js).

### Runes

| Display name | Exact Rune ID | Reference |
|---|---|---|
| DOG | `840000:3` | [DOG•GO•TO•THE•MOON on Ordinals](https://ordinals.com/rune/DOG%E2%80%A2GO%E2%80%A2TO%E2%80%A2THE%E2%80%A2MOON) |
| RSIC | `840000:28` | [RSIC•GENESIS•RUNE on Ordinals](https://ordinals.com/rune/RSIC%E2%80%A2GENESIS%E2%80%A2RUNE) |
| PUPS | `840000:41` | [PUPS•WORLD•PEACE on Ordinals](https://ordinals.com/rune/PUPS%E2%80%A2WORLD%E2%80%A2PEACE) |
| Billion Dollar Cat | `845764:84` | [BILLION•DOLLAR•CAT on Ordinals](https://ordinals.com/rune/BILLION%E2%80%A2DOLLAR%E2%80%A2CAT) |
| LOBO | `840000:35` | [LOBO•THE•WOLF•PUP on Ordinals](https://ordinals.com/rune/LOBO%E2%80%A2THE%E2%80%A2WOLF%E2%80%A2PUP) |
| Uncommon Goods | `1:0` | [UNCOMMON•GOODS on Ordinals](https://ordinals.com/rune/UNCOMMON%E2%80%A2GOODS) |

Billion Dollar Cat's maximum issuance is derived from 40,000 permitted mints × 25,000 units. It does not imply that minting is open now. Uncommon Goods is protocol-defined; no Unix-epoch date or ordinary etching transaction is invented for it. Current supply, burns and mint availability are never copied into this static catalog.

### Inscriptions

| Project / artifact | Example inscription | Collection snapshot / reference | Card preview |
|---|---|---|---|
| NodeMonkes | [#83,522](https://ordiscan.com/inscription/83522) | [10,000 items](https://ordiscan.com/collection/nodemonkes) | Optional PNG |
| Bitcoin Puppets | [#53,114,151 / Puppet #3627](https://ordiscan.com/inscription/53114151) | [10,001 items](https://ordiscan.com/collection/bitcoin-puppets) | Optional WebP |
| Quantum Cats | [#53,785,860 / cat0000](https://ordiscan.com/inscription/53785860) | [3,333 items](https://ordiscan.com/collection/quantum-cats) | None: recursive HTML |
| Bitcoin Frogs | [#395,538 / Frog #1](https://ordiscan.com/inscription/395538) | [10,000 items](https://ordiscan.com/collection/bitcoin-frogs) | Optional WebP |
| Runestone | [#63,140,674](https://ordiscan.com/inscription/63140674) | [112,384 items](https://ordiscan.com/collection/runestone) | None: roughly 4 MB glTF |
| Inscription #0 | [#0](https://ordiscan.com/inscription/0) | Historical artifact, no collection assertion | Optional PNG |

An indexer's character number is not necessarily an inscription number. Runestone is an inscription project, not a Rune token. Opening its example now uses the isolated [glTF/GLB 3D viewer](3D_INSCRIPTIONS.md); the card itself never runs the model. This does not imply support for every 3D format or decoder extension. Public reference review does not prove availability through every configured local/public Ord source.

## Security and privacy boundaries

The catalog is local, bounded and deeply frozen. There is no downloaded catalog, external image URL, market API, analytics, dependency, provider default, credential request or wallet permission added. Display strings use DOM text nodes, not HTML injection. Actions look up a fixed catalog key and recheck the live network and owning tab; provider metadata cannot choose card destinations or reference URLs.

The new discovery cards make **no remote/provider content requests by default**; project logos are bundled with the app as static PNG/WebP data images. The existing latest-inscription gallery still has its existing automatic raster previews. **Show safe artwork** opts into at most four exact-example images, using only `ord://thumbnail/<exact-inscription-id>` and the existing resolver, routing policy and cache. Example images are lazy-loaded, contained/centered and referrer-free. Offline mode uses cached content only; local-only mode uses permitted local sources. Non-mainnet hides the catalog without changing settings. Routing/privacy transitions reset example previews, while the bundled logos remain; ordinary background result updates preserve cards, disclosures, focus and preview nodes.

The thumbnail route limits encoded content to **2 MiB**, rejects non-200/empty/oversized responses and non-raster MIME types, removes provider-controlled headers, and supplies restrictive CSP and `nosniff`. HTML, SVG, recursive scripts, audio, video and 3D content never execute in discovery cards. The byte limit is **not a decoded-pixel or image-decoder memory guarantee**; existing Chromium decoding and provider trust limitations remain. Opening an inscription uses the existing isolated content viewer, not additional wallet or application privileges.

External-reference and navigation failures produce bounded generic feedback; native user cancellation is handled. No raw provider/system error or credentials are rendered by the new component. No wallet connection, transaction, PSBT or signature is requested by discovery. This is scoped regression coverage, not a certification that arbitrary extensions or inscriptions are safe.

## Verification and manual acceptance

Run with Node 22 or newer:

```bash
node --test --test-reporter=spec tests/popular-assets.test.js tests/content-thumbnail.test.js tests/inscriptions-ui.test.js tests/runes-ui.test.js tests/renderer-bootstrap-ui.test.js
npm run security:beta
npm run verify
```

The added tests exercise actual catalog/renderer functions with bounded DOM collaborators: exact native targets, frozen/unknown catalog kinds, mainnet gating, explicit actions, reference cancellation, image fallback, no active embeds, routing and stale-tab guards, retained drafts/disclosures and existing view integration. The beta security command includes both catalog/UI and thumbnail protocol tests. DOM/static CSS checks do not certify native rendering, decoded artwork, keyboard defaults, screen readers or responsive geometry.

Manual acceptance still needs a visible browser pass: open both tabs; expand and collapse picks; inspect long identifiers and light/dark/narrow layouts; use keyboard focus; request artwork, including unavailable-image fallback; open an example and a Rune; verify details against the active provider; reject an external reference; and repeat in offline/local-only/non-mainnet settings. Do not connect funded wallets or sign transactions for these checks. Broader beta startup/shutdown, distribution and wallet qualification gates remain separate and unchanged.
