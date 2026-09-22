// Controlled Electron collaborators exercise the REAL exported main-process
// adapter. No Electron/LLDB/native process is imported or launched. Lifecycle
// callbacks and preload IPC are synthetic, not native qualification evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createStartupBranchFixture, completeStartupBranchFixtureQuit,
  STARTUP_BRANCH_URL, STARTUP_BRANCH_PRELOAD_CHANNEL } from '../scripts/startup-branch-fixture.mjs';
import { buildAppPreloadProbe } from '../scripts/startup-diagnostic-support.mjs';
import { createStartupBranchCoordinator } from '../scripts/startup-branch-coordinator.mjs';
import { STARTUP_BRANCH_RUNTIME, STARTUP_BRANCH_SITES } from '../scripts/startup-branch-evidence.mjs';

const production = Buffer.from("'use strict';\nconst { contextBridge, ipcRenderer } = require('electron');\n// controlled input, never executed\n");
const nonce = '12345678-1234-1234-1234-123456789abc';
const clone = value => JSON.parse(JSON.stringify(value));
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const marker = () => ({ href: STARTUP_BRANCH_URL, sandboxed: true, contextIsolated: true });

function controlled(options = {}) {
  const h = { calls: [], windows: [], time: 1000, ready: false, requestHandler: null, protocolHandler: null,
    permissionRequest: null, permissionCheck: null, phaseHook: null, markerOrder: ['commit', 'preload', 'load'] };
  h.clock = { now: () => h.time, pause: async ms => { h.calls.push(`pause:${ms}`); h.time += ms; h.pauseHook?.(); } };
  const app = new EventEmitter(); const ipcMain = new EventEmitter();
  Object.assign(app, {
    isReady: () => h.ready,
    enableSandbox() { assert.equal(h.ready, false); h.calls.push('sandbox'); },
    whenReady() { h.calls.push('whenReady'); return new Promise(resolve => {
      h.resolveReady = () => { h.ready = true; resolve(); }; if (!options.holdReady) queueMicrotask(h.resolveReady);
    }); },
    quit() { h.calls.push('app.quit'); }
  });
  const targetSession = {
    protocol: {
      isProtocolHandled: () => false,
      handle(scheme, handler) { assert.equal(scheme, 'app'); h.calls.push('protocol.handle'); h.protocolHandler = handler; },
      unhandle(scheme) { assert.equal(scheme, 'app'); h.calls.push('protocol.unhandle'); h.protocolHandler = null; }
    },
    webRequest: { onBeforeRequest(filter, handler) {
      if (filter === null) { h.calls.push('request.remove'); h.requestHandler = null; }
      else { assert.deepEqual(filter, { urls: ['<all_urls>'] }); h.requestHandler = handler; }
    } },
    setPermissionRequestHandler(handler) { h.permissionRequest = handler; },
    setPermissionCheckHandler(handler) { h.permissionCheck = handler; }
  };
  class Window extends EventEmitter {
    static getAllWindows() { return h.windows.filter(window => !window.closed); }
    constructor(config) {
      if (options.throwBeforeContents) throw new Error('synthetic constructor failure before ownership');
      super(); h.calls.push('window.create'); this.config = config; this.closed = false;
      const wc = new EventEmitter(); this.webContents = wc;
      const frame = { processId: 31, routingId: 5, osProcessId: options.pid ?? 4242,
        parent: null, frames: [], url: '', isDestroyed: () => this.closed };
      Object.assign(wc, { id: 12, mainFrame: frame, destroyed: false,
        getOSProcessId: () => frame.osProcessId, isDestroyed: () => wc.destroyed,
        setWindowOpenHandler: handler => { h.openHandler = handler; } });
      const originalRemove = wc.removeListener.bind(wc);
      wc.removeListener = (event, listener) => {
        if (event === 'console-message' && wc.destroyed) throw new Error('synthetic late native console removal');
        return originalRemove(event, listener);
      };
      const debuggerApi = new EventEmitter();
      Object.assign(debuggerApi, { attached: false, isAttached: () => debuggerApi.attached,
        attach(version) { assert.equal(version, '1.3'); h.calls.push('cdp.attach'); debuggerApi.attached = true; h.attachHook?.(); },
        detach() { h.calls.push('cdp.detach'); debuggerApi.attached = false;
          h.rejectCommand?.(new Error('synthetic detach')); debuggerApi.emit('detach', {}, 'synthetic intentional detach'); },
        sendCommand(method) { h.calls.push(method); h.commandHook?.(); return Promise.resolve({}); }
      });
      wc.debugger = debuggerApi; h.windows.push(this); h.window = this; h.wc = wc;
      app.emit('web-contents-created', {}, wc);
      if (options.throwAfterContents) throw new Error('synthetic constructor failure after contents ownership');
    }
    isDestroyed() { return this.closed; }
    loadURL(url) {
      h.calls.push('loadURL'); assert.equal(url, STARTUP_BRANCH_URL); h.beforeLoad?.();
      this.webContents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false, frame: this.webContents.mainFrame });
      return new Promise((resolve, reject) => {
        let canceled;
        h.requestHandler({ url, method: 'GET', resourceType: 'mainFrame', webContentsId: this.webContents.id,
          webContents: this.webContents, frame: this.webContents.mainFrame }, result => { canceled = result.cancel; });
        if (canceled) { reject(new Error('synthetic denied request')); return; }
        Promise.resolve(h.protocolHandler({ url, method: 'GET' })).then(response => {
          h.response = response; h.calls.push(`response:${response.status}`);
          if (response.status !== 200 || this.closed) { reject(new Error('synthetic closed navigation')); return; }
          this.webContents.mainFrame.url = url;
          for (const phase of h.markerOrder) {
            h.phaseHook?.(phase);
            if (phase === 'commit') this.webContents.emit('did-frame-navigate', {}, url, 200, 'OK', true, 31, 5);
            if (phase === 'preload') ipcMain.emit(STARTUP_BRANCH_PRELOAD_CHANNEL,
              { sender: this.webContents, senderFrame: this.webContents.mainFrame }, marker());
            if (phase === 'load') this.webContents.emit('did-finish-load');
          }
          resolve();
        }, reject);
      });
    }
    close() {
      h.calls.push('window.close'); if (options.stuckClose) return;
      this.closed = true; this.webContents.destroyed = true; this.emit('closed'); app.emit('window-all-closed');
    }
  }
  h.electron = { app, ipcMain, BrowserWindow: Window,
    protocol: { registerSchemesAsPrivileged(value) { assert.equal(h.ready, false); h.calls.push('scheme.register'); h.scheme = value; } },
    session: { fromPartition(partition, config) {
      h.calls.push('session.create'); assert.match(partition, /^startup-branch-[a-f0-9-]{36}$/);
      assert.equal(partition.startsWith('persist:'), false); assert.deepEqual(config, { cache: false }); return targetSession;
    } }
  };
  h.fixture = createStartupBranchFixture({ electron: h.electron,
    preloadPath: '/private/tmp/synthetic-uncreated-startup-probe.cjs', productionPreloadBytes: production,
    probeBytes: buildAppPreloadProbe(production), clock: h.clock, setupTimeoutMs: options.setupTimeoutMs ?? 5000,
    observationTimeoutMs: options.observationTimeoutMs ?? 5000, cleanupTimeoutMs: options.cleanupTimeoutMs ?? 100 });
  h.start = async () => { const state = JSON.parse(await h.fixture.start()); h.binding = { owner: state.owner, nonce }; return state; };
  h.bind = () => h.fixture.bind({ binding: h.binding });
  h.prepare = () => h.fixture.prepareQuit({ binding: h.binding });
  h.assertClean = () => {
    for (const emitter of [app, ipcMain, h.window, h.wc, h.wc?.debugger].filter(Boolean)) assert.equal(emitter.eventNames().length, 0);
    assert.equal(h.protocolHandler, null); assert.equal(h.requestHandler, null);
    assert.equal(h.permissionRequest, null); assert.equal(h.permissionCheck, null);
  };
  return h;
}

test('controlled Electron: import/construction is inert; start installs actual sandbox/session/window setup', async () => {
  const h = controlled(); assert.deepEqual(h.calls, []);
  const state = await h.start();
  assert.equal(state.phase, 'held'); assert.equal(state.owner.rendererPid, 4242);
  assert.equal(h.calls.includes('Runtime.enable'), false); assert.equal(h.calls.includes('cdp.attach'), false);
  assert.equal(h.response, undefined);
  assert.deepEqual(h.window.config.webPreferences, { preload: '/private/tmp/synthetic-uncreated-startup-probe.cjs',
    session: h.window.config.webPreferences.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
  assert.equal(h.scheme[0].privileges.bypassCSP, undefined);
  h.bind(); const prepared = JSON.parse(await h.prepare()); assert.equal(prepared.normalQuitPrepared, true);
  assert.equal(Object.hasOwn(prepared, 'fixtureExited'), false); assert.equal(Object.hasOwn(prepared, 'rendererExited'), false);
  h.assertClean(); assert.equal(h.calls.includes('app.quit'), false);
});

test('controlled Electron: exact production-prefix probe required before any Electron effects', async () => {
  const h = controlled(); const fixture = createStartupBranchFixture({ electron: h.electron,
    preloadPath: '/private/tmp/synthetic-probe.cjs', productionPreloadBytes: production,
    probeBytes: Buffer.from('fixture-only weaker preload') });
  await rejected(fixture.start(), 'BRANCH_FIXTURE_INPUT'); assert.deepEqual(h.calls, []);
});

test('controlled Electron: pre-abort and late app-ready failure never create a window', async () => {
  const h = controlled(); const controller = new AbortController(); controller.abort();
  await rejected(h.fixture.start({ signal: controller.signal }), 'BRANCH_FIXTURE_INTERRUPTED'); assert.deepEqual(h.calls, []);
  const late = controlled({ holdReady: true, setupTimeoutMs: 10 });
  await rejected(late.fixture.start(), 'BRANCH_FIXTURE_SETUP_TIMEOUT');
  late.resolveReady(); await Promise.resolve(); await Promise.resolve();
  assert.equal(late.calls.includes('window.create'), false);
  await late.fixture.prepareQuit(); late.assertClean();
});

test('controlled Electron: missing passive PID is inconclusive without Runtime or guessed ownership', async () => {
  const h = controlled({ pid: 0, setupTimeoutMs: 10 });
  await rejected(h.fixture.start(), 'BRANCH_FIXTURE_PID_UNAVAILABLE');
  assert.equal(h.calls.includes('Runtime.enable'), false);
  assert.equal(h.calls.includes('cdp.attach'), false);
  await h.fixture.prepareQuit(); h.assertClean();
});

test('controlled Electron: constructor failure after contents creation cannot confirm window cleanup', async () => {
  const h = controlled({ throwAfterContents: true });
  await rejected(h.fixture.start(), 'BRANCH_FIXTURE_OPERATION');
  assert.equal(h.wc.isDestroyed(), false);
  const before = JSON.parse(h.fixture.diagnostics());
  assert.ok(before.listenersRemaining > 0);
  assert.equal(before.protocolOwned, true); assert.equal(before.sessionOwned, true);
  await rejected(h.fixture.prepareQuit(), 'BRANCH_FIXTURE_WINDOW_UNCONFIRMED');
  const after = JSON.parse(h.fixture.diagnostics());
  assert.equal(after.windowClosed, false); assert.equal(h.wc.isDestroyed(), false);
  assert.equal(after.listenersRemaining, before.listenersRemaining);
  assert.equal(after.protocolOwned, true); assert.equal(after.sessionOwned, true);
  assert.equal(after.diagnosticObservationComplete, false);
  assert.equal(h.calls.includes('window.close'), false);
  assert.equal(h.calls.includes('loadURL'), false); assert.equal(h.calls.includes('cdp.attach'), false);
  assert.equal(h.calls.includes('Runtime.enable'), false);
  assert.throws(() => h.fixture.requestNormalQuit(), { code: 'BRANCH_FIXTURE_QUIT_PHASE' });
  assert.equal(h.calls.includes('app.quit'), false);
  // The synthetic live contents and exact guards deliberately remain owned;
  // external-driver recovery is required, not a fabricated successful cleanup.
});

test('controlled Electron: constructor failure before contents creation can release only owned setup', async () => {
  const h = controlled({ throwBeforeContents: true });
  await rejected(h.fixture.start(), 'BRANCH_FIXTURE_OPERATION');
  assert.equal(h.wc, undefined); assert.deepEqual(h.windows, []);
  const prepared = JSON.parse(await h.fixture.prepareQuit());
  assert.equal(prepared.windowClosed, true); assert.equal(prepared.normalQuitPrepared, true);
  assert.equal(h.calls.includes('window.close'), false); assert.equal(h.calls.includes('app.quit'), false);
  h.assertClean();
});

test('controlled Electron: binding pin is explicit, single-use and rejects wrong owner/getters', async () => {
  const h = controlled(); await h.start();
  await rejected(h.fixture.enableRuntime({ binding: h.binding }), 'BRANCH_FIXTURE_BINDING');
  await h.fixture.prepareQuit(); h.assertClean();
  const other = controlled(); await other.start();
  const wrong = clone(other.binding); wrong.owner.generation++;
  assert.throws(() => other.fixture.bind({ binding: wrong }), { code: 'BRANCH_FIXTURE_BINDING' });
  let getter = false; const value = Object.defineProperty({}, 'nonce', { get() { getter = true; } });
  assert.throws(() => other.fixture.bind({ binding: value }), { code: 'BRANCH_FIXTURE_INPUT' }); assert.equal(getter, false);
  other.bind(); assert.throws(() => other.bind(), { code: 'BRANCH_FIXTURE_BINDING' });
  await other.prepare(); other.assertClean();
});

test('controlled Electron: Runtime checks pinned nonce and current PID again after CDP attach', async () => {
  for (const mutation of ['pid', 'nonce', 'abort']) {
    const h = controlled(); await h.start(); h.bind(); const controller = new AbortController();
    const supplied = clone(h.binding);
    h.attachHook = () => {
      if (mutation === 'pid') h.wc.mainFrame.osProcessId++;
      if (mutation === 'nonce') supplied.nonce = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      if (mutation === 'abort') controller.abort();
    };
    await assert.rejects(h.fixture.enableRuntime({ binding: supplied, signal: controller.signal }));
    assert.equal(h.calls.includes('Runtime.enable'), false);
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: early Runtime sends exactly one command and retains observation through commit', async () => {
  const h = controlled(); await h.start(); h.bind();
  assert.equal(JSON.parse(await h.fixture.enableRuntime({ binding: h.binding })).enabled, true);
  assert.equal(h.response, undefined);
  const receipt = JSON.parse(await h.fixture.observeCommitted({ binding: h.binding }));
  assert.equal(receipt.heldObservedMs, 250); assert.equal(receipt.committedObservedMs, 250);
  assert.equal(JSON.parse(h.fixture.readState()).phase, 'committed');
  assert.equal(h.calls.filter(call => call === 'Runtime.enable').length, 1);
  assert.equal(h.wc.debugger.isAttached(), true, 'observer remains attached through committed observation');
  await h.prepare(); h.assertClean();
  assert.ok(h.calls.indexOf('cdp.detach') < h.calls.indexOf('window.close'));
});

test('controlled Electron: no-Runtime path still releases owned response and accepts either marker/load order', async () => {
  for (const order of [['commit', 'preload', 'load'], ['commit', 'load', 'preload']]) {
    const h = controlled(); h.markerOrder = order; await h.start(); h.bind();
    const receipt = JSON.parse(await h.fixture.observeCommitted({ binding: h.binding }));
    assert.equal(receipt.committed, true); assert.equal(receipt.preload, true); assert.equal(receipt.loaded, true);
    assert.equal(h.calls.includes('cdp.attach'), false); assert.equal(h.calls.includes('Runtime.enable'), false);
    assert.equal(h.response.headers.get('content-security-policy'), "default-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const events = JSON.parse(h.fixture.diagnostics()).events.map(event => event.event);
    assert.ok(events.indexOf('response-released') < events.indexOf('preload-marker'));
    assert.ok(events.indexOf('document-loaded') < events.indexOf('observation-complete'));
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: foreign/stale/early/duplicate preload cannot satisfy document milestones', async () => {
  for (const mode of ['early', 'foreign', 'frame', 'unsandboxed', 'duplicate']) {
    const h = controlled(); await h.start(); h.bind();
    const emit = () => h.electron.ipcMain.emit(STARTUP_BRANCH_PRELOAD_CHANNEL,
      { sender: mode === 'foreign' ? {} : h.wc, senderFrame: mode === 'frame' ? {} : h.wc.mainFrame },
      { ...marker(), ...(mode === 'unsandboxed' ? { sandboxed: false } : {}) });
    if (mode === 'early') emit(); else h.phaseHook = phase => { if (phase === 'preload') emit(); };
    await rejected(h.fixture.observeCommitted({ binding: h.binding }), 'BRANCH_FIXTURE_PRELOAD_OWNER');
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: changed OS/frame identity and duplicate commit/load remain failures', async () => {
  for (const mode of ['pid', 'processId', 'routingId', 'duplicateCommit', 'duplicateLoad']) {
    const h = controlled(); await h.start(); h.bind();
    h.phaseHook = phase => {
      if (phase !== 'commit') return;
      if (mode === 'pid') h.wc.mainFrame.osProcessId++;
      if (mode === 'processId') h.wc.mainFrame.processId++;
      if (mode === 'routingId') h.wc.mainFrame.routingId++;
      if (mode === 'duplicateCommit') h.wc.emit('did-frame-navigate', {}, STARTUP_BRANCH_URL, 200, 'OK', true, 31, 5);
      if (mode === 'duplicateLoad') h.wc.emit('did-finish-load');
    };
    await assert.rejects(h.fixture.observeCommitted({ binding: h.binding }));
    assert.notEqual(JSON.parse(h.fixture.diagnostics()).failure, null);
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: unexpected navigation, popup, frame, permission and external request fail closed', async () => {
  for (const mode of ['navigate', 'popup', 'frame', 'permission', 'network']) {
    const h = controlled(); await h.start(); h.bind();
    if (mode === 'navigate') { let denied = false; h.wc.emit('will-navigate', { preventDefault() { denied = true; } }); assert.equal(denied, true); }
    if (mode === 'popup') assert.deepEqual(h.openHandler({ url: 'about:blank' }), { action: 'deny' });
    if (mode === 'frame') h.wc.emit('frame-created', {}, { frame: { parent: h.wc.mainFrame } });
    if (mode === 'permission') { let granted; h.permissionRequest(h.wc, 'clipboard-read', value => { granted = value; }); assert.equal(granted, false); }
    if (mode === 'network') { let cancel; h.requestHandler({ url: 'https://example.invalid/private', method: 'GET', webContentsId: 12, resourceType: 'mainFrame' }, value => { cancel = value.cancel; }); assert.equal(cancel, true); }
    assert.throws(() => h.fixture.readState());
    assert.equal(h.fixture.diagnostics().includes('https://example.invalid/private'), false);
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: known bootstrap and unknown console errors are normalized, never retained raw', async () => {
  for (const message of ['sandboxed_renderer.bundle.js script failed to run', 'startupData is null', 'synthetic-private-console-value']) {
    const h = controlled(); await h.start(); h.bind();
    h.wc.emit('console-message', { message, sourceId: 'node:electron/js2c/sandbox_bundle', frame: h.wc.mainFrame });
    assert.throws(() => h.fixture.readState(), { code: 'BRANCH_FIXTURE_CONSOLE' });
    assert.equal(h.fixture.diagnostics().includes(message), false);
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: exact held Runtime signature pair completes observation but never product startup', async () => {
  const h = controlled(); await h.start(); h.bind();
  const signatures = ['Electron sandboxed_renderer.bundle.js script failed to run',
    "TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null."];
  h.commandHook = () => { for (const message of signatures) h.wc.emit('console-message', {
    message, sourceId: 'node:electron/js2c/sandbox_bundle', frame: h.wc.mainFrame }); };
  await h.fixture.enableRuntime({ binding: h.binding });
  await h.fixture.observeCommitted({ binding: h.binding });
  const report = JSON.parse(h.fixture.diagnostics());
  assert.equal(report.diagnosticObservationComplete, true);
  assert.equal(report.knownStartupFailureObserved, true);
  assert.equal(report.productStartupSucceeded, false);
  assert.equal(report.failure, null);
  assert.deepEqual(report.events.filter(event => event.event === 'console').map(event => event.signature), signatures);
  await h.prepare(); h.assertClean();
});

test('controlled Electron: allowlist never permits added text, wrong source/frame/phase or repeated signature', async () => {
  for (const mode of ['extra', 'source', 'frame', 'phase', 'duplicate']) {
    const h = controlled(); await h.start(); h.bind();
    const details = { message: 'Electron sandboxed_renderer.bundle.js script failed to run',
      sourceId: 'node:electron/js2c/sandbox_bundle', frame: h.wc.mainFrame };
    if (mode === 'extra') details.message += ' synthetic unexpected suffix';
    if (mode === 'source') details.sourceId = 'synthetic-unowned-source';
    if (mode === 'frame') details.frame = {};
    if (mode === 'phase') h.wc.emit('console-message', details);
    else h.commandHook = () => { h.wc.emit('console-message', details); if (mode === 'duplicate') h.wc.emit('console-message', details); };
    await rejected(h.fixture.enableRuntime({ binding: h.binding }), 'BRANCH_FIXTURE_CONSOLE');
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: missing committed preload stays fatal even with a known reproducing signature', async () => {
  const h = controlled({ observationTimeoutMs: 600 }); h.markerOrder = ['commit', 'load']; await h.start(); h.bind();
  h.commandHook = () => h.wc.emit('console-message', { message: 'Electron sandboxed_renderer.bundle.js script failed to run',
    sourceId: 'node:electron/js2c/sandbox_bundle', frame: h.wc.mainFrame });
  await h.fixture.enableRuntime({ binding: h.binding });
  await rejected(h.fixture.observeCommitted({ binding: h.binding }), 'BRANCH_FIXTURE_OBSERVATION_TIMEOUT');
  assert.equal(JSON.parse(h.fixture.diagnostics()).diagnosticObservationComplete, false);
  await h.prepare(); h.assertClean();
});

test('controlled Electron: Runtime context output is normalized and bounded; unknown session/events fail', async () => {
  const h = controlled(); await h.start(); h.bind(); await h.fixture.enableRuntime({ binding: h.binding });
  h.wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1,
    name: 'synthetic-secret-name', origin: 'https://synthetic-secret-origin', auxData: { frameId: 'frame-1', isDefault: true, type: 'default' } } });
  assert.equal(h.fixture.diagnostics().includes('synthetic-secret'), false);
  for (let i = 2; i <= 81; i++) h.wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: i } });
  assert.throws(() => h.fixture.readState(), { code: 'BRANCH_FIXTURE_CONTEXT_LIMIT' });
  assert.equal(JSON.parse(h.fixture.diagnostics()).events.filter(event => event.event === 'runtime-context').length, 80);
  await h.prepare(); h.assertClean();
});

test('controlled Electron: lifecycle cap fails without unbounded diagnostics or retained permission details', async () => {
  const h = controlled(); await h.start(); h.bind();
  for (let index = 0; index < 300; index++) assert.equal(h.permissionCheck(h.wc, 'synthetic-private-permission'), false);
  const report = JSON.parse(h.fixture.diagnostics());
  assert.equal(report.failure, 'BRANCH_FIXTURE_OUTPUT_LIMIT'); assert.equal(report.overflow, true);
  assert.ok(report.events.length <= 256); assert.ok(Buffer.byteLength(h.fixture.diagnostics()) <= 65536);
  assert.equal(h.fixture.diagnostics().includes('synthetic-private-permission'), false);
  await h.prepare(); h.assertClean();
});

test('controlled Electron: cancellation during held/committed pause prevents a successful receipt and cleans listeners', async () => {
  for (const pauseNumber of [1, 2]) {
    const h = controlled(); await h.start(); h.bind(); const controller = new AbortController(); let count = 0;
    h.pauseHook = () => { if (++count === pauseNumber) controller.abort(); };
    await rejected(h.fixture.observeCommitted({ binding: h.binding, signal: controller.signal }), 'BRANCH_FIXTURE_INTERRUPTED');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    if (pauseNumber === 1) assert.equal(h.response, undefined);
    await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: pending Runtime work remains owned until cleanup detaches and settles it', async () => {
  const h = controlled(); await h.start(); h.bind(); const controller = new AbortController();
  h.wc.debugger.sendCommand = () => new Promise((_, reject) => { h.rejectCommand = reject; queueMicrotask(() => controller.abort()); });
  await rejected(h.fixture.enableRuntime({ binding: h.binding, signal: controller.signal }), 'BRANCH_FIXTURE_INTERRUPTED');
  assert.equal(JSON.parse(h.fixture.diagnostics()).commandSettled, false);
  const prepared = JSON.parse(await h.prepare()); assert.equal(prepared.debuggerDetached, true);
  assert.equal(JSON.parse(h.fixture.diagnostics()).commandSettled, true); h.assertClean();
});

test('controlled Electron: synchronous Runtime send failure has no dangling command to await', async () => {
  const h = controlled({ cleanupTimeoutMs: 10 }); await h.start(); h.bind();
  h.wc.debugger.sendCommand = () => { throw new Error('synthetic synchronous send failure'); };
  await rejected(h.fixture.enableRuntime({ binding: h.binding }), 'BRANCH_FIXTURE_OPERATION');
  assert.equal(JSON.parse(h.fixture.diagnostics()).commandSettled, true);
  await h.prepare(); h.assertClean();
});

test('controlled Electron: synchronous load failure leaves no fictitious pending navigation at cleanup', async () => {
  const h = controlled({ cleanupTimeoutMs: 10 }); h.beforeLoad = () => { throw new Error('synthetic load failure'); };
  await rejected(h.fixture.start(), 'BRANCH_FIXTURE_OPERATION');
  const prepared = JSON.parse(await h.fixture.prepareQuit());
  assert.equal(prepared.loadSettled, true); assert.equal(prepared.windowClosed, true); h.assertClean();
});

test('controlled Electron: a hung close is not OS exit and never triggers forced destruction/quit', async () => {
  const h = controlled({ stuckClose: true, cleanupTimeoutMs: 10 }); await h.start(); h.bind();
  await rejected(h.prepare(), 'BRANCH_FIXTURE_CLEANUP_TIMEOUT');
  assert.equal(JSON.parse(h.fixture.diagnostics()).windowClosed, false);
  assert.equal(h.calls.includes('app.quit'), false);
  assert.throws(() => h.fixture.requestNormalQuit({ binding: h.binding }), { code: 'BRANCH_FIXTURE_QUIT_PHASE' });
});

test('controlled Electron: external close/quit is stopped while collector ownership may still be active', async () => {
  for (const [target, event, code] of [['window', 'close', 'BRANCH_FIXTURE_UNEXPECTED_CLOSE'],
    ['app', 'before-quit', 'BRANCH_FIXTURE_UNEXPECTED_QUIT']]) {
    const h = controlled(); await h.start(); h.bind(); let prevented = false;
    (target === 'app' ? h.electron.app : h.window).emit(event, { preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.throws(() => h.fixture.readState(), { code });
    assert.equal(h.window.closed, false); await h.prepare(); h.assertClean();
  }
});

test('controlled Electron: startup after app ready and pre-existing windows never become owned', async () => {
  const ready = controlled(); ready.ready = true;
  await rejected(ready.fixture.start(), 'BRANCH_FIXTURE_APP_LIFETIME'); assert.deepEqual(ready.calls, []);
  const occupied = controlled(); const foreign = new occupied.electron.BrowserWindow({});
  await rejected(occupied.fixture.start(), 'BRANCH_FIXTURE_UNEXPECTED_WINDOW');
  await occupied.fixture.prepareQuit(); assert.equal(foreign.closed, false);
});

test('controlled Electron: late retained protocol callback cannot release another document or preserve a clean result', async () => {
  const h = controlled(); await h.start(); h.bind(); const retained = h.protocolHandler;
  await h.fixture.observeCommitted({ binding: h.binding }); await h.prepare();
  assert.equal(JSON.parse(h.fixture.diagnostics()).diagnosticObservationComplete, true);
  const response = retained({ url: STARTUP_BRANCH_URL, method: 'GET' });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(h.fixture.diagnostics()).diagnosticObservationComplete, false);
  assert.equal(h.window.closed, true); h.assertClean();
});

test('controlled Electron: destroyed contents cannot fabricate confirmed CDP detach preparation', async () => {
  const h = controlled(); await h.start(); h.bind(); await h.fixture.enableRuntime({ binding: h.binding });
  h.wc.destroyed = true;
  // A passive EventEmitter teardown must not substitute for debugger state.
  h.wc.removeListener = EventEmitter.prototype.removeListener.bind(h.wc);
  await rejected(h.prepare(), 'BRANCH_FIXTURE_DEBUGGER_CLEANUP');
  assert.throws(() => h.fixture.requestNormalQuit({ binding: h.binding }), { code: 'BRANCH_FIXTURE_QUIT_PHASE' });
});

test('controlled Electron: CDP observation ends explicitly before intentional detach teardown notifications', async () => {
  const h = controlled(); await h.start(); h.bind(); await h.fixture.enableRuntime({ binding: h.binding });
  await h.fixture.observeCommitted({ binding: h.binding });
  const detach = h.wc.debugger.detach;
  h.wc.debugger.detach = () => {
    h.wc.debugger.emit('message', {}, 'Runtime.executionContextsCleared', {}); detach();
  };
  await h.prepare(); h.assertClean();
  const report = JSON.parse(h.fixture.diagnostics());
  assert.equal(report.diagnosticObservationComplete, true);
  assert.ok(report.events.some(event => event.event === 'context-observation-ended'));
});

test('controlled Electron: normal-quit preparation does not invent exits; only external receipt join completes quit', async () => {
  const h = controlled(); await h.start(); h.bind(); await h.fixture.observeCommitted({ binding: h.binding });
  const prepared = await h.prepare();
  for (const key of ['fixtureExited', 'rendererExited', 'normalQuit']) {
    const exits = { binding: h.binding, normalQuit: true, fixtureExited: true, rendererExited: true }; exits[key] = false;
    assert.throws(() => completeStartupBranchFixtureQuit(prepared, JSON.stringify(exits)), { code: 'BRANCH_FIXTURE_EXIT_UNCONFIRMED' });
  }
  const stale = clone(h.binding); stale.owner.rendererPid++;
  assert.throws(() => completeStartupBranchFixtureQuit(prepared, JSON.stringify({ binding: stale, normalQuit: true, fixtureExited: true, rendererExited: true })), { code: 'BRANCH_FIXTURE_EXIT_UNCONFIRMED' });
  assert.equal(h.calls.includes('app.quit'), false);
  assert.equal(JSON.parse(h.fixture.requestNormalQuit({ binding: h.binding })).normalQuitRequested, true);
  assert.equal(h.calls.filter(call => call === 'app.quit').length, 1);
  const complete = completeStartupBranchFixtureQuit(prepared, JSON.stringify({ binding: h.binding, normalQuit: true, fixtureExited: true, rendererExited: true }));
  assert.deepEqual(JSON.parse(complete), { binding: h.binding, normalQuit: true, fixtureExited: true, rendererExited: true });
  assert.throws(() => h.fixture.requestNormalQuit({ binding: h.binding }), { code: 'BRANCH_FIXTURE_QUIT_PHASE' });
});

test('controlled Electron: malformed external exit inputs and extra fields never invoke caller accessors', () => {
  for (const value of [null, {}, ' '.repeat(8193), '{', '{}']) {
    assert.throws(() => completeStartupBranchFixtureQuit(value, '{}'));
  }
});

test('controlled integration: frozen coordinator composes explicit binding and external-exit boundary, not native evidence', async () => {
  for (const earlyRuntime of [false, true]) {
    const h = controlled(); await h.start();
    if (earlyRuntime) h.commandHook = () => h.wc.emit('console-message', {
      message: 'Electron sandboxed_renderer.bundle.js script failed to run',
      sourceId: 'node:electron/js2c/sandbox_bundle', frame: h.wc.mainFrame });
    const provenance = { kind: 'synthetic', adapterId: 'controlled-fixture-composition', sha256: 'a'.repeat(64) };
    const collector = {
      arm({ binding, onRecord }) {
        h.binding = binding; h.fixture.bind({ binding }); this.onRecord = onRecord;
        return JSON.stringify({ binding, runtime: STARTUP_BRANCH_RUNTIME, provenance,
          sites: STARTUP_BRANCH_SITES.map(site => ({ ...site, enabled: true, locations: 1 })) });
      },
      begin({ binding }) { return JSON.stringify({ binding, recording: true, resumed: true }); },
      stopAndDrain({ binding }) {
        // Explicitly fabricated branch ORDER for orchestration only; these are
        // not a native collector implementation or real breakpoint observations.
        ['service-check', 'null-fallback', 'result-merge'].forEach((site, index) =>
          assert.equal(this.onRecord(JSON.stringify({ sequence: index + 1, threadOrdinal: 1, site })), true));
        return JSON.stringify({ binding, quiescent: true, complete: true, overflow: false, lossless: true, recordCount: 3 });
      },
      removeSites({ binding }) { return JSON.stringify({ binding, removedSites: STARTUP_BRANCH_SITES.map(site => site.id), remaining: 0 }); },
      detachAndResume({ binding }) { return JSON.stringify({ binding, runtime: STARTUP_BRANCH_RUNTIME, provenance,
        finalized: true, detached: true, resumed: true, callbacksRemoved: true, debuggerExited: true }); }
    };
    const fixture = { ...h.fixture, async quit(args) {
      const prepared = await h.fixture.prepareQuit(args); h.fixture.requestNormalQuit(args);
      // The real external driver must independently observe these OS exits.
      // Here the receipt is intentionally synthetic and never native evidence.
      return completeStartupBranchFixtureQuit(prepared, JSON.stringify({ binding: args.binding,
        normalQuit: true, fixtureExited: true, rendererExited: true }));
    } };
    const result = await createStartupBranchCoordinator({ fixture, collector }).run({ enabled: true, earlyRuntime });
    assert.equal(result.complete, true); assert.equal(result.evidenceScope, 'synthetic-coordination-only');
    assert.equal(result.interpretation, null); h.assertClean();
    const report = JSON.parse(h.fixture.diagnostics());
    assert.equal(report.diagnosticObservationComplete, true);
    assert.equal(report.knownStartupFailureObserved, earlyRuntime);
    assert.equal(report.productStartupSucceeded, earlyRuntime ? false : null);
  }
});
