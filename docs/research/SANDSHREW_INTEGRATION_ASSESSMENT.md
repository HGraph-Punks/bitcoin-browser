# Sandshrew integration assessment for Bitcoin Browser

## Executive decision

An optional, user-supplied Sandshrew API key is a worthwhile addition to Bitcoin Browser, provided the integration remains a replaceable, read-only data source. Its best product opportunity is a richer view of the Bitcoin, Runes and inscriptions associated with an explicitly selected address, supported by the same source-aware results in Ask Bitcoin. It should not become a prerequisite for ordinary browsing, a replacement for local validation, or a requirement for the first beta release.

The recommended investment is a small contract-validation prototype, followed by a constrained provider integration if the prototype passes. Broad integration with every Sandshrew namespace, arbitrary AI-controlled RPC, custom hosted indexes and trading functionality would add disproportionate beta risk. A useful integration does not require those features.

The assessment is dated **September 12, 2026**. Published capabilities, source-code observations and proposed behavior are distinguished throughout. No authenticated Sandshrew requests, account creation, billing operations, credential access or application changes were performed; production performance and account entitlements remain unverified.

| Decision area | Assessment |
| --- | --- |
| Optional managed Bitcoin/Ord data source | Good architectural fit; moderate incremental value over existing adapters |
| Rune holdings and richer address pages | Strongest incremental user benefit; contract and completeness validation required |
| Ask Bitcoin enrichment | High-value reuse of browser data, not unrestricted access to vendor APIs |
| Better inscription content delivery | Plausible, but binary transport differs materially from the existing Ord adapter |
| Global inscription keyword search, collections and popularity | Not established by the reviewed Sandshrew APIs |
| Local-only privacy or independent validation | Not a substitute for local Core/Ord |
| First-beta critical path | Keep separate from unresolved native and release qualification |

## 1. What Sandshrew actually adds

Sandshrew documents a unified JSON-RPC service over hosted Bitcoin Core, Esplora and Ord, with additional Rune methods. Authentication uses a key in the endpoint path, and the getting-started guide lists mainnet, testnet and signet endpoints under `/v1/`. The reviewed Oyl provider implementation also defaults to `v1` and constructs its URL from the host, version and project identifier.[^1][^2]

This is primarily infrastructure aggregation. Bitcoin Browser already has Core, Ord and mempool-compatible adapters, normalized navigation targets, provider preferences, fallback, provenance and offline/local-only controls. Consequently, many existing pages would gain another source rather than an entirely new capability. The value rises when Sandshrew removes the need to run additional address or asset indexes locally.[^3]

### Documented and source-backed capability map

| Data or operation | Evidence | Incremental browser value | Qualification needed |
| --- | --- | --- | --- |
| Blocks, transactions, node/mempool information | Hosted Core namespace; documentation says `txindex` is enabled.[^4] | Historical transaction availability and remote chain context | Actual Core version, permitted methods, history and response envelopes |
| Address statistics, UTXOs, transaction history | Esplora namespace maps RPC methods to explorer paths.[^5] | More complete address browsing without a local explorer index | Pagination, pending transactions, response limits and freshness |
| Inscription metadata, listing, sat and relationship reads | Ord namespace reference.[^6] | Alternate source for current inscription functionality | Deployed Ord version and field/path compatibility |
| Inscription content | `ord_content` returns base64 data in JSON.[^6] | Potential alternate media delivery path | MIME, encoding, delegation, size limits and range behavior |
| Rune metadata and listing | Oyl Ord client calls `ord_rune` and `ord_runes`.[^7] | Existing Rune pages can use another source | Precise integers, pagination and matching identities |
| Rune balances by address/output | `runes_address` and `runes_outpoint`; examples include balances, identifiers and divisibility.[^8] | A practical Rune holdings interface | Completeness, index height, historical parameters and pending semantics |
| Aggregated address asset snapshot | Oyl client exposes `sandshrew_balances` and its UTXO consumer uses the result.[^9][^10] | Potentially the best single-request address enrichment | Not covered by the main reference; treat as experimental until validated |
| Batched reads | `sandshrew_multicall` is documented.[^11] | Fewer network round trips for related reads | Billing per subcall, maximum batch size, partial errors and timeouts |
| Custom derived indexes | Metashrew supports custom WASM index programs.[^12] | Possible future specialized search or analytics | Separate index development, hosting agreement and operating costs |

The aggregated address response deserves particular attention. Oyl's consumer separates `spendable`, `pending` and `assets`, uses `metashrewHeight`, and maps Bitcoin Rune data from `ord_runes`; another field named `runes` is interpreted there as Alkanes. This is evidence of client expectations, not proof of a stable hosted contract. Mapping every vendor field named “runes” to Bitcoin Runes would therefore be an unsafe assumption.[^10]

## 2. Where users would feel the improvement

### A useful address page, without turning the browser into a wallet

The most valuable first experience is: paste an address, see its Bitcoin summary, Rune holdings and inscriptions, then open any asset or transaction normally. Present token quantities in ordinary decimal form, keep the exact base-unit amount available in details, and show when the source last indexed the data. A holdings row should link to the existing Rune page, not a new vendor-specific explorer.

This should be described as **assets at this address**, not **your complete wallet**. A wallet may have multiple receiving, payment and change addresses, and an address may belong to somebody else. The first version should neither enumerate wallet accounts nor derive address sets from an extended public key. A later explicit multi-address selection could be added independently, with clear disclosure of the additional information sent remotely.

The current AI already projects some address/output Rune and inscription fields when an eligible source supplies them. The gap is a dependable aggregate contract and a polished, reusable holdings presentation—not a complete absence of asset data in the application.[^14]

### Better Ask Bitcoin answers

Useful examples would include “Which Runes are at this address?”, “Show its inscriptions”, and “Explain the inputs and outputs of this transaction.” The browser should calculate quantities and produce result cards; the model should explain those structured results. Missing index coverage must become “not available from this source,” not a zero balance.

This should extend existing closed tools or add a narrow `get_address_assets` capability. It does not require giving the model the API key, endpoint URL, provider object or a generic RPC method argument. The same address snapshot must be reusable by the normal page and the AI so they cannot silently disagree about balances, network or freshness.

### A complement to compact local nodes

| User setup | Sensible role for Sandshrew |
| --- | --- |
| No local services | Optional managed source for chain and indexed asset data |
| Compact/pruned Core | Explicit remote historical/asset supplement; never presented as locally verified history |
| Archival Core without an asset index | Supply Ord/Rune/address capabilities that Core alone does not provide |
| Core plus suitably indexed Ord | Convenience or explicitly allowed fallback; smaller incremental benefit |
| Local-only or offline mode | No remote Sandshrew requests, including probes and AI activity |

A current Ord address endpoint can already expose address assets when its address index is enabled. Rune endpoints likewise depend on the Rune index. Sandshrew's advantage here is managed availability and convenience, not exclusive ownership of this capability.[^13]

## 3. What this will not automatically solve

The reviewed reference and client sources do not establish global inscription full-text search, collection-name search, trait filters, authoritative collection membership, live market prices, floor prices, Rune holder rankings or network-wide recursive-inscription rankings. Listing inscriptions and fetching known IDs are not equivalent to searching their meaning. The browser should not advertise an ord.io-like global discovery backend merely because an API key is connected.

Recursion is especially important: content can reference other inscription content or approved on-chain data; parent/child provenance is a different relationship. Ord gives recursive endpoints compatibility guarantees that its ordinary server endpoints do not share. Neither those endpoints nor a hosted Core connection directly provides a global “most recursive” ranking.[^15]

Bitcoin Browser's current inspector performs bounded static dependency traversal and its finder starts with a small curated candidate set. Sandshrew might supply the bytes for those same scans, but better data transport does not create a reverse-reference index or discover every recursive artwork. Dynamic code, unused references, delegation and changing sat pointers also prevent a static count from becoming a definitive complexity score.[^14]

Metashrew offers a possible foundation for custom derived data, but a search product would still require index design, backfill, reorg handling, query semantics and operational ownership. A content search service may also need off-chain text/search infrastructure rather than just a chain-state WASM view. Its feasibility should be evaluated as a separate product, with an explicit definition of search coverage.

BRC-20, Alkanes, swaps, minting and trading should remain outside this integration. Their availability elsewhere in Sandshrew/Oyl does not make them necessary for the browser's current Bitcoin-and-Runes scope.

## 4. Pricing and practical economics

The official production site advertises the following plans at the assessment date.[^16]

| Plan | Advertised monthly price | Advertised daily requests | Users |
| --- | ---: | ---: | ---: |
| Starter | Free | 100,000 | 1 |
| Developer | $295 | 1,000,000 | Up to 2 |
| Team | $1,995 | 10,000,000 | Up to 5 |
| Custom | Negotiated | 10,000,000+ | Unlimited |

The paid custom-metaprotocol plans also list storage at $0.10/GB/month. This is not evidence of a general inscription-download bandwidth price. An older Vercel-hosted page advertises different, cheaper paid tiers; those figures should not be used to budget a new integration.[^16][^17]

For an individual browser user, the advertised free allowance makes the idea attractive. The jump to the first paid plan is substantial for a casual-user feature, however. The application should not imply a subscription is needed for ordinary browsing or recommend an upgrade until actual usage justifies it.

Important commercial details were not established: burst/concurrency limits, whether a multicall is charged once or per nested method, failed-request charging, response/egress limits, daily-reset rules, overage behavior, key-specific quotas and any free-tier restrictions on advanced aggregate methods. Account-dashboard entitlements should take precedence over public marketing. Published requests/day cannot be treated as a guaranteed instantaneous throughput rate.

### Illustrative request model—not measured vendor billing

Count upstream method executions as well as HTTP requests. Let `M` be uncached logical method calls, `R` additional retry attempts, and `B` the supported batch size. Logical work is approximately `M + R`; batching may reduce HTTP requests toward `ceil(M / B)`, but it does not establish lower billable usage. Account usage can also include other applications using the same key.

| Illustrative activity | Assumptions | Logical calls |
| --- | --- | ---: |
| One gallery page | 1 listing + metadata for 24 items + content for 12 visible items | 37 |
| One richer address page | 1 aggregate snapshot + 1 history page + details for 8 selected assets | 10 |
| One bounded recursive inspection | 36 content reads + 36 separate MIME/metadata reads, if needed | Up to 72 before retries and root resolution |
| Example active day | 50 gallery pages + 20 address pages + 20 scans | 3,490 before other activity |

The example is about 3.5% of the advertised Starter daily allowance under the assumed accounting. It is not a promise that every user fits, every method is included, or every request is cheap. Content-heavy inscriptions can consume substantial bandwidth and memory while using few logical calls, and repeated failed retries can erase the benefit of caching.

A per-installation request budget is useful but is not a provider billing cap. Display “requests made by this browser” unless an authenticated usage API is verified. Do not display a fabricated account balance, dollars remaining or exact quota-reset countdown.

## 5. Recommended UX

Place the connection under the existing data-source settings, with a plainly named **Connect Sandshrew** action. Explain that it is optional, uses the user's own account, and sends requested public Bitcoin identifiers to a remote service. Normal browsing and local setup remain available without it; no additional left-sidebar destination is needed.

The setup flow should accept the key in a dedicated secret field, validate the selected network, run a bounded connection check, and summarize which capabilities actually worked. It should distinguish “key accepted,” “Rune index available,” “index catching up,” and “content delivery unavailable.” One successful Core health call must not turn every asset feature green.

After connection, improve existing address, Runes and inscription pages in place. Keep source and freshness information compact but discoverable. Show a small remote-source indicator and expand the technical details only on demand; do not place RPC namespaces, index implementation names or raw response objects in the main experience.

Source choice must be explicit. Adding a key should not reorder existing sources or silently enable paid remote fallback. A user can choose Sandshrew for normal lookups or allow it as an additional source; an existing local-only setting always wins. Selecting a local service in Ask Bitcoin must continue to exclude remote equivalents.

Use actionable failure messages: “Key rejected—replace it,” “Request limit reached—try later or choose another allowed source,” or “Rune data is still indexing.” Preserve successful partial results and explain omissions. Disconnect should stop future requests immediately, with separate choices to remove the locally stored key and to visit the vendor dashboard for revocation; disconnecting the browser is not server-side revocation.

## 6. Technical integration: fit and nontrivial changes

### Provider and capability boundaries

Introduce a real `sandshrew` provider type, not a disguised Core or Ord instance. Keep one connection/account identity while exposing independently qualified capabilities. Internal namespace helpers can share a transport and request budget, but public configuration should remain provider-neutral.

The current validator recognizes only Ord, mempool, Core and mock types, and strips non-root URL paths. Pasting a `/v1/KEY` URL into an existing source is therefore not a working integration. More importantly, allowing that URL to persist would place authentication material in a configuration object that the base provider clones into descriptors.[^18]

| Existing area | Required integration work |
| --- | --- |
| `constants.js`, `validation.js`, `provider-manager.js` | Register the provider, validate secret-free configuration, preserve routing and shutdown fences |
| `provider-credential-coordinator.js`, `provider-recovery.js` | Add an explicit API-key credential kind and matching recovery/remove behavior |
| `secure-store.js`, settings/IPC | Store only through the secret lifecycle; expose status, not a recoverable key |
| `http.js`, error serialization, logger | Use bounded remote HTTPS, fixed origins, denied redirects and secret-safe errors |
| `providers/normalize.js`, `providers/ord-runes.js` | Normalize namespace-specific schemas without rounding or changing units |
| `resolver.js`, content delivery | Adapt encoded content only after MIME, limits and recursive semantics are established |
| `ai-bitcoin-data.js`, `ai-bitcoin-tools.js`, `local-ai.js` | Extend capability-aware data access without bypassing strict source selection |
| Address/Rune views and source settings | Add reusable holdings UI, explicit consent, partial results and freshness |

These are source observations and proposed changes, not a claim that a Sandshrew implementation currently exists. The relevant routing, resolver and AI source contracts are linked in the implementation evidence.[^18][^19][^20]

### Explicit RPC mapping

Use a closed map from validated browser operations to literal vendor methods. Esplora's colon-separated placeholders and Ord's method/path mapping are transport conventions, not permission to accept arbitrary paths. Keep identifiers such as `840000:22` in parameter positions rather than splitting their colon as a method delimiter.

Validate JSON-RPC IDs, expected envelopes and per-item results, including documented legacy-shaped Core responses where appropriate. Treat HTTP 200 containing a JSON-RPC error as failure. Reject mismatched identities, unexpected scalar/object shapes and oversized responses; return stable application error codes without reflecting raw vendor messages.

Do not assume multicall gives an atomic chain snapshot. Independent indexes can be at different heights even when their results arrive in one HTTP response. Preserve the source namespace and observed height/hash for each relevant section, and avoid describing combined results as consistent at one block unless that contract has been established.

### Exact amounts and schema compatibility

Rune amounts can be 128-bit integers. The current Rune adapter already preserves numeric JSON tokens before normalization, validates identities and computes supply using integer arithmetic. A generic `JSON.parse` of the RPC envelope followed by reserialization could round an amount before the existing safeguards ever see it.[^21][^22]

Use lossless parsing at the original response boundary for Rune data, then normalize numeric types field by field. Keep balances as decimal base-unit strings, divisibility as a validated small integer, and display formatting separate from calculation. If the gateway itself has rounded values upstream, client parsing cannot repair them; authenticated conformance tests must compare large values with an independent canonical source.

The browser currently distinguishes Core BTC amounts from explorer satoshis partly through `source.type`. A combined provider makes that shortcut insufficient. Core fee estimates are denominated in BTC/kvB, whereas Esplora fee estimates use sat/vB; Core transaction outputs also have different shapes and units from explorer outputs. Normalize by originating method/schema, not by the Sandshrew brand, and include previous-output normalization.[^20][^23][^24]

Old inscription examples use fields such as `inscription_id`, `inscription_number` and `genesis_height`; the browser expects its own normalized names. Add explicit compatibility mappings and verify returned ID/number correspondence. Never infer that a legacy singular parent field is proof that inscriptions can have only one parent.[^6][^19]

### Content is a separate delivery contract

The existing Ord adapter supplies byte buffers and HTTP headers, including optional ranges, to the recursive resolver. A base64 JSON result does not preserve that contract automatically. A dedicated decoder must establish actual MIME, encoded versus decoded length, compression semantics and delegation behavior before returning a browser resource.[^6][^19]

Base64 needs `4 × ceil(n / 3)` characters for `n` bytes, before the JSON envelope. Additional text/buffer copies and decompression increase peak memory further. Bound the wire body, encoded field, decoded bytes and decompressed bytes separately; never silently raise the user's resource limits to accommodate the wrapper.

Without documented range support, the safe options are a bounded full download followed by local slicing of validated cached bytes, or an explicit unsupported response. Repeatedly redownloading a full video for every range request is not acceptable. A separate already-approved Ord content source can remain available, but any cross-source fallback must follow the user's selected policy and disclose provenance.

Continue using the browser's own sandboxed viewers. Do not insert `ord_preview` HTML into the privileged application DOM, load key-bearing URLs into image/frame elements, or expose the authenticated endpoint to recursive inscription scripts. Metadata support can ship before complete content transport, but the capability label must accurately describe that limitation.

## 7. Key safety, wallet boundaries and privacy

### Keep the API key out of general application state

Construct the authenticated URL only inside the main-process transport, immediately before the request. Persist a secret-free provider descriptor and bind the secret to the provider type, network, allowed destination and authentication mode. Key rotation, removal, failed persistence and recovery must follow the existing credential transaction model rather than an unrelated local-storage field.

The current coordinator handles username/password pairs and binds their lifecycle to provider state. It needs a deliberate API-key extension, including migration/versioning of binding metadata where necessary. Its pending, active, recovery and removal states must continue to prevent stale credentials from being reused for a changed destination.[^18]

The existing JSON sanitizer redacts selected property names; it does not redact secrets embedded in arbitrary strings, and its current pattern does not include `apiKey`. The HTTP response object can contain the final URL, and generic HTTP error construction can include a response-body excerpt. Therefore the new adapter must use safe error projections and redact before logging or publishing, not assume the generic helpers already protect path-embedded keys.[^18][^19]

Use exact production hosts, HTTPS, public-address DNS policy and no redirects for authenticated requests. Do not accept arbitrary proxy URLs for the first version. If a header-based authentication option is confirmed later, it may simplify handling, but it does not remove the need to protect errors, request dumps and crash diagnostics.

### Storage differs by platform

Electron documents platform-specific protection for `safeStorage`, including Linux's `basic_text` fallback when no suitable secret store is available and potential Keychain prompts on macOS. Its documentation also notes that consistent app signing matters to macOS credential access across updates.[^25]

Before enabling persistent API keys on a supported build, verify the actual bundled Electron behavior on that platform. Refuse insecure fallback storage; if a session-only key mode is implemented, label it clearly and drop application references on disconnect/exit. JavaScript cannot guarantee physical erasure from process memory or OS swap, and OS-backed storage is not protection against a fully compromised user session.

### Preserve the wallet boundary

Reading public address data does not require private keys, seed phrases, signing permissions or a wallet connection. Keep those capabilities absent from this provider and from AI tools. Never interpret the vendor's “spendable” classification as a spending guarantee; display classifications as source-reported data.

The Oyl provider includes a PSBT broadcast path and its RPC client exposes a broad method generator. Those are reasons to use it as contract evidence rather than import the entire wallet SDK into a read-only browser. They are not evidence that Sandshrew grants every customer every listed Core method.[^2][^9]

A minimal custom adapter using the browser's bounded transport is preferable to a full wallet SDK dependency. Oyl's dependency manifest includes signing/key-derivation libraries and unrelated protocol packages. Adding that surface would not improve the read-only requirement and would increase maintenance and review work.[^26]

### Be honest about privacy

The production-site privacy policy is effective February 15, 2024 and describes account, usage, device/IP and billing-related collection, with additional transaction-related language. The reviewed policy does not establish a no-logging promise or a precise retention period for address lookups. It should not be summarized as guaranteeing anonymous API use.[^27]

Architecturally, a keyed remote request lets the service associate the requested identifier with an account and connection metadata. Multiple address lookups can also reveal associations of interest even though the addresses are public. Local AI inference does not make its remote Bitcoin lookups local or anonymous; the setup copy should state that distinction directly.

Only validated identifiers and necessary RPC parameters should go to Sandshrew—not chat transcripts, browser history, bookmarks, local labels or wallet secrets. Returned asset metadata remains untrusted text: it cannot become an instruction to the AI, an arbitrary URL fetch or an HTML execution opportunity.

## 8. Freshness, reliability and request control

A healthy HTTP connection is not proof that Core, Esplora, Ord and a Rune index agree. Probe the specific capabilities that matter, record observations separately and display partial availability. Confirm network identity with an appropriate chain/genesis check; a host name or generic “testnet” label is not enough to distinguish supported test networks.

Prefer block-hash-anchored snapshots when available. Where a historical Rune query accepts a height but its reorg semantics are not documented, do not promise a stable historical portfolio. An index lag, missing page or failed method is different from a genuinely empty address.

Cache immutable content separately from mutable ownership, UTXO status, Rune balances and mintability. Keep fetched time and source/index metadata with each snapshot. Provider removal, network changes and local-only transitions must invalidate pending publication and prevent ineligible cached remote results from satisfying strict local requests.[^19][^20]

Add a shared scheduler per connection, with bounded concurrency, queued work, deduplication and retry budgets. Charge nested multicall work, background probes, content dependencies and retries against local limits. The existing ten-tool-call AI ceiling is not a vendor-call ceiling: one recursive inspection alone can attempt 36 resources, before extra metadata or provider retries.[^14]

Proposed initial settings for validation are four in-flight requests per connection, batches of at most ten methods, no automatic retry for authentication failures, and at most one transient retry within the original deadline. These are conservative application design choices, not published Sandshrew allowances; reduce them if the account contract requires it. Add a clearly labeled per-question logical-request budget and stop with partial results when exhausted.

Do not run background address monitoring by default. Pause automatic refresh in hidden views, abort queued work on navigation/disconnect and avoid retry loops during quota exhaustion. Removing a connection cannot guarantee that a request already accepted by the vendor is cancelled or unbilled, but it must stop further browser-originated work.

## 9. Evidence gaps that should change the implementation plan

| Unresolved question | Why it matters | Required evidence before relying on it |
| --- | --- | --- |
| Are advanced Rune/aggregate methods included on Starter? | Determines whether casual users get the promised benefit | Current entitlement plus authenticated success/error tests |
| Is `sandshrew_balances` a supported public contract? | Determines whether it can be the default holdings path | Versioned schema, completeness/pagination rules and index semantics |
| Is historical Rune state reliably available? | Determines whether date/height comparisons are truthful | Retention, reorg and pending-state specification |
| How are multicalls billed and bounded? | Prevents misleading usage estimates and request bursts | Accounting rules and maximum supported sizes |
| Are header auth, key scopes, restrictions and usage APIs available? | Determines credential and quota UX | Current dashboard/documentation or written vendor confirmation |
| Which Core/Ord versions and indexes are deployed? | Determines normalization, fees and content fidelity | Version/feature probes and a supported-version statement |
| Which testnet and signet features are supported now? | Avoids wrong-network and unsupported-batch failures | Network-specific contract tests; mainnet first until qualified |
| What are content byte/egress/range/encoding limits? | Determines whether Sandshrew can serve rich inscriptions well | Documented contract plus media tests |
| What are API-log retention, service terms and outage guarantees? | Affects privacy disclosures and dependency risk | Applicable current policy/terms, support/SLA information |
| Is a realtime subscription API actually supported? | Prevents building on an unverified websocket example | Official endpoint, authentication and event/reconnect contract |

The main documentation index does not resolve these operational questions. A consumer integration page contains a websocket example, but that is not enough to promise a Sandshrew production subscription API without matching vendor evidence.[^28][^29]

Some reference examples also contain parameter/response inconsistencies: the Rune address parameter description says `txid` although its example sends an address, and the inscription listing description and sample pagination shape do not establish an unambiguous cursor contract. Treat examples as discovery evidence, not test oracles. Capture actual sanitized wire responses during a later authorized prototype.[^6][^8]

## 10. Alternatives and opportunity cost

The existing sources remain the lowest-cost engineering option for ordinary browsing. Improving their address normalization and UX benefits every user, including those who never create an API account. A provider-neutral holdings contract should be reusable by local Ord and a future hosted adapter rather than making Rune pages Sandshrew-specific.

If the main objective becomes Rune discovery and holder analytics, UniSat merits a separate comparison: its official API reference explicitly documents Rune search/listing, holder endpoints and address balance lists. That is evidence of a more directly documented fit for those particular features, not a general conclusion that it is safer, cheaper or more reliable. Its commercial and privacy terms were not evaluated here.[^30]

Sandshrew's differentiated fit is the unified Core/explorer/Ord stack plus possible aggregate reads. A specialized marketplace API may be more appropriate for prices and trading volume, while a dedicated search index may be needed for content discovery. Avoid expanding the first integration to collect unrelated providers merely to fill every table cell.

## 11. Phased implementation recommendation

### Phase A: bounded contract-validation prototype

Validate mainnet against a dedicated user-approved development key and public fixtures, without changing normal provider defaults. Probe only the proposed read methods, capture sanitized response schemas, and compare a small fixed set of chain/asset facts with an independent source. Verify free-tier access, exact large Rune values, aggregate semantics, error shapes and request accounting.

Measure cold and warm gallery, address and AI workloads rather than only one RPC's latency. Record HTTP requests, nested methods, bytes, index lag and failures. Do not load-test the service or assume that a local time limit proves an upstream request has stopped processing.

### Phase B: optional provider and focused user benefit

Implement explicit API-key lifecycle, mainnet-only qualification, closed read methods, normalized provenance, request limits and connection settings. Add Rune holdings to an explicit address view and let Ask Bitcoin reuse that data. Preserve existing sources and make every new capability conditional on its own tests.

Use documented Rune/address methods where they meet the requirement. Prefer the aggregate shortcut only after its contract is confirmed; otherwise a bounded Ord/Esplora fallback can serve supported cases with a clear completeness limit. Do not replace an efficient aggregate with an unbounded scan of every UTXO on a large address.

### Phase C: deeper browsing integration

Add full content transport after binary/MIME/range testing, more efficient listing enrichment and carefully scoped historical comparisons if supported. Realtime updates, saved multi-address views and specialized derived indexes should each have a separate value and privacy decision. They are not prerequisites for delivering the main Rune/address benefit.

For planning, a constrained integration is approximately **13–23 focused engineering days**: 2–4 for contract validation, 4–7 for transport/credential/routing work, 4–7 for address/AI UX, and 3–5 for integration qualification. Full content transport could add 5–10 days. These are low-confidence engineering estimates, not measured project throughput; they exclude vendor response time and existing beta release blockers.

The repository's readiness documentation still records unresolved native lifecycle and packaged-release qualification. Do not treat a successful API prototype as clearing those gates, and do not make this optional integration delay fixes needed for every beta tester.[^31]

## 12. Acceptance criteria for a worthwhile integration

The feature should ship only if its claimed capabilities meet the following conditions. A failed advanced method can remain unavailable without blocking unrelated existing browsing, but credential isolation, source-policy enforcement and exact quantities are mandatory.

1. **Key containment:** synthetic key canaries do not appear in provider descriptors, state exports, diagnostics, logs, errors, cards, content URLs, cached metadata or AI requests. Replacement/removal and failed persistence cannot restore a stale key or change its destination binding.
2. **Closed authority:** only reviewed read operations are callable. Renderer, inscription and model input cannot select arbitrary RPC, nested multicall methods, endpoints, headers, wallet operations or broadcast calls.
3. **Source policy:** no Sandshrew sockets are opened while disabled, offline or local-only; strict local/service selections remain strict across cache hits, fallbacks and content dependencies. Disconnect and route changes cancel queued work and suppress late publication.
4. **Transport behavior:** authentication errors, rate limits, HTTP-200 RPC errors, partial batches, mismatched IDs, redirects, slow bodies and oversized responses produce bounded, useful failures without leaking secrets.
5. **Amount correctness:** values above `2^53`, u128 limits, zero balances, high divisibility, burned supply, fees and BTC/satoshi conversions round-trip exactly. Aggregated `ord_runes` cannot be confused with Alkanes fields.
6. **Data honesty:** returned identities match the query; duplicates and missing pages do not become complete holdings; index lag, empty results, unsupported endpoints and reorgs remain distinguishable. No address is described as a whole wallet without evidence.
7. **Content fidelity:** if claimed, test text/JSON, images, SVG, HTML recursion, audio/video, PDF, fonts and supported 3D models through the actual decoder/viewer boundary. Include malformed base64, MIME conflicts, compressed content, delegation and range requests.
8. **AI usefulness:** representative questions produce the same facts as the address/entity UI, openable source-backed cards and explicit partial results. Prompt-injection text cannot request secrets or expand RPC access, and expensive fan-out respects the shared budget.
9. **User control:** setup works with keyboard navigation and clear progress; rejected keys are replaceable; returning from an asset preserves chat; disabling the integration leaves all existing functionality intact.
10. **Platform qualification:** test credential storage/recovery and connection lifecycle on each advertised packaged platform. No secure-storage claim is made for an unqualified fallback backend.

Success should be judged by an actual new task becoming easy: a beta tester can inspect assets at an address and ask useful follow-up questions without running extra indexes or learning API terminology. If the integration only duplicates existing exact-ID pages while introducing account setup and a paid-service dependency, its priority should remain low.

## Sources and implementation evidence

All online sources were accessed September 12, 2026. Vendor documentation is descriptive evidence, not an authenticated service test. Undated pages are identified as such; a recent search crawl does not establish a recent API revision. Source branches can change, so the implementation prototype should pin its own fixtures and contract versions.

[^1]: Sandshrew, [Getting Started](https://docs.sandshrew.io/welcome-to-sandshrew/getting-started), undated; rendered guide reports an update approximately one year earlier. Authentication and network endpoint evidence.
[^2]: Oyl Wallet, [Provider implementation](https://github.com/Oyl-Wallet/oyl-sdk/blob/main/src/provider/provider.ts), `main` source as accessed; [raw source](https://raw.githubusercontent.com/Oyl-Wallet/oyl-sdk/main/src/provider/provider.ts). URL construction, v1 default and PSBT broadcast scope.
[^3]: Bitcoin Browser, [Data sources and local operation](../DATA_SOURCES.md), current local worktree. Existing adapters, capabilities, fallback, local-only and privacy design.
[^4]: Sandshrew, [Bitcoin Core namespace](https://docs.sandshrew.io/sandshrew-namespaces/btc-standard-bitcoin-rpc), undated. Hosted Core and transaction-index claims.
[^5]: Sandshrew, [Esplora namespace](https://docs.sandshrew.io/sandshrew-namespaces/esplora-block-explorer-apis), undated. JSON-RPC/explorer route mapping and indexed chain reads.
[^6]: Sandshrew, [Ord namespace](https://docs.sandshrew.io/sandshrew-namespaces/ord-inscriptions-runes), undated; [Markdown source](https://docs.sandshrew.io/sandshrew-namespaces/ord-inscriptions-runes.md). Metadata/listing examples, base64 content and preview HTML.
[^7]: Oyl Wallet, [Ord RPC client](https://github.com/Oyl-Wallet/oyl-sdk/blob/main/src/rpclient/ord.ts), `main` as accessed; [raw source](https://raw.githubusercontent.com/Oyl-Wallet/oyl-sdk/main/src/rpclient/ord.ts). Rune and address method names.
[^8]: Sandshrew, [Runes](https://docs.sandshrew.io/sandshrew-namespaces/runes), undated; [Markdown source](https://docs.sandshrew.io/sandshrew-namespaces/runes.md). Address/outpoint methods and optional block parameter examples.
[^9]: Oyl Wallet, [Sandshrew RPC client](https://github.com/Oyl-Wallet/oyl-sdk/blob/main/src/rpclient/sandshrew.ts), `main` as accessed; [raw source](https://raw.githubusercontent.com/Oyl-Wallet/oyl-sdk/main/src/rpclient/sandshrew.ts). Aggregate method, multicall and broad RPC generator. The public [file-history query](https://api.github.com/repos/Oyl-Wallet/oyl-sdk/commits?path=src/rpclient/sandshrew.ts&per_page=1) returned commit `b2aff87d634e3a54ceade7c5293f0601e5cc0a35`, dated August 7, 2025; this dates the client file, not the deployed service.
[^10]: Oyl Wallet, [UTXO processing](https://github.com/Oyl-Wallet/oyl-sdk/blob/main/src/utxo/utxo.ts), `main` as accessed; [raw source](https://raw.githubusercontent.com/Oyl-Wallet/oyl-sdk/main/src/utxo/utxo.ts). `addressUtxos` and `processSandshrewUtxo` consume the aggregate response and distinguish `ord_runes` from Alkanes.
[^11]: Sandshrew, [Multicall](https://docs.sandshrew.io/sandshrew-namespaces/multicall), undated; [Markdown source](https://docs.sandshrew.io/sandshrew-namespaces/multicall.md). Lists mainnet/testnet support and says signet support is ongoing; no current billing or atomicity contract established.
[^12]: Sandshrew, [What is Metashrew?](https://docs.sandshrew.io/metashrew/what-is-metashrew), undated; [Markdown source](https://docs.sandshrew.io/metashrew/what-is-metashrew.md), and [metashrew-runes repository](https://github.com/sandshrewmetaprotocols/metashrew-runes), source as accessed. Custom WASM indexing and open-source Rune index implementation.
[^13]: Ordinals project, [Ord JSON API](https://docs.ordinals.com/guides/api.html), current Handbook as accessed. Address and Rune endpoints, required indexes and non-market asset data.
[^14]: Bitcoin Browser, [Local AI documentation](../LOCAL_AI.md) and [recursive inspection implementation](../../src/main/ai-inscription-recursion.js), current local worktree. Current tools, static-scan scope, source boundaries and request limits.
[^15]: Ordinals project, [Recursion](https://docs.ordinals.com/inscriptions/recursion.html), current Handbook as accessed. Content access and recursive endpoint compatibility. Parent/child behavior is not used as a substitute for content-reference evidence.
[^16]: Sandshrew, [Official product and pricing page](https://sandshrew.io/), undated, production site as accessed. Advertised plans and custom-metaprotocol storage charge; not an account-specific offer.
[^17]: Sandshrew-branded [older Vercel deployment](https://sandshrew.vercel.app/), undated, as accessed. Conflicting older pricing; excluded from current budgeting.
[^18]: Bitcoin Browser, [provider base](../../src/main/providers/base.js), [configuration validation](../../src/shared/validation.js), [provider manager](../../src/main/provider-manager.js), [credential coordinator](../../src/main/provider-credential-coordinator.js), [provider recovery](../../src/shared/provider-recovery.js) and [secure store](../../src/main/secure-store.js), current local worktree. Code was inspected; stored credentials and application profile data were not.
[^19]: Bitcoin Browser, [HTTP transport](../../src/main/http.js), [Ord adapter](../../src/main/providers/ord-server.js), [recursive resolver](../../src/main/resolver.js), [normalizer](../../src/main/providers/normalize.js) and [logger](../../src/main/logger.js), current local worktree. Transport, headers, bounds, provenance and error-handling contracts.
[^20]: Bitcoin Browser, [AI Bitcoin data](../../src/main/ai-bitcoin-data.js), [AI tools](../../src/main/ai-bitcoin-tools.js) and [local AI manager](../../src/main/local-ai.js), current local worktree. Source-type selection, data projections, units and closed-tool execution.
[^21]: Ordinals project, [Rune specification](https://docs.ordinals.com/runes/specification.html), current Handbook as accessed. u128 amounts and canonical Rune identifiers.
[^22]: Bitcoin Browser, [Rune parsing and normalization](../../src/main/providers/ord-runes.js), current local worktree. Original numeric-token handling and integer arithmetic.
[^23]: Bitcoin Core, [estimatesmartfee, version 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/util/estimatesmartfee/) and [getrawtransaction, version 30.0](https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/getrawtransaction/), versioned reference. Used for unit/shape semantics, not a claim about Sandshrew's deployed Core version or latest Core release.
[^24]: Blockstream, [Esplora API reference](https://github.com/Blockstream/esplora/blob/master/API.md), `master` as accessed. Address/history/UTXO and fee-estimate semantics; hosted Sandshrew compatibility still requires testing.
[^25]: Electron/OpenJS Foundation, [safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage), latest documentation as accessed. Platform-specific storage protection, Linux fallback and macOS signing caveats; actual bundled Electron must be separately qualified.
[^26]: Oyl Wallet, [SDK package manifest](https://github.com/Oyl-Wallet/oyl-sdk/blob/main/package.json), `main` as accessed; [raw manifest](https://raw.githubusercontent.com/Oyl-Wallet/oyl-sdk/main/package.json). Dependency scope, not a dependency vulnerability audit.
[^27]: Sandshrew/Oyl, [Privacy Policy](https://sandshrew.io/privacy-policy), effective February 15, 2024. Production-site policy as accessed; no account agreement or legal interpretation is supplied here.
[^28]: Sandshrew, [Documentation index](https://docs.sandshrew.io/llms.txt), current index as accessed. No separate operational/authentication/limits specification was listed there.
[^29]: LaserEyes, [Sandshrew integration documentation](https://www.lasereyes.build/docs/sandshrew), undated. Primary evidence of the consumer integration's websocket example, not authoritative evidence of Sandshrew production websocket support.
[^30]: UniSat, [Runes Indexer API](https://github.com/unisat-wallet/unisat-dev-docs/blob/master/open-api/auto-generated/docs/runes-indexer.md), `master` as accessed; [raw reference](https://raw.githubusercontent.com/unisat-wallet/unisat-dev-docs/master/open-api/auto-generated/docs/runes-indexer.md). Alternative feature-contract evidence only; no commercial or security comparison completed.
[^31]: Bitcoin Browser, [Beta readiness audit](../BETA_READINESS_AUDIT.md), current local worktree with dated historical checkpoints. Existing release gates are not re-tested or cleared by this assessment.
