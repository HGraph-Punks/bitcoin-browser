# Bitcoin Browser — early beta tester guide

**Release status:** this guide does not certify a download. Use only a build the project owner has explicitly cleared for testing, with release notes naming its tested operating system and architecture. Local packages under `release/developer` are engineering builds, not signed release downloads.

## Before you start

Bitcoin Browser is made by Turtle Moon (legal entity: Turtle Moon Command Center). You can explore Bitcoin, inscriptions and Runes without a wallet, a local node or an AI model. Those integrations are optional.

- Do not use valuable funds during beta testing. If testing the Wallet Bridge, use an empty test wallet obtained from its verified publisher.
- Never enter a seed phrase or private key into Bitcoin Browser. Packaged beta builds disable transaction and message signing; this is not a wallet or a minting app.
- Public data sources can see your lookup requests. A local AI connection does not make Bitcoin data lookups private. Review **Data sources** and **Settings → Privacy** before researching sensitive addresses.
- Back up any existing browser profile before replacing a beta version. Do not delete Bitcoin Core, Ord or wallet data to resolve an app problem.

## Pick the right download

Use the exact release link supplied by the maintainer, not an unsolicited mirror. Only combinations explicitly qualified in that release's notes are supported for that beta.

| Computer | Architecture label | Preferred package | Alternatives |
| --- | --- | --- | --- |
| Mac with an Apple chip | `macos-arm64` | `.dmg` | `.zip` |
| Intel Mac | `macos-x64` | `.dmg` | `.zip` |
| Windows with an Intel/AMD processor | `windows-x64` | `-setup.exe` | `-portable.exe`, `.zip` |
| Windows with an ARM processor | `windows-arm64` | `-setup.exe` | `-portable.exe`, `.zip` |
| Linux with an Intel/AMD processor | `linux-x64`, or package label `amd64`/`x86_64` | Package matching your distribution | `.AppImage`, `.deb`, `.rpm`, `.tar.gz` |
| Linux with an ARM64 processor | `linux-arm64`, or package label `aarch64` | Package matching your distribution | `.AppImage`, `.deb`, `.rpm`, `.tar.gz` |

These are planned pipeline formats, not a statement that all downloads have been built or tested. There are no 32-bit beta targets in this matrix.

- **Mac:** open the DMG and copy Bitcoin Browser to Applications. Release downloads must be Developer ID signed and notarized. If macOS rejects the app or the publisher is unexpected, stop and report it; do not disable Gatekeeper or remove quarantine attributes.
- **Windows:** use the setup executable for an installed app, or the portable executable when the release notes qualify that option. For a signed build, check the signature and expected publisher against the maintainer's release notes. The owner may instead qualify an **unsigned Windows beta**, identifiable by `-unsigned` in its filename and **UNSIGNED BETA — no verified publisher** in the release notes. Such a file does not authenticate the publisher, and Windows may warn or block launch. If blocked, stop and report the result; do not disable antivirus, Smart App Control or other Windows security controls to run it. Do not treat an invalid signature as an acceptable unsigned beta.
- **Linux:** use DEB on a compatible Debian/Ubuntu system, RPM on a compatible RPM-based system, or a qualified AppImage/archive. Follow the distribution-specific instructions supplied with the release. Never run the browser as root or add `--no-sandbox` to work around a launch failure. AppImage/archive compatibility depends on system libraries and the distribution's sandbox policy.

## A useful 15-minute test

1. Open **About → Build & troubleshooting**. Record the version, platform and architecture. Confirm **Packaged: Yes** for a release download.
2. On Start, search for `block:840000`, then `sat:0`. Confirm that a result or a clear source error appears; try the recovery action if a source is unavailable.
3. Open **Inscriptions**. Try a known inscription number or ID, browse a page, open an item, then return. Check text/JSON readability and image fit. For suitable assets, try **Original**, **Details**, image zoom, media playback or 3D rotation.
4. Open **Runes**. Choose a **Popular to explore** example or a known Rune. Check its source, supply and mint information. Popular examples are curated introductions, not live popularity rankings or trading advice.
5. Save a bookmark, open **Bookmarks** and **History**, and revisit the exact saved item. Try new tabs, Back and Forward.
6. Switch between dark and light themes. Resize the window and try keyboard navigation. Report clipped controls, unreadable text or confusing scrolling.
7. After loading a page, enable **Offline cache-only mode** in Settings. A cached record should remain usable; a new, uncached target should give a clear offline error. Turn the setting back off when finished. Browser offline mode does not disconnect wallet extensions.
8. Quit the application normally and reopen it. Check saved bookmarks, settings and expected tab restoration. Report a process that stays running, a forced-quit requirement or lost state.

Source outages, missing provider capabilities and unsynced local indexes can limit available data. The inscription filters apply to the loaded page; the browser does not offer a complete global keyword or collection search. A missing source field is not proof that an asset lacks that property.

## Optional integrations

**Ask Bitcoin:** start your own LM Studio or Ollama server, choose the matching app in the AI screen, enter its address/port, and select **Connect & find models**. Choose a chat model with tool support. Ask about a public Bitcoin identifier, open a source card, and return through Ask Bitcoin in the sidebar. Finished chat should remain available within that session; closing its tab or quitting clears the memory-only conversation. Check answers against source cards—AI explanations can be wrong. The AI cannot access wallets, sign or install software.

**Local node:** choose **Local node → Guided setup**. The recommendation checks capacity on this computer. You can review it and cancel without installing anything; **Customize setup** keeps the advanced options. Installing and starting Core requires explicit confirmation and can use substantial bandwidth and disk space. Compact mode still downloads and validates historical blocks. Full local inscription/Runes indexing requires a suitable archival Core and Ord configuration, not just a compact Core node. Coordinate real installation/sync testing with the maintainer; it is not required for ordinary browsing tests.

**Wallet Bridge:** test only the exact wallet extension/version approved by the maintainer, with no valuable funds. Check discovery, public-account connection, disconnect, extension removal and restart. Report any signing request in a packaged beta; signing should be disabled. Never share wallet files or credentials in a report.

## Send useful feedback

Use the feedback destination supplied with your release invitation. For a suspected vulnerability, contact the maintainer privately; do not post exploits or sensitive data in a public issue. A monitored private security-reporting destination must be established before distribution.

Include:

- App version, OS version, processor architecture and package format.
- What you were trying to do, the smallest steps to repeat it, and expected versus actual behavior.
- The public identifier involved, only if you are comfortable sharing it; relevant source type and online/offline/local-only settings.
- A screenshot or short recording with personal details removed.
- Diagnostics only when needed: **About → Build & troubleshooting → Export diagnostics**. Review the file before sharing; automatic redaction is best-effort.

Never attach seed phrases, private keys, wallet files, RPC cookies, API tokens, provider passwords, signing credentials or an entire application profile. Do not assume that portable packages store their profile beside the executable or leave no state on the computer.

If an update goes wrong, quit it and contact the maintainer before changing data. Restore only a compatible app/profile backup using the release's recovery instructions; never overwrite a live profile or remove blockchain data as a shortcut.
