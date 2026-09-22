import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { AppError, serializeError, toAppError } from '../src/shared/errors.js';
import { RecursiveResolver } from '../src/main/resolver.js';

const source = await fs.readFile(new URL('../src/main/cache.js', import.meta.url), 'utf8');
const body = source.replace(/^import .*;\n/gm, '').replace('export class DiskCache', 'class DiskCache');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const payload = Buffer.from('verified offline fixture');

async function fixture(t, key = 'key') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-operation-recovery-'));
  const object = path.join(directory, 'objects', digest(key));
  let failure = null; let injected = 0;
  const io = { ...fs, async readFile(file, ...args) {
    if (file === object && failure) { const error = failure; failure = null; injected++; throw error; }
    return fs.readFile(file, ...args);
  } };
  const Cache = vm.runInNewContext(`(() => { ${body}; return DiskCache; })()`, {
    fs: io, path, crypto, process: { pid: process.pid }, Buffer, structuredClone, AppError, serializeError, toAppError
  });
  const cache = new Cache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 });
  t.after(async () => { try { await cache.flush(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  await cache.init(); await cache.put(key, payload, { fixture: true });
  return { cache, Cache, directory, object, failRead: (error) => { failure = error; }, injected: () => injected };
}

test('transient EACCES/EIO reading verified cache bytes reports failure without deleting the offline payload', async (t) => {
  const observations = [];
  for (const code of ['EACCES', 'EIO']) {
    const f = await fixture(t); const primary = Object.assign(new Error(`Synthetic ${code} object read`), { code });
    f.failRead(primary); let error;
    try { await f.cache.get('key', { allowStale: true }); } catch (failure) { error = failure; }
    assert.equal(f.injected(), 1);
    let retained = false;
    try { retained = (await fs.readFile(f.object)).equals(payload); }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    const retry = await f.cache.get('key', { allowStale: true });
    const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'index.json'), 'utf8'));
    observations.push({ code, originalFailure: error === primary || error?.cause === primary,
      reportedCode: error?.code ?? null, retained, indexRetained: Boolean(persisted[digest('key')]), readableAfterRetry: retry?.data.equals(payload) ?? false });
  }
  assert.deepEqual(observations, ['EACCES', 'EIO'].map((code) => ({
    code, originalFailure: true, reportedCode: code, retained: true, indexRetained: true, readableAfterRetry: true
  })));
});

test('verified cache hit remains readable with original metadata and on reopen', async (t) => {
  const f = await fixture(t); const hit = await f.cache.get('key', { allowStale: true });
  assert.equal(hit.data.equals(payload), true); assert.deepEqual(hit.meta, { fixture: true });
  assert.equal(f.cache.stats().entries, 1);
  const reopened = new f.Cache(f.directory); await reopened.init();
  assert.equal((await reopened.get('key')).data.equals(payload), true); await reopened.flush();
});

test('genuine same-size digest corruption is evicted as a cache miss', async (t) => {
  const f = await fixture(t); await fs.writeFile(f.object, Buffer.alloc(payload.length, 0x78));
  assert.equal(await f.cache.get('key'), null); assert.equal(f.cache.stats().entries, 0);
  await assert.rejects(fs.stat(f.object), { code: 'ENOENT' });
  await f.cache.put('key', payload); assert.equal((await f.cache.get('key')).data.equals(payload), true);
});

test('missing canonical object becomes a miss and repairs its stale index entry', async (t) => {
  const f = await fixture(t); await fs.unlink(f.object);
  assert.equal(await f.cache.get('key'), null); assert.equal(f.cache.stats().entries, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'index.json'), 'utf8')), {});
  await f.cache.put('key', payload); assert.equal((await f.cache.get('key')).data.equals(payload), true);
});

test('actual offline resolver preserves transient read failure and serves retained bytes on explicit retry without transport', async (t) => {
  const resource = `/content/${'a'.repeat(64)}i0`;
  const key = `v2|mainnet|auto|*/*|${resource}`;
  const f = await fixture(t, key);
  const settings = { network: 'mainnet', preferredProviderId: null, offlineMode: true,
    maxConcurrentContentRequests: 2, cacheMaxBytes: 1024 * 1024, maxResourceBytes: 1024 };
  const routing = {}; let transportCalls = 0;
  const manager = {
    captureRouting: () => routing, assertRouting: (value) => assert.equal(value, routing),
    fetchOrdPath() { transportCalls++; throw new Error('Transport must not run in this offline fixture'); }
  };
  const store = { get: (segments) => segments.length === 2 ? settings[segments[1]] : structuredClone(settings) };
  const resolver = new RecursiveResolver(manager, f.cache, store);
  const primary = Object.assign(new Error('Synthetic offline cache read EACCES'), { code: 'EACCES' });
  f.failRead(primary); let initialError; let retryError; let retry;
  try { await resolver.resolve(resource); } catch (error) { initialError = error; }
  try { retry = await resolver.resolve(resource); } catch (error) { retryError = error; }
  assert.equal(transportCalls, 0);
  assert.deepEqual({ firstCode: initialError?.code, originalFailure: initialError === primary || initialError?.cause === primary,
    retryCode: retryError?.code ?? null, servedRetainedBytes: retry?.data.equals(payload) ?? false }, {
    firstCode: 'EACCES', originalFailure: true, retryCode: null, servedRetainedBytes: true
  });
});
