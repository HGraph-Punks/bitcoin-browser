# Beta packaging checkpoint — 2026-09-21

## Outcome

**Latest follow-up:** the owner subsequently authorized the source commit/push and a matching draft-release run. The local GitHub CLI can access the private repository as `HGraphPunks`; source/lockfile version `1.0.0-rc.2` is prepared. The protected `beta` environment and signing secrets are absent, so source CI can proceed but the release tag and signed installer builds remain pending. The sections below preserve the earlier RC.1 local-artifact checkpoint, not a claim that RC.2 has already been packaged or released.

**Local Apple Silicon Mac package built and tested. Cross-platform tester distribution remains blocked.** No GitHub commit, push, tag, workflow dispatch, release or publication was performed. Package version remains `1.0.0-rc.1`; the current source changes are not represented by the repository's existing `5069a07` initial commit.

The local engineering app is [Bitcoin Browser.app](<../release/developer/mac-arm64/Bitcoin Browser.app>). It is ad-hoc signed for local execution, **not** Developer ID signed/notarized and not a distributable DMG/ZIP. Do not send this directory to external testers as a trusted release download.

## Verification

Environment: macOS **26.5.2**, native **arm64**, Node **22.23.2**, Electron **44.2.0**, electron-builder **26.16.0**. Dependencies were already installed from the project lockfile; this checkpoint did not perform a fresh `npm ci`. The GitHub workflow must still do that on its exact release commit.

- Full source suite: **2,176 passed**, zero failures, cancellations, skips or todos.
- Focused beta security suite: **573 passed**, zero failures, cancellations, skips or todos.
- Static verification: **344 JavaScript syntax checks**, **444 inspected files**; PDF/JXL generated workers are current; `git diff --check` passes.
- Fresh `npm audit` against `registry.npmjs.org`: **zero reported vulnerabilities**, including build dependencies. This is an advisory check, not proof of complete security.
- All **125 files under `src/`**, plus README, LICENSE and SECURITY, were compared byte-for-byte with their packaged ASAR entries. Packaged version and main entry match the project.
- Actual packaged fuse readback confirms RunAsNode, Node options, Node CLI inspection and extra file-protocol privileges disabled; cookie encryption, embedded ASAR integrity and ASAR-only loading enabled. The build's ad-hoc signature verification also passed.
- **Three consecutive full native smoke suites passed 34/34 each** on the same final artifact, with zero skips. Reports: [r4](../release/packaged-smoke-beta-local-20260921-r4.json), [r5](../release/packaged-smoke-beta-local-20260921-r5.json), [r6](../release/packaged-smoke-beta-local-20260921-r6.json).
- Each suite recorded seven clean packaged main-process launches/shutdowns: **21 total**, all confirmed closed with exit code zero, no forced exit, no unclassified bootstrap errors and no unconfirmed owned processes. Generated smoke profiles were removed. These 21 observations belong to the three suites; they are **not** the separate 20 additional lifecycle cycles requested by the broader qualification plan, nor a system-wide descendant-process audit.

Native coverage includes shell/IPC isolation, synthetic wallet discovery/connect/disconnect/removal/restart, disabled packaged signing, hostile content probes, HTTP/WS/TLS policy boundaries, settings, tabs, clipboard fallbacks, bookmarks/history, source failover/recovery, managed fixture services, offline cache integrity, corrupt-state backup recovery and persistence across restarts. It does not certify a real wallet extension, all inscription formats, live node synchronization or every app workflow.

## Corrections made during packaging

The earlier package runs are retained as evidence: [initial run](../release/packaged-smoke-beta-local-20260921.json), [r2](../release/packaged-smoke-beta-local-20260921-r2.json), [r3](../release/packaged-smoke-beta-local-20260921-r3.json).

- Updated old smoke expectations for **Copy identifier**, progressive error details, offline/source status and the structured extension-mutation outcome. Removal now verifies both the committed mutation and independent extension-list readback before restart.
- Simulated actual omnibox input events and waited for the navigation progress indicator. The shell intentionally remains interactive during lookup; its bootstrap `aria-busy` flag is no longer a lookup-completion signal. This corrects premature checks against loading placeholders and missing history/provenance.
- Exercised Home shortcuts through the visible **Tools & setup** disclosure and retained bounded library-failure snapshots.
- Corrected the built-in **mock** provider's content/recursive metadata to declare the HTML its `fetchPath` actually serves. The hostile HTML fixture now follows the normal sandboxed viewer path. Real-provider behavior, wallet permissions, sandbox rules, signing gates and shutdown checks were not relaxed.
- Added regression tests and a [tester guide](BETA_TESTER_GUIDE.md), linked from README.

The first run also recorded one forced shutdown. Later passes do not establish the root cause of that failure or close the separate historical early-debugger/native shutdown investigations. No runtime shutdown workaround, forced-success exit, sandbox disablement or ignored failure was introduced. Keep those investigations visible during broader platform qualification.

Old local bundles were preserved, not deleted: the pre-existing developer directory is under `release/developer-before-2026-09-21`; the first build from this session is under `release/developer-before-fixture-2026-09-21`.

## Remaining distribution gates

| Platform | Existing workflow targets | Current deliverable / outstanding work |
| --- | --- | --- |
| macOS | Intel x64 and Apple Silicon arm64; DMG + ZIP | arm64 engineering app only. Developer ID signing, notarization, native signed-build smoke and clean-machine installer acceptance remain unverified. Intel build/testing not run. |
| Windows | x64 and arm64; setup EXE + portable EXE + ZIP | No current installer built. Authenticode configuration and native build/smoke/installer acceptance required. |
| Linux | x64 and arm64; AppImage + DEB + RPM + tar.gz | No current distribution built. Public maintainer contact is now configured; native build/smoke/distribution acceptance required. |

The existing six-job release matrix plans **18 downloads**, but that is not evidence that any of those installers currently exists. Draft release creation remains gated on source/security checks, native signing where applicable, smoke and expected-asset validation.

Before continuing:

1. Restore connected GitHub access to the owner-confirmed `HGraphPunks/satoshi-browser-1.0.0-rc.1` repository. The connected GitHub API still returned **404** after confirmation. This does not prove the repository is absent—it may be private or inaccessible to the connected account.
2. Authorize preparing a reviewed release commit and a new matching prerelease version/tag from the current working tree, then running the native GitHub pipeline. Do not push/tag the old commit and present its artifacts as the latest source. Do not sweep unrelated marketing archives into the release commit. Keep the resulting release a **draft** pending owner review.
3. Configure/confirm protected `beta` environment signing inputs: Mac `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; Windows `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`. These are secret names, not a request to paste secret values into chat. No signing credential or credential-store enumeration was performed here.
4. Confirm monitored feedback and private security-reporting destinations for the release invitation/notes. The owner supplied `hgraphpunks@gmail.com` for the public Linux maintainer; `Turtle Moon <hgraphpunks@gmail.com>` is now the local and CI default, with an optional `BETA_LINUX_MAINTAINER` CI override. This confirmation does not itself establish that the email is a monitored private security-reporting channel.
5. Complete the remaining applicable acceptance checks: separate lifecycle repetition/early-debugger investigation, advertised real-wallet versions, supported native Core/Ord installations, clean-machine installation/update/uninstall and actual supported OS/architecture matrix. Keep limitations explicit; a synthetic fixture pass is not a compatibility guarantee.

New release checksum manifests/source-freeze hashing remain deferred as requested. Existing package-integrity and native-smoke identity checks were retained.

## Owner metadata follow-up

The owner confirmed the repository name and public maintainer email after the native qualification above. `package.json` now records that homepage, Git repository and Linux maintainer; the workflow uses the same maintainer when no CI override is configured. This follow-up changes release metadata and documentation only, not application source or dependencies. The already-open engineering app and the native results above precede these metadata edits; no new packaged artifact or remote build is claimed. Repository access, permission to commit/push/tag/run the remote release pipeline, and signing setup remain outstanding.

Follow-up verification: **28/28 release workflow, packaging-policy and beta-release tests pass**, including the new default-metadata consistency check, existing override validation and the pinned electron-builder configuration schema. `git diff --check` also passes. The full application/native suites above were not repeated for this metadata-only change.

## Browser left open for the owner

The exact prior source process **15762** was verified, gracefully terminated and confirmed gone. The final packaged Mac app was opened with the same approved disposable test profile and `satnav://about` requested, as **PID 20493**. Passive shell load was recorded at **2026-09-21 16:42:45.169 UTC**. Only fixed time/event/PID fields were projected from a bounded log read; no credential values or user chat were inspected. This confirms packaged startup, not visual acceptance. Restart clears memory-only AI chat; the app remains open for testing.
