# Bitcoin Browser v0.1.0 beta testing

Start with [downloads](../README.md#download-v010-beta) and the [getting started guide](GETTING_STARTED.md). Each platform's installation guide covers its architecture and formats. This beta's macOS and Windows downloads are unsigned; follow the documented per-app launch flow if your operating system allows it.

## A useful fifteen-minute check

1. Install the format you want to test. Record the exact filename, OS version and CPU architecture.
2. Open the app, choose Dark or Light in Settings, resize the window and move through Start, Inscriptions, Runes and Sources.
3. Open `block:840000` and `sat:0`. Confirm results identify their source and errors remain recoverable.
4. Open an inscription. Try its applicable view, Details and recursive information without enabling external networking unnecessarily.
5. Create tabs and a bookmark, restart, and confirm the saved session works. Quit normally and launch again.
6. Try offline mode with previously opened content and with something uncached; report whether the distinction is clear.
7. Use keyboard navigation and your normal display scaling. Report clipping, lost focus or unreadable content.

## Optional integrations

Your own node, local AI and Wallet Bridge require separate setup; they are not prerequisites for browsing. See [node setup](EASY_NODE_SETUP.md), [AI](LOCAL_AI.md) and [wallet boundaries](WALLET_BRIDGE.md). Packaged releases do not authorize wallet signing. Do not test with secrets or funds you cannot afford to expose to experimental software.

## Evidence and limitations

The release manifest records the build commit, native jobs, artifact hashes and runtime results. Automated native smoke covers clean test profiles, the bundled shell, controlled providers/content, persistence, deep links and shutdown. It does not certify every Linux distribution, every wallet/provider version, real-node synchronization, screen-reader behavior or OS reputation prompts on a newly downloaded copy.

Submit a [GitHub issue](https://github.com/HGraph-Punks/bitcoin-browser/issues) with reproducible steps and expected/actual behavior. Review **Settings → Export diagnostics** before sharing. Private security reports go to [patches@turtlemoon.io](mailto:patches@turtlemoon.io). Source investigation documents record historical qualification work and are not the current download status.
