# Install on macOS

**Minimum: macOS Ventura 13.** Choose **arm64** for Apple silicon (M-series) or **x64** for Intel in Apple menu → About This Mac. Both formats contain the same Bitcoin Browser application. Get them from the [v0.1.0 release](https://github.com/HGraph-Punks/bitcoin-browser/releases/tag/v0.1.0).

These are **unsigned beta downloads**: the app has an ad-hoc integrity signature, but no Apple Developer ID identity or notarization. Apple has not verified this publisher. See [download verification](verify-download.md) first.

## DMG — standard installation

1. Download `bitcoin-browser-0.1.0-macos-arm64-unsigned.dmg` or the `x64` equivalent.
2. Open the DMG in Finder. Drag **Bitcoin Browser.app** into **Applications** (or your user's Applications folder if system installation is restricted).
3. Eject the disk image. Launch **Bitcoin Browser** from Applications.
4. Follow the first-launch steps below, then [start browsing](../GETTING_STARTED.md).

## ZIP — app archive

1. Download `bitcoin-browser-0.1.0-macos-arm64-unsigned.zip` or the `x64` equivalent.
2. Double-click it in Finder to extract **Bitcoin Browser.app**.
3. Move the complete app to Applications. Do not move files out of its bundle.
4. Launch it and follow the first-launch steps below.

## First launch and Gatekeeper

If macOS says it cannot verify the developer or cannot check the app, first confirm the download came from this repository and matches SHA256SUMS. Attempt to open it once, then open **System Settings → Privacy & Security**. If macOS offers **Open Anyway** for Bitcoin Browser and you choose to trust this beta, use that app-specific exception and confirm **Open**. Managed Macs can prohibit this action. [Apple documents this first-launch flow](https://support.apple.com/en-us/102445).

Do not disable Gatekeeper globally. A malware alert or damaged-file warning is not the same as the expected unsigned-publisher prompt: stop, compare the checksum and report the exact message. Re-download a mismatched archive.

## Updates and removal

Quit Bitcoin Browser before replacing the app with a newer release. Installation does not intentionally remove the profile. Back it up first using the [profile guide](../GETTING_STARTED.md#update-recover-and-report-problems).

To uninstall, quit and move the app from Applications to Trash. Your profile remains in `~/Library/Application Support/satoshi-browser`; delete it separately only if you intentionally want to erase local settings, history, bookmarks, caches and managed-node data.

The minimum OS comes from the packaged Electron runtime; Electron 44 drops macOS 12. See [Electron's platform change](https://www.electronjs.org/docs/latest/breaking-changes).
