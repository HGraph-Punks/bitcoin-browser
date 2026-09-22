import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCurrentFuseWire } from '@electron/fuses';
import { inspectBundle, requireOwnedPairRoot, verifySignature } from './diagnose-cookie-fuse-pair.mjs';
import { detachUnconfirmedPackagedChild } from './packaged-smoke-child-lifecycle.mjs';
import { STOCK_MODES, STOCK_SESSION_TOPOLOGIES, classifyCleanExit, classifyExperimentCompletion, classifyStockRun, hasExpectedRawTlsActivity, runChild, startRawTlsSink, stockMainSource, stockProbeHtml } from './diagnose-stock-network-shutdown.mjs';

export function buildTopologySchedule({ repeat = 2 } = {}) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 2) throw new Error('Repeat must be 1 or 2');
  const rows = [];
  for (let run = 1; run <= repeat; run += 1) {
    const topologies = run % 2 ? STOCK_SESSION_TOPOLOGIES : [...STOCK_SESSION_TOPOLOGIES].reverse();
    for (const mode of STOCK_MODES) for (const topology of topologies) rows.push({ mode, topology, run });
  }
  return rows;
}

export function parseTopologyReady(line) {
  const match = /^STOCK_TOPOLOGY_READY:(\{[^\n]{1,4096}\})$/.exec(line);
  if (!match) return null;
  let value;
  try { value = JSON.parse(match[1]); } catch { return null; }
  if (!STOCK_SESSION_TOPOLOGIES.includes(value?.topology) || value.permissionDenied !== true || !Array.isArray(value.partitions)) return null;
  const expected = value.topology === 'stock-single' ? ['persist:stock-network-shutdown']
    : value.topology === 'named-single' ? ['persist:satoshi-browser-app']
      : ['persist:satoshi-browser-app', 'persist:satoshi-browser-wallet'];
  return JSON.stringify(value.partitions) === JSON.stringify(expected) ? value : null;
}

const APPROVED_BUNDLE = '/private/tmp/satoshi-cookie-fuse-pair-nEMi0r/cookie-encrypted/Electron.app';
const PREPARATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'release', 'cookie-fuse-pair-preparation-20260905.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stableFuse = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));

export async function preflightApprovedTopologyBundle({ io = fs, fuseReader = getCurrentFuseWire, signatureVerifier = verifySignature } = {}) {
  await requireOwnedPairRoot('/private/tmp/satoshi-cookie-fuse-pair-nEMi0r', io);
  const preparation = JSON.parse(await io.readFile(PREPARATION, 'utf8'));
  if (preparation.root !== '/private/tmp/satoshi-cookie-fuse-pair-nEMi0r' || preparation.mutation?.target !== APPROVED_BUNDLE) throw new Error('Preparation report does not identify the approved encrypted copy');
  const expected = preparation.afterSigning?.entries?.find((entry) => entry.arm === 'encrypted');
  if (!expected) throw new Error('Preparation report lacks encrypted post-signing evidence');
  const inspected = await inspectBundle(APPROVED_BUNDLE, io, fuseReader);
  const actualHashes = [
    ['Contents/MacOS/Electron', inspected.hashes.executable],
    ['Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', inspected.hashes.framework],
    ['Contents/Info.plist', inspected.hashes.infoPlist]
  ];
  if (JSON.stringify(actualHashes) !== JSON.stringify(expected.hashes.map((item) => [item.relative, item.sha256]))
    || stableFuse(inspected.fuseWire) !== stableFuse(expected.fuses)) throw new Error('Approved encrypted copy differs from preparation evidence');
  await signatureVerifier(APPROVED_BUNDLE);
  return inspected;
}

export async function runStockSessionTopology({ output, repeat = 2 } = {}, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Stock session topology diagnostic supports macOS only');
  if (!path.isAbsolute(output ?? '')) throw new Error('output must be absolute');
  const expectedSchedule = buildTopologySchedule({ repeat });
  const io = dependencies.fs ?? fs;
  const handle = await io.open(output, 'wx', 0o600);
  let root = null; let retain = false; const runs = []; let stoppedReason = null; let report = null; let unknownChild = null; let reportAttempted = false;
  try {
    const inspected = await (dependencies.preflight ?? preflightApprovedTopologyBundle)({ io });
    root = await io.mkdtemp(path.join(os.tmpdir(), 'satoshi-stock-session-topology-'));
    const appDirectory = path.join(root, 'fixture'); const profiles = path.join(root, 'profiles');
    await io.mkdir(appDirectory, { mode: 0o700 }); await io.mkdir(profiles, { mode: 0o700 });
    await io.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'stock-network-shutdown', main: 'main.cjs' }), { flag: 'wx', mode: 0o600 });
    const sink = await (dependencies.startSink ?? startRawTlsSink)({ maxConnections: 128 });
    try {
      for (const item of buildTopologySchedule({ repeat })) {
        const profile = path.join(profiles, `${item.topology}-${item.mode}`);
        if (item.run === 1) await io.mkdir(profile, { mode: 0o700 });
        const main = stockMainSource(item.topology); const html = stockProbeHtml(item.mode, sink.endpoint);
        await io.writeFile(path.join(appDirectory, 'main.cjs'), main, { mode: 0o600 }); await io.writeFile(path.join(appDirectory, 'index.html'), html, { mode: 0o600 });
        const before = sink.connections.length;
        const result = await (dependencies.runChild ?? runChild)(inspected.executable, appDirectory, profile, item.mode, item.run, (child) => { unknownChild = child; });
        const rawTlsConnections = sink.connections.slice(before).map((value) => ({ ...value }));
        Object.assign(result, item, { profile, rawTlsConnections, rawTlsObservationOverflow: Boolean(sink.observationOverflow), networkExpectationMet: hasExpectedRawTlsActivity(result.outcome, rawTlsConnections), fixtureSha256: sha256(html), mainSha256: sha256(main) });
        result.topologyEvidence = parseTopologyReady(result.topologyReady);
        result.topologyReady = Boolean(result.topologyMarkerCount === 1 && result.topologyEvidence && result.topologyEvidence.topology === item.topology);
        result.passed = result.topologyReady && classifyStockRun(result);
        runs.push(result);
        if (!result.closed) { stoppedReason = 'OWNED_PROCESS_CLOSE_UNCONFIRMED'; retain = true; break; }
        if (!result.topologyReady) { stoppedReason = 'TOPOLOGY_READINESS_INVALID'; break; }
      }
    } finally { await sink.close(); }
    const identitiesMatch = runs.length === expectedSchedule.length && expectedSchedule.every((item, index) => item.topology === runs[index]?.topology && item.mode === runs[index]?.mode && item.run === runs[index]?.run);
    const complete = !stoppedReason && identitiesMatch;
    report = { schemaVersion: 1, generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, config: { repeat, modes: STOCK_MODES, topologies: STOCK_SESSION_TOPOLOGIES }, purpose: 'Stock Electron session-topology/no-TLS observation; cookie roundtrip not exercised; not product qualification', root, stoppedReason,
      provenance: { bundle: APPROVED_BUNDLE, hashes: inspected.hashes, fuseWire: inspected.fuseWire, signatureVerified: true }, runs,
      summary: { complete, passing: complete && runs.every((run) => run.passed === true), experimentCompleted: runs.filter(classifyExperimentCompletion).length, cleanExits: runs.filter(classifyCleanExit).length, networkObserved: runs.filter((run) => run.networkExpectationMet).length } };
    reportAttempted = true; await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); await handle.sync();
    return report;
  } catch (error) {
    retain = true;
    if (!report) report = { schemaVersion: 1, purpose: 'Stock Electron session-topology/no-TLS observation; cookie roundtrip not exercised; not product qualification', root, stoppedReason: stoppedReason ?? `RUNNER_FAILED:${error?.code ?? 'UNEXPECTED'}`, runs,
      failure: { code: error?.code ?? 'UNEXPECTED', message: String(error?.message ?? 'Topology runner failed').slice(0, 1024) }, summary: { complete: false } };
    if (!reportAttempted) {
      reportAttempted = true;
      try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); await handle.sync(); }
      catch (writeError) {
        const fallback = JSON.stringify({ event: 'TOPOLOGY_REPORT_WRITE_FAILED', code: writeError?.code ?? 'WRITE_FAILED', retainedRoot: root, unknownPid: Number.isSafeInteger(unknownChild?.pid) ? unknownChild.pid : null });
        (dependencies.stderr ?? process.stderr).write(`${fallback.slice(0, 4096)}\n`);
        throw writeError;
      }
    } else (dependencies.stderr ?? process.stderr).write(`${JSON.stringify({ event: 'TOPOLOGY_REPORT_WRITE_FAILED', code: error?.code ?? 'WRITE_FAILED', retainedRoot: root, unknownPid: Number.isSafeInteger(unknownChild?.pid) ? unknownChild.pid : null }).slice(0, 4096)}\n`);
    throw error;
  } finally {
    try { await handle.close(); } finally { if (unknownChild) detachUnconfirmedPackagedChild(unknownChild); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv.find((value) => value.startsWith('--output='))?.slice(9);
  runStockSessionTopology({ output }).then((report) => { process.stdout.write(`${JSON.stringify(report.summary)}\n`); if (!report.summary.passing) process.exitCode = 1; }, (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
