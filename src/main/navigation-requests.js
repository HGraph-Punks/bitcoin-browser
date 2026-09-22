import { AppError } from '../shared/errors.js';

const failure = (code, message, status = 409) => new AppError(code, message, { status });
const cancelled = () => failure('NAVIGATION_CANCELLED', 'Navigation was cancelled.', 499);

// Handles are main-owned capabilities bound to a particular live main document.
// Active cancellation never retires completion ownership prematurely.
export class NavigationRequests {
  constructor({ resolve, maxEntries = 128, prepareTimeoutMs = 15_000,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (typeof resolve !== 'function' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
        !Number.isSafeInteger(prepareTimeoutMs) || prepareTimeoutMs < 1) throw new TypeError('Invalid navigation registry options');
    this.resolver = resolve; this.maxEntries = maxEntries; this.prepareTimeoutMs = prepareTimeoutMs;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.entries = new Map(); this.owners = new Map(); this.nextHandle = 1;
    this.stopping = false; this.drain = null;
  }
  identity(event) {
    const sender = event?.sender, frame = event?.senderFrame;
    if (!sender || sender.isDestroyed() || !frame || frame.detached || frame !== sender.mainFrame)
      throw failure('NAVIGATION_OWNER_INVALID', 'Navigation requires the current main frame.', 403);
    return { sender, frame, processId: frame.processId, routingId: frame.routingId };
  }
  assertOpen() { if (this.stopping) throw failure('APP_SHUTTING_DOWN', 'The application is shutting down.', 503); }
  prepare(event, request) {
    this.assertOpen();
    const identity = this.identity(event);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('INVALID_NAVIGATION_REQUEST', 'Invalid navigation request.', 400);
    if (this.entries.size >= this.maxEntries || !Number.isSafeInteger(this.nextHandle)) throw failure('NAVIGATION_BUSY', 'Too many pending navigations.', 429);
    const ownedRequest = structuredClone(request);
    let owner = this.owners.get(identity.sender);
    if (!owner) {
      owner = { sender: identity.sender, entries: new Set(), epoch: 0, listeners: [] };
      const invalidate = () => {
        owner.epoch++;
        for (const entry of [...owner.entries]) this.abort(entry);
      };
      const navigation = (details, _url, isInPlace, isMainFrame) => {
        const main = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
        const same = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace;
        if (main === true && same !== true) invalidate();
      };
      try {
        for (const [name, callback] of [['did-start-navigation', navigation], ['render-process-gone', invalidate], ['destroyed', invalidate]]) {
          // Record before registration: an emitter may register and then throw.
          owner.listeners.push([name, callback]); identity.sender.on(name, callback);
        }
      } catch (cause) {
        for (const [name, callback] of owner.listeners) identity.sender.removeListener(name, callback);
        throw cause;
      }
      this.owners.set(identity.sender, owner);
    }
    const entry = { ...identity, owner, epoch: owner.epoch, handle: this.nextHandle++, request: ownedRequest,
      controller: new AbortController(), promise: null, timer: null };
    this.entries.set(entry.handle, entry); owner.entries.add(entry);
    try {
      entry.timer = this.setTimer(() => this.abort(entry), this.prepareTimeoutMs);
      entry.timer.unref?.();
      this.assertOpen();
      if (entry.controller.signal.aborted || this.entries.get(entry.handle) !== entry || entry.epoch !== owner.epoch)
        throw entry.controller.signal.reason ?? cancelled();
      const current = this.identity(event);
      if (current.sender !== entry.sender || current.frame !== entry.frame || current.processId !== entry.processId || current.routingId !== entry.routingId)
        throw failure('NAVIGATION_OWNER_INVALID', 'Navigation belongs to another document.', 403);
    } catch (cause) { this.remove(entry); throw cause; }
    return { handle: entry.handle };
  }
  lookup(event, handle) {
    this.assertOpen();
    if (!Number.isSafeInteger(handle) || handle <= 0) throw failure('INVALID_NAVIGATION_HANDLE', 'Invalid navigation handle.', 400);
    const identity = this.identity(event), entry = this.entries.get(handle);
    if (!entry) return null;
    if (entry.sender !== identity.sender || entry.frame !== identity.frame || entry.processId !== identity.processId ||
        entry.routingId !== identity.routingId || entry.epoch !== entry.owner.epoch)
      throw failure('NAVIGATION_OWNER_INVALID', 'Navigation belongs to another document.', 403);
    return entry;
  }
  resolve(event, handle) {
    let entry;
    try {
      entry = this.lookup(event, handle);
      if (!entry) throw cancelled();
      if (entry.promise) throw failure('NAVIGATION_ALREADY_STARTED', 'Navigation was already started.');
      this.clearTimer(entry.timer); entry.timer = null;
    } catch (cause) { return Promise.reject(cause); }
    entry.promise = Promise.resolve().then(() => {
      if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
      // Re-check at actual callback admission, not only at IPC delivery.
      const current = this.identity(event);
      if (current.frame !== entry.frame || current.processId !== entry.processId || current.routingId !== entry.routingId)
        throw failure('NAVIGATION_OWNER_INVALID', 'Navigation belongs to another document.', 403);
      return this.resolver(entry.request, entry.controller.signal);
    }).then(result => {
      if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
      return result;
    }, cause => {
      if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
      throw cause;
    }).finally(() => this.remove(entry));
    void entry.promise.catch(() => {});
    return entry.promise;
  }
  cancel(event, handle) {
    const entry = this.lookup(event, handle);
    if (!entry) return { requested: false };
    this.abort(entry); return { requested: true };
  }
  abort(entry) {
    if (!this.entries.has(entry.handle)) return;
    if (!entry.controller.signal.aborted) entry.controller.abort(cancelled());
    if (!entry.promise) this.remove(entry);
  }
  remove(entry) {
    if (entry.timer !== null) this.clearTimer(entry.timer);
    this.entries.delete(entry.handle); entry.owner.entries.delete(entry);
    if (!entry.owner.entries.size) {
      for (const [name, callback] of entry.owner.listeners) entry.sender.removeListener(name, callback);
      this.owners.delete(entry.sender);
    }
  }
  shutdown() {
    if (this.drain) return this.drain;
    this.stopping = true;
    let finish;
    this.drain = new Promise(resolve => { finish = resolve; });
    for (const entry of [...this.entries.values()]) this.abort(entry);
    void Promise.allSettled([...this.entries.values()].map(entry => entry.promise)).then(finish);
    return this.drain;
  }
}
