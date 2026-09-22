# Bitcoin Browser: features, benefits and claim boundaries

Source snapshot: **2026-09-12 · 1.0.0-rc.1**. “Implemented” below means present in the current source, not certified across every native platform, data source, wallet or media codec.

## 1. A Bitcoin-native desktop browser

**User benefit:** explore related Bitcoin information without constantly switching explorer sites or losing your place.

Implemented:

- An omnibox that recognizes Bitcoin-native destinations and offers suggestions.
- Tabs, new/close/reload, per-tab back/forward history and optional restore-on-launch.
- Keyboard shortcuts and a command palette for navigation and tools.
- A left sidebar for core destinations including Inscriptions, Runes and Ask Bitcoin.
- Local bookmarks and browsing history, with copyable canonical identifiers independent of a particular explorer.
- `satnav://` deep links and an application-local `ord://` content transport.
- Navigation between available related records, such as an inscription's sat/output/address or a block's neighbors.
- External web links and Bitcoin payment URIs handed to the appropriate system app after confirmation.

**Suggested copy:** “Familiar browser controls. Bitcoin-native destinations.”

**Boundary:** ordinary websites open in the system browser. Do not sell this as a Chrome replacement, built-in web search, or a new Bitcoin consensus protocol.

Evidence: `src/renderer/app.js`, `src/shared/navigation.js`, `src/main/window.js`, `README.md`.

## 2. An approachable Start screen and guided lookup

**User benefit:** get from an identifier to useful information without memorizing technical syntax.

- A prominent inscription-exploration entry point and a guided Bitcoin lookup.
- Automatic recognition, type selection, explanatory examples and explicit choices for ambiguous inputs.
- Examples fill the input; they do not silently run a query.
- Common workflows are visible first; advanced tools and technical status expand when needed.
- Drafts, focus and open disclosures survive passive updates where the view is retained.
- History/bookmark shortcuts and an optional path to local-node setup.

**Suggested copy:** “Paste an identifier. Find your way through Bitcoin.”

**Boundary:** arbitrary natural-language text in the omnibox is not a global on-chain search. Natural-language assistance belongs in Ask Bitcoin and has its own bounded tools.

Evidence: `src/renderer/search.js`, `src/renderer/home.css`, `src/renderer/views.js`, `tests/home-clarity-ui.test.js`.

## 3. Bitcoin record exploration

**User benefit:** inspect the underlying Bitcoin record and see where each result came from.

| Destination | Information exposed when the selected source supplies it |
| --- | --- |
| Transactions | Transaction ID, status, fee, size/weight and raw/provider data; the AI data tools can project bounded inputs/outputs and related records |
| Blocks | Height, hash, timestamp, transaction count, size/weight, neighboring blocks and raw data |
| Public addresses | Address, funded/spent statistics, transaction counts and source records; AI projections distinguish confirmed and pending statistics where available |
| Outputs | Outpoint, value, spent state, inscription count/links and Rune-related source data |
| Sats and satpoints | Sat number/name, rarity, inscription count and source-supported location information |
| Inscriptions | ID/number, content type/length, sat, address, output, genesis height, timestamp and charms, where supplied |

Supported parsing also covers sat names and degree notation, explicit output/satpoint syntax, block hashes and inscription numbers.

**Boundary:** source capabilities differ. Bitcoin Core alone is not a general address, Ordinals or Rune index. Unknown fields remain unknown; these views are not a complete wallet portfolio or guaranteed spendable-balance calculation.

Evidence: `src/main/providers/normalize.js`, `src/renderer/views.js`, `src/main/ai-bitcoin-data.js`.

## 4. Easy inscription discovery

**User benefit:** browse visually and open interesting on-chain content without social-feed complexity.

- Dedicated Inscriptions tab with number, ID and recognized inscription-link lookup.
- Latest/earlier source pages, pagination and discovery within a specified block.
- Current-page media filters, including images, text, interactive content, audio/video, 3D, documents and fonts.
- Bounded raster previews; heavy or active content opens when selected.
- Recoverable loading, unavailable-source, offline and empty states.
- Search/block drafts are retained through loading and error updates.
- No social features, comments, likes, trading actions or wallet connection required to browse.

**Suggested copy:** “Discover inscriptions, then open the full experience.”

**Boundary:** exact number/ID lookup searches the configured source's index. Media filters apply only to the loaded page. There is no complete global keyword, collection-membership or content-text search index.

Evidence: `src/renderer/inscriptions.js`, `src/shared/discovery.js`, `README.md`.

## 5. Curated places to start

**User benefit:** recognizable projects and historical examples help a new user find something interesting immediately.

- “Popular to explore” sections in both the Inscriptions and Runes tabs.
- Six mainnet editorial picks per tab, with three shown initially and progressive expansion.
- Existing project logos/collection icons bundled for offline display.
- Creation context, exact identifiers, explanatory asset details and optional external references.
- Inscription cards open one exact example; optional safe artwork is separate from project branding.

Current Rune picks: DOG, RSIC, PUPS, Billion Dollar Cat, LOBO and Uncommon Goods.

Current inscription picks: NodeMonkes, Bitcoin Puppets, Quantum Cats, Bitcoin Frogs, Runestone and Inscription #0.

**Suggested copy:** “Not sure where to start? Explore curated Bitcoin projects and artifacts.”

**Boundary:** these are editorial introductions, not live popularity rankings, endorsements, authenticity certificates, market-price feeds or complete collection galleries. Third-party logos and artwork are not automatically licensed for a promotional partner strip. Runestone is an inscription project, not a Rune token.

Evidence: `src/shared/popular-assets.js`, `src/renderer/popular-assets.js`, `docs/POPULAR_DISCOVERY.md`, `docs/POPULAR_ASSET_LOGOS.md`.

## 6. A more readable inscription viewer

**User benefit:** art is centered and readable data looks like readable data, with the technical record available on demand.

- Automatic content-appropriate previews.
- Fit-to-view and actual-size image presentation, zoom, crisp-pixel options and background choices.
- Theme-aware selectable text and formatted/source JSON views without rounding large integer tokens.
- Original-content access, Save original, bookmarks and copyable identifiers.
- Expandable Details, source information, Record, dependency Graph and Inspect tools.
- Loading deadlines, retry/recovery and disposal when leaving a view.
- Bounded decoding for Brotli, gzip and deflate in the supported preview paths.

**Suggested copy:** “Made for the content—not just the transaction.”

**Boundary:** raw JSON that happens to describe BRC-20 can be read as inscription content. There is no dedicated BRC-20 token interface, index, balance view or trading support.

Evidence: `src/renderer/inscription-display.js`, `src/renderer/inscription-viewer.css`, `src/shared/inscription-presentation.js`, `docs/INSCRIPTION_FORMATS.md`.

## 7. Interactive 3D inscriptions

**User benefit:** inspect an on-chain object as an object, instead of downloading an unsupported file.

- glTF 2.0, GLB 2.0 and ASCII/binary STL viewers.
- Centered fit, studio lighting, rotate, zoom and reset controls.
- Mouse, supported touch/pinch and keyboard interaction.
- Optional auto-rotation and supported model animation controls; no automatic playback claim.
- Original geometry/materials and admitted textures, with bounded embedded/on-chain resources.
- Isolated local rendering, explicit unsupported-content errors and Save recovery.

**Suggested copy:** “Explore Bitcoin in three dimensions.”

**Boundary:** not a universal 3D importer. OBJ, FBX, USDZ, glTF 1.x and certain compressed-texture/geometry extensions are not supported previews. Arbitrary external model dependencies are blocked. GPU, size and complexity limits apply.

Evidence: `src/model-viewer/`, `src/shared/model-inscription.js`, `docs/3D_INSCRIPTIONS.md`.

## 8. More than pictures: media, documents and data

| Family | Current experience | Important limitation |
| --- | --- | --- |
| Images | PNG/APNG, JPEG, GIF, WebP, AVIF, BMP and ICO; SVG preview | Native format/animation behavior varies; scripted original SVG is a separate sandboxed path |
| JPEG XL | Local compatibility decoding when needed | Still-image fallback, not animation/HDR fidelity assurance |
| Interactive HTML/XHTML | Authored content in an opaque sandbox | External networking is blocked by default; some experiences need unavailable dependencies |
| Text and code | Plain text, JSON, CSS, JavaScript, Python, YAML, XML and other readable MIME aliases | Shown as text, not executed or semantically verified |
| Markdown | Readable document formatting and Source view | Raw HTML remains inert; external images do not automatically load |
| Audio/video | Native controls for supported MP3/FLAC/Ogg/WAV/MP4/WebM and related types | Recognized containers do not guarantee every codec/platform combination; no autoplay |
| PDF | Page navigation, fit width, zoom, rotation and extractable text view | PDF scripts/forms/active document interactions disabled; encrypted files need another reader |
| Fonts | Editable specimen, size control, letters/numbers/symbols | Font is isolated, not installed into the OS or browser UI |
| Other binary data | Bounded hexadecimal/ASCII inspection and Save original | Not a semantic CBOR/protobuf/torrent parser and never an executable runner |

**Suggested copy:** “Art, audio, documents and interactive content—inside one Bitcoin browser.”

**Boundary:** do not advertise “every inscription format,” “40 completely different formats,” or complete live ord.io parity. The tested registry has 40 MIME/codec/charset rows, and native qualification is narrower than registration coverage.

Evidence: `docs/INSCRIPTION_FORMATS.md`, `src/document-viewer/`, `src/renderer/document-frame.js`.

## 9. Runes that are easier to understand

**User benefit:** understand a Rune's identity, supply and issuance rules without starting with raw protocol JSON.

- Dedicated Runes sidebar tab and source-backed creation-order listing.
- Exact name, ID and recognized-link lookup; spaces can stand in for name separators.
- Current-page name filtering and pagination.
- Name, number, Rune ID, symbol, creation/protocol-defined origin and decimal places.
- Available supply, total created, initial allocation/premine and permanently burned amounts.
- Mint status at retrieval, units per mint, completed mints, mint limit, maximum issuance and effective start/end block bounds, where applicable.
- Links to the creation transaction, block and linked inscription when supplied.
- Source/network/retrieval labels, bookmarks, copyable ID/name and technical details.
- Exact integer accounting with divisibility-aware display.

**Suggested copy:** “Understand Runes. See the supply, rules and on-chain record.”

**Boundary:** this is read-only exploration. No minting, swaps, purchases, market cap, price chart, volume, floor price, holder ranking, complete transfer feed or address-level Rune portfolio UI. “Available supply” is not a wallet balance. A suitable Ord Rune index is required.

Evidence: `src/renderer/runes.js`, `src/shared/runes.js`, `src/main/providers/ord-runes.js`.

## 10. Ask Bitcoin: a local-AI research workspace

**User benefit:** ask a question in everyday language, then open the Bitcoin records behind the answer.

Connection and chat:

- Explicit connection to a user-run LM Studio or Ollama server on the same computer.
- Port/address entry, model discovery/selection, setup guidance, progress, cancellation and actionable errors.
- Optional user-entered LM Studio token retained only for the in-memory session.
- Familiar message layout, inert text formatting, inline result cards, Copy answer, Stop, retry and New chat.
- One main content scroll area, anchored header/composer and Jump to latest.
- Reading older messages pauses automatic following. Returning from a result through Ask Bitcoin preserves the connection, draft, chat, disclosures and scroll position while that session remains open.
- Clear separation between server discovery and actual model-response status.
- Explicit read-only Bitcoin-data toggle; model/network changes start a new chat.

Data tools:

- Discover enabled source names/capabilities without exposing their credentials.
- Check available chain/node-sync, mempool and fee-estimate data.
- Look up transactions, blocks, addresses, outputs, sats, inscriptions and Runes.
- Read bounded inscription text and selected related Ord records.
- Browse bounded inscription/Rune listing samples and search the bundled featured catalog.
- Use eligible local Core/Ord sources or configured public sources, respecting routing/network/offline constraints.
- Return browser-produced, source-labeled cards that open exact records in normal tabs.

**Suggested copy:** “Ask in plain English. Explore the source-backed results.”

Example prompts to demonstrate, not promises of guaranteed success:

- “Find a highly recursive inscription for me to explore.”
- “Find DOG in the featured Rune catalog and explain its current on-chain details.”
- “Explain the inputs and outputs of this transaction: [public transaction ID].”
- “Check my Bitcoin Core sync status using local sources only.”

**Boundary:** the app does not install/run the AI service or supply a built-in model. Tool-capable model behavior varies and explanations can be wrong. A local endpoint does not prove its server performs all inference locally. Bitcoin identifiers may go to configured public providers. The model cannot inspect wallets/credentials/history, sign, spend, broadcast, execute code, read arbitrary files, open arbitrary URLs or change settings. Binary art, PDFs, audio and 3D are not visually interpreted by the AI. Chats are memory-only and disappear on tab closure/restart; do not advertise durable chat history or token streaming.

Evidence: `docs/LOCAL_AI.md`, `src/renderer/ai.js`, `src/renderer/ai.css`, `src/main/local-ai.js`, `src/main/ai-bitcoin-tools.js`.

## 11. Recursive-inscription research

**User benefit:** find examples of on-chain content reuse and inspect the resources an inscription references.

- A Find recursive art starter and browser-owned handling for clear direct search requests.
- A small candidate set derived from documented artwork examples, inspected through configured sources.
- Exact-ID/number inspection with bounded reference traversal, source evidence, counts, observed hops, unresolved reads and partial-result notices.
- Browser-generated factual summaries for recursion-tool results, distinct from general model prose.
- Developer graph inspection for reference structure, cycles and limits.

**Suggested copy:** “Discover how inscriptions build on other on-chain content.”

**Boundary:** recursion is content/data reuse, not parent/child ancestry or repeated UTXO spending. Static inspection is not proof of runtime execution, a longest-path measurement, an authenticity check or a global “most recursive” ranking. Core alone has no Ord recursion-search RPC.

Evidence: `src/main/ai-inscription-recursion.js`, `docs/LOCAL_AI.md`, `src/main/resolver.js`.

## 12. Optional guided local-node setup

**User benefit:** start exploring without a node, then take more control when ready.

- A five-step walkthrough for Bitcoin Core + Ord, Core only, Ord only, or neither.
- Choose supported pinned program downloads, an installed executable, or an existing running service.
- Separate actions for downloading, reviewing/saving configuration and starting services.
- Fresh dedicated app-managed data/configuration locations, loopback RPC/HTTP and storage review.
- Status, sync/index progress, app-managed start/stop, bounded logs and opt-in autostart.
- Resume a saved setup and retain advanced executable, argument and service controls.
- Connected external services are not claimed as browser-owned processes and are not stopped by the browser's managed-service controls.
- Mainnet, testnet, signet and regtest settings, with reviewed regtest peer controls for newly managed test chains.

**Suggested copy:** “Your node, at your pace. Connect what you already run—or follow the setup guide.”

**Boundary:** node software, storage, time and index requirements still apply. Managed Ord needs a suitable archival Core with the required indexes/settings; “Ord only” does not remove that dependency. Automatic software-download coverage is narrower than the browser build-target matrix. Downloads are pinned for integrity, not a claim that publisher signatures were verified by this workflow. Native installation and safe node shutdown require platform qualification. No wallet is created or funded by the walkthrough.

Evidence: `src/renderer/node-setup.js`, `src/main/node-setup-plan.js`, `src/main/node-setup-manager.js`, `README.md`.

## 13. Compact and snapshot-assisted node choices

- Compact/pruned Core, Quick-start compact Core and Complete archive choices.
- Guided explanation of storage and historical-lookup tradeoffs.
- An opt-in local-file AssumeUTXO snapshot-import workflow for supported new mainnet/Core setups.
- Distinct “Current with network” and “Historical validation” status; no false equivalence between them.
- Explicit file selection/import confirmation and conservative recovery after uncertain import outcomes.

**Suggested copy:** “Choose a storage approach that fits your setup.” Keep snapshot assistance in an advanced section or FAQ, not the hero promise.

**Boundary:** the user obtains the snapshot separately; the browser does not automatically choose a mirror/download it. Historical validation still runs and downloads historical blocks. No instant sync, bandwidth-savings guarantee, fixed total disk cap, witness-free full node, or history-from-start-date retention. Real snapshot import/background-validation qualification remains open.

Evidence: `docs/QUICK_START_NODE.md`, `src/main/node-snapshot-manager.js`, `src/renderer/node-setup.js`.

## 14. Choose your data sources

**User benefit:** understand and control where your browser gets information.

- Local Ord, Bitcoin Core JSON-RPC and mempool-compatible REST adapters.
- Source enable/disable/edit, health checks, explicit preference and capability-aware fallback.
- Network-specific eligibility and visible source attempts/provenance.
- Local-only provider routing and offline cache-only mode.
- On-disk content caching with user-configurable capacity/resource limits and explicit cache misses.
- Encrypted storage for supported provider credentials when OS encryption is available, with reviewed recovery/cleanup paths.

**Suggested copy:** “Public sources when convenient. Your own node when preferred.”

**Boundary:** a local-only source policy is not whole-machine network isolation. Offline mode does not disconnect separate Wallet Bridge extensions or an independently running node. Public services have their own privacy/availability policies. Cache access is limited to eligible data already available locally.

Evidence: `src/main/provider-manager.js`, `src/main/resolver.js`, `src/renderer/views.js`, `docs/DATA_SOURCES.md`.

## 15. Wallet separation and transaction inspection

**User benefit:** explore on-chain content without giving that content wallet authority.

- A separate Wallet Bridge window/partition for supported user-selected wallet extensions.
- Explicit discovery, connection approval, public-account disclosure and disconnect.
- No private-key or seed-phrase import into the browser.
- Local PSBT v0/conservative-v2 parsing and preview, with inputs, outputs, recognized scripts/addresses, available totals/fees and warnings.
- Packaged builds visibly and technically disable PSBT/message signing.

**Suggested copy:** “Browsing and wallet connections are kept separate.”

**Boundary:** this is not a wallet, a signing/trading product, a guarantee of third-party extension safety or universal wallet compatibility. Do not use “bank-grade,” “fully audited,” “funds are always safe,” or “connect any wallet.” Empty/test wallets and native compatibility qualification remain appropriate beta practice.

Evidence: `src/main/wallet-manager.js`, `src/main/wallet-protocol.js`, `src/wallet/`, `docs/WALLET_BRIDGE.md`.

## 16. Privacy, appearance and power-user tools

- Dark, light and system themes; responsive desktop layout and macOS window-control spacing.
- Visible keyboard focus, keyboard navigation, reduced-motion styles and progressive disclosure.
- Local history/bookmarks and case-insensitive saved-item search; local “collection” matching is not an on-chain collection index.
- No analytics/telemetry transport included in the current beta source.
- Explicit inscription-network compatibility controls, with external requests blocked by default.
- Opaque content frames, sandboxing, context isolation, no renderer Node integration and denied popups/privileged content access.
- Developer inspector for raw data, request attempts and bounded dependency graphs.
- Structured local logs, redacted diagnostic export, cache controls and built-in documentation/About information.

**Suggested copy:** “Simple when browsing. Detailed when you need it.”

**Boundary:** keyboard/reduced-motion implementations are not a completed accessibility certification. No app telemetry does not mean no network traffic or third-party logging. Diagnostics still require review before sharing. Do not expand unfinished team/contact/legal About details into invented public facts.

Evidence: `src/renderer/views.js`, `src/renderer/styles.css`, `src/main/content-protocol.js`, `src/main/window.js`, `src/main/index.js`, `src/main/diagnostics.js`, `src/main/preload.cjs`.

## 17. Distribution and open-source engineering

- MIT-licensed application source, with separate third-party dependency/asset obligations.
- Electron desktop release configurations for macOS, Windows and Linux on x64/arm64.
- Configured downloads: macOS DMG/ZIP; Windows setup EXE/portable EXE/ZIP; Linux AppImage/DEB/RPM/TAR.GZ.
- GitHub CI/release configuration with pinned tooling, source tests, focused boundary checks, dependency audits, native packaged-smoke stages and platform signing gates.
- Release staging creates a draft prerelease, not automatic public publication.
- Public product/bundle naming is Bitcoin Browser; compatibility-sensitive internal identifiers retain the old name.

**Boundary:** a configured target is not an available, tested download. No public repository/domain/download URL has been supplied in this handoff. No mobile app, web-hosted browser, app-store listing, automatic updater or universal Linux compatibility is promised. Release checksum-manifest work was explicitly deferred; do not invent a verification-download feature.

Evidence: `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/EARLY_BETA_PIPELINE.md`, `docs/RELEASING.md`, `LICENSE`.

## Claims to exclude from the landing page

- Search every inscription by any word, or browse every collection completely.
- Real-time popularity/market rankings, prices, portfolios, trading or BRC-20 support.
- Instant Bitcoin sync, no-history validation, witness-free full nodes or date-based retention.
- Guaranteed fully local/private inference, an included AI model, arbitrary autonomous agent control or AI wallet actions.
- All wallet extensions are safe/compatible; PSBT/message signing is available in the packaged beta.
- Every inscription/3D/media format renders perfectly on every OS.
- Universal privacy, anonymity, security certification, accessibility certification or guaranteed uptime.
- Public-beta readiness, downloads, partnerships, endorsements, testimonials or user counts that the owner has not confirmed.

## Evidence precedence

Current source and scoped tests take precedence over older aspirational prose. `docs/IMPLEMENTATION_STATUS.md` and the readiness/requirements documents determine qualification status. A passing automated check is not native visual evidence, a verified wallet matrix or a distributable artifact. Keep this inventory separate from the shorter visitor-facing page copy.
