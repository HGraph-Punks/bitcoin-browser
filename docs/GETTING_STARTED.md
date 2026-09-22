# Get started with Bitcoin Browser

Install v0.1.0 using the [macOS](install/macos.md), [Windows](install/windows.md) or [Linux](install/linux.md) guide. Downloads live in the [official HGraph-Punks repository](https://github.com/HGraph-Punks/bitcoin-browser/releases/tag/v0.1.0).

## Your first five minutes

1. Open **Bitcoin Browser**. The **Start** page is ready without a login, wallet or local node.
2. Choose **Settings → General → Theme → Dark** if you want the dark interface. System is the default and follows your desktop appearance.
3. Return to **Start**. Type `block:840000` into the address bar and press Enter. This explicit syntax avoids ambiguity between block heights and inscription numbers. Try `sat:0` next.
4. Choose **Inscriptions**, select a card and inspect its content and **Details**. Use media filters on the loaded page, or paste an exact inscription number/ID into **Find**.
5. Open **Runes** to explore examples and supply/mint details. Values reflect the configured source; missing information stays unavailable.
6. Bookmark a page and open another tab. Restart the app to check your saved session. Tabs, bookmarks and history are stored on this device.

## Choose where data comes from

Open **Sources** to inspect, enable, prefer or add providers. The default balanced setup can contact public providers for the Bitcoin and Ordinals data you request. The app does not make public-provider browsing anonymous. Source labels and health information help explain errors or differing results.

In **Settings**, choose the privacy/network options appropriate for your setup. Local-only requires a working local provider with the requested capability. Offline mode can display previously cached content; it does not guarantee that an entire recursive inscription is cached. If a request fails, check the network, source health and available capabilities before retrying. See [data sources](DATA_SOURCES.md).

## Optional tools

- **Your own node:** [Easy node setup](EASY_NODE_SETUP.md) covers Bitcoin Core and ord. Synchronization and indexing require additional time and storage; they are not needed for initial browsing.
- **Local AI:** [Local AI setup](LOCAL_AI.md) explains a separately installed local model service and supported operations. Verify the linked source records when evaluating generated explanations.
- **Wallet Bridge:** [Wallet integration](WALLET_BRIDGE.md) explains the isolated extension session. Packaged beta releases keep signing disabled. Browsing requires no wallet; Bitcoin Browser never needs your seed phrase or private key.
- **Developer tools:** advanced inspection remains available through the developer panel. It is optional for ordinary browsing.

## Update, recover and report problems

Updates are manual: read the next release's notes, quit the app, and install the matching system/architecture build. Back up the profile before changing versions. Do not run old and new versions against the same profile simultaneously.

The internal profile name remains `satoshi-browser`. Default locations are `~/Library/Application Support/satoshi-browser` on macOS, `%APPDATA%\satoshi-browser` on Windows, and `$XDG_CONFIG_HOME/satoshi-browser` (normally `~/.config/satoshi-browser`) on Linux. A custom user-data directory overrides these. Quit before making a backup. OS-encrypted credentials may not transfer to another machine or account; enter those again rather than sharing credential files.

To report a bug, include v0.1.0, your OS/version, CPU architecture, download filename, steps and expected/actual behavior in a [GitHub issue](https://github.com/HGraph-Punks/bitcoin-browser/issues). **Settings → Export diagnostics** provides a report to review before attaching. Do not include private RPC credentials, wallet material or a full browsing profile. Email [patches@turtlemoon.io](mailto:patches@turtlemoon.io) for private reports.
