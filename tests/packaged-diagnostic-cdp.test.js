import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticCdp, discoverTargets } from '../scripts/packaged-diagnostic-cdp.mjs';

function responseFor(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  let sent = false;
  return {
    ok: true,
    body: { getReader: () => ({
      async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; },
      async cancel() {}
    }) }
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.emit('open', {}); });
  }
  addEventListener(name, listener, options = {}) {
    const wrapped = options.once ? (...args) => { this.removeEventListener(name, wrapped); listener(...args); } : listener;
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), wrapped]);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }
  emit(name, event) { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event); }
  send(payload) {
    this.sent.push(JSON.parse(payload));
    const request = this.sent.at(-1);
    const result = request.method === 'Runtime.evaluate' ? { result: { value: true } } : {};
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: request.id, result }) }));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => { this.readyState = FakeWebSocket.CLOSED; this.emit('close', {}); });
  }
}

test('discovers bounded targets only through the expected loopback endpoint', async () => {
  let requested;
  let requestOptions;
  const targets = await discoverTargets(9222, {
    fetchImpl: async (url, options) => {
      requested = url;
      requestOptions = options;
      return responseFor([{ id: 'one', type: 'page', url: 'app://app/renderer/index.html', title: 'App', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/one' }]);
    }
  });
  assert.equal(requested, 'http://127.0.0.1:9222/json/list');
  assert.equal(requestOptions.redirect, 'error');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, 'one');
  await assert.rejects(discoverTargets(0), (error) => error.code === 'INVALID_CDP_PORT');
  await assert.rejects(discoverTargets(9222, {
    fetchImpl: async () => responseFor([{ webSocketDebuggerUrl: 'ws://example.com:9222/devtools/page/one' }])
  }), (error) => error.code === 'INVALID_CDP_URL');
});

test('discovery rejects target collections above the bounded limit', async () => {
  const targets = Array.from({ length: 257 }, (_, index) => ({
    id: String(index), type: 'page', url: 'app://app/renderer/index.html',
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${index}`
  }));
  await assert.rejects(discoverTargets(9222, { fetchImpl: async () => responseFor(targets) }),
    (error) => error.code === 'CDP_DISCOVERY_LIMIT');
});

test('discovery rejects response bodies over the byte limit', async () => {
  const bytes = Buffer.alloc(64 * 1024 + 1, 97);
  const response = { ok: true, body: { getReader: () => ({
    async read() { return { done: false, value: bytes }; }, async cancel() {}
  }) } };
  await assert.rejects(discoverTargets(9222, { fetchImpl: async () => response }), (error) => error.code === 'CDP_DISCOVERY_LIMIT');
});

test('CDP opens required domains, tracks bounded contexts, and evaluates by value', async () => {
  const cdp = new DiagnosticCdp('ws://127.0.0.1:9222/devtools/page/one', 9222, { WebSocketImpl: FakeWebSocket });
  await cdp.open();
  assert.deepEqual(cdp.socket.sent.map((item) => item.method), ['Runtime.enable', 'Page.enable']);
  cdp.socket.emit('message', { data: JSON.stringify({ method: 'Runtime.executionContextCreated', params: { context: { id: 7, auxData: { isDefault: true, frameId: 'frame-one' } } } }) });
  assert.equal(cdp.contexts.get('frame-one'), 7);
  cdp.socket.emit('message', { data: JSON.stringify({ method: 'Runtime.exceptionThrown', params: {} }) });
  assert.equal(cdp.exceptionCount, 1);
  cdp.socket.emit('message', { data: JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }) });
  assert.equal(cdp.contexts.size, 0);
  const pending = cdp.evaluate('Boolean(window.satBrowser)', 7);
  const request = cdp.socket.sent.at(-1);
  assert.equal(await pending, true);
  assert.equal(request.params.awaitPromise, true);
  assert.equal(request.params.returnByValue, true);
  assert.equal(request.params.userGesture, true);
  await cdp.close();
});

test('failed open closes its socket and preserves the protocol failure', async () => {
  class MalformedWebSocket extends FakeWebSocket {
    send(payload) {
      this.sent.push(JSON.parse(payload));
      queueMicrotask(() => this.emit('message', { data: '{malformed' }));
    }
  }
  const cdp = new DiagnosticCdp('ws://127.0.0.1:9222/devtools/page/one', 9222, { WebSocketImpl: MalformedWebSocket });
  await assert.rejects(cdp.open(), (error) => error.code === 'CDP_MESSAGE_INVALID');
  assert.equal(cdp.socket.readyState, FakeWebSocket.CLOSED);
  await assert.rejects(cdp.send('Runtime.enable'), (error) => error.code === 'CDP_MESSAGE_INVALID');
});

test('oversized messages truncate events and reject pending commands', async () => {
  class HeldWebSocket extends FakeWebSocket {
    send(payload) { this.sent.push(JSON.parse(payload)); }
  }
  const cdp = new DiagnosticCdp('ws://127.0.0.1:9222/devtools/page/one', 9222, { WebSocketImpl: HeldWebSocket });
  const opening = cdp.open();
  while (cdp.socket.sent.length < 1) await Promise.resolve();
  const first = cdp.socket.sent[0];
  cdp.socket.emit('message', { data: JSON.stringify({ id: first.id, result: {} }) });
  while (cdp.socket.sent.length < 2) await Promise.resolve();
  const second = cdp.socket.sent[1];
  cdp.socket.emit('message', { data: JSON.stringify({ id: second.id, result: {} }) });
  await opening;
  const pending = cdp.send('Fixture.wait');
  cdp.socket.emit('message', { data: 'x'.repeat(128 * 1024 + 1) });
  await assert.rejects(pending, (error) => error.code === 'CDP_MESSAGE_LIMIT');
  assert.equal(cdp.eventsTruncated, true);
  await cdp.close();
});

test('close rejects pending commands and command deadlines are enforced', async () => {
  class HeldWebSocket extends FakeWebSocket {
    send(payload) {
      const request = JSON.parse(payload);
      this.sent.push(request);
      if (request.method === 'Runtime.enable' || request.method === 'Page.enable') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: request.id, result: {} }) }));
      }
    }
  }
  const cdp = new DiagnosticCdp('ws://127.0.0.1:9222/devtools/page/one', 9222, { WebSocketImpl: HeldWebSocket });
  await cdp.open();
  const pending = cdp.send('Fixture.pending');
  await cdp.close();
  await assert.rejects(pending, (error) => error.code === 'CDP_CLIENT_CLOSED');

  const second = new DiagnosticCdp('ws://127.0.0.1:9222/devtools/page/two', 9222, { WebSocketImpl: HeldWebSocket });
  await second.open();
  await assert.rejects(second.send('Fixture.timeout', {}, 5), (error) => error.code === 'CDP_COMMAND_TIMEOUT');
  await second.close();
});

test('constructor rejects non-loopback and unknown DevTools socket paths', () => {
  assert.throws(() => new DiagnosticCdp('ws://localhost:9222/devtools/page/one', 9222), (error) => error.code === 'INVALID_CDP_URL');
  assert.throws(() => new DiagnosticCdp('ws://127.0.0.1:9222/devtools/browser/one', 9222), (error) => error.code === 'INVALID_CDP_URL');
  assert.throws(() => new DiagnosticCdp('ws://user@127.0.0.1:9222/devtools/page/one', 9222), (error) => error.code === 'INVALID_CDP_URL');
});
