import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/main/preload.cjs', import.meta.url), 'utf8');
const PREPARE = 'entity:resolve-prepare';
const RESOLVE = 'entity:resolve';
const CANCEL = 'entity:resolve-cancel';
const copy = value => JSON.parse(JSON.stringify(value));
const ok = result => ({ ok: true, result });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, hooks = {}, { legacy = false } = {}) {
  const calls = [];
  const gates = [];
  let facade;
  let next = 0;
  const hold = () => { const gate = deferred(); gates.push(gate); return gate; };
  const context = { require(name) {
    assert.equal(name, 'electron', 'sandboxed preload may require only electron');
    return {
      contextBridge: { exposeInMainWorld(_name, api) { facade = api; } },
      ipcRenderer: {
        async invoke(channel, payload) {
          calls.push(copy({ channel, payload }));
          if (hooks[channel]) return hooks[channel](payload);
          if (channel === PREPARE) return ok({ handle: ++next });
          if (channel === CANCEL) return ok({ requested: true });
          return ok({ canonical: payload.input ?? `handle:${payload.handle}` });
        }, on() {}, removeListener() {}
      }
    };
  } };
  vm.runInNewContext(source, context, { filename: 'preload.cjs' });
  t.after(() => { for (const gate of gates) gate.resolve(ok({ handle: 1 })); });
  // Fail before creating held asynchronous assertions if the baseline does not
  // yet expose the tracked API; an absent API must not strand fixture work.
  if (!legacy) assert.equal(typeof facade.navigation.cancelResolve, 'function');
  return { api: facade.navigation, calls, hold };
}

test('tracked resolve uses a hidden main preparation handle, preserving input and options', async t => {
  const f = fixture(t);
  const options = { localOnly: true, preferredProviderId: 'source', timeoutMs: 4000 };
  assert.deepEqual(copy(await f.api.resolve('sat:0', options, 'request_1')), { canonical: 'handle:1' });
  assert.deepEqual(f.calls, [
    { channel: PREPARE, payload: { input: 'sat:0', options } },
    { channel: RESOLVE, payload: { handle: 1 } }
  ]);
  assert.deepEqual(copy(await f.api.cancelResolve('request_1')), { requested: false });
});

test('legacy two-argument resolve keeps its original channel and options', async t => {
  const f = fixture(t, {}, { legacy: true });
  await f.api.resolve('sat:0', { network: 'mainnet' });
  assert.deepEqual(f.calls, [{ channel: RESOLVE, payload: { input: 'sat:0', options: { network: 'mainnet' } } }]);
});

test('cancellation before preparation settles cannot admit resolution', async t => {
  const prepare = deferred();
  t.after(() => prepare.resolve(ok({ handle: 27 })));
  const f = fixture(t, { [PREPARE]: () => prepare.promise });
  const resolution = f.api.resolve('sat:0', undefined, 'pending');
  const rejected = assert.rejects(resolution, e => e.code === 'NAVIGATION_CANCELLED');
  const cancellation = f.api.cancelResolve('pending');
  prepare.resolve(ok({ handle: 27 }));
  assert.deepEqual(copy(await cancellation), { requested: true });
  await rejected;
  assert.deepEqual(f.calls.map(c => c.channel), [PREPARE, CANCEL]);
  assert.deepEqual(f.calls[1].payload, { handle: 27 });
});

test('active cancellation is exact and does not pretend the resolution has drained', async t => {
  const gate = deferred();
  t.after(() => gate.resolve(ok({ value: 'late' })));
  const f = fixture(t, { [RESOLVE]: payload => payload.handle === 1 ? gate.promise : ok({ other: true }) });
  let settled = false;
  const first = f.api.resolve('sat:0', undefined, 'first');
  const rejected = assert.rejects(first, e => e.code === 'NAVIGATION_CANCELLED').then(() => { settled = true; });
  await tick();
  const other = f.api.resolve('sat:1', undefined, 'other');
  assert.deepEqual(copy(await f.api.cancelResolve('first')), { requested: true });
  assert.equal(settled, false, 'abort acknowledgment is not operation settlement');
  assert.deepEqual(copy(await other), { other: true });
  assert.deepEqual(f.calls.filter(c => c.channel === CANCEL), [{ channel: CANCEL, payload: { handle: 1 } }]);
  gate.resolve(ok({ value: 'late' }));
  await rejected;
});

test('duplicate cancellation shares one main cancellation and late success stays cancelled', async t => {
  const gate = deferred();
  t.after(() => gate.resolve(ok(null)));
  const f = fixture(t, { [RESOLVE]: () => gate.promise });
  const result = f.api.resolve('sat:0', undefined, 'same');
  const rejected = assert.rejects(result, e => e.code === 'NAVIGATION_CANCELLED');
  await tick();
  await Promise.all([f.api.cancelResolve('same'), f.api.cancelResolve('same')]);
  assert.equal(f.calls.filter(c => c.channel === CANCEL).length, 1);
  gate.resolve(ok({ stale: true }));
  await rejected;
});

test('duplicate pending ID is rejected without replacing ownership', async t => {
  const gate = deferred();
  t.after(() => gate.resolve(ok(null)));
  const f = fixture(t, { [RESOLVE]: () => gate.promise });
  const first = f.api.resolve('sat:0', undefined, 'duplicate');
  const rejected = assert.rejects(first, e => e.code === 'NAVIGATION_CANCELLED');
  await assert.rejects(f.api.resolve('sat:1', undefined, 'duplicate'), e => e.code === 'NAVIGATION_REQUEST_CONFLICT');
  await f.api.cancelResolve('duplicate');
  gate.resolve(ok(null));
  await rejected;
  assert.equal(f.calls.filter(c => c.channel === PREPARE).length, 1);
});

test('IDs are bounded exact strings and invalid IDs perform no IPC', async t => {
  const f = fixture(t);
  for (const id of ['', 'space id', 'a'.repeat(129), null, 1, {}, '../x']) {
    await assert.rejects(f.api.resolve('sat:0', undefined, id), e => e.code === 'VALIDATION_ERROR');
    await assert.rejects(f.api.cancelResolve(id), e => e.code === 'VALIDATION_ERROR');
  }
  assert.equal(f.calls.length, 0);
});

test('preparation failure retires local ownership and keeps actionable error metadata', async t => {
  let failures = 1;
  const f = fixture(t, { [PREPARE]: () => failures-- > 0
    ? { ok: false, error: { code: 'APP_SHUTTING_DOWN', message: 'Stopping', status: 503 } }
    : ok({ handle: 3 }) });
  await assert.rejects(f.api.resolve('sat:0', undefined, 'retry'), e => e.code === 'APP_SHUTTING_DOWN' && e.status === 503);
  assert.deepEqual(copy(await f.api.cancelResolve('retry')), { requested: false });
  await f.api.resolve('sat:1', undefined, 'retry');
  assert.equal(f.calls.filter(c => c.channel === CANCEL).length, 0);
});

test('invalid preparation response cannot start an unowned resolution', async t => {
  for (const prepared of [null, {}, { handle: 0 }, { handle: -1 }, { handle: '1' }, { handle: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = fixture(t, { [PREPARE]: () => ok(prepared) });
    await assert.rejects(f.api.resolve('sat:0', undefined, 'invalid'), e => e.code === 'IPC_INVALID_RESPONSE');
    assert.deepEqual(f.calls.map(c => c.channel), [PREPARE]);
  }
});

test('resolution transport failure attempts exact cleanup and preserves the primary error', async t => {
  const f = fixture(t, { [RESOLVE]: () => { throw new Error('transport unavailable'); } });
  await assert.rejects(f.api.resolve('sat:0', undefined, 'failed'), e => e.code === 'IPC_TRANSPORT_ERROR');
  assert.deepEqual(f.calls.map(c => c.channel), [PREPARE, RESOLVE, CANCEL]);
  assert.deepEqual(f.calls[2].payload, { handle: 1 });
});

test('cancellation failure rejects the cancellation call without publishing a late success', async t => {
  const gate = deferred();
  t.after(() => gate.resolve(ok({ stale: true })));
  const f = fixture(t, {
    [RESOLVE]: () => gate.promise,
    [CANCEL]: () => ({ ok: false, error: { code: 'CANCEL_FAILED', message: 'Unavailable', status: 503 } })
  });
  const result = f.api.resolve('sat:0', undefined, 'failure');
  const rejected = assert.rejects(result, e => e.code === 'NAVIGATION_CANCELLED' && e.details.cancellationError.code === 'CANCEL_FAILED');
  await tick();
  await assert.rejects(f.api.cancelResolve('failure'), e => e.code === 'CANCEL_FAILED');
  gate.resolve(ok({ stale: true }));
  await rejected;
});

test('pending registration capacity stays bounded and releases after settlement', async t => {
  const gate = deferred();
  t.after(() => gate.resolve(ok(null)));
  const f = fixture(t, { [RESOLVE]: () => gate.promise });
  const active = Array.from({ length: 128 }, (_, i) => f.api.resolve('sat:0', undefined, `request-${i}`));
  await assert.rejects(f.api.resolve('sat:0', undefined, 'overflow'), e => e.code === 'NAVIGATION_REQUEST_LIMIT');
  assert.equal(f.calls.filter(c => c.channel === PREPARE).length, 128);
  gate.resolve(ok(null));
  await Promise.all(active);
  await f.api.resolve('sat:1', undefined, 'released');
});
