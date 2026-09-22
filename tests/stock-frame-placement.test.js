import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { APP_DOCUMENT_URL } from '../scripts/diagnose-stock-document-protocol.mjs';
import {
  FRAME_PLACEMENTS,
  ORD_DOCUMENT_URL,
  buildFrameSchedule,
  parseFrameEvidence,
  parseProbeSourceEvidence,
  runStockFramePlacement,
  stockFrameDocuments,
  stockFrameMainSource,
  summarizeFrameReport
} from '../scripts/diagnose-stock-frame-placement.mjs';

function frameMarker(placement, overrides = {}) {
  const child = placement === 'opaque-child';
  return `STOCK_FRAME_READY:${JSON.stringify({ placement, route: child ? ORD_DOCUMENT_URL : APP_DOCUMENT_URL,
    relaySourceId: APP_DOCUMENT_URL, sourceBound: true, opaqueOrigin: child, facadePresent: !child,
    nodeRequirePresent: false, nodeProcessPresent: false, ordRequests: child ? 1 : 0, rejectedOrdRequests: 0,
    ...(child ? { sandbox: 'allow-scripts allow-forms allow-modals allow-pointer-lock', referrerPolicy: 'no-referrer' } : {}), ...overrides })}`;
}

test('frame evidence requires exact route, source binding, opacity, authority, attributes, and request counts', () => {
  for (const placement of FRAME_PLACEMENTS) assert.ok(parseFrameEvidence(frameMarker(placement), placement));
  const mutations = [{ sourceBound: false }, { relaySourceId: 'ord://content/other' }, { route: 'ord://content/other' },
    { nodeRequirePresent: true }, { nodeProcessPresent: true }, { rejectedOrdRequests: 1 }, { ordRequests: 7 }, { opaqueOrigin: false }];
  for (const change of mutations) assert.equal(parseFrameEvidence(frameMarker('opaque-child', change), 'opaque-child'), null);
  assert.equal(parseFrameEvidence(frameMarker('opaque-child', { sandbox: 'allow-scripts' }), 'opaque-child'), null);
  assert.equal(parseFrameEvidence(`${frameMarker('top')}\n${frameMarker('top')}`, 'top'), null);
  assert.equal(parseFrameEvidence('STOCK_FRAME_READY:{bad}', 'top'), null);
  assert.ok(parseProbeSourceEvidence(`STOCK_PROBE_SOURCE:{"sourceId":"${APP_DOCUMENT_URL}"}`, 'top'));
  assert.ok(parseProbeSourceEvidence(`STOCK_PROBE_SOURCE:{"sourceId":"${ORD_DOCUMENT_URL}"}`, 'opaque-child'));
  assert.equal(parseProbeSourceEvidence(`STOCK_PROBE_SOURCE:{"sourceId":"${APP_DOCUMENT_URL}"}`, 'opaque-child'), null);
});

test('schedule alternates the exact twelve top/opaque-child rows with profile reuse identities', () => {
  const rows = buildFrameSchedule(2); assert.equal(rows.length, 12);
  for (const mode of ['https', 'https-include', 'wss']) assert.deepEqual(rows.filter((row) => row.mode === mode).map(({ run, placement }) => ({ run, placement })), [
    { run: 1, placement: 'top' }, { run: 1, placement: 'opaque-child' },
    { run: 2, placement: 'opaque-child' }, { run: 2, placement: 'top' }
  ]);
  for (const repeat of [0, 3, 1.5]) assert.throws(() => buildFrameSchedule(repeat));
});

test('document factories preserve one top probe and relay every valid or wrong-source matching-token child message', () => {
  const top = stockFrameDocuments('top', 'https', 'https://127.0.0.1:4443');
  assert.match(top.indexHtml, /STOCK_FRAME_CLIENT/); assert.match(top.indexHtml, /fetch\(endpoint/); assert.doesNotMatch(top.indexHtml, /<iframe/);
  const child = stockFrameDocuments('opaque-child', 'wss', 'https://127.0.0.1:4443');
  assert.match(child.indexHtml, new RegExp(`src="${ORD_DOCUMENT_URL}"`));
  assert.match(child.indexHtml, /sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock"/);
  assert.match(child.indexHtml, /referrerpolicy="no-referrer"/); assert.doesNotMatch(child.indexHtml, /new WebSocket/);
  assert.match(child.childHtml, /new WebSocket/); assert.match(child.childHtml, /parent\.postMessage/);
  assert.match(child.indexHtml, /event\.source !== frame\.contentWindow/); assert.doesNotMatch(child.indexHtml, /once:\s*true/);
  const script = child.indexHtml.match(/<script>([\s\S]*)<\/script>/)[1]; const logs = []; let listener;
  const ownedSource = {}; const frame = { contentWindow: ownedSource, getAttribute: () => 'allow-scripts allow-forms allow-modals allow-pointer-lock', referrerPolicy: 'no-referrer' };
  vm.runInNewContext(script, { window: { satBrowser: { app: { bootstrap() {} }, wallet: { signPsbt() {} } }, addEventListener(_name, callback) { listener = callback; } },
    document: { querySelector: () => frame }, console: { log: (line) => logs.push(line) } }, { timeout: 1000 });
  const data = { token: 'stock-owned-frame-ready', route: ORD_DOCUMENT_URL, facadePresent: false, nodeRequirePresent: false, nodeProcessPresent: false };
  listener({ source: {}, data, origin: 'null' }); listener({ source: ownedSource, data, origin: 'null' }); listener({ source: ownedSource, data, origin: 'null' });
  const relays = logs.filter((line) => line.startsWith('STOCK_FRAME_CLIENT:')).map((line) => JSON.parse(line.slice('STOCK_FRAME_CLIENT:'.length)));
  assert.deepEqual(relays.map((value) => value.sourceBound), [false, true, true]);
});

async function executeMain() {
  const stdout = []; const sessions = []; const deferred = []; let win; let quitCount = 0;
  const persistent = { handlers: {}, protocol: { handle(scheme, handler) { persistent.handlers[scheme] = handler; } },
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.getURL = () => APP_DOCUMENT_URL; win = this; }
    async loadURL(url) { await (await persistent.handlers.app(new Request(url))).text(); this.webContents.emit('did-finish-load'); }
  }
  vm.runInNewContext(stockFrameMainSource(), { __dirname: '/fixture', Request, Response, Date,
    require(name) {
      if (name === 'electron') return { app: { enableSandbox() {}, whenReady: () => Promise.resolve(), quit() { quitCount++; }, exit() {} }, BrowserWindow,
        session: { fromPartition(partition) { sessions.push(partition); return persistent; } }, protocol: { registerSchemesAsPrivileged(value) { assert.equal(JSON.stringify(value.map((item) => item.scheme)), '["app","ord"]'); } } };
      if (name === 'node:path') return path;
      if (name === 'node:fs/promises') return { readFile: async (name) => Buffer.from(name === 'child.html' ? 'child' : 'index') };
      throw new Error(`unexpected ${name}`);
    }, process: { stdout: { write: (line) => stdout.push(line) } }, setImmediate(callback) { deferred.push(callback); }, setTimeout: () => ({ unref() {} })
  }, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve)); return { stdout, sessions, persistent, win, deferred, quitCount: () => quitCount };
}

test('generated main installs both protocols, application preload and product-compatible ord Response', async () => {
  const fixture = await executeMain(); assert.deepEqual(fixture.sessions, ['persist:satoshi-browser-app', 'persist:satoshi-browser-wallet']);
  assert.equal(fixture.win.options.webPreferences.preload, path.join('/fixture', 'preload.cjs'));
  const response = await fixture.persistent.handlers.ord(new Request(ORD_DOCUMENT_URL));
  assert.equal(await response.text(), 'child'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-security-policy'), /connect-src[^;]*https: wss:/);
  assert.match(response.headers.get('permissions-policy'), /publickey-credentials-get=\(\)/);
  const denied = await fixture.persistent.handlers.ord(new Request('ord://content/other'));
  assert.equal(denied.status, 404);
  fixture.win.webContents.emit('console-message', { message: 'STOCK_PROBE_DONE:rejected', sourceId: APP_DOCUMENT_URL });
  fixture.win.webContents.emit('console-message', { message: preload, sourceId: APP_DOCUMENT_URL });
  assert.equal(fixture.deferred.length, 0);
  fixture.win.webContents.emit('console-message', { message: 'STOCK_FRAME_CLIENT:{"placement":"top","route":"app://app/renderer/index.html","sourceBound":true,"opaqueOrigin":false,"facadePresent":true,"nodeRequirePresent":false,"nodeProcessPresent":false}', sourceId: APP_DOCUMENT_URL });
  assert.equal(fixture.deferred.length, 1); fixture.deferred[0](); assert.equal(fixture.quitCount(), 1);
  assert.ok(fixture.stdout.includes(`STOCK_PROBE_SOURCE:{"sourceId":"${APP_DOCUMENT_URL}"}\n`));
  assert.ok(fixture.stdout.some((line) => line.startsWith('STOCK_FRAME_READY:') && line.includes(`"relaySourceId":"${APP_DOCUMENT_URL}"`)));
});

const topology = 'STOCK_TOPOLOGY_READY:{"topology":"named-dual","partitions":["persist:satoshi-browser-app","persist:satoshi-browser-wallet"],"permissionDenied":true}';
const preload = 'STOCK_PRELOAD_READY:{"facadePresent":true,"bootstrapFunction":true,"signingFunction":true,"nodeRequirePresent":false,"nodeProcessPresent":false}';
function clean(item, overrides = {}) {
  return { ready: true, topologyReady: topology, topologyMarkerCount: 1,
    documentReady: 'STOCK_DOCUMENT_READY:{"documentMode":"app","url":"app://app/renderer/index.html","documentRequests":1,"rejectedDocumentRequests":0}', documentMarkerCount: 1,
    preloadReady: preload, preloadMarkerCount: 1, frameReady: frameMarker(item.placement), frameMarkerCount: 1,
    probeSourceReady: `STOCK_PROBE_SOURCE:${JSON.stringify({ sourceId: item.placement === 'opaque-child' ? ORD_DOCUMENT_URL : APP_DOCUMENT_URL })}`, probeSourceMarkerCount: 1,
    loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected', closed: true, code: 0, signal: null,
    forced: false, spawnError: null, killError: null, outputTruncated: false, diagnostics: { recognizedCount: 0 }, ...overrides };
}
const preflight = async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} });
function sink() { return { endpoint: 'https://127.0.0.1:4443', connections: [], observationOverflow: false, close: async () => {} }; }

test('injected runner completes exact matrix and preserves distinct placement profile reuse', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-run-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const tls = sink(); let calls = 0;
  const report = await runStockFramePlacement({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async () => { const item = buildFrameSchedule(2)[calls++]; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(item); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  assert.equal(report.runs.length, 12); assert.equal(report.summary.complete, true); assert.equal(report.summary.passing, true);
  assert.equal(new Set(report.runs.map((run) => run.profile)).size, 6);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(parent, 'report.json'), 'utf8')).summary, report.summary);
});

test('missing, duplicate, malformed, and wrong-source frame markers stop before profile reuse', async (t) => {
  for (const override of [{ frameMarkerCount: 0, frameReady: null }, { frameMarkerCount: 2 }, { frameReady: 'STOCK_FRAME_READY:{bad}' },
    { frameReady: frameMarker('top', { relaySourceId: ORD_DOCUMENT_URL }) }, { probeSourceReady: `STOCK_PROBE_SOURCE:{"sourceId":"${ORD_DOCUMENT_URL}"}` }]) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-invalid-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const tls = sink(); let calls = 0;
    const report = await runStockFramePlacement({ output: path.join(parent, 'report.json'), repeat: 1 }, { platform: 'darwin', preflight, startSink: async () => tls,
      runChild: async () => { calls++; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(buildFrameSchedule(1)[0], override); } });
    t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 1);
    assert.equal(report.stoppedReason, 'FRAME_EVIDENCE_INVALID'); assert.equal(report.summary.passing, false);
  }
});

test('unconfirmed child closure stops the schedule and remains incomplete', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-close-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const tls = sink(); let calls = 0; const child = { unref() {}, stdout: { unref() {} }, stderr: { unref() {} } };
  const report = await runStockFramePlacement({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async (_e, _a, _p, _m, _r, handoff) => { calls++; handoff(child); tls.connections.push({ clientHello: true, bytes: 64 }); return clean(buildFrameSchedule(2)[0], { closed: false }); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 1);
  assert.equal(report.stoppedReason, 'OWNED_PROCESS_CLOSE_UNCONFIRMED'); assert.equal(report.summary.complete, false);
});

test('summary rejects otherwise clean rows with reordered identity or invalid frame evidence', () => {
  const runs = buildFrameSchedule(1).map((item) => ({ ...clean(item), ...item, frameValid: true, probeSourceValid: true, preloadValid: true, documentValid: true, topologyValid: true,
    networkExpectationMet: true, rawTlsObservationOverflow: false }));
  const base = { config: { repeat: 1 }, runs, failure: null, stoppedReason: null };
  assert.equal(summarizeFrameReport(base).passing, true);
  assert.equal(summarizeFrameReport({ ...base, runs: [{ ...runs[0], placement: 'opaque-child' }, ...runs.slice(1)] }).complete, false);
  assert.equal(summarizeFrameReport({ ...base, runs: [{ ...runs[0], frameValid: false }, ...runs.slice(1)] }).passing, false);
});
