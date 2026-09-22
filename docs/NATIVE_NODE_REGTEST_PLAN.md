# Bounded native Core/Ord qualification — harness and execution contract

Prepared September 8, 2026 for decision D-02. Status: **Harness implemented and locally tested; native Core/Ord execution NOT RUN and approval still required**. This document does not authorize downloads, binary execution, cookie inspection, personal-node changes or mainnet synchronization.

## Setup guidance and publication qualification — 2026-09-08

[The setup-guidance/publication report](../release/node-guidance-verification-20260908.json) records 108/108 focused and 1,387/1,387 full source checks. Guidance now distinguishes mainnet recommendations, unknown test-chain capacity and the unchanged 2 GiB managed-start minimum; existing-only connections avoid unused storage I/O. Saved-plan hashes remain unchanged.

Nine new actual-filesystem tests dynamically exercise interruption before/during result writes, immutable earlier result snapshots, exclusive mode-0600 creation, collisions and failed marker writes. Independent review inspected the actual caller's final interruption recheck and passed 28/28 owning tests. That additional promise boundary can retain a failed terminal outcome even when no new marker is written. **The terminal outcome and complete matching evidence remain mandatory.** These helper tests do not qualify full native execution, OS signals or power-loss durability; retain the end-to-end publication-interruption gate.

## Purpose and evidence boundary

Exercise the actual guided setup, provider adapters and managed-service lifecycle against isolated Core/Ord regtest processes, then qualify full synchronization separately under D-03. Synthetic RPC, Node child fixtures and archive inspection do not establish native node compatibility, database flush safety, populated inscription coverage or complete synchronization.

The existing archive report, `release/node-software-archive-qualification-20260907.json`, retained downloaded bodies only in memory. No installed executable path or executable SHA-256 is established by that report.

| Recorded archive | SHA-256 | Expected member |
|---|---|---|
| Bitcoin Core 31.1 macOS arm64, 65,771,644 bytes | `16a097c09fbd7eb78b240ce1dae123663ea2e5e377cfd6a951e71e227e23cf2f` | `bitcoin-31.1/bin/bitcoind` |
| Ord 0.29.0 macOS arm64, 10,696,403 bytes | `9360e97054a1d96624190634882c187126b02647a889b344cb601627ed1bd80c` | `ord-0.29.0/ord` |

These pins match the inspected software catalog. The recorded combined size is 76,468,047 bytes, approximately 72.93 MiB. Any approved download must retain static catalog URLs, bounded per-hop origin/status observations without signed CDN URL paths/query tokens, archive digest and installation-manifest evidence; native launch must also read back the installed executable digest. Checksum integrity, publisher verification and OS trust acceptance are separate claims.

## Required run contract

Prepare a plan-only-by-default harness with a separate explicit execution action. Before execution, resolve and record:

- Exact binary paths and hashes, selected release URLs and approved redirect hosts (`bitcoincore.org`, `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`).
- One newly allocated, explicitly named disposable root, with no personal application, Bitcoin or Ord profile/configuration in scope. Do not substitute a guessed directory or historical process ID.
- Regtest only; exact loopback RPC/REST/Ord HTTP endpoints. New guided regtest drafts default to explicit `core.peerConnections: 'disabled'`, generating `-networkactive=0 -connect=0 -dnsseed=0 -fixedseeds=0 -dns=0` inside the original preview/save/hash contract. Old absent-field saved plans remain byte-identical. The harness requires these exact generated flags and checks `networkactive === false` and zero connections. This is application-configured P2P isolation, not an OS firewall; a hard prohibition on all external activity needs a separately approved OS/network boundary.
- A 30-minute total deadline and bounded per-operation waits, normal exact-child stop, retained failure evidence and a cleanup policy that refuses to delete data while ownership is uncertain.
- An approved storage policy. The earlier proposed 2 GiB ceiling needs clarification: guided startup rejects less than 2 GiB available, so a partly occupied hard 2 GiB volume fails its precondition. A monitored growth budget is not a hard filesystem quota. State the enforcement mechanism and overshoot risk honestly.
- No wallet creation, funds, private keys or credential output. Authentication may use only the new fixture cookie through normal application code after approval. Do not display cookie values or authorization headers.
- Stop on OS trust rejection. Preserve quarantine and Gatekeeper; no trust bypass or broad signing-store discovery.

## Implemented harness and current limits

`scripts/native-node-regtest.mjs` uses the actual StateStore, empty fixture SecureStore without native encryption, NodeSetupManager, NodeSoftware installation manifests, ProviderManager/Core/Ord adapters and LocalServiceManager. No Electron, wallet, Keychain, download or installer action is part of this harness. Autostart is disabled. Generated configuration identity is preserved through preview, save, reopen, start and stop.

The driver covers Core-only; managed Core + Ord; managed Ord with compatible fixture Core; connections to already-running fixture services; and neither. It reopens saved StateStores and restarts managed setups, checks that connected stops leave the owning pair running, and verifies exact block/provider/transaction-index responses. It rejects occupied ports before claiming a fresh root. Cancellation closes manager admission immediately, aborts admitted readiness and drains all managers. The executable run remains NOT RUN; synthetic orchestration and actual-manager admission tests do not establish native results. Additional native fault scenarios (port races after reservation, runtime permission failures, crashes, prolonged indexing, full storage and populated inscriptions) remain required beyond this first integration driver.

A fresh regtest cannot be assumed ready. The coordinator requires Core to leave initial block download, match headers/blocks, report a synchronized transaction index and expose matching-chain REST before managed Ord starts. `scripts/regtest-block-fixture.mjs` constructs one bounded proof-of-work block with one zero-value OP_RETURN coinbase; subsidy is unclaimed and no wallet, key, recipient, spendable output or inscription is created. The native path checks genesis, exact tip, timestamp, compact target and inactive networking before its sole generated `submitblock`. Core acceptance, IBD transition and Ord indexing still require native evidence; offline serialization tests cannot prove them.

Record allowlisted public readiness fields, source/network identity, owned PID and executable, start/close times, exit code, signal, forced-termination request, bounded logs, operation outcome and retained directory. Never equate a reachable RPC port or empty index with the complete intended workflow. Add populated inscription fixtures separately when an approved construction method exists.

The current harness exports bounded public status events, hashes and error codes, not raw process log text, RPC bodies or credentials. Native-generated files remain in the retained dedicated root. Source/build inputs and binaries are checked at admission and after drain. Freeze the worktree before invoking the CLI and through completion: static modules load before the first disk hash, so concurrent source edits invalidate the runtime/source attribution even if a later disk snapshot looks consistent.

The Core RPC version must be `310100`. Both binaries must have an adjacent four-field `NodeSoftware` installation manifest matching the current catalog archive pin, kind/version and explicitly approved executable SHA-256. This is installation-integrity evidence, not publisher authentication. Ord `/status` JSON does not expose a version field; the harness does not invent one. Separate actual installation approval is needed to obtain those executable identities.

## Plan-only and execution interfaces

The input JSON contains exactly these fields (values below are explanatory, not an approved run):

```json
{
  "schemaVersion": 1,
  "root": "/private/tmp/satoshi-browser-regtest-20260908-reviewed",
  "core": { "path": "/absolute/managed/core/31.1/bitcoind", "sha256": "64 lowercase hexadecimal digits from installed executable readback" },
  "ord": { "path": "/absolute/managed/ord/0.29.0/ord", "sha256": "64 lowercase hexadecimal digits from installed executable readback" },
  "ports": { "coreOnlyRpc": 28443, "pairRpc": 28444, "pairOrd": 28080, "ordOnlyHttp": 28081 },
  "maxRunMs": 1800000,
  "maxGrowthBytes": 2147483648
}
```

Use Node 22 or newer. With no arguments or `--help`, the CLI only prints usage. With `--manifest` and an absolute JSON path, it reads that manifest and source/build inputs and prints the complete hashed plan. It does not inspect binaries, contact services, create a run directory or read a cookie in plan mode.

After reviewing the actual plan and obtaining exact execution approval, `--execute --approved-plan-sha256` with its printed hash is required in addition to `--manifest`. The hash confirms scope; it does not replace user/tool approval. Changed source, flags, paths, ports, binary hashes or limits require a new plan and appropriate approval. Current native execution supports only macOS arm64 and a fresh direct child named `satoshi-browser-regtest-…` under `/private/tmp`; it does not qualify other platforms or full synchronization.

The work-admission deadline is 30 seconds before the selected run limit. Cancellation synchronously closes setup/provider/service admission and begins owned drains. Five-second graceful and five-second forced service-stop windows remain unchanged; any forced request is a failed run. Timers and growth polling are not hard OS quotas, and unresponsive native/filesystem operations need external supervision under an approved procedure. The root monitor counts apparent regular-file bytes without reading contents, rejects symlinks/special files and bounds entry count; allocated-block usage and transient overshoot are not hard-limited. At least 2 GiB free space must remain available.

All run data is retained, including `approved-plan.json` and `result.json`. An interruption during result publication may also create `result-invalidated.json`; any invalidation marker, nonzero command exit, failed/unavailable final identity check, missing case, forced stop or remaining child invalidates acceptance. Never accept a standalone PASS string without the terminal command outcome and matching complete evidence. Cleanup requires a separate exact-target decision and confirmed child closure; the harness never recursively deletes run data.

## Pinned-source rationale

Core 31.1 regtest includes a dummy DNS seed, so a fresh directory plus inbound-listening denial is not an outbound guarantee. The [regtest parameters](https://github.com/bitcoin/bitcoin/blob/v31.1/src/kernel/chainparams.cpp#L580), [argument interactions](https://github.com/bitcoin/bitcoin/blob/v31.1/src/init.cpp#L728) and [inactive-network lookup/connection guards](https://github.com/bitcoin/bitcoin/blob/v31.1/src/net.cpp#L2194) support the explicit peer-control choice. Ord's guided path already strips ambient `ORD_*` variables and uses explicit dedicated configuration and loopback RPC/HTTP. Source inspection is narrower than whole-process traffic qualification or OS trust behavior.

The managed-stop correction identified during this preparation makes unexpected/forced closes fail truthfully and preserves failure through admitted work. Expected generic SIGTERM termination remains compatible; it does not prove database flushing. Windows needs a native graceful-node-stop strategy and qualification because Node's emulated signals are abrupt. See the [Node 22.23.2 contract](https://nodejs.org/download/release/v22.23.2/docs/api/child_process.html#subprocesskillsignal).

## Installation-path correction — locally verified

The [September 8 read-only finding](../release/native-regtest-installation-review-20260908.md) is historical. The actual default download path now enforces the four default-port HTTPS origins before DNS/connection admission at each hop, retains only bounded origin/status observations, and sanitizes installer errors. Private snapshots, cancellation and response cleanup preserve the requested boundary. [Source verification](../release/software-download-verification-20260908.json) passes 95 focused and 1,358 full tests; default-installer HTTPS/DNS fixtures are mocked, and two actual loopback tests establish response closure. They do not establish real upstream TLS/CDN availability, installation, publisher authentication or native execution. Four-field manifests and quarantine behavior remain compatible.

The exact [stage 1 installation-only approval proposal](../release/native-regtest-installation-approval-20260908.md) has been requested. Its target absence/parent metadata must be revalidated immediately before any approved operation. No installation or native execution approval is inferred.

## Approval request to finalize

Next obtain exact permission for installation of the two pinned binaries into a dedicated, verified destination without execution, preserving quarantine and recording executable/installation-manifest hashes. Then fill the real run manifest, inspect its generated plan, and request execution approval naming the exact plan hash, new root, endpoints, normal fixture-cookie use, limits, configured-versus-OS networking boundary, shutdown/failure supervision and data retention. These can be reviewed as separate stages because installed executable identities do not exist yet. No illustrative path or historical PID is an approved target. Do not treat this document as approval.

D-03 full synchronization, native platform matrices, publisher trust and actual rendered walkthrough qualification remain separate open gates. No node execution or download occurred while preparing this document.
