# Bitcoin Browser v0.1.0 beta

The first public Bitcoin Browser release brings the existing Satoshi Browser codebase to **HGraph-Punks/bitcoin-browser**. Explore Bitcoin blocks, transactions, addresses and sats; browse inscriptions and Runes; inspect media and recursive content; and choose public or local sources. Light, dark and system appearance are available.

## Install and start

Use the [README download table](https://github.com/HGraph-Punks/bitcoin-browser#download-v010-beta) for your OS and processor, then follow the [macOS](https://github.com/HGraph-Punks/bitcoin-browser/blob/v0.1.0/docs/install/macos.md), [Windows](https://github.com/HGraph-Punks/bitcoin-browser/blob/v0.1.0/docs/install/windows.md) or [Linux](https://github.com/HGraph-Punks/bitcoin-browser/blob/v0.1.0/docs/install/linux.md) guide. Every available format has a runbook. Start with `block:840000` after opening the app; no wallet, account or full node is needed.

**macOS and Windows are unsigned beta builds.** macOS has an ad-hoc integrity signature, with no Developer ID or notarization. Windows executables have no Authenticode publisher signature. OS security policy may warn or block launch. Linux packages are not repository-signed. Keep system-wide protections enabled; consult the installation guides for supported first-launch steps.

## Verification

Download **SHA256SUMS** and compare your file using the [verification guide](https://github.com/HGraph-Punks/bitcoin-browser/blob/v0.1.0/docs/install/verify-download.md). **release-manifest.json** records exact files, hashes, source commits and native build evidence. The release also contains a dependency inventory, audit report and verified source archive.

## Beta scope

- Manual updates; back up the profile and quit before installing another version.
- Known macOS issue: quitting can intermittently stall after network-content use. One local macOS 26.6.2 DMG run needed a forced exit after application persistence completed; a repeat passed all 34 checks. Native macOS 15 checks passed. This does not establish a root cause or guarantee that every shutdown saves successfully. See the macOS guide for recovery and reporting.
- Packaged wallet signing is disabled. The browser is not a wallet or seed store.
- Public sources receive your requested queries unless your settings restrict them. Offline browsing is limited to cached content.
- Curated asset cards are examples, not prices, verified collections or live rankings. Global inscription keyword search and holder indexes are not provided.
- Native automated smoke does not qualify every desktop distribution, third-party wallet or real-node configuration. See the manifest and [tester guide](https://github.com/HGraph-Punks/bitcoin-browser/blob/v0.1.0/docs/BETA_TESTER_GUIDE.md).

Report bugs at [GitHub Issues](https://github.com/HGraph-Punks/bitcoin-browser/issues); send support or private security reports to [patches@turtlemoon.io](mailto:patches@turtlemoon.io). Do not share credentials or full browsing profiles.
