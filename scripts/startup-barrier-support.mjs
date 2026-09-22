import { createBoundedOutput } from './startup-diagnostic-support.mjs';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildAppPreloadProbe } from './startup-diagnostic-support.mjs';

export async function readStartupInput(filename, maxBytes, collect = false) {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('STARTUP_INPUT_NOT_BOUNDED_REGULAR');
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('STARTUP_INPUT_CHANGED');
    const hash = createHash('sha256'); const chunks = []; let bytes = 0; let header;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('STARTUP_INPUT_LIMIT');
      if (!header) header = chunk.subarray(0, 8);
      hash.update(chunk); if (collect) chunks.push(chunk);
    }
    const after = await handle.stat(); const current = await fs.lstat(filename);
    if (!current.isFile() || current.isSymbolicLink() || bytes !== before.size
      || [after, current].some(stat => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => stat[key] !== before[key]))) throw new Error('STARTUP_INPUT_CHANGED');
    const architecture = header?.length === 8 && header.readUInt32LE(0) === 0xfeedfacf
      ? ({ 16777228: 'arm64', 16777223: 'x64' })[header.readUInt32LE(4)] ?? null : null;
    return { path: filename, bytes, sha256: hash.digest('hex'), ...(architecture ? { architecture } : {}), ...(collect ? { data: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}

export async function captureStartupContinuationInputs(root, probePath) {
  const bundle = path.join(root, 'node_modules/electron/dist/Electron.app');
  const filenames = {
    executable: path.join(bundle, 'Contents/MacOS/Electron'),
    framework: path.join(bundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'),
    fixturePackage: path.join(root, 'tests/fixtures/wallet-startup/package.json'),
    fixtureIndex: path.join(root, 'tests/fixtures/wallet-startup/index.html'),
    electronPackage: path.join(root, 'node_modules/electron/package.json'),
    installedVersion: path.join(root, 'node_modules/electron/dist/version'),
    runner: path.join(root, 'scripts/diagnose-wallet-startup.mjs'),
    barrier: path.join(root, 'scripts/startup-barrier-support.mjs'),
    diagnosticSupport: path.join(root, 'scripts/startup-diagnostic-support.mjs'),
    finalizer: path.join(root, 'scripts/packaged-smoke-child-lifecycle.mjs')
  };
  const files = {};
  for (const [name, filename] of Object.entries(filenames)) files[name] = await readStartupInput(filename, name === 'framework' ? 512 * 1024 * 1024 : 1024 * 1024, ['electronPackage', 'installedVersion'].includes(name));
  const version = JSON.parse(files.electronPackage.data.toString('utf8')).version;
  const installedVersion = files.installedVersion.data.toString('utf8').trim();
  delete files.electronPackage.data;
  delete files.installedVersion.data;
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || version !== installedVersion
    || !files.executable.architecture || files.executable.architecture !== files.framework.architecture) throw new Error('STARTUP_RUNTIME_IDENTITY_INVALID');
  const prefix = await readStartupInput(path.join(root, 'src/main/preload.cjs'), 65536, true);
  const probe = await readStartupInput(probePath, 65536);
  const expected = createHash('sha256').update(buildAppPreloadProbe(prefix.data)).digest('hex');
  delete prefix.data;
  if (probe.sha256 !== expected) throw new Error('STARTUP_PROBE_PREFIX_MISMATCH');
  return { version, architecture: files.executable.architecture, wrapperArchitecture: process.arch, files, productionPreload: prefix, generatedProbe: probe };
}

export const STARTUP_CONTINUATION_MODE = 'held-native-runtime-continuation';
export const STARTUP_BARRIER_MODES = ['held-socket', 'held-remote-runtime', 'held-native-runtime', 'post-load-runtime', STARTUP_CONTINUATION_MODE];
const TARGET = 'app://app/renderer/index.html';

export function startupFrameIdentity(contents) {
  const read = fn => { try { return fn(); } catch { return null; } };
  const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const url = read(() => contents.mainFrame.url);
  return { rendererPid: id(read(() => contents.getOSProcessId())),
    frameProcessId: id(read(() => contents.mainFrame.processId)),
    frameRoutingId: id(read(() => contents.mainFrame.routingId)),
    frameUrl: url === '' ? '[empty]' : url === TARGET || url === 'about:blank' ? url : '[other]' };
}

export function normalizeStartupContext(method, params) {
  if (!['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'].includes(method)) return null;
  const context = params?.context;
  const id = method === 'Runtime.executionContextCreated' ? context?.id : params?.executionContextId;
  const boundedId = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : null;
  return {
    method,
    contextId: Number.isSafeInteger(id) && id > 0 ? id : null,
    frameId: boundedId(context?.auxData?.frameId),
    isDefault: typeof context?.auxData?.isDefault === 'boolean' ? context.auxData.isDefault : null,
    type: ['default', 'isolated'].includes(context?.auxData?.type) ? context.auxData.type : null,
    origin: ['', 'null', 'app://app', 'app://app/', 'about:blank'].includes(context?.origin) ? context.origin : '[other]',
    name: context?.name === 'Electron Isolated Context' ? context.name : '[omitted]'
  };
}

export function validateStartupBarrierEvents(events, mode) {
  if (!STARTUP_BARRIER_MODES.includes(mode) || !Array.isArray(events)) return false;
  const continuation = mode === STARTUP_CONTINUATION_MODE;
  if (continuation && (events.length > 499 || events.some(event => event.phase !== undefined && ![1, 2].includes(event.phase)))) return false;
  if (continuation) {
    const first = events.filter(event => event.phase === 1);
    const second = events.filter(event => event.phase === 2);
    if (!first.length || !second.length || events.indexOf(first.at(-1)) >= events.indexOf(second[0])
      || first[0].webContentsId === second[0].webContentsId) return false;
  }
  if (events.some(event => ['barrier-failure', 'barrier-limit', 'barrier-deadline', 'preload-marker-rejected'].includes(event?.event))) return false;
  for (const phase of [1, 2]) {
    const records = events.filter(event => event.phase === phase);
    const one = name => records.filter(event => event.event === name);
    const names = mode === 'post-load-runtime'
      ? ['response-released', 'preload-marker', 'did-finish-load', 'barrier-observer-start', 'barrier-observer-complete', 'barrier-window-closed']
      : ['response-held', 'barrier-observer-start', 'barrier-observer-complete', 'response-released', 'preload-marker', 'did-finish-load', 'barrier-window-closed'];
    if (names.some(name => one(name).length !== 1)) return false;
    const ids = new Set(names.map(name => one(name)[0].webContentsId));
    if (ids.size !== 1 || !Number.isSafeInteger([...ids][0]) || [...ids][0] <= 0) return false;
    // Marker/load IPC delivery can arrive in either order; both must follow release.
    const at = name => events.indexOf(one(name)[0]);
    if (!(at('response-released') < at('preload-marker') && at('response-released') < at('did-finish-load'))) return false;
    if (!(at('barrier-observer-start') < at('barrier-observer-complete') && at('barrier-observer-complete') < at('barrier-window-closed'))) return false;
    if (mode === 'post-load-runtime') {
      if (!(at('preload-marker') < at('barrier-observer-start') && at('did-finish-load') < at('barrier-observer-start'))) return false;
      if (one('response-held').length) return false;
    } else if (continuation) {
      if (!(at('response-held') < at('barrier-observer-start') && at('barrier-runtime-enabled') < at('response-released')
        && at('preload-marker') < at('barrier-native-detached') && at('did-finish-load') < at('barrier-native-detached'))) return false;
      for (const name of ['response-held', 'response-released', 'preload-marker', 'did-finish-load']) {
        const record = one(name)[0];
        if (!['[empty]', '[other]', 'about:blank', TARGET].includes(record.frameUrl)) return false;
        for (const key of ['rendererPid', 'frameProcessId', 'frameRoutingId']) {
          if (record[key] !== null && (!Number.isSafeInteger(record[key]) || record[key] <= 0)) return false;
          if (name === 'did-finish-load' && record[key] === null) return false;
        }
        if (name === 'did-finish-load' && record.frameUrl !== TARGET) return false;
      }
      const contexts = records.filter(event => event.event === 'barrier-context');
      if (!contexts.length || contexts.length > 80) return false;
      if (!contexts.some(event => event.responseState === 'held') || !contexts.some(event => event.responseState === 'released')) return false;
      for (const event of contexts) {
        const index = events.indexOf(event);
        if (event.webContentsId !== [...ids][0] || !(at('barrier-native-attached') < index && index < at('barrier-native-detached'))
          || event.responseState !== (index < at('response-released') ? 'held' : 'released')) return false;
        if (!['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared'].includes(event.method)) return false;
        if (event.method !== 'Runtime.executionContextsCleared' && (!Number.isSafeInteger(event.contextId) || event.contextId <= 0)) return false;
      }
    } else if (!(at('response-held') < at('barrier-observer-start') && at('barrier-observer-complete') < at('response-released'))) return false;
    if (one('barrier-observer-complete')[0].cleanClose !== true) return false;
    if (mode === 'held-socket' ? one('barrier-runtime-enabled').length !== 0 : one('barrier-runtime-enabled').length !== 1) return false;
    if (mode !== 'held-socket' && !(at('barrier-observer-start') < at('barrier-runtime-enabled') && at('barrier-runtime-enabled') < at('barrier-observer-complete'))) return false;
    const opened = mode === 'held-native-runtime' || continuation ? 'barrier-native-attached' : 'barrier-socket-open';
    const closed = mode === 'held-native-runtime' || continuation ? 'barrier-native-detached' : 'barrier-socket-closed';
    if (one(opened).length !== 1 || one(closed).length !== 1) return false;
    if (!(at('barrier-observer-start') < at(opened) && at(opened) < at(closed) && at(closed) < at('barrier-observer-complete'))) return false;
    if (mode !== 'held-socket' && !(at(opened) < at('barrier-runtime-enabled') && at('barrier-runtime-enabled') < at(closed))) return false;
    if (!Number.isSafeInteger(one(opened)[0].elapsedMs) || !Number.isSafeInteger(one(closed)[0].elapsedMs)
      || one(closed)[0].elapsedMs - one(opened)[0].elapsedMs < 250) return false;
  }
  return true;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}

// Only Runtime.enable is sent. The caller owns response release and awaits both
// document milestones before finish; errors still detach the exact observer.
export async function startNativeContinuation(debuggerApi, emit, observeContext, pause = delay) {
  let intentionalDetach = false;
  let earlyDetach = false;
  let finished = false;
  const listener = (_event, method, params) => observeContext(method, params);
  const detached = () => { if (!intentionalDetach) { earlyDetach = true; emit('barrier-failure', { code: 'BARRIER_NATIVE_EARLY_DETACH' }); } };
  const cleanup = () => {
    if (finished) return;
    finished = true;
    intentionalDetach = true;
    try {
      if (debuggerApi.isAttached()) debuggerApi.detach();
      if (debuggerApi.isAttached()) throw new Error('BARRIER_NATIVE_DETACH');
      emit('barrier-native-detached');
    } finally {
      debuggerApi.removeListener('message', listener);
      debuggerApi.removeListener('detach', detached);
    }
  };
  debuggerApi.on('message', listener);
  debuggerApi.on('detach', detached);
  try {
    emit('barrier-observer-start', { transport: 'native' });
    debuggerApi.attach('1.3');
    emit('barrier-native-attached');
    await deadline(debuggerApi.sendCommand('Runtime.enable'), 1000, 'BARRIER_RUNTIME_TIMEOUT');
    emit('barrier-runtime-enabled');
    await pause(250);
    if (earlyDetach || !debuggerApi.isAttached()) throw new Error('BARRIER_NATIVE_EARLY_DETACH');
  } catch (error) { cleanup(); throw error; }
  return {
    abort: cleanup,
    async finish() {
      try {
        await pause(250);
        if (earlyDetach || !debuggerApi.isAttached()) throw new Error('BARRIER_NATIVE_EARLY_DETACH');
      } finally { cleanup(); }
      emit('barrier-observer-complete', { cleanClose: true });
    }
  };
}

async function remoteObserver(port, mode, emit, observeContext) {
  let socket;
  let listener;
  const waiters = new Map();
  let nextId = 0;
  let outputFailure = null;
  let intentionalClose = false;
  const output = createBoundedOutput(128 * 1024);
  let messages = 0;
  try {
    let target;
    const until = Date.now() + 2000;
    while (!target && Date.now() < until) {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(250), redirect: 'error' });
      if (!response.ok) throw new Error('BARRIER_DISCOVERY_HTTP');
      const reader = response.body.getReader();
      const bytes = createBoundedOutput(64 * 1024);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes.append(value);
          if (bytes.truncated) throw new Error('BARRIER_DISCOVERY_LIMIT');
        }
      } finally { await reader.cancel(); }
      const list = JSON.parse(bytes.text);
      if (!Array.isArray(list) || list.length > 40) throw new Error('BARRIER_DISCOVERY_SHAPE');
      const pages = list.filter(item => item.type === 'page');
      // This opt-in fixture owns precisely one live window, no keeper/extensions.
      if (pages.length > 1) throw new Error('BARRIER_TARGET_AMBIGUOUS');
      if (pages.length === 1 && ['', 'about:blank', TARGET].includes(pages[0].url)) target = pages[0];
      if (!target) await delay(25);
    }
    if (!target || typeof target.webSocketDebuggerUrl !== 'string' || target.webSocketDebuggerUrl.length > 4096) throw new Error('BARRIER_TARGET_MISSING');
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || url.username || url.password || url.search || url.hash || !/^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error('BARRIER_TARGET_INVALID');
    socket = new WebSocket(url);
    socket.addEventListener('close', () => { if (!intentionalClose) outputFailure = 'BARRIER_SOCKET_EARLY_CLOSE'; });
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('BARRIER_SOCKET_ERROR')), { once: true });
    });
    listener = event => {
      messages += 1;
      if (typeof event.data !== 'string') outputFailure = 'BARRIER_OUTPUT_TYPE';
      else output.append(event.data);
      if (messages > 500 || output.truncated) outputFailure = 'BARRIER_OUTPUT_LIMIT';
      if (outputFailure) {
        for (const pending of waiters.values()) pending.reject(new Error(outputFailure));
        waiters.clear();
        socket.close();
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { outputFailure = 'BARRIER_OUTPUT_JSON'; return; }
      observeContext(message.method, message.params);
      const pending = waiters.get(message.id);
      if (pending) {
        waiters.delete(message.id);
        if (message.error) pending.reject(new Error('BARRIER_RUNTIME_COMMAND'));
        else pending.resolve();
      }
    };
    socket.addEventListener('message', listener);
    await deadline(opened, 1000, 'BARRIER_SOCKET_TIMEOUT');
    emit('barrier-socket-open');
    if (mode !== 'held-socket') {
      const id = ++nextId;
      const acknowledgement = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method: 'Runtime.enable' }));
      await deadline(acknowledgement, 1000, 'BARRIER_RUNTIME_TIMEOUT');
      emit('barrier-runtime-enabled');
    }
    await delay(250);
    if (outputFailure) throw new Error(outputFailure);
    if (socket.readyState !== WebSocket.OPEN) throw new Error('BARRIER_SOCKET_EARLY_CLOSE');
  } finally {
    for (const pending of waiters.values()) pending.reject(new Error('BARRIER_OBSERVER_CLEANUP'));
    waiters.clear();
    if (socket) {
      intentionalClose = true;
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
        socket.close();
        await deadline(closed, 1000, 'BARRIER_SOCKET_CLOSE_TIMEOUT');
      }
      if (listener) socket.removeEventListener('message', listener);
      emit('barrier-socket-closed');
    }
  }
}

export async function runStartupBarrierCase({ mode, port, preloadPath, htmlPath }) {
  if (!STARTUP_BARRIER_MODES.includes(mode)) throw new Error('Invalid startup barrier mode');
  const continuation = mode === STARTUP_CONTINUATION_MODE;
  if (mode !== 'held-native-runtime' && !continuation && (!Number.isSafeInteger(port) || port <= 0 || port > 65535)) throw new Error('Invalid startup barrier port');
  const { app, BrowserWindow, ipcMain, protocol, session } = await import('electron');
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } }]);
  let sequence = 0;
  const startedAt = Date.now();
  const log = (event, fields = {}) => {
    if (sequence >= (continuation ? 498 : 499)) {
      if (continuation) generationFailure = 'BARRIER_EVENT_LIMIT';
      if (sequence === 498 && continuation) console.log(JSON.stringify({ event: 'barrier-limit', pid: process.pid, sequence: ++sequence }));
      return;
    }
    console.log(JSON.stringify({ event, pid: process.pid, sequence: ++sequence, elapsedMs: Date.now() - startedAt, ...fields }));
  };
  const timer = setTimeout(() => { log('barrier-deadline'); app.exit(1); }, 12000);
  let current;
  let phase = 0;
  let responseState = 'not-requested';
  let contextCount = 0;
  let generationFailure = null;
  let markerResolve;
  let continuationObserver;
  const emit = (event, fields = {}) => log(event, { phase, webContentsId: current?.webContents.id ?? null, responseState,
    ...(continuation && ['response-held', 'response-released', 'preload-marker', 'did-finish-load'].includes(event) ? startupFrameIdentity(current?.webContents) : {}), ...fields });
  const observeContext = (method, params) => {
    const context = normalizeStartupContext(method, params);
    if (!context) return;
    if (++contextCount > 80) { generationFailure = 'BARRIER_CONTEXT_LIMIT'; if (contextCount === 81) emit('barrier-limit'); return; }
    emit('barrier-context', context);
  };
  app.on('window-all-closed', () => {});
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', details => {
      if (details.sourceId !== 'node:electron/js2c/sandbox_bundle') return;
      const text = typeof details.message === 'string' ? details.message.slice(0, 1024) : '';
      const code = /sandboxed_renderer\.bundle\.js script failed to run/.test(text) ? 'SANDBOX_BUNDLE_SCRIPT_FAILED'
        : /startupData[^\n]*null/.test(text) ? 'SANDBOX_STARTUP_DATA_NULL' : null;
      if (code) emit('console-message', { code, webContentsId: contents.id, observedBeforeResponseRelease: responseState === 'held' });
    });
    contents.on('preload-error', () => { generationFailure = 'BARRIER_PRELOAD_ERROR'; emit('preload-error'); });
    contents.on('render-process-gone', () => { generationFailure = 'BARRIER_RENDERER_GONE'; emit('barrier-failure', { code: generationFailure }); });
  });
  ipcMain.on('wallet-startup:preload', (event, marker) => {
    if (!current || event.sender !== current.webContents || event.senderFrame !== current.webContents.mainFrame || !markerResolve
      || marker?.href !== TARGET || marker.sandboxed !== true || marker.contextIsolated !== true) {
      generationFailure = 'BARRIER_MARKER_INVALID'; emit('preload-marker-rejected'); return;
    }
    emit('preload-marker', { marker: { href: TARGET, sandboxed: true, contextIsolated: true } });
    const done = markerResolve; markerResolve = null; done();
  });
  const observe = async () => {
    emit('barrier-observer-start', { transport: mode === 'held-native-runtime' ? 'native' : 'remote' });
    if (mode === 'held-native-runtime') {
      const debuggerApi = current.webContents.debugger;
      const listener = (_event, method, params) => observeContext(method, params);
      let intentionalDetach = false;
      let earlyDetach = false;
      const detached = () => { if (!intentionalDetach) earlyDetach = true; };
      debuggerApi.on('message', listener);
      debuggerApi.on('detach', detached);
      try {
        debuggerApi.attach('1.3');
        emit('barrier-native-attached');
        await deadline(debuggerApi.sendCommand('Runtime.enable'), 1000, 'BARRIER_RUNTIME_TIMEOUT');
        emit('barrier-runtime-enabled');
        await delay(250);
        if (earlyDetach || !debuggerApi.isAttached()) throw new Error('BARRIER_NATIVE_EARLY_DETACH');
      } finally {
        intentionalDetach = true;
        if (debuggerApi.isAttached()) debuggerApi.detach();
        debuggerApi.removeListener('message', listener);
        debuggerApi.removeListener('detach', detached);
        if (debuggerApi.isAttached()) throw new Error('BARRIER_NATIVE_DETACH');
        emit('barrier-native-detached');
      }
    } else await remoteObserver(port, mode, emit, observeContext);
    if (generationFailure) throw new Error(generationFailure);
    emit('barrier-observer-complete', { cleanClose: true });
  };
  try {
    await app.whenReady();
    const html = await fs.readFile(htmlPath, 'utf8');
    const targetSession = session.fromPartition('persist:startup-barrier', { cache: true });
    targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    targetSession.setPermissionCheckHandler(() => false);
    targetSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => callback({ cancel: details.url !== TARGET }));
    await targetSession.protocol.handle('app', async request => {
      if (request.url !== TARGET || responseState !== 'not-requested') return new Response('not found', { status: 404 });
      if (mode !== 'post-load-runtime') {
        responseState = 'held'; emit('response-held');
        try {
          if (continuation) {
            const owner = current;
            const ownerPhase = phase;
            const ownerId = owner.webContents.id;
            continuationObserver = await startNativeContinuation(owner.webContents.debugger, emit, (method, params) => {
              if (current !== owner || phase !== ownerPhase || current?.webContents.id !== ownerId) {
                generationFailure = 'BARRIER_CONTEXT_OWNER'; emit('barrier-failure', { code: generationFailure }); return;
              }
              observeContext(method, params);
            });
          } else await observe();
        }
        catch (error) { generationFailure = /^BARRIER_[A-Z_]+$/.test(error?.message) ? error.message : 'BARRIER_OBSERVER_FAILED'; emit('barrier-failure', { code: generationFailure }); }
      }
      responseState = 'released'; emit('response-released');
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
    });
    log('case-start', { electron: process.versions.electron, barrierMode: mode });
    for (phase = 1; phase <= 2; phase++) {
      responseState = 'not-requested'; contextCount = 0; generationFailure = null;
      const marker = new Promise(resolve => { markerResolve = resolve; });
      current = new BrowserWindow({ show: false, width: 480, height: 320, webPreferences: { preload: preloadPath, partition: 'persist:startup-barrier', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      current.webContents.on('will-navigate', (event, url) => { if (url !== TARGET) event.preventDefault(); });
      const loaded = new Promise(resolve => current.webContents.once('did-finish-load', () => { emit('did-finish-load'); resolve(); }));
      await deadline(Promise.all([marker, loaded, current.loadURL(TARGET)]), 5000, 'BARRIER_GENERATION_TIMEOUT');
      if (generationFailure) throw new Error(generationFailure);
      if (mode === 'post-load-runtime') await observe();
      if (continuation) {
        if (!continuationObserver) throw new Error('BARRIER_OBSERVER_MISSING');
        await continuationObserver.finish();
        continuationObserver = null;
        if (generationFailure) throw new Error(generationFailure);
      }
      const webContentsId = current.webContents.id;
      const closed = new Promise(resolve => current.once('closed', resolve));
      current.close();
      await deadline(closed, 1000, 'BARRIER_WINDOW_CLOSE_TIMEOUT');
      // Capture ID before destruction via the preceding events; do not inspect destroyed WebContents.
      log('barrier-window-closed', { phase, webContentsId, responseState });
      current = null;
    }
    log('finish', { reason: 'second-preload-marker' });
    app.quit();
  } catch (error) {
    log('barrier-failure', { phase, code: /^BARRIER_[A-Z_]+$/.test(error?.message) ? error.message : 'BARRIER_CASE_FAILED' });
    app.exit(1);
  } finally { try { continuationObserver?.abort(); } finally { clearTimeout(timer); } }
}
