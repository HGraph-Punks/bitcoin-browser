import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupLifecycle } from '../src/main/startup-lifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('startup admits once and preserves one run result before and after settlement', async () => {
  const lifecycle = createStartupLifecycle();
  const entered = deferred();
  const gate = deferred();
  const resource = { initialized: false };
  const run = lifecycle.run(async ({ step, checkpoint }) => {
    checkpoint();
    await step(async () => { entered.resolve(); await gate.promise; resource.initialized = true; });
    return resource;
  });
  assert.equal(lifecycle.run(() => { throw new Error('second startup admitted'); }), run);
  await entered.promise;
  gate.resolve();
  assert.equal(await run, resource);
  assert.equal(resource.initialized, true);
  assert.equal(lifecycle.run(() => {}), run);
  const drain = lifecycle.stop();
  assert.equal(lifecycle.stopping, true);
  assert.equal(lifecycle.stop(), drain);
  await drain;
});

test('stop before startup admission drains without waiting for external readiness and prevents late work', async () => {
  const lifecycle = createStartupLifecycle();
  const readiness = deferred();
  let resource = null;
  const scheduled = readiness.promise.then(() => lifecycle.run(() => { resource = {}; }));
  const rejected = assert.rejects(scheduled, (error) => lifecycle.isStopError(error));
  const drain = lifecycle.stop();
  assert.equal(lifecycle.stopping, true);
  let drained = false;
  void drain.then(() => { drained = true; });
  await turn();
  assert.equal(drained, true);
  assert.equal(resource, null);
  readiness.resolve();
  await rejected;
  assert.equal(resource, null);
  assert.equal(lifecycle.stop(), drain);
});

test('stop drains admitted work before cleanup and prevents the next resource stage', async () => {
  const lifecycle = createStartupLifecycle();
  const entered = deferred();
  const gate = deferred();
  const resources = new Set();
  const events = [];
  const run = lifecycle.run(async ({ step }) => {
    await step(async () => {
      resources.add('store'); events.push('store-start'); entered.resolve();
      await gate.promise; events.push('store-settled');
    });
    await step(() => { resources.add('window'); events.push('window-created'); });
  });
  const cancelled = assert.rejects(run, (error) => lifecycle.isStopError(error));
  await entered.promise;
  const drain = lifecycle.stop();
  const cleanup = drain.then(() => { resources.delete('store'); events.push('cleanup'); events.push('flush'); });
  await turn();
  assert.deepEqual(events, ['store-start']);
  assert.deepEqual([...resources], ['store']);
  gate.resolve();
  await Promise.all([cancelled, cleanup]);
  assert.deepEqual(events, ['store-start', 'store-settled', 'cleanup', 'flush']);
  assert.equal(resources.size, 0);
});

test('step refuses invocation after stopping and checkpoint throws the exact owned cancellation', async () => {
  const lifecycle = createStartupLifecycle();
  const entered = deferred();
  const gate = deferred();
  let invoked = false;
  let checkpointError;
  const run = lifecycle.run(async ({ step, checkpoint }) => {
    entered.resolve(); await gate.promise;
    try { checkpoint(); } catch (error) { checkpointError = error; }
    await step(() => { invoked = true; });
  });
  const rejected = assert.rejects(run, (error) => error === checkpointError && lifecycle.isStopError(error));
  await entered.promise;
  const drain = lifecycle.stop();
  gate.resolve();
  await Promise.all([rejected, drain]);
  assert.equal(invoked, false);
  assert.equal(lifecycle.isStopError(new Error(checkpointError.message)), false);
});

test('a genuine rejection during stop is retained by identity rather than treated as cancellation', async () => {
  const lifecycle = createStartupLifecycle();
  const gate = deferred();
  const entered = deferred();
  const failure = new Error('synthetic initialization failure');
  const run = lifecycle.run(({ step }) => step(() => { entered.resolve(); return gate.promise; }));
  const rejected = assert.rejects(run, (error) => error === failure);
  await entered.promise;
  const drain = lifecycle.stop();
  const drainRejected = assert.rejects(drain, (error) => error === failure);
  gate.reject(failure);
  await Promise.all([rejected, drainRejected]);
  assert.equal(lifecycle.isStopError(failure), false);
  assert.equal(lifecycle.stop(), drain);
});

test('matching cancellation code and message never suppress an independent failure', async () => {
  const probe = createStartupLifecycle();
  await probe.stop();
  let owned;
  await assert.rejects(probe.run(() => {}), (error) => { owned = error; return probe.isStopError(error); });
  const failure = Object.assign(new Error(owned.message), { code: owned.code });
  const lifecycle = createStartupLifecycle();
  const run = lifecycle.run(() => { throw failure; });
  await assert.rejects(run, (error) => error === failure);
  await assert.rejects(lifecycle.stop(), (error) => error === failure);
  assert.equal(lifecycle.isStopError(failure), false);
  assert.equal(lifecycle.isStopError(owned), false);
});

test('synchronous action throw retains the primary error and never admits the next stage', async () => {
  const lifecycle = createStartupLifecycle();
  const failure = new Error('synthetic synchronous init failure');
  const resources = new Set(['logger']);
  const events = [];
  const run = lifecycle.run(async ({ step }) => {
    await step(() => { throw failure; });
    resources.add('window');
  });
  await assert.rejects(run, (error) => error === failure);
  try { await lifecycle.stop(); } catch (error) { assert.equal(error, failure); events.push('failure-observed'); }
  resources.clear(); events.push('cleanup'); events.push('exit-1');
  assert.equal(resources.size, 0);
  assert.deepEqual(events, ['failure-observed', 'cleanup', 'exit-1']);
  // The caller sequence here is a fixture, not proof of real index.js cleanup.
});

test('run and stop immediately observe rejections even when callers attach later', async (t) => {
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.removeListener('unhandledRejection', listener));
  const lifecycle = createStartupLifecycle();
  const failure = new Error('synthetic delayed observation');
  const entered = deferred();
  const gate = deferred();
  const run = lifecycle.run(() => { entered.resolve(); return gate.promise; });
  await entered.promise;
  const drain = lifecycle.stop();
  gate.reject(failure);
  await turn();
  await turn();
  await assert.rejects(run, (error) => error === failure);
  await assert.rejects(drain, (error) => error === failure);
  assert.deepEqual(unhandled, []);
});
