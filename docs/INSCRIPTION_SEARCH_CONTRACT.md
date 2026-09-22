# Global inscription search — proposed implementation contract

Requirement: DISCOVERY-01B. Status: **proposed; not implemented or approved**. Prepared 2026-09-08. Exact identifier lookup, latest/block browsing and page-local filters remain available independently. This document is a specification and decision input, not evidence that global search exists.

## Product decision

Recommended architecture: one explicit **Search inscriptions** experience with a capability-advertising index adapter. Support a local index implementation and the same contract for an explicitly selected remote index. Do not silently pick a remote service or scrape a social platform. For a no-node user, an approved operated remote index is needed for immediately useful global results; a local-only index requires ingest time and storage. The browser must disclose that tradeoff before setup.

The owner must approve a deliverable scope: index-wide metadata/media filtering plus literal keyword/content-text search, and provenance-labelled collection lookup. Name the actual index implementation/operator, corpus, maintenance owner and resource budget before calling it implementation-ready for deployment. Remote hosting/payment/default-provider changes require separate approval. An unimplemented adapter facade or a local visited-items index does not satisfy global search. An explicit beta deferral is also allowed by the goal, but has not been granted.

## Source facts and resulting limits

Ord 0.29.0's `/search` dispatches recognized identifiers to entity routes; it does not implement a keyword results query. Its `/inscriptions` routes paginate the index, while `/collections` renders a parent-based listing. These routes alone do not establish a full-text or collection-name search API. This is a source-inspection conclusion, not a live-server qualification. [Pinned server source](https://raw.githubusercontent.com/ordinals/ord/0.29.0/src/subcommand/server.rs)

Parent/child provenance is an on-chain relationship with specific transaction requirements. A display name or marketplace grouping is not proof of that relationship, nor does a parent identifier alone prove an artist's off-chain identity. [Ordinal provenance specification](https://docs.ordinals.com/inscriptions/provenance.html)

Delegation can make returned content/type/encoding come from another inscription. The index must distinguish the inscription identifier from the effective content identifier instead of attributing delegated text to original bytes without disclosure. [Ordinal delegation specification](https://docs.ordinals.com/inscriptions/delegate.html)

## Version-one semantics

All semantics below are proposed product requirements, not claims about an existing provider.

| Query | Required meaning | Explicit exclusions |
|---|---|---|
| Number/ID/copied inscription link | Existing exact lookup; do not make it depend on the new index | Never send a valid exact target to keyword search as a silent fallback |
| Words | Case-insensitive, literal all-token matching over explicitly selected indexed fields; normalize Unicode NFKC then lowercase and split whitespace; same versioned normalization on ingest/query | No SQL/regex/query-language execution, stemming, inferred traits, OCR, semantic similarity or silent fuzzy correction |
| Content text | Search indexed UTF-8 `text/plain` bodies within the declared ingest bounds; show corpus coverage and exclusions | No HTML execution, JS execution, external document fetch, decompression without bounds, or claims that every inscription contains searchable text |
| Collection name | Match a supplied name/alias record whose authority and membership method are shown | Do not infer collection membership from filenames, similar art, title words, social popularity or a matching name |
| Collection ID | Exact membership group identified by authority + network + stable ID; distinguish on-chain parent edges from curated manifest membership | No unlabelled union of conflicting memberships or recursive descendant expansion |
| Media/block/number filters | Apply over the entire selected indexed corpus before pagination; media classification uses the declared effective-content policy | Not filtering the currently displayed 24 cards; no claim that provider-declared MIME proves safe rendering |

Use deterministic ordering: inscription sequence descending or ascending, then inscription ID; no opaque popularity or social ranking. Word search may initially use this chronological order, with an explicit label. Exact collection-name collisions produce a chooser with source/ID, not a guess. Negative inscription numbers remain signed decimal strings; large sequence/sat values are decimal strings, never lossy JavaScript numbers.

## Corpus and provenance contract

Each index exposes `protocolVersion: 1`, immutable `sourceId`, network, implementation/version, capability flags, normalization version, indexed chain height/hash, corpus revision, last successful update time, indexing state and exclusions. The browser's configured endpoint is authoritative for where traffic goes; a response cannot choose a new endpoint or rewrite source identity.

For every result retain inscription ID/number/sequence, block height/hash, declared/effective MIME, effective content ID, matched fields, and optional collection references. Collection metadata includes `authorityId`, `collectionId`, display name, membership method (`onchain-parent` or `curated-manifest`), manifest digest/revision when applicable, and optional exact parent ID. Render untrusted labels as text with length limits. A curated manifest is an assertion by the named authority, not consensus-verified provenance.

Coverage records must identify the included block range and counts for discovered records, indexed metadata, eligible text, indexed text, skipped oversized/unsupported/invalid text and failed records. Never infer completeness from an upstream reported total alone. `ready` requires all committed records in the declared range to have an indexed or explicit excluded status; `partial` remains visible when ingest is capped/interrupted. Reorganizations invalidate affected rows and snapshot cursors; catch up against a new corpus revision before claiming current readiness.

For a local implementation: incrementally ingest confirmed block-associated listings and metadata from the selected Ord source, persist a per-block checkpoint and source chain identity transactionally, and reconcile from the last common block on reorg. Do not crawl the whole chain on every query. Write into an independent app-owned database, never Ord's live database or personal Core configuration. Store raw searchable text only for opted-in bounded MIME content. Build prepared/parameterized search statements with explicit escaping of FTS operators if a full-text engine is used. Choose and verify the actual database/runtime dependency before implementation; benchmark on representative corpora rather than inventing disk-per-inscription estimates.

## Main-process/provider wire contract

Proposed HTTPS remote or loopback HTTP API; no URL credentials and no arbitrary user-supplied result URLs. Existing destination/redirect/DNS policy remains mandatory. No browser renderer talks directly to the index.

`GET /v1/capabilities` returns the source/corpus fields above. `POST /v1/search` receives a bounded JSON body:

```json
{
  "protocolVersion": 1,
  "network": "mainnet",
  "query": { "text": "orange cat", "fields": ["metadata", "contentText"] },
  "filters": { "media": ["image"], "collection": null, "blockFrom": null, "blockTo": null },
  "sort": "sequence-desc",
  "limit": 24,
  "cursor": null
}
```

The response contains `protocolVersion`, `sourceId`, `network`, `corpusRevision`, `snapshotId`, `indexedTip`, `coverage`, `items`, `nextCursor`, `hasMore`, optional `total` with `totalRelation` (`exact` or `lower-bound`), and bounded warning codes. An empty successful result is distinct from unsupported capability, unavailable source, incomplete index and failed query. A missing total is displayed as unknown, never zero.

Each cursor is opaque, bounded and tied to the source, network, normalized query/filters/sort, corpus revision and page snapshot. It must not contain executable URLs. The index authenticates server cursors or validates an equivalent server-owned lookup token. Stable snapshots prevent duplicates/omissions while new inscriptions arrive. Expired or reorganized snapshots return `SEARCH_SNAPSHOT_EXPIRED`; preserve the query and offer an explicit refresh, never quietly switch to live offset pagination. Never reuse a cursor against a failover provider: start a new search and disclose source change.

Proposed stable error codes: `SEARCH_UNSUPPORTED`, `SEARCH_INDEX_NOT_READY`, `SEARCH_SNAPSHOT_EXPIRED`, `SEARCH_RATE_LIMITED`, `SEARCH_INVALID_RESPONSE`, plus existing transport/policy/cancellation errors. Include only bounded public metadata in diagnostics, not raw queries, response bodies, credentials or opaque cursors. A retry may repeat this read-only operation only while the same current query owns it; there is no ingest/configuration mutation attached to Search.

## Bounds, cancellation and privacy

- Query: at most 256 Unicode scalar values and 1,024 UTF-8 bytes; at most 16 tokens; reject oversized input before normalization and after normalization. No live keystroke transmission. Explicit submit only.
- Request body at most 8 KiB; cursor at most 2 KiB; capability response at most 64 KiB; response at most 512 KiB after bounded decoding. At most 24 validated results, 256-character titles, 512-character plain-text excerpts and 16 collection references per result. Reject schema/type/duplicate-ID/network/source/snapshot mismatches; no partial acceptance of a malformed security envelope.
- At most four concurrent index operations globally, one active search per tab; replace/close/navigation/provider/network/privacy changes abort queued and active work. Use current routing generation and tab/request ownership checks both before transport and before publication/cache writes. Old search cancellation must not cancel a newer search's shared request.
- Deadline: use the stricter of configured provider timeout and a 15-second search cap. Bounded retry for retryable transport/429 only under the same deadline; respect a bounded Retry-After and expose the retry state. No perpetual polling or retries after cancellation.
- Local ingest proposals: two concurrent fetches, metadata 64 KiB each, eligible UTF-8 text at most 256 KiB per inscription and no more than 1 MiB transient decoded content per worker. A configurable disk cap and free-space guard pause ingest before exhaustion; cap exhaustion means partial coverage, not success. Exact total disk/time budget requires owner approval and measurement.
- Offline: no network, including loopback. Serve a matching local index snapshot or explicitly cached query with provenance/staleness, otherwise an honest miss. Local-only: never contact remote index sources or perform remote fallback. A local index service that itself proxies remote content must disclose that and cannot be represented as verified network-isolated merely because its URL is loopback.
- Remote submission sends the chosen words/filters and client IP to the selected operator. Explain this beside source selection. Do not persist raw query history by default for the new feature without an explicit retention choice; use per-tab in-memory drafts. Existing saved-item search history behavior is unchanged. Persistent query caching is separately opt-in and disclosed; a query digest is still sensitive metadata, not encryption.
- Thumbnails and open actions use validated inscription IDs through existing bounded `ord://thumbnail`/viewer paths. Never follow index-supplied image, HTML, script, payment or external URLs. Delegated effective-content provenance must stay visible. No social features, wallet connection, signing, payment or collection trading is introduced.

## UI integration and implementation map

Keep the existing Inscriptions page and exact Find control. Add a clear mode choice “By number or ID” / “Search words or collections” in the same search region; only show index filters for the latter. Explain the selected source, coverage and privacy in one compact line with expandable details. If no capable index exists, show an actionable source setup path, not a zero-results screen. Preserve drafts, focus, selection, disclosure and scroll across result/status publication, and keep the existing viewer/Graph/Inspect/Save/Bookmark controls.

Implementation locations:

1. New `src/shared/inscription-search.js`: schemas, normalization, bounds, capabilities and canonical target grammar; distinguish from existing saved `search:` and page-local discovery.
2. New `src/main/providers/inscription-search.js`: read-only adapter through existing `http.js`; no new direct renderer authority.
3. `constants.js`, `validation.js`, `navigation.js`, `provider-manager.js`, normalized entities: explicit search capability/type, strict configuration/routing/cancellation and provenance. Provider mutation must respect corrected credential-binding rules.
4. A separately specified/approved local index worker or operated index backend: transactional ingest/query engine, versioned corpus/collection sources, reorg recovery, disk/CPU limits and maintenance. The browser adapter alone is not the index implementation.
5. `src/renderer/inscriptions.js` and related styles: progressive filters, plain-language coverage/errors, accessible result/status region and source setup. Extend actual UI ownership tests and IPC surface inventory for any new cancellation contract; do not expose generic fetch/SQL/file access.
6. README, built-in help, test plan, requirements matrix and privacy/source configuration: exact supported fields, omissions, source policy and measured operational limits.

## Qualification required before closure

Use a deterministic full-corpus fixture with records outside the first page, duplicate titles, colliding collection names, parent and curated memberships, negative numbers, Unicode queries, delegated text, invalid/oversized text, missing metadata, two networks and a reorg. Known expected query sets must be derived independently of the search implementation. Prove global filters before pagination, exact stable traversal without missing/duplicate results, source/snapshot/endpoint rejection, literal operator handling, bounded errors/results/decompression, and cancellation ownership across tabs/reconfiguration/shutdown.

Prove offline/local-only behavior with observed request counts, including failed remote fallback; query-retention policy with actual persisted-file readback using public synthetic phrases; no secret values. Exercise unavailable/partial/stale/rate-limited sources, corrupted/recovered index checkpoints, full-disk/rename failures and resumed ingest. An empty indexed corpus must never be reported as complete for the full chain.

Then use the real approved index implementation and a representative complete declared corpus, recording binary/source/version, corpus revision, source provenance, artifact hashes, resources and exact query results. Native keyboard, screen-reader, focus, zoom, narrow/theme/reduced-motion and long-content tests are mandatory. Ordinary users must complete finding an inscription and understanding source/coverage without needing protocol knowledge. Adapter mocks, this document and a running service without a qualified corpus do not close DISCOVERY-01B.
