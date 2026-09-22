# Release engineering

For the GitHub draft-release workflow, start with the [early-beta pipeline guide](EARLY_BETA_PIPELINE.md). That pipeline intentionally defers new source/archive hashing and checksum manifests. About has since been added separately (`satnav://about`), with Turtle Moon credit, its bundled logo and the owner-supplied website link; the later owner-supplied donation address/QR are covered in [donations](DONATIONS.md). **Turtle Moon Command Center** is the legal publisher; in-app Turtle Moon branding is unchanged. Historical archive/checksum procedures below describe later publication requirements, not steps to run in this pipeline batch.

## Release classes

- **Source release candidate**: verified source archive, checksums, manifest, documented limitations.
- **Unsigned internal build**: packaged application used only for testing.
- **Explicit unsigned Windows early beta**: separate Windows-only beta/RC distribution with `-unsigned` filenames and a no-verified-publisher warning; all source/security/native gates still apply. It is not a signed candidate or a stable release.
- **Signed candidate**: platform-signed/notarized artifacts generated from a protected CI ref.
- **Stable release**: signed candidate that passes the full platform, node, provider, wallet, security, accessibility, and update matrix.

This repository is undergoing controlled-beta qualification. The [2026-09-21 packaging checkpoint](BETA_PACKAGING_CHECKPOINT_2026-09-21.md) records three consecutive full native smoke passes on its macOS arm64 developer artifact, but does not establish a fix for historical early-debugger sandbox failures or the native shutdown hang. The [requirements matrix](BETA_REQUIREMENTS_MATRIX.md) and [shutdown investigation](NATIVE_SHUTDOWN_INVESTIGATION.md) distinguish passing controls from unresolved gates. It intentionally contains no private signing material. `npm run pack` produces only a local test directory under `release/developer`; public distribution must use the reviewed release workflow and complete every applicable gate below. macOS remains signed/notarized; the only unsigned Windows exception is the explicitly selected, labeled early-beta mode. Linux currently has no package/repository signing gate.

## Prerequisites

- clean protected branch and reviewed commit;
- supported Node/npm versions;
- exact dependency versions and reviewed lockfile;
- current Electron security review;
- platform signing identities stored in CI secret management;
- update/publication endpoint ownership when auto-update is introduced;
- tested provider and wallet version matrix; and
- reproducible artifact manifest/checksums.

## Local source verification

See the [current execution checkpoint](BETA_EXECUTION_PLAN.md) and [startup-preparation evidence](../release/startup-preparation-verification-20260909.json). Source-test and offline instruction passes do not qualify native startup/shutdown or a distributable artifact; D-07 collection and all final native/release gates remain open.

```bash
npm ci
npm run verify
npm audit --audit-level=high
npm run pack
npm run smoke:packaged
npm run source:archive
```

Capture:

```bash
node --version
npm --version
npm ls --all
npm audit --omit=dev
```

Electron is currently a development dependency because it is the packaging runtime. Audit both production and development dependencies for a desktop release.

## Packaged smoke matrix

`scripts/packaged-smoke.mjs` automates the deterministic subset using a temporary clean profile. On Linux CI it runs under `xvfb-run`; macOS and Windows run it directly. The report is written to `release/packaged-smoke-report.json`. For each advertised target platform/architecture, complete the remaining manual/integration subset:

1. Install from the produced artifact on a clean user account.
2. Verify the release's recorded signing status before first launch: publisher identity/notarization for signed apps, or the explicit unsigned Windows disclosure and matching `-unsigned` filename. An unsigned build has no authenticated publisher; stop/report an OS block instead of disabling security controls.
3. Launch without a node or wallet and confirm recoverable empty/error states.
4. Check default source health and external navigation confirmation.
5. Add a fixture/mock source in a test profile and browse each target kind.
6. Connect local Bitcoin Core and ord; compare representative results to their CLIs.
7. Render hostile inscription fixtures: popup, top navigation, permission request, external fetch, wallet detection, large media, recursive loop, deep graph, and malformed MIME.
8. Install each supported wallet version; discover/connect/reject/disconnect accounts, inspect a fixture PSBT, and remove the extension. For this beta, verify PSBT/message signing controls remain unavailable and requests return `FEATURE_DISABLED`, including with the signing environment variable set. Signet/regtest signing qualification belongs to a separately authorized future signing-enabled scope; do not enable it to complete this beta checklist.
9. Launch/stop configured local services and terminate the app while they run.
10. Corrupt primary state/cache indexes and verify backup/repair behavior.
11. Test deep links, second-instance handling, tab restoration, offline cache, local-only mode, provider failure/fallback, and diagnostics export.
12. Test keyboard-only navigation, screen-reader labels, high zoom, reduced motion, narrow window, dark/light/system themes, and long translated/data strings.
13. Confirm no app-session permissions, popups, Node globals, webviews, wallet injection, or external inscription network access in default mode.
14. Inspect packaged Electron fuses.

Do not convert a skipped platform check into a pass. Record `pass`, `fail`, `blocked`, or `not applicable` plus the artifact SHA-256 and environment for every row in [`BETA_TEST_PLAN.md`](BETA_TEST_PLAN.md).

## Signing

### macOS

Use a Developer ID Application identity, hardened runtime, entitlements, and notarization credentials. `scripts/package.mjs` fails a macOS distributable build before packaging unless it has a signing identity and complete credentials for at least one builder-supported notarization mode: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`; `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` plus `SATOSHI_BROWSER_EXPECTED_TEAM_ID`; or `APPLE_KEYCHAIN_PROFILE` plus `SATOSHI_BROWSER_EXPECTED_TEAM_ID` (optionally `APPLE_KEYCHAIN`). Never put credential values in source or reports. A keychain profile name and expected team are sufficient to select an already authorized stored profile; credential-store access requires explicit authorization.

The wrapper accepts only platform/architecture selectors and the advertised target names. It rejects config/project/prepackaged/publish overrides, sanitizes inherited internal mode flags, forces macOS signing/notarization, and sets `--publish=never`. `--unsigned` requires `--dir`, rejects archive targets, removes signing/notary variables from the child environment, and uses the separate developer output directory. Customize build configuration through reviewed source changes, not bypass flags.

Fuse and checked Info.plist hardening/readback occur before signing. After electron-builder waits for Apple notarization, `scripts/after-sign.cjs` verifies the Developer ID authority, exact TeamIdentifier, hardened runtime, timestamp, and deep signature, staples and validates the ticket, and requires Gatekeeper acceptance before archive construction. Regression tests prove individual hook failures stop subsequent commands; a successful notarized end-to-end run still requires credentials and is not established by mocked tests. Verify the final downloaded artifact independently:

```bash
codesign --verify --deep --strict --verbose=2 "Bitcoin Browser.app"
codesign -dvvv "Bitcoin Browser.app"
spctl --assess --type execute --verbose=4 "Bitcoin Browser.app"
xcrun stapler validate "Bitcoin Browser.app"
```

The identity must be a Developer ID Application identity with the expected team ID, `spctl` must accept the artifact, and stapler must find a valid notarization ticket. An ad-hoc signature from `npm run pack` is valid only for local execution and must fail the public-distribution identity gate.

Typical CI variables depend on the signing integration but include certificate material/password and Apple notarization credentials. Use least-privilege app-specific credentials or a Team-scoped App Store Connect API key. Missing and partially populated credential groups are release errors, never a reason to skip notarization.

### Windows

**Signed is the default.** Use an organization-owned Authenticode certificate. The wrapper requires `WIN_CSC_LINK` (or `CSC_LINK`) and `SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER`, and forces signing in this mode; missing credentials or unsigned files are errors, never a fallback. GitHub supplies that public publisher name from the protected `beta` environment variable `BETA_WINDOWS_PUBLISHER`, separately from the Windows-specific signing secrets. The name must exactly match the issued certificate, not a guessed marketing brand. A hardware-backed or managed signing service needs a separately reviewed integration; do not assume a newly purchased certificate offers an exportable PFX. The workflow verifies valid embedded, timestamped signatures on the application, setup installer and portable executable, requires each publisher name to match the configured identity, and requires their full publisher subjects to agree.

**Owner-approved early-beta exception:** `npm run dist:win -- --x64 --unsigned-windows-beta` (or `--arm64`) builds only beta/RC versions into `release/unsigned-windows-beta`. It strips signing/notarization credentials from the child environment and preserves icon editing, fuses and fixed packaging hooks. On native Windows, run `./scripts/verify-windows-signatures.ps1 -Architecture x64 -SigningMode unsigned-beta` and `npm run smoke:packaged -- --distribution --unsigned-windows-beta`. Use `arm64` verification on a native ARM64 runner. The full test/shutdown suite is unchanged. Native status verification rejects broken, partial, or unexpected signatures; the required state is truly unsigned with no signer/timestamp. This mode cannot be used for unsigned Mac, stable-version, mixed-platform or directory-only distributions.

The native Windows trust verdict is obtained with `Get-AuthenticodeSignature`; a bounded, dependency-free policy validator tests the exact executable inventory and selected signed/unsigned contract. GitHub exposes the exception only through the manual `windows_signing: unsigned-beta` choice; tag pushes/default manual runs remain signed. Staging and draft notes use that same choice: six Windows downloads gain `-unsigned`, and the draft title/opening notes disclose the missing verified publisher. No Windows certificate/publisher settings are needed in this explicit mode. Also validate the downloaded packages on a clean machine, including the executable inside each ZIP. Windows may block unsigned software; do not ask testers to disable security protections. The builder configuration retains update signature verification even though auto-update is not included yet. See the [public-beta signing checklist](PUBLIC_BETA_SIGNING.md) for account setup and public-release acceptance.

### Linux

Trusted publication should provide checksums and repository/package signatures through authenticated infrastructure; that work is deferred from the current early-beta pipeline request. Test AppImage, DEB, RPM and tarball targets on each advertised distribution. The owner-confirmed default public maintainer is `Turtle Moon Command Center <hgraphpunks@gmail.com>` in local packaging and CI; `BETA_LINUX_MAINTAINER` is an optional CI override, validated in `Name <email>` form. CI derives the package homepage from its GitHub repository. Local packaging uses the confirmed `https://github.com/HGraphPunks/satoshi-browser-1.0.0-rc.1` homepage. This metadata does not establish repository access, publisher signing or a monitored private security-reporting channel.

## CI workflows

`ci.yml` runs lockfile installation, static/unit verification, focused wallet/content security tests, dependency audit and native developer-package smoke on Linux, Windows and macOS. Its weekly run repeats source/security/audit checks only. `release.yml` validates a matching beta/RC tag, tests the exact selected commit, builds both native architectures for each selected OS family, and runs the full packaged smoke against distribution staging. Actions are pinned to immutable commits; signing secrets are scoped to their platform build step inside the protected `beta` environment. Build jobs have read-only repository permissions; only draft creation receives write access. Uploads are allowlisted, architecture-qualified installer/archive names, with bounded native reports in separate artifacts. Publication rechecks the remote tag and creates a draft prerelease only, never replacing an existing release. See the [pipeline guide](EARLY_BETA_PIPELINE.md) for the six-target matrix, manual dispatch, secrets, protections, and clean-machine/wallet acceptance. Declaring an environment in YAML does not configure approval rules. No workflow or remote publication was executed from this workspace.

## Artifact manifest

Public product/bundle names and download prefixes are now **Bitcoin Browser** / `bitcoin-browser`. The internal `name: "satoshi-browser"` and `org.satoshibrowser.desktop` application ID remain stable to avoid an implicit profile migration. Do not change the top-level Electron package name/productName or call `app.setName` solely to adjust branding; the public name is configured separately. Existing artifacts and historical qualification records are not renamed.

Each release should include a machine-readable manifest:

```json
{
  "name": "satoshi-browser",
  "version": "1.0.0-rc.1",
  "sourceRevision": "<git commit>",
  "generatedAt": "<ISO-8601>",
  "artifacts": [
    { "path": "...", "bytes": 123, "sha256": "...", "signed": true }
  ],
  "verification": {
    "staticChecks": "pass",
    "unitTests": { "passed": "<actual>", "failed": 0 },
    "packagedSmoke": { "passed": "<actual>", "failed": 0 }
  }
}
```

Source archives should exclude node modules, caches, chain data, wallet data, credentials, logs, generated installers, and signing assets.

`npm run source:archive` regenerates `SOURCE_MANIFEST.json` from the source payload (excluding the manifest itself) and writes a deterministic gzip/tar archive. Run it twice and require identical SHA-256 values before publication.

After each generation, run `node scripts/verify-source-archive.mjs` under Node 22 against the unchanged workspace. An optional positional argument selects an exact archive path. The read-only verifier rejects malformed/oversized gzip and tar input, unsafe/duplicate/non-regular entries, unexpected USTAR link/prefix fields, package/manifest identity mismatch, missing/extra files, mode changes, and byte/hash differences between workspace, manifest and archive. It extracts no files. Preserve both actual verifier outputs and archive hashes. Source or included-documentation changes invalidate the comparison; freeze included files while generating and verifying. This proves a content-addressed local snapshot, not authenticated source ownership or reproducible signed binaries.

## Auto-update strategy

Auto-update is intentionally not implemented in this source candidate. A secure implementation requires:

- signed update metadata and artifacts;
- HTTPS endpoint ownership and pinning strategy evaluation;
- staged rollout and rollback;
- explicit channel selection;
- signature verification before install;
- no silent downgrade;
- release notes and user control; and
- offline/local-sovereign deployments that can disable checks completely.

Do not add an updater pointed at an unowned public bucket.
