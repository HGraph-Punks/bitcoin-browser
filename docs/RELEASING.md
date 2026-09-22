# Release engineering

The first public release is **v0.1.0 beta** in [HGraph-Punks/bitcoin-browser](https://github.com/HGraph-Punks/bitcoin-browser). It uses explicitly unsigned macOS and Windows build modes. The old private RC numbering and dated investigation checkpoints remain historical records, not the public release status.

## Build modes

| Mode | Command on a native host | Output |
| --- | --- | --- |
| Developer directory | `npm run pack -- --arm64` (or `--x64`) | `release/developer` |
| Unsigned macOS beta | `npm run dist:mac -- --arm64 --unsigned-macos-beta` | `release/unsigned-macos-beta` |
| Unsigned Windows beta | `npm run dist:win -- --x64 --unsigned-windows-beta` | `release/unsigned-windows-beta` |
| Linux distribution | `npm run dist:linux -- --x64` | `release` |
| Signed macOS / Windows | Same distribution command without its unsigned flag | Requires complete signing configuration |

Replace architecture flags with the native machine's architecture. The unsigned beta flags are explicit, strip signing secrets from the packaging child, isolate output directories and label filenames. macOS keeps an ad-hoc application integrity signature. They do not disable Electron sandboxing, hardened fuses, ASAR integrity, tests or shutdown checks. Only v0.1.0 and the accepted beta/RC version pattern qualify; arbitrary stable versions do not.

The internal package name `satoshi-browser` and app ID `org.satoshibrowser.desktop` remain fixed for profile compatibility. Public artifacts use **Bitcoin Browser** / `bitcoin-browser`. Linux package-manager identity remains `satoshi-browser`.

## Required source checks

Use Node.js 22.23.2 and a clean checkout. Update package.json and both lockfile version roots together.

```sh
npm ci
npm run verify
npm run security:beta
npm audit --audit-level=high
```

Do not commit signing credentials, environment files or test profiles. `.gitattributes` fixes text files to LF so generated viewer checks compare the same bytes on Windows and POSIX hosts.

## Native builds and runtime checks

[Unsigned beta builds](../.github/workflows/beta-build.yml) builds macOS arm64/x64, Windows arm64/x64 and Linux arm64/x64 on native runners. It is manually dispatchable, and also runs on the private staging branch used to prepare v0.1.0. It uploads packages only after source checks, packaging and full native smoke pass. It never publishes a release or needs signing credentials.

Run the matching smoke locally after packaging:

```sh
# macOS
npm run smoke:packaged -- --distribution --unsigned-macos-beta
# Windows
npm run smoke:packaged -- --distribution --unsigned-windows-beta
# Linux (GUI-less CI host)
dbus-run-session -- xvfb-run -a npm run smoke:packaged -- --distribution
```

Windows also verifies all executable signing states with `scripts/verify-windows-signatures.ps1 -Architecture x64 -SigningMode unsigned-beta` (choose arm64 on ARM). Normal Windows window closure is requested with WM_CLOSE; the Node SIGTERM forced-stop behavior is not treated as a graceful app shutdown.

Collect the bounded JSON smoke reports independently of the download assets. Do not upload browser profiles. State the tested scope accurately: automated native application checks and artifact inspection do not replace every end-user clean-install, OS reputation, accessibility, wallet or node test. Keep applicable limitations in the release notes.

## Source archive and release inventory

After freezing source and documentation, run:

```sh
npm run source:archive
node scripts/verify-source-archive.mjs
```

This regenerates `SOURCE_MANIFEST.json` and a deterministic `release/satoshi-browser-0.1.0-source.tar.gz`. The public release may name that same verified file `bitcoin-browser-0.1.0-source.tar.gz`; pass its renamed path to the verifier when needed. The contained directory retains the internal package name. Repeating archive generation must produce the same hash. Generation and verification share exclusions for build output, node_modules, Git data, local profiles, logs, environment files and key files; `.env.example` is allowed. Symlinks are not archived.

Commit the refreshed source manifest before creating the release tag. It inventories source files but excludes itself, avoiding recursive hashing. Do not modify tracked files after the tag's archive is generated.

Download only the six successful `beta-installers-*` artifacts from the reviewed run. Check the inventory with `expectedAssets(version, BETA_TARGETS, 'unsigned-beta', 'unsigned-beta')` from `scripts/beta-release.mjs`: v0.1.0 has **18 application downloads**, with no blockmaps, updater metadata or profiles. Add:

- verified source archive;
- SPDX dependency inventory and dependency-audit JSON;
- bounded native smoke evidence;
- `release-manifest.json` with source/build commit, run IDs, OS/architecture, filenames, byte sizes and SHA-256 values;
- `SHA256SUMS` for every published asset except the checksum list itself.

Hash the final bytes, including the manifest. Compare downloaded assets against their recorded hashes after upload. Platform-signed reproducibility is not promised by the deterministic source archive.

## Publish

Create the public repository only when the prepared builds and docs are ready. The first commit must retain the exact imported source tree; release changes follow it. Push `main`, then the reviewed `v0.1.0` tag. Create a **prerelease**, initially as a draft, upload the exact verified assets and notes, review the complete inventory, then publish. The task authorizes publication once these preparations are complete.

The separate [Early beta release workflow](../.github/workflows/release.yml) supports existing tags and manual `windows_signing` / `macos_signing` choices. Its defaults remain signed, its final action only creates a draft, and signing credentials are scoped to the appropriate platform build. v0.1.0 is accepted on manual dispatch; its tag push does not silently trigger signed jobs. See [signing setup](PUBLIC_BETA_SIGNING.md) before a future signed release.

## Updates

There is no auto-updater in this beta. Users download a new release, quit and replace/install the app. Preserve the profile and document any future migrations. Update README and the Turtle Moon site's links only to actual published assets, with the correct signing status and platform scope.
