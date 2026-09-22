import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SHUTDOWN_CASES, shutdownProbeHtml, classifyShutdown, shutdownCaseProbe, shutdownFrameExpression } from '../scripts/packaged-shutdown-support.mjs';

function runProbe(probe, credentialless) {
  const operations = [];
  const callbacks = [];
  const context = { window: { credentialless }, clearTimeout() {}, setTimeout(callback) { callbacks.push(callback); return callbacks.length; },
    AbortController,
    fetch(url, options) { operations.push({ protocol: 'https', url, credentials: options.credentials }); return Promise.reject(new Error('fixture')); },
    WebSocket: class { constructor(url) { operations.push({ protocol: 'wss', url }); } close() {} }
  };
  const html = shutdownProbeHtml(probe, 'https://127.0.0.1:44321');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(script, context, { timeout: 1000 });
  return { context, operations, callbacks };
}

test('shutdown fixture controls execute zero or exactly one bounded network operation', async () => {
  const none = runProbe('none');
  assert.equal(none.operations.length, 0);
  assert.equal(none.context.window.shutdownProbe.done, true);
  assert.equal(none.context.window.shutdownProbe.attempted, false);
  const https = runProbe('https');
  await Promise.resolve();
  assert.deepEqual(https.operations, [{ protocol: 'https', url: 'https://127.0.0.1:44321/probe', credentials: 'same-origin' }]);
  assert.equal(https.context.window.shutdownProbe.outcome, 'rejected');
  const include = runProbe('https-include');
  await Promise.resolve();
  assert.equal(include.operations.length, 1);
  assert.equal(include.operations[0].credentials, 'include');
  const wss = runProbe('wss');
  assert.deepEqual(wss.operations, [{ protocol: 'wss', url: 'wss://127.0.0.1:44321/probe' }]);
  wss.callbacks[0]();
  assert.equal(wss.context.window.shutdownProbe.outcome, 'bounded-timeout');
  assert.equal(wss.context.window.shutdownProbe.done, true);
});

test('diagnostic frame controls preserve sandbox and set credentialless before any navigation', () => {
  const id = `${'d'.repeat(64)}i1`;
  for (const credentialless of [false, true]) {
    const operations = [];
    const values = {};
    const frame = {
      setAttribute(name, value) { values[name] = value; operations.push(name); },
      getAttribute(name) { return values[name]; },
      get credentialless() { return values.credentialless; },
      set credentialless(value) { values.credentialless = value; operations.push('credentialless'); },
      get src() { return values.src; },
      set src(value) { values.src = value; operations.push('src'); }
    };
    const context = { document: {
      querySelector(selector) { return selector === '#page' ? { append(item) { assert.equal(item, frame); operations.push('append'); } } : null; },
      createElement(tag) { assert.equal(tag, 'iframe'); return frame; }
    } };
    const result = vm.runInNewContext(shutdownFrameExpression(id, credentialless), context, { timeout: 1000 });
    assert.deepEqual(operations, ['sandbox', 'credentialless', 'src', 'append']);
    assert.equal(result.sandbox, 'allow-scripts allow-forms allow-modals allow-pointer-lock');
    assert.equal(result.credentialless, credentialless);
    assert.equal(result.referrerPolicy, 'no-referrer');
    assert.equal(result.src, `ord://content/${id}`);
    assert.equal(runProbe('none', credentialless).context.window.shutdownProbe.credentialless, credentialless);
  }
  assert.equal(runProbe('none').context.window.shutdownProbe.credentialless, null);
});

test('diagnostic frame composition fails closed on unsupported, existing, or invalid frames', () => {
  const id = `${'d'.repeat(64)}i1`;
  for (const invalid of [null, '', `${'d'.repeat(64)}i4`, `${id}\";evil()`]) assert.throws(() => shutdownFrameExpression(invalid, true));
  assert.throws(() => shutdownFrameExpression(id, 'true'));
  assert.throws(() => vm.runInNewContext(shutdownFrameExpression(id, true), { document: {
    querySelector() { return null; }, createElement() { return {}; }
  } }), /unsupported/);
  assert.throws(() => vm.runInNewContext(shutdownFrameExpression(id, true), { document: {
    querySelector() { return {}; }, createElement() { throw new Error('must not create'); }
  } }), /Unexpected existing/);
  for (const name of SHUTDOWN_CASES) assert.ok(['none', 'https', 'https-include', 'wss'].includes(shutdownCaseProbe(name)));
  for (const suffix of ['', '-credentialless']) {
    assert.equal(shutdownCaseProbe(`frame-https-include${suffix}`), 'https-include');
    assert.equal(shutdownCaseProbe(`frame-wss${suffix}`), 'wss');
  }
  assert.throws(() => shutdownCaseProbe('unreviewed-probe'));
});

test('shutdown fixture refuses non-loopback destinations and unknown probes', () => {
  for (const endpoint of ['https://example.com:44321', 'http://127.0.0.1:44321', 'https://user@127.0.0.1:44321', 'https://127.0.0.1']) {
    assert.throws(() => shutdownProbeHtml('https', endpoint));
  }
  assert.throws(() => shutdownProbeHtml('unknown', 'https://127.0.0.1:44321'));
  assert.equal(new Set(SHUTDOWN_CASES).size, SHUTDOWN_CASES.length);
});

test('shutdown classification rejects forced, incomplete, diagnostic, and nonzero outcomes', () => {
  const clean = { operationCompleted: true, code: 0, signal: null, forced: false, closed: true,
    spawnError: null, diagnostics: 0, exceptionCount: 0, truncated: false };
  assert.equal(classifyShutdown(clean), true);
  for (const changes of [{ operationCompleted: false }, { code: null }, { code: 1 }, { signal: 'SIGTERM' },
    { forced: true }, { closed: false }, { spawnError: 'EACCES' }, { diagnostics: 1 }, { exceptionCount: 1 }, { truncated: true }]) {
    assert.equal(classifyShutdown({ ...clean, ...changes }), false, JSON.stringify(changes));
  }
  assert.equal(classifyShutdown({}), false);
});
