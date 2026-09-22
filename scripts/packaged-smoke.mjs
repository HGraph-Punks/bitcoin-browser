import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHostileNetworkFixture } from '../tests/fixtures/hostile-network.mjs';
import { readShellDocumentLoaded } from './packaged-startup-readiness.mjs';
import { finalizePackagedEvidence, observePackagedChild, requestWindowsWindowClose, requireConfirmedChildClose, shutdownPackagedChild } from './packaged-smoke-child-lifecycle.mjs';
import { createPackagedOutput } from './packaged-smoke-output.mjs';
import { sampleOwnedProcess } from './packaged-smoke-sampler.mjs';
import { findPackagedExecutable, packagedArtifactDirectory } from './packaged-executable.mjs';
import { readBackPackagedLibraryChecks, runPackagedLibraryChecks } from './packaged-library-checks.mjs';
import { runPackagedSettingsNavigationChecks } from './packaged-settings-navigation-checks.mjs';
import { runPackagedSettingsControlChecks } from './packaged-settings-controls.mjs';
import { createDisabledEmptyProviderDraft, runPackagedProviderControlChecks, verifyDisabledEmptyProviderDraftAfterRestart } from './packaged-provider-controls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = path.join(root, 'release');
const keepProfile = process.argv.includes('--keep-profile');
const sampleSlowShutdown = process.argv.includes('--sample-slow-shutdown');
const distributionBuild = process.argv.includes('--distribution');
const unsignedWindowsBeta = process.argv.includes('--unsigned-windows-beta');
const unsignedMacosBeta = process.argv.includes('--unsigned-macos-beta');
const artifactDirectory = packagedArtifactDirectory(releaseDirectory, { distribution: distributionBuild, unsignedWindowsBeta, unsignedMacosBeta });
const executableArgument = process.argv.find((argument) => argument.startsWith('--executable='))?.slice('--executable='.length);
const reportArgument = process.argv.find((argument) => argument.startsWith('--report='))?.slice('--report='.length);
if (reportArgument && !/^packaged-smoke-[a-zA-Z0-9-]+\.json$/.test(reportArgument)) throw new Error('Invalid packaged smoke report basename');
const reportFile = path.join(releaseDirectory, reportArgument ?? 'packaged-smoke-report.json');
const startupTimeoutMs = 30_000;
const stepTimeoutMs = 15_000;
const allProcessOutput = createPackagedOutput();
const allRendererEvents = [];
const allStops = [];
const unconfirmedChildren = new Set();
let launchSequence = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactJson(value) {
  if (Array.isArray(value)) return `[${value.map(exactJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${exactJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function decideProfileRetention(explicitKeep, stops) {
  if (explicitKeep) return { retained: true, reason: 'explicit-keep-profile' };
  if (Array.isArray(stops) && stops.some((entry) => entry?.closeConfirmed === false)) return { retained: true, reason: 'owned-child-close-unconfirmed' };
  const sampled = Array.isArray(stops) && stops.some((entry) => typeof entry?.nativeStackSample?.file === 'string' && entry.nativeStackSample.file.length > 0);
  if (sampled) return { retained: true, reason: 'native-stack-sample-recorded' };
  return { retained: false, reason: 'no-retained-native-sample' };
}

async function findExecutable() {
  if (executableArgument) return path.resolve(executableArgument);
  return findPackagedExecutable(artifactDirectory);
}

async function seedWalletFixture(profile) {
  const extensionPath = await fs.realpath(path.join(root, 'tests', 'fixtures', 'wallet-extension'));
  const stateDirectory = path.join(profile, 'state');
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDirectory, 'state.json'), `${JSON.stringify({
    schemaVersion: 3,
    settings: { localOnly: true },
    // Keep this deterministic fixture run off public providers from the first
    // main-process health timer onward. Real-provider compatibility is separate.
    providers: [],
    extensions: [{
      id: 'packaged-smoke-wallet',
      name: 'Packaged smoke wallet',
      version: '1.0.0',
      path: extensionPath,
      manifestVersion: 3,
      installedAt: new Date(0).toISOString()
    }]
  })}\n`, { mode: 0o600 });
}

async function seedLegacyProviderFixture(profile, provider) {
  const statePath = path.join(profile, 'state', 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert(Array.isArray(state.providers), 'Legacy provider fixture requires an existing provider configuration list');
  assert(!state.providers.some((item) => item.id === provider.id || item.name === provider.name), 'Legacy provider fixture id or name already exists');
  state.providers.push(provider);
  await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const written = JSON.parse(await fs.readFile(statePath, 'utf8')).providers.find((item) => item.id === provider.id);
  assert(JSON.stringify(written) === JSON.stringify(provider), 'Legacy provider fixture was not seeded exactly');
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startProviderFixtures() {
  const requests = [];
  const servers = [];
  const providers = [];
  const modes = new Map();
  for (const [index, label] of ['primary', 'fallback'].entries()) {
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const mode = modes.get(`${label}:${pathname}`) ?? 200;
      const observation = { sequence: requests.length, provider: label, path: pathname, mode, closed: false, completed: false };
      requests.push(observation);
      response.once('close', () => { observation.closed = true; observation.completed = response.writableEnded; });
      if (mode === 'timeout') return; // Client deadline closes this bounded fixture request.
      response.setHeader('content-type', 'application/json');
      response.statusCode = mode;
      if (mode !== 200) return response.end(JSON.stringify({ error: `fixture HTTP ${mode}` }));
      if (pathname === '/r/blockheight') return response.end('840000');
      if (pathname === '/r/blockhash') return response.end(JSON.stringify('b'.repeat(64)));
      const sat = pathname.match(/^\/r\/sat\/(\d+)$/)?.[1];
      if (sat) return response.end(JSON.stringify({ number: sat, name: `${label}-${sat}`, rarity: 'common', ids: [] }));
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'fixture route not found' }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    servers.push(server);
    providers.push({ id: `beta-http-${label}`, name: `HTTP ${label}`, type: 'ord-server', network: 'mainnet',
      baseUrl: `http://127.0.0.1:${server.address().port}`, enabled: true, priority: index,
      local: true, capabilities: ['sat', 'ord-recursion'] });
  }
  return {
    providers, requests, modes,
    async close() {
      await Promise.all(servers.map((server) => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })));
    }
  };
}

async function navigateShell(cdp, input, expectedText) {
  await cdp.evaluate(`(() => {
    const input = document.querySelector('#omnibox');
    input.value = ${JSON.stringify(input)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  let lastSnapshot;
  try {
    return await poll(async () => (lastSnapshot = await cdp.evaluate(`(() => ({
    busy: document.querySelector('#app')?.getAttribute('aria-busy'),
    loading: document.querySelector('#page-loading')?.classList.contains('hidden') === false,
    target: document.querySelector('#omnibox')?.value,
    page: document.querySelector('#page')?.innerText,
    network: document.querySelector('#network-status')?.textContent,
    cache: document.querySelector('#cache-status')?.textContent
  }))()`)), (value) => value.busy === 'false' && value.loading === false && value.page?.includes(expectedText), stepTimeoutMs, `rendered ${input}`);
  } catch (error) {
    error.evidence = { expectedText, lastSnapshot: lastSnapshot && { ...lastSnapshot, page: lastSnapshot.page?.slice(0, 4096) } };
    throw error;
  }
}

async function poll(action, predicate, timeoutMs = stepTimeoutMs, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools discovery returned HTTP ${response.status}`);
  return response.json();
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.contexts = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(`${message.error.message}: ${message.error.data ?? ''}`));
        else waiter.resolve(message.result);
        return;
      }
      this.events.push(message);
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params.context;
        if (context.auxData?.isDefault && context.auxData?.frameId) this.contexts.set(context.auxData.frameId, context.id);
      }
      if (message.method === 'Runtime.executionContextDestroyed') {
        for (const [frameId, contextId] of this.contexts) if (contextId === message.params.executionContextId) this.contexts.delete(frameId);
      }
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
    return this;
  }

  send(method, params = {}, timeoutMs = stepTimeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, contextId) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...(contextId ? { contextId } : {})
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Renderer evaluation failed');
    }
    return response.result?.value;
  }

  close() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.socket?.close();
  }
}

function flattenFrames(frameTree, output = []) {
  output.push(frameTree.frame);
  for (const child of frameTree.childFrames ?? []) flattenFrames(child, output);
  return output;
}

async function readFixtureFrame(instance, cdp, needle, expression, predicate) {
  const topology = await poll(async () => {
    const frames = flattenFrames((await cdp.send('Page.getFrameTree')).frameTree);
    const list = await targets(instance.port);
    return { frame: frames.find((item) => item.url.includes(needle)), target: list.find((item) => item.url.includes(needle)) };
  }, (value) => value.frame || value.target, stepTimeoutMs, 'fixture frame topology');
  let connection = cdp;
  let contextId;
  if (topology.frame) {
    contextId = await poll(() => cdp.contexts.get(topology.frame.id), Number.isInteger, stepTimeoutMs, 'fixture context');
  } else {
    connection = await new CdpConnection(topology.target.webSocketDebuggerUrl).open();
  }
  try { return await poll(() => connection.evaluate(expression, contextId), predicate, stepTimeoutMs, 'fixture result'); }
  catch (error) {
    error.evidence = { frameUrl: topology.frame?.url ?? topology.target?.url,
      snapshot: await connection.evaluate('({ url: location.href, text: document.body?.innerText?.slice(0, 4096), result: window.networkFixtureResult ?? null })', contextId).catch(() => null) };
    throw error;
  }
  finally { if (connection !== cdp) connection.close(); }
}

async function launch(executable, profile, port) {
  const launchId = ++launchSequence;
  const spawnedAt = Date.now();
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-breakpad'
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SATOSHI_BROWSER_ENABLE_WALLET_SIGNING: '1', ELECTRON_ENABLE_LOGGING: '1' }
  });
  const childObservation = observePackagedChild(child);
  const output = allProcessOutput.start(launchId, child.pid);
  const collect = (source, chunk) => output.append(source, chunk);
  child.stdout?.on('data', (chunk) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk) => collect('stderr', chunk));
  let cdp;
  try {
    // Early debugger runtime enablement can materialize an empty context.
    // Observe the application's passive document-load log before any CDP HTTP
    // request. This does not delay application navigation or waive bootstrap
    // errors: all output and early lifecycle diagnostics remain failing gates.
    await poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const error = new Error(`Packaged process exited before shell document load (${child.exitCode ?? child.signalCode})`);
        error.fatal = true;
        throw error;
      }
      return readShellDocumentLoaded(path.join(profile, 'logs', 'satoshi-browser.jsonl'), child.pid, spawnedAt);
    }, Boolean, startupTimeoutMs, 'passive shell document-load record before CDP');
    const page = await poll(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          const error = new Error(`Packaged process exited during startup (${child.exitCode ?? child.signalCode})`);
          error.fatal = true;
          throw error;
        }
        return targets(port);
      },
      (list) => list.find((target) => target.type === 'page' && target.url === 'app://app/renderer/index.html'),
      startupTimeoutMs,
      'packaged renderer target'
    ).then((list) => list.find((target) => target.type === 'page' && target.url === 'app://app/renderer/index.html'));
    cdp = await new CdpConnection(page.webSocketDebuggerUrl).open();
    await poll(
      () => cdp.evaluate(`({ busy: document.querySelector('#app')?.getAttribute('aria-busy'), page: document.querySelector('#page')?.children.length ?? 0, api: Boolean(window.satBrowser) })`),
      (value) => value?.busy === 'false' && value.page > 0 && value.api,
      startupTimeoutMs,
      'application bootstrap'
    );
    return { child, childObservation, cdp, output, port, launchId, profile };
  } catch (error) {
    await stop({ child, childObservation, cdp, launchId, profile }, { expectClean: false });
    const captured = output.text.slice(-32_000).trim();
    throw new Error(`${error.message}${captured ? `\nPackaged process output:\n${captured}` : ''}`);
  }
}

async function sampleOwnedShutdown(instance) {
  const { child, profile, launchId } = instance;
  if (process.platform !== 'darwin' || !profile || child.exitCode !== null || child.signalCode !== null) return null;
  assert(Number.isSafeInteger(child.pid) && child.pid > 0, 'Invalid owned packaged PID for stack sampling');
  const file = path.join(profile, `shutdown-stack-launch-${launchId}-pid-${child.pid}.txt`);
  assert(!(await exists(file)), 'Refusing to overwrite an existing shutdown stack sample');
  // Stack-only, one-second sampling of this exact spawned fixture process. No
  // memory dump, arbitrary PID discovery, credentials, or remote upload.
  const sampled = await sampleOwnedProcess(child.pid, file);
  if (!sampled.result.closeConfirmed) unconfirmedChildren.add(sampled.child);
  let readback = null;
  let readbackError = null;
  // A sampler that still owns the file can keep changing it. Preserve its path
  // without reading or claiming a stable snapshot until close is confirmed.
  if (sampled.result.closeConfirmed) {
    try {
      const stat = await fs.lstat(file);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'Native sample is not an owned regular file');
      assert(stat.size > 0 && stat.size <= 8 * 1024 * 1024, 'Native sample exceeded its readback bound or was empty');
      await fs.chmod(file, 0o600);
      const bytes = await fs.readFile(file);
      assert(bytes.length === stat.size, 'Native sample changed during readback');
      readback = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mode: '0600' };
    } catch (error) { readbackError = error.code ?? error.message; }
  }
  return { ...sampled.result, readback, readbackError };
}

async function stop(instance, { expectClean = true, fatalOnUnconfirmed = true } = {}) {
  instance?.cdp?.close();
  const child = instance?.child;
  if (!child || instance.stopRecorded) return;
  const started = Date.now();
  let sampleTimer;
  let sampleResult = Promise.resolve(null);
  if (sampleSlowShutdown && !instance.childObservation?.closeConfirmed) sampleTimer = setTimeout(() => {
    sampleResult = sampleOwnedShutdown(instance).catch((error) => ({ error: error.message }));
  }, 2000);
  const closure = await shutdownPackagedChild(child, instance.childObservation ?? observePackagedChild(child),
    process.platform === 'win32' ? { requestClose: () => requestWindowsWindowClose(child) } : {});
  if (!closure.closeConfirmed) unconfirmedChildren.add(child);
  clearTimeout(sampleTimer);
  instance.stopRecorded = true;
  let shutdownEvents = [];
  let shutdownLogError = null;
  if (instance.profile) {
    try {
      const log = await fs.readFile(path.join(instance.profile, 'logs', 'satoshi-browser.jsonl'), 'utf8');
      shutdownEvents = log.split('\n').filter(Boolean).flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.event === 'app.shutdown' && entry.pid === child.pid ? [entry] : [];
        } catch { return []; }
      });
    } catch (error) { shutdownLogError = error.code ?? error.message; }
  }
  const nativeStackSample = await sampleResult;
  allStops.push({ launch: instance.launchId, pid: child.pid, durationMs: Date.now() - started,
    exitCode: closure.code, signalCode: closure.signal, forced: closure.forced, expectClean,
    closeConfirmed: closure.closeConfirmed, spawnError: closure.spawnError, killError: closure.killError,
    initialSignalError: closure.initialSignalError, shutdownEvents, shutdownLogError, nativeStackSample });
  if (fatalOnUnconfirmed) {
    requireConfirmedChildClose(closure);
    if (nativeStackSample?.closeConfirmed === false) requireConfirmedChildClose(nativeStackSample);
  }
}

function processExists(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Invalid fixture process ID');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function lifecycleService(id, mode = 'wait') {
  return { id, name: `Lifecycle ${mode}`, executable: process.execPath,
    args: [path.join(root, 'tests', 'fixtures', 'service-lifecycle.cjs'), mode],
    cwd: root, enabled: true, autoStart: false };
}

async function captureApi(cdp, promiseExpression) {
  return cdp.evaluate(`(async () => {
    try { return { ok: true, value: await (${promiseExpression}) }; }
    catch (error) { return { ok: false, error: { name: error?.name, code: error?.code, message: error?.message, status: error?.status, retryable: error?.retryable, details: error?.details ?? null } }; }
  })()`);
}

const results = [];
async function check(name, task) {
  const started = Date.now();
  try {
    const details = await task();
    results.push({ name, ok: true, durationMs: Date.now() - started, details });
    console.log(`PASS  ${name}`);
    return details;
  } catch (error) {
    results.push({ name, ok: false, durationMs: Date.now() - started, error: error.stack || error.message, ...(error.evidence ? { details: error.evidence } : {}) });
    console.error(`FAIL  ${name}: ${error.message}`);
    if (error.fatal) throw error;
    return null;
  }
}

const executable = await findExecutable();
if (reportArgument && await exists(reportFile)) throw new Error('Named smoke report already exists; choose a fresh --report basename');
const asarFile = process.platform === 'darwin'
  ? path.resolve(path.dirname(executable), '../Resources/app.asar')
  : path.join(path.dirname(executable), 'resources/app.asar');
const asarSha256 = crypto.createHash('sha256').update(await fs.readFile(asarFile)).digest('hex');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-browser-packaged-smoke-'));
let instance;
let walletExtensionRuntimeId;
let providerFixture;
let libraryExpectation;
let retainedLegacyProvider;
let retainedDisabledDraft;
const libraryTargets = [{ input: 'sat:991001', expectedText: '991001' }, { input: 'sat:991002', expectedText: '991002' }];

try {
  await seedWalletFixture(profile);
  const firstPort = await reservePort();
  instance = await launch(executable, profile, firstPort);
  let cdp = instance.cdp;

  await check('packaged shell bootstraps without Node authority or overflow', async () => {
    const value = await cdp.evaluate(`(() => ({
      bootstrap: window.satBrowser ? true : false,
      node: typeof window.process,
      require: typeof window.require,
      webviews: document.querySelectorAll('webview').length,
      busy: document.querySelector('#app')?.getAttribute('aria-busy'),
      viewport: { innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
      application: null
    }))()`);
    value.application = await cdp.evaluate(`window.satBrowser.app.bootstrap().then((value) => value.application)`);
    assert(value.bootstrap && value.busy === 'false', 'shell did not finish bootstrapping');
    assert(value.application?.packaged === true, 'runtime does not identify as packaged');
    assert(value.application.platform === process.platform && value.application.arch === process.arch, 'runtime does not match the native test platform and architecture');
    assert(value.node === 'undefined' && value.require === 'undefined' && value.webviews === 0, 'renderer exposes privileged authority');
    assert(value.viewport.scrollWidth <= value.viewport.clientWidth, `horizontal overflow: ${value.viewport.scrollWidth}px > ${value.viewport.clientWidth}px`);
    return value;
  });

  await check('responsive shell remains horizontally bounded at minimum and high-zoom-equivalent widths', async () => {
    const samples = [];
    for (const width of [1024, 740, 480, 370]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
      samples.push(await cdp.evaluate(`(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const offenders = [...document.querySelectorAll('*')].map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            element: [node.tagName.toLowerCase(), node.id ? '#' + node.id : '', node.classList.length ? '.' + [...node.classList].join('.') : ''].join(''),
            left: Math.round(rect.left * 10) / 10,
            right: Math.round(rect.right * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            scrollWidth: node.scrollWidth
          };
        }).filter((item) => item.left < -0.5 || item.right > viewportWidth + 0.5).slice(0, 20);
        return { width: viewportWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, offenders };
      })()`));
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    for (const sample of samples) {
      assert(sample.scrollWidth <= sample.width && sample.bodyWidth <= sample.width, `horizontal overflow at ${sample.width}px: document=${sample.scrollWidth}, body=${sample.bodyWidth}, offenders=${JSON.stringify(sample.offenders)}`);
    }
    return samples;
  });

  await check('Settings section controls honor live reduced motion and continue keyboard focus at the destination',
    () => runPackagedSettingsNavigationChecks({ cdp, poll, assert }));

  await check('Settings controls commit valid values, reject invalid bounds, and restore authoritative state',
    () => runPackagedSettingsControlChecks({ cdp, poll, assert }));

  await check('IPC rejects preserve structured application error metadata', async () => {
    const response = await captureApi(cdp, `window.satBrowser.navigation.parse('tx:not-a-transaction-id')`);
    assert(!response.ok, 'invalid transaction unexpectedly parsed');
    assert(response.error.code === 'INVALID_TARGET', `unexpected code ${response.error.code}`);
    assert(response.error.status === 400 && response.error.retryable === false, 'status/retryability did not cross contextBridge');
    assert(Object.hasOwn(response.error, 'details'), 'details field missing from IPC error');
    return response.error;
  });

  await check('canonical recursive navigation is stable', async () => {
    const parsed = await cdp.evaluate(`window.satBrowser.navigation.parse('/r/blockheight')`);
    assert(parsed.kind === 'recursive' && parsed.canonical === 'ord://r/blockheight', `unexpected canonical ${parsed.canonical}`);
    return parsed;
  });

  await check('deterministic mock provider resolves one entity plus offline cache hit and miss', async () => {
    const response = await cdp.evaluate(`(async () => {
      const api = window.satBrowser;
      const provider = {
        id: 'beta-smoke-mock', name: 'Beta smoke mock', type: 'mock', network: 'mainnet', baseUrl: '', enabled: true, priority: 0,
        capabilities: ['ord-recursion','inscription','inscription-number','sat','block','transaction','transaction-raw','output','satpoint','address','rune']
      };
      await api.providers.upsert(provider, {});
      await api.providers.preferred(provider.id);
      await api.settings.update({ localOnly: true, contentNetworkPolicy: 'blocked', offlineMode: false });
      const online = await api.navigation.resolve('sat:0');
      await api.settings.update({ offlineMode: true });
      const cached = await api.navigation.resolve('sat:0');
      let miss;
      try { await api.navigation.resolve('sat:1'); } catch (error) { miss = { code: error.code, status: error.status, retryable: error.retryable }; }
      await api.settings.update({ offlineMode: false });
      return { online, cached, miss, cache: await api.cache.stats() };
    })()`);
    assert(response.online.entity?.summary?.sat === '0', 'online sat resolution was not normalized');
    assert(response.cached.cache === 'hit', `offline resolution was ${response.cached.cache}`);
    assert(response.miss?.code === 'OFFLINE_CACHE_MISS' && response.miss.status === 503, 'offline cache miss contract failed');
    assert(response.cache.entries >= 1, 'entity cache was not populated');
    return response;
  });

  await check('sat values render as identifiers rather than epoch dates', async () => {
    const value = await cdp.evaluate(`(async () => {
      const box = document.querySelector('#omnibox');
      box.value = 'sat:0';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && document.querySelector('#app')?.getAttribute('aria-busy') !== 'false') await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { text: document.querySelector('#page')?.innerText, target: box.value };
    })()`);
    assert(/\b0\b/.test(value.text), 'sat identifier is absent from rendered output');
    assert(!/1969|1970|Dec 31, 1969|Jan 1, 1970/i.test(value.text), 'sat identifier was formatted as an epoch date');
    return { target: value.target };
  });

  await check('malformed PSBTs fail closed with INVALID_PSBT', async () => {
    const response = await captureApi(cdp, `window.satBrowser.psbt.inspect('cHNidP8B')`);
    assert(!response.ok && response.error.code === 'INVALID_PSBT' && response.error.status === 400, 'malformed PSBT leaked an unexpected parser error');
    return response.error;
  });

  await check('packaged wallet signing remains explicitly disabled', async () => {
    const snapshot = await cdp.evaluate(`window.satBrowser.app.bootstrap().then((value) => value.wallet)`);
    const psbt = await captureApi(cdp, `window.satBrowser.wallet.signPsbt({ psbt: 'cHNidP8=', options: {} })`);
    const message = await captureApi(cdp, `window.satBrowser.wallet.signMessage({ message: 'beta smoke' })`);
    assert(snapshot.signingEnabled === false, 'packaged runtime enabled signing via environment override');
    assert(psbt.error?.code === 'FEATURE_DISABLED' && message.error?.code === 'FEATURE_DISABLED', 'signing gate did not fail closed');
    return { snapshot, psbt: psbt.error, message: message.error };
  });

  await check('isolated fixture wallet discovers, connects once, and disconnects without entering the app partition', async () => {
    const response = await cdp.evaluate(`(async () => {
      const api = window.satBrowser;
      let snapshot;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        snapshot = await api.wallet.discover();
        if (snapshot.discovered.some((wallet) => wallet.id === 'unisat')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const candidate = snapshot.discovered.find((wallet) => wallet.id === 'unisat');
      if (!candidate) return { snapshot, candidate: null };
      const connected = await api.wallet.connect(candidate.id);
      const disconnected = await api.wallet.disconnect();
      return { snapshot, candidate, connected, disconnected, extensions: await api.extensions.list(), shellWallet: Boolean(window.unisat || window.BitcoinProvider || window.walletHost) };
    })()`);
    assert(response.candidate?.id === 'unisat', 'fixture extension did not inject into the isolated Wallet Bridge');
    assert(response.connected?.connected === true && response.connected.accounts.length === 1, 'wallet did not complete a live account handshake');
    assert(response.connected.accounts[0].address === 'bc1qpackagedsmokewallet000000000000000000000', 'wallet account normalization changed');
    assert(response.disconnected?.connected === false, 'wallet did not disconnect');
    const loadedExtension = response.extensions.find((extension) => extension.loaded && extension.runtime?.id === extension.id);
    assert(loadedExtension, 'restored fixture extension is not listed with a live runtime id');
    walletExtensionRuntimeId = loadedExtension.id;
    assert(response.shellWallet === false, 'wallet provider leaked into the trusted application partition');
    return response;
  });

  await check('reachable copy actions use bounded synthetic clipboard feedback and clean fallback state', async () => {
    const response = await cdp.evaluate(`(async () => {
      const api = window.satBrowser;
      const clipboard = navigator.clipboard;
      if (!clipboard) throw new Error('Clipboard facade is unavailable');
      const writeDescriptor = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      const execDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
      const writes = [];
      let writeAttempts = 0;
      let execFalseCalls = 0;
      let execThrowCalls = 0;
      const observations = {};
      const wait = () => new Promise((resolve) => setTimeout(resolve, 80));
      const setWrite = (implementation) => Object.defineProperty(clipboard, 'writeText', { configurable: true, writable: true, value: implementation });
      const setExec = (implementation) => Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: implementation });
      const latestStatusNode = () => [...document.querySelectorAll('#toasts [role="status"]')].at(-1) ?? null;
      const observeStatus = (previous) => {
        const current = latestStatusNode();
        return { status: current?.innerText ?? '', newStatus: Boolean(current && current !== previous) };
      };
      try {
        let snapshot = await api.wallet.discover();
        const candidate = snapshot.discovered.find((wallet) => wallet.id === 'unisat');
        if (!candidate) throw new Error('Synthetic wallet candidate is unavailable');
        setWrite(async (value) => { writeAttempts += 1; writes.push(String(value)); });
        await api.wallet.connect(candidate.id);
        const walletChip = document.querySelector('[data-route="wallet"]');
        if (!walletChip) throw new Error('Wallet route control is unavailable');
        walletChip.click();
        const accountDeadline = Date.now() + 3000;
        while (Date.now() < accountDeadline && ![...document.querySelectorAll('#page button')].some((button) => button.textContent.trim() === 'Copy')) await wait();
        const accountCopy = [...document.querySelectorAll('#page button')].find((button) => button.textContent.trim() === 'Copy');
        if (!accountCopy) throw new Error('Reachable account copy action is unavailable');
        const accountPreviousStatus = latestStatusNode();
        accountCopy.click();
        await wait();
        observations.account = { value: writes.at(-1), ...observeStatus(accountPreviousStatus), writeAttempts };

        const omnibox = document.querySelector('#omnibox');
        omnibox.value = 'sat:0';
        omnibox.dispatchEvent(new Event('input', { bubbles: true }));
        omnibox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const entityDeadline = Date.now() + 3000;
        while (Date.now() < entityDeadline && ![...document.querySelectorAll('#page button')].some((button) => button.textContent.includes('Copy identifier'))) await wait();
        const canonicalCopy = [...document.querySelectorAll('#page button')].find((button) => button.textContent.includes('Copy identifier'));
        if (!canonicalCopy) throw new Error('Reachable canonical copy action is unavailable');
        const canonicalPreviousStatus = latestStatusNode();
        canonicalCopy.click();
        await wait();
        observations.canonical = { value: writes.at(-1), ...observeStatus(canonicalPreviousStatus), writeAttempts };

        omnibox.focus();
        omnibox.setSelectionRange(1, 3, 'forward');
        setWrite(async () => { writeAttempts += 1; throw new Error('synthetic clipboard denial'); });
        setExec(() => { execFalseCalls += 1; return false; });
        const deniedPreviousStatus = latestStatusNode();
        const deniedBefore = { writeAttempts, execFalseCalls, execThrowCalls };
        canonicalCopy.click();
        await wait();
        observations.denied = {
          ...observeStatus(deniedPreviousStatus), hiddenTextareas: document.querySelectorAll('textarea[style*="opacity"]').length,
          focus: document.activeElement?.id, selection: [omnibox.selectionStart, omnibox.selectionEnd, omnibox.selectionDirection],
          deltas: { writeAttempts: writeAttempts - deniedBefore.writeAttempts, execFalseCalls: execFalseCalls - deniedBefore.execFalseCalls, execThrowCalls: execThrowCalls - deniedBefore.execThrowCalls }
        };

        setExec(() => { execThrowCalls += 1; throw new Error('synthetic execCommand failure'); });
        const thrownPreviousStatus = latestStatusNode();
        const thrownBefore = { writeAttempts, execFalseCalls, execThrowCalls };
        canonicalCopy.click();
        await wait();
        observations.thrown = {
          ...observeStatus(thrownPreviousStatus), hiddenTextareas: document.querySelectorAll('textarea[style*="opacity"]').length,
          focus: document.activeElement?.id, selection: [omnibox.selectionStart, omnibox.selectionEnd, omnibox.selectionDirection],
          deltas: { writeAttempts: writeAttempts - thrownBefore.writeAttempts, execFalseCalls: execFalseCalls - thrownBefore.execFalseCalls, execThrowCalls: execThrowCalls - thrownBefore.execThrowCalls }
        };
        observations.liveRegion = document.querySelector('#toasts')?.getAttribute('aria-live');
        return { writes, writeAttempts, execFalseCalls, execThrowCalls, observations };
      } finally {
        if (writeDescriptor) Object.defineProperty(clipboard, 'writeText', writeDescriptor);
        else delete clipboard.writeText;
        if (execDescriptor) Object.defineProperty(document, 'execCommand', execDescriptor);
        else delete document.execCommand;
        await api.wallet.disconnect();
      }
    })()`);
    const account = 'bc1qpackagedsmokewallet000000000000000000000';
    assert(response.writes.length === 2 && response.writeAttempts === 4, 'synthetic clipboard attempts did not match two successes and two denials');
    assert(response.execFalseCalls === 1 && response.execThrowCalls === 1, 'each synthetic fallback branch must execute exactly once');
    assert(response.observations.account.value === account && response.observations.account.newStatus && response.observations.account.writeAttempts === 1 && /Copied/.test(response.observations.account.status), 'account copy did not use the synthetic clipboard success path');
    assert(response.observations.canonical.value === 'sat:0' && response.observations.canonical.newStatus && response.observations.canonical.writeAttempts === 2 && /Copied/.test(response.observations.canonical.status), 'canonical copy did not use the synthetic clipboard success path');
    for (const mode of ['denied', 'thrown']) {
      const value = response.observations[mode];
      assert(value.newStatus && /Copy failed/.test(value.status), `${mode} clipboard failure lacked a newly created status`);
      assert(value.hiddenTextareas === 0, `${mode} clipboard fallback leaked a textarea`);
      assert(value.focus === 'omnibox' && value.selection[0] === 1 && value.selection[1] === 3, `${mode} clipboard fallback lost focus or selection`);
    }
    assert(response.observations.denied.deltas.writeAttempts === 1 && response.observations.denied.deltas.execFalseCalls === 1 && response.observations.denied.deltas.execThrowCalls === 0, 'false fallback branch counters changed unexpectedly');
    assert(response.observations.thrown.deltas.writeAttempts === 1 && response.observations.thrown.deltas.execFalseCalls === 0 && response.observations.thrown.deltas.execThrowCalls === 1, 'throwing fallback branch counters changed unexpectedly');
    assert(response.observations.liveRegion === 'polite', 'clipboard status feedback is not in the polite live region');
    return { syntheticWrites: response.writes, observations: response.observations };
  });

  await check('closing or deliberately crashing the Wallet Bridge revokes live account authority', async () => {
    const observations = [];
    for (const action of ['close', 'crash']) {
      await poll(() => cdp.evaluate('window.satBrowser.wallet.discover()'),
        (snapshot) => snapshot.discovered.some((wallet) => wallet.id === 'unisat'),
        stepTimeoutMs, `wallet discovery before ${action}`);
      const connected = await cdp.evaluate("window.satBrowser.wallet.connect('unisat')");
      assert(connected.connected === true && connected.accounts.length === 1, `wallet was not connected before ${action}`);
      const walletTarget = (await targets(instance.port)).find((target) => target.type === 'page' && target.url === 'https://wallet.satoshi.invalid/index.html');
      assert(walletTarget, `isolated Wallet Bridge target is missing before ${action}`);
      let commandOutcome;
      if (action === 'close') {
        const closed = await cdp.send('Target.closeTarget', { targetId: walletTarget.id });
        assert(closed.success === true, 'CDP did not acknowledge closing the Wallet Bridge');
        commandOutcome = 'acknowledged';
      } else {
        const walletCdp = await new CdpConnection(walletTarget.webSocketDebuggerUrl).open();
        try {
          // Intentionally kill only the fixture's isolated wallet renderer.
          // Chromium may terminate before responding; the assertion below uses
          // the still-live shell's authoritative wallet snapshot, not this ack.
          await walletCdp.send('Page.crash', {}, 3_000);
          commandOutcome = 'acknowledged';
        } catch (error) {
          commandOutcome = error.message;
        } finally {
          walletCdp.close();
        }
      }
      const revoked = await poll(() => cdp.evaluate('window.satBrowser.app.bootstrap().then((value) => value.wallet)'),
        (snapshot) => snapshot.bridgeOpen === false && snapshot.state.connected === false && snapshot.state.accounts.length === 0 && snapshot.discovered.length === 0,
        stepTimeoutMs, `wallet authority revocation after ${action}`);
      assert(await cdp.evaluate("document.querySelector('#app')?.getAttribute('aria-busy') === 'false'"), `shell stopped responding after wallet ${action}`);
      observations.push({ action, commandOutcome, bridgeOpen: revoked.bridgeOpen, connected: revoked.state.connected, accountCount: revoked.state.accounts.length });
    }
    return observations;
  });

  if (process.platform !== 'win32') {
    await check('local service success, edit protection, failure state, and idempotent stop', async () => {
      const serviceCwd = os.tmpdir();
      const response = await cdp.evaluate(`(async () => {
        const api = window.satBrowser.services;
        await api.upsert({ id: 'beta-smoke-sleep', name: 'Beta smoke sleep', executable: '/bin/sleep', args: ['10'], cwd: ${JSON.stringify(serviceCwd)}, enabled: true, autoStart: false });
        const started = await api.start('beta-smoke-sleep');
        let editError;
        try { await api.upsert({ id: 'beta-smoke-sleep', name: 'Changed', executable: '/bin/sleep', args: ['10'], cwd: ${JSON.stringify(serviceCwd)}, enabled: true, autoStart: false }); }
        catch (error) { editError = { code: error.code, status: error.status }; }
        const stopped = await api.stop('beta-smoke-sleep');
        const stoppedAgain = await api.stop('beta-smoke-sleep');
        await api.upsert({ id: 'beta-smoke-failure', name: 'Beta smoke failure', executable: '/etc/hosts', args: [], cwd: ${JSON.stringify(serviceCwd)}, enabled: true, autoStart: false });
        let failure;
        try { await api.start('beta-smoke-failure'); } catch (error) { failure = { code: error.code, status: error.status }; }
        const failedState = (await api.list()).find((item) => item.id === 'beta-smoke-failure');
        await api.remove('beta-smoke-sleep');
        await api.remove('beta-smoke-failure');
        return { started, editError, stopped, stoppedAgain, failure, failedState };
      })()`);
      assert(response.started.status === 'running' && response.started.pid > 0, 'service reported running without a pid');
      assert(response.editError?.code === 'SERVICE_RUNNING' && response.editError.status === 409, 'running service was editable');
      assert(response.stopped.status === 'stopped' && response.stoppedAgain.status === 'stopped', 'stop is not idempotent');
      assert(response.failure?.code === 'SERVICE_START_FAILED', 'non-executable service did not report start failure');
      assert(response.failedState?.status === 'failed' && response.failedState.logs.some((entry) => entry.stream === 'error'), 'failed service state/logs were not retained');
      return response;
    });
  } else {
    results.push({ name: 'local service POSIX lifecycle', ok: true, skipped: true, reason: 'Windows requires a platform-specific fixture executable' });
    console.log('SKIP  local service POSIX lifecycle (Windows)');
  }

  await check('packaged services drain output, distinguish exit failure, share starts/stops, and remove live children', async () => {
    const observations = [];
    for (const mode of ['success', 'failure', 'success']) {
      const service = lifecycleService('beta-service-output', mode);
      await cdp.evaluate(`window.satBrowser.services.upsert(${JSON.stringify(service)})`);
      const started = await cdp.evaluate("window.satBrowser.services.start('beta-service-output')");
      assert(started.pid > 0, `${mode} service did not acquire a PID`);
      const terminal = await poll(() => cdp.evaluate("window.satBrowser.services.list().then((list) => list.find((item) => item.id === 'beta-service-output'))"),
        (value) => value?.pid === null && value.status === (mode === 'failure' ? 'failed' : 'stopped'), stepTimeoutMs, `${mode} fixture exit`);
      assert(terminal.exitCode === (mode === 'failure' ? 7 : 0), `${mode} exit code was lost`);
      assert(terminal.logs.some((entry) => entry.stream === 'stdout' && entry.text.includes(`fixture stdout ${mode}`)), `${mode} stdout was lost`);
      assert(terminal.logs.some((entry) => entry.stream === 'stderr' && entry.text.includes(`fixture stderr ${mode}`)), `${mode} stderr was lost`);
      assert(!processExists(started.pid), `${mode} child is still alive after terminal status`);
      observations.push({ mode, pid: started.pid, status: terminal.status, exitCode: terminal.exitCode });
    }
    await cdp.evaluate(`window.satBrowser.services.upsert(${JSON.stringify(lifecycleService('beta-service-output'))})`);
    const starts = await cdp.evaluate("Promise.all(Array.from({ length: 8 }, () => window.satBrowser.services.start('beta-service-output')))");
    assert(starts.every((item) => item.status === 'running' && item.pid === starts[0].pid), 'concurrent starts did not share one child');
    await poll(() => cdp.evaluate("window.satBrowser.services.list().then((list) => list.find((item) => item.id === 'beta-service-output').logs)"),
      (logs) => logs.some((entry) => entry.text.includes('fixture stdout wait')), stepTimeoutMs, 'service signal handler readiness');
    const stops = await cdp.evaluate("Promise.all(Array.from({ length: 8 }, () => window.satBrowser.services.stop('beta-service-output')))");
    assert(stops.every((item) => item.status === 'stopped') && !processExists(starts[0].pid), 'stop resolved before child termination');
    const stopped = (await cdp.evaluate('window.satBrowser.services.list()')).find((item) => item.id === 'beta-service-output');
    if (process.platform === 'win32') {
      // Windows does not deliver POSIX signal handlers. Verify its actual
      // termination status and preserved output, rather than inventing a
      // graceful-shutdown message that this platform cannot produce.
      assert(stopped.signal === 'SIGTERM' && stopped.exitCode === null, 'Windows service termination status was lost');
      assert(stopped.logs.some((entry) => entry.text.includes('fixture stdout wait')), 'Windows stop lost previously emitted stdout');
    } else {
      assert(stopped.logs.some((entry) => entry.text.includes('fixture graceful shutdown')), 'stop did not drain final stdout');
    }
    const restarted = await cdp.evaluate("window.satBrowser.services.start('beta-service-output')");
    const removed = await cdp.evaluate("window.satBrowser.services.remove('beta-service-output')");
    const removedAgain = await cdp.evaluate("window.satBrowser.services.remove('beta-service-output')");
    assert(!processExists(restarted.pid), 'removing a running service left its child alive');
    assert([...removed, ...removedAgain].every((item) => item.id !== 'beta-service-output'), 'removed service remains visible');
    return { observations, concurrentStartCount: starts.length, sharedPid: starts[0].pid, concurrentStopCount: stops.length,
      finalOutputDrained: true, stopMechanism: process.platform === 'win32' ? 'windows-process-termination' : 'posix-sigterm', liveRemovalTerminatedChild: true };
  });

  await check('modal and command palette enforce focus isolation and restoration', async () => {
    const value = await cdp.evaluate(`(async () => {
      document.querySelector('[data-route="providers"]').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const add = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('Add source'));
      add.focus(); add.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const modal = { inert: document.querySelector('#app').inert, visible: !document.querySelector('#modal-backdrop').classList.contains('hidden'), focusedInside: document.querySelector('#modal').contains(document.activeElement) };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const modalRestored = document.activeElement === add;
      const paletteTrigger = document.querySelector('[data-command="command-palette"]');
      paletteTrigger.focus(); paletteTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const palette = { inert: document.querySelector('#app').inert, visible: !document.querySelector('#palette-backdrop').classList.contains('hidden'), focus: document.activeElement?.id };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { modal, modalRestored, palette, paletteRestored: document.activeElement === paletteTrigger };
    })()`);
    assert(value.modal.inert && value.modal.visible && value.modal.focusedInside && value.modalRestored, 'modal focus containment/restoration failed');
    assert(value.palette.inert && value.palette.visible && value.palette.focus === 'palette-input' && value.paletteRestored, 'palette focus containment/restoration failed');
    return value;
  });

  await check('tab and developer tablists support keyboard navigation', async () => {
    const value = await cdp.evaluate(`(async () => {
      document.querySelector('#new-tab').click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const activeTab = document.querySelector('#tabs [role="tab"][aria-selected="true"]');
      activeTab.focus();
      activeTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const browser = { activeIsFirst: document.querySelector('#tabs [role="tab"]')?.getAttribute('aria-selected') === 'true', focusIsActive: document.activeElement === document.querySelector('#tabs [role="tab"][aria-selected="true"]') };
      document.querySelector('#developer-button').click();
      const raw = document.querySelector('#drawer-tab-raw'); raw.focus();
      raw.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const drawer = { selected: document.querySelector('[data-drawer-tab][aria-selected="true"]')?.dataset.drawerTab, focus: document.activeElement?.dataset.drawerTab };
      return { browser, drawer };
    })()`);
    assert(value.browser.activeIsFirst && value.browser.focusIsActive, 'browser tab keyboard navigation failed');
    assert(value.drawer.selected === 'graph' && value.drawer.focus === 'graph', 'developer tab keyboard navigation failed');
    return value;
  });

  await check('renderer enforces the 64-tab limit and recovers capacity after close', async () => {
    const initial = await cdp.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
      return { ids: tabs.map((tab) => tab.dataset.tabId), activeId: tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.tabId ?? null };
    })()`);
    let evidence;
    try {
      const capped = await cdp.evaluate(`(() => {
        const button = document.querySelector('#new-tab');
        for (let operation = 0; operation < 64; operation += 1) {
          if (button.disabled) break;
          const before = document.querySelectorAll('#tabs [role="tab"]').length;
          button.click();
          const after = document.querySelectorAll('#tabs [role="tab"]').length;
          if (after !== before + 1) throw new Error('new-tab click made no progress before the limit');
        }
        return { count: document.querySelectorAll('#tabs [role="tab"]').length, disabled: button.disabled, title: button.title };
      })()`);
      assert(capped.count === 64 && capped.disabled === true && /64/.test(capped.title), 'renderer did not expose the 64-tab boundary');
      const modifier = process.platform === 'darwin' ? 4 : 2;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't', code: 'KeyT', modifiers: modifier });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't', code: 'KeyT', modifiers: modifier });
      const attempted = await cdp.evaluate(`(() => ({
        count: document.querySelectorAll('#tabs [role="tab"]').length,
        feedback: [...document.querySelectorAll('#toasts .toast strong')].some((node) => node.textContent === 'Tab limit reached')
      }))()`);
      assert(attempted.count === 64 && attempted.feedback, 'keyboard tab attempt bypassed the limit or lacked feedback');
      const recovered = await cdp.evaluate(`(() => {
        const initialIds = new Set(${JSON.stringify(initial.ids)});
        const temporary = [...document.querySelectorAll('#tabs [role="tab"]')].find((tab) => !initialIds.has(tab.dataset.tabId));
        if (!temporary) throw new Error('no temporary tab was available for capacity recovery');
        temporary.querySelector('.tab-close').click();
        const countAfterClose = document.querySelectorAll('#tabs [role="tab"]').length;
        const button = document.querySelector('#new-tab');
        if (countAfterClose !== 63 || button.disabled) throw new Error('single close did not restore tab capacity');
        button.click();
        return { countAfterClose, countAfterCreate: document.querySelectorAll('#tabs [role="tab"]').length, disabledAfterCreate: button.disabled };
      })()`);
      assert(recovered.countAfterCreate === 64 && recovered.disabledAfterCreate === true, 'new tab creation did not recover after a single close');
      evidence = { initialCount: initial.ids.length, capped, keyboardAttemptCount: attempted.count, recovered };
    } finally {
      await cdp.evaluate(`(() => {
        const initialIds = new Set(${JSON.stringify(initial.ids)});
        for (let operation = 0; operation < 64; operation += 1) {
          const temporary = [...document.querySelectorAll('#tabs [role="tab"]')].find((tab) => !initialIds.has(tab.dataset.tabId));
          if (!temporary) break;
          const before = document.querySelectorAll('#tabs [role="tab"]').length;
          temporary.querySelector('.tab-close').click();
          const after = document.querySelectorAll('#tabs [role="tab"]').length;
          if (after !== before - 1) throw new Error('temporary tab cleanup made no progress');
        }
        const remaining = [...document.querySelectorAll('#tabs [role="tab"]')];
        if (remaining.some((tab) => !initialIds.has(tab.dataset.tabId))) throw new Error('temporary tab cleanup exceeded its 64-operation bound');
        const originalActive = remaining.find((tab) => tab.dataset.tabId === ${JSON.stringify(initial.activeId)});
        originalActive?.click();
      })()`);
    }
    return evidence;
  });

  await check('a second packaged instance delivers a deep link to the existing trusted window', async () => {
    const second = spawn(executable, [`--user-data-dir=${profile}`, 'satnav://about'], { cwd: root, stdio: 'ignore' });
    try {
      const value = await poll(
        () => cdp.evaluate(`({ heading: document.querySelector('#page h1')?.textContent, target: document.querySelector('#omnibox')?.value, shellUrl: location.href })`),
        (result) => result.heading === 'Bitcoin Browser' && result.target === 'satnav://about',
        stepTimeoutMs,
        'second-instance deep link'
      );
      assert(value.shellUrl === 'app://app/renderer/index.html', 'deep link changed the trusted shell origin');
      return value;
    } finally {
      if (second.exitCode === null && second.signalCode === null) second.kill('SIGTERM');
    }
  });

  await check('hostile recursive fixture blocks tested shell, wallet, storage, popup, fetch, image, and geolocation attempts', async () => {
    const launchValue = await cdp.evaluate(`(async () => {
      const box = document.querySelector('#omnibox');
      box.value = '/r/satoshi-browser-hostile-fixture';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const frame = document.querySelector('.viewer-canvas iframe');
        if (frame?.src?.includes('satoshi-browser-hostile-fixture')) return { src: frame.src, sandbox: frame.getAttribute('sandbox'), shellUrl: location.href };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { frameMissing: true, target: box.value, page: document.querySelector('#page')?.innerText?.slice(0, 4096) };
    })()`);
    if (launchValue?.sandbox !== 'allow-scripts allow-forms allow-modals allow-pointer-lock') {
      const error = new Error('Hostile fixture frame was unavailable or its sandbox changed');
      error.evidence = launchValue;
      throw error;
    }
    const topology = await poll(
      async () => {
        const frames = flattenFrames((await cdp.send('Page.getFrameTree')).frameTree);
        const discoveredTargets = await targets(instance.port);
        return {
          frames,
          targets: discoveredTargets,
          frame: frames.find((item) => item.url.includes('satoshi-browser-hostile-fixture')) ?? null,
          target: discoveredTargets.find((item) => item.url.includes('satoshi-browser-hostile-fixture')) ?? null
        };
      },
      (value) => value.frame || value.target,
      stepTimeoutMs,
      'hostile iframe target'
    );
    let hostileConnection = cdp;
    let contextId;
    let separateConnection;
    if (topology.frame) {
      contextId = await poll(
        async () => cdp.contexts.get(topology.frame.id),
        (value) => Number.isInteger(value),
        stepTimeoutMs,
        'hostile iframe execution context'
      );
    } else {
      separateConnection = await new CdpConnection(topology.target.webSocketDebuggerUrl).open();
      hostileConnection = separateConnection;
    }
    let attempts;
    try {
      attempts = await poll(
        () => hostileConnection.evaluate(`(() => { const text = document.querySelector('#hostile-result')?.textContent; try { return JSON.parse(text); } catch { return null; } })()`, contextId),
        (value) => value && value.externalFetch !== null && value.externalImage !== null && value.geolocationPermission !== null,
        stepTimeoutMs,
        'hostile fixture results'
      );
    } finally {
      separateConnection?.close();
    }
    const shellUrl = await cdp.evaluate('location.href');
    assert(shellUrl === 'app://app/renderer/index.html', `hostile frame navigated shell to ${shellUrl}`);
    assert(attempts.opener === false && attempts.popup === false, 'hostile content received opener or popup authority');
    assert(attempts.cookieWrite === false && attempts.localStorage === false, 'hostile content acquired persistent storage');
    assert(attempts.externalFetch === false && attempts.externalImage === false, 'hostile content reached an external network resource');
    assert(attempts.walletAuthority === false && attempts.nodeAuthority === false, 'hostile content acquired wallet or Node authority');
    assert(['denied', 'blocked'].includes(attempts.geolocationPermission), `unexpected geolocation permission ${attempts.geolocationPermission}`);
    assert(attempts.downloadAttempted === true, 'download denial branch was not exercised');
    return { launch: launchValue, topology: topology.frame ? 'frame' : `target:${topology.target.type}`, attempts, shellUrl };
  });

  // Run explicit download prevention before the first restart, separately from
  // launch 3's content-mode probes, so teardown failures can be attributed to
  // a narrower sequence without omitting either production boundary check.
  await check('session-wide download handler explicitly denies a trusted-renderer data download', async () => {
    const token = `beta-denied-${Date.now()}`;
    const filename = `${token}.txt`;
    await cdp.evaluate(`(() => {
      const anchor = document.createElement('a');
      anchor.href = ${JSON.stringify(`data:text/plain,${token}`)};
      anchor.download = ${JSON.stringify(filename)};
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    })()`);
    const observation = await poll(async () => {
      const log = await fs.readFile(path.join(profile, 'logs', 'satoshi-browser.jsonl'), 'utf8');
      return log.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } })
        .find((entry) => entry.event === 'content.download_blocked' && entry.url?.includes(token));
    }, Boolean, stepTimeoutMs, 'explicit application download denial');
    const checkedPaths = [path.join(profile, 'Downloads', filename), path.join(profile, 'downloads', filename), path.join(os.homedir(), 'Downloads', filename)];
    for (const file of checkedPaths) assert(!(await exists(file)), `denied fixture download appeared at ${file}`);
    return { denialEvent: observation.event, mime: observation.mime, filename, checkedSentinelLocations: 3,
      scope: 'Explicit app-session will-download prevention plus absence at generated-profile and conventional OS Downloads sentinel paths; not a custom native Downloads-location qualification.' };
  });

  libraryExpectation = await check('reachable Home cards, All history, Bookmarks and History controls preserve exact canonicals and clear history',
    () => runPackagedLibraryChecks({ cdp, poll, navigateShell, assert, targets: libraryTargets }));

  await check('session restores tabs and wallet; wallet reconnects, removes, and stays removed after restart', async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const saved = await cdp.evaluate(`window.satBrowser.tabs.save([
      { id: 'restored-home', title: 'Start', target: 'satnav://home', history: ['satnav://home'], historyIndex: 0, pinned: false, lastAccessedAt: Date.now() },
      { id: 'restored-block', title: 'Block 840000', target: 'block:840000', history: ['satnav://home', 'block:840000'], historyIndex: 1, pinned: false, lastAccessedAt: Date.now() - 1 },
      { id: 'restored-click', title: 'Block 840001', target: 'block:840001', history: ['satnav://home', 'block:840001'], historyIndex: 1, pinned: false, lastAccessedAt: Date.now() - 2 }
    ], 'restored-home')`);
    assert(saved === true, 'tab session save did not acknowledge');
    allRendererEvents.push(...cdp.events);
    await stop(instance);
    instance = null;
    // Wait for Electron helper processes from the first instance to finish
    // teardown before reusing the persistent profile in a new process.
    await new Promise((resolve) => setTimeout(resolve, 750));
    const secondPort = await reservePort();
    instance = await launch(executable, profile, secondPort);
    cdp = instance.cdp;
    const initial = await cdp.evaluate(`(() => ({ tabs: [...document.querySelectorAll('#tabs [role="tab"]')].map((node) => ({ id: node.dataset.tabId, selected: node.getAttribute('aria-selected') })), heading: document.querySelector('#page h1')?.textContent }))()`);
    assert(initial.tabs.length === 3 && initial.tabs[0].selected === 'true', 'saved tab set/active tab was not restored');
    await check('bookmark persistence and cleared history survive a full packaged restart', async () => {
      assert(libraryExpectation, 'Library setup did not produce a valid restart expectation');
      return readBackPackagedLibraryChecks({ cdp, poll, navigateShell, assert, targets: libraryTargets }, libraryExpectation);
    });
    const successor = await cdp.evaluate(`(async () => {
      document.querySelector('[data-tab-id="restored-home"] .tab-close').click();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const page = document.querySelector('#page')?.innerText ?? '';
        if (document.querySelector('#app')?.getAttribute('aria-busy') === 'false' && /840000/.test(page)) return { page, target: document.querySelector('#omnibox')?.value, selected: document.querySelector('[data-tab-id="restored-block"]')?.getAttribute('aria-selected') };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { page: document.querySelector('#page')?.innerText, target: document.querySelector('#omnibox')?.value, selected: document.querySelector('[data-tab-id="restored-block"]')?.getAttribute('aria-selected') };
    })()`);
    assert(successor.selected === 'true' && successor.target === 'block:840000' && /840000/.test(successor.page) && !/Navigation error/i.test(successor.page), 'closing the active restored tab did not lazily resolve its successor');
    const restored = await cdp.evaluate(`(async () => {
      document.querySelector('[data-tab-id="restored-click"]').click();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const page = document.querySelector('#page')?.innerText ?? '';
        if (document.querySelector('#app')?.getAttribute('aria-busy') === 'false' && /840001/.test(page)) return { page, target: document.querySelector('#omnibox')?.value, selected: document.querySelector('[data-tab-id="restored-click"]')?.getAttribute('aria-selected') };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { page: document.querySelector('#page')?.innerText, target: document.querySelector('#omnibox')?.value, selected: document.querySelector('[data-tab-id="restored-click"]')?.getAttribute('aria-selected') };
    })()`);
    assert(restored.selected === 'true' && restored.target === 'block:840001', 'background tab did not become active with preserved target');
    assert(/840001/.test(restored.page) && !/Navigation error/i.test(restored.page), 'restored background tab was not lazily resolved');
    const walletAfterRestart = await cdp.evaluate(`(async () => {
      const deadline = Date.now() + 8000;
      let snapshot;
      while (Date.now() < deadline) {
        snapshot = await window.satBrowser.wallet.discover();
        if (snapshot.discovered.some((wallet) => wallet.id === 'unisat')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const candidate = snapshot.discovered.find((wallet) => wallet.id === 'unisat');
      if (!candidate) return { snapshot, candidate: null };
      const connected = await window.satBrowser.wallet.connect(candidate.id);
      const disconnected = await window.satBrowser.wallet.disconnect();
      return { snapshot, candidate, connected, disconnected, extensions: await window.satBrowser.extensions.list() };
    })()`);
    assert(walletAfterRestart?.candidate?.id === 'unisat', 'wallet extension did not rediscover after a full packaged restart');
    assert(walletAfterRestart.connected?.connected === true && walletAfterRestart.connected.accounts?.[0]?.address === 'bc1qpackagedsmokewallet000000000000000000000', 'wallet did not repeat its live account handshake after restart');
    assert(walletAfterRestart.disconnected?.connected === false, 'wallet did not disconnect after its restart handshake');
    const restoredExtension = walletAfterRestart.extensions.find((extension) => extension.id === walletExtensionRuntimeId);
    assert(restoredExtension?.loaded === true && restoredExtension.runtime?.id === walletExtensionRuntimeId, 'restored fixture is not loaded under its persisted runtime id');

    const removed = await cdp.evaluate(`(async () => {
      const mutation = await window.satBrowser.extensions.remove(${JSON.stringify(walletExtensionRuntimeId)});
      const wallet = await window.satBrowser.wallet.discover();
      return { mutation, extensions: await window.satBrowser.extensions.list(), wallet };
    })()`);
    assert(removed.mutation.extensionMutationCommitted === true && removed.mutation.operation === 'remove'
      && removed.mutation.extensionId === walletExtensionRuntimeId && removed.mutation.walletRefreshPending === false
      && !removed.mutation.stateReadErrors && removed.mutation.extensions?.length === 0,
    'wallet extension removal did not acknowledge a complete committed mutation');
    assert(removed.extensions.length === 0 && removed.wallet.extensions.length === 0, 'wallet extension removal did not clear the configured/runtime extension list');
    assert(removed.wallet.state.connected === false && removed.wallet.discovered.length === 0, 'wallet extension removal did not clear live bridge state');

    allRendererEvents.push(...cdp.events);
    await stop(instance);
    instance = null;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const thirdPort = await reservePort();
    instance = await launch(executable, profile, thirdPort);
    cdp = instance.cdp;
    const removalAfterRestart = await cdp.evaluate(`(async () => ({ extensions: await window.satBrowser.extensions.list(), wallet: await window.satBrowser.wallet.discover() }))()`);
    assert(removalAfterRestart.extensions.length === 0 && removalAfterRestart.wallet.extensions.length === 0, 'removed wallet extension returned after restart');
    assert(removalAfterRestart.wallet.discovered.length === 0 && removalAfterRestart.wallet.state.connected === false, 'removed wallet retained bridge discovery or connection state after restart');
    return { initial, successor: { target: successor.target, selected: successor.selected }, restored: { target: restored.target, selected: restored.selected }, walletAfterRestart: { connected: true, runtimeId: walletExtensionRuntimeId }, removalPersisted: true };
  });

  await check('real HTTP providers fail over in order and preserve errors, health, and UI recovery', async () => {
    providerFixture = await startProviderFixtures();
    const [primary, fallback] = providerFixture.providers;
    await cdp.evaluate(`(async () => {
      const api = window.satBrowser;
      for (const provider of await api.providers.list()) await api.providers.upsert({ ...provider, enabled: false });
      for (const provider of ${JSON.stringify(providerFixture.providers)}) await api.providers.upsert(provider);
      await api.providers.preferred(${JSON.stringify(primary.id)});
      await api.settings.update({ localOnly: true, offlineMode: false, requestTimeoutMs: 1000 });
    })()`);
    const samples = [];
    for (const [index, mode] of [404, 401, 429, 500, 'timeout'].entries()) {
      const sat = String(4000 + index);
      const requestPath = `/r/sat/${sat}`;
      providerFixture.modes.set(`primary:${requestPath}`, mode);
      await cdp.evaluate('window.satBrowser.providers.health()');
      const result = await cdp.evaluate(`window.satBrowser.navigation.resolve('sat:${sat}')`);
      assert(result.entity?.source?.id === fallback.id && result.entity.summary.sat === sat, `HTTP ${mode} did not reach normalized fallback`);
      assert(result.attempts.length === 2 && result.attempts[0].providerId === primary.id && result.attempts[0].ok === false && result.attempts[1].providerId === fallback.id && result.attempts[1].ok === true, `HTTP ${mode} attempt order changed`);
      const error = result.attempts[0].error;
      const expectedCode = mode === 404 ? 'NOT_FOUND' : mode === 401 ? 'PROVIDER_AUTH_ERROR' : mode === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_HTTP_ERROR';
      // The transport contract represents timeout as provider unavailability
      // (503); verify that actual contract rather than assuming HTTP gateway 504.
      assert(error.code === expectedCode && error.status === (mode === 'timeout' ? 503 : mode), `HTTP ${mode} error code/status did not survive IPC: ${JSON.stringify(error)}`);
      assert(typeof error.message === 'string' && typeof error.retryable === 'boolean' && Object.hasOwn(error, 'details'), `HTTP ${mode} error metadata is incomplete`);
      const observed = providerFixture.requests.filter((entry) => entry.path === requestPath).map((entry) => entry.provider);
      assert(JSON.stringify(observed) === JSON.stringify(['primary', 'fallback']), `HTTP ${mode} wire request order differs from attempts: ${observed}`);
      const descriptor = (await cdp.evaluate('window.satBrowser.providers.list()')).find((provider) => provider.id === primary.id);
      assert(descriptor.health?.ok === (mode === 404), `HTTP ${mode} incorrectly affected provider health`);
      samples.push({ mode, attempts: result.attempts, observed, primaryHealthy: descriptor.health.ok });
    }

    const failingPath = '/r/sat/4099';
    providerFixture.modes.set(`primary:${failingPath}`, 404);
    providerFixture.modes.set(`fallback:${failingPath}`, 404);
    const failed = await captureApi(cdp, "window.satBrowser.navigation.resolve('sat:4099')");
    assert(failed.error?.code === 'ALL_PROVIDERS_FAILED' && failed.error.status === 503 && failed.error.retryable === true, 'all-provider failure contract changed');
    assert(failed.error.details?.attempts?.length === 2 && failed.error.details.attempts.every((attempt) => attempt.error.code === 'NOT_FOUND' && attempt.error.status === 404), 'nested attempt errors were lost across contextBridge');
    const errorUi = await navigateShell(cdp, 'sat:4099', 'This page couldn’t be loaded');
    const failureDetails = await cdp.evaluate(`(() => {
      const view = document.querySelector('#page .lookup-recovery');
      const summary = view?.querySelector('.recovery-technical > summary');
      if (!summary) throw new Error('Lookup failure omitted its technical disclosure');
      summary.click();
      return { open: view.querySelector('.recovery-technical').open, text: view.innerText };
    })()`);
    assert(failureDetails.open && failureDetails.text.includes('ALL_PROVIDERS_FAILED'), 'all-provider failure lost its disclosed technical error');
    providerFixture.modes.delete(`primary:${failingPath}`);
    providerFixture.modes.delete(`fallback:${failingPath}`);
    const recoveredUi = await navigateShell(cdp, 'sat:4099', 'primary-4099');
    assert(!(await cdp.evaluate("Boolean(document.querySelector('#page .lookup-recovery'))")), 'renderer retained the failed navigation after successful retry');
    const recoveredHealth = (await cdp.evaluate('window.satBrowser.providers.list()')).find((provider) => provider.id === primary.id).health;
    assert(recoveredHealth.ok === true && recoveredHealth.error === null, 'successful retry did not clear stale health errors');

    const edited = await cdp.evaluate(`window.satBrowser.providers.upsert(${JSON.stringify({ ...primary, baseUrl: fallback.baseUrl })})`);
    assert(edited.providerMutationCommitted === true && edited.operation === 'upsert' && edited.providerId === primary.id, 'provider edit lost its committed mutation outcome');
    assert(Array.isArray(edited.providers) && edited.settings && !edited.stateReadErrors, 'provider edit did not return a complete authoritative snapshot');
    const editedProvider = edited.providers.find((provider) => provider.id === primary.id);
    assert(editedProvider && editedProvider.health === null, 'editing a provider endpoint retained its old health');
    const routed = await cdp.evaluate("window.satBrowser.navigation.resolve('sat:4098')");
    assert(routed.entity.source.id === primary.id && providerFixture.requests.filter((entry) => entry.path === '/r/sat/4098').every((entry) => entry.provider === 'fallback'), 'provider edit did not refresh the live endpoint');
    await cdp.evaluate(`window.satBrowser.providers.upsert(${JSON.stringify(primary)})`);
    return { samples, failed: failed.error, errorUi: { target: errorUi.target }, recoveredUi: { target: recoveredUi.target }, endpointEditApplied: true };
  });

  await check('provider Add, Edit, Cancel, Enable, Prefer, Auto and Remove controls preserve authoritative configuration', async () => {
    assert(providerFixture, 'HTTP fixture setup failed');
    const fixtureNonce = crypto.randomUUID().slice(0, 8);
    return runPackagedProviderControlChecks({ cdp, poll, assert, fixtureProvider: {
      id: `beta-provider-controls-${fixtureNonce}`,
      name: `Beta provider controls ${fixtureNonce}`,
      baseUrl: providerFixture.providers[0].baseUrl
    } });
  });

  await check('home quick targets navigate through actual buttons with provider provenance', async () => {
    assert(providerFixture, 'HTTP fixture setup failed');
    const observations = [];
    const cases = [
      ['Genesis sat', 'sat:0', 'primary-0', '/r/sat/0'],
      ['Block height', 'ord://r/blockheight', '/r/blockheight', '/r/blockheight'],
      ['Latest block hash', 'ord://r/blockhash', '/r/blockhash', '/r/blockhash'],
      ['Wallet', 'satnav://wallet', 'Wallet', null],
      ['Local sources', 'satnav://providers', 'Data sources', null]
    ];
    for (const [label, canonical, expectedText, requestPath] of cases) {
      await navigateShell(cdp, 'satnav://home', 'Find your way around Bitcoin.');
      const start = providerFixture.requests.length;
      const clicked = await cdp.evaluate(`(() => {
        const tools = document.querySelector('.home-tools');
        if (tools && !tools.open) tools.querySelector('summary').click();
        const chip = [...document.querySelectorAll('.quick-targets button')].find((button) => button.textContent === ${JSON.stringify(label)});
        if (!chip || !chip.checkVisibility()) return false;
        chip.click();
        return true;
      })()`);
      assert(clicked, `missing quick-target button ${label}`);
      const rendered = await poll(() => cdp.evaluate(`(() => ({
        busy: document.querySelector('#app')?.getAttribute('aria-busy'),
        loading: document.querySelector('#page-loading')?.classList.contains('hidden') === false,
        target: document.querySelector('#omnibox')?.value,
        page: document.querySelector('#page')?.innerText,
        source: document.querySelector('#source-label')?.textContent
      }))()`), (value) => value.busy === 'false' && value.loading === false && value.target === canonical && value.page?.includes(expectedText), stepTimeoutMs, `${label} quick target`);
      const requests = providerFixture.requests.slice(start).filter((entry) => entry.path === requestPath);
      if (requestPath) {
        assert(requests.some((entry) => entry.provider === 'primary'), `${label} did not reach the expected provider route`);
        assert(rendered.source?.includes('HTTP primary'), `${label} lost provider provenance`);
      }
      if (label === 'Local sources') {
        // Fixture configuration was installed through IPC, outside the UI's
        // own mutation actions. Exercise the real refresh action before
        // expecting that external setup in the renderer's provider snapshot.
        const refreshed = await cdp.evaluate(`(() => {
          const button = [...document.querySelectorAll('#page button')].find((node) => node.textContent.includes('Health check'));
          if (!button) return false;
          button.click();
          return true;
        })()`);
        assert(refreshed, 'provider health action was unavailable');
        await poll(() => cdp.evaluate("document.querySelector('#page')?.innerText"),
          (text) => text.includes('HTTP primary') && text.includes('HTTP fallback'), stepTimeoutMs, 'refreshed provider descriptors');
      }
      observations.push({ label, target: rendered.target, source: rendered.source, requests });
    }
    return observations;
  });

  await check('controlled hostile HTTP, WS, and TLS probes honor browser content modes', async () => {
    const fixture = await startHostileNetworkFixture();
    const original = (await cdp.evaluate('window.satBrowser.app.bootstrap()')).state.settings;
    const modes = [
      { name: 'default', localOnly: false, offlineMode: false, contentNetworkPolicy: 'blocked' },
      { name: 'local-only', localOnly: true, offlineMode: false, contentNetworkPolicy: 'blocked' },
      { name: 'offline', localOnly: true, offlineMode: true, contentNetworkPolicy: 'blocked' },
      { name: 'compatible', localOnly: false, offlineMode: false, contentNetworkPolicy: 'https-only' },
      { name: 'offline-compatible', localOnly: false, offlineMode: true, contentNetworkPolicy: 'https-only' }
    ];
    const samples = [];
    try {
      assert(await (await fetch(`${fixture.baseUrl}/control`)).text() === 'fixture-ready', 'controlled HTTP endpoint is not reachable');
      await cdp.evaluate(`window.satBrowser.providers.upsert(${JSON.stringify(fixture.provider)})`);
      await cdp.evaluate(`window.satBrowser.providers.preferred(${JSON.stringify(fixture.provider.id)})`);
      for (const [index, mode] of modes.entries()) {
        const inscriptionId = `${'c'.repeat(64)}i${index}`;
        // Warm through the real iframe so its Accept-dependent cache key is
        // identical to the offline navigation. A trusted-shell fetch has a
        // different Accept header and does not establish an iframe cache hit.
        await cdp.evaluate('window.satBrowser.settings.update({ offlineMode: false, contentNetworkPolicy: "blocked" })');
        await navigateShell(cdp, `inscription:${inscriptionId}`, 'Opaque sandbox');
        await readFixtureFrame(instance, cdp, `/content/${inscriptionId}`,
          'window.networkFixtureResult ?? null', (value) => value?.done === true);
        await navigateShell(cdp, 'satnav://home', 'Find your way around Bitcoin.');
        const requestStart = fixture.requests.length;
        const connectionStart = fixture.connections.length;
        const { name, ...settings } = mode;
        await cdp.evaluate(`window.satBrowser.settings.update(${JSON.stringify(settings)})`);
        await navigateShell(cdp, `inscription:${inscriptionId}`, 'Opaque sandbox');
        const result = await readFixtureFrame(instance, cdp, `/content/${inscriptionId}`,
          'window.networkFixtureResult ?? null', (value) => value?.done === true);
        const requests = fixture.requests.slice(requestStart);
        const attackRequests = requests.filter((entry) => entry.path.startsWith('/attack/'));
        const tlsConnections = fixture.connections.slice(connectionStart);
        assert(attackRequests.length === 0, `${name} leaked controlled HTTP/WS traffic: ${JSON.stringify(attackRequests)}`);
        if (name !== 'compatible') assert(tlsConnections.length === 0, `${name} opened ${tlsConnections.length} prohibited TLS connections`);
        if (mode.offlineMode) assert(requests.length === 0, `${name} contacted a provider while rendering cached content`);
        assert(result.attempted.length === 15, `${name} did not execute every bounded network branch`);
        assert(result.authority === false && result.popup === false, `${name} gained shell or popup authority`);
        assert(Object.values(result.permissions).every((value) => ['denied', 'unavailable'].includes(value)), `${name} exposed a granted/prompt permission: ${JSON.stringify(result.permissions)}`);
        assert(await cdp.evaluate('location.href') === 'app://app/renderer/index.html', `${name} navigated the trusted shell`);
        samples.push({ name, settings, result, requestCount: requests.length, attackRequests, tlsConnections,
          tlsScope: 'Raw loopback TLS sink only; a connection is pre-HTTP egress evidence, not successful TLS/HTTPS/WSS compatibility. Certificate verification was not weakened.' });
      }
      return samples;
    } catch (error) {
      error.evidence = { ...error.evidence, samples, requests: fixture.requests, tlsConnections: fixture.connections };
      throw error;
    } finally {
      try {
        await cdp.evaluate(`window.satBrowser.settings.update(${JSON.stringify({ localOnly: original.localOnly, offlineMode: original.offlineMode, contentNetworkPolicy: original.contentNetworkPolicy })})`);
        await cdp.evaluate(`window.satBrowser.providers.preferred(${JSON.stringify(original.preferredProviderId)})`);
        await cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(fixture.provider.id)})`);
      } finally { await fixture.close(); }
    }
  });

  await check('routing changes abort active HTTP resolution and health without obsolete fallback', async () => {
    assert(providerFixture, 'HTTP fixture setup failed');
    const [primary, fallback] = providerFixture.providers;
    const observations = [];
    for (const [index, transition] of ['offline', 'network', 'endpoint'].entries()) {
      const target = `sat:${4300 + index}`;
      const requestPath = `/r/sat/${4300 + index}`;
      await cdp.evaluate('window.satBrowser.settings.update({ offlineMode: false, network: "mainnet", localOnly: true, requestTimeoutMs: 5000 })');
      await cdp.evaluate(`window.satBrowser.providers.upsert(${JSON.stringify(primary)})`);
      providerFixture.modes.set(`primary:${requestPath}`, 'timeout');
      providerFixture.modes.set('primary:/r/blockheight', 'timeout');
      const startSequence = providerFixture.requests.length;
      await cdp.evaluate(`(() => {
        const capture = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: { code: error.code, status: error.status, retryable: error.retryable } }));
        window.__betaTransitionNavigation = capture(window.satBrowser.navigation.resolve(${JSON.stringify(target)}));
        window.__betaTransitionHealth = capture(window.satBrowser.providers.health());
        return true;
      })()`);
      await poll(async () => providerFixture.requests.slice(startSequence),
        (requests) => requests.some((item) => item.provider === 'primary' && item.path === requestPath) && requests.some((item) => item.provider === 'primary' && item.path === '/r/blockheight'), stepTimeoutMs, `${transition} pending HTTP requests`);

      if (transition === 'offline') await cdp.evaluate('window.satBrowser.settings.update({ offlineMode: true })');
      else if (transition === 'network') await cdp.evaluate('window.satBrowser.settings.update({ network: "testnet" })');
      else await cdp.evaluate(`window.satBrowser.providers.upsert(${JSON.stringify({ ...primary, baseUrl: fallback.baseUrl })})`);
      const outcome = await cdp.evaluate('Promise.all([window.__betaTransitionNavigation, window.__betaTransitionHealth])');
      assert(outcome.every((item) => item.ok === false && item.error.code === 'ROUTING_INVALIDATED' && item.error.status === 409 && item.error.retryable === true), `${transition} did not preserve routing cancellation metadata: ${JSON.stringify(outcome)}`);
      const requests = await poll(async () => providerFixture.requests.slice(startSequence),
        (entries) => entries.filter((item) => item.provider === 'primary' && [requestPath, '/r/blockheight'].includes(item.path)).every((item) => item.closed), 3000, `${transition} aborted transport closure`);
      const targetRequests = requests.filter((item) => item.path === requestPath);
      assert(targetRequests.length === 1 && targetRequests[0].provider === 'primary' && targetRequests[0].completed === false, `${transition} continued fallback or completed obsolete HTTP response`);
      assert(requests.find((item) => item.provider === 'primary' && item.path === '/r/blockheight').completed === false, `${transition} did not abort the old health connection`);
      if (transition === 'offline') assert((await cdp.evaluate('window.satBrowser.providers.health()')).length === 0, 'offline health emitted new work');
      if (transition === 'endpoint') assert((await cdp.evaluate('window.satBrowser.providers.list()')).find((item) => item.id === primary.id).health === null, 'obsolete health returned after endpoint edit');
      providerFixture.modes.delete(`primary:${requestPath}`);
      providerFixture.modes.delete('primary:/r/blockheight');
      observations.push({ transition, navigation: outcome[0].error, health: outcome[1].error, targetRequestCount: targetRequests.length, oldConnectionsClosed: true });
    }
    await cdp.evaluate(`window.satBrowser.providers.upsert(${JSON.stringify(primary)})`);
    await cdp.evaluate('window.satBrowser.settings.update({ offlineMode: false, network: "mainnet" })');
    const health = await cdp.evaluate('window.satBrowser.providers.health()');
    assert(health.length === 2 && health.every((item) => item.ok), 'current configuration could not recover after routing invalidation');
    await cdp.evaluate('delete window.__betaTransitionNavigation; delete window.__betaTransitionHealth; true');
    return { observations, currentRoutingRecovered: true };
  });

  await check('offline restart serves fresh/stale cache, rejects corruption/misses, and sends zero provider requests', async () => {
    assert(providerFixture, 'HTTP fixture setup failed');
    for (const sat of ['4100', '4101', '4102']) await cdp.evaluate(`window.satBrowser.navigation.resolve('sat:${sat}')`);
    await navigateShell(cdp, 'sat:4100', '4100');
    await cdp.evaluate('window.satBrowser.settings.update({ offlineMode: true })');
    const requestCount = providerFixture.requests.length;
    const explicitHealth = await cdp.evaluate('window.satBrowser.providers.health()');
    assert(explicitHealth.length === 0, 'health check did not honor offline mode');
    await new Promise((resolve) => setTimeout(resolve, 400));
    allRendererEvents.push(...cdp.events);
    await stop(instance);
    instance = null;

    const legacyNonce = crypto.randomUUID().slice(0, 8);
    retainedLegacyProvider = {
      id: `beta-legacy-mempool-${legacyNonce}`,
      name: `Beta legacy Mempool ${legacyNonce}`,
      type: 'mempool', network: 'mainnet', baseUrl: providerFixture.providers[0].baseUrl,
      priority: 997, enabled: true, local: true, capabilities: ['block', 'satpoint'], cookieFile: ''
    };
    await seedLegacyProviderFixture(profile, retainedLegacyProvider);

    const cacheIndexPath = path.join(profile, 'cache', 'index.json');
    const cacheIndex = JSON.parse(await fs.readFile(cacheIndexPath, 'utf8'));
    const stale = Object.entries(cacheIndex).find(([, entry]) => entry.meta?.canonical === 'sat:4100');
    const corrupt = Object.entries(cacheIndex).find(([, entry]) => entry.meta?.canonical === 'sat:4101');
    assert(stale && corrupt, 'HTTP entity fixtures were not persisted in the cache');
    stale[1].expiresAt = Date.now() - 1000;
    await fs.writeFile(cacheIndexPath, JSON.stringify(cacheIndex), { mode: 0o600 });
    const corruptPath = path.join(profile, 'cache', 'objects', corrupt[0]);
    const bytes = await fs.readFile(corruptPath);
    bytes[0] ^= 1; // Same-size corruption must fail the stored SHA-256 check.
    await fs.writeFile(corruptPath, bytes, { mode: 0o600 });

    instance = await launch(executable, profile, await reservePort());
    cdp = instance.cdp;
    const restoredOffline = await poll(() => cdp.evaluate(`(async () => ({
      bootstrap: await window.satBrowser.app.bootstrap(), health: await window.satBrowser.providers.health(),
      network: document.querySelector('#network-status')?.textContent, page: document.querySelector('#page')?.innerText,
      target: document.querySelector('#omnibox')?.value,
      canonical: document.querySelector('#page .page-header-copy > p')?.textContent,
      entityLoaded: Boolean(document.querySelector('#page .entity-layout'))
    }))()`), (value) => value.target === 'sat:4100' && value.canonical === 'sat:4100'
      && value.entityLoaded && !/Navigation error/i.test(value.page), stepTimeoutMs,
    'offline restored entity before provider workflow navigation');
    assert(restoredOffline.bootstrap.state.settings.offlineMode === true && restoredOffline.network === 'Offline · cached pages only', 'offline setting/indicator did not survive restart');
    assert(restoredOffline.target === 'sat:4100' && restoredOffline.page.includes('4100') && !/Navigation error/i.test(restoredOffline.page), 'offline active tab was not restored from cache before provider workflow navigation');
    assert(restoredOffline.health.length === 0 && providerFixture.requests.length === requestCount, 'immediate offline restart emitted provider HTTP traffic');
    const legacyWorkflow = await runPackagedProviderControlChecks({ cdp, poll, assert,
      fixtureProvider: { id: `beta-provider-restart-${legacyNonce}`, name: `Beta provider restart ${legacyNonce}`, baseUrl: providerFixture.providers[0].baseUrl },
      legacyProvider: retainedLegacyProvider, retainLegacyForRestart: true });
    assert(legacyWorkflow.deferredCleanup?.providerId === retainedLegacyProvider.id, 'Legacy provider workflow did not retain its repaired fixture for restart readback');
    await navigateShell(cdp, 'sat:4100', '4100');
    const offline = await cdp.evaluate(`(async () => ({
      bootstrap: await window.satBrowser.app.bootstrap(),
      stale: await window.satBrowser.navigation.resolve('sat:4100'),
      fresh: await window.satBrowser.navigation.resolve('sat:4102'),
      health: await window.satBrowser.providers.health(),
      network: document.querySelector('#network-status')?.textContent,
      cache: document.querySelector('#cache-status')?.textContent,
      page: document.querySelector('#page')?.innerText
    }))()`);
    assert(offline.bootstrap.state.settings.offlineMode === true && offline.network === 'Offline · cached pages only', 'offline setting/indicator changed during provider workflow');
    assert(offline.stale.cache === 'stale' && offline.stale.attempts.length === 0 && offline.fresh.cache === 'hit', 'offline stale/fresh cache behavior changed');
    assert(offline.page.includes('4100') && !/Navigation error/i.test(offline.page), 'explicit post-workflow offline navigation failed');
    assert(/^Cache (?!0 B)/.test(offline.cache), 'rendered cache statistics were not populated after restart');
    const damaged = await captureApi(cdp, "window.satBrowser.navigation.resolve('sat:4101')");
    const missing = await captureApi(cdp, "window.satBrowser.navigation.resolve('sat:4199')");
    assert(damaged.error?.code === 'OFFLINE_CACHE_MISS' && missing.error?.code === 'OFFLINE_CACHE_MISS', 'corrupt/missing offline data did not fail explicitly');
    assert(await exists(corruptPath) === false, 'same-size corrupted cache object survived startup repair');
    assert(offline.health.length === 0 && providerFixture.requests.length === requestCount, 'offline restart/browsing/health emitted provider HTTP traffic');

    // Use the rendered setting to exercise renderer refresh, not just the API.
    await navigateShell(cdp, 'satnav://settings', 'Settings');
    await cdp.evaluate(`document.querySelector('[aria-label="Offline mode"]').click()`);
    const onlineUi = await poll(() => cdp.evaluate(`({ network: document.querySelector('#network-status')?.textContent, settings: document.querySelector('#page')?.innerText })`),
      (value) => /sources? passed last check/i.test(value.network), stepTimeoutMs, 'rendered online health recovery');
    const refreshed = await navigateShell(cdp, 'sat:4100', '4100');
    assert(!/Navigation error/i.test(refreshed.page) && providerFixture.requests.length > requestCount, 'returning online did not resume provider resolution');
    return { stale: offline.stale.cache, fresh: offline.fresh.cache, corrupt: damaged.error, miss: missing.error, offlineRequestDelta: 0,
      onlineNetwork: onlineUi.network, renderedCache: offline.cache,
      restoredBeforeProviderWorkflow: { target: restoredOffline.target, canonical: restoredOffline.canonical,
        entityLoaded: restoredOffline.entityLoaded, offlineRequestDelta: 0 },
      legacyWorkflow: legacyWorkflow.evidence.find((item) => item.branch === 'legacy-disable-repair-enable') };
  });

  await check('packaged startup recovers a corrupt primary from backup and announces recovery', async () => {
    assert(providerFixture, 'HTTP fixture setup failed');
    await cdp.evaluate(`(async () => {
      await window.satBrowser.settings.update({ offlineMode: true });
      await window.satBrowser.bookmarks.toggle({ canonical: 'sat:4200', title: 'Recovery sentinel' });
      await window.satBrowser.settings.update({ theme: 'dark' });
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    allRendererEvents.push(...cdp.events);
    await stop(instance);
    instance = null;
    const backupPath = path.join(profile, 'state', 'state.backup.json');
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
    assert(backup.settings.offlineMode === true && backup.bookmarks.some((entry) => entry.title === 'Recovery sentinel'), 'valid backup did not contain the recovery sentinel');
    await fs.writeFile(path.join(profile, 'state', 'state.json'), '{ interrupted test-fixture write', { mode: 0o600 });
    const requestCount = providerFixture.requests.length;
    instance = await launch(executable, profile, await reservePort());
    cdp = instance.cdp;
    const recovered = await cdp.evaluate(`(async () => ({ data: await window.satBrowser.app.bootstrap() }))()`);
    // The IPC bootstrap can resolve before the renderer finishes its own
    // bootstrap continuation. Observe the real announcement after it renders.
    await poll(() => cdp.evaluate(`document.body.innerText.includes('State recovered from backup')`),
      (visible) => visible === true, stepTimeoutMs, 'backup recovery announcement');
    assert(recovered.data.stateRecovery?.source === 'backup' && recovered.data.stateRecovery.reason === 'invalid', 'packaged startup did not identify backup recovery');
    assert(recovered.data.state.bookmarks.some((entry) => entry.title === 'Recovery sentinel'), 'backup recovery lost the persisted bookmark');
    assert(recovered.data.state.settings.offlineMode === true && providerFixture.requests.length === requestCount, 'recovered offline state contacted providers');
    assert(retainedLegacyProvider, 'Legacy provider restart fixture was not retained');
    const expectedLegacy = { ...retainedLegacyProvider, capabilities: ['block'] };
    const persistedLegacy = recovered.data.state.providers.find((item) => item.id === retainedLegacyProvider.id);
    assert(exactJson(persistedLegacy) === exactJson(expectedLegacy), 'Repaired legacy provider did not survive restart with its exact enabled configuration');
    const retainedLegacyId = retainedLegacyProvider.id;
    await cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(retainedLegacyId)})`);
    assert((await cdp.evaluate('window.satBrowser.providers.list()')).every((item) => item.id !== retainedLegacyId), 'Repaired legacy provider cleanup did not persist');
    retainedLegacyProvider = null;
    assert(JSON.parse(await fs.readFile(path.join(profile, 'state', 'state.json'), 'utf8')).bookmarks.some((entry) => entry.title === 'Recovery sentinel'), 'recovery did not repair the primary state file');
    return { recovery: recovered.data.stateRecovery, bookmarkRestored: true, primaryRepaired: true, offlineRequestDelta: 0,
      legacyProviderRestartReadback: { enabled: true, capabilities: ['block'], cleaned: true } };
  });

  await check('app quit stops its managed child and provider/service removals persist across restart', async () => {
    const service = lifecycleService('beta-service-quit');
    await cdp.evaluate(`window.satBrowser.services.upsert(${JSON.stringify(service)})`);
    const running = await cdp.evaluate("window.satBrowser.services.start('beta-service-quit')");
    assert(running.status === 'running' && processExists(running.pid), 'quit fixture child was not running');
    await poll(() => cdp.evaluate("window.satBrowser.services.list().then((list) => list.find((item) => item.id === 'beta-service-quit').logs)"),
      (logs) => logs.some((item) => item.text.includes('fixture stdout wait')), stepTimeoutMs, 'quit fixture readiness');
    const draftNonce = crypto.randomUUID().slice(0, 8);
    const disabledDraftCandidate = { id: `beta-disabled-draft-${draftNonce}`, name: `Beta disabled draft ${draftNonce}`, type: 'mempool',
      network: 'mainnet', baseUrl: providerFixture.providers[0].baseUrl, priority: 998, enabled: false, local: true, capabilities: [], cookieFile: '' };
    const draftCreated = await createDisabledEmptyProviderDraft({ cdp, poll, assert, provider: disabledDraftCandidate,
      setOwnedProvider: (provider) => { retainedDisabledDraft = provider; } });
    assert(retainedDisabledDraft?.id === disabledDraftCandidate.id
      && draftCreated.deferredCleanup?.providerId === retainedDisabledDraft.id && draftCreated.preexistingStatePreserved,
      'Disabled-empty draft was not retained for ordinary restart readback with preserved state');
    allRendererEvents.push(...cdp.events);
    await stop(instance);
    assert(instance.child.exitCode === 0, `app quit did not complete cleanly: ${instance.child.exitCode ?? instance.child.signalCode}`);
    assert(!processExists(running.pid), 'application quit left its managed fixture child alive');
    instance = null;
    instance = await launch(executable, profile, await reservePort());
    cdp = instance.cdp;
    const draftRestart = await verifyDisabledEmptyProviderDraftAfterRestart({ cdp, poll, assert, provider: retainedDisabledDraft });
    retainedDisabledDraft = null;
    const restored = (await cdp.evaluate('window.satBrowser.services.list()')).find((item) => item.id === service.id);
    assert(restored?.status === 'stopped' && restored.pid === null, 'non-autostart service resumed on app restart');
    const removal = await cdp.evaluate(`(async () => {
      for (const provider of await window.satBrowser.providers.list()) {
        await window.satBrowser.providers.remove(provider.id);
        await window.satBrowser.providers.remove(provider.id);
      }
      await window.satBrowser.services.remove(${JSON.stringify(service.id)});
      await window.satBrowser.services.remove(${JSON.stringify(service.id)});
      return window.satBrowser.app.bootstrap();
    })()`);
    assert(removal.providers.length === 0 && removal.state.settings.preferredProviderId === null, 'provider removal did not clear list and preferred ID');
    assert(removal.services.every((item) => !item.id.startsWith('beta-service-')), 'removed lifecycle fixture remained visible');
    const requestCount = providerFixture.requests.length;
    allRendererEvents.push(...cdp.events);
    await stop(instance);
    instance = null;
    instance = await launch(executable, profile, await reservePort());
    cdp = instance.cdp;
    const persisted = await cdp.evaluate('window.satBrowser.app.bootstrap()');
    assert(persisted.providers.length === 0 && persisted.state.providers.length === 0 && persisted.state.settings.preferredProviderId === null, 'provider removal resurrected defaults or preference after restart');
    assert(persisted.services.every((item) => !item.id.startsWith('beta-service-')), 'removed service returned after restart');
    assert(providerFixture.requests.length === requestCount, 'restart after provider removal contacted former providers');
    return { appQuitExitCode: 0, managedPid: running.pid, childTerminated: true, nonAutostartRestoredStopped: true,
      removedProviderCount: removal.providers.length, removalsPersisted: true, disabledEmptyDraftRestart: draftRestart, requestDeltaAfterRemoval: 0 };
  });

} catch (error) {
  results.push({ name: 'packaged smoke infrastructure', ok: false, durationMs: 0, error: error.stack || error.message });
  console.error(`FAIL  packaged smoke infrastructure: ${error.message}`);
  process.exitCode = 1;
} finally {
  await finalizePackagedEvidence(async () => {
  const deferredProviderCleanupErrors = [];
  if (retainedLegacyProvider && instance?.cdp) {
    try {
      await instance.cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(retainedLegacyProvider.id)})`);
      const retainedId = retainedLegacyProvider.id;
      const remaining = await instance.cdp.evaluate('window.satBrowser.providers.list()');
      assert(remaining.every((item) => item.id !== retainedId), 'Deferred legacy provider fixture remained after finalizer cleanup');
      retainedLegacyProvider = null;
    } catch (error) { deferredProviderCleanupErrors.push({ fixture: 'legacy-provider', error }); }
  }
  if (retainedDisabledDraft && instance?.cdp) {
    try {
      const retainedId = retainedDisabledDraft.id;
      await instance.cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(retainedId)})`);
      const remaining = await instance.cdp.evaluate('window.satBrowser.providers.list()');
      assert(remaining.every((item) => item.id !== retainedId), 'Deferred disabled draft remained after finalizer cleanup');
      retainedDisabledDraft = null;
    } catch (error) { deferredProviderCleanupErrors.push({ fixture: 'disabled-draft', error }); }
  }
  await stop(instance, { fatalOnUnconfirmed: false });
  for (const entry of deferredProviderCleanupErrors) {
    results.push({ name: `deferred ${entry.fixture} cleanup`, ok: false, durationMs: 0,
      error: String(entry.error.stack ?? entry.error.message).slice(0, 4096) });
    process.exitCode = 1;
  }
  if (instance?.cdp) allRendererEvents.push(...instance.cdp.events);
  const rendererErrors = allRendererEvents.filter((event) => event.method === 'Runtime.exceptionThrown');
  await check('trusted renderers emitted no uncaught exceptions, application preload failures, or unclassified sandbox bootstrap failures', async () => {
    assert(rendererErrors.length === 0, `${rendererErrors.length} uncaught renderer exception(s)`);
    const output = allProcessOutput.text;
    const applicationPreloadLoadFailures = (output.match(/Unable to load preload script|Error occurred while loading preload script/gi) ?? []).length;
    const sandboxScriptFailureLines = (output.match(/sandboxed_renderer\.bundle\.js script failed to run/gi) ?? []).length;
    const nullStartupDataLines = (output.match(/binding\.startupData[^\n]*is null/gi) ?? []).length;
    const evidence = { exceptions: rendererErrors.length, applicationPreloadLoadFailures, sandboxScriptFailureLines, nullStartupDataLines, outputCapture: allProcessOutput.snapshot() };
    // These are counts of diagnostic lines, not distinct incidents or contexts.
    // Keep both counts even on failure so the report does not imply zero errors.
    if (evidence.outputCapture.truncated || applicationPreloadLoadFailures || sandboxScriptFailureLines || nullStartupDataLines) {
      const error = new Error(`Electron reported ${applicationPreloadLoadFailures} application preload failures, ${sandboxScriptFailureLines} sandbox script-failure lines, ${nullStartupDataLines} null startup-data lines; output truncated: ${evidence.outputCapture.truncated}`);
      error.evidence = evidence;
      throw error;
    }
    return evidence;
  });
  await check('every packaged launch shuts down cleanly without a forced exit', async () => {
    const expected = allStops.filter((entry) => entry.expectClean);
    assert(expected.length > 0, 'No packaged clean-exit observations were recorded');
    const failures = expected.filter((entry) => !entry.closeConfirmed || entry.forced || entry.exitCode !== 0 || entry.signalCode !== null
      || entry.spawnError || entry.killError || entry.initialSignalError);
    const sampleFailures = allStops.filter(({ nativeStackSample: sample }) => sample
      && (!sample.closeConfirmed || sample.forced || sample.exitCode !== 0 || sample.signal !== null || sample.spawnError || sample.killError || sample.outputTruncated || !sample.readback));
    if (failures.length || sampleFailures.length) {
      const error = new Error(`${failures.length} packaged launch(es) had failed shutdown; ${sampleFailures.length} native sampler(s) lacked complete clean-close evidence`);
      error.evidence = { launches: allStops };
      throw error;
    }
    return { launches: expected };
  });
  await providerFixture?.close();
  let rendererDiagnostics = [];
  let rendererDiagnosticsReadError = null;
  try {
    // Read only this generated fixture profile's structured application log.
    // Production attribution omits arbitrary console text and browsing paths.
    const ownedPids = new Set(allStops.map((entry) => entry.pid));
    const log = await fs.readFile(path.join(profile, 'logs', 'satoshi-browser.jsonl'), 'utf8');
    rendererDiagnostics = log.split('\n').filter(Boolean).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.event === 'renderer.bootstrap' && ownedPids.has(entry.pid) ? [entry] : [];
      } catch { return []; }
    }).slice(-200);
  } catch (error) { rendererDiagnosticsReadError = error.code ?? error.message; }
  const profileRetention = decideProfileRetention(keepProfile, allStops);
  const report = {
    generatedAt: new Date().toISOString(),
    executable,
    // Selection records the requested input, not proof of signature validity.
    artifactSelection: executableArgument ? 'explicit-executable' : unsignedWindowsBeta ? 'unsigned-windows-beta' : unsignedMacosBeta ? 'unsigned-macos-beta' : distributionBuild ? 'distribution' : 'developer',
    asarSha256,
    platform: process.platform,
    arch: process.arch,
    profile: profileRetention.retained ? profile : '[removed]',
    profileRetention,
    passed: results.filter((result) => result.ok && !result.skipped).length,
    failed: results.filter((result) => !result.ok).length,
    skipped: results.filter((result) => result.skipped).length,
    results,
    rendererDiagnostics,
    rendererDiagnosticsReadError,
    unconfirmedOwnedProcesses: [...unconfirmedChildren].map((child) => ({ pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode, closeConfirmed: false })),
    outputCapture: allProcessOutput.snapshot(),
    processOutput: allProcessOutput.text
  };
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: reportArgument ? 'wx' : 'w', mode: 0o600 });
  if (!profileRetention.retained) await fs.rm(profile, { recursive: true, force: true });
  console.log(`\nPackaged smoke report: ${reportFile}`);
  console.log(`${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  if (report.failed) process.exitCode = 1;
  }, (error) => {
    // Covers errors anywhere in finalization, including fixture shutdown before
    // normal report writing. Preserve a bounded ownership fallback before unref.
    console.error(JSON.stringify({ finalizationError: String(error.code ?? error.message).slice(0, 512), retainedProfile: profile,
      unconfirmedOwnedProcesses: [...unconfirmedChildren].map((child) => ({ pid: child.pid ?? null, closeConfirmed: false })) }));
  }, unconfirmedChildren);
}
