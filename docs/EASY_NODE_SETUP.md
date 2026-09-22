# Capacity-aware Bitcoin Core setup

Implemented 2026-09-20. This is a simpler entry to the existing local-node workflows, not a new system installer or a replacement for advanced controls.

## User path

Open **Local node → Guided setup**, or **Set up a local node** on Start. A profile without a saved guided setup sees **Run your own Bitcoin node**. It shows one recommendation, the free space on the selected volume, installed memory and logical processor count. Choose **Set up Bitcoin Core**, approve one native **Set up and start** confirmation, and the browser downloads/verifies Core, creates fresh configuration, saves its source/service and starts synchronization. OS launch protections may require separate interaction; the app does not dismiss or bypass them.

The primary path uses compact mainnet Core with ordinary historical synchronization. No snapshot needs to be found, no command line needs to be copied, and no wallet is created. Setup stages are shown without fabricated percentages. The existing progress screen provides live Core status/counters, start, stop, refresh and continued browsing. Initial synchronization is not instant and is not equivalent to successful program installation.

**Change folder** recalculates capacity on the selected volume. **Recheck computer** refreshes an uncertain or outdated recommendation. **Customize setup** preserves Core + Ord, Core only, Ord only, neither, archive storage, snapshot-assisted sync, installed executables, running services, all existing networks, ports, cookies and index options. Resource targets can also be customized or cleared to use Core defaults. Existing saved setups are resumed; altered definitions require the existing advanced recovery path rather than reinstallation.

Automatic start on later **browser launches** is an explicit, initially unchecked option. This does not install a boot service. Keep the computer/browser open to sync or participate; quitting the browser stops its managed process. Closing the setup page before saving requests cancellation. Once saving has begun, the approved atomic save/start finishes and is resumed through Local node; use the existing Stop action afterward.

## Local recommendation policy

The main process reads aggregate OS memory, available logical parallelism, OS release/architecture, and filesystem metadata (`stat`, canonical path, write access, free-space statistics) for the selected directory or its nearest existing ancestor. It does not inspect personal files, identifiers, credentials, network traffic, installed applications beyond the existing bounded node discovery, or benchmark the machine. These capacity values are not sent to a server or persisted as a hardware profile.

| Check | Easy-path policy |
|---|---|
| Storage | Accessible, writable destination with at least **30 GiB free**; fresh `core-mainnet` subdirectory only |
| Memory | At least **2 GiB installed**; below 4 GiB gets a slow-machine warning |
| Processor | Known positive logical count; one processor gets a slow-machine warning |
| Database cache | 256 MiB below 8 GiB RAM; 512 MiB from 8 to below 16 GiB; 1,024 MiB from 16 GiB upward |
| Validation threads | Half the available logical count, rounded down, bounded to 1–4 |
| Larger disks | At least 1 TiB free exposes an archive alternative; compact remains the simple default |
| Platform | A pinned Core artifact plus a supported OS baseline; unknown/older baselines direct users to Customize setup |
| Privacy | Offline or local-only mode prevents this download path; existing-program/service workflows remain available |

These are conservative **product heuristics**, not certified minimum specifications, a promise of performance, or hard limits on total RAM/CPU/storage. Installed RAM may exceed memory currently available to apps or containers. Disk speed, temporary space competition, network quality, runtime libraries and OS launch acceptance remain untested by the automatic check. The legacy advanced startup floor remains 2 GiB of free space; existing plans do not receive new defaults or changed ownership hashes.

Core 31's published baseline is macOS 14, Windows 10 version 1903, or Linux kernel 3.17 and newer. The release notes also document its increased default database cache; this UI explicitly chooses smaller targets on lower-memory hosts. [Core 31 release notes](https://bitcoincore.org/en/releases/31.0/).

Compact storage uses the existing `-prune=10000 -txindex=0`. The 10,000 MiB target applies to block files, not the entire node. Core still downloads/processes historical blocks; pruning does not create a witness-free node or reduce that initial bandwidth. The screen explains substantial downloads, power use, hours/days of sync, and the benefit of an unmetered connection. A compact node independently validates and relays through outbound peers; it neither retains all history nor becomes a publicly reachable archival server. Running it is not mining and offers no protocol reward. [Full-node guidance](https://bitcoin.org/en/full-node).

## Consent, ownership and recovery

- All new requests use the existing trusted-shell node-setup channel. Inscription frames do not gain access. The closed actions are `capacity`, `easy-preview`, `easy-start`, `easy-status` and `easy-cancel`.
- The main process constructs an expiring, single-use plan for the exact pinned Core destination. The renderer cannot supply a program, URL, command, arbitrary arguments, or a “consented” flag. Optional cache/thread fields in the existing planner are bounded integers and affect only managed Core.
- One Cancel-default native confirmation covers download, dedicated configuration, network selection and startup, plus the selected future-browser-launch option. Existing manual download/apply/start actions retain their separate confirmations.
- Capacity, canonical storage, privacy, selected network, catalog identity, existing data and source/service collisions are rechecked around consent/download. No personal `bitcoin.conf`, existing node data or existing source/service definition is overwritten. Reserve/commit/rollback and saved-plan ownership continue through the existing manager.
- Downloads use the existing HTTPS-origin policy, bounded redirects, pinned archive checksums, selected regular-file extraction, isolated installation and quarantine handling. Publisher signature verification is **not** claimed. No new release-hashing workflow was added.
- Downloads can be cancelled before saving. Privacy changes and shutdown abort and drain pending work. Completed verified software can remain available for later reuse; user/node data is not deleted. Once persistence begins, cancellation cannot interrupt its atomic save; the UI moves to management/recovery instead of replaying setup.
- A saved-but-failed start or failed readback reports its durable setup identity. It does not offer a blind reinstall. Existing status/start/stop controls remain the recovery path.
- The renderer does not hold its settings queue during the download/native dialog. Privacy changes can reach main immediately. After commit it serializes a fresh settings/provider/service readback, never replacing newer privacy state with an old setup response. Readback failure preserves saved identity and directs source-state recovery.
- RPC remains loopback-only. No router port, NAT mapping, administrator installer or new inbound peer listener is enabled. The app uses Core's generated authentication cookie internally through its existing adapter; capacity/setup never displays or inspects credential values. Browser offline/local-only controls are not a firewall for an already-running Core process.
- Compact Core is not a complete local inscription/Runes index. Managed Ord still requires archive Core plus its own storage/indexing, or users can keep a separate Ord source. Existing browsing providers remain configured.

## Installer compatibility correction

The existing 64 MiB compressed-download limit rejected the pinned Intel Mac and Linux Core 31.1 bundles. Core now has a **128 MiB** compressed limit and **10-minute** request deadline; Ord retains 64 MiB / 120 seconds. Executable and whole-tar expansion bounds, checksum verification, HTTPS destinations, extraction/ownership rules and OS protections are unchanged.

Official compressed sizes and four-byte gzip trailer metadata were checked on 2026-09-20. These are metadata checks, not downloads of executable payloads or native launch qualification. [Official Core 31.1 release directory](https://bitcoincore.org/bin/bitcoin-core-31.1/).

| Platform | Compressed bytes | Gzip-expanded bytes |
|---|---:|---:|
| macOS arm64 | 65,771,644 | 130,877,440 |
| macOS x64 | 71,646,932 | 143,636,480 |
| Linux arm64 | 85,851,107 | 178,759,680 |
| Linux x64 | 90,293,352 | 192,204,800 |
| Windows x64 (ZIP) | 54,894,985 | Not a gzip archive |

## Core connection status and startup recovery — 2026-09-21

Core creates its RPC authentication cookie during startup and removes it on shutdown. The browser rereads that file for each RPC request; users do not need to enter or replace a password for the guided setup.

Previously, a missing cookie was reported as `PROVIDER_AUTH_ERROR`. The main process refreshed health every minute, but the visible source cards/sidebar could retain the renderer's old startup failure until an explicit Health check. The adapter now distinguishes missing/empty cookies, filesystem permission failures, unreadable files, actual HTTP 401/403 rejection, and Core warmup (`-28`, including HTTP 500). Guided progress gives the corresponding next step. No cookie is rewritten, cached, exported, or shown.

Data sources now shows **STOPPED OR STARTING**, **STARTING**, **FILE ACCESS NEEDED**, or **SIGN-IN REJECTED** as appropriate. A connected Core that is still in initial sync shows its reported verification percentage and explains that some local lookups remain unavailable. A healthy connection does not imply complete historical data, a fully synchronized node, or an Ord index.

A passive five-second renderer poll publishes the existing main-process health results, without additional provider requests. It pauses while hidden/offline or source recovery is pending. It changes health only, rejects obsolete replies across routing/configuration mutations, and updates cards in place without resetting an open editor, typed values, focused controls or disclosures. Main-process automatic checks retain their existing one-minute cadence; **Health check** remains available for an immediate check.

For recovery: use **Local node → Guided setup → Resume existing setup → Start** if the node is stopped. If Core is loading, keep it running. If an actual sign-in rejection or permission problem persists, verify the source's RPC address and cookie location refer to the same node. Do not reinstall, delete chain data, disable authentication, or change wallet credentials to clear a startup warning. Future-launch autostart remains an explicit option; this correction does not turn it on.

## Verification and remaining acceptance

Automated checks exercise aggregate capacity, unsupported/unknown states, OS baselines, exact action shapes, consent denial, token expiry/replay, data collisions, low space, changing privacy/network/catalog/storage, cancellation, ignored-abort draining, persisted recovery, startup failures, postcommit publication, native-dialog disclosures, resource validation, preserved legacy plans, UI alternatives, async ownership and stable stage/disclosure DOM. Boundary checks are included in the early-beta security runner. Tests use real disposable persistence with synthetic download/process/RPC/dialog collaborators, not a real Core launch or blockchain sync.

Before calling this turnkey **beta-qualified**, use explicitly approved disposable profiles/drives on each advertised OS to exercise the real pinned download and OS prompt, initial and resumed sync, low-space handling, external-volume removal, quit/start/stop, keyboard/screen-reader behavior, zoom and narrow/light/dark layouts. Native Windows shutdown remains a broader qualification concern: generic signal emulation is not proof that Core flushed its databases cleanly. The supported interactive Browser runtime was unavailable during this implementation; automated DOM assertions and reopening the Electron app do not establish native visual acceptance.

No Core executable was downloaded or started, no real node was installed/synchronized, and no credential values were read or manually changed during this implementation. No dependency, release, router/firewall or wallet-permission changes were made. The broader beta release gates remain open.
