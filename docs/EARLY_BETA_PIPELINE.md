# Beta build and release pipeline

For v0.1.0, follow [release engineering](RELEASING.md). The public repository is **HGraph-Punks/bitcoin-browser**. Both macOS and Windows use explicitly labeled unsigned beta modes; Linux packages have no repository signatures. No workflow silently falls back from signed to unsigned.

## Workflows

- **CI:** source/static/unit checks, focused security tests, dependency audit and three native developer-package smoke targets. Weekly runs perform source/security/audit checks.
- **Unsigned beta builds:** six native OS/architecture builds, full native smoke, Windows unsigned-status verification and allowlisted artifact upload. Read-only repository access; no signing secrets or automatic publication.
- **Early beta release:** validates an existing matching tag and binds builds to its commit. Manual choices select each platform's signing policy independently. After required gates it creates a draft prerelease; a maintainer publishes the prepared release.

| Target | Native runner | Formats |
| --- | --- | --- |
| macOS arm64 | macos-15 | DMG, ZIP |
| macOS x64 | macos-15-intel | DMG, ZIP |
| Windows x64 | windows-2022 | Setup EXE, Portable EXE, ZIP |
| Windows arm64 | windows-11-arm | Setup EXE, Portable EXE, ZIP |
| Linux x64 | ubuntu-22.04 | AppImage, DEB, RPM, tar.gz |
| Linux arm64 | ubuntu-22.04-arm | AppImage, DEB, RPM, tar.gz |

Run **Unsigned beta builds** from GitHub Actions for a reviewed branch. For a signed or separately selected draft, dispatch **Early beta release** with an existing tag, `platforms`, `windows_signing`, and `macos_signing`. Signed is the default for the latter two. Unsigned v0.1.0 requires `unsigned-beta` explicitly for both Mac and Windows.

The six `beta-installers-*` artifacts contain only application downloads. `beta-smoke-*` contains bounded evidence. Download both, confirm all required jobs passed, then prepare source, dependency and checksum files using the [release guide](RELEASING.md#source-archive-and-release-inventory). Do not merge evidence or profiles into the installer inventory. Complete the release's notes and installation guides before publication.

No builds enable packaged wallet signing. The [tester guide](BETA_TESTER_GUIDE.md) describes optional integrations and what native smoke does and does not establish.
