import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { boundedDiagnosticValue, buildAppPreloadProbe, createBoundedOutput, validateCdpObserver, validateStartupMarkers, waitForStartupChildClose } from './startup-diagnostic-support.mjs';
import { STARTUP_BARRIER_MODES, STARTUP_CONTINUATION_MODE, runStartupBarrierCase, validateStartupBarrierEvents, readStartupInput, captureStartupContinuationInputs } from './startup-barrier-support.mjs';
import { finalizePackagedEvidence } from './packaged-smoke-child-lifecycle.mjs';

// Experimental macOS-only diagnostic utility, not a release gate. The original
// single-window/no-extension matrix ran successfully without reproducing the
// packaged failure. Completion requires both independently identified windows'
// preload markers and load completion; an exit code alone is not valid evidence.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = path.join(root, 'tests', 'fixtures', 'wallet-startup');
const preloadPath = path.join(fixtureDirectory, 'preload.cjs');
const walletExtensionPath = path.join(root, 'tests', 'fixtures', 'wallet-extension');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const barrierSelection = argument('startup-barrier');
const reportName = argument('report') ?? (barrierSelection ? `wallet-startup-barrier-${Date.now()}.json` : 'wallet-startup-diagnostic-report.json');
if (!/^wallet-startup-(?:diagnostic-report|barrier-[a-zA-Z0-9-]+)\.json$/.test(reportName)) throw new Error('Invalid startup report basename');
const reportPath = path.join(root, 'release', reportName);
const unconfirmedChildren = new Set();
const retainedProfiles = new Set();

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function runElectronCase() {
  if (barrierSelection) {
    return runStartupBarrierCase({ mode: barrierSelection, port: Number(argument('startup-barrier-port')),
      preloadPath: path.join((await import('electron')).app.getPath('userData'), 'startup-app-preload.cjs'),
      htmlPath: path.join(fixtureDirectory, 'index.html') });
  }
  const { app, BrowserWindow, ipcMain, protocol, session } = await import('electron');
  const caseName = argument('case');
  const persistent = argument('persistent') === 'true';
  const transport = argument('transport');
  const loadExtension = argument('load-extension') === 'true';
  const keepWindow = argument('keeper') !== 'false';
  const mainWindowStyle = argument('window-style') === 'main';
  const appPreload = argument('preload-style') === 'app';
  const remoteDebugging = argument('remote-debugging') === 'true';
  const observerMode = argument('observer') ?? 'none';
  const observed = observerMode !== 'none';
  app.enableSandbox();
  if (transport === 'app') protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } },
    { scheme: 'ord', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
  ]);

  let sequence = 0;
  const startedAt = Date.now();
  const safe = (read, fallback = null) => { try { return read(); } catch { return fallback; } };
  const location = (value) => {
    if (!value) return '[empty]';
    if (value === 'https://wallet.satoshi.invalid/index.html' || value === 'app://app/renderer/index.html' || value === 'about:blank') return value;
    if (typeof value === 'string' && value.startsWith('data:')) return 'data:[fixture]';
    return '[other]';
  };
  const log = (event, details = {}) => {
    if (sequence >= 500) return;
    console.log(JSON.stringify({ event, caseName, pid: process.pid, sequence: ++sequence,
      timestampMs: Date.now(), elapsedMs: Date.now() - startedAt, ...boundedDiagnosticValue(details) }));
  };
  app.on('web-contents-created', (_event, contents) => {
    const frameDetails = (frame) => ({ frameUrl: location(safe(() => frame?.url)),
      frameProcessId: safe(() => frame?.processId), frameRoutingId: safe(() => frame?.routingId),
      mainFrame: frame ? safe(() => frame === frame.top) : null });
    const details = () => ({ webContentsId: contents.id, type: safe(() => contents.getType()),
      url: location(safe(() => contents.getURL())), rendererPid: safe(() => contents.getOSProcessId()) });
    log('web-contents-created', details());
    contents.on('did-start-navigation', (event) => log('did-start-navigation', { ...details(), navigationUrl: location(event.url), isMainFrame: event.isMainFrame, ...frameDetails(safe(() => event.frame)) }));
    contents.on('did-frame-navigate', (_event, url, _status, _text, isMainFrame, processId, routingId) => log('did-frame-navigate', { ...details(), navigationUrl: location(url), isMainFrame, processId, routingId }));
    contents.on('console-message', (event) => {
      if (event.sourceId !== 'node:electron/js2c/sandbox_bundle') return;
      const message = typeof event.message === 'string' ? event.message.slice(0, 1_024) : '';
      const code = /sandboxed_renderer\.bundle\.js script failed to run/.test(message) ? 'SANDBOX_BUNDLE_SCRIPT_FAILED'
        : /startupData[^\n]*null/.test(message) ? 'SANDBOX_STARTUP_DATA_NULL' : 'OTHER_ELECTRON_SANDBOX_CONSOLE';
      log('console-message', { ...details(), ...frameDetails(safe(() => event.frame)), code, level: event.level, line: event.lineNumber });
    });
    contents.on('preload-error', () => log('preload-error', details()));
    contents.on('dom-ready', () => log('dom-ready', details()));
    contents.once('destroyed', () => log('web-contents-destroyed', { webContentsId: contents.id }));
    contents.on('render-process-gone', (_event, detailsGone) => log('render-process-gone', { ...details(), details: detailsGone }));
  });
  app.on('before-quit', () => log('before-quit'));
  app.on('will-quit', () => log('will-quit'));
  app.on('quit', (_event, exitCode) => log('quit', { exitCode }));
  // Keep the controlled zero-window reopen interval alive without adding a
  // second BrowserWindow in no-keeper cases. Finish/outer deadline own exit.
  app.on('window-all-closed', () => log('window-all-closed'));

  await app.whenReady();
  const partition = transport === 'app' ? 'persist:satoshi-browser-app'
    : persistent ? 'persist:wallet-startup-diagnostic' : 'wallet-startup-diagnostic';
  const targetSession = session.fromPartition(partition, { cache: true });
  const casePreloadPath = appPreload ? path.join(app.getPath('userData'), 'startup-app-preload.cjs') : preloadPath;
  targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith('https://wallet.satoshi.invalid/') && !details.url.startsWith('chrome-extension://') && !details.url.startsWith('app://app/') });
  });
  const walletUrl = 'https://wallet.satoshi.invalid/index.html';
  const fixtureUrl = transport === 'app' ? 'app://app/renderer/index.html' : walletUrl;
  log('case-start', { electron: process.versions.electron, persistent, transport, loadExtension, partition, keepWindow, mainWindowStyle, appPreload, remoteDebugging, observerMode });
  if (appPreload) log('preload-payload', {
    productionSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'src', 'main', 'preload.cjs'))).digest('hex'),
    probeSha256: createHash('sha256').update(await fs.readFile(casePreloadPath)).digest('hex')
  });
  if (transport === 'https' || transport === 'app') {
    await targetSession.protocol.handle(transport, async (request) => {
      if (request.url !== fixtureUrl) return new Response('not found', { status: 404 });
      return new Response(await fs.readFile(path.join(fixtureDirectory, 'index.html')), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'content-security-policy': "default-src 'self'; script-src 'self' chrome-extension:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-origin',
          'x-content-type-options': 'nosniff'
        }
      });
    });
  }
  if (loadExtension) {
    let extension;
    try {
      extension = await targetSession.extensions.loadExtension(walletExtensionPath, { allowFileAccess: false });
    } catch (error) {
      log('extension-load-unsupported', { code: /temporary session/i.test(String(error.message))
        ? 'TEMPORARY_SESSION_EXTENSION_UNSUPPORTED' : 'EXTENSION_LOAD_FAILED' });
      app.quit();
      return;
    }
    log('extension-loaded', { extensionId: extension.id, extensionName: extension.name, extensionVersion: extension.version });
  }

  const target = transport === 'https' || transport === 'app'
    ? fixtureUrl
    : `data:text/html;charset=utf-8,${encodeURIComponent(await fs.readFile(path.join(fixtureDirectory, 'index.html'), 'utf8'))}`;
  let completed = false;
  let phase = 0;
  let window;
  const markedPhases = new Set();
  const loadedPhases = new Set();
  const progressedPhases = new Set();
  let keeperWindow;
  const productionWindowFactory = mainWindowStyle ? (await import('../src/main/window.js')).createMainWindow : null;
  const finish = (reason) => {
    if (completed) return;
    completed = true;
    log('finish', { reason, keeperAlive: keeperWindow ? !keeperWindow.isDestroyed() : null });
    setTimeout(() => app.quit(), 50);
  };
  const advance = (currentPhase, currentWindow) => {
    if (completed || progressedPhases.has(currentPhase) || !markedPhases.has(currentPhase) || !loadedPhases.has(currentPhase)) return;
    progressedPhases.add(currentPhase);
    if (currentPhase === 1) {
      setTimeout(() => {
        currentWindow.destroy();
        setTimeout(() => { if (!completed) createWindow(); }, 150);
      }, remoteDebugging ? 350 : 25);
    } else if (remoteDebugging) setTimeout(() => finish('second-preload-marker'), 750);
    else finish('second-preload-marker');
  };
  ipcMain.on('wallet-startup:preload', (event, marker) => {
    if (completed || !window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || markedPhases.has(phase)
      || marker?.href !== target || marker?.sandboxed !== true || marker?.contextIsolated !== true) {
      log('preload-marker-rejected', { phase, webContentsId: event.sender.id });
      return;
    }
    log('preload-marker', { phase, webContentsId: event.sender.id, url: location(event.sender.getURL()),
      marker: { href: location(marker.href), sandboxed: marker.sandboxed, contextIsolated: marker.contextIsolated } });
    markedPhases.add(phase);
    advance(phase, window);
  });

  function createWindow() {
    phase += 1;
    window = productionWindowFactory ? productionWindowFactory({
      preloadPath: casePreloadPath,
      // Real BrowserWindow construction, with disposable no-disk bounds state.
      // The document and marker preload remain diagnostic fixtures, not app UI.
      stateStore: { get: () => null, mutate: async (callback) => { const draft = {}; callback(draft); return draft; } },
      logger: { warn: (event) => log('main-window-warning', { code: event }), error: (event) => log('main-window-error', { code: event }) }
    }) : new BrowserWindow({
      width: 480,
      height: 320,
      show: false,
      webPreferences: {
        preload: casePreloadPath,
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    });
    const currentPhase = phase;
    const currentWindow = window;
    currentWindow.once('ready-to-show', () => log('ready-to-show', { phase: currentPhase, webContentsId: currentWindow.webContents.id, url: location(currentWindow.webContents.getURL()) }));
    currentWindow.webContents.once('did-finish-load', () => {
      log('did-finish-load', { phase: currentPhase, webContentsId: currentWindow.webContents.id, url: location(currentWindow.webContents.getURL()) });
      loadedPhases.add(currentPhase);
      advance(currentPhase, currentWindow);
    });
    if (!productionWindowFactory) currentWindow.loadURL(target).catch((error) => log('load-error', { phase: currentPhase, code: error.code ?? 'LOAD_FAILED' }));
  }
  // Unrelated lifecycle keeper, not a parent-child BrowserWindow relationship.
  if (keepWindow) {
    keeperWindow = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: { partition: 'persist:wallet-startup-parent', nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    log('lifecycle-keeper', { webContentsId: keeperWindow.webContents.id });
    await keeperWindow.loadURL('data:text/html,<title>Lifecycle keeper</title>');
  }
  createWindow();
  setTimeout(() => finish('timeout'), 3_000).unref();
}

async function reserveDebugPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Could not reserve a bounded CDP observer port');
  return port;
}

async function observeAppTarget(port, spawnedAt, mode) {
  const milestones = [];
  let socket;
  const pending = new Map();
  let success = false;
  let errorCode = null;
  const mark = (name) => milestones.push({ name, elapsedMs: Math.max(0, Date.now() - spawnedAt) });
  try {
    let target;
    const discoveryDeadline = Date.now() + 4_000;
    for (let attempt = 0; attempt < 250 && Date.now() < discoveryDeadline && !target; attempt += 1) {
      try {
        const requestTimeout = Math.max(1, Math.min(250, discoveryDeadline - Date.now()));
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(requestTimeout), redirect: 'error' });
        if (response.ok) {
          const reader = response.body?.getReader();
          const chunks = [];
          let bytes = 0;
          while (reader && chunks.length < 64) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 64 * 1024) {
              await reader.cancel();
              throw new Error('DISCOVERY_OUTPUT_LIMIT');
            }
            chunks.push(value);
          }
          if (chunks.length >= 64) {
            await reader?.cancel();
            throw new Error('DISCOVERY_CHUNK_LIMIT');
          }
          const list = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString('utf8'));
          if (Array.isArray(list)) target = list.slice(0, 40).find((item) => item?.type === 'page'
            && item?.url === 'app://app/renderer/index.html' && typeof item?.webSocketDebuggerUrl === 'string');
        }
      } catch {}
      if (!target && Date.now() < discoveryDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!target) throw new Error('TARGET_NOT_DISCOVERED');
    if (target.webSocketDebuggerUrl.length > 4_096) throw new Error('TARGET_SOCKET_URL_INVALID');
    const socketUrl = new URL(target.webSocketDebuggerUrl);
    if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== '127.0.0.1' || Number(socketUrl.port) !== port
      || socketUrl.username || socketUrl.password || socketUrl.search || socketUrl.hash
      || !socketUrl.pathname.startsWith('/devtools/page/') || socketUrl.pathname.length > 1_024) {
      throw new Error('TARGET_SOCKET_URL_INVALID');
    }
    mark('target-discovered');
    if (mode === 'discovery') {
      success = true;
      return { mode, exercised: true, facade: null, milestones };
    }
    socket = new WebSocket(socketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SOCKET_TIMEOUT')), 1_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('SOCKET_ERROR')); }, { once: true });
    });
    mark('socket-open');
    const closeNotBefore = Date.now() + 250;
    if (mode === 'socket') {
      success = true;
    } else {
    let sequence = 0;
    let receivedBytes = 0;
    let receivedMessages = 0;
    socket.addEventListener('message', (event) => {
      receivedMessages += 1;
      receivedBytes += typeof event.data === 'string' ? Buffer.byteLength(event.data) : (event.data?.byteLength ?? 0);
      if (receivedMessages > 500 || receivedBytes > 128 * 1024 || typeof event.data !== 'string') {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('CDP_OUTPUT_LIMIT'));
        }
        pending.clear();
        try { socket.close(); } catch {}
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const waiter = pending.get(message?.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error('CDP_COMMAND_ERROR'));
      else waiter.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP_COMMAND_TIMEOUT'));
      }, 1_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const commands = mode === 'runtime'
      ? [['Runtime.enable', 'runtime-enabled']]
      : [['Runtime.enable', 'runtime-enabled'], ['Page.enable', 'page-enabled'], ['Log.enable', 'log-enabled']];
    for (const [method, milestone] of commands) {
      await send(method);
      mark(milestone);
    }
    if (mode === 'full') {
      const evaluated = await send('Runtime.evaluate', {
        expression: 'Boolean(window.satBrowser)', awaitPromise: true, returnByValue: true, userGesture: true
      });
      if (evaluated?.exceptionDetails || evaluated?.result?.value !== true) throw new Error('FACADE_NOT_AVAILABLE');
      mark('facade-true');
    }
    success = true;
    }
    const holdMs = closeNotBefore - Date.now();
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  } catch (error) {
    const known = new Set(['TARGET_NOT_DISCOVERED', 'TARGET_SOCKET_URL_INVALID', 'SOCKET_TIMEOUT', 'SOCKET_ERROR',
      'CDP_OUTPUT_LIMIT', 'CDP_COMMAND_ERROR', 'CDP_COMMAND_TIMEOUT', 'FACADE_NOT_AVAILABLE']);
    errorCode = known.has(error?.message) ? error.message : 'OBSERVER_FAILED';
  } finally {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('OBSERVER_CLEANUP'));
    }
    pending.clear();
    if (socket) {
      try {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.addEventListener('open', () => { try { socket.close(); } catch {} }, { once: true });
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 250);
            const done = () => { clearTimeout(timer); resolve(); };
            socket.addEventListener('open', done, { once: true });
            socket.addEventListener('error', done, { once: true });
            socket.addEventListener('close', done, { once: true });
          });
        }
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
        if (socket.readyState === WebSocket.OPEN) socket.close();
        if (socket.readyState !== WebSocket.CLOSED) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 500);
            socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      } catch {
        errorCode = 'SOCKET_CLEANUP_FAILED';
        success = false;
      }
      if (socket.readyState === WebSocket.CLOSED) mark('socket-closed');
      else {
        errorCode = 'SOCKET_CLEANUP_FAILED';
        success = false;
      }
    }
  }
  return { mode, exercised: success, facade: mode === 'full' ? success : null, milestones, ...(errorCode ? { error: errorCode } : {}) };
}

async function launch(executable, profile, testCase, run) {
  const loadExtension = testCase.loadExtensionRuns?.includes(run) === true;
  const debugPort = testCase.remoteDebugging ? await reserveDebugPort() : null;
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--disable-breakpad',
    ...(testCase.remoteDebugging ? [`--remote-debugging-port=${debugPort ?? 0}`, '--remote-debugging-address=127.0.0.1'] : []),
    fixtureDirectory, `--case=${testCase.name}`, `--persistent=${testCase.persistent}`, `--transport=${testCase.transport}`, `--load-extension=${loadExtension}`, `--keeper=${testCase.keeper !== false}`, `--window-style=${testCase.windowStyle ?? 'fixture'}`, `--preload-style=${testCase.preloadStyle ?? 'fixture'}`, `--remote-debugging=${Boolean(testCase.remoteDebugging)}`, `--observer=${testCase.observe ?? 'none'}`,
    ...(testCase.barrier ? [`--startup-barrier=${testCase.barrier}`, `--startup-barrier-port=${debugPort ?? 0}`] : [])];
    const spawnedAt = Date.now();
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    unconfirmedChildren.add(child);
    child.once('close', () => unconfirmedChildren.delete(child));
    const closeResult = waitForStartupChildClose(child, testCase.barrier ? 15_000 : 10_000);
    const observerResult = testCase.observe ? observeAppTarget(debugPort, spawnedAt, testCase.observe) : Promise.resolve(null);
    const stdout = createBoundedOutput();
    const stderr = createBoundedOutput();
    child.stdout.on('data', (chunk) => stdout.append(chunk));
    child.stderr.on('data', (chunk) => stderr.append(chunk));
      const closed = await closeResult;
      const { code, signal } = closed;
      const observer = await observerResult;
      const events = stdout.text.split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const markers = events.filter((event) => event.event === 'preload-marker').map((event) => event.marker);
      const marker = markers.at(-1) ?? null;
      const caseStart = events.find((event) => event.event === 'case-start') ?? null;
      const expectedUnsupported = events.some((event) => event.event === 'extension-load-unsupported' && event.code === 'TEMPORARY_SESSION_EXTENSION_UNSUPPORTED');
      return {
        case: testCase.name,
        run,
        spawnedAt,
        pid: child.pid ?? null,
        loadExtension,
        code,
        signal,
        ...closed,
        electron: caseStart?.electron ?? null,
        marker,
        markerValid: closed.closeConfirmed && !closed.forced && !closed.timedOut && !closed.spawnError && !stdout.truncated && !stderr.truncated && validateStartupMarkers(events)
          && (!testCase.observe || validateCdpObserver(observer, testCase.observe))
          && (!testCase.barrier || validateStartupBarrierEvents(events, testCase.barrier)),
        ...(testCase.barrier ? { barrierMode: testCase.barrier, profileState: run === 1 ? 'fresh' : 'reused',
          preReleaseSandboxRecords: events.filter(event => event.event === 'console-message' && event.observedBeforeResponseRelease === true).length,
          attribution: 'Console callback observed while fixture response held; not a native instruction timestamp' } : {}),
        markerCount: markers.length,
        expectedUnsupported,
        sandboxDiagnostic: events.some((event) => event.code === 'SANDBOX_BUNDLE_SCRIPT_FAILED' || event.code === 'SANDBOX_STARTUP_DATA_NULL') || /sandboxed_renderer\.bundle\.js script failed to run|binding\.startupData[^\n]*is null/i.test(stderr.text),
        outputTruncated: stdout.truncated || stderr.truncated,
        observer,
        events,
        stderr: stderr.text
      };
}

async function orchestrate() {
  await fs.access(electronExecutable);
  let cases = [
    { name: 'persistent-https', persistent: true, transport: 'https' },
    { name: 'memory-https', persistent: false, transport: 'https' },
    { name: 'persistent-data', persistent: true, transport: 'data' },
    { name: 'memory-data', persistent: false, transport: 'data' },
    { name: 'persistent-https-extension', persistent: true, transport: 'https', loadExtensionRuns: [1, 2] },
    { name: 'memory-https-extension', persistent: false, transport: 'https', loadExtensionRuns: [1, 2] },
    { name: 'persistent-https-extension-residue', persistent: true, transport: 'https', loadExtensionRuns: [1] },
    { name: 'persistent-https-no-keeper', persistent: true, transport: 'https', keeper: false },
    { name: 'persistent-data-no-keeper', persistent: true, transport: 'data', keeper: false },
    { name: 'persistent-app-minimal', persistent: true, transport: 'app', keeper: false },
    { name: 'persistent-app-main-window', persistent: true, transport: 'app', keeper: false, windowStyle: 'main' },
    { name: 'persistent-app-main-window-app-preload', persistent: true, transport: 'app', keeper: false, windowStyle: 'main', preloadStyle: 'app' },
    { name: 'persistent-app-debug-port', persistent: true, transport: 'app', keeper: false, windowStyle: 'main', preloadStyle: 'app', remoteDebugging: true },
    { name: 'persistent-app-debug-port-discovery', persistent: true, transport: 'app', keeper: false, windowStyle: 'main', preloadStyle: 'app', remoteDebugging: true, observe: 'discovery' },
    { name: 'persistent-app-debug-port-socket', persistent: true, transport: 'app', keeper: false, windowStyle: 'main', preloadStyle: 'app', remoteDebugging: true, observe: 'socket' },
    { name: 'persistent-app-debug-port-runtime', persistent: true, transport: 'app', keeper: false, windowStyle: 'main', preloadStyle: 'app', remoteDebugging: true, observe: 'runtime' },
    { name: 'persistent-app-debug-port-observed', persistent: true, transport: 'app', keeper: false, windowStyle: 'main', preloadStyle: 'app', remoteDebugging: true, observe: 'full' }
  ];
  const profileSelection = argument('startup-barrier-profiles') ?? 'fresh-reused';
  if (barrierSelection) {
    // Historical "all" remains the original four arms; continuation is explicit.
    const selected = barrierSelection === 'all' ? STARTUP_BARRIER_MODES.filter(mode => mode !== STARTUP_CONTINUATION_MODE) : barrierSelection.split(',');
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(mode => !STARTUP_BARRIER_MODES.includes(mode))) throw new Error('Invalid startup barrier case');
    if (!['fresh', 'fresh-reused'].includes(profileSelection)) throw new Error('Invalid startup barrier profiles');
    if (selected.includes(STARTUP_CONTINUATION_MODE) && profileSelection !== 'fresh-reused') throw new Error('Continuation requires fresh-reused profiles');
    cases = selected.map(mode => ({ name: `startup-barrier-${mode}`, barrier: mode, persistent: true, transport: 'app',
      keeper: false, preloadStyle: 'app', remoteDebugging: mode !== 'held-native-runtime' && mode !== STARTUP_CONTINUATION_MODE }));
    // New experiments must not overwrite retained historical evidence.
    try { await fs.access(reportPath); throw new Error('Startup barrier report already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const results = [];
  const profiles = [];
  let stoppedReason = null;
  for (const testCase of cases) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), `wallet-startup-${testCase.name}-`));
    retainedProfiles.add(profile);
    const profileRecord = { case: testCase.name, path: profile, removed: false, retainReason: null };
    profiles.push(profileRecord);
    let launchPending = false;
    let continuationBaseline = null;
    try {
      if (testCase.preloadStyle === 'app') {
        const prefix = testCase.barrier === STARTUP_CONTINUATION_MODE
          ? (await readStartupInput(path.join(root, 'src/main/preload.cjs'), 65536, true)).data
          : await fs.readFile(path.join(root, 'src', 'main', 'preload.cjs'));
        await fs.writeFile(path.join(profile, 'startup-app-preload.cjs'), buildAppPreloadProbe(prefix), { flag: 'wx', mode: 0o600 });
      }
      for (const run of (!barrierSelection || profileSelection === 'fresh-reused' ? [1, 2] : [1])) {
        const inputsBefore = testCase.barrier === STARTUP_CONTINUATION_MODE
          ? await captureStartupContinuationInputs(root, path.join(profile, 'startup-app-preload.cjs')) : null;
        if (inputsBefore && continuationBaseline && JSON.stringify(inputsBefore) !== JSON.stringify(continuationBaseline)) {
          profileRecord.retainReason = 'STARTUP_INPUT_CHANGED'; stoppedReason = 'STARTUP_INPUT_CHANGED'; break;
        }
        if (inputsBefore) continuationBaseline = inputsBefore;
        launchPending = true;
        const result = await launch(electronExecutable, profile, testCase, run);
        launchPending = false;
        results.push(result);
        if (inputsBefore) {
          result.inputProvenance = { before: inputsBefore, after: null, unchanged: false };
          const inputsAfter = await captureStartupContinuationInputs(root, path.join(profile, 'startup-app-preload.cjs'));
          result.inputProvenance.after = inputsAfter;
          result.inputProvenance.unchanged = JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter) && result.electron === inputsBefore.version;
          if (!result.inputProvenance.unchanged) {
            result.markerValid = false; profileRecord.retainReason = 'STARTUP_INPUT_CHANGED'; stoppedReason = 'STARTUP_INPUT_CHANGED'; break;
          }
        }
        console.log(`${testCase.name} run ${run} completed; closeConfirmed=${result.closeConfirmed}`);
        if (!result.closeConfirmed) {
          profileRecord.retainReason = 'OWNED_CLOSE_UNCONFIRMED';
          stoppedReason = 'OWNED_CLOSE_UNCONFIRMED';
          break;
        }
        if (testCase.barrier === STARTUP_CONTINUATION_MODE && (!result.markerValid || result.code !== 0 || result.signal)) {
          profileRecord.retainReason = 'CONTINUATION_EVIDENCE_INVALID';
          stoppedReason = 'CONTINUATION_EVIDENCE_INVALID';
          break;
        }
      }
    } catch (error) {
      stoppedReason = error?.code ?? 'STARTUP_ORCHESTRATION_FAILED';
      profileRecord.retainReason = launchPending ? 'LAUNCH_OWNERSHIP_UNCERTAIN' : 'SETUP_FAILED';
    } finally {
      if (!profileRecord.retainReason && !launchPending) {
        try { await fs.rm(profile, { recursive: true }); retainedProfiles.delete(profile); profileRecord.removed = true; profileRecord.path = '[removed]'; }
        catch (error) { profileRecord.retainReason = error?.code ?? 'PROFILE_CLEANUP_FAILED'; stoppedReason = 'PROFILE_CLEANUP_FAILED'; }
      }
    }
    if (stoppedReason) break;
  }
  const electronVersions = [...new Set(results.map((result) => result.electron).filter(Boolean))];
  const report = {
    generatedAt: new Date().toISOString(),
    electronVersions,
    sandbox: true,
    temporaryProfilesRemoved: profiles.every(profile => profile.removed),
    profiles,
    stoppedReason,
    expectedLaunches: cases.length * (!barrierSelection || profileSelection === 'fresh-reused' ? 2 : 1),
    complete: !stoppedReason && results.length === cases.length * (!barrierSelection || profileSelection === 'fresh-reused' ? 2 : 1),
    total: results.length,
    validMarkers: results.filter((result) => result.markerValid).length,
    expectedUnsupported: results.filter((result) => result.expectedUnsupported).length,
    sandboxDiagnostics: results.filter((result) => result.sandboxDiagnostic).length,
    results
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  if (barrierSelection && Buffer.byteLength(reportText) > 4 * 1024 * 1024) throw new Error('STARTUP_REPORT_LIMIT');
  await fs.writeFile(reportPath, reportText, barrierSelection ? { flag: 'wx', mode: 0o600 } : undefined);
  console.log(JSON.stringify({ reportPath, electronVersions, total: report.total, validMarkers: report.validMarkers, sandboxDiagnostics: report.sandboxDiagnostics }, null, 2));
  if (stoppedReason || results.some((result) => !result.closeConfirmed || result.spawnError || result.forced || result.timedOut || result.code !== 0 || result.signal || (!result.markerValid && !result.expectedUnsupported))) process.exitCode = 1;
}

if (process.versions.electron) {
  runElectronCase().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
} else {
  await finalizePackagedEvidence(orchestrate, async (error) => {
    process.stderr.write(`${JSON.stringify({ event: 'STARTUP_REPORT_FAILED', code: String(error?.code ?? 'STARTUP_ORCHESTRATION_FAILED').slice(0, 64),
      reportPath, retainedProfiles: [...retainedProfiles], unknownPids: [...unconfirmedChildren].map(child => child.pid ?? null) }).slice(0, 8192)}\n`);
  }, unconfirmedChildren);
}
