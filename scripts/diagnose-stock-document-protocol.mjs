import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finalizePackagedEvidence } from './packaged-smoke-child-lifecycle.mjs';
import { parseTopologyReady, preflightApprovedTopologyBundle } from './diagnose-stock-session-topology.mjs';
import { STOCK_MODES, classifyCleanExit, classifyExperimentCompletion, classifyStockRun, hasExpectedRawTlsActivity,
  runChild, startRawTlsSink, stockMainSource, stockProbeHtml } from './diagnose-stock-network-shutdown.mjs';

export const APP_DOCUMENT_URL = 'app://app/renderer/index.html';
export const DOCUMENT_MODES = Object.freeze(['file', 'app']);
export const PRELOAD_MODES = Object.freeze(['none', 'application']);
const APPLICATION_PRELOAD = fileURLToPath(new URL('../src/main/preload.cjs', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reviewed stock source insertion point changed');
  return source.replace(before, after);
}

export function stockDocumentMainSource(documentMode) {
  if (!DOCUMENT_MODES.includes(documentMode)) throw new TypeError('Unknown document mode');
  let source = stockMainSource('named-dual');
  source = replaceOnce(source, 'const { app, BrowserWindow, session }', 'const { app, BrowserWindow, session, protocol }');
  source = replaceOnce(source, 'app.enableSandbox();', `protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }
]);
app.enableSandbox();`);
  source = replaceOnce(source, '  const persistent = sessions[0].value;', `  const persistent = sessions[0].value;
  const documentMode = ${JSON.stringify(documentMode)};
  const documentHtml = await require('node:fs/promises').readFile('index.html');
  let documentRequests = 0;
  let rejectedDocumentRequests = 0;
  persistent.protocol.handle('app', (request) => {
    if (request.url !== ${JSON.stringify(APP_DOCUMENT_URL)} || !['GET', 'HEAD'].includes(request.method)) {
      rejectedDocumentRequests += 1;
      return new Response('Not found', { status: 404 });
    }
    documentRequests += 1;
    return new Response(request.method === 'HEAD' ? null : documentHtml, { status: 200, headers: {
      'content-type': 'text/html; charset=utf-8', 'content-length': String(documentHtml.length),
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store'
    }});
  });`);
  source = replaceOnce(source, "  await win.loadFile('index.html');", documentMode === 'file'
    ? "  await win.loadFile('index.html');"
    : `  await win.loadURL(${JSON.stringify(APP_DOCUMENT_URL)});`);
  source = replaceOnce(source, "  process.stdout.write('STOCK_READY\\n');", `  process.stdout.write('STOCK_DOCUMENT_READY:' + JSON.stringify({ documentMode, url: win.webContents.getURL(), documentRequests, rejectedDocumentRequests }) + '\\n');
  process.stdout.write('STOCK_READY\\n');`);
  return source;
}

export function buildDocumentSchedule(repeat = 2) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 2) throw new TypeError('Repeat must be 1 or 2');
  const schedule = [];
  for (const mode of STOCK_MODES) for (let run = 1; run <= repeat; run += 1) {
    for (const documentMode of run % 2 ? DOCUMENT_MODES : [...DOCUMENT_MODES].reverse()) schedule.push({ mode, run, documentMode });
  }
  return schedule;
}

export function stockPreloadMainSource(preloadMode) {
  if (!PRELOAD_MODES.includes(preloadMode)) throw new TypeError('Unknown preload mode');
  let source = stockDocumentMainSource('app');
  if (preloadMode === 'application') source = replaceOnce(source, '    session: persistent, sandbox: true,',
    "    preload: require('node:path').join(__dirname, 'preload.cjs'), session: persistent, sandbox: true,");
  source = replaceOnce(source, "    if (typeof message === 'string' && message.length <= 4096) {",
    "    if (typeof message === 'string' && message.length <= 4096) {\n      if (/^STOCK_PRELOAD_READY:\\{[^\\n]+\\}$/.test(message)) process.stdout.write(message + '\\n');");
  return source;
}

export function stockPreloadProbeHtml(mode, endpoint) {
  return replaceOnce(stockProbeHtml(mode, endpoint), '(() => {\n  const { mode, endpoint }', `(() => {
  console.log('STOCK_PRELOAD_READY:' + JSON.stringify({
    facadePresent: typeof window.satBrowser === 'object' && window.satBrowser !== null,
    bootstrapFunction: typeof window.satBrowser?.app?.bootstrap === 'function',
    signingFunction: typeof window.satBrowser?.wallet?.signPsbt === 'function',
    nodeRequirePresent: typeof window.require !== 'undefined',
    nodeProcessPresent: typeof window.process !== 'undefined'
  }));
  const { mode, endpoint }`);
}

export function buildPreloadSchedule(repeat = 2) {
  // Reuse document schedule validation and alternation; both arms load app://.
  return buildDocumentSchedule(repeat).map(({ documentMode, ...item }) => ({
    ...item, documentMode: 'app', preloadMode: documentMode === 'file' ? 'none' : 'application'
  }));
}

export function parsePreloadEvidence(line, preloadMode) {
  if (!PRELOAD_MODES.includes(preloadMode) || typeof line !== 'string' || line.length > 8192) return null;
  const match = /^STOCK_PRELOAD_READY:(\{[^\n]+\})$/.exec(line);
  if (!match) return null;
  let value;
  try { value = JSON.parse(match[1]); } catch { return null; }
  const expected = preloadMode === 'application';
  if (value?.facadePresent !== expected || value.bootstrapFunction !== expected || value.signingFunction !== expected
    || value.nodeRequirePresent !== false || value.nodeProcessPresent !== false) return null;
  return value;
}

export function parseDocumentEvidence(line, documentMode, expectedFileUrl) {
  if (!DOCUMENT_MODES.includes(documentMode) || typeof line !== 'string' || line.length > 8192) return null;
  const match = /^STOCK_DOCUMENT_READY:(\{[^\n]+\})$/.exec(line);
  if (!match) return null;
  let value;
  try { value = JSON.parse(match[1]); } catch { return null; }
  if (value?.documentMode !== documentMode || value.url !== (documentMode === 'file' ? expectedFileUrl : APP_DOCUMENT_URL)
    || value.documentRequests !== (documentMode === 'file' ? 0 : 1)
    || value.rejectedDocumentRequests !== 0) return null;
  return value;
}

export function summarizeDocumentReport(report) {
  const preloadComparison = report.config.comparison === 'preload';
  const expected = preloadComparison ? buildPreloadSchedule(report.config.repeat) : buildDocumentSchedule(report.config.repeat);
  const runs = report.runs;
  const complete = report.stoppedReason === null && !report.failure && runs.length === expected.length
    && expected.every((item, index) => ['mode', 'run', 'documentMode', ...(preloadComparison ? ['preloadMode'] : [])].every((key) => item[key] === runs[index]?.[key]))
    && runs.every((run) => run.closed === true);
  return { complete, passing: complete && runs.every((run) => run.documentValid === true && run.topologyValid === true
      && (!preloadComparison || run.preloadValid === true) && classifyStockRun(run)),
    experimentsCompleted: runs.filter(classifyExperimentCompletion).length,
    cleanExits: runs.filter(classifyCleanExit).length, expectedRawTlsActivity: runs.filter((run) => run.networkExpectationMet === true).length };
}

export async function runStockDocumentProtocol({ output, repeat = 2, comparison = 'document' } = {}, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Document diagnostic supports macOS only');
  if (typeof output !== 'string' || !path.isAbsolute(output) || output.length > 4096) throw new Error('Output must be an absolute bounded path');
  if (!['document', 'preload'].includes(comparison)) throw new TypeError('Unknown comparison');
  const preloadComparison = comparison === 'preload';
  const schedule = preloadComparison ? buildPreloadSchedule(repeat) : buildDocumentSchedule(repeat);
  const io = dependencies.fs ?? fs;
  const outputHandle = await io.open(output, 'wx', 0o600);
  const unknownChildren = new Set();
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), generatedAt: null,
    platform: process.platform, arch: process.arch, config: { comparison, repeat, modes: STOCK_MODES,
      documentModes: preloadComparison ? ['app'] : DOCUMENT_MODES, ...(preloadComparison ? { preloadModes: PRELOAD_MODES } : {}), topology: 'named-dual' },
    purpose: preloadComparison
      ? 'Matched encrypted-stock actual application preload initialization; bridge APIs observed but not invoked. No product CSP/second window, successful TLS or cookie roundtrip qualification.'
      : 'Matched encrypted-stock document/protocol diagnostic; no product preload/CSP/second window, successful TLS or cookie roundtrip qualification.',
    root: null, provenance: null, runs: [], stoppedReason: null, failure: null };
  let sink;
  const fail = (error, phase) => {
    const failure = { phase, code: String(error?.code ?? 'DIAGNOSTIC_FAILED').slice(0, 64), message: String(error?.message ?? error).slice(0, 1024) };
    if (report.failure) report.cleanupFailure = failure;
    else report.failure = failure;
  };
  try {
    const inspected = await (dependencies.preflight ?? preflightApprovedTopologyBundle)({ io });
    report.provenance = { ...inspected, signatureVerified: true, internalName: 'stock-network-shutdown' };
    report.root = await io.realpath(await io.mkdtemp(path.join(os.tmpdir(), preloadComparison ? 'satoshi-stock-preload-' : 'satoshi-stock-document-protocol-')));
    const appDirectory = path.join(report.root, 'fixture');
    const profiles = path.join(report.root, 'profiles');
    await io.mkdir(appDirectory, { mode: 0o700 });
    await io.mkdir(profiles, { mode: 0o700 });
    const metadata = JSON.stringify({ name: 'stock-network-shutdown', main: 'main.cjs' });
    await io.writeFile(path.join(appDirectory, 'package.json'), metadata, { flag: 'wx', mode: 0o600 });
    report.fixturePackageSha256 = digest(metadata);
    if (preloadComparison) {
      const stat = await io.lstat(APPLICATION_PRELOAD);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Expected bounded regular application preload source');
      const preloadBytes = await io.readFile(APPLICATION_PRELOAD);
      if (preloadBytes.length !== stat.size || preloadBytes.length > 64 * 1024) throw new Error('Application preload changed while reading');
      const copy = path.join(appDirectory, 'preload.cjs');
      await io.writeFile(copy, preloadBytes, { flag: 'wx', mode: 0o600 });
      if (digest(await io.readFile(copy)) !== digest(preloadBytes)) throw new Error('Application preload copy differs from source');
      report.applicationPreload = { source: APPLICATION_PRELOAD, bytes: preloadBytes.length, sha256: digest(preloadBytes), copiedTo: copy,
        scope: 'Unmodified source bytes copied once for both arms; only application arm configures the preload. No bridge API invocation.' };
    }
    sink = await (dependencies.startSink ?? startRawTlsSink)({ maxConnections: 128 });
    for (const item of schedule) {
      const profile = path.join(profiles, `${preloadComparison ? item.preloadMode : item.documentMode}-${item.mode}`);
      if (item.run === 1) await io.mkdir(profile, { mode: 0o700 });
      const main = preloadComparison ? stockPreloadMainSource(item.preloadMode) : stockDocumentMainSource(item.documentMode);
      const html = preloadComparison ? stockPreloadProbeHtml(item.mode, sink.endpoint) : stockProbeHtml(item.mode, sink.endpoint);
      await io.writeFile(path.join(appDirectory, 'main.cjs'), main, { mode: 0o600 });
      await io.writeFile(path.join(appDirectory, 'index.html'), html, { mode: 0o600 });
      const before = sink.connections.length;
      const result = await (dependencies.runChild ?? runChild)(inspected.executable, appDirectory, profile, item.mode, item.run, (child) => unknownChildren.add(child));
      const connections = sink.connections.slice(before).map((value) => ({ ...value }));
      const topology = parseTopologyReady(result.topologyReady);
      const document = parseDocumentEvidence(result.documentReady, item.documentMode, pathToFileURL(path.join(appDirectory, 'index.html')).href);
      Object.assign(result, item, { profile, expectedFileUrl: pathToFileURL(path.join(appDirectory, 'index.html')).href,
        rawTlsConnections: connections, rawTlsObservationOverflow: sink.observationOverflow,
        networkExpectationMet: hasExpectedRawTlsActivity(result.outcome, connections),
        topologyEvidence: topology, topologyValid: result.topologyMarkerCount === 1 && topology?.topology === 'named-dual',
        documentEvidence: document, documentValid: result.documentMarkerCount === 1 && document !== null,
        fixtureSha256: digest(html), mainSha256: digest(main) });
      if (preloadComparison) {
        result.preloadEvidence = parsePreloadEvidence(result.preloadReady, item.preloadMode);
        result.preloadValid = result.preloadMarkerCount === 1 && result.preloadEvidence !== null;
      }
      result.passed = result.topologyValid && result.documentValid && (!preloadComparison || result.preloadValid) && classifyStockRun(result);
      report.runs.push(result);
      if (!result.closed) { report.stoppedReason = 'OWNED_PROCESS_CLOSE_UNCONFIRMED'; break; }
      if (!result.documentValid || !result.topologyValid) { report.stoppedReason = 'DOCUMENT_OR_TOPOLOGY_EVIDENCE_INVALID'; break; }
      if (preloadComparison && !result.preloadValid) { report.stoppedReason = 'PRELOAD_EVIDENCE_INVALID'; break; }
    }
  } catch (error) { fail(error, 'run'); }
  finally {
    try { if (sink) await sink.close(); } catch (error) { fail(error, 'sink-close'); }
    report.generatedAt = new Date().toISOString();
    report.summary = summarizeDocumentReport(report);
    await finalizePackagedEvidence(async () => {
      try {
        const serialized = `${JSON.stringify(report, null, 2)}\n`;
        if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('Bounded diagnostic report exceeded 256 KiB');
        await outputHandle.writeFile(serialized);
        await outputHandle.sync();
      } finally { await outputHandle.close(); }
    }, async (error) => {
      (dependencies.stderr ?? process.stderr).write(`${JSON.stringify({ event: 'DOCUMENT_REPORT_FAILED',
        code: String(error?.code ?? 'REPORT_FAILED').slice(0, 64), retainedRoot: report.root,
        unknownPids: [...unknownChildren].map((child) => Number.isSafeInteger(child?.pid) ? child.pid : null) }).slice(0, 8192)}\n`);
    }, unknownChildren);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (![1, 2].includes(args.length) || !args[0].startsWith('--output=') || (args.length === 2 && args[1] !== '--preload-comparison')) {
    throw new Error('Usage: --output=/absolute/new-report.json [--preload-comparison]');
  }
  runStockDocumentProtocol({ output: args[0].slice(9), comparison: args.length === 2 ? 'preload' : 'document' }).then((report) => {
    process.stdout.write(`${JSON.stringify(report.summary)}\n`);
    if (!report.summary.passing) process.exitCode = 1;
  }, (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
