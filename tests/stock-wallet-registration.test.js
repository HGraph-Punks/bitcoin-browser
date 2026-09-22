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
  WALLET_REGISTRATION_MODES,
  WALLET_RESERVED_ORIGIN,
  buildWalletRegistrationSchedule,
  parseWalletRegistrationEvidence,
  runStockWalletRegistration,
  stockWalletRegistrationMainSource,
  summarizeWalletRegistrationReport
} from '../scripts/diagnose-stock-wallet-registration.mjs';

const partitions = ['persist:satoshi-browser-app', 'persist:satoshi-browser-wallet'];
function walletMarker(mode, overrides = {}) {
  return `STOCK_WALLET_REGISTRATION:${JSON.stringify({ registrationMode: mode, handlerInstalled: mode === 'present', walletHandlerInvocations: 0,
    sessionCount: 2, distinctSessions: true, partitions, browserWindowCount: 1, ...overrides })}`;
}
function frameMarker() {
  return `STOCK_FRAME_READY:${JSON.stringify({ placement: 'opaque-child', route: ORD_DOCUMENT_URL, relaySourceId: APP_DOCUMENT_URL, sourceBound: true,
    opaqueOrigin: true, facadePresent: false, nodeRequirePresent: false, nodeProcessPresent: false, ordRequests: 1, rejectedOrdRequests: 0,
    sandbox: 'allow-scripts allow-forms allow-modals allow-pointer-lock', referrerPolicy: 'no-referrer' })}`;
}

test('wallet registration evidence requires exact arm, zero invocations, distinct sessions, partitions, and one window', () => {
  for (const mode of WALLET_REGISTRATION_MODES) assert.ok(parseWalletRegistrationEvidence(walletMarker(mode), mode));
  for (const change of [{ walletHandlerInvocations: 1 }, { sessionCount: 1 }, { distinctSessions: false }, { partitions: [...partitions].reverse() },
    { browserWindowCount: 2 }, { handlerInstalled: false }]) assert.equal(parseWalletRegistrationEvidence(walletMarker('present', change), 'present'), null);
  assert.equal(parseWalletRegistrationEvidence(`${walletMarker('present')}\n${walletMarker('present')}`, 'present'), null);
  assert.equal(parseWalletRegistrationEvidence('STOCK_WALLET_REGISTRATION:{bad}', 'present'), null);
});

test('schedule alternates absent/present over exact twelve opaque-child rows', () => {
  const rows = buildWalletRegistrationSchedule(2); assert.equal(rows.length, 12); assert.ok(rows.every((row) => row.placement === 'opaque-child'));
  for (const mode of ['https', 'https-include', 'wss']) assert.deepEqual(rows.filter((row) => row.mode === mode).map(({ run, registrationMode }) => ({ run, registrationMode })), [
    { run: 1, registrationMode: 'absent' }, { run: 1, registrationMode: 'present' },
    { run: 2, registrationMode: 'present' }, { run: 2, registrationMode: 'absent' }
  ]);
});

async function executeMain(mode) {
  const stdout = []; const sessions = new Map(); let win;
  const app = new EventEmitter(); Object.assign(app, { enableSandbox() {}, whenReady: () => Promise.resolve(), quit() {}, exit() {} });
  function makeSession(partition) {
    const value = { partition, handlers: {}, fetchCalls: [], protocol: { handle(scheme, handler) { value.handlers[scheme] = handler; } },
      fetch(request, options) { value.fetchCalls.push({ request, options }); return Promise.resolve('passthrough'); }, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
    sessions.set(partition, value); return value;
  }
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.getURL = () => APP_DOCUMENT_URL; win = this; }
    async loadURL(url) { await (await sessions.get(partitions[0]).handlers.app(new Request(url))).text(); this.webContents.emit('did-finish-load'); }
  }
  vm.runInNewContext(stockWalletRegistrationMainSource(mode), { __dirname: '/fixture', Request, Response, URL, Date,
    require(name) {
      if (name === 'electron') return { app, BrowserWindow,
        session: { fromPartition: (partition) => makeSession(partition) }, protocol: { registerSchemesAsPrivileged() {} } };
      if (name === 'node:path') return path;
      if (name === 'node:fs/promises') return { readFile: async (name) => Buffer.from(name) };
      throw new Error(`unexpected ${name}`);
    }, process: { stdout: { write: (line) => stdout.push(line) } }, setImmediate() {}, setTimeout: () => ({ unref() {} })
  }, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve)); return { stdout, sessions, win, app };
}

test('generated arms create distinct sessions and only present arm installs exact reserved/pass-through HTTPS handler', async () => {
  const absent = await executeMain('absent'); assert.equal(absent.sessions.get(partitions[1]).handlers.https, undefined); assert.equal(absent.stdout.some((line) => line.startsWith('STOCK_WALLET_REGISTRATION:')), false);
  absent.app.emit('before-quit');
  assert.ok(absent.stdout.includes(`${walletMarker('absent')}\n`));
  const present = await executeMain('present'); const wallet = present.sessions.get(partitions[1]); assert.equal(typeof wallet.handlers.https, 'function');
  assert.equal(present.stdout.some((line) => line.startsWith('STOCK_WALLET_REGISTRATION:')), false); present.app.emit('before-quit');
  assert.ok(present.stdout.includes(`${walletMarker('present')}\n`)); assert.equal(wallet.fetchCalls.length, 0);
  const external = new Request('https://example.invalid/resource'); assert.equal(await wallet.handlers.https(external), 'passthrough');
  assert.equal(wallet.fetchCalls.length, 1); assert.equal(wallet.fetchCalls[0].request, external);
  assert.deepEqual({ ...wallet.fetchCalls[0].options }, { bypassCustomProtocolHandlers: true });
  const reserved = await wallet.handlers.https(new Request(`${WALLET_RESERVED_ORIGIN}/index.html`)); assert.equal(reserved.status, 404);
  assert.equal(wallet.fetchCalls.length, 1); assert.equal(present.win.options.webPreferences.session, present.sessions.get(partitions[0]));
});

const topology = 'STOCK_TOPOLOGY_READY:{"topology":"named-dual","partitions":["persist:satoshi-browser-app","persist:satoshi-browser-wallet"],"permissionDenied":true}';
const preload = 'STOCK_PRELOAD_READY:{"facadePresent":true,"bootstrapFunction":true,"signingFunction":true,"nodeRequirePresent":false,"nodeProcessPresent":false}';
function clean(item, overrides = {}) {
  return { ready: true, topologyReady: topology, topologyMarkerCount: 1,
    documentReady: 'STOCK_DOCUMENT_READY:{"documentMode":"app","url":"app://app/renderer/index.html","documentRequests":1,"rejectedDocumentRequests":0}', documentMarkerCount: 1,
    preloadReady: preload, preloadMarkerCount: 1, frameReady: frameMarker(), frameMarkerCount: 1,
    probeSourceReady: `STOCK_PROBE_SOURCE:{"sourceId":"${ORD_DOCUMENT_URL}"}`, probeSourceMarkerCount: 1,
    walletRegistrationReady: walletMarker(item.registrationMode), walletRegistrationMarkerCount: 1,
    loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected', closed: true, code: 0, signal: null,
    forced: false, spawnError: null, killError: null, outputTruncated: false, diagnostics: { recognizedCount: 0 }, ...overrides };
}
const preflight = async () => ({ executable: '/fixture/Electron', hashes: {}, fuseWire: {} });
function sink() { return { endpoint: 'https://127.0.0.1:4443', connections: [], observationOverflow: false, close: async () => {} }; }

test('injected matrix completes all twelve rows and reuses six arm/mode profiles', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-registration-test-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const tls = sink(); let calls = 0;
  const report = await runStockWalletRegistration({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async () => { const item = buildWalletRegistrationSchedule(2)[calls++]; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(item); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(report.runs.length, 12);
  assert.equal(report.summary.complete, true); assert.equal(report.summary.passing, true); assert.equal(new Set(report.runs.map((run) => run.profile)).size, 6);
  assert.equal(report.fixturePackageSha256.length, 64); assert.equal(report.provenance.internalName, 'stock-network-shutdown');
});

test('missing, duplicate, invoked, and wrong-arm markers stop before a second launch', async (t) => {
  for (const override of [{ walletRegistrationMarkerCount: 0, walletRegistrationReady: null }, { walletRegistrationMarkerCount: 2 },
    { walletRegistrationReady: walletMarker('absent', { walletHandlerInvocations: 1 }) }, { walletRegistrationReady: walletMarker('present') }]) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-registration-invalid-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
    const report = await runStockWalletRegistration({ output: path.join(parent, 'report.json'), repeat: 1 }, { platform: 'darwin', preflight, startSink: async () => tls,
      runChild: async () => { calls++; tls.connections.push({ clientHello: true, bytes: 64 }); return clean(buildWalletRegistrationSchedule(1)[0], override); } });
    t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 1);
    assert.equal(report.stoppedReason, 'WALLET_REGISTRATION_EVIDENCE_INVALID'); assert.equal(report.summary.passing, false);
  }
});

test('unknown close stops schedule and persists incomplete evidence', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-registration-close-')); t.after(() => fs.rm(parent, { recursive: true, force: true })); const tls = sink(); let calls = 0;
  const child = { unref() {}, stdout: { unref() {} }, stderr: { unref() {} } };
  const report = await runStockWalletRegistration({ output: path.join(parent, 'report.json'), repeat: 2 }, { platform: 'darwin', preflight, startSink: async () => tls,
    runChild: async (_e, _a, _p, _m, _r, handoff) => { calls++; handoff(child); tls.connections.push({ clientHello: true, bytes: 64 }); return clean(buildWalletRegistrationSchedule(2)[0], { closed: false }); } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true })); assert.equal(calls, 1);
  assert.equal(report.stoppedReason, 'OWNED_PROCESS_CLOSE_UNCONFIRMED'); assert.equal(JSON.parse(await fs.readFile(path.join(parent, 'report.json'), 'utf8')).summary.complete, false);
});

test('summary independently rejects reordered identity and invalid registration evidence', () => {
  const runs = buildWalletRegistrationSchedule(1).map((item) => ({ ...clean(item), ...item, walletRegistrationValid: true, frameValid: true,
    probeSourceValid: true, preloadValid: true, documentValid: true, topologyValid: true, networkExpectationMet: true, rawTlsObservationOverflow: false }));
  const report = { config: { repeat: 1 }, runs, stoppedReason: null, failure: null };
  assert.equal(summarizeWalletRegistrationReport(report).passing, true);
  assert.equal(summarizeWalletRegistrationReport({ ...report, runs: [{ ...runs[0], registrationMode: 'present' }, ...runs.slice(1)] }).complete, false);
  assert.equal(summarizeWalletRegistrationReport({ ...report, runs: [{ ...runs[0], walletRegistrationValid: false }, ...runs.slice(1)] }).passing, false);
});
