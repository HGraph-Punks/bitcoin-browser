import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { AppError, serializeError, toAppError } from '../src/shared/errors.js';

const source = await fs.readFile(new URL('../src/main/cache.js', import.meta.url), 'utf8');
const body = source.replace(/^import .*;\n/gm, '').replace('export class DiskCache', 'class DiskCache');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const oldBytes = Buffer.from('prior synthetic cache bytes');
const newBytes = Buffer.from('replacement synthetic cache bytes');

async function fixture(t, mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-write-recovery-'));
  const index = path.join(directory, 'index.json');
  const object = path.join(directory, 'objects', digest('key'));
  const primary = ['validation-and-index', 'post-index-validation'].includes(mode)
    ? new AppError('ROUTING_INVALIDATED', 'Synthetic routing invalidation', { status: 409, retryable: true })
    : Object.assign(new Error('Synthetic index commit rename failure'), { code: 'EIO' });
  const secondary = Object.assign(new Error('Synthetic rollback filesystem failure'), { code: 'EACCES' });
  const cleanupFailure = Object.assign(new Error('Synthetic index temporary cleanup failure'), { code: 'EPERM' });
  const loggerFailure = Object.assign(new Error('Synthetic warning logger rejection'), { code: 'EPIPE' });
  const indexTemporaries = new Set();
  const opens = []; const warnings = [];
  let armed = false; let rollback = false; let injected = 0;
  let indexPublished = false; let restored = false; let collision = null;
  let indexWriteFailed = false;
  const io = {
    ...fs,
    async open(file, flags, permissions) {
      if (armed) {
        opens.push({ file, flags, permissions });
        if (mode === 'collision' && file.startsWith(`${index}.`) && !collision) {
          collision = file; await fs.writeFile(file, 'nonowned collision sentinel');
        }
      }
      const handle = await fs.open(file, flags, permissions);
      if (armed && file.startsWith(`${index}.`)) indexTemporaries.add(file);
      return {
        async writeFile(...args) {
          if (armed && mode === 'exclusive-write' && file.startsWith(path.dirname(object)) && file.endsWith('.tmp')) { rollback = true; injected++; throw primary; }
          if (armed && rollback && file.startsWith(`${index}.`) && ['rollback-index', 'validation-and-index', 'nested-cleanup'].includes(mode)) { indexWriteFailed = true; injected++; throw secondary; }
          return handle.writeFile(...args);
        },
        write: handle.write.bind(handle), sync: handle.sync.bind(handle),
        async close() {
          await handle.close();
          if (armed && mode === 'exclusive-close' && file.startsWith(path.dirname(object)) && file.endsWith('.tmp')) { rollback = true; injected++; throw primary; }
        }
      };
    },
    async writeFile(file, ...args) {
      if (armed && file.startsWith(`${index}.`)) {
        indexTemporaries.add(file);
        if (rollback && ['rollback-index', 'validation-and-index'].includes(mode)) { injected++; throw secondary; }
      }
      return fs.writeFile(file, ...args);
    },
    async rename(from, to) {
      if (armed && to === index && !rollback && !['validation-and-index', 'post-index-validation', 'collision', 'cleanup', 'cleanup-logger', 'exclusive-write', 'exclusive-close'].includes(mode)) {
        rollback = true; injected++; throw primary;
      }
      if (armed && to === index && rollback && mode === 'nested-rename' && !indexWriteFailed) { indexWriteFailed = true; injected++; throw secondary; }
      if (armed && mode === 'restore' && from.endsWith('.previous') && to === object) { injected++; throw secondary; }
      await fs.rename(from, to);
      if (armed && to === index) indexPublished = true;
      if (armed && from.endsWith('.previous') && to === object) restored = true;
    },
    async rm(file, ...args) {
      if (armed && rollback && mode === 'remove-new' && file === object) { injected++; throw secondary; }
      if (armed && !rollback && ['cleanup', 'cleanup-logger'].includes(mode) && file.endsWith('.previous')) { injected++; throw secondary; }
      if (armed && ['nested-cleanup', 'nested-rename'].includes(mode) && indexWriteFailed && file.startsWith(`${index}.`)) { injected++; throw cleanupFailure; }
      return fs.rm(file, ...args);
    },
    async readFile(file, ...args) {
      if (armed && rollback && restored && mode === 'verify-restore' && file === object) { injected++; throw secondary; }
      return fs.readFile(file, ...args);
    }
  };
  const Cache = vm.runInNewContext(`(() => { ${body}; return DiskCache; })()`, {
    fs: io, path, crypto, process: { pid: process.pid }, Buffer, structuredClone, AppError, serializeError, toAppError
  });
  const cache = new Cache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, { warn: (...args) => {
    warnings.push(args); if (mode === 'cleanup-logger') return Promise.reject(loggerFailure);
  } });
  t.after(async () => {
    try { await cache.flush(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await cache.init(); await cache.put('key', oldBytes, { version: 'old' });
  const preserved = ['operator-note.txt', 'index.json.operator.tmp', 'index.json.123.not-a-uuid.tmp'];
  for (const name of preserved) await fs.writeFile(path.join(directory, name), 'preserve');
  let validations = 0;
  const perform = async () => {
    armed = true;
    try {
      return await cache.put('key', newBytes, { version: 'new' }, null, {
        validate() {
          if (mode === 'validation-and-index' && ++validations === 4) { rollback = true; injected++; throw primary; }
          if (mode === 'post-index-validation' && indexPublished && !rollback) { rollback = true; injected++; throw primary; }
        }
      });
    }
    finally { armed = false; }
  };
  const attempt = async () => {
    let failure;
    try { await perform(); } catch (error) { failure = error; }
    assert.ok(failure, 'Injected failure must reject'); return failure;
  };
  return { cache, Cache, directory, index, object, primary, secondary, preserved, indexTemporaries, opens, warnings, attempt, perform, collision: () => collision, injections: () => injected };
}

function preservesPrimary(error, primary) {
  assert.equal(error.code, primary.code);
  assert.ok(error === primary || error.cause === primary, 'Original failure identity is retained directly or as cause');
  assert.equal(error.status, primary.status);
  assert.equal(error.retryable, primary.retryable);
}

test('failed index commit with successful rollback preserves prior same-key payload and primary failure', async (t) => {
  const f = await fixture(t, 'control'); const error = await f.attempt();
  assert.equal(f.injections(), 1); preservesPrimary(error, f.primary);
  assert.equal((await f.cache.get('key')).data.equals(oldBytes), true);
  assert.equal(f.cache.stats().entries, 1);
  assert.equal(f.cache.stats().bytes, oldBytes.length);
  const reopened = new f.Cache(f.directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 });
  await reopened.init(); assert.equal((await reopened.get('key')).data.equals(oldBytes), true); await reopened.flush();
});

test('failed same-key restoration retains prior bytes and reports recovery failure without false restored metadata', async (t) => {
  const f = await fixture(t, 'restore'); const error = await f.attempt();
  assert.equal(f.injections(), 2); preservesPrimary(error, f.primary);
  const objects = await fs.readdir(path.dirname(f.object));
  const candidates = objects.filter((name) => name === path.basename(f.object) || name.endsWith('.previous'));
  const retained = await Promise.all(candidates.map((name) => fs.readFile(path.join(path.dirname(f.object), name))));
  assert.ok(retained.some((bytes) => bytes.equals(oldBytes)), 'Failed restore must not silently destroy its only previous payload');
  const entry = f.cache.entries[digest('key')];
  if (entry) {
    const canonical = await fs.readFile(f.object);
    assert.equal(entry.sha256, digest(canonical), 'Any live entry must describe the actual canonical bytes');
  }
  assert.ok(Array.isArray(error.details?.recoveryErrors) && error.details.recoveryErrors.length > 0, 'Failed restore is reported explicitly');
  assert.equal(await f.cache.get('key'), null, 'Unverified restoration is a runtime miss');
  assert.equal(error.details.cacheRollback.restartRecoveryConfirmed, false);
  assert.equal(error.details.cacheRollback.rollbackIndexCommitted, true);
  const retry = await f.cache.put('key', newBytes, { retry: true });
  assert.equal(retry.cached, true);
  assert.equal((await f.cache.get('key')).data.equals(newBytes), true);
  // No reopen assertion: a durable salvage policy is not established by retained bytes alone.
});

test('rollback index failure cannot replace the original index commit failure', async (t) => {
  const f = await fixture(t, 'rollback-index'); const error = await f.attempt();
  assert.equal(f.injections(), 2); preservesPrimary(error, f.primary);
  assert.equal((await fs.readFile(f.object)).equals(oldBytes), true);
});

test('rollback index failure cannot replace ROUTING_INVALIDATED classification', async (t) => {
  const f = await fixture(t, 'validation-and-index'); const error = await f.attempt();
  assert.equal(f.injections(), 2); preservesPrimary(error, f.primary);
  assert.equal((await fs.readFile(f.object)).equals(oldBytes), true);
});

test('failed index rename cleans only its exact owned temporary and preserves unrelated root files', async (t) => {
  const f = await fixture(t, 'control'); const error = await f.attempt(); preservesPrimary(error, f.primary);
  assert.ok(f.indexTemporaries.size > 0);
  const rootNames = await fs.readdir(f.directory);
  for (const temporary of f.indexTemporaries) assert.equal(rootNames.includes(path.basename(temporary)), false);
  for (const name of f.preserved) assert.equal(await fs.readFile(path.join(f.directory, name), 'utf8'), 'preserve');
  assert.ok(f.opens.length > 0);
  for (const opened of f.opens) { assert.equal(opened.flags, 'wx'); assert.equal(opened.permissions, 0o600); }
});

test('validation failure after index publication rolls back old bytes and persisted metadata', async (t) => {
  const f = await fixture(t, 'post-index-validation'); const error = await f.attempt(); preservesPrimary(error, f.primary);
  assert.equal(error.details.cacheRollback.indexCommitted, true);
  assert.equal(error.details.cacheRollback.rollbackIndexCommitted, true);
  assert.equal((await f.cache.get('key')).data.equals(oldBytes), true);
  const persisted = JSON.parse(await fs.readFile(f.index, 'utf8'));
  assert.equal(persisted[digest('key')].sha256, digest(oldBytes));
});

test('remove-new rollback failure remains secondary and never creates false canonical metadata', async (t) => {
  const f = await fixture(t, 'remove-new'); const error = await f.attempt(); preservesPrimary(error, f.primary);
  assert.ok(error.details.recoveryErrors.length > 0);
  const entry = f.cache.entries[digest('key')];
  if (entry) assert.equal(entry.sha256, digest(await fs.readFile(f.object)));
  else assert.equal(await f.cache.get('key'), null);
  await f.cache.put('key', Buffer.from('usable later')); assert.equal((await f.cache.get('key')).data.toString(), 'usable later');
});

test('restoration verification failure yields a truthful miss rather than claimed successful restore', async (t) => {
  const f = await fixture(t, 'verify-restore'); const error = await f.attempt(); preservesPrimary(error, f.primary);
  assert.ok(f.injections() >= 2, 'Verification failure was actually reached');
  assert.ok(error.details.recoveryErrors.length > 0);
  assert.equal(f.cache.entries[digest('key')], undefined);
  assert.equal(await f.cache.get('key'), null);
  assert.equal(error.details.cacheRollback.restartRecoveryConfirmed, false);
});

test('exclusive index temporary collision leaves nonowned sentinel untouched', async (t) => {
  const f = await fixture(t, 'collision'); const error = await f.attempt();
  assert.equal(error.code, 'EEXIST'); assert.ok(f.collision());
  assert.equal(await fs.readFile(f.collision(), 'utf8'), 'nonowned collision sentinel');
  assert.equal((await f.cache.get('key')).data.equals(oldBytes), true);
});

test('post-commit backup cleanup failure returns cached success with warnings instead of rolling back', async (t) => {
  const f = await fixture(t, 'cleanup'); const result = await f.perform();
  assert.equal(result.cached, true); assert.ok(f.injections() >= 1);
  assert.ok(Array.isArray(result.cleanupErrors) && result.cleanupErrors.length > 0);
  assert.ok(f.warnings.length > 0);
  assert.equal((await f.cache.get('key')).data.equals(newBytes), true);
  assert.equal(JSON.parse(await fs.readFile(f.index, 'utf8'))[digest('key')].sha256, digest(newBytes));
});

test('rollback index failure retains nested owned temporary cleanup failure alongside primary error', async (t) => {
  const observations = [];
  for (const mode of ['nested-cleanup', 'nested-rename']) {
    const f = await fixture(t, mode); const error = await f.attempt(); preservesPrimary(error, f.primary);
    assert.ok(f.injections() >= 3, 'Commit, rollback write/rename and cleanup faults all fired');
    assert.ok(error.details.recoveryErrors.some((entry) => entry.code === 'EACCES'));
    observations.push({ mode, cleanupRecorded: error.details.recoveryErrors.some((entry) => entry.code === 'EPERM') });
    assert.equal((await fs.readFile(f.object)).equals(oldBytes), true);
  }
  assert.deepEqual(observations, [
    { mode: 'nested-cleanup', cleanupRecorded: true }, { mode: 'nested-rename', cleanupRecorded: true }
  ], 'Nested cleanup errors must survive both rollback-index wrapper paths');
});

test('exclusive staging write and close failures clean owned files and preserve usable prior entry', async (t) => {
  for (const mode of ['exclusive-write', 'exclusive-close']) {
    const f = await fixture(t, mode); const error = await f.attempt(); preservesPrimary(error, f.primary);
    assert.ok(f.injections() >= 1);
    const names = await fs.readdir(path.dirname(f.object));
    assert.deepEqual(names, [path.basename(f.object)]);
    assert.equal((await f.cache.get('key')).data.equals(oldBytes), true);
    await f.cache.put('key', newBytes); assert.equal((await f.cache.get('key')).data.equals(newBytes), true);
  }
});

test('post-commit warning logger rejection remains secondary without rollback or unhandled rejection', async (t) => {
  const unhandled = []; const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const f = await fixture(t, 'cleanup-logger'); const result = await f.perform();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.cached, true);
    assert.ok(result.cleanupErrors.some((entry) => entry.stage === 'cleanup-log' && entry.code === 'EPIPE'));
    assert.equal((await f.cache.get('key')).data.equals(newBytes), true);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});
