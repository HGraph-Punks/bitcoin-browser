import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createModelFrame } from '../src/renderer/model-frame.js';

class Element {
  constructor(tag) { this.tagName = tag; this.attributes = {}; this.listeners = {}; this.contentWindow = { postMessage: (...args) => this.messages.push(args) }; this.messages = []; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  append() {}
}
globalThis.document = { createElement: tag => new Element(tag) };
globalThis.Node = Element;
const id = `${'a'.repeat(64)}i0`;
function fixture() {
  const events = new Map(), statuses = [], failures = []; let successes = 0, deadline, cancelled = 0;
  const options = { eventTarget: { addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) },
    schedule: (fn, ms) => { assert.equal(ms, 60_000); deadline = fn; return 123; }, cancel: value => { assert.equal(value, 123); cancelled++; } };
  const view = createModelFrame({ id, title: 'Runestone', onStatus: value => statuses.push(value), onFailure: value => failures.push(value), onReady: () => successes++ }, options);
  const send = (data = {}, overrides = {}) => events.get('message')?.({ source: view.frame.contentWindow, origin: 'null', data: { type: 'satoshi:model-viewer', id, ...data }, ...overrides });
  return { view, send, events, statuses, failures, deadline: () => deadline(), get successes() { return successes; }, get cancelled() { return cancelled; } };
}
test('3D frame is script-only opaque and iframe load alone never marks the model ready', () => {
  const f = fixture(); assert.equal(f.view.frame.attributes.src, `ord://model-viewer/${id}`);
  assert.equal(f.view.frame.attributes.sandbox, 'allow-scripts'); assert.equal(f.view.frame.attributes.allow, '');
  assert.equal(f.view.frame.attributes.referrerpolicy, 'no-referrer');
  f.view.frame.listeners.load(); assert.equal(f.successes, 0); f.view.dispose();
});
test('3D readiness accepts only the owning opaque frame and exact inscription, never arbitrary messages', async () => {
  const f = fixture();
  for (const overrides of [{ source: {} }, { origin: 'ord://model-viewer' }, { origin: 'https://evil.example' }]) f.send({ state: 'ready' }, overrides);
  f.send({ state: 'ready', id: 'another-id' }); f.send({ state: 'ready', type: 'wallet:connect' });
  assert.equal(f.successes, 0);
  f.send({ state: 'preparing', detail: '<script>evil</script>' }); assert.deepEqual(f.statuses, ['Preparing 3D model and textures…']);
  f.send({ state: 'ready' }); await f.view.ready; assert.equal(f.successes, 1); assert.equal(f.cancelled, 1);
  f.send({ state: 'loading' }); f.send({ state: 'ready' }); assert.equal(f.successes, 1); assert.equal(f.statuses.length, 1); f.view.dispose();
});
test('missing module or stalled model reaches an explicit deadline and retires resources', async () => {
  const f = fixture(); const late = f.events.get('message'); f.deadline(); await f.view.ready;
  assert.match(f.failures[0], /too long/); assert.equal(f.view.frame.src, 'about:blank'); assert.equal(f.events.size, 0);
  late({ source: f.view.frame.contentWindow, origin: 'null', data: { type: 'satoshi:model-viewer', id, state: 'ready' } }); assert.equal(f.successes, 0);
});
test('GPU failure after readiness clears the frame and uses fixed safe recovery text', () => {
  const f = fixture(); f.send({ state: 'ready' }); f.send({ state: 'error', code: 'MODEL_GRAPHICS', message: '<script>do not show</script>' });
  assert.match(f.failures[0], /graphics renderer/); assert.doesNotMatch(f.failures[0], /script/); assert.equal(f.view.frame.src, 'about:blank');
});
test('unsupported and unknown error codes are not interpreted as actions or markup', () => {
  for (const code of ['MODEL_EXTERNAL_RESOURCE', 'MODEL_EXTENSION', 'constructor', '<img src=x>', undefined]) {
    const f = fixture(); f.send({ state: 'error', code }); assert.equal(typeof f.failures[0], 'string'); assert.doesNotMatch(f.failures[0], /<img|constructor/);
  }
});
test('appearance message contains only validated presentation and disposal is idempotent', async () => {
  const f = fixture(); f.view.setBackground('light');
  assert.deepEqual(f.view.frame.messages.at(-1), [{ type: 'satoshi:model-appearance', background: 'light' }, '*']);
  f.view.setBackground('https://evil.example'); assert.equal(f.view.frame.messages.at(-1)[0].background, 'dark');
  f.view.dispose(); f.view.dispose(); await f.view.ready; assert.equal(f.cancelled, 1); assert.equal(f.events.size, 0); assert.deepEqual(f.failures, []);
});
test('standalone model viewer renders before ready and releases animation/GPU/texture resources', async () => {
  const source = await fs.readFile(new URL('../src/model-viewer/viewer.js', import.meta.url), 'utf8');
  assert.match(source, /renderer\.render\(scene, camera\); \/\/ Readiness[\s\S]*publish\('ready'\)/);
  for (const text of ['cancelAnimationFrame(frame)', 'resizeObserver?.disconnect()', 'controls?.dispose()', 'mixer?.stopAllAction()', 'value.source?.data?.close?.()', 'renderer?.forceContextLoss()', 'resources?.dispose()']) assert.ok(source.includes(text));
  assert.match(source, /event.source !== parent \|\| event.origin !== 'app:\/\/app'/);
  assert.match(source, /if \(!resources.urls.has\(url\)\) throw/);
  assert.doesNotMatch(source, /eval\(|innerHTML|setDRACOLoader|wallet\.|satBrowser|https?:\/\//);
});
