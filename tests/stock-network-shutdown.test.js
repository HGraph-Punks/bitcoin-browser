import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import {
  MAX_OUTPUT_BYTES,
  PROCESS_DEADLINE_MS,
  STOCK_MODES,
  classifyCleanExit,
  classifyExperimentCompletion,
  classifyStockDiagnostic,
  classifyStockRun,
  createStockOutputCollector,
  hasExpectedRawTlsActivity,
  parseStockShutdownArgs,
  startRawTlsSink,
  stockMainSource,
  stockProbeHtml
} from '../scripts/diagnose-stock-network-shutdown.mjs';

function executeProbe(mode) {
  const operations = [];
  const timers = [];
  const logs = [];
  const html = stockProbeHtml(mode, 'https://127.0.0.1:43123');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const context = {
    console: { log: (value) => logs.push(value) },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout() {}, AbortController,
    fetch(url, options) { operations.push({ type: 'fetch', url, credentials: options.credentials }); return new Promise(() => {}); },
    WebSocket: class {
      constructor(url) { this.url = url; operations.push({ type: 'wss', url }); }
      close() {}
    }
  };
  vm.runInNewContext(script, context, { timeout: 1000 });
  return { operations, timers, logs };
}

test('CLI accepts only bounded reviewed modes, repeats, and optional absolute output', () => {
  assert.deepEqual(parseStockShutdownArgs([]), { modes: [...STOCK_MODES], repeat: 2, output: null });
  const parsed = parseStockShutdownArgs(['--mode=https,wss', '--repeat=1', '--output=fixture.json']);
  assert.deepEqual(parsed.modes, ['https', 'wss']);
  assert.equal(parsed.repeat, 1);
  assert.equal(pathIsAbsolute(parsed.output), true);
  for (const argv of [['--mode=idle'], ['--mode=https,https'], ['--mode='], ['--mode=https,'], ['--mode=https,,wss'], ['--repeat=0'], ['--repeat=6'], ['--output='], ['--repeat=1', '--repeat=2'], ['--unknown']]) {
    assert.throws(() => parseStockShutdownArgs(argv));
  }
});

function pathIsAbsolute(value) { return typeof value === 'string' && path.isAbsolute(value); }

test('raw TLS observation bounds reject invalid limits before opening a listener', async () => {
  for (const maxConnections of [0, 31, 129, 32.5, NaN, '32']) {
    await assert.rejects(startRawTlsSink({ maxConnections }), /observation limit/);
  }
});

test('fixture modes perform exactly one bounded operation with reviewed credentials semantics', () => {
  const https = executeProbe('https');
  assert.deepEqual(https.operations, [{ type: 'fetch', url: 'https://127.0.0.1:43123/probe', credentials: 'same-origin' }]);
  const include = executeProbe('https-include');
  assert.deepEqual(include.operations, [{ type: 'fetch', url: 'https://127.0.0.1:43123/probe', credentials: 'include' }]);
  const wss = executeProbe('wss');
  assert.deepEqual(wss.operations, [{ type: 'wss', url: 'wss://127.0.0.1:43123/probe' }]);
  for (const fixture of [https, include, wss]) {
    assert.equal(fixture.timers.length, 1);
    fixture.timers[0]();
    assert.deepEqual(fixture.logs, ['STOCK_PROBE_DONE:bounded-timeout']);
  }
});

test('fixture rejects non-loopback, credential-bearing, non-TLS, and unknown inputs', () => {
  for (const endpoint of ['https://example.com:443', 'http://127.0.0.1:443', 'https://user@127.0.0.1:443', 'https://127.0.0.1']) {
    assert.throws(() => stockProbeHtml('https', endpoint));
  }
  assert.throws(() => stockProbeHtml('other', 'https://127.0.0.1:443'));
});

test('stock main source preserves browser security and persistent-session boundaries', () => {
  const source = stockMainSource();
  assert.match(source, /app\.enableSandbox\(\)/);
  assert.match(source, /persist:stock-network-shutdown/);
  assert.match(source, /sandbox: true/);
  assert.match(source, /contextIsolation: true/);
  assert.match(source, /nodeIntegration: false/);
  assert.match(source, /webSecurity: true/);
  assert.match(source, /allowRunningInsecureContent: false/);
  assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /!loadComplete \|\| probeMarkers !== 1/);
  assert.match(source, /STOCK_LOAD_COMPLETE/);
  assert.match(source, /STOCK_QUIT_REQUESTED/);
  assert.match(source, /STOCK_PROBE_DUPLICATE/);
  assert.doesNotMatch(source, /arguments\[3\]/);
  assert.doesNotMatch(source, /certificate-error|setCertificateVerifyProc|safeStorage|cookies\.|keychain/i);
  assert.ok(PROCESS_DEADLINE_MS <= 12_000);
  assert.ok(MAX_OUTPUT_BYTES <= 65_536);
});

test('classification fails forced, signaled, nonzero, incomplete, and truncated runs', () => {
  const clean = {
    ready: true, loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected',
    closed: true, code: 0, signal: null, forced: false, spawnError: null, killError: null,
    outputTruncated: false, networkExpectationMet: true, rawTlsObservationOverflow: false, diagnostics: { recognizedCount: 0 }
  };
  assert.equal(classifyStockRun(clean), true);
  for (const change of [{ ready: false }, { loadCompleted: false }, { markerCount: 0 }, { markerCount: 2 }, { operationCompleted: false }, { closed: false }, { code: 1 }, { signal: 'SIGKILL' }, { forced: true }, { spawnError: 'EACCES' }, { killError: 'EPERM' }, { outputTruncated: true }, { rawTlsObservationOverflow: true }, { networkExpectationMet: false }, { diagnostics: { recognizedCount: 1 } }]) {
    assert.equal(classifyStockRun({ ...clean, ...change }), false);
  }
  assert.equal(classifyExperimentCompletion({ ...clean, outcome: 'bounded-timeout' }), false);
  assert.equal(classifyExperimentCompletion({ ...clean, outcome: 'thrown' }), false);
  assert.equal(classifyCleanExit(clean), true);
});

test('raw TLS activity is independent from renderer completion and requires observed ClientHello bytes', () => {
  const hello = [{ clientHello: true, bytes: 128 }];
  assert.equal(hasExpectedRawTlsActivity('rejected', hello), true);
  assert.equal(hasExpectedRawTlsActivity('opened', hello), true);
  assert.equal(hasExpectedRawTlsActivity('bounded-timeout', hello), false);
  assert.equal(hasExpectedRawTlsActivity('thrown', hello), false);
  assert.equal(hasExpectedRawTlsActivity(null, hello), false);
  assert.equal(hasExpectedRawTlsActivity('rejected', [{ clientHello: false, bytes: 128 }]), false);
});

async function mainFixture() {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  const stdout = [];
  const deferred = [];
  let resolveLoad;
  let quitCount = 0;
  const app = { enableSandbox() {}, whenReady: () => Promise.resolve(), quit: () => { quitCount++; }, exit() {} };
  vm.runInNewContext(stockMainSource(), {
    require: () => ({ app, session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }) },
      BrowserWindow: class {
        webContents = contents;
        loadFile() { return new Promise((resolve) => { resolveLoad = resolve; }); }
      }
    }),
    process: { stdout: { write: (line) => stdout.push(line) } },
    setImmediate: (callback) => deferred.push(callback),
    setTimeout: () => ({ unref() {} }), Date
  }, { timeout: 1000 });
  await Promise.resolve();
  return { contents, stdout, deferred, resolveLoad: () => resolveLoad(), quitCount: () => quitCount };
}

test('generated main handles the pinned single-object console event and both load/marker orders', async () => {
  for (const probeFirst of [true, false]) {
    const fixture = await mainFixture();
    const probe = () => fixture.contents.emit('console-message', { message: 'STOCK_PROBE_DONE:rejected' });
    const load = () => { fixture.contents.emit('did-finish-load'); fixture.resolveLoad(); };
    (probeFirst ? probe : load)();
    assert.equal(fixture.deferred.length, 0);
    (probeFirst ? load : probe)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.deferred.length, 1);
    assert.ok(fixture.stdout.includes('STOCK_READY\n'));
    assert.ok(fixture.stdout.includes('STOCK_PROBE_DONE:rejected\n'));
    fixture.deferred[0]();
    assert.equal(fixture.quitCount(), 1);
  }
});

test('generated main rejects duplicate markers before readiness and emits only normalized diagnostic kinds', async () => {
  const fixture = await mainFixture();
  fixture.contents.emit('console-message', { message: 'STOCK_PROBE_DONE:rejected' });
  fixture.contents.emit('console-message', { message: 'STOCK_PROBE_DONE:rejected' });
  fixture.contents.emit('did-finish-load'); fixture.resolveLoad();
  fixture.contents.emit('console-message', { message: 'binding.startupData is null PRIVATE_FIXTURE_TEXT' });
  fixture.contents.emit('preload-error', {}, '/private/fixture', new Error('PRIVATE_FIXTURE_TEXT'));
  await Promise.resolve();
  assert.equal(fixture.deferred.length, 0);
  assert.ok(fixture.stdout.includes('STOCK_PROBE_DUPLICATE\n'));
  assert.ok(fixture.stdout.includes('STOCK_DIAGNOSTIC:null-startup-data\n'));
  assert.ok(fixture.stdout.includes('STOCK_DIAGNOSTIC:preload-error\n'));
  assert.equal(fixture.stdout.some(line => line.includes('PRIVATE_FIXTURE_TEXT') || line.includes('/private/fixture')), false);
});

test('bounded output reports honest total bytes, truncation, and recognized diagnostics without raw retention', () => {
  const stream = new EventEmitter();
  const lines = [];
  const collector = createStockOutputCollector(stream, (line) => lines.push(line));
  const diagnostic = 'sandboxed_renderer.bundle.js script failed because binding.startupData was null';
  stream.emit('data', Buffer.from(`${diagnostic}\n`));
  stream.emit('data', Buffer.alloc(MAX_OUTPUT_BYTES, 120));
  assert.equal(classifyStockDiagnostic(lines[0]), 'sandboxed-renderer-startup');
  assert.equal(classifyStockDiagnostic('Unable to load preload script'), 'preload-error');
  assert.equal(classifyStockDiagnostic('Error occurred while loading preload script'), 'preload-error');
  assert.equal(classifyStockDiagnostic("TypeError binding.startupData is null"), 'null-startup-data');
  assert.equal(classifyStockDiagnostic('unrelated'), null);
  assert.equal(collector.totalBytes, Buffer.byteLength(`${diagnostic}\n`) + MAX_OUTPUT_BYTES);
  assert.equal(collector.retainedBytes, MAX_OUTPUT_BYTES);
  assert.equal(collector.truncated, true);
});

test('reviewed child close helper bounds late close and reports failed kills', async () => {
  const { waitForStartupChildClose } = await import('../scripts/startup-diagnostic-support.mjs');
  const errored = new EventEmitter();
  errored.exitCode = null; errored.signalCode = null; errored.kill = () => true;
  const errorResult = waitForStartupChildClose(errored, 100, 10);
  errored.emit('error', { code: 'ENOENT' });
  errored.emit('close', -2, null);
  assert.deepEqual(await errorResult, { closeConfirmed: true, code: -2, signal: null, forced: false, timedOut: false, spawnError: 'ENOENT', killError: null });

  const late = new EventEmitter();
  late.exitCode = null; late.signalCode = null;
  late.kill = () => { setTimeout(() => late.emit('close', null, 'SIGKILL'), 8); return true; };
  const closed = await waitForStartupChildClose(late, 2, 30);
  assert.equal(closed.closeConfirmed, true);
  assert.equal(closed.forced, true);

  const denied = new EventEmitter();
  denied.exitCode = null; denied.signalCode = null;
  denied.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  const uncertain = await waitForStartupChildClose(denied, 2, 3);
  assert.equal(uncertain.closeConfirmed, false);
  assert.equal(uncertain.killError, 'EPERM');
});
