import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentFrame } from '../src/renderer/document-frame.js';
class Element {
  constructor(tag) { this.tagName = tag; this.attributes = {}; this.listeners = {}; this.messages = []; this.contentWindow = { postMessage: (...args) => this.messages.push(args) }; }
  setAttribute(key, value) { this.attributes[key] = String(value); } addEventListener(key, fn) { this.listeners[key] = fn; } append() {}
}
globalThis.document = { createElement: tag => new Element(tag) }; globalThis.Node = Element;
const id = `${'a'.repeat(64)}i0`;
function fixture(kind = 'pdf') {
  const events = new Map(), statuses = [], failures = [], links = []; let successes = 0, deadline, cancelled = 0;
  const view = createDocumentFrame({ id, kind, title: 'Test inscription', onStatus: text => statuses.push(text), onReady: () => successes++, onFailure: text => failures.push(text), onLink: target => links.push(target) }, {
    eventTarget: { addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key) }, schedule: (fn, ms) => { assert.equal(ms, 60_000); deadline = fn; return 123; }, cancel: () => { cancelled++; }
  });
  const send = (data, overrides = {}) => events.get('message')?.({ source: view.frame.contentWindow, origin: 'null', data: { type: 'satoshi:document-viewer', id, kind, ...data }, ...overrides });
  return { view, events, send, statuses, failures, links, deadline: () => deadline(), get successes() { return successes; }, get cancelled() { return cancelled; } };
}
test('all document frames are opaque, script-only and require rendered readiness rather than iframe load', async () => {
  for (const kind of ['pdf', 'font', 'markdown', 'jxl', 'binary']) {
    const f = fixture(kind); assert.equal(f.view.frame.attributes.src, `ord://document-viewer/${kind}/${id}`); assert.equal(f.view.frame.attributes.sandbox, 'allow-scripts'); assert.equal(f.view.frame.attributes.referrerpolicy, 'no-referrer'); assert.equal(f.view.frame.attributes.allow, '');
    f.view.frame.listeners.load(); assert.equal(f.successes, 0); f.send({ state: 'ready' }); await f.view.ready; assert.equal(f.successes, 1); f.view.dispose();
  }
});
test('readiness and navigation require exact owning frame, origin, kind, ID and message type', () => {
  const f = fixture('markdown');
  for (const overrides of [{ source: {} }, { origin: 'app://app' }, { origin: 'https://invalid.example' }]) f.send({ state: 'ready' }, overrides);
  for (const values of [{ kind: 'font' }, { id: 'wrong' }, { type: 'wallet:connect' }]) f.send({ state: 'ready', ...values });
  f.send({ type: 'satoshi:document-link', href: 'https://example.com' }); assert.equal(f.successes, 0); assert.deepEqual(f.links, []);
  f.send({ state: 'loading', detail: '<script>untrusted</script>' }); assert.deepEqual(f.statuses, ['Preparing markdown reader…']);
  f.send({ state: 'ready' }); f.send({ state: 'loading' }); f.send({ state: 'ready' }); assert.equal(f.successes, 1); assert.equal(f.cancelled, 1);
  for (const href of ['javascript:evil()', 'app://app', 'file:///etc/passwd', 'https://user:secret@example.com']) f.send({ type: 'satoshi:document-link', href }); assert.deepEqual(f.links, []);
  f.send({ type: 'satoshi:document-link', href: `/content/${id}` }); assert.deepEqual(f.links, [`inscription:${id}`]); f.view.dispose();
});
test('stalled readers time out, release the frame and ignore stale readiness messages', async () => {
  const f = fixture(), listener = f.events.get('message'); f.deadline(); await f.view.ready; assert.equal(f.view.frame.src, 'about:blank'); assert.equal(f.events.size, 0); assert.match(f.failures[0], /too long/);
  listener({ source: f.view.frame.contentWindow, origin: 'null', data: { type: 'satoshi:document-viewer', id, kind: 'pdf', state: 'ready' } }); assert.equal(f.successes, 0);
});
test('late reader failures use fixed text and appearance cannot convey URLs or actions', async () => {
  const f = fixture(); f.view.setBackground('light'); assert.equal(f.view.frame.messages.at(-1)[0].background, 'light'); f.view.setBackground('url(https://evil.example)'); assert.equal(f.view.frame.messages.at(-1)[0].background, 'dark');
  f.send({ state: 'ready' }); f.send({ state: 'error', code: '<script>', message: 'private-provider-details' }); assert.doesNotMatch(f.failures[0], /private|script/); f.view.dispose(); f.view.dispose(); await f.view.ready; assert.equal(f.events.size, 0);
});
