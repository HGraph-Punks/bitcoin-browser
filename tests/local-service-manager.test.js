import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalServiceManager } from '../src/main/local-service-manager.js';

function serviceStore(service) {
  const state = { localServices: [service] };
  return {
    get(pathSegments) { return structuredClone(state[pathSegments[0]]); },
    async mutate(callback) { callback(state); },
    snapshot() { return structuredClone(state); }
  };
}

function configuredService(overrides = {}) {
  return {
    id: 'fixture', name: 'Fixture', executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: process.cwd(),
    enabled: true, autoStart: false, ...overrides
  };
}

async function waitFor(predicate, message = 'condition') {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function outputService(source, overrides = {}) {
  return configuredService({
    args: ['-e', source],
    cwd: os.tmpdir(),
    ...overrides
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('rejects relative service working directories', async () => {
  const manager = new LocalServiceManager(serviceStore(configuredService()), null);
  await assert.rejects(manager.upsert(configuredService({ cwd: 'relative/path' })), { code: 'VALIDATION_ERROR' });
});

test('rejects a missing working directory without creating process state', async () => {
  const manager = new LocalServiceManager(serviceStore(configuredService({ cwd: path.join(os.tmpdir(), 'missing-satoshi-service-cwd') })), null);
  await assert.rejects(manager.start('fixture'), { code: 'SERVICE_CWD_MISSING' });
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.status('fixture').status, 'stopped');
});

test('reports asynchronous spawn failures instead of a null-pid running state', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-service-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'not-executable');
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  const manager = new LocalServiceManager(serviceStore(configuredService({ executable, cwd: directory, args: [] })), null);
  await assert.rejects(manager.start('fixture'), { code: 'SERVICE_START_FAILED' });
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.status('fixture').status, 'failed');
  assert.equal(manager.list()[0].pid, null);
  assert.match(manager.list()[0].logs.at(-1).text, /EACCES|permission/i);
});

test('starts, protects configuration, and idempotently stops a service', async (t) => {
  const store = serviceStore(configuredService());
  const manager = new LocalServiceManager(store, null);
  t.after(() => manager.stopAll());
  const running = await manager.start('fixture');
  assert.equal(running.status, 'running');
  assert.equal(Number.isInteger(running.pid), true);
  await assert.rejects(manager.upsert(configuredService({ name: 'Changed' })), { code: 'SERVICE_RUNNING' });
  assert.equal((await manager.stop('fixture')).status, 'stopped');
  assert.equal((await manager.stop('fixture')).status, 'stopped');
  assert.equal(manager.processes.size, 0);
});

test('concurrent starts reserve the service id and create one child', async (t) => {
  const manager = new LocalServiceManager(serviceStore(outputService('setInterval(() => {}, 1000)')), null);
  t.after(() => manager.stopAll());

  const starts = [manager.start('fixture'), manager.start('fixture'), manager.start('fixture')];
  assert.equal(manager.hasActiveLifecycle(), true);
  const results = await Promise.all(starts);

  assert.equal(new Set(results.map((result) => result.pid)).size, 1);
  assert.equal(manager.processes.size, 1);
  assert.equal(manager.list()[0].logs.filter((entry) => entry.text === 'Starting process').length, 1);
  await manager.stop('fixture');
});

test('simultaneous stops share close completion and retain final output', async () => {
  const manager = new LocalServiceManager(serviceStore(outputService(`
    process.on('SIGTERM', () => {
      process.stdout.write('closing stdout\\n');
      process.stderr.write('closing stderr\\n');
      setTimeout(() => process.exit(0), 75);
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `)), null);
  await manager.start('fixture');
  await waitFor(() => manager.list()[0].logs.some((entry) => entry.stream === 'stdout' && entry.text.includes('ready')), 'child signal handler');

  const stops = [manager.stop('fixture'), manager.stop('fixture'), manager.stop('fixture')];
  assert.equal(manager.status('fixture').status, 'stopping');
  const results = await Promise.all(stops);

  assert.deepEqual(results.map((result) => result.status), ['stopped', 'stopped', 'stopped']);
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.hasActiveLifecycle(), false);
  const logs = manager.list()[0].logs;
  if (process.platform === 'win32') {
    // Node terminates Windows children directly; POSIX signal handlers cannot run.
    assert.match(logs.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join(''), /ready/);
  } else {
    assert.match(logs.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join(''), /closing stdout/);
    assert.match(logs.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text).join(''), /closing stderr/);
  }
  assert.match(logs.at(-1).text, /Process exited/);
});

test('stop after process exit waits for close without entering the termination timeout', async () => {
  const manager = new LocalServiceManager(serviceStore(outputService(`
    process.stdout.write(Buffer.alloc(1024 * 1024, 120));
    process.exitCode = 0;
  `)), null);
  await manager.start('fixture');
  const child = manager.processes.get('fixture');
  await new Promise((resolve) => child.once('exit', resolve));

  const started = Date.now();
  const stopped = await manager.stop('fixture');

  assert.equal(stopped.status, 'stopped');
  assert.equal(Date.now() - started < 1_000, true);
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.list()[0].logs.filter((entry) => entry.stream === 'stdout').reduce((size, entry) => size + entry.text.length, 0) > 0, true);
});

test('remove racing a reserved start closes the child before clearing state', async () => {
  const store = serviceStore(outputService('setInterval(() => {}, 1000)'));
  const manager = new LocalServiceManager(store, null);

  const starting = manager.start('fixture');
  const removing = manager.remove('fixture');
  await Promise.all([starting, removing]);

  assert.deepEqual(store.snapshot().localServices, []);
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.hasActiveLifecycle(), false);
  assert.equal(manager.logs.has('fixture'), false);
  assert.equal(manager.statuses.has('fixture'), false);
});

test('remove reserves the id through a delayed state commit', async (t) => {
  const commitStarted = deferred();
  const releaseCommit = deferred();
  t.after(() => releaseCommit.resolve());
  const state = { localServices: [outputService('setInterval(() => {}, 1000)')] };
  const store = {
    get(pathSegments) { return structuredClone(state[pathSegments[0]]); },
    async mutate(callback) {
      commitStarted.resolve();
      await releaseCommit.promise;
      callback(state);
    },
    snapshot() { return structuredClone(state); }
  };
  const manager = new LocalServiceManager(store, null);
  await manager.start('fixture');

  const firstRemoval = manager.remove('fixture');
  const secondRemoval = manager.remove('fixture');
  assert.equal(firstRemoval, secondRemoval);
  await commitStarted.promise;

  await assert.rejects(manager.start('fixture'), { code: 'SERVICE_REMOVING' });
  await assert.rejects(manager.upsert(outputService('process.exit(0)')), { code: 'SERVICE_REMOVING' });
  assert.equal(store.snapshot().localServices.length, 1);
  assert.equal(manager.processes.size, 0);

  releaseCommit.resolve();
  await firstRemoval;
  assert.deepEqual(store.snapshot().localServices, []);
  assert.equal(manager.hasActiveLifecycle(), false);
});

test('upsert reserves the id through commit so start uses the committed configuration', async (t) => {
  const commitStarted = deferred();
  const releaseCommit = deferred();
  t.after(() => releaseCommit.resolve());
  const state = { localServices: [outputService("process.stdout.write('old configuration\\n'); setInterval(() => {}, 1000)")] };
  const store = {
    get(pathSegments) { return structuredClone(state[pathSegments[0]]); },
    async mutate(callback) {
      commitStarted.resolve();
      await releaseCommit.promise;
      callback(state);
    }
  };
  const manager = new LocalServiceManager(store, null);
  t.after(() => manager.stopAll());
  const updated = outputService("process.stdout.write('new configuration\\n'); setInterval(() => {}, 1000)");

  const editing = manager.upsert(updated);
  await commitStarted.promise;
  assert.equal(manager.hasActiveLifecycle(), true);
  await assert.rejects(manager.start('fixture'), { code: 'SERVICE_EDITING' });
  await assert.rejects(manager.remove('fixture'), { code: 'SERVICE_EDITING' });
  await assert.rejects(manager.upsert(updated), { code: 'SERVICE_EDITING' });

  releaseCommit.resolve();
  await editing;
  await manager.start('fixture');
  await waitFor(() => manager.list()[0].logs.some((entry) => entry.stream === 'stdout'), 'committed child output');
  const output = manager.list()[0].logs.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join('');
  assert.match(output, /new configuration/);
  assert.doesNotMatch(output, /old configuration/);
  await manager.stop('fixture');
});

test('shutdown waits for an in-flight configuration commit', async (t) => {
  const commitStarted = deferred();
  const releaseCommit = deferred();
  t.after(() => releaseCommit.resolve());
  const state = { localServices: [outputService('process.exit(0)')] };
  const store = {
    get(pathSegments) { return structuredClone(state[pathSegments[0]]); },
    async mutate(callback) {
      commitStarted.resolve();
      await releaseCommit.promise;
      callback(state);
    }
  };
  const manager = new LocalServiceManager(store, null);
  const updated = outputService('process.exit(0)', { name: 'Committed during shutdown' });

  const editing = manager.upsert(updated);
  await commitStarted.promise;
  let shutdownFinished = false;
  const shutdown = manager.shutdown().then(() => { shutdownFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);
  await assert.rejects(manager.start('fixture'), { code: 'SERVICE_SHUTTING_DOWN' });

  releaseCommit.resolve();
  await Promise.all([editing, shutdown]);
  assert.equal(state.localServices[0].name, 'Committed during shutdown');
  assert.equal(manager.hasActiveLifecycle(), false);
});

test('shutdown rejects new starts and drains a start already in flight', async () => {
  const first = outputService('setInterval(() => {}, 1000)', { id: 'first', name: 'First', autoStart: true });
  const second = outputService('setInterval(() => {}, 1000)', { id: 'second', name: 'Second', autoStart: true });
  const store = serviceStore(first);
  await store.mutate((draft) => draft.localServices.push(second));
  const manager = new LocalServiceManager(store, null);

  const autoStarting = manager.autoStart();
  const shuttingDown = manager.shutdown();
  assert.equal(shuttingDown, manager.shutdown());
  await assert.rejects(manager.start('second'), { code: 'SERVICE_SHUTTING_DOWN' });
  await assert.rejects(manager.upsert(outputService('process.exit(0)', { id: 'third' })), { code: 'SERVICE_SHUTTING_DOWN' });
  await Promise.all([autoStarting, shuttingDown]);

  assert.equal(manager.processes.size, 0);
  assert.equal(manager.hasActiveLifecycle(), false);
  assert.equal(manager.logs.has('second'), false);
});

test('retains stdout and stderr when a service exits successfully', async () => {
  const manager = new LocalServiceManager(serviceStore(outputService(
    "process.stdout.write('fixture stdout\\n'); process.stderr.write('fixture stderr\\n')"
  )), null);

  await manager.start('fixture');
  await waitFor(() => manager.status('fixture').status === 'stopped', 'successful service exit');

  const service = manager.list()[0];
  assert.equal(service.pid, null);
  assert.equal(service.exitCode, 0);
  assert.equal(service.signal, null);
  assert.equal(service.error, null);
  assert.match(service.logs.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join(''), /fixture stdout/);
  assert.match(service.logs.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text).join(''), /fixture stderr/);
});

test('reports a natural nonzero exit as failed and retains its output', async () => {
  const manager = new LocalServiceManager(serviceStore(outputService(
    "process.stdout.write('before failure\\n'); process.stderr.write('failure detail\\n'); process.exitCode = 7"
  )), null);

  await manager.start('fixture');
  await waitFor(() => manager.status('fixture').status === 'failed', 'failed service exit');

  const service = manager.list()[0];
  assert.equal(service.pid, null);
  assert.equal(service.exitCode, 7);
  assert.equal(service.signal, null);
  assert.match(service.error, /code 7/);
  assert.match(service.logs.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join(''), /before failure/);
  assert.match(service.logs.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text).join(''), /failure detail/);
});

test('can restart a service after natural exit and after an explicit stop', async (t) => {
  const store = serviceStore(outputService("setTimeout(() => process.exit(0), 25)"));
  const manager = new LocalServiceManager(store, null);
  t.after(() => manager.stopAll());

  const first = await manager.start('fixture');
  await waitFor(() => manager.status('fixture').status === 'stopped', 'first natural exit');
  const second = await manager.start('fixture');
  assert.notEqual(second.pid, first.pid);
  await waitFor(() => manager.status('fixture').status === 'stopped', 'second natural exit');

  await manager.upsert(outputService('setInterval(() => {}, 1000)'));
  const third = await manager.start('fixture');
  assert.equal(third.status, 'running');
  await manager.stop('fixture');
  const fourth = await manager.start('fixture');
  assert.equal(fourth.status, 'running');
  assert.notEqual(fourth.pid, third.pid);
  await manager.stop('fixture');
});

test('remove is idempotent and clears retained lifecycle state', async () => {
  const store = serviceStore(outputService("process.stdout.write('temporary log')"));
  const manager = new LocalServiceManager(store, null);
  await manager.start('fixture');
  await waitFor(() => manager.status('fixture').status === 'stopped', 'service exit before removal');

  await manager.remove('fixture');
  await manager.remove('fixture');

  assert.deepEqual(store.snapshot().localServices, []);
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.logs.has('fixture'), false);
  assert.equal(manager.statuses.has('fixture'), false);
});

test('stopAll stops every running service and leaves no process state', async () => {
  const first = outputService('setInterval(() => {}, 1000)', { id: 'first', name: 'First' });
  const second = outputService('setInterval(() => {}, 1000)', { id: 'second', name: 'Second' });
  const store = serviceStore(first);
  await store.mutate((draft) => draft.localServices.push(second));
  const manager = new LocalServiceManager(store, null);

  await Promise.all([manager.start('first'), manager.start('second')]);
  assert.equal(manager.processes.size, 2);
  await manager.stopAll();

  assert.equal(manager.processes.size, 0);
  assert.equal(manager.status('first').status, 'stopped');
  assert.equal(manager.status('second').status, 'stopped');
  assert.deepEqual(manager.list().map((service) => service.pid), [null, null]);
  await manager.stopAll();
});

test('stopAll waits for every stop attempt before aggregating failures', async () => {
  const manager = new LocalServiceManager(serviceStore(configuredService()), null);
  manager.processes.set('first', {});
  manager.processes.set('second', {});
  const first = deferred();
  const second = deferred();
  const attempted = [];
  manager.stop = (id) => {
    attempted.push(id);
    return id === 'first' ? first.promise : second.promise;
  };

  let settled = false;
  const stopping = manager.stopAll().finally(() => { settled = true; });
  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  second.resolve(Promise.reject(new Error('fixture stop failure')));

  await assert.rejects(stopping, AggregateError);
  assert.deepEqual(attempted.sort(), ['first', 'second']);
});
