import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalServiceManager } from '../src/main/local-service-manager.js';

function configuredService(id, overrides = {}) {
  return {
    id, name: `Fixture ${id}`, executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: os.tmpdir(),
    enabled: true, autoStart: true, ...overrides
  };
}

function storeFor(services) {
  const state = { localServices: structuredClone(services) };
  return {
    get(parts) { return structuredClone(state[parts[0]]); },
    async mutate(callback) { callback(state); },
    snapshot() { return structuredClone(state); }
  };
}

function loggerCapture() {
  const warnings = [];
  return { warnings, logger: { warn: (...args) => warnings.push(args), info() {} } };
}

test('autoStart publishes missing executable and cwd failures while creating no child', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-autostart-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const services = [
    configuredService('missing-executable', { executable: path.join(directory, 'missing-node') }),
    configuredService('missing-cwd', { cwd: path.join(directory, 'missing-cwd') })
  ];
  const store = storeFor(services);
  const { logger, warnings } = loggerCapture();
  const publications = [];
  const manager = new LocalServiceManager(store, logger, (snapshot) => publications.push(snapshot));

  await manager.autoStart();

  assert.equal(manager.processes.size, 0);
  assert.equal(manager.hasActiveLifecycle(), false);
  assert.deepEqual(manager.list().map(({ id, status, pid }) => ({ id, status, pid })), [
    { id: 'missing-executable', status: 'failed', pid: null },
    { id: 'missing-cwd', status: 'failed', pid: null }
  ]);
  assert.match(manager.list()[0].error, /executable/i);
  assert.match(manager.list()[1].error, /working directory/i);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings.map(([, fields]) => fields.id), ['missing-executable', 'missing-cwd']);
  assert.ok(publications.some((snapshot) => snapshot.find((service) => service.id === 'missing-executable')?.status === 'failed'));
  assert.ok(publications.at(-1).every((service) => service.status === 'failed' && service.pid === null));
});

test('correcting an autoStart failure permits start and clears its visible error', { timeout: 5_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-autostart-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const failed = configuredService('fixture', { executable: path.join(directory, 'missing-node') });
  const store = storeFor([failed]);
  const publications = [];
  const manager = new LocalServiceManager(store, loggerCapture().logger, (snapshot) => publications.push(snapshot));
  t.after(() => manager.stopAll());

  await manager.autoStart();
  assert.equal(manager.status('fixture').status, 'failed');
  await manager.upsert(configuredService('fixture', { autoStart: false }));
  const running = await manager.start('fixture');

  assert.equal(running.status, 'running');
  assert.equal(Number.isInteger(running.pid), true);
  assert.equal(running.error, null);
  assert.equal(manager.list()[0].error, null);
  assert.ok(publications.some((snapshot) => snapshot[0].status === 'running' && snapshot[0].error === null));
  const stopped = await manager.stop('fixture');
  assert.equal(stopped.status, 'stopped');
});

test('manual pre-spawn validation still rejects without converting stopped state into an autoStart failure', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-manual-start-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = new LocalServiceManager(storeFor([
    configuredService('fixture', { executable: path.join(directory, 'missing-node'), autoStart: false })
  ]), null);
  const publications = [];
  manager.onChange = (snapshot) => publications.push(snapshot);

  await assert.rejects(manager.start('fixture'), { code: 'SERVICE_EXECUTABLE_MISSING' });
  assert.equal(manager.status('fixture').status, 'stopped');
  assert.equal(manager.list()[0].error, null);
  assert.equal(manager.processes.size, 0);
  assert.deepEqual(publications, []);
});

test('autoStart joining an already admitted manual start still owns visible validation failure', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-shared-autostart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const publications = [];
  const manager = new LocalServiceManager(storeFor([
    configuredService('fixture', { executable: path.join(directory, 'missing-node') })
  ]), loggerCapture().logger, (snapshot) => publications.push(snapshot));

  const manual = manager.start('fixture');
  const automatic = manager.autoStart();
  await assert.rejects(manual, { code: 'SERVICE_EXECUTABLE_MISSING' });
  await automatic;

  assert.equal(manager.status('fixture').status, 'failed');
  assert.equal(manager.processes.size, 0);
  assert.equal(publications.at(-1)[0].status, 'failed');
  assert.match(publications.at(-1)[0].error, /executable/i);
});

test('manual start joining an admitted autoStart shares the exact failure and one publication', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-auto-manual-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const publications = [];
  const manager = new LocalServiceManager(storeFor([
    configuredService('fixture', { executable: path.join(directory, 'missing-node') })
  ]), loggerCapture().logger, (snapshot) => publications.push(snapshot));

  const automatic = manager.autoStart();
  const manual = manager.start('fixture');
  await assert.rejects(manual, { code: 'SERVICE_EXECUTABLE_MISSING' });
  await automatic;

  assert.equal(publications.filter((snapshot) => snapshot[0]?.status === 'failed').length, 1);
  assert.equal(manager.status('fixture').status, 'failed');
});

test('malformed persisted autoStart configurations publish bounded validation failures', async () => {
  const publications = [];
  const manager = new LocalServiceManager(storeFor([
    configuredService('relative', { executable: 'relative/node' }),
    configuredService('nul-arg', { args: ['ok', 'bad\0arg'] })
  ]), loggerCapture().logger, (snapshot) => publications.push(snapshot));

  await manager.autoStart();

  const listed = manager.list();
  assert.deepEqual(listed.map(({ id, status }) => ({ id, status })), [
    { id: 'relative', status: 'failed' }, { id: 'nul-arg', status: 'failed' }
  ]);
  assert.match(listed[0].error, /absolute path/i);
  assert.match(listed[1].error, /invalid data/i);
  assert.equal(publications.length, 2);
  assert.equal(manager.processes.size, 0);
});

test('disabled and empty executable autoStart records are deliberately skipped', async () => {
  const { logger, warnings } = loggerCapture();
  const publications = [];
  const manager = new LocalServiceManager(storeFor([
    configuredService('disabled', { enabled: false }),
    configuredService('empty', { executable: '' })
  ]), logger, (snapshot) => publications.push(snapshot));

  await manager.autoStart();

  assert.deepEqual(manager.list().map(({ status }) => status), ['stopped', 'stopped']);
  assert.deepEqual(warnings, []);
  assert.deepEqual(publications, []);
  assert.equal(manager.hasActiveLifecycle(), false);
});

test('throwing publication observer cannot replace the exact shared AppError', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-autostart-observer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { logger, warnings } = loggerCapture();
  const manager = new LocalServiceManager(storeFor([
    configuredService('fixture', { executable: path.join(directory, 'missing-node') })
  ]), logger, () => { throw new Error('observer exploded'); });

  const manual = manager.start('fixture');
  const automatic = manager.autoStart();
  const error = await manual.catch((failure) => failure);
  await automatic;

  assert.equal(error.code, 'SERVICE_EXECUTABLE_MISSING');
  assert.match(error.message, /does not exist/i);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].message, error.message);
  assert.equal(manager.status('fixture').status, 'failed');
});

test('concurrent repeated autoStart calls share one attempt and one failed publication', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-autostart-repeat-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { logger, warnings } = loggerCapture();
  const publications = [];
  const manager = new LocalServiceManager(storeFor([
    configuredService('fixture', { executable: path.join(directory, 'missing-node') })
  ]), logger, (snapshot) => publications.push(snapshot));

  await Promise.all([manager.autoStart(), manager.autoStart()]);

  assert.equal(publications.filter((snapshot) => snapshot[0]?.status === 'failed').length, 1);
  assert.equal(warnings.length, 2, 'each caller observes and logs the shared failed attempt');
  assert.equal(manager.processes.size, 0);
});

test('a later manual-only validation failure is not tagged by an old autoStart promise', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-autostart-old-tag-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = configuredService('fixture', { executable: path.join(directory, 'missing-one') });
  const store = storeFor([first]);
  const publications = [];
  const manager = new LocalServiceManager(store, loggerCapture().logger, (snapshot) => publications.push(snapshot));
  await manager.autoStart();
  const published = publications.length;
  await manager.upsert(configuredService('fixture', { executable: path.join(directory, 'missing-two'), autoStart: false }));

  await assert.rejects(manager.start('fixture'), { code: 'SERVICE_EXECUTABLE_MISSING' });

  assert.equal(publications.length, published);
  assert.equal(manager.processes.size, 0);
});

test('remove superseding a shared failed start suppresses stale failed publication', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-autostart-remove-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = storeFor([configuredService('fixture', { executable: path.join(directory, 'missing-node') })]);
  const publications = [];
  const manager = new LocalServiceManager(store, loggerCapture().logger, (snapshot) => publications.push(snapshot));
  const manual = manager.start('fixture');
  const automatic = manager.autoStart();
  const removing = manager.remove('fixture');

  await assert.rejects(manual, { code: 'SERVICE_EXECUTABLE_MISSING' });
  await Promise.all([automatic, removing]);

  assert.deepEqual(store.snapshot().localServices, []);
  assert.equal(publications.some((snapshot) => snapshot[0]?.status === 'failed'), false);
  assert.equal(manager.hasActiveLifecycle(), false);
});

test('shutdown superseding a shared failed start suppresses stale failed publication', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-autostart-shutdown-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const publications = [];
  const manager = new LocalServiceManager(storeFor([
    configuredService('fixture', { executable: path.join(directory, 'missing-node') })
  ]), loggerCapture().logger, (snapshot) => publications.push(snapshot));
  const manual = manager.start('fixture');
  const automatic = manager.autoStart();
  const shutdown = manager.shutdown();

  await assert.rejects(manual, { code: 'SERVICE_EXECUTABLE_MISSING' });
  await Promise.all([automatic, shutdown]);

  assert.equal(publications.some((snapshot) => snapshot[0]?.status === 'failed'), false);
  assert.equal(manager.hasActiveLifecycle(), false);
});
