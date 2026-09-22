# Product and technical specification

## 1. Executive summary

Bitcoin Browser is a cross-platform desktop application that makes Bitcoin and Ordinals addressable through familiar browser behavior. Users can enter a sat, inscription, transaction, block, output, address, rune, or recursive resource; navigate with tabs/history/bookmarks; choose local or remote data sources; inspect exact source attempts and raw data; render on-chain content in a hostile-content sandbox; and connect a wallet through a separate security boundary.

The product is not a Chromium fork, a custody wallet, or another website wrapper. It is a purpose-built Electron shell with a canonical Bitcoin navigation model and pluggable data plane. Local Bitcoin Core + ord operation is a first-class topology rather than an expert afterthought.

## 2. Vision

Make Bitcoin's addressable information layer feel as navigable, composable, inspectable, and sovereign as the web—without pretending arbitrary inscriptions are trusted websites or coupling users to one indexer.

## 3. Product principles

1. **Bitcoin-native addressability.** On-chain identifiers are locations, not search-engine keywords.
2. **Local sovereignty.** A fully local Core + ord path must be obvious, complete, and reliable.
3. **Source transparency.** Every resolved entity identifies its provider and attempts.
4. **Correctness over guessing.** Ambiguous inputs retain alternatives.
5. **Hostile content by default.** On-chain permanence is not trust.
6. **Wallet authority is separate.** Viewed content cannot become a wallet origin.
7. **Recursion is infrastructure.** Recursive resources use a resolver, cache, graph, limits, and developer tools.
8. **Low cognitive load, no capability deletion.** Defaults are simple; advanced functions remain available through progressive disclosure.
9. **Recoverable failure.** Offline, unsynced, incompatible, and provider failures are explicit and actionable.
10. **Extensibility through contracts.** Providers and future extensions integrate behind versioned interfaces.

## 4. Target users and jobs

### Collector/researcher

Needs to inspect inscription content/metadata, owners/outputs/sats, provenance, related locations, collections, and recursive dependencies without moving among multiple websites.

### Artist/developer

Needs to open exact inscription content, test recursion against different ord servers, inspect dependency graphs, save raw content, see MIME/hash/source details, and diagnose failures.

### Sovereign operator

Needs to browse exclusively through local Bitcoin Core + ord, monitor sync/health, avoid leaking target lookups, control caching, and operate offline after warming data.

### Trader/power user

Needs rapid keyboard navigation, multiple tabs, wallet connection, PSBT/message review, source fallback, raw data, and no loss of expert controls.

### Newcomer

Needs a forgiving omnibox, human-readable summaries, safe defaults, strong error guidance, and clear separation between viewing and signing.

## 5. Scope

### Included in v1 source candidate

- Bitcoin/Ordinals omnibox and canonical deep links;
- tabs, back/forward/reload, history, bookmarks, command palette;
- inscription content viewer and entity detail views;
- recursion transport/cache/graph/limits;
- provider abstraction and local/remote source management;
- Bitcoin Core, ord, mempool-compatible, and fixture adapters;
- wallet-extension bridge, public accounts, PSBT/message signing requests;
- local process management for preinstalled binaries;
- settings, diagnostics, accessibility/responsive foundations;
- packaging and security gates.

### Non-goals for this release

- custody, seed/private-key import, key generation, or backup;
- inscription creation/minting transaction construction;
- marketplace matching, fiat prices, escrow, or order books;
- consensus implementation or replacement for Bitcoin Core;
- bundled node/indexer binaries or chain data;
- malware/content-moderation guarantee;
- automatic source consensus;
- universal wallet compatibility claim;
- secure auto-update without owned signing/update infrastructure.

## 6. Terminology

- **Target:** Parsed navigation intent, independent from any provider.
- **Canonical address:** Stable local string stored in tabs/history/bookmarks.
- **Entity:** Normalized data returned by a provider for a target.
- **Content resource:** Raw bytes under `/content/<inscription-id>`.
- **Recursive endpoint:** An ord `/r/*` endpoint addressable from inscription content.
- **Provider:** Adapter-backed data source with declared capabilities/network.
- **Attempt:** One provider resolution outcome.
- **Wallet Bridge:** Separate partition/window hosting injected wallets.
- **Local service:** User-configured preinstalled process managed by the app.
- **Opaque sandbox:** Iframe without same-origin privilege.

## 7. Functional requirements

### Navigation

**NAV-001 — Parse native targets.** The omnibox shall recognize all target kinds listed in the architecture domain model.

Acceptance:

- explicit prefixes produce deterministic targets;
- invalid explicit targets return `INVALID_TARGET`;
- bare inscription IDs/outpoints/satpoints/addresses are recognized;
- bare 64-hex and integer values expose alternatives;
- unrelated schemes are treated as search text, not executed.

**NAV-002 — Canonical persistence.** Tabs, history, and bookmarks shall store canonical targets rather than provider URLs.

**NAV-003 — Browser controls.** New/close/switch tabs, back/forward, reload, per-tab history, session restore, and shortcuts shall work without losing other tabs.

**NAV-004 — Deep links.** `satnav://` shall route to native targets/internal pages and support second-instance/open-url delivery.

**NAV-005 — External URLs.** HTTP(S) and `bitcoin:` links shall open only in the OS handler after native confirmation. Other schemes shall be rejected.

**NAV-006 — Search fallback.** Unrecognized text shall present grammar/help and never silently contact a general search engine.

### Entity browsing

**ENT-001 — Normalized summary.** Each adapter result shall expose schema version, target type/id/canonical/network, summary, bounded raw data, related links, source, and fetch time.

**ENT-002 — Progressive disclosure.** Default views shall show high-value summary/provenance; complete sanitized provider data and attempts remain available in the developer inspector.

**ENT-003 — Related navigation.** Normalized links shall navigate through canonical targets rather than external provider pages.

**ENT-004 — Errors.** Failed navigation shall preserve target, stable error, retryability, and attempts, with Retry and Data sources actions.

### Inscription and recursion

**REC-001 — Custom transport.** `ord://content/<id>` and `ord://r/<path>` shall resolve through the configured provider layer.

**REC-002 — Safe namespace.** Traversal, backslashes, NULs, unrelated paths/schemes, unsafe queries, and oversized paths shall be rejected before provider access.

**REC-003 — Caching.** Resolver cache keys shall include format revision, network, preferred source, accept value, and path. Content/volatile endpoints shall use distinct TTLs.

**REC-004 — Limits.** Resolver shall enforce request timeout, maximum resource bytes, bounded global concurrency, valid single-range handling, and offline cache semantics.

**REC-005 — Provenance.** Fresh resolver responses shall include provider ID/name, endpoint, fetch time, SHA-256, attempts, and cache status.

**REC-006 — Sandbox.** Inscription content shall render in an iframe with no preload, IPC, wallet injection, same-origin, popup, top-navigation, or download authority.

**REC-007 — External content network.** Default policy shall block inscription external networking. HTTPS-only compatibility shall require explicit setting.

**REC-008 — Graph.** Developer tooling shall breadth-first inspect explicit `/content` and `/r` references within configurable depth/node/scan-byte limits, reporting edges, cycles, errors, and truncation.

**REC-009 — Content export.** User-initiated save shall fetch through the resolver and write only after a native save dialog.

### Providers and sovereignty

**SRC-001 — Capability routing.** Providers shall declare network and capabilities. The manager shall filter and order candidates independent of renderer code.

**SRC-002 — Fallback.** Transport/provider failures shall proceed to eligible fallbacks and retain attempts. Invalid target/resource-limit failures shall not be hidden.

**SRC-003 — Health.** Users shall run health checks and see latency, chain height/status where available, failure code, local/remote classification, and capabilities.

**SRC-004 — Preference.** Users shall set/clear a preferred provider without disabling fallback.

**SRC-005 — Local-only.** Users shall exclude non-loopback providers without deleting them.

**SRC-006 — Offline.** Users shall prevent network entity resolution and allow cached recursive reads, including stale reads with explicit status.

**SRC-007 — Provider CRUD.** Users shall add/edit/remove provider configuration and capabilities. URLs shall reject embedded credentials.

**SRC-008 — Secret storage.** Provider secrets shall be stored only through OS encryption; unavailable encryption shall produce an actionable failure.

**SRC-009 — Local topology.** The app shall support loopback ord and Bitcoin Core adapters as a complete operating mode.

### Wallet

**WAL-001 — Separation.** Wallet extensions shall load only in `persist:satoshi-browser-wallet`, never the browser partition.

**WAL-002 — No key import.** The app shall expose no private-key/seed import or generation path.

**WAL-003 — Discovery.** The bridge shall enumerate compatible injected providers and return bounded public descriptors.

**WAL-004 — Connection.** Account disclosure shall require user selection and wallet approval. Stored state shall contain public descriptors only.

**WAL-005 — PSBT inspection.** Users shall parse base64/hex PSBTs locally without connection and see counts, known totals, output types/addresses, fee status, hash, and warnings.

**WAL-006 — Signing boundary.** PSBT/message signing shall require connected state, native review, and wallet review. Requests from inscription content are impossible by architecture.

**WAL-007 — Extension lifecycle.** Users may load/remove unpacked wallet extensions through a native directory picker; file access is disabled.

**WAL-008 — Hardware wallets.** Hardware support shall be mediated through wallet extensions; the application session shall not request device permissions.

### Local services

**LOC-001 — Explicit configuration.** A local service requires stable ID, display name, absolute executable path, argument array, optional working directory, enablement, and autostart flag.

**LOC-002 — Safe spawn.** Processes shall launch with `shell:false`, no command string, no inherited Node injection variables, and no automatic binary download.

**LOC-003 — Lifecycle.** Start/stop/status/PID/logs shall be visible; quit shall terminate managed children gracefully then forcibly if needed.

**LOC-004 — Logs.** In-memory logs shall be bounded and distinguish stdout/stderr/system entries.

### Library/settings/diagnostics

**LIB-001 — History.** History shall be local, bounded, clearable, and de-duplicate rapid repeated target visits.

**LIB-002 — Bookmarks.** Bookmarks shall be canonical, durable, removable, and displayed on Start/Bookmarks.

**SET-001 — Themes/accessibility.** System/dark/light themes, keyboard operation, focus indicators, reduced motion, resize states, semantic labels, and high zoom shall be supported.

**SET-002 — Advanced controls.** Privacy, content networking, source policies, cache/resource limits, recursion limits, timeout, developer mode, paths, and diagnostics shall remain available.

**DIA-001 — Diagnostics.** Export shall use a native save dialog and redact fields matching password/secret/cookie/authorization/token patterns.

**OBS-001 — Telemetry.** No telemetry transport shall exist in the default source. The stored opt-in setting is reserved and must not imply data is sent.

## 8. UX requirements

### Information architecture

Persistent chrome:

- title row: brand, source readiness, command palette, wallet, settings;
- tab row: native tabs and new tab;
- navigation row: back/forward/reload, omnibox, bookmark, source selector, developer inspector;
- sidebar: Start, Bookmarks, History, Wallet, Data sources, Local node, Settings, About;
- status bar: source health, network, privacy profile, cache usage;
- optional developer drawer: Raw, Recursion, Sources.

### Cognitive-load strategy

- Use one primary action per page header.
- Prefer normalized summaries to raw JSON.
- Keep provenance visible without requiring developer mode.
- Put source switching in persistent chrome and detailed controls on one page.
- Use explicit badges for local/remote, online/offline, connected/disconnected, fallback/truncation.
- Preserve raw data, attempts, limits, credentials, services, and signing tools through progressive disclosure.
- Never remove a hard capability solely to simplify onboarding.

### Start screen

- Hero statement and one large browse field.
- Safe quick targets (`sat:0`, `/r/blockheight`, `/r/blockhash`) and internal destinations.
- Three high-signal metrics: sources, cache, network/mode.
- Recent and bookmarked lists with empty states.

### Inscription viewer

- Compact content-first layout.
- Header with identifier/source URL, Record, Save, Graph, Inspect, Bookmark.
- Full-height content canvas with checkerboard transparency background.
- Right information rail with sandbox status, normalized content summary, source, and warning.
- Narrow windows may collapse the rail, while details remain in Record/Inspect.

### Provider states

- unchecked, healthy, unhealthy, disabled, local, remote, preferred;
- source health does not remove edit/prefer/toggle controls;
- local-only/offline controls explain consequences;
- provider modal validates stable ID, type, network, URL, priority, capabilities, Core cookie, and optional secrets.

### Wallet states

- no bridge/no provider;
- providers discovered;
- connecting/user approval;
- connected with accounts;
- signing native review;
- wallet approval;
- success/rejection/timeout/bridge crash;
- extension installed/unavailable/removed.

### Loading/error/empty

- Entity navigation uses a non-destructive loading overlay.
- Existing tabs/chrome remain interactive.
- Errors preserve the target and attempts.
- Empty states always explain what creates data.
- Offline cache misses never masquerade as not-found.
- Local-service disabled/missing executable states disable Start with explanation.

### Keyboard

Minimum shortcuts:

```text
Cmd/Ctrl+L             omnibox
Cmd/Ctrl+T             new tab
Cmd/Ctrl+W             close tab
Cmd/Ctrl+R             reload data
Alt+Left/Right         back/forward
Cmd/Ctrl+Shift+P       command palette
Cmd/Ctrl+Shift+I       developer inspector
Cmd/Ctrl+Shift+W       wallet
Esc                    close overlays/suggestions
```

## 9. Technical architecture requirements

### Desktop framework decision

Electron is selected because extension injection and mature cross-platform web-content sandboxing are central requirements. Tauri reduces runtime footprint but does not provide equivalent Chromium extension-host behavior without substantial custom work. See ADR-001.

### Renderer model

- main and wallet renderers use context isolation and sandbox;
- no renderer has Node integration;
- inscription content is a nested sandbox without preload;
- no webview tag;
- no direct provider fetch in trusted renderer;
- all remote data inserted with text APIs.

### Networking

- main process only for provider requests;
- app session protocol for recursive resources;
- external inscription network blocked unless explicit HTTPS-only mode;
- wallet partition retains network access required by extensions;
- request timeout/byte limits at common HTTP layer;
- redirects remain subject to final fetch and content bounds; SSRF/DNS policy is a stable-release hardening item.

### Persistence/migrations

- schema-versioned JSON state;
- atomic temporary rename and previous-file backup;
- migration merges defaults and validates providers;
- tabs/history/bookmarks/services/extensions survive upgrades;
- unknown fields may be preserved only when harmless; secret values never migrate into plaintext.

### Packaging

- ASAR enabled;
- fuses disable RunAsNode, Node options/inspect, and non-ASAR loading;
- hardened runtime and entitlements for macOS;
- NSIS configurable install path on Windows;
- AppImage/deb/tar.gz on Linux;
- deep-link protocol registration;
- signing/notarization owned by distributor.

## 10. Performance and SLOs

Source candidate targets; verify in packaged benchmarks:

| Metric | Target |
|---|---:|
| Warm app shell visible | < 1.5 s median on reference hardware |
| Omnibox parse feedback | < 50 ms p95 excluding IPC scheduling |
| Tab switch to local view | < 100 ms p95 |
| Cached recursive first byte | < 100 ms p95 for small resources |
| UI response to source failure | timeout setting + < 250 ms rendering |
| Main-renderer long task | no task > 100 ms during common navigation |
| Idle CPU | < 1% average after source checks settle |
| History/bookmark operations | < 100 ms p95 |
| Managed log memory | bounded to configured implementation limit |
| Crash-free session rate | > 99.5% in stable telemetry-enabled opt-in deployments |

Remote resolution latency is provider-dependent and must be displayed rather than hidden.

## 11. Privacy

- History/bookmarks/settings remain local.
- Telemetry transport is absent.
- Remote providers learn targets they resolve.
- Fallback may contact multiple providers; attempts make this visible.
- External inscription networking is blocked by default.
- Strict deployments use local-only Core + ord.
- Diagnostics are user-triggered and redacted.
- No wallet key material is collected.

## 12. Observability

Local structured events should cover app start, provider failures, protocol errors, extension loading, service lifecycle, state recovery, and renderer crashes. Logs must avoid content bodies, account public keys unless required, provider credentials, PSBT payloads, signatures, or full browsing history.

## 13. Testing strategy

### Unit

- grammar/canonicalization/ambiguity/fuzz corpus;
- provider validation/normalization;
- cache keys/TTL/range/pruning;
- recursive path and graph limits;
- PSBT corpus and mutation fuzzing;
- state migrations and corruption recovery;
- error serialization/redaction.

### Integration

- local HTTP fixture providers for ord/mempool failure and malformed responses;
- Bitcoin Core and ord on regtest;
- protocol fetch from sandboxed frames;
- IPC sender rejection from untrusted frame and wallet contexts;
- wallet fixture extensions;
- managed service lifecycle.

### End to end

- packaged Playwright/Electron flows for tabs, omnibox, settings, providers, offline, content, graph, wallet, service, diagnostics, deep links;
- hostile inscription fixtures;
- cross-platform installer/signature/deep-link behavior.

### Security

- dependency/SBOM review;
- Electron baseline scan;
- CSP/permissions runtime assertions;
- SSRF/redirect/DNS rebinding tests;
- content/resource exhaustion tests;
- extension boundary tests;
- local path/process tests.

## 14. Failure and recovery

- state load failure falls back to backup, then defaults;
- cache index repair drops missing/size-mismatched objects;
- provider failure records attempt and falls back;
- all-provider failure preserves attempt list;
- wallet bridge crash rejects pending requests;
- wallet timeout returns retryable error;
- local service exit updates status/logs;
- app quit stops managed services;
- offline cache miss is distinct from not-found;
- renderer crash is logged and may be manually reloaded; automatic crash-loop recovery is a future item.

## 15. Release phases

### RC1 (this source)

Core navigation, adapters, recursion, sandbox, wallet bridge, services, settings, tests, packaging scaffolding.

### Stable v1

Complete packaged integration/security matrix, pinned lockfile/SBOM, signed artifacts, exact supported node/ord/wallet versions, hostile-content fixtures, accessibility audit, SSRF hardening, crash recovery.

### v1.x

Collection adapter contract, multi-source comparison, request log waterfall, richer MIME viewers, content pinning/offline packs, Core/ord sync dashboard, declarative provider subprocess API.

### Future

Inscription-aware transaction simulation, rare-sat flow verification, audited minting workflows, signed plugin manifests/out-of-process extensions, collaborative local collections, secure optional update channels.

## 16. Prioritized implementation backlog

### Epic 0 — Release hardening

- E0-1 generate/review dependency lockfile and SBOM;
- E0-2 packaged test harness and hostile fixture extension/content;
- E0-3 SSRF/redirect/DNS policy for remote and local providers;
- E0-4 platform signing/notarization;
- E0-5 security contact and incident response;
- E0-6 crash-loop recovery and safe mode.

### Epic 1 — Local node excellence

- E1-1 Core/ord version/capability detection;
- E1-2 sync progress and estimated readiness;
- E1-3 cookie-file picker and permission checks;
- E1-4 regtest integration harness;
- E1-5 service dependency ordering and readiness probes;
- E1-6 guided but non-destructive local setup.

### Epic 2 — Recursion developer platform

- E2-1 runtime request waterfall and timing;
- E2-2 graph export/import;
- E2-3 per-tab pin/offline pack;
- E2-4 source/hash comparison;
- E2-5 syntax-aware source viewer;
- E2-6 module/resource diagnostics without redefining ord behavior.

### Epic 3 — Wallet assurance

- E3-1 versioned compatibility fixtures;
- E3-2 capability-scoped permission ledger;
- E3-3 address/account selector;
- E3-4 inscription/rare-sat transaction simulation;
- E3-5 signet hardware-wallet matrix;
- E3-6 explicit wallet result verification.

### Epic 4 — Ecosystem replacement

- E4-1 normalized collection interface;
- E4-2 collection/creator/trait views;
- E4-3 saved queries and workspace layouts;
- E4-4 export/shareable deep links;
- E4-5 multiple source comparison;
- E4-6 migration importers for browser bookmarks/ord explorer links.

## 17. Definition of done

A feature is done only when:

- functionality and failure states meet acceptance criteria;
- advanced behavior is preserved or explicitly migrated;
- input, resource, and permission boundaries are enforced;
- unit/integration/E2E tests cover malformed and failure paths;
- keyboard/accessibility/resizing/loading/error/empty states pass;
- source provenance and privacy effects are visible;
- packaged builds pass on affected platforms;
- docs and migration notes are updated; and
- no shortcut deletes difficult functionality instead of implementing it.
