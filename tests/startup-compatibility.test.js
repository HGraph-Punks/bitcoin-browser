import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { COMPATIBILITY_CHANNEL, COMPATIBILITY_HOST, COMPATIBILITY_CHILD, COMPATIBILITY_PAGE_PROBE,
  runStartupCompatibility, validateCompatibilityReport } from '../scripts/startup-compatibility-support.mjs';
import { runCompatibilityDiagnostic } from '../scripts/diagnose-startup-compatibility.mjs';

const preloadSource = await fs.readFile(new URL('./fixtures/wallet-startup/compatibility-preload.cjs', import.meta.url), 'utf8');

// These are controlled Electron collaborators, not a Blink/preload/runtime simulation.
// Executing the actual fixture preload checks its contract; native timing remains untested.
function fixture({ fault = null, preloadFirst = false } = {}) {
  const app = new EventEmitter(); const ipcMain = new EventEmitter(); const windows = [];
  const handlers = {}; const order = []; let clock = 0; let context = 0; let checks = 0;
  const targetSession = {
    setPermissionRequestHandler(listener) { handlers.permission = listener; },
    setPermissionCheckHandler(listener) { handlers.permissionCheck = listener; },
    webRequest: { onBeforeRequest(filter, listener) { handlers.request = filter === null ? null : listener; } },
    protocol: { handle(scheme, listener) { handlers[scheme] = listener; }, unhandle(scheme) { delete handlers[scheme]; } }
  };
  function marker(win, url) {
    win.page = { location: { href: url } };
    if (fault === 'page-node' && url === COMPATIBILITY_CHILD) win.page.require = () => {};
    const isolated = {
      location: { href: url }, process: { contextId: `fixture-${++context}`, sandboxed: fault !== 'unsandboxed', contextIsolated: true, isMainFrame: true },
      require(name) {
        assert.equal(name, 'electron');
        return { contextBridge: { exposeInMainWorld(key, value) { win.page[key] = value; } },
          ipcRenderer: { send(channel, value) {
            assert.equal(channel, COMPATIBILITY_CHANNEL);
            const senderFrame = fault === 'wrong-frame' ? { ...win.webContents.mainFrame } : win.webContents.mainFrame;
            if (fault === 'stale-frame-url' && url === COMPATIBILITY_CHILD) senderFrame.url = COMPATIBILITY_HOST;
            ipcMain.emit(channel, { sender: win.webContents, senderFrame }, value);
            if (fault === 'duplicate-preload' && url === COMPATIBILITY_CHILD) ipcMain.emit(channel, { sender: win.webContents, senderFrame }, { ...value, contextId: 'duplicate' });
          } } };
      }
    };
    vm.runInNewContext(preloadSource, isolated);
  }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this); const n = windows.length;
      const wc = new EventEmitter(); this.webContents = wc; wc.id = n; wc.mainFrame = { url: '', processId: n, routingId: 1 };
      wc.setWindowOpenHandler = fn => { wc.openHandler = fn; };
      wc.isDestroyed = () => this.closed === true;
      wc.close = () => this.close();
      wc.executeJavaScript = async source => {
        if (source === COMPATIBILITY_PAGE_PROBE) { checks++; return vm.runInNewContext(source, this.page); }
        assert.equal(source, "window.open('about:blank', 'startup-owned-child') !== null");
        const details = { url: fault === 'wrong-child-url' ? 'https://unexpected.invalid/' : 'about:blank', frameName: 'startup-owned-child' };
        const allowed = wc.openHandler(details);
        if (allowed.action !== 'allow') return false;
        const child = new BrowserWindow(allowed.overrideBrowserWindowOptions);
        child.webContents.mainFrame.url = 'about:blank';
        wc.emit('did-create-window', child, details);
        marker(child, 'about:blank');
        if (fault === 'extra-window') new BrowserWindow(options);
        return true;
      };
      if (fault === 'listener-leak') {
        const remove = wc.removeListener.bind(wc);
        wc.removeListener = (name, listener) => name === 'did-finish-load' ? wc : remove(name, listener);
      }
      if (fault === 'native-console-removal') {
        const remove = wc.removeListener.bind(wc);
        wc.removeListener = (name, listener) => {
          const present = wc.listeners(name).includes(listener);
          const result = remove(name, listener);
          if (name === 'console-message' && present) {
            order.push(['console-removed', wc.id, this.closed === true]);
            if (this.closed) throw Error('SYNTHETIC_DESTROYED_NATIVE_CONSOLE_HOOK');
          }
          return result;
        };
      }
      app.emit('web-contents-created', {}, wc);
    }
    async loadURL(url) {
      order.push(['load', this.webContents.id, url]);
      this.webContents.emit('did-start-navigation', { url, isMainFrame: true, preventDefault() {} });
      if (url.startsWith('app:')) {
        handlers.request({ url, webContentsId: this.webContents.id, resourceType: 'mainFrame', method: 'GET' }, result => assert.equal(result.cancel, false));
        const response = await handlers.app({ url }); assert.equal(response.status, 200);
      }
      this.webContents.mainFrame.url = url;
      const commit = () => this.webContents.emit('did-frame-navigate', {}, url, 200, 'OK', true,
        this.webContents.mainFrame.processId, this.webContents.mainFrame.routingId);
      if (preloadFirst) marker(this, url);
      if (!(fault === 'missing-commit' && url === 'about:blank')) commit();
      if (!preloadFirst) marker(this, url);
      this.webContents.emit('did-finish-load');
      if (fault === 'sandbox-console') this.webContents.emit('console-message', { sourceId: 'node:electron/js2c/sandbox_bundle' });
      if ((['blank-csp-warning', 'blank-csp-error', 'blank-csp-other-frame', 'sandbox-script-failed', 'sandbox-data-null'].includes(fault) && url === 'about:blank')
        || (fault === 'host-csp-warning' && url === COMPATIBILITY_HOST)) {
        this.webContents.emit('console-message', { sourceId: 'node:electron/js2c/sandbox_bundle',
          message: fault === 'sandbox-script-failed' ? 'sandboxed_renderer.bundle.js script failed to run'
            : fault === 'sandbox-data-null' ? 'binding.startupData is null' : 'Electron Security Warning (Insecure Content-Security-Policy)',
          level: fault === 'blank-csp-error' ? 'error' : 'warning',
          frame: fault === 'blank-csp-other-frame' ? { ...this.webContents.mainFrame } : this.webContents.mainFrame });
      }
      if (fault === 'permission') handlers.permission(this.webContents, 'camera', allowed => assert.equal(allowed, false));
      if (fault === 'permission-check' || fault === 'permission-check-overflow') {
        for (let i = 0; i < (fault === 'permission-check-overflow' ? 129 : 1); i++) {
          assert.equal(handlers.permissionCheck(this.webContents, 'clipboard-sanitized-write'), false);
        }
      }
      if (fault === 'unexpected-request') handlers.request({ url: 'https://unexpected.invalid/' }, result => assert.equal(result.cancel, true));
      if (fault === 'wrong-commit') this.webContents.emit('did-frame-navigate', {}, url, 200, 'OK', false, 200, 9);
    }
    close() { if (!this.closed && fault !== 'leaked-window') { this.closed = true; order.push(['close', this.webContents.id]); this.emit('closed'); } }
    destroy() { if (fault !== 'leaked-window') this.close(); }
  }
  Object.assign(app, { enableSandbox() { order.push(['sandbox']); }, whenReady: async () => {} });
  const electron = { app, ipcMain, BrowserWindow, protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition(partition) {
    assert.equal(partition, 'startup-compatibility'); return targetSession;
  } } };
  return { app, ipcMain, windows, handlers, order,
    async run() { return runStartupCompatibility({ electron, preloadPath: '/fixture/compatibility-preload.cjs', timeoutMs: 20,
      now: () => clock, pause: async ms => { clock += ms; } }); },
    get checks() { return checks; }
  };
}

for (const preloadFirst of [false, true]) {
  test(`actual harness qualifies four distinct documents with ${preloadFirst ? 'preload' : 'commit'} first`, async () => {
    const f = fixture({ preloadFirst }); const report = await f.run();
    assert.deepEqual(report.failures, []);
    assert.equal(validateCompatibilityReport(report), true);
    assert.equal(f.checks, 4);
    assert.deepEqual(f.order.filter(item => item[0] === 'load'), [
      ['load', 1, 'about:blank'], ['load', 2, COMPATIBILITY_HOST], ['load', 3, COMPATIBILITY_CHILD]
    ], 'the child blank checkpoint issues no navigation');
    assert.deepEqual(report.documents.map(doc => [doc.id, doc.preloadCount]), [
      ['committed-blank', 1], ['held-host', 1], ['child-initial-blank', 1], ['child-navigated', 1]
    ]);
    assert.equal(report.documents[2].commitCount, 0, 'a blank child need not commit a further navigation');
    for (const win of f.windows) {
      assert.equal(win.closed, true);
      assert.equal(win.webContents.eventNames().length, 0);
      assert.equal(win.eventNames().length, 0);
      assert.equal(win.options.webPreferences.sandbox, true);
      assert.equal(win.options.webPreferences.contextIsolation, true);
      assert.equal(win.options.webPreferences.nodeIntegration, false);
      assert.equal(win.options.webPreferences.webSecurity, true);
    }
    assert.equal(f.app.eventNames().length, 0); assert.equal(f.ipcMain.eventNames().length, 0);
    assert.equal(f.handlers.app, undefined); assert.equal(f.handlers.permission, null);
  });
}

for (const fault of ['unsandboxed', 'page-node', 'wrong-frame', 'duplicate-preload', 'missing-commit', 'wrong-child-url',
  'extra-window', 'sandbox-console', 'blank-csp-error', 'blank-csp-other-frame', 'sandbox-script-failed', 'sandbox-data-null', 'host-csp-warning',
  'permission', 'permission-check-overflow', 'unexpected-request', 'wrong-commit', 'stale-frame-url', 'listener-leak']) {
  test(`actual harness fails closed for ${fault}`, async () => {
    const f = fixture({ fault }); const report = await f.run();
    assert.equal(report.fixtureComplete, false);
    assert.equal(validateCompatibilityReport(report), false);
    assert.ok(report.failures.length);
    assert.equal(f.windows.every(win => win.closed), true, 'failures still close owned windows');
  });
}

test('evidence validator rejects forged ownership, multiplicity, missing cleanup and page authority', async () => {
  const report = await fixture().run();
  for (const mutate of [
    r => { r.documents.pop(); }, r => { r.documents[0].preloadCount = 2; },
    r => { r.documents[3].contextId = r.documents[2].contextId; },
    r => { r.documents[0].webContentsId = r.documents[1].webContentsId; },
    r => { r.documents[0].frameRoutingId = null; }, r => { r.documents[0].commitCount = 0; },
    r => { r.documents[1].page.requireAbsent = false; }, r => { r.documents[0].page.contextId = 'stale'; },
    r => { r.windows[2].closed = false; }, r => { r.cleanup.listenersRemaining = 1; },
    r => { r.heldResponse.preloadsBeforeRelease = 1; }, r => { r.childBlank.navigationRequests = 1; },
    r => { r.debuggerUsed = true; }, r => { r.security.contextIsolation = false; },
    r => { r.documents[0] = null; }, r => { r.windows[0] = null; },
    r => { delete r.heldResponse.observedMs; }, r => { r.childBlank.observedMs = NaN; },
    r => { delete r.permissionChecks; },
    r => { delete r.consoleEvents; },
    r => { r.consoleEvents.push({ code: 'SANDBOX_STARTUP_DATA_NULL', owner: 'blank', document: 'committed-blank', webContentsId: 1, mainFrame: true, level: 'warning' }); },
    r => { r.permissionChecks.push({ permission: 'notifications', owner: 'blank', webContentsId: 1, granted: true }); }
  ]) { const changed = structuredClone(report); mutate(changed); assert.equal(validateCompatibilityReport(changed), false); }
});

test('routine permission checks are denied and retained without granting authority or failing navigation', async () => {
  const report = await fixture({ fault: 'permission-check' }).run();
  assert.equal(validateCompatibilityReport(report), true);
  assert.equal(report.permissionChecks.length, 3);
  assert.ok(report.permissionChecks.every(check => check.permission === 'clipboard-sanitized-write' && check.granted === false));
  assert.deepEqual(report.permissionChecks.map(check => check.owner), ['blank', 'host', 'child']);
});

test('explicit blank CSP warning is retained while sandbox failures and nonblank warnings still fail', async () => {
  const report = await fixture({ fault: 'blank-csp-warning' }).run();
  assert.equal(validateCompatibilityReport(report), true);
  assert.equal(report.consoleEvents.length, 1);
  assert.deepEqual(report.consoleEvents[0], { code: 'ELECTRON_INSECURE_CSP_WARNING', owner: 'blank', document: 'committed-blank',
    webContentsId: 1, mainFrame: true, level: 'warning' });
});

test('native console observer is removed before destroying its WebContents', async () => {
  const f = fixture({ fault: 'native-console-removal' }); const report = await f.run();
  assert.equal(validateCompatibilityReport(report), true);
  assert.equal(report.cleanup.listenersRemaining, 0);
  assert.deepEqual(f.order.filter(item => item[0] === 'console-removed'), [
    ['console-removed', 1, false], ['console-removed', 3, false], ['console-removed', 2, false]
  ]);
});

test('observation durations outside the defined 50 to 5000 ms bound never qualify', async () => {
  const report = await fixture().run();
  for (const checkpoint of ['heldResponse', 'childBlank']) {
    for (const value of [undefined, null, '75', NaN, Infinity, -1, 49, 5001]) {
      const changed = structuredClone(report); changed[checkpoint].observedMs = value;
      assert.equal(validateCompatibilityReport(changed), false, `${checkpoint}: ${value}`);
    }
  }
});

test('missing and malformed evidence is rejected without throwing', () => {
  for (const value of [undefined, null, false, 1, '', [], {}, { documents: [null], windows: [null] }]) {
    assert.equal(validateCompatibilityReport(value), false);
  }
});

test('leaked windows remain explicit failed evidence after close and destroy both fail', async () => {
  const report = await fixture({ fault: 'leaked-window' }).run();
  assert.equal(report.fixtureComplete, false);
  assert.equal(report.cleanup.windowsRemaining, 1);
  assert.ok(report.failures.includes('COMPATIBILITY_WINDOWS_REMAIN'));
});

test('fixture preload exposes only context identity and sends real process authority markers once', () => {
  const exposed = []; const sent = [];
  vm.runInNewContext(preloadSource, { location: { href: 'about:blank' }, process: {
    contextId: 'context-1', sandboxed: true, contextIsolated: true, isMainFrame: true
  }, require: name => { assert.equal(name, 'electron'); return {
    contextBridge: { exposeInMainWorld: (key, value) => exposed.push([key, value]) },
    ipcRenderer: { send: (key, value) => sent.push([key, value]) }
  }; } });
  assert.equal(exposed.length, 1); assert.deepEqual(Object.keys(exposed[0][1]), ['contextId']);
  assert.equal(sent.length, 1); assert.equal(sent[0][1].sandboxed, true);
  assert.equal(sent[0][1].contextIsolated, true); assert.equal(sent[0][1].isMainFrame, true);
});

test('native runner requires explicit opt-in before touching files or spawning', async () => {
  await assert.rejects(runCompatibilityDiagnostic({ reportPath: '/tmp/startup-compatibility-test.json' }, {
    fs: { lstat() { assert.fail('unexpected filesystem access'); } }, spawn() { assert.fail('unexpected spawn'); }
  }), /Explicit --run-native/);
});

async function runnerFixture({ closeConfirmed = true, writeFailure = false, changed = false, invalid = false, identity = null } = {}) {
  const fixtureReport = await fixture().run(); if (invalid) fixtureReport.documents[0].preloadCount = 0;
  fixtureReport.runtime = { electron: identity === 'runtime-version' ? '43.0.0' : '44.2.0',
    chrome: '152.0.7977.76', architecture: identity === 'runtime-architecture' ? 'x64' : 'arm64' };
  const child = new EventEmitter(); child.pid = 12345; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const order = []; const reads = new Map(); let output;
  child.unref = () => order.push('detach');
  return { order, get output() { return output; },
    run: () => runCompatibilityDiagnostic({ runNative: true, reportPath: '/tmp/startup-compatibility-test.json' }, {
      fs: { async lstat() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        async mkdtemp() { return '/tmp/startup-compatibility-native-owned'; },
        async rm(target) { assert.equal(target, '/tmp/startup-compatibility-native-owned'); order.push('remove'); },
        async writeFile(filename, body, options) {
          assert.equal(options.flag, 'wx'); assert.equal(options.mode, 0o600);
          const ownership = filename.endsWith('-ownership.json');
          order.push(ownership ? 'ownership' : 'report');
          if (!ownership) { output = JSON.parse(body); if (writeFailure) throw Error('write failed'); }
        } },
      readInput: async (filename, _maxBytes, collect) => {
        const count = (reads.get(filename) ?? 0) + 1; reads.set(filename, count);
        let data;
        if (collect && filename.split(path.sep).join('/').endsWith('/electron/package.json')) data = Buffer.from(identity === 'malformed-package' ? '{}' : JSON.stringify({ version: '44.2.0' }));
        if (collect && filename.split(path.sep).join('/').endsWith('/electron/dist/version')) data = Buffer.from(identity === 'version-file' ? '43.0.0' : '44.2.0');
        return { path: filename, sha256: changed && count > 1 ? 'changed' : 'original',
          ...(/\/(?:Electron|Electron Framework)$/.test(filename.split(path.sep).join('/')) ? { architecture: identity === 'binary-architecture' && filename.endsWith('Electron Framework') ? 'x64' : 'arm64' } : {}),
          ...(collect ? { data } : {}) };
      },
      reportFailure: value => { assert.equal(value.profile.removed, false); order.push('fallback'); },
      reportOwnership() {},
      spawn: (_executable, args, options) => { assert.equal(args.includes('--compatibility-child'), true); assert.equal(options.stdio[0], 'ignore'); return child; },
      waitClose: async () => {
        // Native ChildProcess output arrives asynchronously after observation
        // is installed, not synchronously from the close-observer constructor.
        await Promise.resolve();
        child.stdout.emit('data', `STARTUP_COMPATIBILITY_RESULT:${JSON.stringify(fixtureReport)}\n`);
        return { closeConfirmed, code: closeConfirmed ? 0 : null, signal: null, forced: false, timedOut: !closeConfirmed, spawnError: null, killError: null };
      }
    }) };
}

test('native runner controlled success requires exact fixture, close and unchanged inputs', async () => {
  const f = await runnerFixture(); const report = await f.run();
  assert.equal(report.complete, true); assert.equal(report.earlyDebuggerQualified, false);
  assert.equal(report.supportedRuntimeCorrectionQualified, false);
  assert.deepEqual(f.order, ['ownership', 'report']);
  assert.equal(report.profile.removed, false);
  assert.equal(report.profile.retained, true);
  for (const option of [{ changed: true }, { invalid: true }]) {
    assert.equal((await (await runnerFixture(option)).run()).complete, false);
  }
});

test('native runner rejects mismatched or unavailable package, version-file and runtime identities', async () => {
  for (const identity of ['runtime-version', 'runtime-architecture', 'binary-architecture', 'version-file', 'malformed-package']) {
    const report = await (await runnerFixture({ identity })).run();
    assert.equal(report.complete, false, identity);
  }
});

test('provenance includes all local behavior dependencies and both installed version identities', async () => {
  const report = await (await runnerFixture()).run();
  for (const suffix of ['/scripts/startup-diagnostic-support.mjs', '/scripts/startup-barrier-support.mjs',
    '/scripts/packaged-smoke-child-lifecycle.mjs', '/node_modules/electron/package.json', '/node_modules/electron/dist/version']) {
    assert.equal(report.provenance.before.some(input => input.path.split(path.sep).join('/').endsWith(suffix)), true, suffix);
  }
});

test('unconfirmed native close retains exact profile and writes evidence before detaching', async () => {
  for (const writeFailure of [false, true]) {
    const f = await runnerFixture({ closeConfirmed: false, writeFailure });
    if (writeFailure) await assert.rejects(f.run(), /write failed/);
    else { const report = await f.run(); assert.equal(report.complete, false); assert.equal(report.profile.removed, false); }
    assert.deepEqual(f.order, writeFailure ? ['ownership', 'report', 'fallback', 'detach'] : ['ownership', 'report', 'detach']);
  }
});
