# Bitcoin Browser 0.2.0-beta.1 — Create Alpha

This public prerelease adds the native Create **Alpha** workspace and the WebGL Start introduction. The owner explicitly authorized Developer ID-signed macOS Alpha builds without notarization, plus unsigned Windows builds, on October 8, 2026. The ordinary signed distribution workflow continues to require Apple notarization.

## Build scope

Six native CI runners qualify macOS arm64/x64, Windows arm64/x64 and Linux arm64/x64. The unsigned build workflow now installs and builds the Creator workspace. Each packaged smoke run opens the actual Create Alpha control, checks all 24 starters and native protocol types, verifies separate renderer authority and returns to Browse. Asset upload follows the source/security/audit gates and packaged smoke.

macOS distribution is prepared separately on the owner’s Mac with the installed `Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)` identity. App and DMG signatures are checked; the app preserves hardened runtime and inherited Electron release fuses. Filenames include `signed-alpha`. These files have **no Apple notarization ticket**. Gatekeeper may restrict first launch. Windows files include `unsigned`, and Linux packages have no repository signatures. Do not describe any of these files as notarized or as a stable release.

The dedicated macOS Alpha command requires a valid beta/RC version, clean tracked source, explicit architecture, the complete public signing identity and an acknowledgement flag. It refuses to replace existing outputs. It retains a source/payload inventory and hashes for both DMG and ZIP. It never publishes by itself:

```sh
node scripts/package-public-alpha-macos.mjs --arch=arm64 --developer-id='Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)' --acknowledge-unnotarized-alpha
node scripts/package-public-alpha-macos.mjs --arch=x64 --developer-id='Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)' --acknowledge-unnotarized-alpha
```

## Publication

Verify all six successful CI download sets. Replace the four unsigned Mac files in the publication inventory with the checked signed Alpha DMG/ZIP files. Preserve Windows/Linux native evidence, qualify the exact signed Apple silicon package independently, and ship a complete release manifest and SHA256SUMS. Record native CI source commit and local signed build commit; do not infer signing or notarization from a filename.

Publish as a GitHub **prerelease** only after download inventory and notes are complete. The website uses actual published filenames, labels Create Alpha and per-platform signing, and retains the original v0.1.0 formats plus the October 7 signed/notarized v1.0.0-rc.2 Apple silicon DMG. The old Mac file has no Create mode. Do not overwrite historical downloads or checksums.

Create drafts, libraries, collections, native Rune/Bitmap/BRC-20/Sats Names forms and mode switching are qualified independently of mainnet transaction execution. Existing financial checks use disposable Core/Ord regtest wallets. Mainnet wallet execution and protocol-indexer acceptance remain unqualified; seeds are never imported. Updates are manual. Keep existing browser profiles and export Creator projects before returning to an older build.

## Final qualification — October 8, 2026

Release/source commit: `e8214afd5a0bfd0302352418c44bef54a03539dc`. The immutable release source archive has SHA-256 `821bd812ca390bb42f34f211e9bc877a195452b8c89424228fa49f426663724b` (16,886,601 bytes); it was verified against an isolated exact-source snapshot. Subsequent receipt documentation does not change that frozen archive.

[Native release run 37882072680](https://github.com/HGraph-Punks/bitcoin-browser/actions/runs/37882072680) passed its source/security/audit gate and all six native builds. macOS arm64/x64 and Linux arm64/x64 each passed 35 packaged checks. Windows arm64/x64 each passed 34 checks with one inapplicable POSIX lifecycle check skipped. Every platform exercised the actual Create Alpha control and the separate native Browse renderer.

The exact signed Apple silicon application independently passed all 35 packaged smoke checks, plus native homepage and Creator qualification. Homepage evidence includes actual WebGL assembly, pause/replay, live reduced motion, context loss, static fallback and fresh/returning/narrow layouts. Creator evidence includes all 24 starters, nine running interactive experiences, collection and protocol forms, explicit library-warning acceptance, native clipboard and 51 scoped MCP tools. No mainnet transaction was sent.

Signed Apple silicon source commit: `bde86c19d6fc2b84b20e9e6e1661b69011ad395e`; ZIP SHA-256 `4641feeb5099dd4beb2f5d6f3d246361e116624b18184934f9ab67dc698f7ab2`. Signed Intel source commit: `baba6f863e5052d6ab6252c4ee4bc8ffaf6584ec`; ZIP SHA-256 `594f614794ade03b832ee6e58fd9271ca9f793a70b6ef4c10b1fbfb392abe203`. Differences from the release source commit are release tooling, tests and source-manifest changes. Both candidate integrity receipts verify current application source inputs, Creator build inputs and payload, unpacked workers, signature, hardened runtime and seven release fuses. Intel signing was performed on Apple silicon; native Intel runtime evidence covers the matching unsigned CI application.

The versioned receipts in `docs/evidence/` and the public release assets retain this qualification scope. Browser dependency audit: zero high/critical and nine moderate findings. Creator dependency audit: zero findings. Mainnet execution, protocol-indexer acceptance, wallet recovery and seed import are not qualified or promised by this Alpha release.
