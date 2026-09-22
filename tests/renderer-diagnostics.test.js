import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { classifyRendererLocation, classifyModelDiagnostic, classifyDocumentDiagnostic, installRendererDiagnostics, recordShellDocumentLoaded } from '../src/main/renderer-diagnostics.js';

function fixture(options = {}) {
  const app = new EventEmitter();
  const contents = new EventEmitter();
  contents.id = 7;
  contents.session = {};
  contents.getType = () => 'window';
  contents.getProcessId = () => 19;
  contents.getOSProcessId = () => 23;
  contents.getURL = () => 'app://app/renderer/index.html?secret=hidden';
  const reports = [];
  installRendererDiagnostics(app, {
    logger: () => ({ warn: async (event, fields) => reports.push({ event, fields }) }),
    sessionLabel: () => 'app',
    ...options
  });
  app.emit('web-contents-created', {}, contents);
  return { contents, reports };
}

test('AI view readiness accepts only the exact main-frame marker, is capped, and captures no chat metadata', () => {
  const reports = [];
  const { contents } = fixture({ logger: () => ({ info: (event, fields) => reports.push({ event, fields }) }) });
  const frame = { url: 'app://app/renderer/index.html' }; contents.mainFrame = frame;
  const details = { frame, sourceId: 'app://app/renderer/ai.js', message: 'SATOSHI_AI_WORKSPACE_READY' };
  for (const change of [{ message: 'PRIVATE_PROMPT' }, { message: 'SATOSHI_AI_WORKSPACE_READY token=private' }, { sourceId: 'ord://content/script.js' }, { frame: { ...frame } }, { frame: null }]) contents.emit('console-message', { ...details, ...change });
  assert.equal(reports.length, 0);
  for (let i = 0; i < 8; i++) contents.emit('console-message', { ...details, private: 'DO_NOT_LOG' });
  assert.equal(reports.length, 4); assert.equal(reports[0].event, 'renderer.ai');
  assert.deepEqual(Object.keys(reports[0].fields).sort(), ['pid', 'state']); assert.doesNotMatch(JSON.stringify(reports), /PRIVATE|DO_NOT_LOG/);
});

test('AI connection diagnostics accept only fixed codes from the shell and never log payloads or exception text', () => {
  const reports = [];
  const { contents } = fixture({ logger: () => ({ info: (event, fields) => reports.push({ event, fields }) }) });
  const frame = { url: 'app://app/renderer/index.html' }; contents.mainFrame = frame;
  const details = { frame, sourceId: 'app://app/renderer/ai.js', message: 'SATOSHI_AI_CONNECT:STARTED' };
  for (const change of [{ message: 'SATOSHI_AI_CONNECT:PRIVATE' }, { message: 'SATOSHI_AI_CONNECT:AI_AUTH token=PRIVATE' },
    { message: 'SATOSHI_AI_CONNECT:CONNECTED\n' }, { message: null }, { sourceId: 'ord://content/script.js' },
    { sourceId: 'app://app/renderer/ai-request.js' }, { frame: { ...frame } }, { frame: null }]) contents.emit('console-message', { ...details, ...change });
  assert.equal(reports.length, 0);
  for (const code of ['STARTED', 'CONNECTED', 'AI_AUTH', 'AI_CATALOG', 'AI_BRIDGE_UNAVAILABLE', 'NAVIGATION_OWNER_INVALID', 'FAILED']) {
    contents.emit('console-message', { ...details, message: `SATOSHI_AI_CONNECT:${code}`, private: 'PRIVATE' });
    assert.equal(reports.at(-1).fields.code, code);
  }
  for (let n = 0; n < 30; n++) contents.emit('console-message', details);
  assert.equal(reports.length, 20); assert.equal(reports[0].event, 'renderer.ai'); assert.equal(reports[0].fields.state, 'connection');
  assert.deepEqual(Object.keys(reports[0].fields).sort(), ['code', 'pid', 'state']); assert.doesNotMatch(JSON.stringify(reports), /PRIVATE|baseUrl|token/);
});

test('model diagnostics accept only fixed markers from the bundled viewer and redact the inscription', async () => {
  const id = `${'a'.repeat(64)}i0`, reports = [];
  const source = { sourceId: 'ord://model-viewer/assets/viewer.js', frame: { url: `ord://model-viewer/${id}` }, message: 'SATOSHI_MODEL_VIEWER_READY' };
  assert.deepEqual(classifyModelDiagnostic(source), { state: 'ready', code: null });
  for (const change of [{ sourceId: 'ord://content/script' }, { frame: { url: `ord://content/${id}` } }, { message: 'SATOSHI_MODEL_VIEWER_ERROR:secret' }, { message: 'x'.repeat(200) }, { message: null }]) assert.equal(classifyModelDiagnostic({ ...source, ...change }), null);
  const { contents } = fixture({ logger: () => ({ info: (event, fields) => reports.push({ event, fields }) }) });
  for (let i = 0; i < 30; i++) contents.emit('console-message', source);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.length, 20); assert.equal(reports[0].event, 'renderer.model'); assert.equal(reports[0].fields.state, 'ready');
  assert.equal(JSON.stringify(reports).includes(id), false); assert.equal(reports[0].fields.location, 'ord://model-viewer/[redacted]');
});

test('document diagnostics expose only a bounded kind/state marker, never document contents or inscription IDs', () => {
  const id = `${'b'.repeat(64)}i1`, reports = [], source = { sourceId: 'ord://document-viewer/assets/viewer.js', frame: { url: `ord://document-viewer/pdf/${id}` }, message: 'SATOSHI_DOCUMENT_VIEWER_READY' };
  assert.deepEqual(classifyDocumentDiagnostic(source), { kind: 'pdf', state: 'ready' });
  for (const change of [{ sourceId: 'ord://content/script' }, { frame: { url: `ord://document-viewer/private/${id}` } }, { message: 'SATOSHI_DOCUMENT_VIEWER_ERROR:private' }, { message: null }]) assert.equal(classifyDocumentDiagnostic({ ...source, ...change }), null);
  const { contents } = fixture({ logger: () => ({ info: (event, fields) => reports.push({ event, fields }) }) });
  for (let i = 0; i < 30; i++) contents.emit('console-message', source);
  assert.equal(reports.length, 20); assert.equal(reports[0].event, 'renderer.document'); assert.equal(JSON.stringify(reports).includes(id), false);
  assert.deepEqual(Object.keys(reports[0].fields).sort(), ['kind', 'location', 'pid', 'state']);
});

test('records only the known sandbox source and normalized signatures', async () => {
  const { contents, reports } = fixture();
  const frame = { url: 'ord://content/private-inscription?token=secret', processId: 31, routingId: 37 };
  frame.top = frame;
  contents.emit('console-message', { sourceId: 'https://host/app.js', message: 'sandboxed_renderer.bundle.js script failed to run', frame }, 3, 'deprecated', 1, 'deprecated');
  contents.emit('console-message', { sourceId: 'node:electron/js2c/sandbox_bundle', message: 'unrelated secret console payload', frame }, 3, 'deprecated', 1, 'deprecated');
  contents.emit('console-message', { sourceId: 'node:electron/js2c/sandbox_bundle', message: 'Electron sandboxed_renderer.bundle.js script failed to run', frame }, 3, 'deprecated', 1, 'deprecated');
  contents.emit('console-message', { sourceId: 'node:electron/js2c/sandbox_bundle', message: "TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null", frame }, 3, 'deprecated', 1, 'deprecated');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reports.map((report) => report.fields.code), ['SANDBOX_BUNDLE_SCRIPT_FAILED', 'SANDBOX_STARTUP_DATA_NULL']);
  assert.equal(reports[0].fields.location, 'ord://content/[redacted]');
  assert.equal(reports[0].fields.frameLocation, 'ord://content/[redacted]');
  assert.equal(reports[0].fields.webContentsLocation, 'app://app/renderer/index.html');
  assert.equal(reports[0].fields.frameProcessId, 31);
  assert.equal(reports[0].fields.frameRoutingId, 37);
  assert.equal(reports[0].fields.mainFrame, true);
  assert.equal(reports[0].event, 'renderer.bootstrap');
  assert.equal(reports[0].fields.pid, process.pid);
  assert.equal(JSON.stringify(reports).includes('secret'), false);
});

test('defensively handles destroyed frames and bounds reports per contents', async () => {
  const { contents, reports } = fixture({ maxReportsPerContents: 2 });
  const frame = {};
  Object.defineProperty(frame, 'url', { get() { throw new Error('destroyed'); } });
  for (let index = 0; index < 5; index += 1) {
    contents.emit('console-message', {
      sourceId: 'node:electron/js2c/sandbox_bundle',
      message: 'Electron sandboxed_renderer.bundle.js script failed to run',
      frame
    }, 3, 'deprecated', 1, 'deprecated');
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 2);
  assert.equal(reports[0].fields.location, 'app://app/renderer/index.html');
  assert.equal(reports[0].fields.frameLocation, null);
  assert.equal(reports[0].fields.frameProcessId, null);
  assert.equal(reports[0].fields.mainFrame, null);
});

test('preload errors omit path and raw error payload', async () => {
  const { contents, reports } = fixture();
  contents.emit('preload-error', {}, '/Users/person/private/preload.cjs', new Error('token=secret'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports[0].fields.code, 'APPLICATION_PRELOAD_ERROR');
  assert.equal(JSON.stringify(reports).includes('/Users/person'), false);
  assert.equal(JSON.stringify(reports).includes('token=secret'), false);
});

test('location classification preserves only trusted routes and redacts all unknown origins', () => {
  assert.equal(classifyRendererLocation('app://app/renderer/index.html?secret=hidden'), 'app://app/renderer/index.html');
  assert.equal(classifyRendererLocation('https://wallet.satoshi.invalid/index.html?secret=hidden'), 'https://wallet.satoshi.invalid/index.html');
  assert.equal(classifyRendererLocation('app://app/private/secret'), 'app://[redacted]');
  assert.equal(classifyRendererLocation('https://wallet.satoshi.invalid/private/secret'), 'https://[redacted]');
  assert.equal(classifyRendererLocation('about:blank'), 'about:blank');
  assert.equal(classifyRendererLocation('https://user:pass@example.com:8443/private?q=secret'), 'https://[redacted]');
  assert.equal(classifyRendererLocation('http://[::1]:9000/private'), 'http://[redacted]');
  assert.equal(classifyRendererLocation('data:text/html,secret'), 'data://[redacted]');
  assert.equal(classifyRendererLocation('not a url with secret'), 'invalid');
  assert.equal(classifyRendererLocation(`https://example.com/${'x'.repeat(4_096)}`), '[redacted]');
});

test('oversized sandbox console payloads are ignored', async () => {
  const { contents, reports } = fixture();
  contents.emit('console-message', {
    sourceId: 'node:electron/js2c/sandbox_bundle',
    message: `Electron sandboxed_renderer.bundle.js script failed to run${'x'.repeat(4_096)}`
  }, 3, 'deprecated', 1, 'deprecated');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 0);
});

test('captures modern navigation lifecycle shapes before a diagnostic', async () => {
  let clock = 100;
  const { contents, reports } = fixture({ now: () => clock });
  const frame = { url: 'https://user:secret@example.test/private?q=token', processId: 41, routingId: 43 };
  frame.top = frame;
  clock = 104;
  contents.emit('did-start-navigation', { url: frame.url, isMainFrame: true, frame }, 'deprecated', false, true, 41, 43);
  clock = 106;
  contents.emit('did-frame-navigate', {}, 'ord://content/private?token=secret', 200, 'OK', false, 47, 53);
  clock = 108;
  contents.emit('dom-ready');
  clock = 109;
  contents.emit('did-finish-load');
  clock = 111;
  contents.emit('console-message', {
    sourceId: 'node:electron/js2c/sandbox_bundle',
    message: 'Electron sandboxed_renderer.bundle.js script failed to run',
    frame
  }, 3, 'deprecated', 1, 'deprecated');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reports[0].fields.lifecycle.map(({ phase, elapsedMs, sequence }) => ({ phase, elapsedMs, sequence })), [
    { phase: 'created', elapsedMs: 0, sequence: 1 },
    { phase: 'did-start-navigation', elapsedMs: 4, sequence: 2 },
    { phase: 'did-frame-navigate', elapsedMs: 6, sequence: 3 },
    { phase: 'dom-ready', elapsedMs: 8, sequence: 4 },
    { phase: 'did-finish-load', elapsedMs: 9, sequence: 5 }
  ]);
  assert.equal(reports[0].fields.lifecycle[1].location, 'https://[redacted]');
  assert.equal(reports[0].fields.lifecycle[1].frameProcessId, 41);
  assert.equal(reports[0].fields.lifecycle[1].frameRoutingId, 43);
  assert.equal(reports[0].fields.lifecycle[2].location, 'ord://content/[redacted]');
  assert.equal(reports[0].fields.lifecycle[2].frameProcessId, 47);
  assert.equal(reports[0].fields.lifecycle[2].frameRoutingId, 53);
  assert.equal(reports[0].fields.captureElapsedMs, 11);
  assert.equal(reports[0].fields.captureSequence, 6);
  assert.equal(JSON.stringify(reports).includes('secret'), false);
  assert.equal(JSON.stringify(reports).includes('private'), false);
});

test('bounds lifecycle history and snapshots it immutably per report', async () => {
  let clock = 0;
  const { contents, reports } = fixture({ now: () => clock });
  for (let index = 0; index < 10; index += 1) {
    clock += 1;
    contents.emit('did-start-navigation', { url: `app://app/private/${index}?secret=value`, isMainFrame: true });
  }
  contents.emit('console-message', {
    sourceId: 'node:electron/js2c/sandbox_bundle',
    message: 'Electron sandboxed_renderer.bundle.js script failed to run'
  }, 3, 'deprecated', 1, 'deprecated');
  await new Promise((resolve) => setImmediate(resolve));
  const firstLifecycle = reports[0].fields.lifecycle;
  assert.equal(firstLifecycle.length, 8);
  assert.equal(reports[0].fields.lifecycleDropped, 3);
  assert.equal(firstLifecycle[0].sequence, 4);
  assert.equal(Object.isFrozen(firstLifecycle), true);
  assert.equal(Object.isFrozen(firstLifecycle[0]), true);

  clock += 1;
  contents.emit('did-finish-load');
  contents.emit('console-message', {
    sourceId: 'node:electron/js2c/sandbox_bundle',
    message: "binding.startupData is null"
  }, 3, 'deprecated', 1, 'deprecated');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports[0].fields.lifecycle, firstLifecycle);
  assert.equal(firstLifecycle[7].sequence, 11);
  assert.equal(reports[1].fields.lifecycle[7].phase, 'did-finish-load');
  assert.equal(JSON.stringify(reports).includes('/private/'), false);
  assert.throws(() => firstLifecycle.push({}), TypeError);
});

test('lifecycle capture tolerates destroyed frames without leaking their URLs', async () => {
  const { contents, reports } = fixture();
  const frame = {};
  for (const key of ['url', 'processId', 'routingId', 'top']) {
    Object.defineProperty(frame, key, { get() { throw new Error(`destroyed ${key}`); } });
  }
  contents.emit('did-start-navigation', { url: 'https://example.test/private?token=secret', isMainFrame: false, frame });
  contents.emit('console-message', {
    sourceId: 'node:electron/js2c/sandbox_bundle',
    message: 'Electron sandboxed_renderer.bundle.js script failed to run',
    frame
  }, 3, 'deprecated', 1, 'deprecated');
  await new Promise((resolve) => setImmediate(resolve));
  const lifecycle = reports[0].fields.lifecycle.at(-1);
  assert.equal(lifecycle.location, 'https://[redacted]');
  assert.equal(lifecycle.frameProcessId, null);
  assert.equal(lifecycle.frameRoutingId, null);
  assert.equal(lifecycle.mainFrame, false);
  assert.equal(JSON.stringify(reports).includes('token'), false);
});

test('records shell document load only for the exact trusted route', async () => {
  const records = [];
  const logger = { info: async (event, fields) => records.push({ event, fields }) };
  const matching = { id: 17, isDestroyed: () => false, getURL: () => 'app://app/renderer/index.html' };
  assert.equal(recordShellDocumentLoaded(matching, logger), true);
  assert.equal(recordShellDocumentLoaded({ ...matching, getURL: () => 'app://app/renderer/index.html?secret=value' }, logger), false);
  assert.equal(recordShellDocumentLoaded({ ...matching, getURL: () => 'app://app/private/secret' }, logger), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(records, [{
    event: 'app.shell_document_loaded',
    fields: { pid: process.pid, webContentsId: 17, location: 'app://app/renderer/index.html' }
  }]);
  assert.equal(JSON.stringify(records).includes('secret'), false);
});

test('shell document marker safely rejects destroyed and throwing WebContents', () => {
  const records = [];
  const logger = { info: (event, fields) => records.push({ event, fields }) };
  assert.equal(recordShellDocumentLoaded({ id: 18, isDestroyed: () => true, getURL: () => 'app://app/renderer/index.html' }, logger), false);
  assert.equal(recordShellDocumentLoaded({ id: 19, isDestroyed() { throw new Error('destroyed'); }, getURL: () => 'app://app/renderer/index.html' }, logger), false);
  assert.equal(recordShellDocumentLoaded({ id: 20, isDestroyed: () => false, getURL() { throw new Error('gone'); } }, logger), false);
  assert.equal(records.length, 0);
});
