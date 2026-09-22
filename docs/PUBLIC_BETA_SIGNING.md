# Public-beta signing setup

Owner decisions, 2026-09-22: sign and notarize macOS downloads; allow an explicitly labeled **unsigned Windows early beta** until Windows signing is available. **Turtle Moon Command Center** is the legal entity; Turtle Moon remains the public company brand. Do not ship the local developer package as a public beta, change repository visibility, or publish a release automatically. The release workflow continues to create a **draft prerelease only**.

## What is ready, and what is not

- macOS builds already require a Developer ID Application identity, the expected Apple team, hardened runtime, a secure signing timestamp, Apple notarization, a stapled ticket, and Gatekeeper acceptance of the application.
- Windows builds **default to signed** and require a signing certificate plus an explicitly configured publisher name. Native verification checks the app, setup installer, and portable EXE for valid embedded, timestamped Authenticode signatures. Every certificate's publisher name must exactly match the configured name; full signer subjects must also agree across the three executables.
- The separate `unsigned-beta` Windows option requires deliberate selection, uses isolated build output and `-unsigned` download names, and displays a warning in the draft title/notes. It receives no signing secrets and must pass the same source/security/native smoke gates. Native signature inspection must confirm all three executables are genuinely unsigned, not signed incorrectly or carrying broken signatures. There is no automatic fallback from signed to unsigned.
- These are enforced build gates, not evidence that an artifact has already been signed. Synthetic policy/hook tests do not replace native signing, notarization, or clean-machine installation tests.
- At the last GitHub preflight on 2026-09-22, the repository was private, no `beta` environment existed, and no repository signing secrets were configured. Authorized local identity-metadata inspection found a valid **personal** Developer ID Application identity, not an identity issued to the legal entity. No credential values or private keys were inspected or exported. The owner must choose that personal identity explicitly or provide the company's identity; local notarization-profile selection also remains unresolved.
- The latest native CI run, [35634860404](https://github.com/HGraphPunks/satoshi-browser-1.0.0-rc.1/actions/runs/35634860404), still had failing Mac Settings-navigation, Windows service/shutdown/deep-link, and Linux recovery-notification checks. Signing configuration does not waive those failures.

## 1. Confirm the publisher and available accounts

The product is **Bitcoin Browser**, created by **Turtle Moon**, with legal publisher **Turtle Moon Command Center**. Package author and Linux maintainer metadata use the legal name. These labels do not alter the identity in a signing certificate. The certificate publisher must be the actual identity validated by Apple or the Windows certificate authority; it must not be guessed from the brand.

The owner should confirm only this non-secret information:

1. Should this beta use the available personal Developer ID identity, or wait for a Developer ID Application identity belonging to Turtle Moon Command Center? Select the exact certificate and team before signing. Do not silently substitute a person's certificate for the company.
2. For local notarization, what is the name of the existing authorized `notarytool` keychain profile? Share only the profile name, not its stored credentials. If no profile exists, the owner must choose and authorize a supported notarization method.
3. Windows credentials are not currently available. Use the explicit unsigned-beta path below for this beta. When signing is introduced, confirm the signing provider/backend and exact issued certificate publisher name first.

Do not paste passwords, certificate/private-key bundles, recovery information, or API tokens into chat, source, issues, logs, or release notes. Account enrollment, identity verification, certificate purchases, and provider selection require owner action.

## 2. macOS: Developer ID and notarization

For downloads outside the Mac App Store, use **Developer ID Application**, not Apple Development or an App Store distribution certificate. The current downloads are `.app` bundles delivered through DMG/ZIP, not a signed PKG installer. Apple's [Developer ID guide](https://developer.apple.com/developer-id/) and [certificate setup instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) describe the account requirements.

The current GitHub workflow supports an exported signing identity plus Apple ID notarization. Add the following **secrets to the protected `beta` environment**:

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | Builder-supported encoded Developer ID Application `.p12`, including the corresponding private key; never a public download URL |
| `CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_ID` | Apple ID authorized to submit for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization, not the account's ordinary password |
| `APPLE_TEAM_ID` | The exact ten-character Apple team identifier; also used to verify the resulting signature |

Use the provider/export UI and GitHub's secret-entry UI to transfer the material without echoing it in a terminal transcript. Base64 is only an encoding, not a way to make a private key safe to publish. A downloaded `.cer` by itself is insufficient: signing also needs the corresponding private key.

The local wrapper additionally supports an authorized notarization keychain profile or App Store Connect API key; those alternate methods are not wired into the current GitHub workflow. Do not mix incomplete credential groups or change to a different method without updating and testing the workflow. See [release engineering](RELEASING.md#signing).

The existing hook checks and staples the **application** before archive construction. Do not describe a ZIP as independently code-signed, or claim a DMG-container notarization ticket was checked by the application hook. On a clean Mac, download each final DMG/ZIP, extract/install it, and verify the contained application with `codesign`, `spctl`, and `stapler` as described in the release guide. No quarantine removal, Gatekeeper disabling, or ad-hoc signature qualifies a public build. Apple's [notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) explains the separate signing and notarization steps.

## 3. Windows: select a usable public-trust signing backend

### Owner-approved unsigned early-beta option

For GitHub, run **Actions → Early beta release → Run workflow**, choose an existing reviewed beta/RC tag and the OS families, then deliberately set **Windows signing → `unsigned-beta`**. Manual runs default to `signed`; tag-push runs also remain signed. A tag push will not infer the exception from missing credentials. If the signed run cannot qualify Windows, it fails; select the exception in a separately reviewed manual run rather than changing credentials or relabeling old files.

On native Windows, the equivalent packaging and verification commands for x64 are:

```powershell
npm run dist:win -- --x64 --unsigned-windows-beta
./scripts/verify-windows-signatures.ps1 -Architecture x64 -SigningMode unsigned-beta
npm run smoke:packaged -- --distribution --unsigned-windows-beta
```

For ARM64, use a native ARM64 runner and replace both `x64` architecture arguments with `arm64`. The release workflow checks native architecture and handles staging; the local commands above alone do not create a qualified GitHub release.

- Output is isolated under `release/unsigned-windows-beta`, never `release/developer`. The final downloads use names such as `bitcoin-browser-1.0.0-rc.2-windows-x64-unsigned-setup.exe`, `…-unsigned-portable.exe`, and `…-unsigned.zip`.
- Only beta/RC versions and explicit Windows-only x64/arm64 distributions are allowed. This switch cannot produce an unsigned Mac release, a stable Windows release, or a mixed-platform build.
- The wrapper removes signing/notarization credentials from its child environment, disables certificate auto-discovery and executable signing (`win.signExecutable=false`), and rejects embedded signing configuration. Icon/resource editing (`win.signAndEditExecutable=true`), Electron fuses, fixed packaging hooks, and `--publish=never` remain enabled. Both controls are tested against the pinned packager; missing signed credentials never select this mode implicitly.
- `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and `BETA_WINDOWS_PUBLISHER` are not required for this option. The protected `beta` environment and reviewer checks still apply. The Windows choice never relaxes Apple signing/notarization or Linux gates.
- Native inspection requires `NotSigned`, no embedded/catalog signature, no signer certificate, and no timestamp on every checked executable. Broken or partially signed output fails. The same complete packaged smoke/shutdown tests must pass before upload.
- Staging/draft creation use the planned signing mode end to end and reject missing or mixed-mode download sets. The draft title says **Windows unsigned** and its notes warn **UNSIGNED BETA — no verified publisher** before the ordinary release description.

Unsigned Windows binaries do not establish an authenticated publisher. Windows may warn or block installation/launch, including on systems where overriding the block is unavailable. Testers should use the official release only and must not disable antivirus, Smart App Control, or other OS protections. If blocked, record the limitation; do not promise that every Windows machine can run this beta. See Microsoft's [SmartScreen and unsigned-app guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

### Future signed Windows releases (the default build mode)

The **currently implemented backend is a linked certificate**, passed through electron-builder's `signtoolOptions`. It is not yet a managed cloud/HSM signing integration. Use it only if the certificate provider actually supplies a valid, supported signing method compatible with this backend.

Do not purchase a new Windows certificate assuming that an exportable PFX will be available: publicly trusted code-signing keys are subject to [hardware-protection requirements](https://cabforum.org/working-groups/code-signing/requirements/). If there is no existing signing setup, **Microsoft Artifact Signing's Public Trust model is a candidate for GitHub automation**, subject to eligibility and identity validation. That choice needs a provider-specific integration before it can be used here; adding Azure credentials to `WIN_CSC_LINK` will not work. See Microsoft's [setup guide](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) and the [signing options for the pinned electron-builder v26](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/). Do not use v27 configuration syntax with this repository's v26 packager.

For an existing compatible linked-certificate setup, configure:

| `beta` environment entry | Kind | Value |
| --- | --- | --- |
| `WIN_CSC_LINK` | Secret | Provider-supported signing certificate/private-key material in builder-supported form |
| `WIN_CSC_KEY_PASSWORD` | Secret | The certificate-bundle password |
| `BETA_WINDOWS_PUBLISHER` | Variable | Exact certificate publisher/common name, including capitalization, punctuation, and Unicode characters |

The workflow supplies `BETA_WINDOWS_PUBLISHER` as `SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER` to packaging and verification. The verification step receives **no signing secrets**. There is no fallback to the publisher reported by the files themselves, and no default of `Turtle Moon` that could accidentally qualify another identity. Local signed packaging needs the same `SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER` variable.

A valid signature is not a promise of zero warnings: new signed applications can still have low SmartScreen reputation. Do not claim EV or managed signing guarantees warning-free first downloads. Microsoft documents the distinction between [publisher identity and SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

## 4. Protect the GitHub release environment before adding credentials

Open [repository environments](https://github.com/HGraphPunks/satoshi-browser-1.0.0-rc.1/settings/environments) and explicitly configure `beta`:

- Require an independent release reviewer and prevent self-approval where supported. Naming an environment in YAML does not configure protection rules.
- Restrict deployment refs to reviewed beta/RC tags and the protected default branch used for manual dispatch; protect the release branch and tag creation/update/deletion.
- Put signing material in **environment secrets**, not repository files or plain variables. The Windows expected publisher is public metadata and belongs in an environment variable.
- Review the workflow, package hooks, dependencies, and selected commit before approving use of the signing identity. A signature delegates the publisher's identity to the resulting binary.
- Keep fork/pull-request CI free of release credentials. Never change to `pull_request_target` to make an external contribution's build receive secrets.

These steps require an owner-selected reviewer and signing identity. No environment, credential, visibility, or repository-protection settings are changed by the code in this document.

## 5. Public-release acceptance

Before a beta tag is built/published:

1. Commit the intended source and confirm `package.json` and lockfile versions agree. Use a new matching beta/RC tag; do not repoint a published tag.
2. Pass source tests, focused wallet/content security tests, and the dependency audit. Resolve all applicable native CI failures.
3. Run the selected native builds with an explicitly recorded Windows signing mode. Require Apple signing/notarization, the matching Windows signed/unsigned inspection, packaged smoke, and clean-shutdown gates to pass. Never convert a missing credential or failed test into an automatic unsigned fallback.
4. Inspect the resulting draft's exact download set and signing disclosures. Test downloaded installers/archives on clean machines, including the executable inside each ZIP, installation, opening deep links, persistence, quit/reopen, and uninstall without losing profile data. Record the actual expected Mac/Windows certificate identity for signed files; do not describe the unsigned exception as publisher-verified.
5. Follow the empty/test-wallet checklist. Binary signing does not certify wallet extensions, remove connection privacy risks, or authorize Bitcoin transaction signing; packaged transaction/message signing remains disabled.
6. Separately approve repository visibility and public prerelease publication. A public repository or a passing unit test does not make an untested draft ready to publish.

Linux has no directly equivalent Apple notarization/Windows Authenticode gate for all four formats. The current AppImage/DEB/RPM/TAR.GZ pipeline does **not** add package/repository signing and must not be advertised as doing so. Linux publisher-key/distribution authentication requires a separate decision. Per the earlier scope, this change adds no checksum manifest, source-archive hashing pass, or auto-updater.

Full download coverage and remaining native/installer qualification are documented in the [early-beta pipeline](EARLY_BETA_PIPELINE.md) and [beta test plan](BETA_TEST_PLAN.md).

## 6. Local verification checkpoint — 2026-09-22

Verified the current working tree under Node 22 after adding the explicit Windows exception and legal publisher metadata:

- Full source regression suite: **2,247 passed, 0 failed, 0 skipped**.
- Existing focused wallet/content/release security suite: **630 passed, 0 failed, 0 skipped**. This is regression coverage, not certification of arbitrary wallet extensions.
- Focused release-policy, signature-metadata, packaging-hook, workflow, asset and branding tests: **78 passed** (overlaps the suites above; do not add the counts together).
- Static verification: **354 JavaScript files passed syntax checks; 467 files inspected**. Bundled viewer freshness and `git diff --check` passed.
- The pinned builder's real parser/schema, unsigned signing guard and no-certificate backend path passed fixture tests. Native Windows `Get-AuthenticodeSignature`, actual unsigned installer generation, Apple signing/notarization, and clean-machine download acceptance were **not run** in this change.

No new installers were produced, no release was published, no repository visibility/protection/secrets were changed, and no credential values/private keys were inspected or exported. The running owner browser and syncing Bitcoin Core node were left untouched. No fresh dependency audit was performed in this change; the release workflow still requires one against the exact candidate. The latest native CI failures listed above remain unresolved and cannot be waived by these passes. macOS packaging still needs the owner's certificate choice and authorized notarization configuration.
