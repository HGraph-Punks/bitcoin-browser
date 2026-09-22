import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { AppError, serializeError, toAppError } from '../src/shared/errors.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { RecursiveResolver } from '../src/main/resolver.js';
import { buildDiagnostics } from '../src/main/diagnostics.js';

const cacheSource = (await fs.readFile(new URL('../src/main/cache.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export class DiskCache', 'class DiskCache');

const settings = Object.freeze({
  network: 'mainnet', localOnly: false, offlineMode: true, preferredProviderId: null,
  requestTimeoutMs: 1_000, maxResourceBytes: 64 * 1024, maxConcurrentContentRequests: 2,
  cacheMaxBytes: 1024 * 1024
});

function stateStore(providers = []) {
  return { get(parts) { return structuredClone(parts.length === 2 ? settings[parts[1]] : parts[0] === 'providers' ? providers : settings); } };
}

async function fixture(t, { key, data, meta = {}, ttl = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-hit-consumer-'));
  const indexFile = path.join(directory, 'index.json');
  const warnings = [];
  let metadataCode = null;
  let metadataFaults = 0;
  let onMetadataFault = null;
  const managers = [];
  const io = {
    ...fs,
    async open(file, ...args) {
      if (metadataCode && file.startsWith(`${indexFile}.`)) {
        metadataFaults += 1;
        onMetadataFault?.();
        throw Object.assign(new Error('Synthetic cache hit metadata failure'), { code: metadataCode });
      }
      return fs.open(file, ...args);
    }
  };
  const Cache = vm.runInNewContext(`(() => { ${cacheSource}; return DiskCache; })()`, {
    fs: io, path, crypto, process: { pid: process.pid }, Buffer, structuredClone, AppError, serializeError, toAppError
  });
  const cache = new Cache(directory, { maxBytes: settings.cacheMaxBytes, maxEntryBytes: settings.maxResourceBytes }, {
    warn: (...args) => warnings.push(args)
  });
  t.after(async () => {
    try {
      for (const manager of managers) await manager.shutdown();
    }
    finally {
      try { await cache.flush(); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  });
  await cache.init();
  if (key) await cache.put(key, data, meta, ttl);
  return {
    cache, directory, warnings,
    registerManager(manager) { managers.push(manager); return manager; },
    fail(code = 'ENOSPC', callback = null) { metadataCode = code; onMetadataFault = callback; },
    recover() { metadataCode = null; onMetadataFault = null; },
    metadataFaults: () => metadataFaults
  };
}

const target = { kind: 'block', value: '840000', canonical: 'block:840000' };
const entity = { schemaVersion: 1, type: 'block', id: '840000', canonical: target.canonical, network: 'mainnet',
  summary: { height: 840000 }, data: {}, links: [], source: { id: 'synthetic-cache' }, fetchedAt: '2026-01-01T00:00:00.000Z' };

test('actual ProviderManager serves an offline verified entity through hit-index ENOSPC without transport or health penalty', async (t) => {
  const key = `v1|entity|mainnet|${target.canonical}`;
  const f = await fixture(t, { key, data: Buffer.from(JSON.stringify(entity)), meta: { kind: 'entity' } });
  const provider = { id: 'offline-provider', name: 'Offline provider', type: 'mock', network: 'mainnet', baseUrl: '',
    enabled: true, priority: 1, local: true, capabilities: ['block'] };
  const manager = f.registerManager(new ProviderManager(stateStore([provider]), { get: () => null }, { warn() {} }, f.cache));
  manager.healthState.set(provider.id, { ok: true, lastSuccessAt: 'prior' });
  let transport = 0;
  manager.instances.get(provider.id).resolve = async () => { transport += 1; throw new Error('must not transport'); };
  f.fail();
  const result = await manager.resolve(target);
  assert.deepEqual(result.entity, entity);
  assert.equal(result.cache, 'hit');
  assert.equal(transport, 0);
  assert.deepEqual(manager.healthState.get(provider.id), { ok: true, lastSuccessAt: 'prior' });
  assert.equal(f.metadataFaults(), 1);
});

test('invalid cached JSON is never served when its verified-hit metadata write also fails', async (t) => {
  const key = `v1|entity|mainnet|${target.canonical}`;
  const f = await fixture(t, { key, data: Buffer.from('{invalid-json'), meta: { kind: 'entity' } });
  const manager = f.registerManager(new ProviderManager(stateStore([]), { get: () => null }, { warn() {} }, f.cache));
  f.fail();
  await assert.rejects(manager.resolve(target), (error) => error.code === 'ENOSPC');
  f.recover();
  await assert.rejects(manager.resolve(target), { code: 'OFFLINE_CACHE_MISS' });
  assert.equal(f.cache.stats().entries, 0);
});

test('routing invalidation during ProviderManager hit bookkeeping rejects instead of publishing obsolete cached entity', async (t) => {
  const key = `v1|entity|mainnet|${target.canonical}`;
  const f = await fixture(t, { key, data: Buffer.from(JSON.stringify(entity)) });
  const manager = f.registerManager(new ProviderManager(stateStore([]), { get: () => null }, { warn() {} }, f.cache));
  f.fail('ENOSPC', () => manager.invalidateRouting());
  await assert.rejects(manager.resolve(target), (error) => {
    assert.equal(error.code, 'ROUTING_INVALIDATED');
    assert.equal(error.status, 409);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(manager.activeOperations.size, 0);
});

test('routing invalidation during RecursiveResolver hit bookkeeping rejects without transport or obsolete bytes', async (t) => {
  const resource = `/content/${'a'.repeat(64)}i0`;
  const key = `v2|mainnet|auto|*/*|${resource}`;
  const payload = Buffer.from('synthetic recursive bytes');
  const f = await fixture(t, { key, data: payload, meta: { headers: { 'content-type': 'text/plain' }, provenance: {} } });
  let revision = 0;
  let transport = 0;
  const providerManager = {
    captureRouting: () => ({ revision }),
    assertRouting(snapshot) {
      if (snapshot.revision !== revision) throw new AppError('ROUTING_INVALIDATED', 'Synthetic invalidation', { status: 409, retryable: true });
    },
    async fetchOrdPath() { transport += 1; throw new Error('must not transport'); }
  };
  const resolver = new RecursiveResolver(providerManager, f.cache, stateStore());
  f.fail('ENOSPC', () => { revision += 1; });
  await assert.rejects(resolver.resolve(resource), { code: 'ROUTING_INVALIDATED', status: 409, retryable: true });
  assert.equal(transport, 0);
});

test('diagnostics retain bounded pathless hit-warning codes and a successful index write clears cache warning state', async (t) => {
  const key = 'diagnostic-key';
  const f = await fixture(t, { key, data: Buffer.from('diagnostic payload') });
  f.fail('ENOSPC');
  const hit = await f.cache.get(key);
  assert.equal(hit.metadataPersistenceWarning.causeCode, 'ENOSPC');
  const diagnostics = await buildDiagnostics({
    app: { getName: () => 'Bitcoin Browser', getVersion: () => 'test', isPackaged: false },
    stateStore: { snapshot: () => ({ wallet: { accounts: [] }, extensions: [], localServices: [] }) },
    providerManager: { list: () => [] }, cache: f.cache,
    localServiceManager: { list: () => [] }, secureStore: { availabilityStatus: () => null },
    logger: { recent: () => [] }
  });
  const encoded = JSON.stringify(diagnostics);
  assert.deepEqual(Object.keys(hit.metadataPersistenceWarning).sort(), [
    'causeCode', 'code', 'message', 'recoveryErrorCount', 'recoveryErrors'
  ]);
  assert.equal(diagnostics.cache.directory, '[redacted path]');
  assert.equal(diagnostics.cache.metadataPersistenceWarning.causeCode, 'ENOSPC');
  assert.equal(encoded.includes(f.directory), false);
  assert.equal(encoded.includes(key), false);
  assert.equal(encoded.includes('diagnostic payload'), false);
  f.recover();
  await f.cache.get(key);
  assert.equal(f.cache.stats().metadataPersistenceWarning, undefined);
});
