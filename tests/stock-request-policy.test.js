import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { APP_DOCUMENT_URL } from '../scripts/diagnose-stock-document-protocol.mjs';
import { ORD_DOCUMENT_URL } from '../scripts/diagnose-stock-frame-placement.mjs';
import {
  LEGACY_REQUEST_FILTER,
  REQUEST_FILTER_MODES,
  REQUEST_POLICY_MODES,
  buildRequestPolicySchedule,
  parseRequestPolicyEvidence,
  parseRequestPolicyArgs,
  requestFilterEvidence,
  requestPolicySourceEvidence,
  runStockRequestPolicy,
  stockRequestPolicyMainSource,
  summarizeRequestPolicyReport
} from '../scripts/diagnose-stock-request-policy.mjs';
import { CONTENT_NETWORK_REQUEST_FILTER } from '../src/main/content-network-policy.js';

const endpoint = 'https://127.0.0.1:4443';
function policyMarker(policyMode, mode, overrides = {}) {
  const present = policyMode === 'present';
  return `STOCK_REQUEST_POLICY:${JSON.stringify({ policyMode, handlerInstalled: present, targetCalls: present ? 1 : 0,
    observations: present ? [{ scheme: mode === 'wss' ? 'wss:' : 'https:', resourceType: mode === 'wss' ? 'webSocket' : 'xhr', allowed: true }] : [],
    observationOverflow: false, unexpectedExternalCount: 0, ...overrides })}`;
}

test('policy marker strictly distinguishes observed coverage from absent and malformed evidence', () => {
  for (const mode of ['https', 'https-include', 'wss']) for (const policyMode of REQUEST_POLICY_MODES) assert.ok(parseRequestPolicyEvidence(policyMarker(policyMode, mode), policyMode, mode));
  for (const change of [{ targetCalls: 0 }, { observations: [] }, { observations: [{ scheme: 'https:', resourceType: 'xhr', allowed: false }] },
    { unexpectedExternalCount: 1 }, { observationOverflow: true }]) assert.equal(parseRequestPolicyEvidence(policyMarker('present', 'https', change), 'present', 'https'), null);
  assert.equal(parseRequestPolicyEvidence(policyMarker('present', 'https'), 'present', 'wss'), null);
  for (const resourceType of ['', 'other', 'mainFrame', 'webSocket']) {
    assert.equal(parseRequestPolicyEvidence(policyMarker('present', 'https', { observations: [{ scheme: 'https:', resourceType, allowed: true }] }), 'present', 'https'), null);
  }
  assert.equal(parseRequestPolicyEvidence(policyMarker('present', 'wss', { observations: [{ scheme: 'wss:', resourceType: 'xhr', allowed: true }] }), 'present', 'wss'), null);
  assert.equal(parseRequestPolicyEvidence(`${policyMarker('present', 'https')}\n${policyMarker('present', 'https')}`, 'present', 'https'), null);
});

test('generated policy closure retains the exact reviewed production internal-scheme binding', async () => {
  const production = await fs.readFile(new URL('../src/main/content-network-policy.js', import.meta.url), 'utf8');
  const binding = "const INTERNAL_SCHEMES = new Set(['app:', 'ord:', 'data:', 'blob:', 'devtools:']);";
  assert.equal(production.split(binding).length, 2, 'production policy dependency changed; review fixture before execution');
  for (const policyMode of REQUEST_POLICY_MODES) {
    const generated = stockRequestPolicyMainSource(policyMode, 'https', endpoint);
    assert.equal(generated.split(binding).length, 2);
  }
});

test('legacy factory bytes stay default while production variant embeds the exact shared filter', () => {
  assert.deepEqual(REQUEST_FILTER_MODES, ['legacy', 'production']);
  assert.deepEqual(LEGACY_REQUEST_FILTER, { urls: ['*://*/*'] });
  const implicit = stockRequestPolicyMainSource('present', 'wss', endpoint);
  const legacy = stockRequestPolicyMainSource('present', 'wss', endpoint, 'legacy');
  assert.equal(implicit, legacy);
  assert.match(legacy, /onBeforeRequest\(\{ urls: \['\*:\/\/\*\/\*'\] \},/);
  const production = stockRequestPolicyMainSource('present', 'wss', endpoint, 'production');
  assert.match(production, new RegExp(`onBeforeRequest\\(${JSON.stringify(CONTENT_NETWORK_REQUEST_FILTER).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.notEqual(production, legacy);
  assert.deepEqual(requestFilterEvidence.production.urls, CONTENT_NETWORK_REQUEST_FILTER.urls);
});

test('CLI parser defaults legacy and rejects duplicate, empty, and unknown options', () => {
  assert.deepEqual(parseRequestPolicyArgs(['--output=/tmp/report.json']), { output: '/tmp/report.json', requestFilter: 'legacy' });
  assert.deepEqual(parseRequestPolicyArgs(['--request-filter=production', '--output=/tmp/report.json']), { output: '/tmp/report.json', requestFilter: 'production' });
  for (const args of [[], ['--output='], ['--output=/a', '--output=/b'], ['--output=/a', '--request-filter=unknown'], ['--output=/a', '--unknown=x']]) {
    assert.throws(() => parseRequestPolicyArgs(args), /Usage:/);
  }
  assert.throws(() => stockRequestPolicyMainSource('present', 'https', endpoint, 'unknown'), /Unknown request filter mode/);
  assert.throws(() => runStockRequestPolicy({ output: '/tmp/not-used', requestFilter: 'unknown' }, {}), /Unknown request filter mode/);
});

test('schedule alternates absent/present across exact twelve opaque-child rows', () => {
  const rows = buildRequestPolicySchedule(2); assert.equal(rows.length, 12); assert.ok(rows.every((row) => row.placement === 'opaque-child'));
  for (const mode of ['https', 'https-include', 'wss']) assert.deepEqual(rows.filter((row) => row.mode === mode).map(({ run, policyMode }) => ({ run, policyMode })), [
    { run: 1, policyMode: 'absent' }, { run: 1, policyMode: 'present' }, { run: 2, policyMode: 'present' }, { run: 2, policyMode: 'absent' }
  ]);
});

async function executeMain(policyMode, mode, requestFilter = 'legacy') {
  const stdout = []; const sessions = []; const app = new EventEmitter(); Object.assign(app, { enableSandbox() {}, whenReady: () => Promise.resolve(), quit() {}, exit() {} });
  let win; const makeSession = () => { const value = { handlers: {}, protocol: { handle(scheme, handler) { value.handlers[scheme] = handler; } },
    webRequest: { onBeforeRequest(filter, handler) { value.filter = filter; value.beforeRequest = handler; } }, fetch() {}, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }; sessions.push(value); return value; };
  class BrowserWindow { constructor(options) { this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.getURL = () => APP_DOCUMENT_URL; win = this; }
    async loadURL(url) { await (await sessions[0].handlers.app(new Request(url))).text(); this.webContents.emit('did-finish-load'); } }
  vm.runInNewContext(stockRequestPolicyMainSource(policyMode, mode, endpoint, requestFilter), { __dirname: '/fixture', Request, Response, URL, Date,
    require(name) {
      if (name === 'electron') return { app, BrowserWindow, session: { fromPartition: () => makeSession() }, protocol: { registerSchemesAsPrivileged() {} } };
      if (name === 'node:path') return path; if (name === 'node:fs/promises') return { readFile: async (name) => Buffer.from(name) }; throw new Error(`unexpected ${name}`);
    }, process: { stdout: { write: (line) => stdout.push(line) } }, setImmediate() {}, setTimeout: () => ({ unref() {} })
  }, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve)); return { stdout, sessions, app, win };
}

test('generated present callback runs exact production decision and measures target without retaining URLs', async () => {
  const fixture = await executeMain('present', 'https'); const session = fixture.sessions[0]; assert.equal(JSON.stringify(session.filter), '{"urls":["*://*/*"]}');
  let decision; session.beforeRequest({ url: `${endpoint}/probe`, resourceType: 'xhr' }, (value) => { decision = value; }); assert.deepEqual({ ...decision }, { cancel: false });
  session.beforeRequest({ url: 'http://example.invalid/unowned-secret-path', resourceType: 'xhr' }, () => {});
  fixture.app.emit('before-quit'); const line = fixture.stdout.find((value) => value.startsWith('STOCK_REQUEST_POLICY:'));
  const raw = JSON.parse(line.slice('STOCK_REQUEST_POLICY:'.length)); assert.equal(raw.targetCalls, 1); assert.equal(raw.unexpectedExternalCount, 1);
  assert.equal(line.includes('example.invalid'), false); assert.equal(line.includes('unowned-secret-path'), false);
  const wss = await executeMain('present', 'wss'); let wssDecision;
  wss.sessions[0].beforeRequest({ url: 'wss://127.0.0.1:4443/probe', resourceType: 'webSocket' }, (value) => { wssDecision = value; });
  assert.deepEqual({ ...wssDecision }, { cancel: false }); wss.app.emit('before-quit');
  assert.ok(parseRequestPolicyEvidence(wss.stdout.find((value) => value.startsWith('STOCK_REQUEST_POLICY:')).trim(), 'present', 'wss'));
  const absent = await executeMain('absent', 'wss'); assert.equal(absent.sessions[0].beforeRequest, undefined); absent.app.emit('before-quit');
  const absentLine = absent.stdout.find((value) => value.startsWith('STOCK_REQUEST_POLICY:'));
  assert.ok(parseRequestPolicyEvidence(absentLine.trim(), 'absent', 'wss'), absentLine);
  assert.equal(fixture.win.options.webPreferences.session, session);
});

test('generated production variant registers the exact shared filter and observes WSS', async () => {
  const fixture = await executeMain('present', 'wss', 'production');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.sessions[0].filter)), CONTENT_NETWORK_REQUEST_FILTER);
  let decision;
  fixture.sessions[0].beforeRequest({ url: 'wss://127.0.0.1:4443/probe', resourceType: 'webSocket' }, (value) => { decision = value; });
  assert.deepEqual({ ...decision }, { cancel: false });
  fixture.app.emit('before-quit');
  assert.ok(parseRequestPolicyEvidence(fixture.stdout.find((value) => value.startsWith('STOCK_REQUEST_POLICY:')).trim(), 'present', 'wss'));
});

function frameMarker() { return `STOCK_FRAME_READY:${JSON.stringify({ placement: 'opaque-child', route: ORD_DOCUMENT_URL, relaySourceId: APP_DOCUMENT_URL, sourceBound: true,
  opaqueOrigin: true, facadePresent: false, nodeRequirePresent: false, nodeProcessPresent: false, ordRequests: 1, rejectedOrdRequests: 0,
  sandbox: 'allow-scripts allow-forms allow-modals allow-pointer-lock', referrerPolicy: 'no-referrer' })}`; }
const topology = 'STOCK_TOPOLOGY_READY:{"topology":"named-dual","partitions":["persist:satoshi-browser-app","persist:satoshi-browser-wallet"],"permissionDenied":true}';
const preload = 'STOCK_PRELOAD_READY:{"facadePresent":true,"bootstrapFunction":true,"signingFunction":true,"nodeRequirePresent":false,"nodeProcessPresent":false}';
const wallet = 'STOCK_WALLET_REGISTRATION:{"registrationMode":"present","handlerInstalled":true,"walletHandlerInvocations":0,"sessionCount":2,"distinctSessions":true,"partitions":["persist:satoshi-browser-app","persist:satoshi-browser-wallet"],"browserWindowCount":1}';
function clean(item, overrides = {}) { return { ready: true, topologyReady: topology, topologyMarkerCount: 1,
  documentReady: 'STOCK_DOCUMENT_READY:{"documentMode":"app","url":"app://app/renderer/index.html","documentRequests":1,"rejectedDocumentRequests":0}', documentMarkerCount: 1,
  preloadReady: preload, preloadMarkerCount: 1, frameReady: frameMarker(), frameMarkerCount: 1, probeSourceReady: `STOCK_PROBE_SOURCE:{"sourceId":"${ORD_DOCUMENT_URL}"}`, probeSourceMarkerCount: 1,
  walletRegistrationReady: wallet, walletRegistrationMarkerCount: 1, requestPolicyReady: policyMarker(item.policyMode, item.mode), requestPolicyMarkerCount: 1,
  loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected', closed: true, code: 0, signal: null, forced: false,
  spawnError: null, killError: null, outputTruncated: false, diagnostics: { recognizedCount: 0 }, ...overrides }; }
const preflight = async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} });
function sink() { return { endpoint, connections: [], observationOverflow: false, close: async () => {} }; }

test('injected matrix completes twelve rows with six reused profiles and policy source provenance', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'request-policy-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
  const report = await runStockRequestPolicy({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async () => { const item = buildRequestPolicySchedule(2)[calls++]; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(item); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(report.runs.length, 12); assert.equal(report.summary.passing, true);
  assert.equal(report.summary.policyCallbacksObserved, 6); assert.equal(new Set(report.runs.map((run) => run.profile)).size, 6);
  assert.deepEqual(report.config.policySource, requestPolicySourceEvidence);
  assert.equal(report.config.requestFilterMode, 'legacy');
  assert.deepEqual(report.config.requestFilter, requestFilterEvidence.legacy);
});

test('production-filter matrix records exact shared URLs and digest', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'request-policy-production-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
  const report = await runStockRequestPolicy({ output: path.join(parent, 'report.json'), repeat: 1, requestFilter: 'production' }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async () => { const item = buildRequestPolicySchedule(1)[calls++]; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(item); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(report.summary.passing, true);
  assert.equal(report.config.requestFilterMode, 'production');
  assert.deepEqual(report.config.requestFilter, requestFilterEvidence.production);
  assert.deepEqual(report.config.requestFilter.urls, ['*://*/*', 'ws://*/*', 'wss://*/*']);
});

test('present missing callback coverage, duplicate marker, unexpected request, and wrong scheme fail-stop', async (t) => {
  const overrides = [{ requestPolicyReady: policyMarker('present', 'https', { targetCalls: 0, observations: [] }) }, { requestPolicyMarkerCount: 2 },
    { requestPolicyReady: policyMarker('present', 'https', { unexpectedExternalCount: 1 }) }, { requestPolicyReady: policyMarker('present', 'wss') }];
  for (const override of overrides) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'request-policy-invalid-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
    const schedule = buildRequestPolicySchedule(1);
    const report = await runStockRequestPolicy({ output: path.join(parent, 'report.json'), repeat: 1 }, { platform: 'darwin', preflight, startSink: async () => tls,
      runChild: async () => { const item = schedule[calls++]; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(item, calls === 2 ? override : {}); } });
    t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 2); assert.equal(report.stoppedReason, 'REQUEST_POLICY_EVIDENCE_INVALID'); assert.equal(report.summary.passing, false);
  }
});

test('unconfirmed close stops schedule and persists incomplete report', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'request-policy-close-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
  const child = { unref() {}, stdout: { unref() {} }, stderr: { unref() {} } };
  const report = await runStockRequestPolicy({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async (_e, _a, _p, _m, _r, handoff) => { calls++; handoff(child); tls.connections.push({ clientHello: true, bytes: 64 }); return clean(buildRequestPolicySchedule(2)[0], { closed: false }); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 1); assert.equal(report.stoppedReason, 'OWNED_PROCESS_CLOSE_UNCONFIRMED');
  assert.equal(JSON.parse(await fs.readFile(path.join(parent, 'report.json'), 'utf8')).summary.complete, false);
});

test('summary independently rejects identity reorder and policy invalidity', () => {
  const runs = buildRequestPolicySchedule(1).map((item) => ({ ...clean(item), ...item, requestPolicyValid: true, walletRegistrationValid: true,
    frameValid: true, probeSourceValid: true, preloadValid: true, documentValid: true, topologyValid: true, networkExpectationMet: true, rawTlsObservationOverflow: false,
    requestPolicyEvidence: parseRequestPolicyEvidence(policyMarker(item.policyMode, item.mode), item.policyMode, item.mode) }));
  const report = { config: { repeat: 1 }, runs, stoppedReason: null, failure: null }; assert.equal(summarizeRequestPolicyReport(report).passing, true);
  assert.equal(summarizeRequestPolicyReport({ ...report, runs: [{ ...runs[0], policyMode: 'present' }, ...runs.slice(1)] }).complete, false);
  assert.equal(summarizeRequestPolicyReport({ ...report, runs: [{ ...runs[0], requestPolicyValid: false }, ...runs.slice(1)] }).passing, false);
});
