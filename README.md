<p align="center"><img src="bitcoin-browser-logo.png" alt="Bitcoin Browser logo" width="144"></p>

# Bitcoin Browser

Explore Bitcoin, Ordinals, inscriptions and Runes in a dedicated desktop browser by [Turtle Moon](https://turtlemoon.io/products/bitcoin-browser). Browse blocks, transactions, addresses and sats, view inscription media, inspect recursive content, and choose the data sources you trust.

**Local creation candidate: v0.2.0-rc.3.** Choose **Browse** for Bitcoin exploration or **Create** to build websites, experiences and inscriptions. See [the migration plan](docs/CREATOR_MIGRATION.md) and [candidate build checks](docs/CREATOR_BUILD.md). This candidate is not a new public release.

**v0.1.0 is the first public beta.** No account, wallet or full node is required to start browsing. macOS and Windows downloads are **unsigned beta builds**; macOS is not Apple-notarized. Read the installation guide before opening a download.

[Release notes](https://github.com/HGraph-Punks/bitcoin-browser/releases/tag/v0.1.0) · [Getting started](docs/GETTING_STARTED.md) · [Report a bug](https://github.com/HGraph-Punks/bitcoin-browser/issues) · [Security policy](SECURITY.md)

## Download v0.1.0 beta

Choose your operating system and processor. DMG is the usual Mac installation; Setup is the usual Windows installation. On Linux, use the package format for your distribution or an AppImage.

| System | Downloads | Installation |
| --- | --- | --- |
| macOS 13+ · Apple silicon | [DMG](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-macos-arm64-unsigned.dmg) · [ZIP](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-macos-arm64-unsigned.zip) | [macOS guide](docs/install/macos.md) |
| macOS 13+ · Intel | [DMG](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-macos-x64-unsigned.dmg) · [ZIP](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-macos-x64-unsigned.zip) | [macOS guide](docs/install/macos.md) |
| Windows · Intel / AMD | [Setup](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-windows-x64-unsigned-setup.exe) · [Portable](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-windows-x64-unsigned-portable.exe) · [ZIP](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-windows-x64-unsigned.zip) | [Windows guide](docs/install/windows.md) |
| Windows · ARM64 | [Setup](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-windows-arm64-unsigned-setup.exe) · [Portable](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-windows-arm64-unsigned-portable.exe) · [ZIP](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-windows-arm64-unsigned.zip) | [Windows guide](docs/install/windows.md) |
| Linux · Intel / AMD | [AppImage](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-x86_64.AppImage) · [DEB](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-amd64.deb) · [RPM](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-x86_64.rpm) · [tar.gz](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-x64.tar.gz) | [Linux guide](docs/install/linux.md) |
| Linux · ARM64 | [AppImage](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-arm64.AppImage) · [DEB](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-arm64.deb) · [RPM](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-aarch64.rpm) · [tar.gz](https://github.com/HGraph-Punks/bitcoin-browser/releases/download/v0.1.0/bitcoin-browser-0.1.0-linux-arm64.tar.gz) | [Linux guide](docs/install/linux.md) |

The [release page](https://github.com/HGraph-Punks/bitcoin-browser/releases/tag/v0.1.0) includes SHA256SUMS, a build manifest, dependency inventory and source archive. [Verify your download](docs/install/verify-download.md) before opening it. These hashes check the download's integrity; they are not a code-signing certificate.

macOS requires Ventura 13 or later. Windows builds target 64-bit Windows; use a currently supported Windows 11 installation. Linux builds are qualified on Ubuntu 22.04 runners; other distributions can need additional desktop or sandbox dependencies. The platform guides explain architecture selection, all formats, unsigned-app prompts, updates and removal.

## Start exploring

1. Install and open **Bitcoin Browser**.
2. Open **Settings → General → Theme** and choose **Dark** for the dark interface; System follows your OS appearance.
3. On **Start**, enter `block:840000` or `sat:0` in the address bar. Open **Inscriptions** or **Runes** in the sidebar to explore.
4. Use **Sources** to see which provider returned a result. Public sources are enabled by default and receive the requests you make. Local-only and offline modes are available in Settings.
5. Bookmark something, open another tab, and explore **Details** for identifiers, provenance and collector information.

See [getting started](docs/GETTING_STARTED.md) for a short walkthrough and optional local node, AI and wallet setup.

## What you can do

- Browse Bitcoin blocks, transactions, outputs, addresses, sats and inscriptions using native targets such as `block:840000`.
- Explore inscriptions and Runes, media filters, collector traits, exact amounts and mint information supplied by configured sources.
- View images, audio, video, HTML, SVG, PDF, Markdown, fonts, JPEG XL and 3D formats with dedicated, isolated viewers.
- Inspect recursive inscription dependencies and reuse locally cached content.
- Keep tabs, bookmarks and history on your device; choose light, dark or system appearance.
- Connect your own Bitcoin Core / ord sources and manage optional local services.
- Use optional local AI with explicit source controls. A model's explanation is not a verified chain fact.

[Feature reference](docs/FEATURE_REFERENCE.md) · [Data sources](docs/DATA_SOURCES.md) · [Inscription formats](docs/INSCRIPTION_FORMATS.md) · [Collector insights](docs/COLLECTOR_INSIGHTS.md) · [Local AI](docs/LOCAL_AI.md)

## Beta limits

This is an early beta with manual updates. It is not a general-purpose web browser, wallet, key store or exchange. Packaged releases disable Wallet Bridge signing. The creation candidate separately supports owner-reviewed inscription through an explicitly connected local Bitcoin Core / Ord wallet; it never imports a seed. The optional Wallet Bridge remains isolated from inscription content; do not import a seed phrase or private key into Bitcoin Browser.

**Known macOS issue:** quitting can occasionally stall after network-content use. One local macOS 26.6.2 DMG test required a forced exit; the repeat passed. See the [macOS troubleshooting steps](docs/install/macos.md#troubleshooting) if the app remains running after Quit.

Live results depend on your selected source and network. Curated discovery cards are examples, not live rankings or verified collections. Global inscription keyword search, market prices and holder indexes are not promised. Some advanced provider, node and wallet combinations need further testing. See [beta testing](docs/BETA_TESTER_GUIDE.md) and the release's recorded build checks for the tested scope.

## Run from source

Use Node.js **22.23.2**, Git, and a desktop session on macOS, Windows or Linux:

```sh
git clone https://github.com/HGraph-Punks/bitcoin-browser.git
cd bitcoin-browser
npm ci
npm ci --prefix src/creator
npm run build:creator
npm run verify
npm start
```

`npm start` works in PowerShell as well as POSIX shells. Native Electron dependencies are installed by `npm ci`; Linux also needs the desktop libraries listed in its [installation guide](docs/install/linux.md). A Bitcoin node is optional and is not downloaded by these commands.

For a local developer package: `npm run pack -- --arm64` or `npm run pack -- --x64`, then `npm run smoke:packaged`. For beta installers and signed release policy, see [release engineering](docs/RELEASING.md). Keep the sandbox enabled.

## Contribute and get help

Open a [GitHub issue](https://github.com/HGraph-Punks/bitcoin-browser/issues) with your OS, architecture, app version, download format and reproduction steps. Email [patches@turtlemoon.io](mailto:patches@turtlemoon.io) for support or private security reports. Review diagnostic exports before sharing them.

[Contributing](CONTRIBUTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Threat model](docs/THREAT_MODEL.md) · [Changelog](CHANGELOG.md)

## Source and license

The initial commit is an exact source-tree import of Satoshi Browser commit `b3e8fe95030cf4cfdafc9479c576d7a231ee007f`. Subsequent commits prepare this public beta. The internal package name `satoshi-browser` and app ID `org.satoshibrowser.desktop` are retained for profile compatibility; the application and public project are **Bitcoin Browser**. The public version starts at **0.1.0**, independently of the earlier private RC numbering.

[MIT license](LICENSE). Bundled third-party assets retain their own notices and attribution.
