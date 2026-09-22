# Quick-start compact node

This source implementation adds an opt-in, local-file AssumeUTXO workflow to the existing node setup. History-from-start-date retention remains a future advanced feature. No witness-free mode is provided.

## Using the walkthrough

1. Open Local node setup, choose **Customize setup**, then **Bitcoin Core only** (or managed Core with a separately running Ord source). The new capacity-aware one-button recommendation uses ordinary compact sync; it does not import a snapshot automatically.
2. Choose/download the Core program and select mainnet and a fresh data location.
3. Choose **Compact node**, **Quick-start compact node**, or **Complete archive**. Compact choices are visible outside Advanced settings. Managed Ord still requires archive storage.
4. Review and save. Saving does not start a node or import a snapshot.
5. Start services, obtain an uncompressed supported snapshot separately, and use **Choose snapshot file**. The official snapshot guide is linked in the walkthrough; this version does not choose a mirror or download snapshots automatically.
6. Allow Core to receive the snapshot's base header. Choose **Import snapshot** and approve the native review. Core checks the complete snapshot commitment, then catches up while historical validation runs separately.
7. Watch **Current with network** and **Historical validation** independently. Continue browsing or leave the page without interrupting Core.

You may let ordinary compact synchronization continue without importing a snapshot. A snapshot at or below Core's already-processed height is not useful and is rejected by this workflow. Existing guided plans are preserved, not silently migrated or converted; this first integration targets new Quick-start setups.

## Supported scope and storage

The app catalog is reviewed against Core 31.1; the runtime import gate accepts Core 31.x. Mainnet snapshot bases are 935000, 910000, 880000 and 840000. These base block hashes are not file checksums. The app recognizes only version-2 snapshot metadata; Core remains responsible for the serialized UTXO commitment and consensus checks. See [Core's catalog](https://github.com/bitcoin/bitcoin/blob/v31.1/src/kernel/chainparams.cpp) and [snapshot metadata format](https://github.com/bitcoin/bitcoin/blob/v31.1/src/node/utxo_snapshot.h).

Compact configuration retains the existing `-prune=10000` and `-txindex=0`. The block-file target is not a total disk cap. Quick-start guidance recommends 60 GiB free plus the separately obtained snapshot, accounting for temporary double-chainstate work. Import refuses known free space below twice the input file size or 2 GiB, whichever is larger; that floor and the recommendation are not capacity guarantees. Core still downloads historical blocks. No estimate of elapsed synchronization time or bandwidth savings is promised. [Core's AssumeUTXO guidance](https://github.com/bitcoin/bitcoin/blob/v31.1/doc/assumeutxo.md).

## Import ownership and recovery

- Selection is a main-process native picker action associated with the exact saved setup. The renderer receives only an expiring token and display metadata, not authority to submit an arbitrary path or RPC method.
- The app reads a 51-byte metadata header, not the entire multi-gigabyte snapshot. Files must be regular, non-symlink, uncompressed local files, at most 64 GiB, with bounded coin counts and a reviewed mainnet base.
- Import checks saved plan/configuration ownership, app-owned process PID, online policy, Core version/network/pruning, chainstates, base header and storage. File identity and preconditions are rechecked after native consent.
- A pathless import-attempt marker is persisted before `loadtxoutset` is dispatched. The input file is never removed or rewritten. Imports are never replayed by autostart, status polling, page navigation or recovery.
- The RPC observer is bounded to 30 minutes and 64 KiB of response data. A timeout, transport failure or malformed result is an **unknown outcome**, not a successful import or proof Core cancelled it. The same process cannot receive another import through this workflow after an uncertain attempt. Check status; if no snapshot is active, explicitly stop/restart managed Core before selecting again.
- Stop/offline/shutdown abort RPC observation, which is not equivalent to cancelling Core's work. Stop separately invokes the existing managed-process shutdown path. A pending attempt survives app-state reopening and remains conservative until Core status or an explicit process restart resolves the next action.
- `getchainstates` drives snapshot/background state. The renderer never equates a tip-height match with historical validation. Unknown or inconsistent responses do not produce a ready state. See [chainstate RPC](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/getchainstates/) and [snapshot import RPC](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/loadtxoutset/).

## Qualification boundaries

Automated tests use real planning, StateStore, file-header handling, manager and renderer code with controlled process/RPC/native-dialog collaborators. The metadata fixture is intentionally not a valid UTXO set; it does not prove Core cryptographic verification, multi-gigabyte import performance, full background synchronization, native process shutdown or disk exhaustion behavior.

Before external beta qualification, exercise valid and invalid real snapshots with the pinned Core binary, cold/reused profiles, restarts during import and background validation, disk pressure, reorganization handling, native keyboard/accessibility and all supported operating systems. No mainnet snapshot was downloaded or imported as part of implementation. Snapshot-mirror selection/integrity delivery and existing-setup conversion require separate work. Whole-project beta gates remain unchanged.
