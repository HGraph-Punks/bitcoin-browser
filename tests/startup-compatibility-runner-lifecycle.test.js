import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as diagnostic from '../scripts/diagnose-startup-compatibility.mjs';
import { COMPATIBILITY_DOCUMENTS, validateCompatibilityReport } from '../scripts/startup-compatibility-support.mjs';

const reportPath = '/tmp/startup-compatibility-lifecycle.json';
const ownershipPath = '/tmp/startup-compatibility-lifecycle-ownership.json';
const interruptedPath = '/tmp/startup-compatibility-lifecycle-interrupted.json';
const profile = '/tmp/startup-compatibility-native-lifecycle-fixture';
const turns = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const capture = promise => promise.then(result => ({ result }), error => ({ error }));
const ownedProfile = record => typeof record?.profile === 'string' ? record.profile : record?.profile?.path;
const noSuccess = outcome => {
  if (!outcome.error) assert.equal(outcome.result?.complete, false);
};

// Synthetic report, not evidence from Electron. This keeps the tests focused on
// runner ownership/cancellation rather than re-running the fixture orchestration.
function validFixture() {
  const owners = { blank: 1, host: 2, child: 3 };
  return { schemaVersion: 1, fixtureComplete: true, debuggerUsed: false,
    security: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    cleanup: { listenersRemaining: 0, windowsRemaining: 0, protocolRemoved: true }, failures: [], permissionChecks: [], consoleEvents: [],
    heldResponse: { released: true, preloadsBeforeRelease: 0, observedMs: 75 },
    childBlank: { observedMs: 75, navigationRequests: 0 },
    windows: Object.entries(owners).map(([owner, webContentsId]) => ({ owner, webContentsId, closed: true })),
    documents: COMPATIBILITY_DOCUMENTS.map((doc, index) => ({ ...doc, webContentsId: owners[doc.owner],
      contextId: `synthetic-context-${index}`, preloadCount: 1, frameProcessId: owners[doc.owner], frameRoutingId: 1,
      sandboxed: true, contextIsolated: true, isMainFrame: true, commitCount: doc.committed ? 1 : 0, loadCount: doc.committed ? 1 : 0,
      page: { href: doc.url, contextId: `synthetic-context-${index}`, requireAbsent: true, processAbsent: true, moduleAbsent: true, bufferAbsent: true } })),
    runtime: { electron: '44.2.0', chrome: '152.0.7977.76', architecture: 'arm64' } };
}

function fixture({ abortAt = null, holdClose = false, closeOverride = {}, pid = 12345,
  ownershipWriteFails = false, finalWriteFails = false, markerWriteFails = false, pipeAccessFails = false } = {}) {
  const controller = new AbortController(); const order = []; const writes = []; const fallbacks = [];
  const gates = { spawned: deferred(), waiter: deferred(), close: deferred() };
  const child = new EventEmitter(); const stdout = new EventEmitter(); const stderr = new EventEmitter();
  const state = { mkdtemp: 0, launches: 0, waiters: 0, removals: 0, kills: [], inputReads: 0 };
  Object.assign(child, { pid, exitCode: null, signalCode: null });
  Object.defineProperty(child, 'stdout', { get() { order.push('stdout-access'); if (pipeAccessFails) throw Error('SYNTHETIC_PIPE_ACCESS'); return stdout; } });
  child.stderr = stderr;
  child.kill = signal => { state.kills.push({ child, signal }); order.push(`kill:${signal}`); return true; };
  child.unref = () => { order.push('detach'); };
  const close = { closeConfirmed: true, code: 0, signal: null, forced: false, timedOut: false, spawnError: null, killError: null, ...closeOverride };
  function releaseClose() {
    child.exitCode = close.code; child.signalCode = close.signal;
    stdout.emit('data', `STARTUP_COMPATIBILITY_RESULT:${JSON.stringify(validFixture())}\n`);
    gates.close.resolve(close);
  }
  if (abortAt === 'before') controller.abort();
  const deps = {
    fs: {
      async lstat() { throw Object.assign(Error('synthetic absent'), { code: 'ENOENT' }); },
      async mkdtemp() {
        state.mkdtemp++; order.push('mkdtemp');
        if (abortAt === 'mkdtemp') controller.abort();
        return profile;
      },
      async rm() { state.removals++; order.push('remove'); },
      async writeFile(filename, text, options) {
        const record = { filename, value: JSON.parse(text), options }; writes.push(record);
        const kind = filename === ownershipPath ? 'ownership' : filename === interruptedPath ? 'interrupted' : 'report';
        order.push(`write:${kind}`);
        if (filename === ownershipPath) {
          if (abortAt === 'ownership-write') controller.abort();
          if (ownershipWriteFails) throw Object.assign(Error('synthetic ownership write failed'), { code: 'EIO' });
        }
        if (filename === reportPath) {
          if (abortAt === 'report-write') controller.abort();
          if (finalWriteFails) throw Object.assign(Error('synthetic report write failed'), { code: 'EIO' });
        }
        if (filename === interruptedPath && markerWriteFails) throw Object.assign(Error('synthetic marker write failed'), { code: 'EIO' });
      }
    },
    async readInput(filename, _maxBytes, collect) {
      state.inputReads++;
      if (abortAt === 'preflight') controller.abort();
      const metadata = filename.endsWith('/electron/package.json') ? JSON.stringify({ version: '44.2.0' }) : '44.2.0';
      return { path: filename, sha256: 'synthetic-unchanged',
        ...(/\/(?:Electron|Electron Framework)$/.test(filename) ? { architecture: 'arm64' } : {}),
        ...(collect ? { data: Buffer.from(metadata) } : {}) };
    },
    spawn(executable, args) {
      state.launches++; order.push('spawn'); state.executable = executable; state.args = args;
      if (abortAt === 'spawn') controller.abort();
      gates.spawned.resolve(); return child;
    },
    waitClose(ownedChild, timeoutMs, postKillMs) {
      assert.equal(ownedChild, child); assert.ok(timeoutMs > 0 && timeoutMs <= 30000); assert.ok(postKillMs > 0 && postKillMs <= 5000);
      state.waiters++; order.push('wait-close'); gates.waiter.resolve();
      if (!holdClose) queueMicrotask(releaseClose);
      return gates.close.promise;
    },
    reportFailure(value) { fallbacks.push(value); order.push('fallback'); },
    reportOwnership() { order.push('ownership-notice'); }
  };
  return { controller, state, child, stdout, stderr, order, writes, fallbacks, gates, releaseClose,
    run: () => diagnostic.runCompatibilityDiagnostic({ runNative: true, reportPath, signal: controller.signal }, deps) };
}

test('synthetic fixture satisfies the runner evidence contract without native execution', () => {
  assert.equal(validateCompatibilityReport(validFixture()), true);
});

for (const abortAt of ['before', 'preflight']) {
  test(`${abortAt} cancellation rejects before profile allocation or spawn`, async () => {
    const f = fixture({ abortAt });
    await assert.rejects(f.run(), { code: 'COMPATIBILITY_INTERRUPTED' });
    assert.equal(f.state.mkdtemp, 0); assert.equal(f.state.launches, 0); assert.equal(f.state.removals, 0);
  });
}

for (const abortAt of ['mkdtemp', 'ownership-write']) {
  test(`${abortAt} cancellation retains allocated ownership and never spawns`, async () => {
    const f = fixture({ abortAt }); const outcome = await capture(f.run());
    noSuccess(outcome);
    assert.equal(f.state.mkdtemp, 1); assert.equal(f.state.launches, 0); assert.equal(f.state.removals, 0);
    assert.ok([...f.writes.map(item => item.value), ...f.fallbacks].some(record => ownedProfile(record) === profile), 'allocated profile has retained ownership evidence');
    if (outcome.result) { assert.equal(outcome.result.profile.path, profile); assert.equal(outcome.result.profile.removed, false); }
  });
}

test('exclusive private ownership sidecar precedes spawn and even clean profiles are retained', async () => {
  const f = fixture(); const result = await f.run();
  const ownership = f.writes.find(item => item.filename === ownershipPath);
  assert.ok(ownership); assert.equal(ownership.options.flag, 'wx'); assert.equal(ownership.options.mode, 0o600);
  assert.equal(ownedProfile(ownership.value), profile); assert.equal(ownership.value.executable, f.state.executable); assert.equal(ownership.value.reportPath, reportPath);
  assert.ok(f.order.indexOf('write:ownership') < f.order.indexOf('spawn'));
  assert.equal(result.complete, true); assert.equal(result.launchAttempted, true); assert.equal(result.nativeExecuted, true);
  assert.equal(result.profile.removed, false); assert.equal(f.state.removals, 0); assert.equal(f.state.waiters, 1);
  assert.equal(f.stdout.listenerCount('data'), 0); assert.equal(f.stderr.listenerCount('data'), 0);
});

test('ownership sidecar write failure prevents spawn and preserves the new profile', async () => {
  const f = fixture({ ownershipWriteFails: true }); const outcome = await capture(f.run());
  noSuccess(outcome);
  assert.equal(f.state.launches, 0); assert.equal(f.state.removals, 0);
  assert.ok(f.writes.some(item => item.filename === ownershipPath));
});

test('active-child cancellation signals exactly that child once and still awaits its sole close waiter', async t => {
  const f = fixture({ holdClose: true }); let settled = false;
  const running = capture(f.run()).finally(() => { settled = true; });
  t.after(async () => { f.releaseClose(); await running; });
  await f.gates.waiter.promise;
  f.controller.abort(); f.controller.signal.dispatchEvent(new Event('abort'));
  await turns();
  assert.deepEqual(f.state.kills, [{ child: f.child, signal: 'SIGTERM' }]);
  assert.equal(settled, false); assert.equal(f.state.waiters, 1);
  f.releaseClose(); const outcome = await running;
  assert.equal(outcome.error, undefined); assert.equal(outcome.result.complete, false);
  assert.equal(outcome.result.profile.removed, false); assert.equal(f.state.removals, 0);
});

test('abort during synchronous spawn return is handled without losing child ownership', async () => {
  const f = fixture({ abortAt: 'spawn' }); const result = await f.run();
  assert.equal(result.complete, false); assert.equal(f.state.waiters, 1);
  assert.deepEqual(f.state.kills, [{ child: f.child, signal: 'SIGTERM' }]);
  assert.equal(result.profile.removed, false);
});

test('the single close waiter is established before fallible pipe hookup', async () => {
  const f = fixture({ pipeAccessFails: true }); const outcome = await capture(f.run());
  noSuccess(outcome); assert.equal(f.state.waiters, 1);
  assert.ok(f.order.indexOf('wait-close') < f.order.indexOf('stdout-access'));
  assert.equal(f.state.removals, 0);
});

for (const closeOverride of [
  { code: 1 }, { code: null, signal: 'SIGTERM' }, { forced: true }, { timedOut: true },
  { closeConfirmed: false, code: null, timedOut: true }
]) {
  test(`unclean result ${JSON.stringify(closeOverride)} remains failed with profile retained`, async () => {
    const f = fixture({ closeOverride }); const result = await f.run();
    assert.equal(result.complete, false); assert.equal(result.profile.removed, false); assert.equal(f.state.removals, 0);
    assert.equal(result.launchAttempted, true); assert.equal(result.nativeExecuted, true); assert.equal(f.state.waiters, 1);
  });
}

test('an attempted spawn without a positive PID is never recorded as native execution', async () => {
  const f = fixture({ pid: null, closeOverride: { code: -2, spawnError: 'ENOENT' } }); const result = await f.run();
  assert.equal(result.launchAttempted, true); assert.equal(result.nativeExecuted, false); assert.equal(result.complete, false);
  assert.equal(result.profile.removed, false); assert.equal(f.state.removals, 0);
});

test('cancellation while terminal report writes adds an exclusive interruption marker and returns failed', async () => {
  const f = fixture({ abortAt: 'report-write' }); const result = await f.run();
  assert.equal(f.writes.find(item => item.filename === reportPath)?.value.complete, true, 'the write began with a settled successful result');
  const marker = f.writes.find(item => item.filename === interruptedPath);
  assert.ok(marker); assert.equal(marker.options.flag, 'wx'); assert.equal(marker.options.mode, 0o600);
  assert.equal(marker.value.complete, false); assert.equal(marker.value.reportPath, reportPath);
  assert.equal(result.complete, false); assert.equal(result.profile.removed, false); assert.equal(f.state.kills.length, 0);
});

test('late interruption-marker write failure publishes fallback and can never return success', async () => {
  const f = fixture({ abortAt: 'report-write', markerWriteFails: true }); const outcome = await capture(f.run());
  noSuccess(outcome); assert.ok(f.writes.some(item => item.filename === interruptedPath));
  assert.ok(f.fallbacks.length > 0); assert.equal(f.state.removals, 0);
});

test('failed terminal write publishes ownership fallback before detaching an unconfirmed child', async () => {
  const f = fixture({ closeOverride: { closeConfirmed: false, code: null, timedOut: true }, finalWriteFails: true });
  const outcome = await capture(f.run()); noSuccess(outcome);
  assert.equal(f.state.removals, 0); assert.equal(f.state.waiters, 1);
  assert.ok(f.fallbacks.some(value => ownedProfile(value) === profile));
  assert.ok(f.order.indexOf('write:report') < f.order.indexOf('fallback'));
  assert.ok(f.order.indexOf('fallback') < f.order.indexOf('detach'));
});

test('CLI SIGINT and SIGTERM handlers abort one controller and dispose only their own listeners', () => {
  assert.equal(typeof diagnostic.installCompatibilityInterruptHandlers, 'function');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const target = new EventEmitter(); const controller = new AbortController(); const untouched = () => {};
    target.on('SIGINT', untouched); target.on('SIGTERM', untouched);
    const dispose = diagnostic.installCompatibilityInterruptHandlers(controller, target);
    assert.equal(controller.signal.aborted, false); target.emit(signal); assert.equal(controller.signal.aborted, true);
    dispose(); dispose();
    assert.deepEqual(target.listeners('SIGINT'), [untouched]); assert.deepEqual(target.listeners('SIGTERM'), [untouched]);
  }
});
