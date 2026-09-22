import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';
import { waitForStartupChildClose } from './startup-diagnostic-support.mjs';

export const STOCK_MODES = Object.freeze(['https', 'https-include', 'wss']);
export const DEFAULT_REPEAT = 2;
export const MAX_OUTPUT_BYTES = 65_536;
export const PROCESS_DEADLINE_MS = 12_000;
export const POST_KILL_CLOSE_MS = 3_000;
export const STOCK_SESSION_TOPOLOGIES = Object.freeze(['stock-single', 'named-single', 'named-dual']);

export function parseStockShutdownArgs(argv) {
  const result = { modes: [...STOCK_MODES], repeat: DEFAULT_REPEAT, output: null };
  const seen = new Set();
  for (const argument of argv) {
    const name = argument.split('=', 1)[0];
    if (seen.has(name)) throw new Error(`Duplicate argument: ${name}`);
    seen.add(name);
    if (argument.startsWith('--mode=')) result.modes = argument.slice(7).split(',');
    else if (argument.startsWith('--repeat=')) result.repeat = Number(argument.slice(9));
    else if (argument.startsWith('--output=')) {
      if (!argument.slice(9)) throw new Error('Output path must not be empty');
      result.output = path.resolve(argument.slice(9));
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.modes.length || result.modes.some((mode) => !STOCK_MODES.includes(mode))
    || new Set(result.modes).size !== result.modes.length) throw new Error('Modes must be unique reviewed stock modes');
  if (!Number.isSafeInteger(result.repeat) || result.repeat < 1 || result.repeat > 5) throw new Error('Repeat must be an integer from 1 to 5');
  return result;
}

export function stockProbeHtml(mode, endpoint) {
  if (!STOCK_MODES.includes(mode)) throw new Error('Unknown stock shutdown mode');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
    throw new Error('Stock shutdown endpoint must be loopback raw TLS');
  }
  const config = JSON.stringify({ mode, endpoint }).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Stock shutdown fixture</title><script>
(() => {
  const { mode, endpoint } = ${config};
  let finished = false;
  let cleanup = () => {};
  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    cleanup();
    console.log('STOCK_PROBE_DONE:' + outcome);
  };
  const timer = setTimeout(() => finish('bounded-timeout'), 1200);
  const done = (outcome) => { clearTimeout(timer); finish(outcome); };
  try {
    if (mode === 'wss') {
      const socket = new WebSocket(endpoint.replace('https:', 'wss:') + '/probe');
      cleanup = () => { try { socket.close(); } catch {} };
      socket.onopen = () => done('opened');
      socket.onerror = () => done('rejected');
    } else {
      const controller = new AbortController();
      cleanup = () => controller.abort();
      fetch(endpoint + '/probe', { signal: controller.signal, credentials: mode === 'https-include' ? 'include' : 'same-origin' })
        .then(() => done('response'), () => done('rejected'));
    }
  } catch { done('thrown'); }
})();
</script>`;
}

export function stockMainSource(topology = null) {
  if (topology !== null && !STOCK_SESSION_TOPOLOGIES.includes(topology)) throw new Error('Unknown stock session topology');
  const effectiveTopology = topology ?? 'stock-single';
  const partitions = effectiveTopology === 'stock-single'
    ? ['persist:stock-network-shutdown']
    : topology === 'named-single'
      ? ['persist:satoshi-browser-app']
      : ['persist:satoshi-browser-app', 'persist:satoshi-browser-wallet'];
  const topologyConfig = JSON.stringify({ topology: effectiveTopology, partitions }).replaceAll('<', '\\u003c');
  const topologyDeclaration = topology === null ? '' : `const topologyConfig = ${topologyConfig};\n`;
  const sessionSetup = topology === null
    ? `  const persistent = session.fromPartition('persist:stock-network-shutdown', { cache: true });
  persistent.setPermissionCheckHandler(() => false);
  persistent.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));`
    : `  const sessions = topologyConfig.partitions.map((partition) => ({ partition, value: session.fromPartition(partition, { cache: true }) }));
  for (const item of sessions) {
    item.value.setPermissionCheckHandler(() => false);
    item.value.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  }
  const persistent = sessions[0].value;
  process.stdout.write('STOCK_TOPOLOGY_READY:' + JSON.stringify({ topology: topologyConfig.topology, partitions: sessions.map((item) => item.partition), permissionDenied: true }) + '\\n');`;
  return `'use strict';
const { app, BrowserWindow, session } = require('electron');
const classifyDiagnostic = ${classifyStockDiagnostic.toString()};
${topologyDeclaration}app.enableSandbox();
app.whenReady().then(async () => {
${sessionSetup}
  const win = new BrowserWindow({ show: false, webPreferences: {
    session: persistent, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false
  }});
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  let loadComplete = false;
  let probeMarkers = 0;
  let quitRequested = false;
  const maybeQuit = () => {
    if (!loadComplete || probeMarkers !== 1 || quitRequested) return;
    quitRequested = true;
    process.stdout.write('STOCK_QUIT_REQUESTED:' + Date.now() + '\\n');
    setImmediate(() => app.quit());
  };
  win.webContents.on('did-finish-load', () => {
    loadComplete = true;
    process.stdout.write('STOCK_LOAD_COMPLETE\\n');
    maybeQuit();
  });
  win.webContents.on('console-message', (details) => {
    const message = details && typeof details === 'object' ? details.message : null;
    if (typeof message === 'string' && message.length <= 4096) {
      const kind = classifyDiagnostic(message);
      if (kind) process.stdout.write('STOCK_DIAGNOSTIC:' + kind + '\\n');
    }
    if (typeof message === 'string' && /^STOCK_PROBE_DONE:(?:response|rejected|opened|thrown|bounded-timeout)$/.test(message)) {
      probeMarkers += 1;
      process.stdout.write(message + '\\n');
      if (probeMarkers > 1) process.stdout.write('STOCK_PROBE_DUPLICATE\\n');
      maybeQuit();
    }
  });
  win.webContents.on('preload-error', () => process.stdout.write('STOCK_DIAGNOSTIC:preload-error\\n'));
  await win.loadFile('index.html');
  process.stdout.write('STOCK_READY\\n');
}).catch(() => app.exit(2));
setTimeout(() => app.exit(3), 5000).unref();
`;
}

export function classifyStockRun(run) {
  return classifyExperimentCompletion(run) && classifyCleanExit(run) && run.networkExpectationMet === true
    && run.diagnostics?.recognizedCount === 0
    && run.outputTruncated === false && run.rawTlsObservationOverflow === false;
}

export function classifyExperimentCompletion(run) {
  return run.ready === true && run.loadCompleted === true && run.markerCount === 1
    && run.operationCompleted === true && !['bounded-timeout', 'thrown'].includes(run.outcome)
    && run.closed === true;
}

export function classifyCleanExit(run) {
  return run.closed === true
    && run.code === 0 && run.signal === null && run.forced === false
    && run.spawnError === null && run.killError === null;
}

export function classifyStockDiagnostic(line) {
  if (/sandboxed_renderer\.bundle\.js.*(?:startupData|null|script failed)/i.test(line)) return 'sandboxed-renderer-startup';
  if (/binding\.startupData[^\n]{0,160}(?:is null|null)/i.test(line)) return 'null-startup-data';
  if (/(?:Unable to load preload script|Error occurred while loading preload script|preload-error)/i.test(line)) return 'preload-error';
  return null;
}

export function createStockOutputCollector(stream, onLine) {
  let totalBytes = 0;
  let retainedBytes = 0;
  let truncated = false;
  let pending = '';
  stream.on('data', (chunk) => {
    totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + chunk.length);
    const remaining = MAX_OUTPUT_BYTES - retainedBytes;
    const retained = chunk.subarray(0, Math.max(0, remaining));
    retainedBytes += retained.length;
    if (retained.length < chunk.length) truncated = true;
    pending += retained.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (pending) onLine(pending);
    pending = '';
  });
  return { get totalBytes() { return totalBytes; }, get retainedBytes() { return retainedBytes; }, get truncated() { return truncated; } };
}

export async function startRawTlsSink({ maxConnections = 32 } = {}) {
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 32 || maxConnections > 128) {
    throw new Error('Raw TLS observation limit must be an integer from 32 to 128');
  }
  const connections = [];
  const sockets = new Set();
  let observationOverflow = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const observation = { clientHello: false, bytes: 0 };
    if (connections.length < maxConnections) connections.push(observation);
    else observationOverflow = true;
    socket.setTimeout(1500, () => socket.destroy());
    socket.once('data', (data) => {
      observation.bytes = Math.min(data.length, 65_536);
      observation.clientHello = data[0] === 22;
      socket.destroy();
    });
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    endpoint: `https://127.0.0.1:${server.address().port}`,
    maxConnections,
    connections,
    get observationOverflow() { return observationOverflow; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

export async function runChild(executable, appDirectory, profile, mode, run, onUnconfirmedClose = null) {
  const startedAt = Date.now();
  const child = spawn(executable, [appDirectory, `--user-data-dir=${profile}`, '--no-first-run', '--disable-breakpad'], {
    cwd: appDirectory,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let ready = false;
  let outcome = null;
  let loadCompleted = false;
  let markerCount = 0;
  let quitRequestedAt = null;
  let quitRequestedObservedAt = null;
  let topologyReady = null;
  let topologyMarkerCount = 0;
  let documentReady = null;
  let documentMarkerCount = 0;
  let preloadReady = null;
  let preloadMarkerCount = 0;
  let frameReady = null;
  let frameMarkerCount = 0;
  let probeSourceReady = null;
  let probeSourceMarkerCount = 0;
  let walletRegistrationReady = null;
  let walletRegistrationMarkerCount = 0;
  let requestPolicyReady = null;
  let requestPolicyMarkerCount = 0;
  const diagnostics = [];
  let diagnosticCount = 0;
  const stdout = createStockOutputCollector(child.stdout, (line) => {
    const diagnostic = /^STOCK_DIAGNOSTIC:(sandboxed-renderer-startup|null-startup-data|preload-error)$/.exec(line);
    if (diagnostic) {
      diagnosticCount += 1;
      if (diagnostics.length < 32) diagnostics.push(diagnostic[1]);
    }
    if (line === 'STOCK_READY') ready = true;
    if (line === 'STOCK_LOAD_COMPLETE') loadCompleted = true;
    if (line.startsWith('STOCK_TOPOLOGY_READY:')) { topologyMarkerCount += 1; if (topologyMarkerCount === 1) topologyReady = line; }
    if (line.startsWith('STOCK_DOCUMENT_READY:')) { documentMarkerCount += 1; if (documentMarkerCount === 1) documentReady = line; }
    if (line.startsWith('STOCK_PRELOAD_READY:')) { preloadMarkerCount += 1; if (preloadMarkerCount === 1) preloadReady = line; }
    if (line.startsWith('STOCK_FRAME_READY:')) { frameMarkerCount += 1; if (frameMarkerCount === 1) frameReady = line; }
    if (line.startsWith('STOCK_PROBE_SOURCE:')) { probeSourceMarkerCount += 1; if (probeSourceMarkerCount === 1) probeSourceReady = line; }
    if (line.startsWith('STOCK_WALLET_REGISTRATION:')) { walletRegistrationMarkerCount += 1; if (walletRegistrationMarkerCount === 1) walletRegistrationReady = line; }
    if (line.startsWith('STOCK_REQUEST_POLICY:')) { requestPolicyMarkerCount += 1; if (requestPolicyMarkerCount === 1) requestPolicyReady = line; }
    const match = /^STOCK_PROBE_DONE:(response|rejected|opened|thrown|bounded-timeout)$/.exec(line);
    if (match) { markerCount += 1; if (markerCount === 1) outcome = match[1]; }
    const quit = /^STOCK_QUIT_REQUESTED:(\d+)$/.exec(line);
    if (quit) { quitRequestedAt = Number(quit[1]); quitRequestedObservedAt = Date.now(); }
  });
  const stderr = createStockOutputCollector(child.stderr, (line) => {
    const kind = classifyStockDiagnostic(line);
    if (kind) {
      diagnosticCount += 1;
      if (diagnostics.length < 32) diagnostics.push(kind);
    }
  });
  const terminal = await waitForStartupChildClose(child, PROCESS_DEADLINE_MS, POST_KILL_CLOSE_MS);
  const closedAt = Date.now();
  const result = {
    mode, run, pid: child.pid ?? null, ready, topologyReady, topologyMarkerCount, documentReady, documentMarkerCount,
    preloadReady, preloadMarkerCount, frameReady, frameMarkerCount, probeSourceReady, probeSourceMarkerCount,
    walletRegistrationReady, walletRegistrationMarkerCount, loadCompleted, markerCount,
    requestPolicyReady, requestPolicyMarkerCount,
    operationCompleted: outcome !== null, outcome, quitRequestedAt,
    stopDurationMs: quitRequestedObservedAt === null ? null : closedAt - quitRequestedObservedAt,
    durationMs: closedAt - startedAt, code: terminal.code, signal: terminal.signal,
    forced: terminal.forced, closed: terminal.closeConfirmed, spawnError: terminal.spawnError,
    killError: terminal.killError,
    diagnostics: { recognizedCount: diagnosticCount, kinds: [...new Set(diagnostics)], overflow: diagnosticCount > diagnostics.length },
    outputBytes: {
      stdout: { total: stdout.totalBytes, retained: stdout.retainedBytes },
      stderr: { total: stderr.totalBytes, retained: stderr.retainedBytes }
    },
    outputTruncated: stdout.truncated || stderr.truncated
  };
  result.passed = classifyStockRun(result);
  if (!result.closed && typeof onUnconfirmedClose === 'function') onUnconfirmedClose(child);
  return result;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
async function hashFile(filename) {
  try { return sha256(await fs.readFile(filename)); } catch (error) { return { unavailable: error?.code ?? 'READ_FAILED' }; }
}

export function hasExpectedRawTlsActivity(outcome, connections) {
  if (!['rejected', 'opened', 'response'].includes(outcome)) return false;
  return Array.isArray(connections) && connections.some((item) => item.clientHello === true && item.bytes > 0);
}

export async function runStockNetworkShutdown(options) {
  if (process.platform !== 'darwin') throw new Error('Stock shutdown diagnostic currently supports macOS only');
  const validated = parseStockShutdownArgs([
    `--mode=${options.modes.join(',')}`, `--repeat=${options.repeat}`,
    ...(options.output ? [`--output=${options.output}`] : [])
  ]);
  let outputHandle = null;
  if (validated.output) outputHandle = await fs.open(validated.output, 'wx', 0o600);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-stock-network-shutdown-'));
  const appDirectory = path.join(root, 'app');
  const require = createRequire(import.meta.url);
  const executable = require('electron');
  const electronPackage = JSON.parse(await fs.readFile(require.resolve('electron/package.json'), 'utf8'));
  const fuseWire = await getCurrentFuseWire(path.resolve(executable, '..', '..', '..'));
  const cookieEncryptionEnabled = fuseWire[FuseV1Options.EnableCookieEncryption] === FuseState.ENABLE;
  const sink = await startRawTlsSink();
  const cases = [];
  let allChildrenClosed = true;
  let launchInProgress = false;
  let stoppedReason = null;
  try {
    await fs.mkdir(appDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'stock-network-shutdown', main: 'main.cjs' }), { mode: 0o600 });
    await fs.writeFile(path.join(appDirectory, 'main.cjs'), stockMainSource(), { mode: 0o600 });
    for (const mode of validated.modes) {
      const profile = path.join(root, `profile-${mode}`);
      await fs.mkdir(profile, { mode: 0o700 });
      const launches = [];
      cases.push({ mode, launches });
      for (let run = 1; run <= validated.repeat; run += 1) {
        const fixture = stockProbeHtml(mode, sink.endpoint);
        await fs.writeFile(path.join(appDirectory, 'index.html'), fixture, { mode: 0o600 });
        const before = sink.connections.length;
        launchInProgress = true;
        const result = await runChild(executable, appDirectory, profile, mode, run);
        launchInProgress = false;
        result.rawTlsConnections = sink.connections.slice(before).map((item) => ({ ...item }));
        result.rawTlsObservationOverflow = sink.observationOverflow;
        result.networkExpectationMet = hasExpectedRawTlsActivity(result.outcome, result.rawTlsConnections);
        result.fixtureSha256 = sha256(fixture);
        result.passed = classifyStockRun(result);
        launches.push(result);
        allChildrenClosed &&= result.closed;
        if (!result.closed) {
          stoppedReason = 'OWNED_PROCESS_CLOSE_UNCONFIRMED';
          break;
        }
      }
      if (stoppedReason) break;
    }
  } finally {
    await sink.close();
    if (allChildrenClosed && !launchInProgress) await fs.rm(root, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    purpose: 'Stock Electron persistent-session shutdown discrimination; not beta qualification',
    security: 'Sandbox/context isolation/web security preserved; persistent partition with unmodified stock fuses, whose cookie-encryption state is recorded separately. All permission checks and requests denied; raw loopback TLS sink installs no certificate or trust exception; no credentials inspected or modified. Stock defaults are not the hardened product security configuration.',
    runtime: {
      executable,
      electronVersion: electronPackage.version,
      cookieEncryptionEnabled,
      executableSha256: await hashFile(executable),
      frameworkSha256: process.platform === 'darwin'
        ? await hashFile(path.join(executable, '..', '..', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'))
        : { unavailable: 'NOT_DARWIN' },
      mainFixtureSha256: sha256(stockMainSource())
    },
    retainedRoot: allChildrenClosed && !launchInProgress ? null : root,
    stoppedReason,
    cases,
    summary: {
      total: cases.reduce((count, item) => count + item.launches.length, 0),
      passing: cases.flatMap((item) => item.launches).filter((item) => item.passed).length,
      forced: cases.flatMap((item) => item.launches).filter((item) => item.forced).length,
      complete: !stoppedReason && !launchInProgress && cases.length === validated.modes.length
        && cases.every((item) => item.launches.length === validated.repeat && item.launches.every((run) => run.closed)),
      cleanExits: cases.flatMap((item) => item.launches).filter(classifyCleanExit).length,
      experimentsCompleted: cases.flatMap((item) => item.launches).filter(classifyExperimentCompletion).length,
      expectedRawTlsActivity: cases.flatMap((item) => item.launches).filter((item) => item.networkExpectationMet).length
    }
  };
  if (outputHandle) {
    await outputHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = null;
  }
  return report;
}

async function main() {
  const options = parseStockShutdownArgs(process.argv.slice(2));
  const report = await runStockNetworkShutdown(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.complete || report.summary.passing !== report.summary.total) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? 'Stock shutdown diagnostic failed'}\n`);
    process.exitCode = 1;
  });
}
