import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NavigationRequests } from '../src/main/navigation-requests.js';

function sender() {
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  sender.mainFrame = { processId: 1, routingId: 2, detached: false };
  return { sender, senderFrame: sender.mainFrame };
}
function fixture(resolve = async value => value, options = {}) {
  const timers = new Map(); let next = 0;
  const registry = new NavigationRequests({ resolve, ...options,
    setTimer: callback => { const timer = { id: ++next, unref() {} }; timers.set(timer, callback); return timer; },
    clearTimer: timer => timers.delete(timer) });
  return { registry, timers, event: sender() };
}
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

test('prepared request is cloned, executed once, and all idle ownership is released', async () => {
  let calls = 0;
  const f = fixture(async value => { calls++; return value; });
  const request = { target: { id: 'a' }, options: {} };
  const { handle } = f.registry.prepare(f.event, request); request.target.id = 'changed';
  const result = f.registry.resolve(f.event, handle);
  await assert.rejects(f.registry.resolve(f.event, handle), { code: 'NAVIGATION_ALREADY_STARTED' });
  assert.equal((await result).target.id, 'a'); assert.equal(calls, 1);
  assert.equal(f.registry.entries.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.event.sender.eventNames().length, 0);
});

test('other windows, child frames, replaced frames and malformed handles cannot consume ownership', async () => {
  const f = fixture(); const { handle } = f.registry.prepare(f.event, {});
  await assert.rejects(f.registry.resolve(sender(), handle), { code: 'NAVIGATION_OWNER_INVALID' });
  assert.throws(() => f.registry.cancel({ ...f.event, senderFrame: {} }, handle), { code: 'NAVIGATION_OWNER_INVALID' });
  for (const invalid of [0, -1, 1.5, '1', NaN, {}, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => f.registry.cancel(f.event, invalid), { code: 'INVALID_NAVIGATION_HANDLE' });
  f.event.sender.mainFrame = { processId: 1, routingId: 2 };
  await assert.rejects(f.registry.resolve(f.event, handle), { code: 'NAVIGATION_OWNER_INVALID' });
  await f.registry.shutdown();
});

test('idle cancellation and expiry never invoke resolver, handles are not reused', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  const first = f.registry.prepare(f.event, {}).handle;
  assert.deepEqual(f.registry.cancel(f.event, first), { requested: true });
  assert.deepEqual(f.registry.cancel(f.event, first), { requested: false });
  const second = f.registry.prepare(f.event, {}).handle; assert.ok(second > first);
  [...f.timers.values()][0]();
  await assert.rejects(f.registry.resolve(f.event, second), { code: 'NAVIGATION_CANCELLED', status: 499 });
  assert.equal(calls, 0); assert.equal(f.event.sender.eventNames().length, 0);
});

test('active ignored-abort completion is retained and shutdown drains without returning stale success', async () => {
  const held = gate(), entered = gate(); let signal, reentrant;
  const f = fixture(async (_request, value) => { signal = value; entered.resolve(); await held.promise; return 'late'; });
  const { handle } = f.registry.prepare(f.event, {});
  const result = f.registry.resolve(f.event, handle); await entered.promise;
  signal.addEventListener('abort', () => { reentrant = f.registry.shutdown(); });
  const shutdown = f.registry.shutdown(); assert.equal(shutdown, reentrant);
  let closed = false; shutdown.then(() => { closed = true; }); await Promise.resolve();
  assert.equal(closed, false); assert.equal(f.registry.entries.size, 1);
  assert.equal(signal.reason.code, 'NAVIGATION_CANCELLED'); assert.equal(signal.reason.status, 499);
  held.resolve(); await assert.rejects(result, cause => cause === signal.reason); await shutdown;
  assert.equal(f.registry.entries.size, 0); assert.equal(f.event.sender.eventNames().length, 0);
  assert.throws(() => f.registry.prepare(f.event, {}), { code: 'APP_SHUTTING_DOWN' });
});

test('main cross-document navigation invalidates deferred admission; subframes and same-document do not', async () => {
  for (const legacy of [false, true]) {
    let calls = 0; const f = fixture(async () => { calls++; return 'ok'; });
    const { handle } = f.registry.prepare(f.event, {});
    f.event.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    f.event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    assert.equal(f.registry.entries.size, 1);
    const running = f.registry.resolve(f.event, handle);
    if (legacy) f.event.sender.emit('did-start-navigation', {}, 'app://shell', false, true);
    else f.event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await assert.rejects(running, { code: 'NAVIGATION_CANCELLED' }); assert.equal(calls, 0);
  }
});

test('crash and destroy invalidate prepared requests and remove listeners', async () => {
  for (const name of ['render-process-gone', 'destroyed']) {
    const f = fixture(); const { handle } = f.registry.prepare(f.event, {});
    f.event.sender.emit(name);
    await assert.rejects(f.registry.resolve(f.event, handle), { code: 'NAVIGATION_CANCELLED' });
    assert.equal(f.event.sender.eventNames().length, 0);
  }
});

test('global capacity includes active aborted work and listeners are shared per sender', async () => {
  const held = gate(); const f = fixture(async () => held.promise, { maxEntries: 2 });
  const first = f.registry.prepare(f.event, {}).handle, second = f.registry.prepare(f.event, {}).handle;
  assert.equal(f.event.sender.listenerCount('destroyed'), 1);
  const running = f.registry.resolve(f.event, first); await Promise.resolve();
  f.registry.cancel(f.event, first);
  assert.throws(() => f.registry.prepare(sender(), {}), { code: 'NAVIGATION_BUSY' });
  f.registry.cancel(f.event, second); held.resolve(); await assert.rejects(running, { code: 'NAVIGATION_CANCELLED' });
  assert.equal(f.registry.owners.size, 0);
});

test('partial registration failure removes even the listener whose registration throws', () => {
  const f = fixture(); const on = f.event.sender.on;
  f.event.sender.on = function(name, callback) { on.call(this, name, callback); if (name === 'render-process-gone') throw new Error('registration failure'); return this; };
  assert.throws(() => f.registry.prepare(f.event, {}), /registration failure/);
  assert.equal(f.event.sender.eventNames().length, 0); assert.equal(f.registry.entries.size, 0); assert.equal(f.registry.owners.size, 0);
});

test('resolver rejection preserves original identity and releases its ownership', async () => {
  const primary = new Error('controlled failure'); const f = fixture(async () => { throw primary; });
  const { handle } = f.registry.prepare(f.event, {});
  await assert.rejects(f.registry.resolve(f.event, handle), cause => cause === primary);
  assert.equal(f.registry.entries.size, 0); await f.registry.shutdown();
});

test('frame replacement between resolve delivery and callback admission prevents execution', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  const { handle } = f.registry.prepare(f.event, {});
  const result = f.registry.resolve(f.event, handle);
  f.event.sender.mainFrame = { processId: 1, routingId: 3 };
  await assert.rejects(result, { code: 'NAVIGATION_OWNER_INVALID' });
  assert.equal(calls, 0); assert.equal(f.registry.entries.size, 0);
});

test('ignored-abort rejection returns the exact cancellation reason after actual settlement', async () => {
  const held = gate(), entered = gate(); let signal;
  const f = fixture(async (_request, current) => { signal = current; entered.resolve(); await held.promise; throw new Error('late transport failure'); });
  const { handle } = f.registry.prepare(f.event, {});
  const result = f.registry.resolve(f.event, handle); await entered.promise;
  f.registry.cancel(f.event, handle);
  assert.equal(f.registry.entries.size, 1);
  held.resolve(); await assert.rejects(result, cause => cause === signal.reason);
  assert.equal(f.registry.entries.size, 0);
});

test('synchronous timer expiry or invalidation never returns an unowned prepared handle', () => {
  for (const action of ['expire', 'navigate', 'identity', 'shutdown', 'throw']) {
    const event = sender(); let registry, cleared = 0;
    registry = new NavigationRequests({ resolve: async () => {}, setTimer(callback) {
      if (action === 'expire') callback();
      if (action === 'navigate') event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      if (action === 'identity') event.senderFrame.routingId++;
      if (action === 'shutdown') registry.shutdown();
      if (action === 'throw') throw new Error('timer failure');
      return { unref() {} };
    }, clearTimer() { cleared++; } });
    assert.throws(() => registry.prepare(event, {}), undefined, action);
    assert.equal(registry.entries.size, 0, action);
    assert.equal(event.sender.eventNames().length, 0, action);
    if (action !== 'throw') assert.ok(cleared > 0, action);
  }
});
