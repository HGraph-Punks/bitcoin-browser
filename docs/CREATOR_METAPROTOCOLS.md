# Native Bitcoin protocol creation

Research date: 2026-10-08. Implemented in Bitcoin Browser 0.2.0-rc.6.

## Creation model

The persistent Create sidebar separates websites/art, image collections, Runes, Bitmap, BRC-20 and Sats Names. Runes and the three added meta-protocols open native forms with Design and Source panels. They have no website canvas, HTML entrypoint or library runtime. Fresh protocol projects contain only their JSON design file. Existing Rune projects retain older source locally, but publication uses the Rune design only.

Valid edits autosave with revision checks; navigation flushes pending designs. Invalid input and concurrent edits preserve the draft and prevent publishing stale settings. Protocol source, history and portable archives share the existing project model. Copy/export actions save and validate the design before producing the exact payload.

## Research and implemented scope

| Protocol | Native creator | Scope and source |
| --- | --- | --- |
| Bitmap | District block-height form; bare UTF-8 payload | One `<height>.bitmap` claim. The connected Core tip must include the selected block. First valid inscription determines protocol ownership; no parcel delegation. [Bitmap specification](https://gitbook.bitmap.land/) |
| BRC-20 | Deploy/public-mint selector, ticker, supply, mint limit and decimals | Legacy four-byte namespace, restricted to four ASCII letters/digits. Exact decimal strings, divisibility 0–18 and uint64 maximum supply. Public mints credit the initial inscription owner; later sending a mint inscription does not transfer balance. Transfers and self-mint are excluded. [Layer1 Foundation specification](https://layer1.gitbook.io/layer1-foundation/protocols/brc-20/documentation) |
| Sats Names / SNS | Plain registration or JSON registration, optional avatar and website relay | One case-insensitive name/namespace with one period and no whitespace. Visible UTF-8 names supported. Avatar/relay reference exact inscription IDs. No reverse-resolution field or update operation. [SNS registration specification](https://docs.satsnames.org/sats-names/sns-spec/mint-names) |
| Runes | Dedicated native name, symbol, premine, divisibility and open-mint form | Actual runestone etching through Ord; exact u128 arithmetic, six-confirmation commitment, persisted reveal and native Rune viewer. JSON design manifest accompanies the etching. [Ord reference specification](https://docs.ordinals.com/runes/specification.html) |
| Recursive Ordinals | Integrated into website/experience and collection authoring | Existing recursive dependencies and galleries stay in the website creator: their purpose is executable or media content. [Ord recursion documentation](https://docs.ordinals.com/inscriptions/recursion.html) |

BRC-20 encoding/delegation are not recognized by the referenced indexer rules. All three added protocols therefore publish one **uncompressed** inscription with exact UTF-8 bytes and a protocol-appropriate MIME type. The native adapter recomputes the payload, verifies the prepared raw envelope has no encoding tag, and binds bytes/hash/MIME/operation to the reviewed quote.

Five-byte self-mint and six-byte commitment-protected BRC-20 are deliberately outside this legacy editor. They require provenance/commitment workflows and dedicated indexer checks; the form rejects longer tickers and cannot silently produce those variants. See the [extended BRC-20 reference](https://docs.brc20.build/protocol/brc20).

## Transaction review and acceptance

Drafting and payload export work offline. Inscription requires the existing loopback Core 31.1.0 / Ord 0.29.0 connection. Test shows payload/MIME/hash and validation findings. Inscribe shows exact fees, inputs, outputs, destination, network and protocol payload. An initially unchecked acknowledgement explains that protocol acceptance is unverified; both UI and backend require it before owner authorization. The acknowledgement is retained with the exact encrypted authorization. AI/MCP can configure and prepare but cannot accept the acknowledgement or authorize spending.

This candidate has no Bitmap, BRC-20 or SNS state indexer. It cannot prove a name/ticker/district is unclaimed, check BRC-20 remaining supply, or report an accepted token balance. Users must check a compatible indexer before spending. Confirmation verifies chain transaction and exact content only. Receipts explicitly show **Inscription verified · protocol acceptance unverified** and retain that distinction in exported data. Completed inscriptions open native Bitcoin Browser.

## Other protocols investigated

| Protocol | Assessment and next adapter |
| --- | --- |
| Bitcoin Stamps / SRC-20 | The official implementation uses its own output encodings and indexing rules. An Ord JSON inscription is not a Stamp. A future native tool needs a Stampchain transaction builder, output validation, matching indexer and asset protections before enabling spend approval. [Stampchain protocols](https://github.com/stampchain-io/btc_stamps/blob/main/docs/PROTOCOLS.md) |
| Atomicals / ARC-20 / realms | The official CLI and Atomicals ElectrumX indexer expose separate asset operations. A future tool needs its own builder/indexer integration and exact protected-asset transaction checks. It must not route an Atomicals-looking JSON file through Ord and claim success. [Official Atomicals CLI](https://github.com/atomicals/atomicals-js), [official indexer](https://github.com/atomicals/atomicals-electrumx) |

The adapter boundary for future protocols is: typed design → canonical operation → native transaction builder → frozen exact review → owner approval → chain verification → separately sourced protocol-state verification. Availability should be a dated indexer observation, never inferred from a format-valid payload.

## Verification scope

Domain tests cover strict formats, exact large amounts, unsupported operation rejection, protected design entries, revision history, portable round trips, invalid-source blocking and native preview denial. Native desktop qualification exercises all three forms, payload clipboard, saving across Browse switching, unchecked acknowledgement, real disposable-regtest inscription and native result navigation. Versioned receipts in `docs/evidence/creator-*.json` distinguish source and exact-package runs. Regtest confirms transaction mechanics and bytes; it does not prove production protocol-indexer acceptance. No owner wallet or mainnet funds are used.
