# Shell lifecycle qualification — 2026-09-05

## Disposition

The shell lifecycle changes have focused passing evidence, but they do **not** make the beta ready. The source-matching macOS arm64 developer package has ASAR SHA-256 `db9dfabff6c755abea8d187b4d395ef4721bc1f3df38788bf0bff9c7d5b4ef2b`. Its focused shell isolation passes 4/4; its matching full smoke remains 27/1 because launch 3 hangs after application drains and requires SIGKILL.

## What changed

Main-process shell ownership now:

- retains only bounded validated deep-link intent;
- waits for the trusted shell load before delivery;
- recreates a destroyed main window for activation or second-instance intent;
- attaches the shell-load callback before starting navigation;
- avoids ordinary-load focus stealing; and
- prevents shell resurrection once shutdown begins.

Renderer bootstrap now:

- runs single-flight;
- installs command, deep-link and wallet subscriptions once;
- preserves the latest pending link through bootstrap failure/retry;
- applies a pending link only after authoritative restored state is installed; and
- prevents late restored parsing/provider resolution from overwriting newer intent.

These are source/readiness corrections, not a relaxation of the bootstrap diagnostic, navigation security, or shutdown gates.

## Recorded evidence

### Local evidence

The latest prior recorded Node 22 verification was 346/346 tests, zero failures/skips, 147 inspected files and 104 JavaScript syntax checks. It was not rerun for this document. Relevant named tests are in `tests/shell-window-lifecycle.test.js`, `tests/renderer-bootstrap-ui.test.js`, `tests/packaged-startup-readiness.test.js`, `tests/renderer-diagnostics.test.js`, `tests/shutdown.test.js` and `tests/ipc-surface.test.js`.

Local cases cover latest-intent retention, cold delivery after load, destroyed-shell recreation, safe focus/activation, invalid/oversized links, shutdown non-resurrection, callback-before-navigation ordering, bootstrap retry/single-flight, subscription uniqueness, ordinary restoration and stale restored parse/provider suppression. Exact-once delivery is local-test evidence only.

### Focused packaged evidence

`release/packaged-shutdown-isolation-1788628376040.json` records four requested and four passing operations:

| Case | Runs | Observed operation | Shutdown result |
|---|---:|---|---|
| `shell-cold-link` | 2 | Fresh/reused seeded state; lowercase and uppercase-scheme argv links reach Bookmarks after restored-state bootstrap | Exit 0, no signal/force, 144–155 ms |
| `shell-recreate` | 2 | Main window closes; two successive second-instance links create distinct replacement generations reaching Bookmarks then Data sources | Exit 0, no signal/force, 142–153 ms |

All four operations completed with zero recorded exceptions, renderer bootstrap diagnostics or output truncation. Profiles were removed. The report explicitly did not instrument delivery multiplicity, so it cannot promote the local exact-once assertion to packaged evidence. Profiles contained no extensions or services. Requests/connections were empty because these cases did not exercise network operations; this is not evidence that network shutdown is fixed or system-wide traffic is absent.

### Matching full smoke

`release/packaged-smoke-shell-lifecycle-20260905.json` records 27 passed, one failed and zero skipped. Launch 3 (PID 79545) required SIGKILL after 15,022 ms; the other six main launches exited cleanly in 129–252 ms. The failing launch recorded lifecycle drain at 4 ms and persistence/logger/retry-quit by 6 ms, with no later durable phase. Its generated stack sample was not reviewed for this qualification note.

The full run therefore remains the controlling shutdown result. The focused isolation supports the cold-link and recreation paths; it neither explains the intermittent native hang nor permits a clean-exit waiver.

## Bootstrap scope

The staged full smoke records a clean bootstrap gate. Historical/intermediate bootstrap failures and the retained 34-run reduced matrix remain relevant: all four early-`Runtime.enable` cases reproduce the Electron sandbox startup failure. The shell readiness changes do not constitute an upstream runtime fix. Repeated staged and early-DevTools qualification remains open with sandbox/context isolation and raw-error gates unchanged.

## Remaining acceptance gates

1. Instrument and verify exact-once cold/warm/recreated-shell deep-link delivery in the package, including invalid input and bootstrap retry.
2. Re-run focused shell cases with configured wallet extensions and managed-service state where authorized; current isolation used neither.
3. Identify and correct the full-smoke launch-3 native hang, then obtain repeated full runs with every expected launch exiting 0 without signal or harness force.
4. Preserve the early-`Runtime.enable` reproducer and obtain repeated staged and early-DevTools runs with zero unclassified bootstrap failures after a supported fix or qualification.
5. Complete the native platform, accessibility, security/privacy, real wallet/node, dialog and distribution matrices in `BETA_TEST_PLAN.md`.

Until all controlling gates pass, the disposition remains **NO-GO**.
