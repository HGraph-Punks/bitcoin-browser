import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { buildAppPreloadProbe } from './startup-diagnostic-support.mjs';

export const STARTUP_BRANCH_URL = 'app://app/renderer/index.html';
export const STARTUP_BRANCH_PRELOAD_CHANNEL = 'wallet-startup:preload';
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wallet startup diagnostic</title></head><body><main id="marker">wallet startup diagnostic</main></body></html>';
// Exact lines retained in release/wallet-startup-barrier-matrix-20260905.json.
// This narrow diagnostic-only allowlist is not a production acceptance policy.
const knownSignatures = new Map([
  ['Electron sandboxed_renderer.bundle.js script failed to run', 'SANDBOX_BUNDLE_SCRIPT_FAILED'],
  ["TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null.", 'SANDBOX_STARTUP_DATA_NULL']
]);
const ownerKeys = ['generation', 'rendererPid', 'webContentsId', 'frameProcessId', 'frameRoutingId'];
const positive = value => Number.isSafeInteger(value) && value > 0;
class FixtureError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (value, code) => { if (!value) throw new FixtureError(code); };
const nonceValid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const startedApps = new WeakSet();
function dataRecord(value, keys) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'BRANCH_FIXTURE_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]
    && Object.hasOwn(descriptors[key], 'value')), 'BRANCH_FIXTURE_INPUT');
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function copyBinding(value) {
  const binding = dataRecord(value, ['owner', 'nonce']);
  binding.owner = dataRecord(binding.owner, ownerKeys);
  check(nonceValid(binding.nonce) && ownerKeys.every(key => key === 'frameRoutingId'
    ? Number.isSafeInteger(binding.owner[key]) && binding.owner[key] >= 0 : positive(binding.owner[key])), 'BRANCH_FIXTURE_BINDING');
  return Object.freeze({ owner: Object.freeze(binding.owner), nonce: binding.nonce });
}
const sameOwner = (a, b) => ownerKeys.every(key => a[key] === b[key]);
const sameBinding = (a, b) => a.nonce === b.nonce && sameOwner(a.owner, b.owner);
function jsonInput(text) {
  check(typeof text === 'string' && text.length <= 8192 && Buffer.byteLength(text) <= 8192, 'BRANCH_FIXTURE_INPUT');
  try { return JSON.parse(text); } catch { throw new FixtureError('BRANCH_FIXTURE_INPUT'); }
}

/**
 * Real Electron MAIN-PROCESS adapter, never a native launcher. Import and factory
 * construction perform no Electron calls, filesystem reads/writes or attachment.
 * start() MUST be called synchronously before app ready in a fresh diagnostic
 * process. The driver supplies actual {app,session,protocol,BrowserWindow,ipcMain}
 * exports; this module never imports Electron. One window/generation per process.
 *
 * Before start, the external driver must create/record the fresh private profile,
 * verify runtime/production preload/probe files with bounded no-follow reads,
 * and supply the exact verified bytes plus absolute generated preloadPath.
 * probeBytes must equal buildAppPreloadProbe(productionPreloadBytes). This check
 * binds supplied bytes, NOT the file at preloadPath; driver must freeze/readback
 * that file through launch. No fixture-only replacement preload is accepted.
 * The existing builder appends wallet-startup:preload {href,sandboxed,
 * contextIsolated}; frame ownership is checked here, not inferred from a marker.
 *
 * start({signal}) returns held readState JSON only once passive OS PID and frame
 * ownership are positive. It sends NO Runtime command or page evaluation to
 * obtain identity. readState/enableRuntime/observeCommitted match the frozen
 * coordinator. Before collector.arm attaches natively, the external bridge MUST
 * call bind({binding}) once with that coordinator's owner/nonce. bind is separate
 * because the frozen coordinator does not call a fixture arming method.
 * enableRuntime revalidates the pinned binding synchronously immediately before
 * attach and again before its sole Runtime.enable send. No-Runtime never attaches
 * CDP. observeCommitted retains >=250ms held and >=250ms committed observations.
 * No app bootstrap, wallet, provider, credentials, arbitrary page execution or
 * network request is part of this fixture. Other IPC and console/bootstrap errors
 * fail closed; normalized records are capped at 256 events/64KiB, contexts at80.
 * The two EXACT previously retained startup signatures may continue only from
 * the owned sandbox-bundle main frame during the held Runtime send, once each.
 * They set knownStartupFailureObserved:true and productStartupSucceeded:false;
 * completing diagnostic observation is NEVER product startup success. Without a
 * known failure, productStartupSucceeded is null (not established), not true.
 * Unknown/extended signatures, wrong source/frame/phase and preload absence fail.
 *
 * prepareQuit closes only this window, settles its load/command work, removes
 * this adapter's listeners/session handlers, and returns a PREPARATION receipt.
 * It does not assert OS exits. requestNormalQuit then calls app.quit (never
 * app.exit/destroy/kill). The external coordinator fixture.quit proxy must:
 * prepareQuit -> persist receipt/install exact process-exit observers -> request
 * normal quit -> independently observe main AND renderer exit -> call
 * completeStartupBranchFixtureQuit. It must confirm LLDB detach/resume FIRST.
 * This module cannot establish LLDB state or its own OS process exit. Unconfirmed
 * cleanup stays owned by the driver; profiles/evidence are retained, not deleted.
 * No automatic quit occurs on failure while an external collector may be attached.
 * CDP context coverage ends explicitly before intentional CDP detach; console
 * coverage ends before window close, while navigation/crash guards remain.
 * If BrowserWindow construction throws after exposing owned webContents but
 * before returning the window, preparation rejects and retains its guards and
 * session ownership. Missing window ownership is NOT confirmed window closure;
 * the external driver must resolve that failed setup without an exit receipt.
 *
 * clock is an explicit controlled-test seam; a native driver must omit it.
 * Native/global admission, total output/resource budgets, external deadlines,
 * transport cancellation, late-output publication invalidation and live D-07
 * approval remain driver responsibilities. No native qualification is implied.
 * API references: https://www.electronjs.org/docs/latest/api/web-contents
 * https://www.electronjs.org/docs/latest/api/protocol
 * https://www.electronjs.org/docs/latest/api/debugger
 */
export function createStartupBranchFixture({ electron, preloadPath, productionPreloadBytes, probeBytes,
  generation = 1, clock, setupTimeoutMs = 5000, observationTimeoutMs = 5000, cleanupTimeoutMs = 5000 } = {}) {
  let app; let BrowserWindow; let ipcMain; let protocol; let session;
  let phase = 'new'; let failure = null; let owner = null; let binding = null; let win = null; let contents = null;
  let targetSession = null; let expectedCreation = false; let protocolOwned = false; let sessionOwned = false;
  let released = false; let responseResolve = null; let requestSeen = false; let protocolSeen = false;
  let navigationCount = 0; let preloadCount = 0; let commitCount = 0; let loadCount = 0;
  let runtimeAttempted = false; let runtimeEnabled = false; let commandInvoked = false; let debuggerOwned = false; let intentionalDetach = false;
  let closing = false; let windowClosed = false; let prepared = null; let quitRequested = false; let busy = false;
  let loadAttempted = false; let loadSettled = false; let commandSettled = true; let startedAt = 0; let heldAt = 0;
  let observationComplete = false; const observedSignatures = new Set();
  let contextCount = 0; let eventBytes = 2; let overflow = false; let probeSha256 = null;
  const events = []; const listeners = []; const waiters = new Set();
  const now = () => clock ? clock.now() : performance.now();
  const wake = () => { for (const listener of [...waiters]) listener(); };
  const fail = code => { failure ??= code; wake(); return new FixtureError(code); };
  function record(event, fields = {}) {
    const row = { sequence: events.length + 1, event, elapsedMs: Math.max(0, Math.floor(now() - startedAt)), phase, ...fields };
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (events.length >= 256 || eventBytes + bytes > 65536) { overflow = true; fail('BRANCH_FIXTURE_OUTPUT_LIMIT'); return; }
    events.push(row); eventBytes += bytes;
  }
  const ensure = (signal, allowFailure = false) => {
    if (signal?.aborted) throw fail('BRANCH_FIXTURE_INTERRUPTED');
    if (!allowFailure && failure) throw new FixtureError(failure);
  };
  function listen(emitter, event, callback) {
    const guarded = (...args) => { try { callback(...args); } catch (error) { fail(error instanceof FixtureError ? error.code : 'BRANCH_FIXTURE_CALLBACK'); } };
    emitter.on(event, guarded); listeners.push({ emitter, event, listener: guarded });
  }
  function removeListeners(predicate = () => true) {
    for (const entry of [...listeners].reverse()) if (predicate(entry)) {
      try {
        entry.emitter.removeListener(entry.event, entry.listener);
        check(!entry.emitter.listeners(entry.event).includes(entry.listener), 'BRANCH_FIXTURE_LISTENER_CLEANUP');
        listeners.splice(listeners.indexOf(entry), 1);
      } catch { fail('BRANCH_FIXTURE_LISTENER_CLEANUP'); }
    }
  }
  async function waitFor(predicate, signal, until, code, allowFailure = false) {
    while (true) {
      ensure(signal, allowFailure); check(performance.now() <= until, code);
      if (predicate()) return;
      await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
        waiters.add(done); signal?.addEventListener('abort', done, { once: true });
        timer = setTimeout(done, Math.min(10, Math.max(1, until - performance.now())));
      });
    }
  }
  async function measuredPause(signal, until) {
    const began = now();
    if (clock) await clock.pause(250);
    else await waitFor(() => now() - began >= 250, signal, until, 'BRANCH_FIXTURE_OBSERVATION_TIMEOUT');
    ensure(signal); check(performance.now() <= until, 'BRANCH_FIXTURE_OBSERVATION_TIMEOUT');
    const elapsed = now() - began;
    check(Number.isFinite(elapsed) && elapsed >= 250 && elapsed <= observationTimeoutMs, 'BRANCH_FIXTURE_OBSERVATION_DURATION');
    return elapsed;
  }
  function currentOwner() {
    check(contents && win && !windowClosed && !contents.isDestroyed() && !win.isDestroyed()
      && win.webContents === contents, 'BRANCH_FIXTURE_OWNER_GONE');
    const frame = contents.mainFrame;
    check(frame && !frame.isDestroyed() && frame.parent === null && frame.frames.length === 0, 'BRANCH_FIXTURE_FRAME_OWNER');
    const next = { generation, rendererPid: contents.getOSProcessId(), webContentsId: contents.id,
      frameProcessId: frame.processId, frameRoutingId: frame.routingId };
    check(ownerKeys.every(key => key === 'frameRoutingId' ? Number.isSafeInteger(next[key]) && next[key] >= 0 : positive(next[key]))
      && frame.osProcessId === next.rendererPid, 'BRANCH_FIXTURE_PID_UNAVAILABLE');
    if (owner) check(sameOwner(owner, next), 'BRANCH_FIXTURE_OWNER_CHANGED');
    check(released ? frame.url === STARTUP_BRANCH_URL : ['', 'about:blank', STARTUP_BRANCH_URL].includes(frame.url), 'BRANCH_FIXTURE_DOCUMENT_OWNER');
    return next;
  }
  function bound(value, signal, allowFailure = false) {
    ensure(signal, allowFailure); const supplied = copyBinding(value);
    check(binding && sameBinding(binding, supplied), 'BRANCH_FIXTURE_BINDING');
    check(sameOwner(binding.owner, currentOwner()), 'BRANCH_FIXTURE_OWNER_CHANGED');
    return binding;
  }
  async function operation(signal, body, allowFailure = false) {
    ensure(signal, allowFailure); check(!busy, 'BRANCH_FIXTURE_BUSY'); busy = true;
    try { return await body(); }
    catch (error) { throw fail(error instanceof FixtureError ? error.code : 'BRANCH_FIXTURE_OPERATION'); }
    finally { busy = false; }
  }
  function denyNavigation(event) { event?.preventDefault?.(); throw new FixtureError('BRANCH_FIXTURE_NAVIGATION'); }
  function observeContents(_event, wc) {
    if (!expectedCreation || contents) { fail('BRANCH_FIXTURE_UNEXPECTED_WINDOW'); return; }
    contents = wc; expectedCreation = false;
    wc.setWindowOpenHandler(() => { fail('BRANCH_FIXTURE_UNEXPECTED_WINDOW'); return { action: 'deny' }; });
    listen(wc, 'did-create-window', () => { throw new FixtureError('BRANCH_FIXTURE_UNEXPECTED_WINDOW'); });
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'did-redirect-navigation', 'did-navigate-in-page']) {
      // Programmatic initial loadURL does not emit will-navigate/frame-navigate.
      listen(wc, event, denyNavigation);
    }
    listen(wc, 'did-start-navigation', details => {
      check(!closing && details.url === STARTUP_BRANCH_URL && details.isMainFrame === true
        && details.isSameDocument === false && details.frame === wc.mainFrame && ++navigationCount === 1,
      'BRANCH_FIXTURE_NAVIGATION'); record('navigation-started');
    });
    listen(wc, 'frame-created', (_event, details) => {
      check(details.frame && details.frame === wc.mainFrame && details.frame.parent === null, 'BRANCH_FIXTURE_FRAME_OWNER');
    });
    listen(wc, 'did-frame-navigate', (_event, url, _status, _text, main, processId, routingId) => {
      check(!closing && released && url === STARTUP_BRANCH_URL && main === true && ++commitCount === 1, 'BRANCH_FIXTURE_COMMIT');
      const current = currentOwner();
      check(processId === current.frameProcessId && routingId === current.frameRoutingId, 'BRANCH_FIXTURE_COMMIT_OWNER');
      record('document-committed'); wake();
    });
    listen(wc, 'did-finish-load', () => {
      check(!closing && released && ++loadCount === 1, 'BRANCH_FIXTURE_LOAD'); currentOwner(); record('document-loaded'); wake();
    });
    listen(wc, 'ipc-message', (_event, channel) => { check(channel === STARTUP_BRANCH_PRELOAD_CHANNEL, 'BRANCH_FIXTURE_UNEXPECTED_IPC'); });
    listen(wc, 'ipc-message-sync', event => { event.returnValue = null; throw new FixtureError('BRANCH_FIXTURE_UNEXPECTED_IPC'); });
    listen(wc, 'console-message', details => {
      const text = typeof details.message === 'string' && details.message.length <= 4096 ? details.message : '';
      const code = knownSignatures.get(text) ?? 'UNEXPECTED_CONSOLE';
      const expected = code !== 'UNEXPECTED_CONSOLE' && details.sourceId === 'node:electron/js2c/sandbox_bundle'
        && details.frame === wc.mainFrame && phase === 'held' && !released && commandInvoked && !observedSignatures.has(code);
      record('console', { code, bootstrap: details.sourceId === 'node:electron/js2c/sandbox_bundle',
        mainFrame: details.frame === wc.mainFrame, ...(expected ? { signature: text } : {}) });
      if (expected) observedSignatures.add(code);
      else throw new FixtureError('BRANCH_FIXTURE_CONSOLE');
    });
    for (const event of ['preload-error', 'render-process-gone', 'unresponsive', 'will-attach-webview']) {
      listen(wc, event, eventObject => { eventObject?.preventDefault?.(); throw new FixtureError('BRANCH_FIXTURE_RUNTIME_FAILURE'); });
    }
    for (const event of ['did-fail-load', 'did-fail-provisional-load']) listen(wc, event, () => {
      if (!closing) throw new FixtureError('BRANCH_FIXTURE_LOAD_FAILED');
    });
  }
  const api = {
    async start({ signal } = {}) {
      return operation(signal, async () => {
        check(phase === 'new', 'BRANCH_FIXTURE_ALREADY_STARTED');
        check(electron && [generation].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2)
          && [setupTimeoutMs, observationTimeoutMs, cleanupTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 5000)
          && typeof preloadPath === 'string' && path.isAbsolute(preloadPath)
          && Buffer.isBuffer(productionPreloadBytes) && productionPreloadBytes.length > 0 && productionPreloadBytes.length <= 65536
          && Buffer.isBuffer(probeBytes) && probeBytes.length <= 65536
          && probeBytes.equals(buildAppPreloadProbe(productionPreloadBytes)), 'BRANCH_FIXTURE_INPUT');
        ({ app, BrowserWindow, ipcMain, protocol, session } = electron);
        check(!app.isReady() && !startedApps.has(app), 'BRANCH_FIXTURE_APP_LIFETIME');
        startedApps.add(app); startedAt = now(); phase = 'starting';
        probeSha256 = createHash('sha256').update(probeBytes).digest('hex');
        app.enableSandbox();
        protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
          standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }]);
        listen(app, 'window-all-closed', () => {});
        listen(app, 'before-quit', event => { if (!quitRequested) { event.preventDefault(); fail('BRANCH_FIXTURE_UNEXPECTED_QUIT'); } });
        listen(app, 'web-contents-created', observeContents);
        let ready = false;
        Promise.resolve(app.whenReady()).then(() => { ready = true; wake(); }, () => fail('BRANCH_FIXTURE_READY'));
        const until = performance.now() + setupTimeoutMs;
        await waitFor(() => ready, signal, until, 'BRANCH_FIXTURE_SETUP_TIMEOUT');
        check(BrowserWindow.getAllWindows().length === 0, 'BRANCH_FIXTURE_UNEXPECTED_WINDOW');
        targetSession = session.fromPartition(`startup-branch-${randomUUID()}`, { cache: false });
        check(!targetSession.protocol.isProtocolHandled('app'), 'BRANCH_FIXTURE_SESSION_IN_USE'); sessionOwned = true;
        targetSession.setPermissionRequestHandler((_wc, _permission, callback) => { callback(false); fail('BRANCH_FIXTURE_PERMISSION_REQUEST'); });
        targetSession.setPermissionCheckHandler(wc => { record('permission-denied', { owned: wc === contents }); return false; });
        targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
          const allowed = !failure && !closing && !requestSeen && details.url === STARTUP_BRANCH_URL && details.method === 'GET'
            && details.resourceType === 'mainFrame' && details.webContentsId === contents?.id
            && (!details.webContents || details.webContents === contents) && (!details.frame || details.frame === contents?.mainFrame);
          if (allowed) requestSeen = true;
          callback({ cancel: !allowed }); if (!allowed) fail('BRANCH_FIXTURE_REQUEST');
        });
        targetSession.protocol.handle('app', request => {
          if (failure || closing || protocolSeen || !requestSeen || request.url !== STARTUP_BRANCH_URL || request.method !== 'GET') {
            fail('BRANCH_FIXTURE_PROTOCOL'); return new Response('', { status: 403 });
          }
          protocolSeen = true; phase = 'held'; heldAt = now(); record('response-held'); wake();
          return new Promise(resolve => { responseResolve = resolve; });
        }); protocolOwned = true;
        listen(ipcMain, STARTUP_BRANCH_PRELOAD_CHANNEL, (event, value) => {
          const marker = dataRecord(value, ['href', 'sandboxed', 'contextIsolated']);
          check(!closing && released && event.sender === contents && event.senderFrame === contents?.mainFrame
            && marker.href === STARTUP_BRANCH_URL && marker.sandboxed === true && marker.contextIsolated === true
            && ++preloadCount === 1, 'BRANCH_FIXTURE_PRELOAD_OWNER');
          currentOwner(); record('preload-marker', { sandboxed: true, contextIsolated: true }); wake();
        });
        expectedCreation = true;
        win = new BrowserWindow({ show: false, width: 480, height: 320, webPreferences: {
          preload: preloadPath, session: targetSession, sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true, webviewTag: false } });
        check(contents && win.webContents === contents && !expectedCreation, 'BRANCH_FIXTURE_WINDOW_OWNER');
        listen(win, 'closed', () => { windowClosed = true; record('window-closed'); if (!closing) fail('BRANCH_FIXTURE_UNEXPECTED_CLOSE'); wake(); });
        listen(win, 'close', event => { if (!closing) { event.preventDefault(); fail('BRANCH_FIXTURE_UNEXPECTED_CLOSE'); } });
        loadAttempted = true;
        try {
          Promise.resolve(win.loadURL(STARTUP_BRANCH_URL)).then(() => { loadSettled = true; wake(); }, () => {
            loadSettled = true; if (!closing) fail('BRANCH_FIXTURE_LOAD_FAILED'); wake();
          });
        } catch (error) { loadSettled = true; throw error; }
        await waitFor(() => phase === 'held', signal, until, 'BRANCH_FIXTURE_SETUP_TIMEOUT');
        await waitFor(() => {
          try { owner = Object.freeze(currentOwner()); return true; }
          catch (error) { if (error.code === 'BRANCH_FIXTURE_PID_UNAVAILABLE') return false; throw error; }
        }, signal, until, 'BRANCH_FIXTURE_PID_UNAVAILABLE');
        record('owner-ready', owner); return JSON.stringify({ owner, phase });
      });
    },
    readState({ signal } = {}) {
      ensure(signal); check(['held', 'committed'].includes(phase) && owner, 'BRANCH_FIXTURE_PHASE');
      currentOwner(); return JSON.stringify({ owner, phase });
    },
    bind({ binding: supplied, signal } = {}) {
      ensure(signal); check(phase === 'held' && owner && !binding, 'BRANCH_FIXTURE_BINDING');
      const value = copyBinding(supplied); check(sameOwner(value.owner, currentOwner()), 'BRANCH_FIXTURE_BINDING');
      binding = value; record('binding-pinned'); return JSON.stringify({ binding, bound: true });
    },
    async enableRuntime({ binding: supplied, signal } = {}) {
      return operation(signal, async () => {
        bound(supplied, signal); check(phase === 'held' && !runtimeAttempted, 'BRANCH_FIXTURE_RUNTIME_PHASE');
        const debuggerApi = contents.debugger; check(!debuggerApi.isAttached(), 'BRANCH_FIXTURE_DEBUGGER_IN_USE');
        listen(debuggerApi, 'detach', () => { if (!intentionalDetach) fail('BRANCH_FIXTURE_DEBUGGER_DETACHED'); });
        listen(debuggerApi, 'message', (_event, method, params, sessionId) => {
          check(!closing && !intentionalDetach && !sessionId, 'BRANCH_FIXTURE_CONTEXT_OWNER'); currentOwner();
          if (!method.startsWith('Runtime.')) return;
          check(['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'].includes(method)
            && ++contextCount <= 80, 'BRANCH_FIXTURE_CONTEXT_LIMIT');
          const context = params?.context; const id = method === 'Runtime.executionContextCreated' ? context?.id : params?.executionContextId;
          check(method === 'Runtime.executionContextsCleared' || positive(id), 'BRANCH_FIXTURE_CONTEXT_INVALID');
          record('runtime-context', { method, contextId: positive(id) ? id : null,
            frameId: typeof context?.auxData?.frameId === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(context.auxData.frameId) ? context.auxData.frameId : null,
            isDefault: typeof context?.auxData?.isDefault === 'boolean' ? context.auxData.isDefault : null,
            type: ['default', 'isolated'].includes(context?.auxData?.type) ? context.auxData.type : null });
        });
        bound(supplied, signal); runtimeAttempted = true; debuggerOwned = true;
        debuggerApi.attach('1.3');
        bound(supplied, signal); check(debuggerApi.isAttached(), 'BRANCH_FIXTURE_DEBUGGER_DETACHED');
        // No await between this ownership/nonce check and the experimental send.
        commandSettled = false; commandInvoked = true;
        try {
          Promise.resolve(debuggerApi.sendCommand('Runtime.enable')).then(() => { commandSettled = true; wake(); }, () => {
            commandSettled = true; if (!closing) fail('BRANCH_FIXTURE_RUNTIME_COMMAND'); wake();
          });
        } catch (error) { commandSettled = true; throw error; }
        await waitFor(() => commandSettled, signal, performance.now() + 1000, 'BRANCH_FIXTURE_RUNTIME_TIMEOUT');
        bound(supplied, signal); runtimeEnabled = true; record('runtime-enabled');
        return JSON.stringify({ binding, enabled: true });
      });
    },
    async observeCommitted({ binding: supplied, signal } = {}) {
      return operation(signal, async () => {
        bound(supplied, signal); check(phase === 'held' && !released && responseResolve, 'BRANCH_FIXTURE_PHASE');
        const until = performance.now() + observationTimeoutMs;
        const heldObservedMs = await measuredPause(signal, until);
        bound(supplied, signal); released = true; phase = 'released'; record('response-released');
        const resolve = responseResolve; responseResolve = null;
        resolve(new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } }));
        await waitFor(() => commitCount === 1 && preloadCount === 1 && loadCount === 1 && loadSettled,
          signal, until, 'BRANCH_FIXTURE_OBSERVATION_TIMEOUT');
        currentOwner(); phase = 'committed';
        const committedObservedMs = await measuredPause(signal, until);
        bound(supplied, signal); observationComplete = true; record('observation-complete');
        return JSON.stringify({ binding, released: true, committed: true, preload: true, loaded: true,
          heldObservedMs, committedObservedMs });
      });
    },
    async prepareQuit({ binding: supplied, signal } = {}) {
      return operation(signal, async () => {
        check(phase !== 'new' && !prepared, 'BRANCH_FIXTURE_QUIT_PHASE');
        if (binding) check(sameBinding(binding, copyBinding(supplied)), 'BRANCH_FIXTURE_BINDING');
        else check(supplied === undefined || supplied === null, 'BRANCH_FIXTURE_BINDING');
        // web-contents-created can run before the constructor returns. A thrown
        // constructor must not turn retained live contents into !win success.
        check(win !== null || contents === null, 'BRANCH_FIXTURE_WINDOW_UNCONFIRMED');
        closing = true; phase = 'closing'; const until = performance.now() + cleanupTimeoutMs;
        if (debuggerOwned) {
          check(contents && !contents.isDestroyed(), 'BRANCH_FIXTURE_DEBUGGER_CLEANUP');
          record('context-observation-ended');
          removeListeners(entry => entry.emitter === contents.debugger && entry.event === 'message');
          intentionalDetach = true; if (contents.debugger.isAttached()) contents.debugger.detach();
          check(!contents.debugger.isAttached(), 'BRANCH_FIXTURE_DEBUGGER_CLEANUP');
        }
        removeListeners(entry => entry.event === 'console-message');
        if (responseResolve) { const resolve = responseResolve; responseResolve = null; resolve(new Response('', { status: 403 })); }
        if (win && !windowClosed) win.close();
        await waitFor(() => (!win || windowClosed) && (!loadAttempted || loadSettled) && commandSettled,
          signal, until, 'BRANCH_FIXTURE_CLEANUP_TIMEOUT', true);
        removeListeners();
        if (protocolOwned) { targetSession.protocol.unhandle('app'); protocolOwned = false; }
        if (sessionOwned) {
          targetSession.webRequest.onBeforeRequest(null);
          targetSession.setPermissionRequestHandler(null); targetSession.setPermissionCheckHandler(null); sessionOwned = false;
        }
        check(listeners.length === 0 && !protocolOwned && !sessionOwned, 'BRANCH_FIXTURE_CLEANUP');
        phase = 'closed'; record('quit-prepared');
        prepared = Object.freeze({ binding, windowClosed: !win || windowClosed, loadSettled: !loadAttempted || loadSettled,
          debuggerDetached: !debuggerOwned || intentionalDetach, listenersRemoved: true, protocolRemoved: true, normalQuitPrepared: true });
        return JSON.stringify(prepared);
      }, true);
    },
    requestNormalQuit({ binding: supplied, signal } = {}) {
      ensure(signal, true); check(prepared && !quitRequested, 'BRANCH_FIXTURE_QUIT_PHASE');
      if (binding) check(sameBinding(binding, copyBinding(supplied)), 'BRANCH_FIXTURE_BINDING');
      else check(supplied === undefined || supplied === null, 'BRANCH_FIXTURE_BINDING');
      quitRequested = true; app.quit(); return JSON.stringify({ binding, normalQuitRequested: true });
    },
    diagnostics() {
      return JSON.stringify({ schemaVersion: 1, phase, failure, overflow, owner, probeSha256, runtimeAttempted, runtimeEnabled,
        diagnosticObservationComplete: observationComplete && !failure, knownStartupFailureObserved: observedSignatures.size > 0,
        productStartupSucceeded: observedSignatures.size > 0 ? false : null,
        heldElapsedMs: heldAt ? Math.max(0, Math.floor(now() - heldAt)) : null,
        preloadCount, commitCount, loadCount, windowClosed, loadSettled, commandSettled,
        listenersRemaining: listeners.length, protocolOwned, sessionOwned, quitRequested, events });
    }
  };
  return Object.freeze(api);
}

/** Pure EXTERNAL-DRIVER receipt join, not an exit observer. Only call after the
 * driver independently confirms exact main/renderer OS exits and normal quit.
 * In-process window-close/quit callbacks are NOT evidence for the exits input. */
export function completeStartupBranchFixtureQuit(preparedText, exitsText) {
  const prepared = dataRecord(jsonInput(preparedText), ['binding', 'windowClosed', 'loadSettled', 'debuggerDetached',
    'listenersRemoved', 'protocolRemoved', 'normalQuitPrepared']);
  const exits = dataRecord(jsonInput(exitsText), ['binding', 'normalQuit', 'fixtureExited', 'rendererExited']);
  const binding = copyBinding(prepared.binding);
  check(sameBinding(binding, copyBinding(exits.binding)) && Object.entries(prepared).every(([key, value]) => key === 'binding' || value === true)
    && ['normalQuit', 'fixtureExited', 'rendererExited'].every(key => exits[key] === true), 'BRANCH_FIXTURE_EXIT_UNCONFIRMED');
  return JSON.stringify({ binding, normalQuit: true, fixtureExited: true, rendererExited: true });
}
