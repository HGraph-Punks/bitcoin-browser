import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  APP_DOCUMENT_URL,
  buildPreloadSchedule,
  parsePreloadEvidence,
  runStockDocumentProtocol,
  stockPreloadMainSource,
  stockPreloadProbeHtml
} from '../scripts/diagnose-stock-document-protocol.mjs';

const APPLICATION_PRELOAD = path.resolve('src/main/preload.cjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('actual application preload exposes the facade without invoking an IPC API', async () => {
  const source = await fs.readFile(APPLICATION_PRELOAD, 'utf8');
  const exposed = {}; const calls = [];
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } },
        ipcRenderer: { invoke(...args) { calls.push(['invoke', ...args]); }, on(...args) { calls.push(['on', ...args]); }, removeListener(...args) { calls.push(['remove', ...args]); } } };
    }
  }, { timeout: 1000 });
  assert.equal(typeof exposed.satBrowser.app.bootstrap, 'function');
  assert.equal(typeof exposed.satBrowser.wallet.signPsbt, 'function');
  assert.deepEqual(calls, []);
});

function executeProbe(preloadMode) {
  const logs = []; const operations = []; const timers = [];
  const window = preloadMode === 'application' ? { satBrowser: { app: { bootstrap() {} }, wallet: { signPsbt() {} } } } : {};
  const html = stockPreloadProbeHtml('https', 'https://127.0.0.1:4443');
  const source = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(source, { window, console: { log: (line) => logs.push(line) }, AbortController,
    fetch(url, options) { operations.push({ url, credentials: options.credentials }); return new Promise(() => {}); },
    WebSocket: class {}, setTimeout(callback) { timers.push(callback); return 1; }, clearTimeout() {}
  }, { timeout: 1000 });
  return { logs, operations, timers };
}

test('preload probe reports exact facade and Node-global absence before one bounded operation', () => {
  for (const mode of ['none', 'application']) {
    const fixture = executeProbe(mode);
    assert.equal(fixture.logs.length, 1);
    assert.ok(parsePreloadEvidence(fixture.logs[0], mode));
    assert.deepEqual(fixture.operations, [{ url: 'https://127.0.0.1:4443/probe', credentials: 'same-origin' }]);
    assert.equal(fixture.timers.length, 1);
  }
});

test('preload evidence parser rejects malformed, duplicate-line, wrong-shape, and Node-authority markers', () => {
  const marker = (value) => `STOCK_PRELOAD_READY:${JSON.stringify(value)}`;
  const application = { facadePresent: true, bootstrapFunction: true, signingFunction: true, nodeRequirePresent: false, nodeProcessPresent: false };
  assert.deepEqual(parsePreloadEvidence(marker(application), 'application'), application);
  const invalid = ['', 'STOCK_PRELOAD_READY:{bad}', `${marker(application)}\n${marker(application)}`,
    marker({ ...application, facadePresent: false }), marker({ ...application, bootstrapFunction: false }),
    marker({ ...application, signingFunction: false }), marker({ ...application, nodeRequirePresent: true }),
    marker({ ...application, nodeProcessPresent: true }), `STOCK_PRELOAD_READY:${'{'.repeat(9000)}`];
  for (const value of invalid) assert.equal(parsePreloadEvidence(value, 'application'), null);
  assert.equal(parsePreloadEvidence(marker(application), 'none'), null);
});

async function executeGeneratedMain(mode) {
  const stdout = []; let win;
  const persistent = { protocol: { handle(_scheme, handler) { persistent.handler = handler; } }, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.getURL = () => APP_DOCUMENT_URL; win = this; }
    async loadURL(url) { const response = await persistent.handler(new Request(url)); await response.text(); this.webContents.emit('did-finish-load'); }
  }
  vm.runInNewContext(stockPreloadMainSource(mode), { __dirname: '/fixture', Response, Request, Date,
    require(name) {
      if (name === 'electron') return { app: { enableSandbox() {}, whenReady: () => Promise.resolve(), quit() {}, exit() {} }, BrowserWindow,
        session: { fromPartition: () => persistent }, protocol: { registerSchemesAsPrivileged() {} } };
      if (name === 'node:fs/promises') return { readFile: async () => Buffer.from('fixture') };
      if (name === 'node:path') return path;
      throw new Error(`unexpected require ${name}`);
    }, process: { stdout: { write: (line) => stdout.push(line) } }, setImmediate() {}, setTimeout: () => ({ unref() {} })
  }, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  return { stdout, win };
}

test('generated main configures preload only for application arm and forwards only bounded preload markers', async () => {
  const application = stockPreloadMainSource('application'); const none = stockPreloadMainSource('none');
  assert.match(application, /preload: require\('node:path'\)\.join\(__dirname, 'preload\.cjs'\)/);
  assert.doesNotMatch(none, /preload:\s*require/);
  for (const source of [application, none]) {
    assert.match(source, /loadURL\(["']app:\/\/app\/renderer\/index\.html["']\)/);
    assert.match(source, /sandbox: true/); assert.match(source, /contextIsolation: true/); assert.match(source, /nodeIntegration: false/);
    assert.match(source, /\^STOCK_PRELOAD_READY/); assert.doesNotMatch(source, /loadFile\('index\.html'\)/);
  }
  const marker = 'STOCK_PRELOAD_READY:{"facadePresent":true}';
  const executed = await executeGeneratedMain('application');
  assert.equal(executed.win.options.webPreferences.preload, path.join('/fixture', 'preload.cjs'));
  executed.win.webContents.emit('console-message', { message: marker });
  executed.win.webContents.emit('console-message', { message: `STOCK_PRELOAD_READY:${'x'.repeat(5000)}` });
  assert.equal(executed.stdout.filter((line) => line === `${marker}\n`).length, 1);
  assert.equal(executed.stdout.some((line) => line.length > 4096), false);
  const noPreload = await executeGeneratedMain('none');
  assert.equal('preload' in noPreload.win.options.webPreferences, false);
  assert.throws(() => stockPreloadMainSource('other'));
});

test('preload schedule is exact alternating twelve rows and app-only documents', () => {
  const rows = buildPreloadSchedule(2);
  assert.equal(rows.length, 12); assert.ok(rows.every((row) => row.documentMode === 'app'));
  for (const mode of ['https', 'https-include', 'wss']) assert.deepEqual(
    rows.filter((row) => row.mode === mode).map(({ run, preloadMode }) => ({ run, preloadMode })),
    [{ run: 1, preloadMode: 'none' }, { run: 1, preloadMode: 'application' },
      { run: 2, preloadMode: 'application' }, { run: 2, preloadMode: 'none' }]);
});

const topologyReady = 'STOCK_TOPOLOGY_READY:{"topology":"named-dual","partitions":["persist:satoshi-browser-app","persist:satoshi-browser-wallet"],"permissionDenied":true}';
function resultFor(item, overrides = {}) {
  const preload = item.preloadMode === 'application';
  return { ready: true, topologyReady, topologyMarkerCount: 1,
    documentReady: `STOCK_DOCUMENT_READY:${JSON.stringify({ documentMode: 'app', url: APP_DOCUMENT_URL, documentRequests: 1, rejectedDocumentRequests: 0 })}`,
    documentMarkerCount: 1, preloadReady: `STOCK_PRELOAD_READY:${JSON.stringify({ facadePresent: preload, bootstrapFunction: preload,
      signingFunction: preload, nodeRequirePresent: false, nodeProcessPresent: false })}`, preloadMarkerCount: 1,
    loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected', closed: true, code: 0, signal: null,
    forced: false, spawnError: null, killError: null, outputTruncated: false, diagnostics: { recognizedCount: 0 }, ...overrides };
}
function sink() { return { endpoint: 'https://127.0.0.1:4443', connections: [], observationOverflow: false, close: async () => {} }; }
const preflight = async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} });

test('injected preload comparison copies exact source once and completes all twelve arms with reused profiles', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'preload-comparison-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const tls = sink(); let calls = 0;
  const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 2, comparison: 'preload' }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async () => { const item = buildPreloadSchedule(2)[calls++]; tls.connections.push({ clientHello: true, bytes: 64 }); return resultFor(item); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  const actual = await fs.readFile(APPLICATION_PRELOAD);
  assert.equal(report.applicationPreload.sha256, sha256(actual)); assert.equal(report.applicationPreload.bytes, actual.length);
  assert.equal(sha256(await fs.readFile(report.applicationPreload.copiedTo)), sha256(actual));
  assert.equal(report.runs.length, 12); assert.equal(report.summary.complete, true); assert.equal(report.summary.passing, true);
  assert.equal(new Set(report.runs.map((run) => run.profile)).size, 6);
});

test('missing, duplicate, or wrong-authority preload evidence stops after the first closed run', async (t) => {
  for (const override of [{ preloadMarkerCount: 0, preloadReady: null }, { preloadMarkerCount: 2 },
    { preloadReady: 'STOCK_PRELOAD_READY:{"facadePresent":false,"bootstrapFunction":false,"signingFunction":false,"nodeRequirePresent":true,"nodeProcessPresent":false}' }]) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'preload-invalid-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const tls = sink(); let calls = 0;
    const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 1, comparison: 'preload' }, { platform: 'darwin', preflight, startSink: async () => tls,
      runChild: async () => { calls++; tls.connections.push({ clientHello: true, bytes: 64 }); return resultFor(buildPreloadSchedule(1)[0], override); } });
    t.after(() => fs.rm(report.root, { recursive: true, force: true }));
    assert.equal(calls, 1); assert.equal(report.stoppedReason, 'PRELOAD_EVIDENCE_INVALID'); assert.equal(report.summary.passing, false);
  }
});

test('unsafe preload source is rejected before sink or child and bounded copy race is detected', async (t) => {
  for (const kind of ['symlink', 'nonregular', 'oversize', 'changed']) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'preload-source-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
    let started = 0; const real = await fs.readFile(APPLICATION_PRELOAD); let sourceReads = 0;
    const io = { ...fs,
      lstat: async (target) => target === APPLICATION_PRELOAD ? {
        isFile: () => kind !== 'nonregular', isSymbolicLink: () => kind === 'symlink', size: kind === 'oversize' ? 65537 : real.length
      } : fs.lstat(target),
      readFile: async (target, ...args) => {
        if (target !== APPLICATION_PRELOAD) return fs.readFile(target, ...args);
        sourceReads++; return kind === 'changed' ? Buffer.concat([real, Buffer.from('x')]) : real;
      }
    };
    const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 1, comparison: 'preload' }, { platform: 'darwin', fs: io, preflight,
      startSink: async () => { started++; return sink(); }, runChild: async () => { started++; } });
    if (report.root) { const ownedRoot = report.root; t.after(() => fs.rm(ownedRoot, { recursive: true, force: true })); }
    assert.equal(started, 0); assert.ok(report.failure); assert.equal(report.summary.complete, false);
    if (kind !== 'changed') assert.equal(sourceReads, 0);
  }
});

test('unconfirmed close stops profile reuse and retains normalized report evidence', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'preload-close-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const tls = sink(); let calls = 0; const child = { pid: 8181, unref() {}, stdout: { unref() {} }, stderr: { unref() {} } };
  const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 2, comparison: 'preload' }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async (_exe, _app, _profile, _mode, _run, handoff) => { calls++; handoff(child); tls.connections.push({ clientHello: true, bytes: 64 }); return resultFor(buildPreloadSchedule(2)[0], { closed: false }); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  assert.equal(calls, 1); assert.equal(report.stoppedReason, 'OWNED_PROCESS_CLOSE_UNCONFIRMED'); assert.equal(report.summary.complete, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(parent, 'report.json'), 'utf8')).runs[0].pid, undefined);
});
