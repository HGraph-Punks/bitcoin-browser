import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { AppError, serializeError, toAppError } from '../src/shared/errors.js';
import { ProviderManager } from '../src/main/provider-manager.js';

const cacheSource = await fs.readFile(new URL('../src/main/cache.js', import.meta.url), 'utf8');
const cacheBody = cacheSource.replace(/^import .*;\n/gm, '').replace('export class DiskCache', 'class DiskCache');

function mock(id, priority) {
  return { id, name: id, type: 'mock', network: 'mainnet', baseUrl: '', enabled: true, priority, local: true,
    capabilities: ['block', 'transaction', 'ord-recursion', 'inscription'] };
}

function store(providers) {
  const state = { providers, settings: { network: 'mainnet', localOnly: false, offlineMode: false,
    preferredProviderId: null, requestTimeoutMs: 1_000, maxResourceBytes: 1_000_000 } };
  return { get(pathParts) { return structuredClone(state[pathParts[0]]); } };
}

async function cacheFixture(t, mode = 'native') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-provider-'));
  const indexFile = path.join(directory, 'index.json');
  const primary = mode === 'routing'
    ? new AppError('ROUTING_INVALIDATED', 'Synthetic routing invalidation', { status: 409, retryable: true })
    : Object.assign(new Error('Synthetic cache I/O failure'), { code: 'EIO' });
  const secondary = Object.assign(new Error('Synthetic rollback failure'), { code: 'EACCES' });
  let armed = false;
  let primaryUsed = false;
  let secondaryUsed = false;
  let validations = 0;
  let onObjectInstalled = null;
  const io = {
    ...fs,
    async open(file, flags, permissions) {
      const handle = await fs.open(file, flags, permissions);
      return {
        async writeFile(...args) {
          if (armed && primaryUsed && file.startsWith(`${indexFile}.`) && !secondaryUsed) {
            secondaryUsed = true;
            throw secondary;
          }
          return handle.writeFile(...args);
        },
        write: handle.write.bind(handle), sync: handle.sync.bind(handle), close: handle.close.bind(handle)
      };
    },
    async rename(from, to) {
      if (armed && mode === 'native' && to === indexFile && !primaryUsed) {
        primaryUsed = true;
        throw primary;
      }
      await fs.rename(from, to);
      if (armed && path.dirname(to) === path.join(directory, 'objects') && !to.endsWith('.previous')) onObjectInstalled?.();
    },
    async writeFile(file, ...args) {
      if (armed && primaryUsed && file.startsWith(`${indexFile}.`) && !secondaryUsed) {
        secondaryUsed = true;
        throw secondary;
      }
      return fs.writeFile(file, ...args);
    }
  };
  const Cache = vm.runInNewContext(`(() => { ${cacheBody}; return DiskCache; })()`, {
    fs: io, path, crypto, process: { pid: process.pid }, Buffer, structuredClone, AppError, serializeError, toAppError
  });
  const cache = new Cache(directory, { maxBytes: 1_000_000, maxEntryBytes: 100_000 });
  t.after(async () => {
    try { await cache.flush(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await cache.init();
  return {
    cache, primary, secondary,
    arm() { armed = true; },
    setObjectInstalled(callback) { onObjectInstalled = callback; },
    validate() { if (++validations === 3) { primaryUsed = true; throw primary; } },
    used() { return { primaryUsed, secondaryUsed }; }
  };
}

test('native cache failure with rollback error preserves primary classification without an invented status', async (t) => {
  const f = await cacheFixture(t);
  f.arm();
  await assert.rejects(f.cache.put('key', Buffer.from('bytes')), (error) => {
    assert.equal(error.code, 'EIO');
    assert.equal(error.status, undefined);
    assert.equal(error.retryable, undefined);
    assert.equal(error.cause, f.primary);
    assert.equal(error.details.recoveryErrors[0].code, 'EACCES');
    assert.equal(error.details.cacheRollback.restartRecoveryConfirmed, false);
    return true;
  });
  assert.deepEqual(f.used(), { primaryUsed: true, secondaryUsed: true });
});

test('AppError cache cancellation preserves code, status, retryability, and direct cause through rollback failure', async (t) => {
  const f = await cacheFixture(t, 'routing');
  f.arm();
  await assert.rejects(f.cache.put('key', Buffer.from('bytes'), {}, null, { validate: f.validate }), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'ROUTING_INVALIDATED');
    assert.equal(error.status, 409);
    assert.equal(error.retryable, true);
    assert.equal(error.cause, f.primary);
    assert.equal(error.details.recoveryErrors[0].code, 'EACCES');
    return true;
  });
});

test('provider fallback after native cache persistence failure does not mark the healthy source failed', async (t) => {
  const f = await cacheFixture(t);
  const warnings = [];
  const manager = new ProviderManager(store([mock('first', 1), mock('fallback', 2)]), { get: () => null }, { warn: (...args) => warnings.push(args) }, f.cache);
  t.after(() => manager.shutdown());
  manager.healthState.set('first', { ok: true, lastSuccessAt: 'synthetic-prior-success' });
  f.arm();
  const result = await manager.resolve({ kind: 'block', value: '840000', canonical: 'block:840000' });
  assert.equal(result.entity.source.id, 'fallback');
  assert.deepEqual(result.attempts.map(({ providerId, ok }) => ({ providerId, ok })), [
    { providerId: 'first', ok: false }, { providerId: 'fallback', ok: true }
  ]);
  assert.deepEqual(manager.healthState.get('first'), { ok: true, lastSuccessAt: 'synthetic-prior-success' });
  assert.equal(manager.healthState.get('fallback').ok, true);
  assert.equal(warnings.some(([event]) => event === 'provider.resolve_failed'), true);
});

test('routing invalidation during real cache publication stops failover and preserves provider health', async (t) => {
  const f = await cacheFixture(t, 'routing');
  const manager = new ProviderManager(store([mock('first', 1), mock('fallback', 2)]), { get: () => null }, { warn() {} }, f.cache);
  t.after(() => manager.shutdown());
  manager.healthState.set('first', { ok: true, lastSuccessAt: 'synthetic-prior-success' });
  let fallbackCalls = 0;
  manager.instances.get('fallback').resolve = async () => { fallbackCalls += 1; throw new Error('must not run'); };
  f.setObjectInstalled(() => manager.invalidateRouting());
  f.arm();
  await assert.rejects(manager.resolve({ kind: 'block', value: '840000', canonical: 'block:840000' }), (error) => {
    assert.equal(error.code, 'ROUTING_INVALIDATED');
    assert.equal(error.status, 409);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(manager.healthState.get('first'), { ok: true, lastSuccessAt: 'synthetic-prior-success' });
  assert.equal(manager.activeOperations.size, 0);
});
