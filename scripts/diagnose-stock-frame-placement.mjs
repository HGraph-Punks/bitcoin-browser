import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finalizePackagedEvidence } from './packaged-smoke-child-lifecycle.mjs';
import { preflightApprovedTopologyBundle, parseTopologyReady } from './diagnose-stock-session-topology.mjs';
import { APP_DOCUMENT_URL, parseDocumentEvidence, parsePreloadEvidence, stockPreloadMainSource } from './diagnose-stock-document-protocol.mjs';
import { STOCK_MODES, classifyCleanExit, classifyExperimentCompletion, classifyStockRun, hasExpectedRawTlsActivity,
  runChild, startRawTlsSink, stockProbeHtml } from './diagnose-stock-network-shutdown.mjs';

export const FRAME_PLACEMENTS = Object.freeze(['top', 'opaque-child']);
export const ORD_DOCUMENT_URL = 'ord://content/fixturei0';
const APPLICATION_PRELOAD = fileURLToPath(new URL('../src/main/preload.cjs', import.meta.url));
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https: wss:; style-src 'self' 'unsafe-inline' blob: data: https: wss:; img-src 'self' blob: data: https: wss:; media-src 'self' blob: data: https: wss:; font-src 'self' data: https: wss:; connect-src 'self' blob: data: https: wss:; worker-src 'self' blob: https: wss:; child-src 'self' blob: data: https: wss:; frame-src 'self' blob: data: https: wss:; object-src 'none'; form-action https:; base-uri 'none'";
const digest = (value) => createHash('sha256').update(value).digest('hex');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reviewed frame fixture insertion point changed');
  return source.replace(before, after);
}

export function buildFrameSchedule(repeat = 2) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 2) throw new TypeError('Repeat must be 1 or 2');
  const rows = [];
  for (const mode of STOCK_MODES) for (let run = 1; run <= repeat; run += 1) {
    for (const placement of run % 2 ? FRAME_PLACEMENTS : [...FRAME_PLACEMENTS].reverse()) rows.push({ mode, run, placement });
  }
  return rows;
}

export function stockFrameMainSource() {
  let source = stockPreloadMainSource('application');
  source = replaceOnce(source, "{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }",
    "{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } },\n  { scheme: 'ord', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }");
  source = replaceOnce(source, '  let documentRequests = 0;', `  const childHtml = await require('node:fs/promises').readFile('child.html');
  let documentRequests = 0;
  let ordRequests = 0;
  let rejectedOrdRequests = 0;`);
  source = replaceOnce(source, "  process.stdout.write('STOCK_TOPOLOGY_READY:'", `  persistent.protocol.handle('ord', (request) => {
    if (request.url !== ${JSON.stringify(ORD_DOCUMENT_URL)} || request.method !== 'GET') {
      rejectedOrdRequests += 1;
      return new Response('Not found', { status: 404 });
    }
    ordRequests += 1;
    return new Response(childHtml, { status: 200, headers: {
      'content-type': 'text/html; charset=utf-8', 'content-length': String(childHtml.length),
      'content-security-policy': ${JSON.stringify(CSP)}, 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()'
    }});
  });
  process.stdout.write('STOCK_TOPOLOGY_READY:'`);
  source = replaceOnce(source, '  let quitRequested = false;', `  let quitRequested = false;
  let preloadMarkers = 0;
  let frameMarkers = 0;`);
  source = replaceOnce(source, '    if (!loadComplete || probeMarkers !== 1 || quitRequested) return;',
    '    if (!loadComplete || probeMarkers !== 1 || preloadMarkers !== 1 || frameMarkers !== 1 || quitRequested) return;');
  source = replaceOnce(source, "      if (/^STOCK_PRELOAD_READY:\\{[^\\n]+\\}$/.test(message)) process.stdout.write(message + '\\n');",
    `      if (/^STOCK_PRELOAD_READY:\\{[^\\n]+\\}$/.test(message)) { preloadMarkers += 1; process.stdout.write(message + '\\n'); maybeQuit(); }
      if (/^STOCK_FRAME_CLIENT:\\{[^\\n]+\\}$/.test(message)) {
        frameMarkers += 1;
        try {
          const value = JSON.parse(message.slice('STOCK_FRAME_CLIENT:'.length));
          process.stdout.write('STOCK_FRAME_READY:' + JSON.stringify({ ...value, relaySourceId: details.sourceId ?? null,
            ordRequests, rejectedOrdRequests }) + '\\n');
          maybeQuit();
        } catch { process.stdout.write('STOCK_FRAME_INVALID\\n'); }
      }`);
  source = replaceOnce(source, "    if (typeof message === 'string' && /^STOCK_PROBE_DONE:(?:response|rejected|opened|thrown|bounded-timeout)$/.test(message)) {",
    `    if (typeof message === 'string' && /^STOCK_PROBE_DONE:(?:response|rejected|opened|thrown|bounded-timeout)$/.test(message)) {
      process.stdout.write('STOCK_PROBE_SOURCE:' + JSON.stringify({ sourceId: details.sourceId ?? null }) + '\\n');`);
  return source;
}

function probeScript(mode, endpoint) {
  return stockProbeHtml(mode, endpoint).match(/<script>([\s\S]*)<\/script>/)[1];
}

export function stockFrameDocuments(placement, mode, endpoint) {
  if (!FRAME_PLACEMENTS.includes(placement)) throw new TypeError('Unknown frame placement');
  const preload = `console.log('STOCK_PRELOAD_READY:' + JSON.stringify({ facadePresent: typeof window.satBrowser === 'object' && window.satBrowser !== null,
    bootstrapFunction: typeof window.satBrowser?.app?.bootstrap === 'function', signingFunction: typeof window.satBrowser?.wallet?.signPsbt === 'function',
    nodeRequirePresent: typeof window.require !== 'undefined', nodeProcessPresent: typeof window.process !== 'undefined' }));`;
  if (placement === 'top') return {
    indexHtml: `<!doctype html><meta charset="utf-8"><title>Frame placement</title><script>${preload}
console.log('STOCK_FRAME_CLIENT:' + JSON.stringify({ placement: 'top', route: location.href, sourceBound: true, opaqueOrigin: false,
  facadePresent: typeof window.satBrowser === 'object', nodeRequirePresent: typeof window.require !== 'undefined', nodeProcessPresent: typeof window.process !== 'undefined' }));
${probeScript(mode, endpoint)}</script>`,
    childHtml: '<!doctype html><meta charset="utf-8"><title>Unused child</title>'
  };
  const token = 'stock-owned-frame-ready';
  return {
    indexHtml: `<!doctype html><meta charset="utf-8"><title>Frame placement</title><iframe id="probe" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock" referrerpolicy="no-referrer" src="${ORD_DOCUMENT_URL}"></iframe><script>${preload}
const frame = document.querySelector('#probe');
window.addEventListener('message', (event) => {
  if (event.data?.token !== ${JSON.stringify(token)}) return;
  if (event.source !== frame.contentWindow) {
    console.log('STOCK_FRAME_CLIENT:' + JSON.stringify({ placement: 'opaque-child', route: event.data.route ?? null, sourceBound: false,
      opaqueOrigin: event.origin === 'null', facadePresent: event.data.facadePresent, nodeRequirePresent: event.data.nodeRequirePresent,
      nodeProcessPresent: event.data.nodeProcessPresent, sandbox: frame.getAttribute('sandbox'), referrerPolicy: frame.referrerPolicy }));
    return;
  }
  console.log('STOCK_FRAME_CLIENT:' + JSON.stringify({ placement: 'opaque-child', route: event.data.route, sourceBound: true,
    opaqueOrigin: event.origin === 'null', facadePresent: event.data.facadePresent, nodeRequirePresent: event.data.nodeRequirePresent,
    nodeProcessPresent: event.data.nodeProcessPresent, sandbox: frame.getAttribute('sandbox'), referrerPolicy: frame.referrerPolicy }));
});</script>`,
    childHtml: `<!doctype html><meta charset="utf-8"><title>Opaque child</title><script>
parent.postMessage({ token: ${JSON.stringify(token)}, route: location.href, facadePresent: typeof window.satBrowser === 'object',
  nodeRequirePresent: typeof window.require !== 'undefined', nodeProcessPresent: typeof window.process !== 'undefined' }, '*');
${probeScript(mode, endpoint)}</script>`
  };
}

export function parseFrameEvidence(line, placement) {
  if (!FRAME_PLACEMENTS.includes(placement) || typeof line !== 'string' || line.length > 8192) return null;
  const match = /^STOCK_FRAME_READY:(\{[^\n]+\})$/.exec(line);
  if (!match) return null;
  let value; try { value = JSON.parse(match[1]); } catch { return null; }
  const child = placement === 'opaque-child';
  if (value?.placement !== placement || value.route !== (child ? ORD_DOCUMENT_URL : APP_DOCUMENT_URL)
    || value.relaySourceId !== APP_DOCUMENT_URL || value.sourceBound !== true
    || value.opaqueOrigin !== child || value.facadePresent !== !child || value.nodeRequirePresent !== false || value.nodeProcessPresent !== false
    || value.ordRequests !== (child ? 1 : 0) || value.rejectedOrdRequests !== 0
    || (child && (value.sandbox !== 'allow-scripts allow-forms allow-modals allow-pointer-lock' || value.referrerPolicy !== 'no-referrer'))) return null;
  return value;
}

export function parseProbeSourceEvidence(line, placement) {
  if (!FRAME_PLACEMENTS.includes(placement) || typeof line !== 'string' || line.length > 8192) return null;
  const match = /^STOCK_PROBE_SOURCE:(\{[^\n]+\})$/.exec(line);
  if (!match) return null;
  let value; try { value = JSON.parse(match[1]); } catch { return null; }
  return value?.sourceId === (placement === 'opaque-child' ? ORD_DOCUMENT_URL : APP_DOCUMENT_URL) ? value : null;
}

export function summarizeFrameReport(report) {
  const expected = buildFrameSchedule(report.config.repeat); const runs = report.runs;
  const complete = !report.failure && report.stoppedReason === null && runs.length === expected.length
    && expected.every((item, index) => ['mode', 'run', 'placement'].every((key) => item[key] === runs[index]?.[key]))
    && runs.every((run) => run.closed === true);
  return { complete, passing: complete && runs.every((run) => run.frameValid && run.probeSourceValid && run.preloadValid && run.documentValid && run.topologyValid && classifyStockRun(run)),
    experimentsCompleted: runs.filter(classifyExperimentCompletion).length, cleanExits: runs.filter(classifyCleanExit).length,
    expectedRawTlsActivity: runs.filter((run) => run.networkExpectationMet).length };
}

export async function runStockFrameMatrix({ output, repeat = 2 } = {}, dependencies = {}, definition = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Frame placement diagnostic supports macOS only');
  if (typeof output !== 'string' || !path.isAbsolute(output) || output.length > 4096) throw new Error('Output must be an absolute bounded path');
  for (const name of ['buildSchedule', 'mainSource', 'documents', 'profileKey', 'augment', 'summarize']) {
    if (typeof definition[name] !== 'function') throw new TypeError(`Frame matrix definition requires ${name}`);
  }
  const schedule = definition.buildSchedule(repeat); const io = dependencies.fs ?? fs;
  const handle = await io.open(output, 'wx', 0o600); const unknown = new Set();
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), generatedAt: null, platform: process.platform, arch: process.arch,
    config: definition.config(repeat), purpose: definition.purpose,
    root: null, provenance: null, runs: [], stoppedReason: null, failure: null };
  let sink;
  const fail = (error, phase) => { const value = { phase, code: String(error?.code ?? 'DIAGNOSTIC_FAILED').slice(0, 64), message: String(error?.message ?? error).slice(0, 1024) }; if (report.failure) report.cleanupFailure = value; else report.failure = value; };
  try {
    const inspected = await (dependencies.preflight ?? preflightApprovedTopologyBundle)({ io }); report.provenance = { ...inspected, signatureVerified: true, internalName: 'stock-network-shutdown' };
    report.root = await io.realpath(await io.mkdtemp(path.join(os.tmpdir(), definition.rootPrefix)));
    const appDirectory = path.join(report.root, 'fixture'); const profiles = path.join(report.root, 'profiles');
    await io.mkdir(appDirectory, { mode: 0o700 }); await io.mkdir(profiles, { mode: 0o700 });
    const metadata = JSON.stringify({ name: 'stock-network-shutdown', main: 'main.cjs' });
    await io.writeFile(path.join(appDirectory, 'package.json'), metadata, { flag: 'wx', mode: 0o600 }); report.fixturePackageSha256 = digest(metadata);
    const stat = await io.lstat(APPLICATION_PRELOAD); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Expected bounded regular application preload source');
    const preload = await io.readFile(APPLICATION_PRELOAD); if (preload.length !== stat.size || preload.length > 64 * 1024) throw new Error('Application preload changed while reading');
    const preloadCopy = path.join(appDirectory, 'preload.cjs');
    await io.writeFile(preloadCopy, preload, { flag: 'wx', mode: 0o600 });
    if (digest(await io.readFile(preloadCopy)) !== digest(preload)) throw new Error('Application preload copy differs from source');
    report.applicationPreload = { source: APPLICATION_PRELOAD, copiedTo: preloadCopy, bytes: preload.length, sha256: digest(preload),
      scope: definition.preloadScope };
    sink = await (dependencies.startSink ?? startRawTlsSink)({ maxConnections: 128 });
    for (const item of schedule) {
      const profile = path.join(profiles, definition.profileKey(item)); if (item.run === 1) await io.mkdir(profile, { mode: 0o700 });
      const documents = definition.documents(item, sink.endpoint); const main = definition.mainSource(item, sink.endpoint);
      await io.writeFile(path.join(appDirectory, 'main.cjs'), main, { mode: 0o600 }); await io.writeFile(path.join(appDirectory, 'index.html'), documents.indexHtml, { mode: 0o600 }); await io.writeFile(path.join(appDirectory, 'child.html'), documents.childHtml, { mode: 0o600 });
      const before = sink.connections.length; const result = await (dependencies.runChild ?? runChild)(inspected.executable, appDirectory, profile, item.mode, item.run, (child) => unknown.add(child));
      const connections = sink.connections.slice(before).map((value) => ({ ...value })); Object.assign(result, item, { profile, rawTlsConnections: connections,
        rawTlsObservationOverflow: sink.observationOverflow, networkExpectationMet: hasExpectedRawTlsActivity(result.outcome, connections),
        mainSha256: digest(main), indexSha256: digest(documents.indexHtml), childSha256: digest(documents.childHtml) });
      result.topologyEvidence = parseTopologyReady(result.topologyReady); result.topologyValid = result.topologyMarkerCount === 1 && result.topologyEvidence?.topology === 'named-dual';
      result.documentEvidence = parseDocumentEvidence(result.documentReady, 'app'); result.documentValid = result.documentMarkerCount === 1 && result.documentEvidence !== null;
      result.preloadEvidence = parsePreloadEvidence(result.preloadReady, 'application'); result.preloadValid = result.preloadMarkerCount === 1 && result.preloadEvidence !== null;
      result.frameEvidence = parseFrameEvidence(result.frameReady, item.placement); result.frameValid = result.frameMarkerCount === 1 && result.frameEvidence !== null;
      result.probeSourceEvidence = parseProbeSourceEvidence(result.probeSourceReady, item.placement);
      result.probeSourceValid = result.probeSourceMarkerCount === 1 && result.probeSourceEvidence !== null;
      await definition.augment(result, item);
      result.passed = result.topologyValid && result.documentValid && result.preloadValid && result.frameValid && result.probeSourceValid && result.variantValid !== false && classifyStockRun(result); report.runs.push(result);
      if (!result.closed) { report.stoppedReason = 'OWNED_PROCESS_CLOSE_UNCONFIRMED'; break; }
      if (!result.topologyValid || !result.documentValid || !result.preloadValid || !result.frameValid || !result.probeSourceValid || result.variantValid === false) { report.stoppedReason = definition.invalidReason ?? 'FRAME_EVIDENCE_INVALID'; break; }
    }
  } catch (error) { fail(error, 'run'); }
  finally {
    try { if (sink) await sink.close(); } catch (error) { fail(error, 'sink-close'); }
    report.generatedAt = new Date().toISOString(); report.summary = definition.summarize(report);
    await finalizePackagedEvidence(async () => { try { const value = `${JSON.stringify(report, null, 2)}\n`; if (Buffer.byteLength(value) > 256 * 1024) throw new Error('Bounded frame report exceeded 256 KiB'); await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } },
      async (error) => (dependencies.stderr ?? process.stderr).write(`${JSON.stringify({ event: 'FRAME_REPORT_FAILED', code: String(error?.code ?? 'REPORT_FAILED').slice(0, 64), retainedRoot: report.root,
        unknownPids: [...unknown].map((child) => Number.isSafeInteger(child?.pid) ? child.pid : null) }).slice(0, 8192)}\n`), unknown);
  }
  return report;
}

const framePlacementDefinition = Object.freeze({
  buildSchedule: buildFrameSchedule,
  mainSource: () => stockFrameMainSource(),
  documents: (item, endpoint) => stockFrameDocuments(item.placement, item.mode, endpoint),
  profileKey: (item) => `${item.placement}-${item.mode}`,
  augment: () => {},
  summarize: summarizeFrameReport,
  config: (repeat) => ({ repeat, modes: STOCK_MODES, placements: FRAME_PLACEMENTS, documentMode: 'app', preloadMode: 'application', topology: 'named-dual' }),
  purpose: 'Matched encrypted-stock frame-composition/probe-placement diagnostic. The arms also differ by iframe CSP/composition; not product qualification or causal proof.',
  rootPrefix: 'satoshi-stock-frame-placement-',
  preloadScope: 'Unmodified application preload bytes copied once and configured identically in both placement arms; bridge APIs observed but not invoked.',
  invalidReason: 'FRAME_EVIDENCE_INVALID'
});

export function runStockFramePlacement(options, dependencies) {
  return runStockFrameMatrix(options, dependencies, framePlacementDefinition);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); if (args.length !== 1 || !args[0].startsWith('--output=')) throw new Error('Usage: --output=/absolute/new-report.json');
  runStockFramePlacement({ output: args[0].slice(9) }).then((report) => { process.stdout.write(`${JSON.stringify(report.summary)}\n`); if (!report.summary.passing) process.exitCode = 1; },
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
