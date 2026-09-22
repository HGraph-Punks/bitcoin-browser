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
const bytes = (label, length = 40) => Buffer.from(label.padEnd(length, label[0]));

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-eviction-recovery-'));
  const index = path.join(directory, 'index.json');
  const victimId = digest('victim');
  let armed = false;
  let indexFailures = 0;
  let restoreFailures = 0;
  const primary = Object.assign(new Error('Synthetic eviction index commit failure'), { code: 'EIO' });
  const restoreError = Object.assign(new Error('Synthetic victim restoration failure'), { code: 'EACCES' });
  const io = {
    ...fs,
    async rename(from, to) {
      if (armed && to === index && indexFailures++ === 0) throw primary;
      if (armed && from.endsWith('.previous') && (options.failAllRestores
        || (options.failVictimRestore && to === path.join(directory, 'objects', victimId)))) {
        restoreFailures += 1;
        throw restoreError;
      }
      return fs.rename(from, to);
    }
  };
  const Cache = vm.runInNewContext(`(() => { ${body}; return DiskCache; })()`, {
    fs: io, path, crypto, process: { pid: process.pid }, Buffer, structuredClone, AppError, serializeError, toAppError
  });
  const cache = new Cache(directory, { maxBytes: 1024, maxEntryBytes: 1024 });
  t.after(async () => {
    try { await cache.flush(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await cache.init();
  const attempt = async (key, data, meta = {}) => {
    armed = true;
    try { return await cache.put(key, data, meta); }
    finally { armed = false; }
  };
  return { directory, index, victimId, cache, Cache, primary, attempt, restoreFailures: () => restoreFailures };
}

test('failed put index commit restores unrelated LRU victims in memory and after reopen', async (t) => {
  const f = await fixture(t);
  const victim = bytes('victim'); const survivor = bytes('survivor');
  await f.cache.put('victim', victim, { version: 'victim' });
  await f.cache.put('survivor', survivor, { version: 'survivor' });
  f.cache.maxBytes = 100;

  await assert.rejects(f.attempt('new', bytes('new-entry'), { version: 'new' }), (error) => {
    assert.equal(error.code, 'EIO');
    return true;
  });
  assert.equal((await f.cache.get('victim')).data.equals(victim), true);
  assert.equal((await f.cache.get('survivor')).data.equals(survivor), true);
  assert.equal(await f.cache.get('new'), null);
  await f.cache.flush();
  const reopened = new f.Cache(f.directory, { maxBytes: 1024, maxEntryBytes: 1024 });
  await reopened.init();
  assert.equal((await reopened.get('victim')).data.equals(victim), true);
  assert.equal((await reopened.get('survivor')).data.equals(survivor), true);
  assert.equal(await reopened.get('new'), null);
  await reopened.flush();
});

test('failed oversized same-key update restores the old value when the written ID is its own eviction victim', async (t) => {
  const f = await fixture(t);
  const old = bytes('old', 30); const replacement = bytes('replacement', 80);
  await f.cache.put('victim', old, { version: 'old' });
  f.cache.maxBytes = 60;
  await assert.rejects(f.attempt('victim', replacement, { version: 'replacement' }), { code: 'EIO' });
  const current = await f.cache.get('victim');
  assert.equal(current.data.equals(old), true);
  assert.deepEqual(current.meta, { version: 'old' });
});

test('failed victim restoration reports recovery failure, leaves a truthful miss, and retains prior bytes as evidence', async (t) => {
  const f = await fixture(t, { failVictimRestore: true });
  const victim = bytes('victim');
  await f.cache.put('victim', victim, { version: 'victim' });
  await f.cache.put('survivor', bytes('survivor'), { version: 'survivor' });
  f.cache.maxBytes = 100;
  let error;
  try { await f.attempt('new', bytes('new-entry')); } catch (caught) { error = caught; }
  assert.equal(error.code, 'EIO');
  assert.equal(f.restoreFailures(), 1);
  assert.ok(error.details?.recoveryErrors?.some((entry) => entry.code === 'EACCES'));
  assert.equal(await f.cache.get('victim'), null);
  const names = await fs.readdir(path.join(f.directory, 'objects'));
  const retained = names.filter((name) => name.startsWith(`${f.victimId}.`) && name.endsWith('.previous'));
  assert.equal(retained.length, 1);
  assert.equal((await fs.readFile(path.join(f.directory, 'objects', retained[0]))).equals(victim), true);
});

test('successful put-driven eviction and explicit prune retain capacity and usable survivors', async (t) => {
  const f = await fixture(t);
  await f.cache.put('victim', bytes('victim'));
  await f.cache.put('survivor', bytes('survivor'));
  f.cache.maxBytes = 100;
  // Do not arm the synthetic index fault for successful behavior.
  await f.cache.put('new', bytes('new-entry'));
  assert.ok(f.cache.stats().bytes <= 90);
  assert.equal(await f.cache.get('victim'), null);
  assert.equal((await f.cache.get('survivor')).data.length, 40);
  assert.equal((await f.cache.get('new')).data.length, 40);
  await f.cache.configure({ maxBytes: 45, maxEntryBytes: 1024 });
  assert.ok(f.cache.stats().bytes <= 40);
  assert.equal(f.cache.stats().entries, 1);
});

test('high-cardinality restoration failures retain truthful totals while bounding path and error samples', async (t) => {
  const f = await fixture(t, { failAllRestores: true });
  const victimKeys = Array.from({ length: 24 }, (_, index) => `victim-${index}`);
  for (const [index, key] of victimKeys.entries()) {
    await f.cache.put(key, Buffer.alloc(8, index + 1), { index });
  }
  f.cache.maxBytes = 8;

  let error;
  try { await f.attempt('new', Buffer.alloc(8, 0xff)); } catch (caught) { error = caught; }
  assert.equal(error.code, 'EIO');
  assert.equal(f.restoreFailures(), 24);
  assert.equal(error.details.recoveryErrorCount, 24);
  assert.equal(error.details.recoveryErrors.length, 20);
  assert.equal(error.details.cacheRollback.invalidatedEntryCount, 24);
  assert.equal(error.details.cacheRollback.invalidatedEntries.length, 20);
  assert.equal(error.details.cacheRollback.retainedBackupCount, 24);
  assert.equal(error.details.cacheRollback.retainedBackups.length, 20);
  assert.equal(error.details.cacheRollback.restartRecoveryConfirmed, false);
  assert.equal(f.cache.stats().entries, 0);
  for (const key of victimKeys) assert.equal(await f.cache.get(key), null);

  const names = await fs.readdir(path.join(f.directory, 'objects'));
  assert.equal(names.filter((name) => name.endsWith('.previous')).length, 24);
});
