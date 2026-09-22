# Popular asset logos and artwork

Reviewed **2026-09-12**. The twelve discovery-card placeholders have been replaced by original project logos, collection icons or identified project artwork. No AI-generated or redrawn project marks are used.

Images are bundled in [popular-logos.js](../src/renderer/assets/popular-logos.js) as immutable PNG/WebP data URLs. The data URLs contain the downloaded raster bytes unchanged; only their CSS display size and surrounding canvas change. The complete set is **221,373 encoded image bytes**, below 256 KiB. Base64/module overhead increases the packaged text size to about 300 KB. Individual raster payloads are below 96 KiB, and the largest reviewed image is 2048 × 2048.

## Sources

| Asset / usage | Source and downloaded image | Raster dimensions |
|---|---|---|
| DOG project logo | [Reference](https://doggotothemoon.io/) · [Original image](https://doggotothemoon.io/wp-content/uploads/2024/05/cropped-DOG-favicon-192x192.png) | PNG · 192 × 192 |
| RSIC Rune logo | [Reference](https://unisat.io/runes/detail/RSIC%E2%80%A2GENESIS%E2%80%A2RUNE) · [Original image](https://static.unisat.space/content/d40480861e3397c256204694db2ce67a656a435915d6d9a0dbc62717c482ec64i0) | WEBP · 2048 × 2048 |
| PUPS project logo | [Reference](https://www.coingecko.com/en/coins/rune-pups) · [Original image](https://coin-images.coingecko.com/coins/images/37159/large/token_logo.png) | PNG · 250 × 250 |
| Billion Dollar Cat project logo | [Reference](https://unisat.io/runes/detail/BILLION%E2%80%A2DOLLAR%E2%80%A2CAT) · [Original image](https://static.unisat.space/content/c5e59f3f8024c80fe7f8685c1d920f66cee5e9d4a423f3f293d844b291381ba5i0) | PNG · 558 × 558 |
| LOBO project logo | [Reference](https://www.lobothewolfpup.io/) · [Original image](https://www.lobothewolfpup.io/assets/66e38ba8be164d561c082ece/66e4eae9f0ccaa661589f0ae_LOGO%20256X256-01.png) | PNG · 256 × 256 |
| Uncommon Goods community logo | [Reference](https://www.uncommongoods.top/) · [Original image](https://w.ladicdn.com/5b640918f14cf545e6e7ae86/uncommongoods-20240824005035-esyyo.png) | PNG · 250 × 250 |
| NodeMonkes project icon | [Reference](https://nodemonkes.com/) · [Original image](https://nodemonkes.com/static/img/favicon.png?v=5d57dcb046) | PNG · 56 × 56 |
| Bitcoin Puppets collection icon | [Reference](https://ordinalswallet.com/collection/bitcoin-puppets) · [Original image](https://ordinals.com/content/170e13d878efecabbe2f3f31fedf28bc16c31d0ee4292c61829d43a067627ae5i0) | WEBP · 256 × 256 |
| Quantum Cats project artwork | [Reference](https://www.quantumcats.xyz/) · [Original image](https://www.quantumcats.xyz/_next/static/media/cat-face.13799427.png) | PNG · 508 × 292 |
| Bitcoin Frogs collection icon | [Reference](https://ordinalswallet.com/collection/bitcoin-frogs) · [Original image](https://cdn.ordinalswallet.com/inscription/preview/d19981a198e4a8419c8be18588d9e4919cea294deefdb5f9261a30242df578b7i0) | WEBP · 576 × 576 |
| Runestone collection logo | [Reference](https://ordinalswallet.com/collection/runestone) · [Original image](https://media.ordinalswallet.com/693b679f6abf7d61f4e1dcffaa2571b6f1d0740cd080c9b532f54baed98bdc24.png) | PNG · 400 × 400 |
| Inscription #0 original artwork | [Reference](https://ordinals.com/inscription/6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0) · [Original image](https://ordinals.com/content/6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0) | PNG · 100 × 100 |

DOG, LOBO, NodeMonkes and Quantum Cats assets were identified on their project sites. PUPS was matched to Rune ID `840000:41` in CoinGecko's public identity metadata before taking its logo; no market-data feed or API account is installed. RSIC and Billion Dollar Cat use the exact raster inscriptions linked by UniSat's named Rune icon routes. Bitcoin Puppets, Bitcoin Frogs and Runestone use the collection icons advertised by their Ordinals Wallet records. For Bitcoin Puppets, the exact referenced inscription was retrieved from ordinals.com, not by embedding the marketplace's viewer.

Uncommon Goods uses the published mark of the community site linked from the CoinGecko identity record for `1:0`. **It is community branding, not a logo defined by Bitcoin or the Runes protocol**; the UI states that distinction. Inscription #0 uses its original on-chain PNG, since it is a historical artifact rather than a separately branded collection.

Collection icons are not necessarily the particular inscription example linked by a card. The card's Asset details explains this, and **Show safe artwork** remains the separate way to preview an eligible exact example through the user's configured sources.

## Security and behavior

- Logo display works offline and in local-only mode without requests to a CDN, marketplace, project website, wallet or data provider. The existing app CSP already permits these bundled data images; no CSP, IPC, wallet, provider, credential or extension capability was changed.
- Only the reviewed static PNG and WebP payloads are bundled. HTML redirects, generic letter-image placeholders, downloaded SVG and unrelated favicon candidates were not included. The logo source addresses are provenance, never runtime image destinations.
- Automated tests check every file's signature/container, dimensions, byte limits and absence of animation, reject arbitrary/inherited lookup keys, and assert exact bundled sources in the real renderer. Local asset loading does not relax the 2 MiB raster-only route for optional inscription previews.
- Logos fit a 64px card badge, or the larger centered artwork canvas when expanded. Pixel-art icons retain crisp scaling. Quantum Cats uses a light backing so its dark outlines remain legible across app themes. There are no remote fallback URLs; a missing/failed image gets a neutral geometric missing-image marker.
- Source acquisition used bounded public requests without cookies, authorization headers, downloaded script execution or wallet connections. Static bitmap appearance was inspected locally. Native app layout, keyboard, screen-reader and image-decoder robustness are separate acceptance scopes.

## Rights and maintenance

Names, marks and third-party artwork remain associated with their respective creators and rights holders. They are used here to identify the assets being explored, without implying endorsement. Their inclusion does not relicense them under the repository's MIT licence. A broad redistribution licence was not established for every image in this pass; these source references should be retained for the release owner's branding/rights review.

Future replacements should be fetched explicitly, visually checked against the correct project and exact asset identity, kept as bounded static raster bytes, and accompanied by updated source notes and tests. Do not turn these provenance addresses into automatic runtime requests or copy a provider's arbitrary image URL into the privileged renderer.
