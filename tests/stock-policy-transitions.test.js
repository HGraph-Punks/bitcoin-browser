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
  POLICY_TRANSITIONS,
  buildPolicyTransitionSchedule,
  parsePolicyTransitionEvidence,
  runStockPolicyTransitions,
  stockPolicyTransitionDocuments,
  stockPolicyTransitionMainSource,
  summarizePolicyTransitionReport
} from '../scripts/diagnose-stock-policy-transitions.mjs';

const endpoint = 'https://127.0.0.1:4443';
function marker(transition, mode, overrides = {}) {
  const scheme = mode === 'wss' ? 'wss:' : 'https:'; const resourceType = mode === 'wss' ? 'webSocket' : 'xhr';
  return `STOCK_REQUEST_POLICY:${JSON.stringify({ transition, handlerInstalled: true, targetCalls: 2,
    observations: [{ scheme, resourceType, allowed: true }, { scheme, resourceType, allowed: false }], observationOverflow: false,
    unexpectedExternalCount: 0, transitionApplied: true, transitionFailure: false, transitionControlCalls: 1,
    firstProbeOutcome: 'rejected', transitionAppliedAtSecondProbe: true, closeAllConnectionsCalls: 1, ...overrides })}`;
}

test('transition parser requires one allowed control, one denied probe, and one completed cutoff request', () => {
  for (const transition of POLICY_TRANSITIONS) for (const mode of ['https', 'https-include', 'wss']) assert.ok(parsePolicyTransitionEvidence(marker(transition, mode), transition, mode));
  for (const change of [{ targetCalls: 1 }, { transitionApplied: false }, { transitionFailure: true }, { closeAllConnectionsCalls: 0 },
    { observations: [{ scheme: 'https:', resourceType: 'xhr', allowed: true }, { scheme: 'https:', resourceType: 'xhr', allowed: true }] },
    { transitionControlCalls: 0 }, { firstProbeOutcome: 'response' }, { transitionAppliedAtSecondProbe: false },
    { unexpectedExternalCount: 1 }, { observationOverflow: true }]) assert.equal(parsePolicyTransitionEvidence(marker('blocked', 'https', change), 'blocked', 'https'), null);
  assert.equal(parsePolicyTransitionEvidence(`${marker('offline', 'wss')}\n${marker('offline', 'wss')}`, 'offline', 'wss'), null);
});

test('schedule alternates blocked/offline across twelve fresh/reused rows', () => {
  const rows = buildPolicyTransitionSchedule(2); assert.equal(rows.length, 12);
  for (const mode of ['https', 'https-include', 'wss']) assert.deepEqual(rows.filter((row) => row.mode === mode).map(({ run, transition }) => ({ run, transition })), [
    { run: 1, transition: 'blocked' }, { run: 1, transition: 'offline' }, { run: 2, transition: 'offline' }, { run: 2, transition: 'blocked' }
  ]);
});

async function executeMain(transition, mode, { failClose = false, closePromise = null } = {}) {
  const stdout = []; const sessions = []; const app = new EventEmitter(); Object.assign(app, { enableSandbox() {}, whenReady: () => Promise.resolve(), quit() {}, exit() {} });
  const makeSession = () => { const value = { handlers: {}, protocol: { handle(scheme, handler) { value.handlers[scheme] = handler; } }, closeCalls: 0,
    async closeAllConnections() { value.closeCalls += 1; if (failClose) throw new Error('fixture cutoff failure'); if (closePromise) await closePromise; }, webRequest: { onBeforeRequest(filter, handler) { value.filter = filter; value.beforeRequest = handler; } },
    fetch() {}, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }; sessions.push(value); return value; };
  class BrowserWindow { constructor() { this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.getURL = () => APP_DOCUMENT_URL; }
    async loadURL(url) { await (await sessions[0].handlers.app(new Request(url))).text(); this.webContents.emit('did-finish-load'); } }
  vm.runInNewContext(stockPolicyTransitionMainSource(transition, mode, endpoint), { __dirname: '/fixture', Request, Response, URL, Date,
    require(name) { if (name === 'electron') return { app, BrowserWindow, session: { fromPartition: () => makeSession() }, protocol: { registerSchemesAsPrivileged() {} } };
      if (name === 'node:path') return path; if (name === 'node:fs/promises') return { readFile: async (name) => Buffer.from(name) }; throw new Error(`unexpected ${name}`); },
    process: { stdout: { write: (line) => stdout.push(line) } }, setImmediate, setTimeout: () => ({ unref() {} })
  }, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve)); return { stdout, app, session: sessions[0] };
}

test('generated handler applies the exact transition between allowed and denied callbacks', async () => {
  for (const transition of POLICY_TRANSITIONS) {
    const fixture = await executeMain(transition, 'wss'); const decisions = [];
    fixture.session.beforeRequest({ url: 'wss://127.0.0.1:4443/probe', resourceType: 'webSocket' }, (value) => decisions.push(value.cancel));
    assert.equal(fixture.session.closeCalls, 0, 'first allowed callback must precede cutoff');
    await new Promise((resolve) => fixture.session.beforeRequest({ url: `${endpoint}/transition?first=rejected`, resourceType: 'xhr' }, (value) => { decisions.push(value.cancel); resolve(); }));
    fixture.session.beforeRequest({ url: 'wss://127.0.0.1:4443/probe', resourceType: 'webSocket' }, (value) => decisions.push(value.cancel));
    fixture.app.emit('before-quit'); assert.deepEqual(decisions, [false, true, true]); assert.equal(fixture.session.closeCalls, 1);
    assert.ok(parsePolicyTransitionEvidence(fixture.stdout.find((line) => line.startsWith('STOCK_REQUEST_POLICY:')).trim(), transition, 'wss'));
  }
});

test('failed cutoff remains explicit and cannot qualify a denied second callback', async () => {
  const fixture = await executeMain('offline', 'https', { failClose: true }); const decisions = [];
  fixture.session.beforeRequest({ url: `${endpoint}/probe`, resourceType: 'xhr' }, (value) => decisions.push(value.cancel));
  await new Promise((resolve) => fixture.session.beforeRequest({ url: `${endpoint}/transition?first=rejected`, resourceType: 'xhr' }, (value) => { decisions.push(value.cancel); resolve(); }));
  fixture.session.beforeRequest({ url: `${endpoint}/probe`, resourceType: 'xhr' }, (value) => decisions.push(value.cancel));
  fixture.app.emit('before-quit'); assert.deepEqual(decisions, [false, true, true]);
  assert.equal(parsePolicyTransitionEvidence(fixture.stdout.find((line) => line.startsWith('STOCK_REQUEST_POLICY:')).trim(), 'offline', 'https'), null);
});

test('second callback intercepted before delayed cutoff completion is rejected by evidence', async () => {
  let release; const closePromise = new Promise((resolve) => { release = resolve; });
  const fixture = await executeMain('blocked', 'https', { closePromise });
  fixture.session.beforeRequest({ url: `${endpoint}/probe`, resourceType: 'xhr' }, () => {});
  let controlDone = false;
  fixture.session.beforeRequest({ url: `${endpoint}/transition?first=rejected`, resourceType: 'xhr' }, () => { controlDone = true; });
  fixture.session.beforeRequest({ url: `${endpoint}/probe`, resourceType: 'xhr' }, () => {});
  assert.equal(controlDone, false); release(); await closePromise; await new Promise((resolve) => setImmediate(resolve));
  fixture.app.emit('before-quit');
  assert.equal(parsePolicyTransitionEvidence(fixture.stdout.find((line) => line.startsWith('STOCK_REQUEST_POLICY:')).trim(), 'blocked', 'https'), null);
});

test('non-owned transition route cannot initiate the cutoff', async () => {
  const fixture = await executeMain('blocked', 'https'); let decision;
  fixture.session.beforeRequest({ url: `${endpoint}/different?first=rejected`, resourceType: 'xhr' }, (value) => { decision = value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ ...decision }, { cancel: false });
  assert.equal(fixture.session.closeCalls, 0);
});

test('malformed, duplicate, premature, and non-XHR controls cannot mutate settings', async () => {
  for (const details of [
    { url: `${endpoint}/transition?first=secret-value`, resourceType: 'xhr' },
    { url: `${endpoint}/transition?first=rejected&extra=1`, resourceType: 'xhr' },
    { url: `${endpoint}/transition?first=rejected`, resourceType: 'image' }
  ]) {
    const fixture = await executeMain('offline', 'https'); fixture.session.beforeRequest({ url: `${endpoint}/probe`, resourceType: 'xhr' }, () => {});
    fixture.session.beforeRequest(details, () => {}); await new Promise((resolve) => setImmediate(resolve)); assert.equal(fixture.session.closeCalls, 0);
  }
  const premature = await executeMain('blocked', 'https'); premature.session.beforeRequest({ url: `${endpoint}/transition?first=rejected`, resourceType: 'xhr' }, () => {});
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(premature.session.closeCalls, 0);
  const duplicate = await executeMain('blocked', 'https'); duplicate.session.beforeRequest({ url: `${endpoint}/probe`, resourceType: 'xhr' }, () => {});
  await new Promise((resolve) => duplicate.session.beforeRequest({ url: `${endpoint}/transition?first=rejected`, resourceType: 'xhr' }, resolve));
  duplicate.session.beforeRequest({ url: `${endpoint}/transition?first=rejected`, resourceType: 'xhr' }, () => {});
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(duplicate.session.closeCalls, 1);
});

test('document performs two same-document probes and emits only one completion marker', () => {
  for (const mode of ['https', 'https-include', 'wss']) {
    const { indexHtml, childHtml } = stockPolicyTransitionDocuments(mode, endpoint);
    assert.match(indexHtml, new RegExp(ORD_DOCUMENT_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal((childHtml.match(/attempt\(\)/g) ?? []).length, 1);
    assert.equal((childHtml.match(/STOCK_PROBE_DONE:/g) ?? []).length, 1);
    assert.match(childHtml, /STOCK_PROBE_DONE:' \+ second/);
    assert.match(childHtml, /\?first=' \+ encodeURIComponent\(first\)/);
    assert.doesNotMatch(childHtml, /location\.(?:assign|reload)|window\.open/);
  }
});

test('generated HTTPS probe reports its actual second outcome', async () => {
  const html = stockPolicyTransitionDocuments('https', endpoint).childHtml;
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1]; assert.ok(script);
  for (const { secondSucceeds, expected } of [{ secondSucceeds: false, expected: 'rejected' }, { secondSucceeds: true, expected: 'response' }]) {
    const messages = []; let calls = 0;
    vm.runInNewContext(script, { parent: { postMessage() {} }, location: { href: ORD_DOCUMENT_URL }, window: {}, AbortController, encodeURIComponent,
      fetch: async () => { calls += 1; if (calls === 2) throw new Error('owned transition control cancellation'); if (calls === 3 && secondSucceeds) return {};
        throw new Error('owned raw TLS rejection'); }, console: { log: (value) => messages.push(value) }, setTimeout, clearTimeout }, { timeout: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(messages, [`STOCK_PROBE_DONE:${expected}`]); assert.equal(calls, 3);
  }
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
  walletRegistrationReady: wallet, walletRegistrationMarkerCount: 1, requestPolicyReady: marker(item.transition, item.mode), requestPolicyMarkerCount: 1,
  loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected', closed: true, code: 0, signal: null, forced: false, spawnError: null,
  killError: null, outputTruncated: false, diagnostics: { recognizedCount: 0 }, ...overrides }; }
const preflight = async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} });
function sink() { return { endpoint, connections: [], observationOverflow: false, close: async () => {} }; }

test('injected matrix completes twelve rows while retaining cutoff scope limitation', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-transition-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
  const report = await runStockPolicyTransitions({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async () => { const item = buildPolicyTransitionSchedule(2)[calls++]; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(item); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(report.runs.length, 12); assert.equal(report.summary.passing, true);
  assert.equal(report.summary.deniedSecondCallbacks, 12); assert.equal(report.summary.establishedConnectionCutoffQualified, false);
  assert.equal(report.config.establishedConnectionCutoffScope, 'not-qualified-raw-tls-only');
});

test('matrix cannot pass without raw-TLS positive-control activity', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-transition-no-traffic-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
  const report = await runStockPolicyTransitions({ output: path.join(parent, 'report.json'), repeat: 1 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async () => clean(buildPolicyTransitionSchedule(1)[calls++]) });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 6); assert.equal(report.summary.complete, true);
  assert.equal(report.summary.positiveControlsWithRawTlsActivity, 0); assert.equal(report.summary.passing, false);
});

test('invalid transition evidence and unknown close stop rather than complete', async (t) => {
  for (const close of [true, false]) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-transition-invalid-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
    const report = await runStockPolicyTransitions({ output: path.join(parent, 'report.json'), repeat: 1 }, { platform: 'darwin', preflight, startSink: async () => tls,
      runChild: async (_a, _b, _c, _d, _e, handoff) => { calls += 1; if (!close) handoff({ unref() {}, stdout: { unref() {} }, stderr: { unref() {} } });
        tls.connections.push({ clientHello: true, bytes: 64 }); return clean(buildPolicyTransitionSchedule(1)[0], close ? { requestPolicyMarkerCount: 2 } : { closed: false }); } });
    t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 1); assert.equal(report.summary.complete, false);
    assert.equal(report.stoppedReason, close ? 'POLICY_TRANSITION_EVIDENCE_INVALID' : 'OWNED_PROCESS_CLOSE_UNCONFIRMED');
  }
});

test('successful or incomplete second probes cannot qualify an otherwise valid transition marker', async (t) => {
  for (const outcome of ['response', 'opened', 'bounded-timeout', 'thrown']) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-transition-outcome-'));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const tls = sink(); let calls = 0;
    const report = await runStockPolicyTransitions({ output: path.join(parent, 'report.json'), repeat: 1 }, {
      platform: 'darwin', preflight, startSink: async () => tls,
      runChild: async () => {
        calls += 1;
        tls.connections.push({ clientHello: true, bytes: 64 });
        return clean(buildPolicyTransitionSchedule(1)[0], { outcome });
      }
    });
    t.after(() => fs.rm(report.root, { recursive: true, force: true }));
    assert.equal(calls, 1);
    assert.equal(report.summary.passing, false);
    assert.equal(report.stoppedReason, 'POLICY_TRANSITION_EVIDENCE_INVALID');
  }
});

test('summary rejects reordered identity and invalid transition independently', () => {
  const runs = buildPolicyTransitionSchedule(1).map((item) => ({ ...clean(item), ...item, transitionValid: true, walletRegistrationValid: true, frameValid: true,
    probeSourceValid: true, preloadValid: true, documentValid: true, topologyValid: true, networkExpectationMet: true, rawTlsObservationOverflow: false,
    transitionEvidence: parsePolicyTransitionEvidence(marker(item.transition, item.mode), item.transition, item.mode) }));
  const report = { config: { repeat: 1 }, runs, stoppedReason: null, failure: null }; assert.equal(summarizePolicyTransitionReport(report).passing, true);
  assert.equal(summarizePolicyTransitionReport({ ...report, runs: [{ ...runs[0], transition: 'offline' }, ...runs.slice(1)] }).complete, false);
  assert.equal(summarizePolicyTransitionReport({ ...report, runs: [{ ...runs[0], transitionValid: false }, ...runs.slice(1)] }).passing, false);
  for (const outcome of ['response', 'opened', 'bounded-timeout', 'thrown']) {
    assert.equal(summarizePolicyTransitionReport({ ...report, runs: [{ ...runs[0], outcome }, ...runs.slice(1)] }).passing, false);
  }
});
