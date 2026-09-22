import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderManager } from '../src/main/provider-manager.js';
import { DiskCache } from '../src/main/cache.js';
import { AppError } from '../src/shared/errors.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

function storeWithProviders(providers) {
  const state = {
    settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null, requestTimeoutMs: 5000, maxResourceBytes: 1024 * 1024 },
    providers
  };
  return { get(pathSegments) { return structuredClone(state[pathSegments[0]]); } };
}

function mutableStoreWithProviders(providers) {
  let cleanups = [];
  const state = {
    settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null, requestTimeoutMs: 5000, maxResourceBytes: 1024 * 1024 },
    providers
  };
  return {
    get(pathSegments) { return structuredClone(state[pathSegments[0]]); },
    setOffline(value) { state.settings.offlineMode = value; },
    setLocalOnly(value) { state.settings.localOnly = value; },
    setNetwork(value) { state.settings.network = value; },
    setProviders(value) { state.providers = value; },
    getProviderCleanups: () => structuredClone(cleanups),
    async beginProviderCleanup(record, expectedGeneration) {
      assert.equal(state.providers.some(item => item.id === record.id), false);
      assert.equal(cleanups.find(item => item.id === record.id)?.generation ?? null, expectedGeneration);
      cleanups = [...cleanups.filter(item => item.id !== record.id), structuredClone(record)];
    },
    async completeProviderCleanup(id, generation) {
      assert.equal(cleanups.find(item => item.id === id)?.generation, generation);
      cleanups = cleanups.filter(item => item.id !== id);
    },
    async upsertProvider(provider) {
      const index = state.providers.findIndex((item) => item.id === provider.id);
      if (index >= 0) state.providers[index] = provider;
      else state.providers.push(provider);
    },
    async removeProvider(id, record) {
      state.providers = state.providers.filter((provider) => provider.id !== id);
      if (record) cleanups = [...cleanups.filter(item => item.id !== id), structuredClone(record)];
    }
  };
}

const mock = (id, priority = 10) => ({
  id, name: id, type: 'mock', network: 'mainnet', baseUrl: '', enabled: true, priority, local: true,
  capabilities: ['block', 'transaction', 'ord-recursion', 'inscription']
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

test('selects providers by capability, network, and priority', async () => {
  const manager = new ProviderManager(storeWithProviders([mock('later', 50), mock('first', 10)]), { get: () => null }, null);
  assert.deepEqual(manager.candidates('block').map((provider) => provider.id), ['first', 'later']);
  const resolution = await manager.resolve(parseNavigationInput('block:840000'));
  assert.equal(resolution.entity.source.id, 'first');
  assert.equal(resolution.attempts[0].ok, true);
});

test('provider shutdown aborts old work and rejects new routes and mutations', async () => {
  const manager = new ProviderManager(storeWithProviders([mock('fixture')]), { get: () => null }, null);
  const held = deferred();
  let signal;
  manager.instances.get('fixture').resolve = async (_target, options) => { signal = options.signal; return held.promise; };
  const active = manager.resolve(parseNavigationInput('block:840000'));
  manager.shutdown();
  assert.equal(signal.aborted, true);
  held.resolve({ kind: 'block' });
  await assert.rejects(active, { code: 'ROUTING_INVALIDATED' });
  assert.equal(manager.activeOperations.size, 0);
  assert.throws(() => manager.captureRouting(), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.resolve(parseNavigationInput('block:840001')), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.fetchOrdPath('/r/blockheight'), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.healthAll(), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.upsert(mock('new')), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.remove('fixture'), { code: 'APP_SHUTTING_DOWN' });
  assert.equal(manager.activeOperations.size, 0);
  manager.shutdown();
});

test('satpoint routing never attempts generic Mempool or Core output providers', async () => {
  const configs = ['mempool', 'bitcoin-core', 'ord-server'].map((type, index) => ({
    id: type, name: type, type, network: 'mainnet', baseUrl: 'http://127.0.0.1:1',
    enabled: true, local: true, priority: index, capabilities: ['output']
  }));
  const manager = new ProviderManager(storeWithProviders(configs), { get: () => null }, null);
  assert.deepEqual(manager.candidates('satpoint').map((provider) => provider.id), ['ord-server']);
  manager.instances.get('mempool').resolve = () => assert.fail('Mempool cannot resolve a satpoint');
  manager.instances.get('bitcoin-core').resolve = () => assert.fail('Core cannot resolve a satpoint');
  manager.instances.get('ord-server').resolve = async () => ({ type: 'satpoint', summary: { sat: '42' } });
  const result = await manager.resolve(parseNavigationInput(`satpoint:${'a'.repeat(64)}:0:42`), { preferredProviderId: 'mempool' });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].providerId, 'ord-server');
  const withoutOrd = new ProviderManager(storeWithProviders(configs.slice(0, 2)), { get: () => null }, null);
  await assert.rejects(withoutOrd.resolve(parseNavigationInput(`satpoint:${'a'.repeat(64)}:0:42`)), { code: 'NO_PROVIDER' });
});

test('health results are exposed through provider descriptors', async () => {
  const manager = new ProviderManager(storeWithProviders([mock('fixture')]), { get: () => null }, null);
  const health = await manager.healthAll();
  assert.equal(health[0].ok, true);
  assert.equal(manager.list()[0].health.ok, true);
});

test('serves previously resolved entities from cache while offline', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-entity-cache-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 * 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  const store = mutableStoreWithProviders([mock('fixture')]);
  const manager = new ProviderManager(store, { get: () => null }, null, cache);
  const target = parseNavigationInput('block:840000');
  const online = await manager.resolve(target);
  assert.equal(online.entity.source.id, 'fixture');
  store.setOffline(true);
  const offline = await manager.resolve(target);
  assert.equal(offline.cache, 'hit');
  assert.equal(offline.entity.canonical, target.canonical);
  await assert.rejects(manager.resolve(parseNavigationInput('block:840001')), { code: 'OFFLINE_CACHE_MISS' });
});

test('target-specific misses do not mark a provider globally unhealthy', async () => {
  const manager = new ProviderManager(storeWithProviders([mock('missing', 1), mock('fallback', 2)]), { get: () => null }, null);
  manager.instances.get('missing').resolve = async () => { throw new AppError('NOT_FOUND', 'Target not found', { status: 404 }); };
  const result = await manager.resolve(parseNavigationInput('block:840000'));
  assert.equal(result.entity.source.id, 'fallback');
  assert.equal(manager.list().find((provider) => provider.id === 'missing').health, null);
});

test('successful resolution clears stale provider error details', async () => {
  const manager = new ProviderManager(storeWithProviders([mock('fixture')]), { get: () => null }, null);
  manager.healthState.set('fixture', { ok: false, error: { code: 'PROVIDER_TIMEOUT' } });
  await manager.resolve(parseNavigationInput('block:840000'));
  assert.equal(manager.list()[0].health.ok, true);
  assert.equal(manager.list()[0].health.error, null);
});

test('passive health checks honor offline, network, and local-only settings', async () => {
  const remote = { ...mock('remote'), local: false };
  const testnet = { ...mock('testnet'), network: 'testnet' };
  const store = mutableStoreWithProviders([mock('local'), remote, testnet]);
  const manager = new ProviderManager(store, { get: () => null }, null);
  const checked = [];
  for (const provider of manager.instances.values()) {
    provider.health = async () => { checked.push(provider.id); return { ok: true }; };
  }

  store.setLocalOnly(true);
  assert.deepEqual((await manager.healthAll()).map((result) => result.providerId), ['local']);
  assert.deepEqual(checked, ['local']);

  store.setOffline(true);
  assert.deepEqual(await manager.healthAll(), []);
  assert.deepEqual(checked, ['local']);
});

test('fetchOrdPath does not contact providers while offline', async () => {
  const store = mutableStoreWithProviders([mock('fixture')]);
  store.setOffline(true);
  const manager = new ProviderManager(store, { get: () => null }, null);
  let contacted = false;
  manager.instances.get('fixture').fetchPath = async () => { contacted = true; };
  await assert.rejects(manager.fetchOrdPath('/content/example'), { code: 'OFFLINE_CACHE_MISS' });
  assert.equal(contacted, false);
});

test('caller cancellation stops resolution and ord failover', async () => {
  const manager = new ProviderManager(storeWithProviders([mock('first', 1), mock('second', 2)]), { get: () => null }, null);
  const controller = new AbortController();
  const reason = new AppError('REQUEST_ABORTED', 'cancelled', { status: 499 });
  let secondCalls = 0;
  manager.instances.get('first').resolve = async () => { controller.abort(reason); throw reason; };
  manager.instances.get('second').resolve = async () => { secondCalls += 1; };
  await assert.rejects(manager.resolve(parseNavigationInput('block:840000'), { signal: controller.signal }), reason);
  assert.equal(secondCalls, 0);

  const ordController = new AbortController();
  manager.instances.get('first').fetchPath = async () => { ordController.abort(reason); throw reason; };
  manager.instances.get('second').fetchPath = async () => { secondCalls += 1; };
  await assert.rejects(manager.fetchOrdPath('/content/example', { signal: ordController.signal }), reason);
  assert.equal(secondCalls, 0);
  assert.equal(manager.activeOperations.size, 0);
});

test('refresh discards health for changed and removed provider configurations', () => {
  const original = mock('fixture');
  const store = mutableStoreWithProviders([original, mock('removed')]);
  const manager = new ProviderManager(store, { get: () => null }, null);
  manager.healthState.set('fixture', { ok: true });
  manager.healthState.set('removed', { ok: true });

  store.setProviders([{ ...original, baseUrl: 'https://example.com' }]);
  manager.refresh();
  assert.equal(manager.healthState.has('fixture'), false);
  assert.equal(manager.healthState.has('removed'), false);
});

test('per-call routing cannot relax configured local-only mode', () => {
  const local = mock('local', 20);
  const remote = { ...mock('remote', 1), local: false };
  const store = mutableStoreWithProviders([remote, local]);
  store.setLocalOnly(true);
  const manager = new ProviderManager(store, { get: () => null }, null);

  assert.deepEqual(manager.candidates('block', { localOnly: false, preferredProviderId: 'remote' }).map((provider) => provider.id), ['local']);
});

test('per-call local-only routing may be stricter than configured settings', () => {
  const local = mock('local', 20);
  const remote = { ...mock('remote', 1), local: false };
  const manager = new ProviderManager(storeWithProviders([remote, local]), { get: () => null }, null);

  assert.deepEqual(manager.candidates('block', { localOnly: true }).map((provider) => provider.id), ['local']);
});

test('cross-network overrides are rejected before resolution or cache writes', async () => {
  const testnet = { ...mock('testnet'), network: 'testnet' };
  let resolveCalls = 0;
  let cacheWrites = 0;
  const cache = {
    put: async () => { cacheWrites += 1; }
  };
  const manager = new ProviderManager(storeWithProviders([testnet]), { get: () => null }, null, cache);
  manager.instances.get('testnet').resolve = async () => { resolveCalls += 1; return {}; };

  await assert.rejects(
    manager.resolve(parseNavigationInput('block:840000'), { network: 'testnet' }),
    { code: 'NETWORK_MISMATCH', status: 400 }
  );
  assert.equal(resolveCalls, 0);
  assert.equal(cacheWrites, 0);
});

test('cross-network overrides are rejected before offline cache reads', async () => {
  const store = mutableStoreWithProviders([mock('fixture')]);
  store.setOffline(true);
  let cacheReads = 0;
  const cache = {
    get: async () => {
      cacheReads += 1;
      return { data: Buffer.from(JSON.stringify({ network: 'mainnet' })), stale: false };
    }
  };
  const manager = new ProviderManager(store, { get: () => null }, null, cache);

  await assert.rejects(
    manager.resolve(parseNavigationInput('block:840000'), { network: 'testnet' }),
    { code: 'NETWORK_MISMATCH', status: 400 }
  );
  assert.equal(cacheReads, 0);
});

test('cross-network ord requests take precedence over offline cache misses', async () => {
  const store = mutableStoreWithProviders([mock('fixture')]);
  store.setOffline(true);
  const manager = new ProviderManager(store, { get: () => null }, null);

  await assert.rejects(
    manager.fetchOrdPath('/content/example', { network: 'testnet' }),
    { code: 'NETWORK_MISMATCH', status: 400 }
  );
});

test('routing invalidation aborts transport and suppresses ignored late success and cache writes', async () => {
  const store = mutableStoreWithProviders([mock('slow', 1), mock('fallback', 2)]);
  let cacheWrites = 0;
  const manager = new ProviderManager(store, { get: () => null }, null, { put: async () => { cacheWrites += 1; } });
  const late = deferred();
  let operationSignal;
  let fallbackCalls = 0;
  manager.instances.get('slow').resolve = async (_target, options) => {
    operationSignal = options.signal;
    return late.promise;
  };
  manager.instances.get('fallback').resolve = async () => { fallbackCalls += 1; return {}; };

  const pending = manager.resolve(parseNavigationInput('block:840000'));
  await Promise.resolve();
  store.setOffline(true);
  manager.invalidateRouting();
  assert.equal(operationSignal.aborted, true);
  late.resolve({ source: { id: 'slow' } });

  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED', status: 409 });
  assert.equal(fallbackCalls, 0);
  assert.equal(cacheWrites, 0);
  assert.equal(manager.healthState.has('slow'), false);
});

test('direct routing policy changes suppress failover under obsolete settings', async () => {
  const remoteFirst = { ...mock('remote-first', 1), local: false };
  const remoteFallback = { ...mock('remote-fallback', 2), local: false };
  const store = mutableStoreWithProviders([remoteFirst, remoteFallback]);
  const manager = new ProviderManager(store, { get: () => null }, null);
  const late = deferred();
  let fallbackCalls = 0;
  manager.instances.get('remote-first').resolve = async () => late.promise;
  manager.instances.get('remote-fallback').resolve = async () => { fallbackCalls += 1; return {}; };

  const pending = manager.resolve(parseNavigationInput('block:840000'));
  await Promise.resolve();
  store.setLocalOnly(true);
  late.reject(new AppError('PROVIDER_TIMEOUT', 'late failure', { status: 503 }));

  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.equal(fallbackCalls, 0);
  assert.equal(manager.healthState.has('remote-first'), false);
});

test('refresh aborts removed provider health and ignores late health publication', async () => {
  const store = mutableStoreWithProviders([mock('removed')]);
  const manager = new ProviderManager(store, { get: () => null }, null);
  const late = deferred();
  let healthSignal;
  manager.instances.get('removed').health = async (options) => {
    healthSignal = options.signal;
    return late.promise;
  };

  const pending = manager.healthAll();
  await Promise.resolve();
  store.setProviders([]);
  manager.refresh();
  assert.equal(healthSignal.aborted, true);
  late.resolve({ ok: true, checkedAt: 'late' });

  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.equal(manager.healthState.has('removed'), false);
});

test('refresh suppresses late health from an edited provider id', async () => {
  const original = mock('edited');
  const store = mutableStoreWithProviders([original]);
  const manager = new ProviderManager(store, { get: () => null }, null);
  const late = deferred();
  manager.instances.get('edited').health = async () => late.promise;

  const pending = manager.healthAll();
  await Promise.resolve();
  store.setProviders([{ ...original, baseUrl: 'https://new.example' }]);
  manager.refresh();
  late.resolve({ ok: true, checkedAt: 'late' });

  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.equal(manager.healthState.has('edited'), false);
});

test('real provider health adapters forward the manager cancellation signal', async () => {
  const configs = [
    { ...mock('ord'), type: 'ord-server', baseUrl: 'http://127.0.0.1:80' },
    { ...mock('mempool'), type: 'mempool', baseUrl: 'http://127.0.0.1:3000' },
    { ...mock('core'), type: 'bitcoin-core', baseUrl: 'http://127.0.0.1:8332' }
  ];
  const manager = new ProviderManager(storeWithProviders(configs), { get: () => null }, null);
  const signals = [];
  manager.instances.get('ord').fetchPath = async (_path, options) => {
    signals.push(options.signal);
    return { data: Buffer.from('840000'), latencyMs: 1 };
  };
  manager.instances.get('mempool').request = async (_path, options) => {
    signals.push(options.signal);
    return { data: Buffer.from('840000'), latencyMs: 1 };
  };
  manager.instances.get('core').rpc = async (_method, _params, options) => {
    signals.push(options.signal);
    return { result: { blocks: 840000, headers: 840000 }, latencyMs: 1 };
  };

  await manager.healthAll();
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal && signal === signals[0]));
});

test('offline cache reads cannot return entities after routing changes', async () => {
  const store = mutableStoreWithProviders([mock('fixture')]);
  store.setOffline(true);
  const lateGet = deferred();
  const manager = new ProviderManager(store, { get: () => null }, null, { get: async () => lateGet.promise });

  const pending = manager.resolve(parseNavigationInput('block:840000'));
  await Promise.resolve();
  store.setNetwork('testnet');
  manager.invalidateRouting();
  lateGet.resolve({ data: Buffer.from(JSON.stringify({ network: 'mainnet' })), stale: false });

  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.equal(manager.activeOperations.size, 0);
});

test('cache writes cannot complete an old-network resolution or publish health', async () => {
  const store = mutableStoreWithProviders([mock('fixture')]);
  const latePut = deferred();
  const manager = new ProviderManager(store, { get: () => null }, null, { put: async () => latePut.promise });

  const pending = manager.resolve(parseNavigationInput('block:840000'));
  while (!manager.activeOperations.size) await Promise.resolve();
  store.setNetwork('testnet');
  manager.invalidateRouting();
  latePut.resolve();

  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.equal(manager.healthState.has('fixture'), false);
  assert.equal(manager.activeOperations.size, 0);
});

test('routing changes during failure logging suppress obsolete fallback and aggregate errors', async () => {
  const store = mutableStoreWithProviders([mock('first', 1), mock('fallback', 2)]);
  const lateLog = deferred();
  const logger = { warn: async () => lateLog.promise };
  const manager = new ProviderManager(store, { get: () => null }, logger);
  let fallbackCalls = 0;
  manager.instances.get('first').resolve = async () => { throw new AppError('PROVIDER_TIMEOUT', 'failed', { status: 503 }); };
  manager.instances.get('fallback').resolve = async () => { fallbackCalls += 1; return {}; };

  const pending = manager.resolve(parseNavigationInput('block:840000'));
  await Promise.resolve();
  await Promise.resolve();
  store.setNetwork('testnet');
  manager.invalidateRouting();
  lateLog.resolve();

  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.equal(fallbackCalls, 0);
  assert.equal(manager.activeOperations.size, 0);
});

test('removed providers become unroutable before credential cleanup and cleanup can be retried', async () => {
  const store = mutableStoreWithProviders([mock('removed', 1), mock('fallback', 2)]);
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  let cleanupCalls = 0;
  const secureStore = {
    loadStatus: 'primary',
    get: () => null,
    has: (key) => key.startsWith('provider:removed:'),
    async transaction(_updates, callback) { return callback(); },
    deletePrefix: async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        throw new Error('credential cleanup failed');
      }
    }
  };
  const manager = new ProviderManager(store, secureStore, null);
  const removal = manager.remove('removed');
  await cleanupStarted.promise;

  assert.deepEqual(manager.list().map((provider) => provider.id), ['fallback']);
  const resolved = await manager.resolve(parseNavigationInput('block:840000'));
  assert.equal(resolved.entity.source.id, 'fallback');

  releaseCleanup.resolve();
  await assert.rejects(removal, { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED', details: { id: 'removed', providerRemoved: true } });
  const review = manager.reviewCleanup('removed');
  await manager.cleanup({ id: review.id, token: review.token });
  assert.equal(cleanupCalls, 2);
  assert.deepEqual(manager.list().map((provider) => provider.id), ['fallback']);
});

test('credential upsert blocks the affected provider and restores routing after state rollback', async () => {
  const state = {
    settings: { network: 'mainnet', localOnly: false, offlineMode: false, preferredProviderId: null, requestTimeoutMs: 5000, maxResourceBytes: 1024 * 1024 },
    providers: [mock('edited', 1), mock('fallback', 2)]
  };
  const transactionStarted = deferred();
  const releaseTransaction = deferred();
  const stateError = new AppError('STATE_WRITE_FAILED', 'state rejected');
  const secureStore = {
    get: () => null,
    async transaction(_updates, callback) {
      transactionStarted.resolve();
      await releaseTransaction.promise;
      await callback();
    }
  };
  const store = {
    get(pathSegments) { return structuredClone(state[pathSegments[0]]); },
    async upsertProvider() { throw stateError; }
  };
  const manager = new ProviderManager(store, secureStore, null);
  const pending = manager.upsert({ provider: { ...mock('edited'), name: 'new name' }, credentials: { username: 'new-user', password: 'new-password' } });
  await transactionStarted.promise;

  assert.deepEqual(manager.candidates('block').map((provider) => provider.id), ['fallback']);
  releaseTransaction.resolve();
  await assert.rejects(pending, stateError);
  assert.deepEqual(manager.candidates('block').map((provider) => provider.id), ['edited', 'fallback']);
  assert.equal(manager.list().find((provider) => provider.id === 'edited').name, 'edited');
});

test('credential rollback failure explicitly leaves the affected provider unroutable', async () => {
  const rollbackError = new AppError('SECURE_STORAGE_ROLLBACK_FAILED', 'rollback failed', { status: 500 });
  const secureStore = { get: () => null, transaction: async () => { throw rollbackError; } };
  const manager = new ProviderManager(storeWithProviders([mock('edited'), mock('fallback', 20)]), secureStore, null);

  await assert.rejects(
    manager.upsert({ provider: mock('edited'), credentials: { password: 'replacement' } }),
    { code: 'SECURE_STORAGE_ROLLBACK_FAILED', status: 500 }
  );
  assert.deepEqual(manager.candidates('block').map((provider) => provider.id), ['fallback']);
  const descriptor = manager.list().find((provider) => provider.id === 'edited');
  assert.equal(descriptor.routingBlocked, true);
  assert.equal(descriptor.routingError.code, 'SECURE_STORAGE_ROLLBACK_FAILED');
  assert.equal(descriptor.health.ok, false);
});

test('concurrent provider mutations reserve the id until the owner commits', async () => {
  const store = mutableStoreWithProviders([mock('edited')]);
  const transactionStarted = deferred();
  const releaseTransaction = deferred();
  const secureStore = {
    get: () => null,
    async transaction(_updates, callback) {
      transactionStarted.resolve();
      await releaseTransaction.promise;
      return callback();
    }
  };
  const manager = new ProviderManager(store, secureStore, null);
  const first = manager.upsert({ provider: { ...mock('edited'), name: 'first edit' }, credentials: { password: 'first' } });
  await transactionStarted.promise;

  await assert.rejects(
    manager.upsert({ provider: { ...mock('edited'), name: 'second edit' }, credentials: { password: 'second' } }),
    { code: 'PROVIDER_BUSY', status: 409, retryable: true }
  );
  await assert.rejects(manager.remove('edited'), { code: 'PROVIDER_BUSY', status: 409, retryable: true });
  assert.deepEqual(manager.candidates('block'), []);
  assert.equal(manager.list()[0].routingBlocked, true);

  releaseTransaction.resolve();
  const result = await first;
  assert.equal(result.name, 'first edit');
  assert.deepEqual(manager.candidates('block').map((provider) => provider.id), ['edited']);
});
