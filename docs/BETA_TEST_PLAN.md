# Controlled beta test plan

## Purpose and release decision

This plan qualifies one exact Bitcoin Browser artifact for a controlled external beta. It does not qualify a source tree, a different architecture, or a rebuilt artifact with the same version string. The release owner records the artifact SHA-256, source revision, build runner, signing identity, notarization/timestamp evidence, test date, and tester for every platform.

The release decision is binary:

- **GO** only when every P0/P1 automated gate passes, every advertised native platform is signed and accepted by its OS trust mechanism, required manual checks pass, and all remaining limitations are accurately disclosed to testers.
- **NO-GO** when any security boundary, data-integrity path, startup/navigation path, offline/restore behavior, installer trust check, or issue/rollback channel is missing or failing.

Packaged PSBT/message signing is outside this beta. A build that exposes enabled signing controls or does not return `FEATURE_DISABLED` is an immediate no-go.

## Candidate record

### Guided local-node setup acceptance

The source walkthrough is implemented; automated fixtures and official-archive integrity checks do not qualify native installation or full synchronization. On each supported native platform, using an explicitly approved disposable data drive/profile:

First qualify the new [capacity-aware entry](EASY_NODE_SETUP.md): check accurate selected-volume/RAM/CPU values and unavailable/unsupported/low-space guidance; change/cancel the folder picker; verify the sole recommendation and optional, initially unchecked browser-launch autostart. Decline the combined native confirmation before allowing any download/configuration/start. With a separate explicit test approval, accept and check bounded pinned download, OS prompts, fresh compact mainnet configuration, startup and honest sync status. Cancel during download, switch offline/local-only without waiting for the download to finish, navigate away before/after saving, and simulate startup/readback failures. Saved setups must resume, never reinstall. Passive stage polling must retain disclosures/focus and show no fabricated percentages. All existing choices below must remain reachable through **Customize setup**. The one-button flow needs real platform and full-sync acceptance; source fixtures are not that evidence.

1. Reach Guided setup from Home, Local node and the palette; choose Customize setup and exercise Core + Ord, Core only, Ord only and Not now. Not now must preserve all settings/providers/services.
2. For each applicable service, test Download for me, Choose installed program and Use a running service. Decline every confirmation and cancel every picker before accepting a path. Do not inspect credential values. macOS quarantine/Gatekeeper and Windows/Linux launch dependencies need direct qualification; do not disable OS launch protections to force a pass.
3. Verify network defaults/custom ports, loopback-only URLs, Core cookie picker, external storage/free-space warning, archive/pruned limits, optional sat/rune indexes and autostart off/on. Ord-only managed must require existing archival Core, txindex and REST.
   - For mainnet, check only managed components contribute to the recommendation. Testnet3/signet/regtest must show unknown capacity, retain all non-cost warnings, and disclose the 2 GiB startup minimum; less space blocks managed start, recommendations above that minimum remain advisory.
   - Existing-only Core/Ord/both need no new node storage folder or unused-root I/O. Save/check/reopen must retain ownership/network checks, never start/stop external processes, and show truthful post-check status. Resume Core-only from a different draft and verify its ready actions.
4. Save must create only fresh dedicated configs, preserve personal configuration and existing sources, and start no process. Reopen the profile and resume. Verify collisions, storage write failures, partial cleanup warnings and advanced-edit refusal without deleting node data.
5. On an approved regtest/signet fixture, confirm Core→sync→txindex/REST→Ord ordering, honest progress and unavailable/wrong-network/pruned states. Start/stop/restart and quit while downloading, syncing and indexing; verify owned-child drain and no automatic restart after Stop.
   - Hold a passive status check across Start and Stop: the action must obtain a post-transition observation, while the original passive response remains an earlier snapshot. A superseded automatic check or delayed failure must not clear a new same-ID Start intent or authorize Ord. Check successful and failed old reads, reads begun during Stop, ownership changes, and shutdown while a read drains.
   - In the walkthrough, obsolete status success/errors must not replace current action feedback or restore stale ready actions. Polling pauses during an action; successful status retry clears only its read error and never erases a failed-stop outcome or repeats Start/Stop.
6. Qualify an actual mainnet full synchronization separately before advertising turnkey full-node readiness. Measure disk growth, peak RAM/CPU, interrupted-download recovery, OS prompts, accessibility, focus, zoom and narrow layouts. Browser offline/local-only are not node P2P firewalls; connected external services must never be stopped by the wizard.

Original guided implementation evidence is recorded in [the guided setup report](../release/node-setup-verification-20260907.json). [The status-ordering correction](../release/node-setup-status-ordering-verification-20260909.json) adds 12 manager and seven renderer cases; the full frozen-source suite at that checkpoint passed 1,539/1,539 with zero failures/cancellations/skips. Independent 39-case manager and 27-case renderer selections overlap that total. These are controlled source tests, not native node or rendered interaction qualification; the native matrix and full-sync acceptance remain open.

### Exact navigation cancellation acceptance

[Completed source evidence](../release/navigation-cancellation-verification-20260909.json) records 1,607/1,607 integrated tests and a narrow real Electron bridge with six synthetic-provider assertions. Neither is complete native application qualification. On the identified candidate:

1. Hold real provider responses after admission; close the loading tab and commit replacement navigation. Observe cancellation of only the old request, no obsolete metadata/fallback admission or result publication, and uninterrupted independent-tab work.
2. Preserve old document work during invalid/pending parsing, external/payment confirmation and background-tab switching. Late completion must not recreate closed tabs, overwrite replacements or clear a newer owner.
3. Exercise cancellation before prepare acknowledgment, duplicate/retired IDs, rejected cancellation, wrong sender/frame, same-document navigation, actual document replacement/crash and shutdown with ignored-abort work. Distinguish bounded cancellation intent from completed operation drain.
4. Observe real HTTP response/socket closure before fixture cleanup; a cleanup-destroyed socket is not a cancellation pass. Preserve valid cache commits completed before abort; qualify pre-commit rollback and late-publication suppression independently.
5. Retain per-phase results, fixed bounded logs, normal main exit and owned-descendant evidence separately. Re-run complete packaged/native UI/platform acceptance before awarding any full-suite or cycle credit.

### Easy inscription mode acceptance

Local implementation evidence is recorded in [the inscription discovery report](../release/inscription-discovery-verification-20260907.json). The five public Ord probes are read-only adapter checks, not native or complete provider-version qualification. Native acceptance remains NOT RUN:

1. Enter Inscriptions from the sidebar, Home and command palette. Confirm existing tabs, omnibox, Bitcoin lookup, viewer details, Save, Bookmarks, Graph, Inspect and wallet tools remain reachable.
2. Find an inscription by a plain number, negative number, ID and copied public link without learning protocol prefixes. Reject malformed input inline without navigating externally. Verify one Enter submission, associated labels/errors and keyboard/screen-reader announcements.
3. Browse the latest page and cross offsets 72, 96 and the next upstream page in both directions. Browse populated and empty blocks. Distinguish adjacent-block links from pagination and record that a live index can shift between requests.
4. Type a search or block draft while metadata is delayed, then publish success and failure. Preserve draft, input focus, open disclosure and scroll in the same tab/route; do not transfer drafts to another tab or route. Separately qualify focus for replaced results controls.
5. Apply each media filter without a network request or replacing the search form. Verify the visible current-page limitation and recoverable empty state. Do not describe this as global collection-name/content-text search.
6. Verify raster thumbnail success, failed/oversized/incorrect MIME placeholders and click-through to the existing isolated viewer. No gallery iframe, SVG, audio/video or interactive inscription execution. Measure native decoding memory and scrolling responsiveness; the 2 MiB encoded-byte bound does not prove decoded-pixel safety.
7. Disable sources, change network/local-only mode, invalidate in-flight routing, switch offline, and retry cached/missing/unreadable pages. Verify honest source/cache provenance and miss-versus-read-failure feedback. No credentials may be inspected or manually modified.
8. Exercise light/dark/system themes, narrow windows, zoom, reduced motion, keyboard-only navigation and a screen reader. Record exact artifact/build, source/version, environment and results before qualification.

Complete before testing:

| Field | Required value |
|---|---|
| Version | `1.0.0-rc.1` or approved successor |
| Source revision | immutable commit/tag |
| Source archive SHA-256 | 64 lowercase hexadecimal characters |
| Artifact path and SHA-256 | one row per OS/architecture/format |
| Build environment | runner image, OS version, Node/npm/Electron versions |
| Signing identity | publisher subject/team/thumbprint; never private-key material |
| Notarization/timestamp | request ID and accepted status where applicable |
| Test profile | newly created OS account or documented clean VM snapshot |
| Test owner/date | accountable human and UTC timestamp |

## Automated gates

Use Node 22 and the reviewed lockfile:

```bash
npm ci --no-audit --no-fund
npm run verify
npm audit --audit-level=high
npm ls --all
npm run pack
npm run smoke:packaged
npm run source:archive
```

On headless Linux use:

```bash
xvfb-run -a npm run smoke:packaged
```

Required results:

1. Static/syntax/security checks return zero failures.
2. Every unit/integration test passes on Node 22; no sandbox-related skipped test is accepted in CI.
3. Audit reports zero high/critical findings. Any accepted lower-severity finding requires owner, exploitability analysis, and expiry.
4. `npm ls --all` returns a valid dependency tree.
5. Packaging completes without modifying sources.
6. `release/packaged-smoke-report.json` contains zero failures. Platform-specific skips must match the documented matrix and be covered manually.
7. Running `npm run source:archive` twice without source changes produces the same SHA-256.
8. Every expected packaged launch exits with code zero and no terminating signal or harness-forced kill. Record shutdown duration, including launches with no managed services; a timeout-driven restart is not a clean restore test. Keep a harness deadline outside the application watchdog. The JavaScript watchdog is a failure/diagnostic mechanism, not a guaranteed native-exit bound because a native block can prevent timers from firing.
9. Exercise repeated quit while persistence is held: new IPC/provider work is gated, admitted work settles, bounds producers stop, all cleanup stages are attempted, and timeout/failure exits nonzero. Persist bounded phase markers before retry-quit and retain a generic whole-quit watchdog. If the harness must kill the process, identify the last durable phase and collect a bounded stack sample when the platform permits; a sampler timeout or missing artifact is not evidence of a clean shutdown. Store samples only in the generated profile or a reviewed, mode-0600 local diagnostic artifact; do not share them externally without a separate privacy review. Do not capture credential values or infer exact higher-level functions from stripped Electron symbols. Investigation of app-owned Keychain items requires explicit authorization. Do not treat `app.exit(0)` or disabled cookie encryption/safe storage as an acceptable fix. Test messages not yet admitted separately; do not infer a transport-delivery guarantee.
10. Seed cache crash-window layouts with missing/malformed indexes, unindexed digest objects, temporary/previous files, unrelated files and symlinks. Only recognized cache-owned regular orphans may be removed; verified indexed data remains intact.
11. Exercise StateStore with a child-only deterministic rename barrier after its complete temporary write: verify the prior primary before exact-PID termination, recovery of the prior commit, cleanup of only exact regular StateStore temporaries, and survival of a separately acknowledged commit. Preserve unrelated files/directories, symlinks and invalid-backup evidence. Record this as ordinary process-termination coverage, not power-loss/fsync proof.
12. If browser-content cutoff fails, repeat the identical blocked-policy update and prove the pending retry latch invokes cutoff again. A persisted blocked setting is not sufficient evidence that existing connections closed.
13. Diagnostics export must redact split secret arguments, quoted structured log fields, complete multi-value Cookie headers and URL credentials; bound collections/text/depth/nodes/output and disclose truncation. Use cached secure-storage availability without probing it. Verify real exported bytes, POSIX mode 0600 on new/replaced files, symlink-target preservation, atomic failure behavior, cancellation and trusted-sender ordering with local fake-value fixtures. Separately qualify native save dialogs and Windows DACL privacy; no POSIX-mode assertion can establish a Windows ACL.
14. Verify malformed/duplicate library migration, rejected overlong canonicals without truncation collisions, transaction-local bookmark responses, adjacent-only rapid history coalescing, delayed transaction/future timestamp behavior and restart persistence. Execute real renderer navigation with deferred parse/provider success and rejection across newer navigation and tab closure; verify background completion does not steal focus and inscription-number titles work before resolution.
15. At 64 tabs, all new-tab entry points must preserve the savable session and report the limit; creation resumes after a close. Closing the active tab must resolve an unresolved restored successor. Graph requests must remain bound to the originating tab/target/request and reject late success/error after navigation, reload, replacement or closure without altering another tab's drawer selection.
16. Use Wallet Standard's actual `{ register }` API object for initial and late event fixtures. Verify same-object duplicate/no-op unregister, same-name distinct IDs, stale unregister ownership and benign refresh retention. Execute main and bridge sources together with deferred providers: pending connect then disconnect/removal, overlapping selections (including newer rejection), direct Bridge button state, correlated command-only results, same-provider reconnect ordering, stale disconnect return, closure during persistence and extension-refresh gating. Real extension RPC/approval/permissions and current packaged replay remain separate mandatory cases.
17. Retain the whole-quit watchdog through `will-quit`, clearing only on the later `quit` event; this still cannot interrupt native code that prevents JavaScript timers. For sandbox startup failures, collect early `web-contents-created`/modern `console-message` attribution with main and renderer PIDs, session label, WebContents and frame IDs, and distinct frame/WebContents locations. Keep raw diagnostic counts as a failing gate even when a frame can be identified. Production logging accepts only the known Electron sandbox source/signatures or `preload-error`, emits normalized codes, caps reports at 20 per WebContents, and omits arbitrary console/error payloads and non-allowlisted URL paths/origins. Each report snapshots at most eight memory-only lifecycle records with sequence numbers and elapsed times, disclosing dropped records. Test immutable snapshots, event argument contracts, destroyed frames, redaction and bounds. Main-process callback order does not establish exact Blink-internal commit order across distinct IPC paths.
18. Reduced startup diagnostics require two distinct window generations per launch, exactly one sandboxed/context-isolated main-frame preload marker and matching completed load per generation, and one successful finish event. Wait for both marker and load before reopening; reject stale/duplicate/wrong-frame markers, load errors, output truncation and forced/nonzero exits. Run fresh and reused disposable profiles. Report unsupported temporary-session extension loading separately, not as a passing supported case. Compare persistent/memory sessions, HTTPS/data/app transport, fixture extensions, lifecycle keeper presence, production window construction and byte-identical production preload prefix. Separate debugging-port enablement from active discovery/attachment; a clean reduced matrix does not qualify the packaged application or establish a fix.
19. Keep the test observer from forcing an initial renderer context: before the first CDP discovery request, wait for the application's passive `app.shell_document_loaded` record for the exact child PID, expected shell URL and post-spawn timestamp. Read only a bounded tail of the generated profile's log. Then separately verify the IPC facade and visible UI through CDP; the document-load marker alone is not functional readiness. Missing records or early process exit must fail rather than fall back to premature attachment. Do not delay application navigation, weaken isolation, or filter early bootstrap errors to satisfy this check. Retain a separate early-attachment reproducer and no-debugger packaged observations; no-debugger process residency is not a replacement for functional tests.

The packaged tab-boundary case creates at most 64 tabs through the UI, sends an actual CDP Cmd/Ctrl+T key event at capacity, checks feedback and unchanged count, closes one temporary tab and proves creation works again. Its bounded `finally` cleanup closes only newly created tab IDs and restores the preceding active tab. This does not by itself qualify native menu/palette entry points. The restored-session fixture separately tests close-active-to-lazy-successor and click-to-lazy-background behavior. Deferred graph races and full library UI behavior remain separate cases.

The packaged suite must cover the trusted renderer, serializable IPC errors and nested attempts, canonical navigation, mock resolution, controlled HTTP 404/401/429/500/timeout failover and health/UI recovery, active resolution/health connection closure on offline/network/endpoint changes, cold offline restart with fresh/stale/corrupt/missing cache and zero configured-provider requests, rendered cache/online recovery, corrupt-primary backup recovery with a visible notice, responsive widths, PSBT rejection, packaged signing gate, isolated MV3 wallet handshake, service output/exit/concurrent start-stop/live removal/app-quit cleanup, persisted provider/service removal, focus/keyboard behavior, explicit app-session download denial with bounded filesystem checks, 15 controlled hostile network/permission branches across default/local-only/offline/compatible/offline-compatible browser-content modes, second-instance deep links, restart/session restore, wallet reconnect, and persisted extension removal. Fixture request/connection observations do not replace system-wide DNS/proxy capture or prove all third-party wallet and native adapter behavior. Browser content controls do not force the separate Wallet Bridge session or third-party extensions offline. Unclassified Electron sandbox bootstrap failures and any harness-forced quit are failing gates even when visible paths still work. Record application-preload failures separately; successful rediscovery does not prove all execution contexts initialized. The detailed functional/network matrices below remain additional requirements, not implied passes from a coarse feature-name smoke check.

Default smoke tests `release/developer`. After a distribution build, run `npm run smoke:packaged -- --distribution` against the signed staging output too, then independently test the final downloaded/installed artifact.

## Platform packaging and trust

### macOS

- Build universal or each advertised architecture deliberately; do not relabel an arm64-only artifact.
- Require Developer ID Application signing with hardened runtime after all fuse/metadata mutations.
- Require successful notarization and stapling.
- Verify `codesign --verify --deep --strict`, expected TeamIdentifier, `spctl --assess`, and `xcrun stapler validate` on the downloaded artifact.
- Install/launch from Downloads on a clean account so quarantine and Gatekeeper execute.
- Verify DMG mount, drag-install, first launch, relaunch, deep link, and deletion/uninstall instructions.

### Windows

- Require Authenticode on installer and installed executable with a valid timestamp and expected publisher.
- Verify SmartScreen/reputation behavior is disclosed; an unexpected unknown-publisher warning is no-go.
- Test NSIS per-user/per-machine behavior as configured, selectable install directory, protocol registration, repair/reinstall, uninstall with retained user data, and explicit user-data removal instructions.

### Linux

- Publish SHA-256 and authenticated release metadata for AppImage, deb, and tarball formats actually advertised.
- Test on every named distribution/version and desktop stack.
- Verify executable bit, desktop entry, icon, protocol handler, AppArmor/SELinux behavior where applicable, package removal, and user-data retention.

## Functional matrix

Record pass/fail and evidence for each case:

| Area | Cases |
|---|---|
| First launch | no node, no wallet, public network available/unavailable, recoverable source status |
| Omnibox | every documented explicit target; ambiguous 64-hex and integer alternatives; malformed/oversized input |
| Guided Bitcoin lookup | choose every type; plain and prefixed identifiers; Try an example does not submit; Look up and native Enter submit once; integer/hash/name choices require explicit selection; mismatched, blank and oversized inputs show inline errors; auto mode never hands web/payment/app links to external navigation; configured-source and offline behavior |
| Saved-item search | case-insensitive all-word matching of local titles/canonicals; exact deduplication and Bookmark/History provenance; bookmark-first 30-row limit and truthful total; empty/malformed/self-search exclusions; literal URLs/identifiers remain search text in saved mode; no provider/search-service dispatch; local history disclosure; Refresh results after library changes; keyboard choices, screen-reader announcements, light/dark and narrow/high-zoom layouts |
| Tabs | new/close/middle-close, 64-tab guard and recovery, close-active lazy restored successor, back/forward/reload, pinned state if exposed, crash/restart restore, lazy background resolution |
| Library | adjacent rapid history de-duplication without removing older non-adjacent visits; delayed/future timestamp consistency; clear; bookmark add/remove/concurrent toggle responses; malformed/duplicate persisted entries; canonical length/collision validation; persistence across restart |
| Providers | add/edit/remove/toggle/prefer, target-specific 404, auth error, timeout, 429/5xx, fallback attempts, health recovery; late results after endpoint edits; removed preference/credentials stay removed after restart |
| Modes | strict/balanced/compatible, local/private routing, offline cached hit/stale/miss, network switch; active resolution/health connections close on transition without obsolete fallback; queued/cache/graph work rejects obsolete routing; failed browser-content cutoff remains latched and retries on an identical blocked update; test Wallet Bridge traffic separately |
| Recursive content | HTML/text/image/audio/video/PDF as supported, ranges, invalid MIME, oversized response, missing resource |
| Graph | cycles, depth/node/aggregate-byte truncation, malformed options, dynamic dependency limitation disclosure, old success/error after navigation/reload/closure/new graph, background drawer preservation |
| PSBT | valid v0/v2 previews, known/unknown fee, duplicate keys, oversized values, truncation/mutation corpus, mismatched non-witness UTXO |
| Wallet beta | install/restore/remove fixture and each advertised extension; actual Wallet Standard event API and late/duplicate/unregister behavior; discover/connect/reject/disconnect; bounded public fields/exact opaque IDs; pending approval vs disconnect/removal/newer selection; correlated command/direct state; benign refresh; same-provider reconnect; extension-refresh/close-during-persistence; signing unavailable |
| Local service | invalid path/cwd, concurrent start, edit-while-starting/running/stopping, stdout/stderr drained at close, async spawn failure, natural success/nonzero exit, restart, concurrent stop, remove during startup, delayed removal commit, forced-termination failure, app quit including pending autostart |
| State/cache | missing/corrupt/non-object primary with valid backup; both files invalid with honest fallback and backup-evidence retention; deterministic StateStore pre-rename SIGKILL and acknowledged-commit restart; exact regular state-temp cleanup with unrelated/symlink preservation; explicit empty provider list remains empty after restart; cache missing/malformed index and interrupted-replacement orphan repair; corrupt cache object; same-size digest corruption; prune after limit reduction; packaged abrupt-crash/disk-failure and power-loss durability remain separate |
| Diagnostics | export/cancel/trust ordering; real bytes; bounded best-effort redaction and review warning; split/quoted flags, multi-value cookies and URL credentials; cached availability without a probe; POSIX restrictive file mode; separate Windows DACL gate; atomic replacement, symlink preservation and write failure; native dialog UX |
| Native actions | external HTTP/HTTPS/bitcoin confirmation accept/cancel, content save accept/cancel, reveal paths, extension picker |
| Deep links | cold start, warm second instance, malformed link, non-default-handler behavior |

## Hostile-content and network privacy matrix

Use both the built-in deterministic fixture and an intercepting proxy/DNS test environment. Confirm:

- shell URL never leaves `app://app/renderer/index.html`;
- iframe lacks `allow-same-origin`, `allow-popups`, `allow-top-navigation`, and `allow-downloads`;
- `window.opener`, shell preload API, wallet providers, Node globals, Electron APIs, cookies, and persistent storage are unavailable;
- app-session permission checks and requests are denied;
- top navigation, popup, form escape, downloads, external fetch/image/media/frame/WebSocket, and mixed content are blocked in default policy;
- compatible mode allows only the documented HTTPS/WSS content subset and does not grant shell/wallet/storage authority;
- browser-content modes do not govern the separate Wallet Bridge session; capture each advertised extension's destinations and do not claim offline wallet behavior from inscription/provider tests;
- remote providers cannot resolve or redirect to loopback, private, link-local, multicast, shared, reserved, IPv4-mapped IPv6, or mixed public/private DNS results;
- local providers cannot escape to public addresses on any redirect;
- credentials and authorization headers do not cross origins on redirects;
- local-only/offline startup and browsing emit no unexpected public-provider traffic; and
- the reserved wallet origin is intercepted locally and never produces DNS traffic.

Capture destination host/IP/port, initiator, and request type. Any undocumented destination is a no-go until explained and either removed or disclosed.

## Accessibility and usability

Run keyboard-only and native assistive-technology checks (VoiceOver on macOS, Narrator on Windows, Orca on supported Linux):

- logical focus order and visible focus at 100%, 200%, and maximum supported zoom;
- tablists announce role/selection and support Arrow/Home/End/Enter/Space;
- modal and command palette trap focus, mark background inert, close with Escape, and restore focus;
- status/error/loading/toast content is announced without focus theft;
- all icon-only controls have accurate names and disabled state;
- window minimum size and high-zoom layouts do not produce inaccessible horizontal page scrolling;
- dark/light/system themes maintain readable contrast;
- reduced-motion preference suppresses nonessential transitions; and
- hostile or long provider data cannot obscure trusted chrome or critical provenance.

## Node/indexer matrix

For each advertised Bitcoin Core and `ord` version, record binary provenance and configuration. Compare representative block, transaction, output, inscription, sat, rune, recursive content, range, and chain-tip results against the corresponding CLI/API. Exercise cookie authentication, warming-up state, pruned-node limitations, missing `txindex`, wrong network, index lag, process restart, and shutdown. Never use mainnet funds for beta validation.

## Tester operations

Before invitation, establish:

- private distribution channel with immutable artifact/checksum;
- monitored issue form requesting version, OS/arch, target/provider type, reproduction, expected/actual result, and redacted diagnostics;
- security-report channel separate from public bugs;
- explicit warning that signing, auto-update, telemetry, collection indexing, and bundled node software are absent;
- data locations and deletion/export instructions;
- supported provider/node/wallet versions and known failures;
- rollback artifact and revocation procedure; and
- stop-ship authority and response SLA for P0/P1 reports.

## Exit report

The release owner publishes a concise internal decision containing:

1. candidate record and artifact hashes;
2. automated command outputs and packaged smoke report;
3. native platform/signing/notarization results;
4. functional, hostile-content, privacy, accessibility, and node/indexer matrix results;
5. defects with severity, owner, workaround, and disposition;
6. disclosed limitations;
7. rollback/revocation readiness; and
8. final **GO** or **NO-GO**, approver, and timestamp.
## Explicit configured-source recovery — current native qualification queue

The local repair batch is recorded in `release/provider-repair-verification-20260908.json`. These native cases remain **NOT RUN**; fake DOM, synthetic encryption and the passive source-browser restart do not close them.

- In an approved disposable fixture profile, exercise each credential-blocked state and review source name, endpoint, network and authentication. Confirm no credential value is displayed or exported.
- Replace both Basic fields; separately clear stored authentication for public/cookie sources and explicitly unauthenticated Core-compatible endpoints. Switching modes must clear drafts and require another acknowledgment. Cookie files and configuration must remain unchanged.
- Cancel, double-click, submit while another authority mutation is queued, change source state before admission, close/reopen the dialog, navigate away, and observe delayed success/error/readback. A spent review must never replay or silently adopt another token.
- Exercise committed finalization/readback failures and read-only Refresh source state; verify the displayed outcome, enabled/preferred state, and explicit next action after restart.
- After recovery, edit public endpoints/networks and cookie paths without adding Basic credentials; test interrupted edits and verify fail-closed recovery without modifying a personal node configuration.
- Qualify keyboard/focus/screen-reader behavior, narrow/zoom/theme layouts and long endpoints. Verify app-managed native storage under exact approved scope; retain signing disabled and no real funds.

## Removed-source cleanup — current native qualification queue

The locally verified batch is recorded in [the cleanup report](../release/cleanup-recovery-verification-20260908.json), with 1,246 full source checks passing. These native/visual cases remain **NOT RUN**. Synthetic secrets, fault injection and passive shell load do not qualify native credential-store behavior.

- In an approved disposable fixture, interrupt removal at each supported state/storage boundary. Reopen the profile and verify that the exact-ID cleanup warning remains visible without recreating the source. Never use a personal credential record for a destructive test.
- Open Review credential cleanup, inspect the ID and deletion limits, cancel, then reopen and explicitly acknowledge. Verify separate review/cleanup IPC, one-shot admission, double-click rejection, and no automatic replay after failure or Refresh source state.
- Change source state while a review is open or queued; ensure a replacement configuration and its storage are preserved. Test configured-ID conflicts, storage-read failures, partial deletion, final acknowledgement failure and shutdown. A saved cleanup record must not be presented as completed deletion.
- With a synthetic older profile lacking a removal ledger, use the collapsed exact-ID lookup. It must not enumerate records, display values, infer a prior removal, or delete until a separate acknowledgement. Invalid/unknown/configured IDs must remain safe.
- Verify public-source removal with encryption unavailable; recovery after restoring storage access; unrelated source and cookie-file preservation; successful later reuse of an ID only after cleanup is confirmed.
- Qualify keyboard, focus, modal ownership, screen-reader announcements, zoom, narrow layouts and themes on the actual supported native build. Keep signing disabled and record exact candidate identity and authority limits.

## Managed-stop native qualification queue — NOT RUN

The source correction in `release/service-stop-verification-20260908.json` is qualified using disposable Node children and controlled IPC/UI collaborators. On each advertised native target, verify actual Core/Ord normal stop and database flush, nonzero close, unexpected signal, forced escalation, signal denial, active Remove/quit handoff, exact-child ownership and retained logs/status. An already reported closed failure must not poison later unrelated shutdown; a currently admitted failure must propagate. Do not count the forced-termination regression as a clean lifecycle cycle.

Windows requires a separately qualified graceful-node-stop strategy: Node signal emulation is abrupt. Use `NATIVE_NODE_REGTEST_PLAN.md` to prepare exact fixtures, budgets and authority. No personal node files or real credentials are test fixtures, and no archive/checksum result closes native execution or full synchronization.

## Native-regtest harness qualification queue — NOT RUN natively

The implementation and run contract are in [NATIVE_NODE_REGTEST_PLAN.md](NATIVE_NODE_REGTEST_PLAN.md); [local verification](../release/native-regtest-harness-verification-20260908.json) is not permission or native evidence.

1. Before native actions, verify the [corrected default-download policy](../release/software-download-verification-20260908.json) against the actual candidate. Obtain the requested [stage 1 installation-only approval](../release/native-regtest-installation-approval-20260908.md), preserve OS quarantine and read back the installed executable/manifest identities without launching them. Mocked HTTPS/DNS and actual loopback cleanup tests do not establish a real official download.
2. With a fresh run manifest, verify plan-only mode has no network, binary, profile or credential effects. Confirm real plan compatibility and exact per-scenario provider sets; review configured peer isolation separately from any approved OS boundary.
3. Obtain exact plan-hash execution authority and freeze source before CLI invocation through drain/publication. Run all five actual-manager scenarios against the approved binaries, recording real chain/version/IBD/txindex/REST/Ord states and exact normal stop/reopen outcomes.
4. Qualify native cancellation during launch validation, readiness, final drain and result publication. A nonzero terminal exit, invalidation marker, incomplete case, forced stop, remaining child or changed source/binary identity fails acceptance. Repeat the evidence-write interruption branch end to end with native execution. Nine actual-filesystem helper cases now cover local publication timing/errors; the full caller's OS-signal behavior remains unqualified.
5. Add approved native port-race, permission, crash, slow-index and storage faults, plus populated inscription fixtures. Verify existing-only stop never stops the owning service pair. Windows graceful database shutdown remains separate.
6. Retain the exact dedicated data root and sanitized evidence. Do not read credential values, use wallets/funds, bypass OS trust or delete retained data automatically. Monitored growth/deadlines are not hard filesystem/OS limits.
7. Full synchronization/Ord indexing, rendered walkthrough/accessibility and supported-platform qualification require separate actual evidence and authority. A single no-wallet fixture block does not close them.

## Startup compatibility and native branch preparation

The coordinator and actual Electron-facing/Python SB adapters are implemented and reviewed. [The unchanged adapters' scoped evidence](../release/startup-branch-adapters-verification-20260909.json) records the historical 1,520/1,520 full Node run on 270 unchanged inputs, 79/79 overlapping focused Node cases, and 43/43 separate offline Python cases. Independent reviews passed 32 fixture and 43 Python cases. Reproduced controls cover partial-window construction, consumer lifetime after process invalidation, unknown/failed thread startup, callback-return auto-resume, event delivery, and synchronous settlement. Adapter import/construction remain inert; this does not establish inert initialization of the installed LLDB module. [The initialization boundary](../release/startup-lldb-initialization-boundary-20260909.md) remains unresolved, as does D-07 approval. The external bridge must pin the fixture binding before collector arming. Outer native worker/bridge, initialization isolation, total resource/output limits, publication invalidation and independently observed ownership/detach/resume/process exits remain unqualified. Possible non-context Runtime events accompanying expected bootstrap failure must be assessed within an approved first native run; no wider capture policy is implied. Controlled receipts and diagnostic completion are not native product success.

The opt-in `scripts/diagnose-startup-compatibility.mjs` runner has a [completed debugger-free native run](../release/startup-compatibility-native-final-20260909.json) on Electron44.2.0 arm64. [Scoped development evidence](../release/startup-compatibility-verification-20260909.json) preserves five earlier failed native runs, the diagnostic corrections, 78/78 overlapping focused checks and 1,455/1,455 frozen integrated verification. Four owned document/preload cases and direct exit0 passed; the initial blank child itself produced native commit/load events. A precise committed-blank CSP warning is retained; bootstrap/wrong-frame/app-document/error controls remain fatal. Console observation ends before owned teardown. Native preflight must still verify exact runtime/profile/scope for any later run, and any force/timeout remains failed evidence. BrowserWindow/main-child closure does not prove every renderer descendant has exited; all six profiles remain retained. Parent cancellation cases are synthetic and do not qualify actual Electron parent signals. No early-Runtime correction or packaged/cycle acceptance is earned by this fixture.

The JSON-only branch interpreter in `scripts/startup-branch-evidence.mjs` accepts at most 64 KiB and 256 losslessly collected events from eight exact instruction sites. Its synthetic tests do not establish collector arming, actual runtime identity, lossless capture, Blink initial-document state or frame/world identity. The [D-07 proposal](../release/startup-native-observation-approval-20260909.md) is separate live-debugger authority; no collector/handshake or native branch run is yet accepted. Preserve original held-response controls and qualify any correction on actual packaged candidates.
