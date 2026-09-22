const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const APP_PRELOAD_PROBE_SUFFIX = Buffer.from("\nipcRenderer.send('wallet-startup:preload', { href: location.href, sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true });\n");

// An error event does not prove that the owned process and its stdio closed.
export function waitForStartupChildClose(child, timeoutMs = 10000, postKillMs = 3000) {
  return new Promise(resolve => {
    let spawnError = null;
    let killError = null;
    let forced = false;
    let timedOut = false;
    let settled = false;
    let afterKill;
    const finish = (closeConfirmed, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(afterKill);
      child.removeListener('close', closed);
      // Keep the error handler after an unconfirmed close; a late error must
      // not become an unhandled exception while the retained report is written.
      if (closeConfirmed) child.removeListener('error', errored);
      resolve({ closeConfirmed, code, signal, forced, timedOut, spawnError, killError });
    };
    const errored = error => { spawnError = error?.code ?? 'SPAWN_FAILED'; };
    const closed = (code, signal) => finish(true, code, signal);
    child.on('error', errored);
    child.once('close', closed);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) {
        forced = true;
        try { if (!child.kill('SIGKILL')) killError = 'KILL_NOT_SENT'; }
        catch (error) { killError = error?.code ?? 'KILL_FAILED'; }
      }
      if (!settled) afterKill = setTimeout(() => finish(false, child.exitCode, child.signalCode), postKillMs);
    }, timeoutMs);
  });
}

export function buildAppPreloadProbe(productionBytes) {
  const prefix = Buffer.isBuffer(productionBytes) ? productionBytes : Buffer.from(productionBytes);
  return Buffer.concat([prefix, APP_PRELOAD_PROBE_SUFFIX]);
}

export function validateCdpObserver(value, mode = 'full') {
  const expected = ({
    discovery: ['target-discovered'],
    socket: ['target-discovered', 'socket-open', 'socket-closed'],
    runtime: ['target-discovered', 'socket-open', 'runtime-enabled', 'socket-closed'],
    full: ['target-discovered', 'socket-open', 'runtime-enabled', 'page-enabled', 'log-enabled', 'facade-true', 'socket-closed']
  })[mode];
  if (!expected) return false;
  const expectedFacade = mode === 'full' ? true : null;
  const validSequence = value?.mode === mode && value?.exercised === true && value?.facade === expectedFacade && Array.isArray(value?.milestones)
    && value.milestones.length === expected.length
    && expected.every((name, index) => value.milestones[index]?.name === name
      && Number.isSafeInteger(value.milestones[index]?.elapsedMs) && value.milestones[index].elapsedMs >= 0
      && (index === 0 || value.milestones[index].elapsedMs >= value.milestones[index - 1].elapsedMs));
  if (!validSequence || mode === 'discovery') return validSequence;
  const opened = value.milestones.find((item) => item.name === 'socket-open');
  const closed = value.milestones.find((item) => item.name === 'socket-closed');
  return closed.elapsedMs - opened.elapsedMs >= 250;
}

export function createBoundedOutput(maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer');
  const chunks = [];
  let retainedBytes = 0;
  let totalBytesSeen = 0;
  let truncated = false;
  return {
    append(chunk) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytesSeen = Math.min(Number.MAX_SAFE_INTEGER, totalBytesSeen + input.byteLength);
      const remaining = maxBytes - retainedBytes;
      if (remaining > 0) {
        const retained = input.subarray(0, remaining);
        if (retained.byteLength) {
          chunks.push(Buffer.from(retained));
          retainedBytes += retained.byteLength;
        }
      }
      if (input.byteLength > remaining) truncated = true;
    },
    get text() { return Buffer.concat(chunks, retainedBytes).toString('utf8'); },
    get truncated() { return truncated; },
    get totalBytesSeen() { return totalBytesSeen; }
  };
}

export function validateStartupMarkers(events) {
  if (!Array.isArray(events)) return false;
  if (events.some((event) => ['load-error', 'preload-error', 'preload-marker-rejected'].includes(event?.event))) return false;
  const markers = events.filter((event) => event?.event === 'preload-marker');
  if (markers.length !== 2) return false;
  const phases = new Set();
  const webContentsIds = new Set();
  for (const event of markers) {
    if (event.phase !== 1 && event.phase !== 2) return false;
    phases.add(event.phase);
    if (!Number.isSafeInteger(event.webContentsId) || event.webContentsId <= 0) return false;
    webContentsIds.add(event.webContentsId);
    const marker = event.marker;
    if (!marker || typeof marker !== 'object' || marker.sandboxed !== true || marker.contextIsolated !== true) return false;
    if (typeof marker.href !== 'string' || marker.href.length > 4_096) return false;
  }
  if (phases.size !== 2 || webContentsIds.size !== 2) return false;
  const loads = events.filter((event) => event?.event === 'did-finish-load');
  if (loads.length !== 2 || loads.some((event) => !webContentsIds.has(event.webContentsId))) return false;
  if (new Set(loads.map((event) => event.webContentsId)).size !== 2) return false;
  const finishes = events.filter((event) => event?.event === 'finish');
  return finishes.length === 1 && finishes[0].reason === 'second-preload-marker';
}

export function boundedDiagnosticValue(value) {
  const ancestors = new WeakSet();
  let nodes = 0;
  const visit = (input, depth) => {
    nodes += 1;
    if (nodes > 500) return '[Node limit]';
    if (typeof input === 'string') return input.slice(0, 1_024);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'bigint') return String(input).slice(0, 1_024);
    if (typeof input === 'undefined' || typeof input === 'function' || typeof input === 'symbol') return null;
    if (typeof input !== 'object') return String(input).slice(0, 1_024);
    if (ancestors.has(input)) return '[Circular]';
    if (depth >= 5) return '[Depth limit]';
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const output = [];
        const length = Math.min(input.length, 40);
        for (let index = 0; index < length; index += 1) {
          try { output.push(visit(input[index], depth + 1)); }
          catch { output.push('[Thrown]'); }
        }
        return output;
      }
      const output = Object.create(null);
      let count = 0;
      try {
        for (const key in input) {
          if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
          if (count >= 40) break;
          count += 1;
          try { output[key.slice(0, 1_024)] = visit(input[key], depth + 1); }
          catch { output[key.slice(0, 1_024)] = '[Thrown]'; }
        }
      } catch { return '[Thrown]'; }
      return output;
    } finally {
      ancestors.delete(input);
    }
  };
  return visit(value, 0);
}
