import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stockMainSource } from '../scripts/diagnose-stock-network-shutdown.mjs';
import { buildTopologySchedule, parseTopologyReady, runStockSessionTopology } from '../scripts/diagnose-stock-session-topology.mjs';

test('generated stock source creates reviewed sessions in exact order with denial handlers', () => {
  const dual = stockMainSource('named-dual');
  assert.ok(dual.includes('persist:satoshi-browser-app'));
  assert.ok(dual.indexOf('persist:satoshi-browser-app') < dual.indexOf('persist:satoshi-browser-wallet'));
  assert.ok(dual.includes('setPermissionCheckHandler(() => false)'));
  assert.ok(dual.includes('setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))'));
  assert.ok(dual.includes('STOCK_TOPOLOGY_READY:'));
  assert.throws(() => stockMainSource('unknown'));
});

test('schedule is bounded, complete, and alternates topology order across reuse runs', () => {
  const rows = buildTopologySchedule({ repeat: 2 });
  assert.equal(rows.length, 18);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.topology), ['stock-single', 'named-single', 'named-dual']);
  assert.deepEqual(rows.slice(9, 12).map((row) => row.topology), ['named-dual', 'named-single', 'stock-single']);
  assert.throws(() => buildTopologySchedule({ repeat: 3 }));
});

test('topology marker parser rejects missing, truncated, reordered, and permissive evidence', () => {
  const valid = 'STOCK_TOPOLOGY_READY:{"topology":"named-dual","partitions":["persist:satoshi-browser-app","persist:satoshi-browser-wallet"],"permissionDenied":true}';
  assert.equal(parseTopologyReady(valid).topology, 'named-dual');
  for (const value of ['', valid.slice(0, -1), valid.replace('true', 'false'), valid.replace('["persist:satoshi-browser-app","persist:satoshi-browser-wallet"]', '["persist:satoshi-browser-wallet","persist:satoshi-browser-app"]')]) assert.equal(parseTopologyReady(value), null);
});

function topologyForProfile(profile) {
  return ['stock-single', 'named-single', 'named-dual'].find((value) => path.basename(profile).startsWith(`${value}-`));
}
function marker(topology) {
  const partitions = topology === 'stock-single' ? ['persist:stock-network-shutdown'] : topology === 'named-single' ? ['persist:satoshi-browser-app'] : ['persist:satoshi-browser-app', 'persist:satoshi-browser-wallet'];
  return `STOCK_TOPOLOGY_READY:${JSON.stringify({ topology, partitions, permissionDenied: true })}`;
}
const closedResult = (topology) => ({ ready: true, topologyReady: marker(topology), topologyMarkerCount: 1, loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected', closed: true, code: 0, signal: null, forced: false, spawnError: null, killError: null, diagnostics: { recognizedCount: 0 }, outputTruncated: false });
const fakeSink = () => ({ endpoint: 'https://127.0.0.1:4443', connections: [{ clientHello: true, bytes: 10 }], close: async () => {} });

test('injected runner writes the exact 18-case topology/mode/run matrix', async (t) => {
  const output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'topology-test-')), 'report.json');
  const report = await runStockSessionTopology({ output, repeat: 2 }, { platform: 'darwin', preflight: async () => ({ executable: '/fixture/electron', hashes: {}, fuseWire: {} }), startSink: async () => fakeSink(),
    runChild: async (_exe, _app, profile) => closedResult(topologyForProfile(profile)) });
  assert.equal(report.runs.length, 18); assert.equal(report.summary.complete, true);
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  assert.deepEqual(report.runs.map(({ topology, mode, run }) => ({ topology, mode, run })), buildTopologySchedule({ repeat: 2 }));
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')).summary, report.summary);
});

test('unknown closure stops launches, persists failure evidence, then detaches handed-off ownership', async (t) => {
  const output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'topology-unknown-')), 'report.json');
  const child = { unrefCalls: 0, unref() { this.unrefCalls += 1; }, stdout: { unref() { child.unrefCalls += 1; } }, stderr: { unref() { child.unrefCalls += 1; } } };
  let launches = 0;
  const report = await runStockSessionTopology({ output, repeat: 2 }, { platform: 'darwin', preflight: async () => ({ executable: '/fixture/electron', hashes: {}, fuseWire: {} }), startSink: async () => fakeSink(),
    runChild: async (_exe, _app, profile, _mode, _run, handoff) => { launches += 1; handoff(child); return { ...closedResult(topologyForProfile(profile)), closed: false }; } });
  t.after(() => fs.rm(report.root, { recursive: true, force: true }));
  assert.equal(launches, 1); assert.equal(report.stoppedReason, 'OWNED_PROCESS_CLOSE_UNCONFIRMED'); assert.equal(child.unrefCalls, 3);
  assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).root, report.root);
});

test('injected runner failure persists a bounded incomplete report', async () => {
  const output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'topology-failure-')), 'report.json');
  await assert.rejects(runStockSessionTopology({ output, repeat: 1 }, { platform: 'darwin', preflight: async () => ({ executable: '/fixture/electron', hashes: {}, fuseWire: {} }), startSink: async () => fakeSink(),
    runChild: async () => { const error = new Error('fixture runner failure'); error.code = 'FIXTURE_FAILURE'; throw error; } }), { code: 'FIXTURE_FAILURE' });
  const report = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(report.summary.complete, false); assert.equal(report.failure.code, 'FIXTURE_FAILURE');
  await fs.rm(report.root, { recursive: true, force: true });
});

test('report write failure is surfaced after the bounded write attempt', async () => {
  const realHandle = { writeFile: async () => { const error = new Error('disk full'); error.code = 'ENOSPC'; throw error; }, sync: async () => {}, close: async () => {} };
  const io = { ...fs, open: async () => realHandle };
  await assert.rejects(runStockSessionTopology({ output: '/fixture/report.json', repeat: 1 }, { platform: 'darwin', fs: io,
    preflight: async () => { const error = new Error('preflight failure'); error.code = 'PREFLIGHT'; throw error; } }), { code: 'ENOSPC' });
});
