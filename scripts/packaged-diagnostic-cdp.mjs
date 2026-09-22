const MAX_DISCOVERY_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_EVENTS = 256;

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPort(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw failure('INVALID_CDP_PORT');
}

function validateSocketUrl(value, port) {
  if (typeof value !== 'string' || value.length > 4_096) throw failure('INVALID_CDP_URL');
  let url;
  try { url = new URL(value); } catch { throw failure('INVALID_CDP_URL'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port
    || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/devtools/page/') || url.pathname.length > 1_024) {
    throw failure('INVALID_CDP_URL');
  }
  return url.toString();
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('CDP_DISCOVERY_INVALID');
  const chunks = [];
  let bytes = 0;
  for (let count = 0; count < 64; count += 1) {
    const { done, value } = await reader.read();
    if (done) {
      try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
      catch { throw failure('CDP_DISCOVERY_INVALID'); }
    }
    bytes += value.byteLength;
    if (bytes > MAX_DISCOVERY_BYTES) {
      await reader.cancel().catch(() => {});
      throw failure('CDP_DISCOVERY_LIMIT');
    }
    chunks.push(Buffer.from(value));
  }
  await reader.cancel().catch(() => {});
  throw failure('CDP_DISCOVERY_LIMIT');
}

export async function discoverTargets(port, { timeoutMs = 2_000, fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  assertPort(port);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw failure('INVALID_CDP_TIMEOUT');
  if (typeof fetchImpl !== 'function') throw failure('INVALID_CDP_FETCH');
  const deadline = Date.now() + timeoutMs;
  let lastError = failure('CDP_DISCOVERY_TIMEOUT');
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(250, remaining))),
        redirect: 'error'
      });
      if (!response?.ok) throw failure('CDP_DISCOVERY_HTTP');
      const list = await boundedJson(response);
      if (!Array.isArray(list)) throw failure('CDP_DISCOVERY_INVALID');
      if (list.length > MAX_EVENTS) throw failure('CDP_DISCOVERY_LIMIT');
      return list.map((item) => {
        const target = item && typeof item === 'object' ? item : {};
        return {
          id: typeof target.id === 'string' ? target.id.slice(0, 256) : '',
          type: typeof target.type === 'string' ? target.type.slice(0, 64) : '',
          url: typeof target.url === 'string' ? target.url.slice(0, 4_096) : '',
          title: typeof target.title === 'string' ? target.title.slice(0, 512) : '',
          webSocketDebuggerUrl: validateSocketUrl(target.webSocketDebuggerUrl, port)
        };
      });
    } catch (error) {
      if (error?.code === 'CDP_DISCOVERY_LIMIT' || error?.code === 'INVALID_CDP_URL') throw error;
      lastError = error?.code ? error : failure('CDP_DISCOVERY_UNAVAILABLE');
    }
    if (Date.now() < deadline) await sleep(Math.min(25, deadline - Date.now()));
  }
  throw failure('CDP_DISCOVERY_TIMEOUT', lastError.message);
}

export class DiagnosticCdp {
  constructor(webSocketDebuggerUrl, port, { WebSocketImpl = globalThis.WebSocket } = {}) {
    assertPort(port);
    if (typeof WebSocketImpl !== 'function') throw failure('INVALID_CDP_WEBSOCKET');
    this.url = validateSocketUrl(webSocketDebuggerUrl, port);
    this.WebSocketImpl = WebSocketImpl;
    this.sequence = 0;
    this.pending = new Map();
    this.events = [];
    this.contexts = new Map();
    this.exceptionCount = 0;
    this.eventsTruncated = false;
    this.closed = false;
    this.failure = null;
  }

  #rejectPending(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async open() {
    if (this.socket) throw failure('CDP_ALREADY_OPEN');
    const socket = this.socket = new this.WebSocketImpl(this.url);
    socket.addEventListener('message', (event) => this.#message(event));
    socket.addEventListener('error', () => {
      this.failure = failure('CDP_SOCKET_ERROR');
      this.#rejectPending(this.failure);
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      this.#rejectPending(failure('CDP_SOCKET_CLOSED'));
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(failure('CDP_OPEN_TIMEOUT')), 3_000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(failure('CDP_SOCKET_ERROR')); }, { once: true });
      });
      await this.send('Runtime.enable');
      await this.send('Page.enable');
      return this;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  #message(event) {
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_MESSAGE_BYTES) {
      this.eventsTruncated = true;
      this.failure = failure('CDP_MESSAGE_LIMIT');
      this.#rejectPending(this.failure);
      try { this.socket.close(); } catch {}
      return;
    }
    let message;
    try { message = JSON.parse(event.data); }
    catch {
      this.failure = failure('CDP_MESSAGE_INVALID');
      this.#rejectPending(this.failure);
      try { this.socket.close(); } catch {}
      return;
    }
    if (Number.isSafeInteger(message?.id)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(failure('CDP_COMMAND_ERROR'));
      else waiter.resolve(message.result);
      return;
    }
    if (this.events.length < MAX_EVENTS) this.events.push(message);
    else this.eventsTruncated = true;
    if (message?.method === 'Runtime.exceptionThrown') {
      this.exceptionCount += 1;
    } else if (message?.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear();
    } else if (message?.method === 'Runtime.executionContextCreated') {
      const context = message.params?.context;
      if (context?.auxData?.isDefault && typeof context.auxData.frameId === 'string' && Number.isSafeInteger(context.id)) {
        if (this.contexts.size < MAX_EVENTS || this.contexts.has(context.auxData.frameId)) this.contexts.set(context.auxData.frameId.slice(0, 256), context.id);
        else this.eventsTruncated = true;
      }
    } else if (message?.method === 'Runtime.executionContextDestroyed' && Number.isSafeInteger(message.params?.executionContextId)) {
      for (const [frameId, contextId] of this.contexts) if (contextId === message.params.executionContextId) this.contexts.delete(frameId);
    }
  }

  send(method, params = {}, timeoutMs = 3_000) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed || !this.socket) return Promise.reject(failure('CDP_SOCKET_CLOSED'));
    if (typeof method !== 'string' || !method || method.length > 128) return Promise.reject(failure('INVALID_CDP_METHOD'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(failure('INVALID_CDP_TIMEOUT'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('CDP_COMMAND_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const payload = JSON.stringify({ id, method, params });
        if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) throw failure('CDP_MESSAGE_LIMIT');
        this.socket.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error?.code ? error : failure('CDP_SEND_FAILED'));
      }
    });
  }

  async evaluate(expression, contextId) {
    if (typeof expression !== 'string' || expression.length > 64 * 1024) throw failure('INVALID_CDP_EXPRESSION');
    const response = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
      ...(contextId === undefined ? {} : { contextId })
    });
    if (response?.exceptionDetails) {
      this.exceptionCount += 1;
      throw failure('CDP_EVALUATION_EXCEPTION');
    }
    return response?.result?.value;
  }

  async close(timeoutMs = 500) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw failure('INVALID_CDP_TIMEOUT');
    this.#rejectPending(failure('CDP_CLIENT_CLOSED'));
    const socket = this.socket;
    if (!socket || this.closed || socket.readyState === this.WebSocketImpl.CLOSED) {
      this.closed = true;
      return;
    }
    const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
    if (socket.readyState === this.WebSocketImpl.CONNECTING) {
      socket.addEventListener('open', () => { try { socket.close(); } catch {} }, { once: true });
    }
    let closeFailed = false;
    try { socket.close(); } catch { closeFailed = true; }
    let timer;
    const completed = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
    clearTimeout(timer);
    if (!completed) throw failure(closeFailed ? 'CDP_CLOSE_FAILED' : 'CDP_CLOSE_TIMEOUT');
    this.closed = true;
  }
}
