import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { AppError, serializeError, toAppError } from '../src/shared/errors.js';
import { RecursiveResolver } from '../src/main/resolver.js';

const source = (await fs.readFile(new URL('../src/main/cache.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export class DiskCache', 'class DiskCache');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const payload = Buffer.from('verified offline payload');

async function fixture(t, { key = 'key', ttl = null, warn = () => {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-hit-metadata-'));
  const index = path.join(directory, 'index.json'); const object = path.join(directory, 'objects', digest(key));
  let metadataError = null; let readError = null; let renameError = null; let cleanupError = null; let metadataFaults = 0;
  const logs = [];
  const io = { ...fs,
    async open(file, ...args) {
      if (metadataError && file.startsWith(`${index}.`)) { metadataFaults++; throw metadataError; }
      return fs.open(file, ...args);
    },
    async readFile(file, ...args) {
      if (readError && file === object) throw readError;
      return fs.readFile(file, ...args);
    },
    async rename(from, to) {
      if (renameError && to === index) { metadataFaults++; throw renameError; }
      return fs.rename(from, to);
    },
    async rm(file, ...args) {
      if (cleanupError && file.startsWith(`${index}.`)) throw cleanupError;
      return fs.rm(file, ...args);
    }
  };
  const Cache = vm.runInNewContext(`(() => { ${source}; return DiskCache; })()`, {
    fs: io, path, crypto, process: { pid: process.pid }, Buffer, structuredClone, AppError, serializeError, toAppError
  });
  const cache = new Cache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, {
    warn: (...args) => { logs.push(args); return warn(...args); }
  });
  t.after(async () => { try { await cache.flush(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  await cache.init(); await cache.put(key, payload, { headers: { 'content-type': 'text/plain' }, provenance: { fixture: true } }, ttl);
  return { cache, Cache, directory, index, object, key, logs,
    failMetadata: (code) => { metadataError = Object.assign(new Error(`Synthetic metadata ${code}`), { code }); return metadataError; },
    failRead: (code) => { readError = Object.assign(new Error(`Synthetic payload ${code}`), { code }); return readError; },
    failRename: (code) => { renameError = Object.assign(new Error(`Synthetic private path ${directory}`), { code }); },
    failCleanup: (code) => { cleanupError = Object.assign(new Error(`Synthetic payload ${payload}`), { code }); },
    recover: () => { metadataError = null; readError = null; renameError = null; cleanupError = null; }, metadataFaults: () => metadataFaults
  };
}

async function observe(action) {
  try { return { result: await action(), error: null }; }
  catch (error) { return { result: null, error }; }
}

test('ENOSPC/EACCES hit-metadata failure does not prevent returning already verified bytes', async (t) => {
  const observations = [];
  for (const code of ['ENOSPC', 'EACCES']) {
    const f = await fixture(t); f.failMetadata(code);
    const hit = await observe(() => f.cache.get(f.key));
    const persisted = JSON.parse(await fs.readFile(f.index, 'utf8'))[digest(f.key)];
    const retained = (await fs.readFile(f.object)).equals(payload);
    const faults = f.metadataFaults(); f.recover();
    const retry = await f.cache.get(f.key);
    const reopened = new f.Cache(f.directory); await reopened.init();
    const reopenedHit = await reopened.get(f.key); await reopened.flush();
    observations.push({ code, faults, returned: hit.result?.data.equals(payload) ?? false, errorCode: hit.error?.code ?? null,
      retained, persistedDigest: persisted.sha256 === digest(payload), retry: retry.data.equals(payload), reopened: reopenedHit.data.equals(payload) });
  }
  assert.deepEqual(observations, ['ENOSPC', 'EACCES'].map((code) => ({
    code, faults: 1, returned: true, errorCode: null, retained: true, persistedDigest: true, retry: true, reopened: true
  })));
});

test('actual offline resolver serves full and ranged verified hits during metadata-write failure without transport', async (t) => {
  const resource = `/content/${'a'.repeat(64)}i0`; const key = `v2|mainnet|auto|*/*|${resource}`;
  const f = await fixture(t, { key }); f.failMetadata('ENOSPC');
  const settings = { network: 'mainnet', preferredProviderId: null, offlineMode: true,
    maxConcurrentContentRequests: 2, cacheMaxBytes: 1024 * 1024, maxResourceBytes: 1024 };
  const routing = {}; let transport = 0;
  const resolver = new RecursiveResolver({ captureRouting: () => routing, assertRouting: (value) => assert.equal(value, routing),
    fetchOrdPath() { transport++; throw new Error('Offline fixture must not use transport'); }
  }, f.cache, { get: (segments) => segments.length === 2 ? settings[segments[1]] : structuredClone(settings) });
  const full = await observe(() => resolver.resolve(resource));
  const ranged = await observe(() => resolver.resolve(resource, { range: 'bytes=2-6' }));
  f.recover(); const retry = await resolver.resolve(resource);
  assert.deepEqual({ transport, fullStatus: full.result?.status ?? null, fullError: full.error?.code ?? null,
    fullBytes: full.result?.data.equals(payload) ?? false, rangeStatus: ranged.result?.status ?? null,
    rangeError: ranged.error?.code ?? null, rangeBytes: ranged.result?.data.toString() ?? null, retry: retry.data.equals(payload) }, {
    transport: 0, fullStatus: 200, fullError: null, fullBytes: true, rangeStatus: 206, rangeError: null,
    rangeBytes: payload.subarray(2, 7).toString(), retry: true
  });
});

test('ordinary hit and expired allowStale behavior retain their existing contract', async (t) => {
  const ordinary = await fixture(t); const normal = await ordinary.cache.get(ordinary.key);
  assert.equal(normal.data.equals(payload), true); assert.equal(normal.stale, false);
  const expired = await fixture(t, { ttl: -1 });
  assert.equal(await expired.cache.get(expired.key), null);
  const stale = await expired.cache.get(expired.key, { allowStale: true });
  assert.equal(stale.data.equals(payload), true); assert.equal(stale.stale, true);
});

test('missing or digest-corrupt bytes never become hits when repair index writes fail', async (t) => {
  for (const condition of ['missing', 'corrupt']) {
    const f = await fixture(t);
    if (condition === 'missing') await fs.unlink(f.object);
    else await fs.writeFile(f.object, Buffer.alloc(payload.length, 0x78));
    f.failMetadata('ENOSPC'); const hit = await observe(() => f.cache.get(f.key));
    assert.equal(hit.result, null); assert.equal(hit.error?.code, 'ENOSPC');
    assert.equal(f.cache.stats().entries, 0);
    f.recover(); await f.cache.put(f.key, payload); assert.equal((await f.cache.get(f.key)).data.equals(payload), true);
  }
});

test('payload-read error remains primary and preserves retryable bytes without attempting metadata write', async (t) => {
  const f = await fixture(t); const primary = f.failRead('EIO'); f.failMetadata('ENOSPC');
  const hit = await observe(() => f.cache.get(f.key));
  assert.equal(hit.result, null); assert.equal(hit.error, primary); assert.equal(f.metadataFaults(), 0);
  assert.equal((await fs.readFile(f.object)).equals(payload), true);
  f.recover(); assert.equal((await f.cache.get(f.key)).data.equals(payload), true);
});

test('warning clones and episode logging preserve counters without flush pretending persistence', async (t) => {
  const f = await fixture(t); f.failMetadata('ENOSPC');
  const first = await f.cache.get(f.key); const warning = first.metadataPersistenceWarning;
  assert.equal(warning.code, 'CACHE_HIT_METADATA_WRITE_FAILED'); assert.equal(warning.causeCode, 'ENOSPC');
  const pristine = structuredClone(f.cache.stats().metadataPersistenceWarning);
  assert.deepEqual(warning, pristine);
  warning.message = 'caller mutation'; warning.recoveryErrors.push({ stage: 'caller', code: 'caller' });
  const stats = f.cache.stats(); stats.metadataPersistenceWarning.causeCode = 'caller';
  f.logs[0][1].message = 'logger mutation';
  assert.deepEqual(f.cache.stats().metadataPersistenceWarning, pristine);
  f.failMetadata('EACCES'); await f.cache.get(f.key);
  assert.equal(f.logs.length, 1); assert.equal(f.cache.stats().metadataPersistenceWarning.causeCode, 'EACCES');
  assert.equal(f.cache.stats().hits, 2);
  await f.cache.flush();
  assert.equal(f.cache.stats().metadataPersistenceWarning.causeCode, 'EACCES');
  assert.equal(JSON.parse(await fs.readFile(f.index, 'utf8'))[digest(f.key)].hits, 0);
  f.recover(); f.failRename('EIO'); await f.cache.get(f.key);
  assert.equal(f.cache.stats().metadataPersistenceWarning.causeCode, 'EIO'); assert.equal(f.logs.length, 1);
  f.recover(); await f.cache.put('another', Buffer.from('successful index commit'));
  assert.equal(f.cache.stats().metadataPersistenceWarning, undefined);
  assert.equal(JSON.parse(await fs.readFile(f.index, 'utf8'))[digest(f.key)].hits, 3);
  f.failMetadata('ENOSPC'); await f.cache.get(f.key); assert.equal(f.logs.length, 2);
  f.recover(); const successful = await f.cache.get(f.key);
  assert.equal(successful.metadataPersistenceWarning, undefined); assert.equal(f.cache.stats().metadataPersistenceWarning, undefined);
  assert.equal(JSON.parse(await fs.readFile(f.index, 'utf8'))[digest(f.key)].hits, 5);
  const reopened = new f.Cache(f.directory); await reopened.init();
  assert.equal(reopened.stats().metadataPersistenceWarning, undefined);
  assert.equal(reopened.entries[digest(f.key)].hits, 5);
  assert.equal(reopened.stats().hits, 5);
  assert.equal((await reopened.get(f.key)).data.equals(payload), true); await reopened.flush();
});

test('rename and cleanup warning retains only bounded codes/stages, never raw paths or payload', async (t) => {
  const f = await fixture(t); f.failRename('R'.repeat(200)); f.failCleanup('C'.repeat(200));
  const hit = await f.cache.get(f.key); const warning = hit.metadataPersistenceWarning;
  assert.equal(hit.data.equals(payload), true);
  assert.equal(warning.causeCode.length, 80);
  assert.equal(warning.message, 'Verified cached content is available, but access statistics could not be saved.');
  assert.ok(warning.recoveryErrors.length > 0 && warning.recoveryErrors.length <= 20);
  assert.ok(warning.recoveryErrorCount >= warning.recoveryErrors.length);
  for (const entry of warning.recoveryErrors) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'stage']);
    assert.ok(entry.stage.length <= 160); assert.ok(entry.code.length <= 80);
  }
  const serialized = JSON.stringify(warning);
  assert.equal(serialized.includes(f.directory), false); assert.equal(serialized.includes(payload.toString()), false);
  assert.equal(serialized.includes('Synthetic'), false);
  f.recover(); assert.equal((await f.cache.get(f.key)).data.equals(payload), true);
});

test('synchronous, rejected and held warning loggers cannot prevent verified-hit return', { timeout: 5000 }, async (t) => {
  const unhandled = []; const listener = (error) => unhandled.push(error); process.on('unhandledRejection', listener);
  try {
    for (const mode of ['throw', 'reject', 'held']) {
      let release; const held = new Promise((resolve) => { release = resolve; });
      const f = await fixture(t, { warn: () => {
        if (mode === 'throw') throw new Error('Synthetic logger throw');
        if (mode === 'reject') return Promise.reject(new Error('Synthetic logger rejection'));
        return held;
      } });
      f.failMetadata('ENOSPC'); let timer; const pending = f.cache.get(f.key);
      try {
        const result = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Hit waited for logger')), 1000); })]);
        assert.equal(result.data.equals(payload), true); assert.equal(f.logs.length, 1);
      } finally { clearTimeout(timer); release(); await pending; }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});
