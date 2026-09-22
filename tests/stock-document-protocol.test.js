import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  APP_DOCUMENT_URL,
  buildDocumentSchedule,
  parseDocumentEvidence,
  runStockDocumentProtocol,
  stockDocumentMainSource,
  summarizeDocumentReport
} from '../scripts/diagnose-stock-document-protocol.mjs';

async function executeGenerated(documentMode) {
  const order = [];
  const sessions = new Map();
  const stdout = [];
  let window;
  const app = { enableSandbox() { order.push('sandbox'); }, whenReady() { order.push('ready'); return Promise.resolve(); }, quit() {}, exit() {} };
  const protocol = { registerSchemesAsPrivileged(value) { order.push('scheme'); assert.equal(value[0].scheme, 'app'); } };
  const session = { fromPartition(partition) {
    const value = { handlers: {}, setPermissionCheckHandler(handler) { this.check = handler; },
      setPermissionRequestHandler(handler) { this.request = handler; }, protocol: { handle(scheme, handler) { value.handlers[scheme] = handler; } } };
    sessions.set(partition, value); return value;
  } };
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.getURL = () => this.url; window = this; }
    async loadFile(value) { this.url = pathToFileURL(path.join('/fixture', value)).href; this.webContents.emit('did-finish-load'); }
    async loadURL(value) { this.url = value; const response = await this.options.webPreferences.session.handlers.app(new Request(value)); assert.equal(await response.text(), '<main>fixture</main>'); this.webContents.emit('did-finish-load'); }
  }
  vm.runInNewContext(stockDocumentMainSource(documentMode), {
    require(name) {
      if (name === 'electron') return { app, BrowserWindow, session, protocol };
      if (name === 'node:fs/promises') return { readFile: async () => Buffer.from('<main>fixture</main>') };
      throw new Error(`unexpected require ${name}`);
    },
    process: { stdout: { write: (line) => stdout.push(line) } }, Response, Request,
    setImmediate() {}, setTimeout: () => ({ unref() {} }), Date
  }, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  return { order, sessions, stdout, window };
}

test('generated fixture registers scheme before readiness and binds named dual sessions with denied permissions', async () => {
  const fixture = await executeGenerated('file');
  assert.deepEqual(fixture.order.slice(0, 3), ['scheme', 'sandbox', 'ready']);
  assert.deepEqual([...fixture.sessions.keys()], ['persist:satoshi-browser-app', 'persist:satoshi-browser-wallet']);
  for (const value of fixture.sessions.values()) {
    assert.equal(value.check(), false);
    let allowed = true; value.request(null, null, (answer) => { allowed = answer; }); assert.equal(allowed, false);
  }
  assert.equal(fixture.window.options.show, false);
  assert.deepEqual({ ...fixture.window.options.webPreferences, session: undefined }, {
    session: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false
  });
  assert.ok(fixture.stdout.some((line) => line.includes('"documentMode":"file"') && line.includes('"documentRequests":0')));
});

test('app document handler has exact URL/method and Response body semantics', async () => {
  const fixture = await executeGenerated('app');
  const handler = fixture.sessions.get('persist:satoshi-browser-app').handlers.app;
  const head = await handler(new Request(APP_DOCUMENT_URL, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('<main>fixture</main>')));
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff'); assert.equal(head.headers.get('cache-control'), 'no-store');
  const missing = await handler(new Request('app://app/other.html'));
  assert.equal(missing.status, 404); assert.equal(await missing.text(), 'Not found');
  const method = await handler(new Request(APP_DOCUMENT_URL, { method: 'POST' }));
  assert.equal(method.status, 404); assert.equal(await method.text(), 'Not found');
  assert.ok(fixture.stdout.some((line) => line.includes('"documentMode":"app"') && line.includes('"documentRequests":1')));
});

test('document marker parsing requires exact mode, URL, counts, and one bounded line', () => {
  const fileUrl = 'file:///fixture/index.html';
  const valid = (mode, url, requests = mode === 'app' ? 1 : 0) => `STOCK_DOCUMENT_READY:${JSON.stringify({ documentMode: mode, url, documentRequests: requests, rejectedDocumentRequests: 0 })}`;
  assert.equal(parseDocumentEvidence(valid('file', fileUrl), 'file', fileUrl).url, fileUrl);
  assert.equal(parseDocumentEvidence(valid('app', APP_DOCUMENT_URL), 'app', fileUrl).url, APP_DOCUMENT_URL);
  const invalid = [
    ['', 'file'], ['STOCK_DOCUMENT_READY:{}', 'file'], ['STOCK_DOCUMENT_READY:{bad}', 'file'],
    [valid('file', fileUrl, 1), 'file'], [valid('app', APP_DOCUMENT_URL, 0), 'app'],
    [valid('file', `${fileUrl}x`), 'file'], [valid('app', `${APP_DOCUMENT_URL}x`), 'app'],
    [`STOCK_DOCUMENT_READY:${JSON.stringify({ documentMode: 'file', url: fileUrl, documentRequests: 0, rejectedDocumentRequests: 1 })}`, 'file'],
    [`${valid('file', fileUrl)}\n${valid('file', fileUrl)}`, 'file'], [`STOCK_DOCUMENT_READY:${'{'.repeat(9000)}`, 'file']
  ];
  for (const [line, mode] of invalid) assert.equal(parseDocumentEvidence(line, mode, fileUrl), null);
  const base = { config: { repeat: 1 }, runs: buildDocumentSchedule(1).map((item) => ({ ...cleanResult(item.documentMode, '/fixture'), ...item,
    documentValid: true, topologyValid: true, networkExpectationMet: true, rawTlsObservationOverflow: false })) , stoppedReason: null, failure: null };
  assert.equal(summarizeDocumentReport(base).complete, true);
  assert.equal(summarizeDocumentReport(base).passing, true);
  const duplicate = { ...base, runs: base.runs.map((run, index) => index === 0 ? { ...run, documentMarkerCount: 2, documentValid: false } : run) };
  assert.equal(summarizeDocumentReport(duplicate).complete, true);
  assert.equal(summarizeDocumentReport(duplicate).passing, false);
});

test('schedule is the exact alternating bounded twelve-row matrix', () => {
  const rows = buildDocumentSchedule(2);
  assert.equal(rows.length, 12);
  for (const mode of ['https', 'https-include', 'wss']) {
    assert.deepEqual(rows.filter((row) => row.mode === mode).map(({ run, documentMode }) => ({ run, documentMode })), [
      { run: 1, documentMode: 'file' }, { run: 1, documentMode: 'app' },
      { run: 2, documentMode: 'app' }, { run: 2, documentMode: 'file' }
    ]);
  }
  for (const value of [0, 3, 1.5]) assert.throws(() => buildDocumentSchedule(value));
});

function topologyMarker() {
  return 'STOCK_TOPOLOGY_READY:{"topology":"named-dual","partitions":["persist:satoshi-browser-app","persist:satoshi-browser-wallet"],"permissionDenied":true}';
}
function cleanResult(documentMode, appDirectory, overrides = {}) {
  const url = documentMode === 'app' ? APP_DOCUMENT_URL : pathToFileURL(path.join(appDirectory, 'index.html')).href;
  return { ready: true, topologyReady: topologyMarker(), topologyMarkerCount: 1,
    documentReady: `STOCK_DOCUMENT_READY:${JSON.stringify({ documentMode, url, documentRequests: documentMode === 'app' ? 1 : 0, rejectedDocumentRequests: 0 })}`,
    documentMarkerCount: 1, loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected', closed: true,
    code: 0, signal: null, forced: false, spawnError: null, killError: null, outputTruncated: false, diagnostics: { recognizedCount: 0 }, ...overrides };
}
function fakeSink() { return { endpoint: 'https://127.0.0.1:4443', connections: [], observationOverflow: false, close: async () => {} }; }

test('orchestrator denies failed preflight before fixture creation, sink, or child launch', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'document-preflight-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  let sink = 0; let launches = 0;
  const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 1 }, { platform: 'darwin',
    preflight: async () => { throw Object.assign(new Error('denied'), { code: 'PREFLIGHT_DENIED' }); },
    startSink: async () => { sink++; return fakeSink(); }, runChild: async () => { launches++; } });
  assert.equal(sink, 0); assert.equal(launches, 0); assert.equal(report.root, null); assert.equal(report.failure.code, 'PREFLIGHT_DENIED');
  assert.equal(JSON.parse(await fs.readFile(path.join(parent, 'report.json'), 'utf8')).summary.complete, false);
});

test('injected workflow reuses per-mode profiles, classifies failures, and stops on unknown close', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'document-run-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sink = fakeSink(); const profiles = []; let calls = 0;
  const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin',
    preflight: async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} }), startSink: async () => sink,
    runChild: async (_exe, appDirectory, profile) => {
      const item = buildDocumentSchedule(2)[calls++]; profiles.push(profile); sink.connections.push({ clientHello: true, bytes: 64 });
      return cleanResult(item.documentMode, appDirectory, calls === 3 ? { closed: false, forced: true, signal: 'SIGKILL' } : {});
    } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  assert.equal(calls, 3); assert.equal(report.stoppedReason, 'OWNED_PROCESS_CLOSE_UNCONFIRMED'); assert.equal(report.summary.complete, false);
  assert.equal(report.runs[2].passed, false); assert.equal(new Set(profiles).size, 2);
});

test('orchestrator stops after a closed child returns duplicate document evidence', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'document-marker-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sink = fakeSink(); let calls = 0;
  const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin',
    preflight: async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} }), startSink: async () => sink,
    runChild: async (_exe, appDirectory) => { calls++; sink.connections.push({ clientHello: true, bytes: 64 }); return cleanResult('file', appDirectory, { documentMarkerCount: 2 }); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  assert.equal(calls, 1); assert.equal(report.runs[0].closed, true);
  assert.equal(report.runs[0].documentValid, false); assert.equal(report.stoppedReason, 'DOCUMENT_OR_TOPOLOGY_EVIDENCE_INVALID');
  assert.equal(report.summary.complete, false); assert.equal(report.summary.passing, false);
});

test('complete injected workflow writes twelve passing rows and reuses each arm profile', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'document-success-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sink = fakeSink(); let calls = 0;
  const report = await runStockDocumentProtocol({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin',
    preflight: async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} }), startSink: async () => sink,
    runChild: async (_exe, appDirectory) => { const item = buildDocumentSchedule(2)[calls++]; sink.connections.push({ clientHello: true, bytes: 64 }); return cleanResult(item.documentMode, appDirectory); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  assert.equal(report.runs.length, 12); assert.equal(report.summary.complete, true); assert.equal(report.summary.passing, true);
  assert.equal(new Set(report.runs.map((run) => run.profile)).size, 6);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(parent, 'report.json'), 'utf8')).summary, report.summary);
});

test('report write fallback precedes release of callback-owned uncertain child and closes output', async () => {
  let closed = 0; const stderr = []; const events = []; const sink = fakeSink();
  const child = { pid: 9191, unref() { events.push('child-unref'); }, stdout: { unref() { events.push('stdout-unref'); } }, stderr: { unref() { events.push('stderr-unref'); } } };
  const io = { ...fs, open: async () => ({
    writeFile: async () => { throw Object.assign(new Error('disk full PRIVATE'), { code: 'ENOSPC' }); },
    sync: async () => {}, close: async () => { closed++; events.push('handle-close'); }
  }) };
  await assert.rejects(runStockDocumentProtocol({ output: '/fixture/new-report.json', repeat: 1 }, { platform: 'darwin', fs: io,
    preflight: async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} }), startSink: async () => sink,
    runChild: async (_exe, appDirectory, _profile, _mode, _run, handoff) => { handoff(child); sink.connections.push({ clientHello: true, bytes: 64 }); return cleanResult('file', appDirectory, { closed: false }); },
    stderr: { write: (line) => { stderr.push(line); events.push('fallback'); } } }), { code: 'ENOSPC' });
  assert.equal(closed, 1); assert.equal(stderr.length, 1); assert.match(stderr[0], /DOCUMENT_REPORT_FAILED/);
  const fallback = JSON.parse(stderr[0]);
  assert.equal(fallback.unknownPids[0], 9191); await fs.rm(fallback.retainedRoot, { recursive: true, force: true });
  assert.deepEqual(events, ['handle-close', 'fallback', 'child-unref', 'stdout-unref', 'stderr-unref']);
  assert.doesNotMatch(stderr[0], /disk full PRIVATE/);
});
