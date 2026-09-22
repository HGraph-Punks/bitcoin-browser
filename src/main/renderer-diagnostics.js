import { WALLET_ORIGIN } from '../shared/constants.js';
import { AI_CONNECT_DIAGNOSTIC_CODES } from '../shared/local-ai.js';

const SANDBOX_SOURCE = 'node:electron/js2c/sandbox_bundle';
const MAX_REPORTS_PER_CONTENTS = 20;
const MAX_LIFECYCLE_RECORDS = 8;
const SHELL_DOCUMENT_URL = 'app://app/renderer/index.html';

function safeCall(callback, fallback = null) {
  try { return callback(); } catch { return fallback; }
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function classifyRendererLocation(value) {
  if (typeof value !== 'string' || !value) return 'unknown';
  if (value.length > 4_096) return '[redacted]';
  let url;
  try { url = new URL(value); } catch { return 'invalid'; }
  if (url.href === 'about:blank') return 'about:blank';
  if (url.protocol === 'app:' && url.hostname === 'app' && url.pathname === '/renderer/index.html') return 'app://app/renderer/index.html';
  if (url.origin === WALLET_ORIGIN && url.pathname === '/index.html') return `${WALLET_ORIGIN}/index.html`;
  if (url.protocol === 'ord:' && url.hostname === 'content') return 'ord://content/[redacted]';
  return `${url.protocol}//[redacted]`;
}

function sandboxDiagnosticCode(details) {
  if (!details || details.sourceId !== SANDBOX_SOURCE || typeof details.message !== 'string' || details.message.length > 4_096) return null;
  if (/sandboxed_renderer\.bundle\.js script failed to run/i.test(details.message)) return 'SANDBOX_BUNDLE_SCRIPT_FAILED';
  if (/startupData[^\n]{0,160}(?:is null|null)/i.test(details.message)) return 'SANDBOX_STARTUP_DATA_NULL';
  return null;
}

export function classifyModelDiagnostic(details) {
  if (details?.sourceId !== 'ord://model-viewer/assets/viewer.js' || typeof details.message !== 'string' || details.message.length > 100) return null;
  const location = safeCall(() => details.frame.url, '');
  if (!/^ord:\/\/model-viewer\/[0-9a-f]{64}i\d{1,10}$/i.test(location)) return null;
  if (details.message === 'SATOSHI_MODEL_VIEWER_READY') return { state: 'ready', code: null };
  const match = /^SATOSHI_MODEL_VIEWER_ERROR:(MODEL_TIMEOUT|MODEL_UNAVAILABLE|MODEL_LIMIT|MODEL_EXTENSION|MODEL_EXTERNAL_RESOURCE|MODEL_GRAPHICS|INVALID_MODEL)$/.exec(details.message ?? '');
  return match ? { state: 'error', code: match[1] } : null;
}

export function classifyDocumentDiagnostic(details) {
  if (details?.sourceId !== 'ord://document-viewer/assets/viewer.js' || typeof details.message !== 'string' || details.message.length > 120) return null;
  const match = /^ord:\/\/document-viewer\/(pdf|font|markdown|jxl|binary)\/[0-9a-f]{64}i\d{1,10}$/i.exec(safeCall(() => details.frame.url, ''));
  if (!match) return null;
  if (details.message === 'SATOSHI_DOCUMENT_VIEWER_READY') return { kind: match[1].toLowerCase(), state: 'ready' };
  const error = /^SATOSHI_DOCUMENT_VIEWER_ERROR:(PREVIEW_TIMEOUT|PREVIEW_WORKER|PREVIEW_PASSWORD|PREVIEW_SECURITY|PREVIEW_TYPE|PREVIEW_STATE|PREVIEW_CLONE|PREVIEW_PDF_INVALID|PREVIEW_INVALID):(fetch|prepare|render)$/.exec(details.message);
  return error ? { kind: match[1].toLowerCase(), state: 'error', code: error[1], phase: error[2] } : null;
}

export function recordShellDocumentLoaded(contents, logger) {
  if (!contents || safeCall(() => contents.isDestroyed?.() === true, true)) return false;
  if (safeCall(() => contents.getURL(), null) !== SHELL_DOCUMENT_URL) return false;
  const fields = {
    pid: process.pid,
    webContentsId: boundedInteger(safeCall(() => contents.id)),
    location: SHELL_DOCUMENT_URL
  };
  try {
    void Promise.resolve(logger?.info('app.shell_document_loaded', fields)).catch(() => {});
  } catch {}
  return true;
}

export function installRendererDiagnostics(app, options = {}) {
  const counts = new WeakMap();
  const modelCounts = new WeakMap();
  const documentCounts = new WeakMap();
  const aiCounts = new WeakMap();
  const aiConnectionCounts = new WeakMap();
  const lifecycles = new WeakMap();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const lifecycleState = (contents) => {
    let state = lifecycles.get(contents);
    if (!state) {
      state = { createdAt: now(), sequence: 0, records: [], dropped: 0 };
      lifecycles.set(contents, state);
    }
    return state;
  };
  const nextTiming = (contents) => {
    const state = lifecycleState(contents);
    state.sequence += 1;
    const elapsed = now() - state.createdAt;
    return { state, sequence: state.sequence, elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.trunc(elapsed)) : 0 };
  };
  const recordLifecycle = (contents, phase, location, frame = null, frameIds = {}) => {
    const { state, sequence, elapsedMs } = nextTiming(contents);
    const frameUrl = frame ? safeCall(() => frame.url) : null;
    const rawLocation = typeof location === 'string' ? location : frameUrl;
    const record = Object.freeze({
      phase,
      elapsedMs,
      sequence,
      location: classifyRendererLocation(typeof rawLocation === 'string' ? rawLocation : safeCall(() => contents.getURL(), '')),
      frameProcessId: boundedInteger(frameIds.processId ?? safeCall(() => frame?.processId)),
      frameRoutingId: boundedInteger(frameIds.routingId ?? safeCall(() => frame?.routingId)),
      mainFrame: typeof frameIds.mainFrame === 'boolean'
        ? frameIds.mainFrame
        : (frame ? safeCall(() => frame.top ? frame === frame.top : null, null) : null)
    });
    state.records.push(record);
    if (state.records.length > MAX_LIFECYCLE_RECORDS) {
      state.records.shift();
      state.dropped = Math.min(Number.MAX_SAFE_INTEGER, state.dropped + 1);
    }
  };
  const emit = (contents, code, frame = null) => {
    const count = counts.get(contents) ?? 0;
    if (count >= (options.maxReportsPerContents ?? MAX_REPORTS_PER_CONTENTS)) return false;
    counts.set(contents, count + 1);
    const frameUrl = frame ? safeCall(() => frame.url) : null;
    const frameLocation = typeof frameUrl === 'string' ? classifyRendererLocation(frameUrl) : null;
    const webContentsLocation = classifyRendererLocation(safeCall(() => contents.getURL(), ''));
    const { state, sequence: captureSequence, elapsedMs: captureElapsedMs } = nextTiming(contents);
    const lifecycle = Object.freeze(state.records.map((record) => Object.freeze({ ...record })));
    const fields = {
      code,
      pid: process.pid,
      webContentsId: boundedInteger(contents?.id),
      webContentsType: String(safeCall(() => contents.getType(), 'unknown')).slice(0, 40),
      rendererProcessId: boundedInteger(safeCall(() => contents.getProcessId())),
      rendererOsProcessId: boundedInteger(safeCall(() => contents.getOSProcessId())),
      session: String(safeCall(() => options.sessionLabel?.(contents.session), 'unknown') ?? 'unknown').slice(0, 40),
      location: frameLocation ?? webContentsLocation,
      frameLocation,
      webContentsLocation,
      frameProcessId: boundedInteger(safeCall(() => frame?.processId)),
      frameRoutingId: boundedInteger(safeCall(() => frame?.routingId)),
      mainFrame: frame ? safeCall(() => frame.top ? frame === frame.top : null, null) : null,
      captureElapsedMs,
      captureSequence,
      lifecycle,
      lifecycleDropped: state.dropped
    };
    try {
      void Promise.resolve(options.logger?.()?.warn('renderer.bootstrap', fields)).catch(() => {});
    } catch {}
    return true;
  };

  app.on('web-contents-created', (_event, contents) => {
    lifecycleState(contents);
    recordLifecycle(contents, 'created', safeCall(() => contents.getURL(), ''));
    contents.on('did-start-navigation', (details) => {
      recordLifecycle(contents, 'did-start-navigation', details?.url, safeCall(() => details?.frame), {
        mainFrame: typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : undefined
      });
    });
    contents.on('did-frame-navigate', (_event, url, _statusCode, _statusText, isMainFrame, frameProcessId, frameRoutingId) => {
      recordLifecycle(contents, 'did-frame-navigate', url, null, {
        processId: frameProcessId,
        routingId: frameRoutingId,
        mainFrame: typeof isMainFrame === 'boolean' ? isMainFrame : undefined
      });
    });
    contents.on('dom-ready', () => {
      recordLifecycle(contents, 'dom-ready', safeCall(() => contents.getURL(), ''), safeCall(() => contents.mainFrame), { mainFrame: true });
    });
    contents.on('did-finish-load', () => {
      recordLifecycle(contents, 'did-finish-load', safeCall(() => contents.getURL(), ''), safeCall(() => contents.mainFrame), { mainFrame: true });
    });
    contents.on('console-message', (details) => {
      // Fixed shell-view readiness/connection codes only: never capture AI
      // questions, answers, model IDs, endpoints, tokens, or result targets.
      if (details?.sourceId === 'app://app/renderer/ai.js' && details.message === 'SATOSHI_AI_WORKSPACE_READY'
          && details.frame && safeCall(() => details.frame === contents.mainFrame && details.frame.url === SHELL_DOCUMENT_URL, false)
          && (aiCounts.get(contents) ?? 0) < 4) {
        aiCounts.set(contents, (aiCounts.get(contents) ?? 0) + 1);
        try { void Promise.resolve(options.logger?.()?.info('renderer.ai', { state: 'ready', pid: process.pid })).catch(() => {}); } catch {}
      }
      if (details?.sourceId === 'app://app/renderer/ai.js' && typeof details.message === 'string' && details.message.length <= 100
          && details.message.startsWith('SATOSHI_AI_CONNECT:') && AI_CONNECT_DIAGNOSTIC_CODES.includes(details.message.slice(19))
          && details.frame && safeCall(() => details.frame === contents.mainFrame && details.frame.url === SHELL_DOCUMENT_URL, false)
          && (aiConnectionCounts.get(contents) ?? 0) < MAX_REPORTS_PER_CONTENTS) {
        aiConnectionCounts.set(contents, (aiConnectionCounts.get(contents) ?? 0) + 1);
        try { void Promise.resolve(options.logger?.()?.info('renderer.ai', { state: 'connection', code: details.message.slice(19), pid: process.pid })).catch(() => {}); } catch {}
      }
      const document = classifyDocumentDiagnostic(details), documents = documentCounts.get(contents) ?? 0;
      if (document && documents < MAX_REPORTS_PER_CONTENTS) {
        documentCounts.set(contents, documents + 1);
        try { void Promise.resolve(options.logger?.()?.info('renderer.document', { ...document, pid: process.pid, location: 'ord://document-viewer/[redacted]' })).catch(() => {}); } catch {}
      }
      const model = classifyModelDiagnostic(details);
      const count = modelCounts.get(contents) ?? 0;
      if (model && count < MAX_REPORTS_PER_CONTENTS) {
        modelCounts.set(contents, count + 1);
        try { void Promise.resolve(options.logger?.()?.info('renderer.model', { ...model, pid: process.pid, location: 'ord://model-viewer/[redacted]' })).catch(() => {}); } catch {}
      }
      const code = sandboxDiagnosticCode(details);
      if (code) emit(contents, code, safeCall(() => details.frame));
    });
    contents.on('preload-error', () => emit(contents, 'APPLICATION_PRELOAD_ERROR'));
  });
}
