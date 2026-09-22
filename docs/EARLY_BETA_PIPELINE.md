# Early-beta security and release pipeline

This is a practical qualification pipeline, not a certification that every wallet or operating system is safe. It adds no About page, source freeze, checksum manifest, or auto-updater. The previously documented native startup/shutdown and compatibility blockers are not waived by installing this workflow. Public release remains a separate owner decision after those gates are closed.

Subsequent UI work added an offline About page (`satnav://about`), crediting Turtle Moon with its bundled logo and owner-supplied website link. The separately supplied donation address/QR are documented in [donations](DONATIONS.md); the release workflow does not change that feature. The owner confirmed **Turtle Moon Command Center** as the legal entity on 2026-09-22; package author and Linux maintainer metadata use that name without changing the in-app brand.

## What runs

- **Push / pull request / manual CI:** pinned Node and Actions, lockfile install, source checks, the full Node test suite, a named wallet/content security suite, and `npm audit --audit-level=high` including development dependencies. Developer Electron packages are smoke-tested natively on Linux x64, Windows x64, and Apple Silicon macOS.
- **Weekly:** the source/security/dependency job runs again so new dependency advisories do not wait for a code change. Native packaging is omitted from scheduled runs to limit cost.
- **Beta release:** validate an existing beta/RC tag against `package.json`; bind all jobs to its checked-out commit; repeat verification; build and run the full native packaged smoke suite on every selected architecture; stage an exact download set; recheck the remote tag; create a **draft prerelease only**.

High/critical advisories, test failures, wrong-architecture execution, invalid signatures, missing Mac notarization, missing/empty downloads, unexpected uploaded files, and a moved tag stop the run. No `continue-on-error`, automatic unsigned installer fallback, sandbox-disabling flag, or automatic dependency fix is used. Windows defaults to signed; the owner-approved **explicit unsigned-beta option** has separate filenames, native unsigned-status verification, and prominent release warnings. It retains all functional/security gates. Network/audit failures also stop the gate; rerun after the service recovers, rather than bypassing it.

## Download coverage

New builds use **Bitcoin Browser** as the product name and `bitcoin-browser-` as the download prefix. macOS bundles and Windows executables use `Bitcoin Browser`; Linux uses `bitcoin-browser`. The internal package name/application ID and existing profile partitions remain unchanged for compatibility. Native lookup, signature checks and staged-download validation use the new names together; old artifacts are not renamed or qualified by this source change.

| OS family | Native runners | Architectures | Downloads per architecture |
| --- | --- | --- | --- |
| macOS | `macos-15-intel`, `macos-15` | Intel x64, Apple Silicon arm64 | DMG, ZIP |
| Windows | `windows-2022`, `windows-11-arm` | x64, arm64 | NSIS setup EXE, portable EXE, ZIP |
| Linux | `ubuntu-22.04`, `ubuntu-22.04-arm` | x64, arm64 | AppImage, DEB, RPM, TAR.GZ |

**All** produces 18 uniquely named downloads if all six builds pass. A manual run may select `macos`, `windows`, or `linux` to qualify one OS family without pretending the omitted families passed. Existing archive formats are preserved. Linux filenames use the packager's conventional architecture labels: x64 DEB is `amd64`, x64 AppImage/RPM are `x86_64`, and arm64 RPM is `aarch64`; the other archive labels stay `x64`/`arm64`. The staging contract is tested against the pinned builder's actual architecture/macro formatter. Linux TAR.GZ provides a manual-install option beyond DEB/RPM distributions; it does not prove compatibility with every Linux distribution or an older libc. AppImage may require FUSE support on the user's machine.

GitHub runner availability and billing depend on repository/account settings. The matrix uses [GitHub's documented native hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Electron targets follow the [electron-builder Linux targets](https://www.electron.build/v26/docs/linux/) and [architecture support](https://www.electron.build/v26/docs/architecture/). Native smoke tests run the unpacked application used to construct the downloads; they are **not** installer/uninstaller or clean-user acceptance tests. Windows ARM64 local Core/Ord automatic downloads and platform-specific local-service fixtures are not all implemented; browser packaging support does not imply managed-node feature parity.

Snap, Flatpak, Microsoft Store, Mac App Store, distro repositories, 32-bit platforms and universal Mac bundles are not advertised by this pipeline. They need separate portal, signing, sandbox, or platform qualification. The existing developer CLI architecture options remain available.

## One-time GitHub setup

Start with the [public-beta signing checklist](PUBLIC_BETA_SIGNING.md). It covers signed/notarized macOS, the explicitly unsigned Windows beta exception, and the future signed Windows backend choice. Configured identities and passing synthetic tests are not verified release artifacts.

1. Review and commit the pipeline and application changes to the release branch. Do not move an existing published tag to pick up new code. The workflow must exist at the selected tag, and the manual workflow must also exist on the default branch.
2. Create/configure the **`beta` environment** in Settings → Environments. Require an independent reviewer, prevent self-review where available, and restrict deployment refs to the reviewed release tags and the protected default branch used for manual dispatch. Protect the release branch and beta/RC tag creation/update/deletion with repository rules. A YAML environment name alone does **not** configure these protections. Do not approve a run without reviewing its workflow, scripts, application changes, and exact tag/commit.
3. Store signing credentials as **environment secrets**, not plaintext files, repository variables, or pull-request secrets. Mac builds use `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. **Signed** Windows builds use `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, plus the public **environment variable `BETA_WINDOWS_PUBLISHER`** containing the exact certificate publisher name. Missing or mismatched publisher identity fails the signed build/verification; it never selects unsigned automatically. Explicit `unsigned-beta` Windows builds need none of those Windows entries and receive no signing secrets. Linked certificates can be the builder-supported encoded certificate material; do not use publicly downloadable private certificates. This initial signed workflow uses certificate-based Windows signing; a managed signing service requires a reviewed adapter, not a bypass. Do not assume newly issued Windows certificates allow exportable private keys.
4. Review the public Linux publisher contact: **`Turtle Moon Command Center <hgraphpunks@gmail.com>`** (email confirmed 2026-09-21, legal name confirmed 2026-09-22). It is the default in both `package.json` and the workflow; an optional **`BETA_LINUX_MAINTAINER`** environment variable can override it in `Name <email>` form. DEB/RPM require this metadata, and invalid overrides fail packaging. CI derives the homepage from the current GitHub repository URL; local packaging uses the confirmed `https://github.com/HGraphPunks/satoshi-browser-1.0.0-rc.1` homepage. Public maintainer metadata is not a signing credential or confirmation of a monitored private security-reporting channel.
5. Enable GitHub Actions and hosted ARM64 runners for the repository as needed. Allow the publish job's narrowly scoped `contents: write` permission. No personal access token is required for release creation. Add the source/security and native CI checks to the protected branch's required checks after their first successful run.

Only signing build steps receive their respective platform secrets. Tests and native smoke steps do not receive them. PR CI has read-only repository permissions and no release credentials. Checkout does not persist a Git credential, dependency caching is disabled for this small project, and only the final draft job requests repository write access. Dependencies and packager hooks execute code on build runners, so environment approval and review remain important even with pinned dependencies.

## Prepare a beta draft

1. Set an early-beta package version, for example `1.0.0-rc.2` or `1.0.0-beta.1`, and update the lockfile root version consistently. Review and merge it with the intended source. Tags must be exact `v<package.version>` values; stable tags and arbitrary branch names are rejected.
2. Create and push the matching tag through your normal reviewed GitHub workflow. A beta/RC tag push selects all six native builds automatically, with **signed Windows**. Alternatively, run **Actions → Early beta release → Run workflow**, choose the protected default branch, enter an **existing** matching tag, select the desired OS family or **all**, and choose **Windows signing** (`signed` by default, or deliberately `unsigned-beta`). With no Windows credentials, use the explicit manual exception; an automatic signed run will fail, not fall back. The workflow checks out the tag, not whichever branch happened to be selected for dispatch, and carries the signing choice through verification, staging and draft notes.
3. Approve the protected environment only after reviewing the exact source. Inspect all source, dependency, signing, native smoke, and shutdown results. A native hang or bootstrap error remains a failure; do not make the test optional to produce downloads.
4. Successful jobs upload `beta-installers-<os>-<arch>` for 14 days and separate bounded `beta-smoke-<os>-<arch>` reports. Only installer artifacts enter the draft. Profiles, logs, `.yml` update metadata, blockmaps and developer packages are not attached to the release. GitHub's Actions artifacts are temporary maintainer downloads, not a substitute for a published release.
5. The final job creates a draft marked prerelease and fills in the actual download names and signing status. Unsigned Windows downloads carry `-unsigned`, the title says **Windows unsigned**, and the opening notes state there is no verified Windows publisher. Review/edit the release-note checklist without removing those disclosures. Complete the clean-machine and real-wallet checks below, resolve applicable open beta blockers, and finalize owner/contact/security-distribution details before manually publishing. Drafts are not generally visible to external testers without repository access.

Unsigned Windows output is built under `release/unsigned-windows-beta`; the original directory-only `release/developer` path remains internal. Staging reads only the source directory for the selected mode and rejects missing, stale, or mixed signed/unsigned downloads. Eighteen formats remain available in an all-platform run; only the six Windows filenames acquire the unsigned qualifier. See the [local Windows commands](PUBLIC_BETA_SIGNING.md#owner-approved-unsigned-early-beta-option). Neither this mode nor a signing pass waives the native CI failures recorded in the signing checklist.

The workflow never edits an existing release or replaces its assets. If draft creation/upload fails midway, a partial **draft** may remain. Inspect it; either deliberately remove that draft using GitHub's UI before retrying, or use a new reviewed version/tag. Never repoint a published tag or overwrite downloads that testers have already received.

## Wallet safety gate and acceptance

Run locally with Node 22:

```bash
npm run security:beta
npm run verify
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

The focused suite uses synthetic wallets, fake public account data and controlled collaborators. It checks passive discovery, explicit connection, account-response bounds, cancel/reject behavior, disconnect and extension-removal revocation, bridge crash/close recovery, stale approval fencing, IPC sender restrictions, separate wallet storage, opaque hostile inscription content, and Electron packaging protections. It executes the real application entrypoint with a packaged flag to verify an environment override cannot enable signing. Direct manager tests require disabled signing to reject before payload parsing, an approval dialog, or wallet transport. The native smoke suite additionally loads a deterministic MV3 extension in an actual packaged Electron process, attempts signing with the environment flag enabled, tests hostile content/network boundaries, restarts the app, and requires clean process termination.

**What a pass means:** the covered application paths preserve connection-only behavior and isolation for the tested fixtures/build. The app does not import seed phrases or private keys. Connecting may disclose selected public accounts to the app, and subsequent provider queries can disclose addresses to the configured providers. Local-only routing and offline mode have their existing meanings; connection is not a privacy guarantee.

**What a pass does not mean:** a malicious, compromised, incompatible or incorrectly obtained wallet extension is safe. Extensions are operator-selected local programs, not authenticated by this pipeline. Supported API detection is not a certified wallet/version list. Start with an empty test wallet and no valuable funds; never type a seed phrase or private key into Bitcoin Browser. Packaged PSBT and message signing remain disabled. Do not enable signing or use mainnet funds to qualify this beta.

Before advertising a real wallet/version, record this checklist for **each exact wallet version, OS, architecture and beta version**. The initial status is **NOT RUN**, not pass:

- Obtain the wallet from its verified publisher and install it only through the Wallet Bridge extension workflow in a fresh test profile. Confirm the sandboxed inscription and main browser pages do not receive its provider object.
- Discovery/list refresh must not request accounts or show transaction/signing prompts. Test approve and reject of an explicit connection with synthetic/empty accounts. Verify selected public addresses and network labels against the wallet UI.
- Browse hostile text/HTML/SVG fixtures and ordinary inscriptions while connected. No unsolicited account approval, signature, transaction, popup or download should occur.
- Disconnect, close/reopen the bridge, restart the app, remove the extension, and cancel a pending connection. No stale “connected” state or late approval should restore authority.
- Confirm PSBT/message signing is unavailable, no unexpected broadcast occurs, and extension errors remain recoverable. Do not inspect or export credentials. Record public behavior, versions, results and redacted error codes only.

For each downloadable format, a clean-machine tester must also install, launch, inspect publisher trust where applicable, test deep links and profile persistence, quit/reopen, update from the previous beta if one exists, and uninstall without removing the user's data. Native workflow smoke alone does not cover these actions. Preserve `fail`, `blocked` and `not run` statuses in the [beta test plan](BETA_TEST_PLAN.md); the [requirements matrix](BETA_REQUIREMENTS_MATRIX.md) remains the overall release gate.

## Deliberately deferred

No source archive, source-hashing pass, new checksum/manifest generation, or checksum release assets are added or run in this batch. Existing package-manager integrity checks, immutable Action revision pins, builder/code-signing internals, and the existing native smoke report's artifact identity are retained; these are not a newly introduced hashing project. The historical source/archive commands in [release engineering](RELEASING.md) remain a **later, explicitly authorized release-ownership task**, not a step in this early-beta workflow. Linux repository/package signing, future Windows signing, final trusted distribution details, and any updater remain follow-ups. About identity/links and donations were implemented separately. Creating a draft does not waive publication requirements.
