# Changelog

## 0.1.0 — first public beta (2026-09-22)

- Published Bitcoin Browser under `HGraph-Punks/bitcoin-browser`, starting from an exact import of the existing Satoshi Browser source tree.
- Retained the Bitcoin/Ordinals/Runes browser, dedicated media viewers, source controls, local AI, optional node tooling and isolated wallet bridge. Packaged wallet signing remains disabled.
- Added explicitly unsigned macOS DMG/ZIP and Windows Setup/Portable/ZIP beta builds, plus Linux AppImage/DEB/RPM/tar archives, for x64 and ARM64.
- Added public download links, getting-started instructions and installation/recovery guides for every format.
- Corrected Windows text-file checkout, bundled PDF font loading in native tests, and native Windows smoke-test shutdown.
- Retained hardened Electron fuses and sandbox policies. Unsigned builds have no verified platform publisher; macOS is not notarized. Updates are manual.

### Earlier private source history

The entries below retain the former private version numbering. The first public release is v0.1.0.

## 1.0.0-rc.1

- Added a hardened Electron desktop shell with separate browser and wallet sessions.
- Added Bitcoin/Ordinals omnibox parsing, tabs, history, bookmarks, and deep links.
- Added pluggable ord server, Bitcoin Core RPC, mempool-compatible, and mock providers.
- Added capability-aware provider routing, health tracking, fallback, and local-first controls.
- Added recursive inscription resolution, dependency inspection, byte ranges, limits, and disk caching.
- Added an isolated extension-wallet bridge with native approval review and PSBT inspection.
- Added local `bitcoind`/`ord` service management, diagnostics, security checks, tests, packaging, and CI.
- Hardened provider networking against redirect-to-private-host and DNS-rebinding paths with per-hop DNS pinning.
- Added cache integrity/concurrency/offline repair, bounded graph aggregation, defensive PSBT v0/v2 parsing, and state/diagnostics recovery tests.
- Added structured IPC errors, lazy restored-tab resolution, accessible modal/tab behavior, and truthful beta settings/wallet gates.
- Moved Wallet Bridge assets to an isolated reserved HTTPS origin so MV3 wallet injection works without exposing providers to the app partition.
- Added a clean-profile packaged Electron smoke matrix with hostile-content, wallet fixture, service, persistence, deep-link, and layout checks.
- Split explicitly ad-hoc-signed developer packages from distributable builds, which now require a valid macOS signing identity.
