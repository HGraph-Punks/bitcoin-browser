import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderManager } from '../src/main/provider-manager.js';
import { DiskCache } from '../src/main/cache.js';
import { StateStore } from '../src/main/state-store.js';
import { discoveryTarget } from '../src/shared/discovery.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function provider(id, options = {}) {
  const local = options.local ?? true;
  const type = options.type ?? (local ? 'mock' : 'ord-server');
  return {
    id,
    name: id,
    type,
    network: options.network ?? 'mainnet',
    baseUrl: type === 'mock' ? '' : (local ? 'http://127.0.0.1:1' : `https://${id}.invalid`),
    enabled: options.enabled ?? true,
    priority: options.priority ?? 10,
    local,
    capabilities: options.capabilities ?? ['inscription']
  };
}

async function fixture(t, providers, settings = {}, secureStore = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-inscription-discovery-'));
  const stateStore = new StateStore(path.join(directory, 'state'), null);
  const cache = new DiskCache(path.join(directory, 'cache'), { maxBytes: 1024 * 1024, maxEntryBytes: 1024 * 1024 }, null);
  let manager;
  t.after(async () => {
    try {
      await Promise.allSettled([manager?.shutdown(), cache.flush(), stateStore.flush()]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  await stateStore.init();
  await cache.init();
  await stateStore.mutate((draft) => {
    draft.providers = providers;
    draft.settings = { ...draft.settings, offlineMode: false, localOnly: false, network: 'mainnet', ...settings };
  });
  manager = new ProviderManager(stateStore, {
    get: () => null,
    transaction: secureStore.transaction ?? (async (_updates, persist) => persist()),
    deletePrefix: secureStore.deletePrefix ?? (async () => {})
  }, null, cache);
  return { directory, stateStore, cache, manager };
}

function installSyntheticResolvers(manager, calls) {
  for (const instance of manager.instances.values()) {
    instance.resolve = async (target, options) => {
      calls.push({ id: instance.id, target: structuredClone(target), signal: options.signal });
      return { kind: target.kind, canonical: target.canonical, providerId: instance.id, inscriptions: [`${instance.id}-one`] };
    };
  }
}

test('gallery routing honors selected network, local-only, disabled, capability, priority, and quarantine rules', async (t) => {
  const target = discoveryTarget('page=2&offset=24');
  const cases = [
    {
      settings: {}, expected: 'remote',
      providers: [provider('disabled', { enabled: false, priority: 0 }), provider('wrong-capability', { capabilities: ['block'], priority: 1 }),
        provider('remote', { local: false, priority: 2 }), provider('local', { priority: 3 }), provider('testnet', { network: 'testnet', priority: 0 })]
    },
    {
      settings: { localOnly: true }, expected: 'local',
      providers: [provider('remote', { local: false, priority: 1 }), provider('local', { priority: 2 })]
    },
    {
      settings: { network: 'testnet' }, expected: 'testnet',
      providers: [provider('mainnet', { priority: 1 }), provider('testnet', { network: 'testnet', priority: 2 })]
    }
  ];
  for (const item of cases) {
    const f = await fixture(t, item.providers, item.settings);
    const calls = [];
    installSyntheticResolvers(f.manager, calls);
    const result = await f.manager.resolve(target);
    assert.equal(result.entity.providerId, item.expected, JSON.stringify({ settings: f.stateStore.get(['settings']), candidates: f.manager.candidates('inscription').map(({ id }) => id) }));
    assert.deepEqual(calls.map(({ id }) => id), [item.expected]);
    assert.equal(calls[0].target.kind, 'inscriptions');
    assert.equal(calls[0].target.canonical, 'satnav://inscriptions?page=2&offset=24');
  }

  const gate = deferred();
  const entered = deferred();
  const f = await fixture(t, [provider('quarantined')], {}, {
    transaction: async (_updates, persist) => { entered.resolve(); await gate.promise; return persist(); }
  });
  t.after(() => gate.resolve());
  const editing = f.manager.upsert({ provider: { ...provider('quarantined'), name: 'edited' }, credentials: { password: 'synthetic' } });
  await entered.promise;
  assert.deepEqual(f.manager.candidates('inscription'), []);
  await assert.rejects(f.manager.resolve(target), { code: 'NO_PROVIDER' });
  gate.resolve();
  await editing;
  const calls = [];
  installSyntheticResolvers(f.manager, calls);
  assert.equal((await f.manager.resolve(target)).entity.providerId, 'quarantined');
});

test('online gallery resolution is served from the selected-network cache while offline without transport', async (t) => {
  const f = await fixture(t, [provider('gallery')]);
  const calls = [];
  installSyntheticResolvers(f.manager, calls);
  const target = discoveryTarget('block=840000');
  const online = await f.manager.resolve(target);
  assert.equal(online.entity.providerId, 'gallery');
  assert.equal(calls.length, 1);

  await f.stateStore.updateSettings({ offlineMode: true });
  f.manager.invalidateRouting();
  f.manager.instances.get('gallery').resolve = () => assert.fail('offline gallery hit must not invoke provider transport');
  const offline = await f.manager.resolve(target);
  assert.equal(offline.cache, 'hit');
  assert.deepEqual(offline.entity, online.entity);
  await assert.rejects(f.manager.resolve(discoveryTarget('block=840001')), { code: 'OFFLINE_CACHE_MISS' });
});

test('routing invalidation rejects gallery results during provider work and after a cached read', async (t) => {
  const f = await fixture(t, [provider('gallery')]);
  const providerGate = deferred();
  let providerSignal;
  f.manager.instances.get('gallery').resolve = async (_target, options) => {
    providerSignal = options.signal;
    await providerGate.promise;
    return { kind: 'inscriptions', canonical: 'satnav://inscriptions', inscriptions: [] };
  };
  const pendingProvider = f.manager.resolve(discoveryTarget());
  f.manager.invalidateRouting();
  assert.equal(providerSignal.aborted, true);
  providerGate.resolve();
  await assert.rejects(pendingProvider, { code: 'ROUTING_INVALIDATED' });

  installSyntheticResolvers(f.manager, []);
  const target = discoveryTarget('page=1');
  await f.manager.resolve(target);
  await f.stateStore.updateSettings({ offlineMode: true });
  f.manager.invalidateRouting();
  const originalGet = f.cache.get.bind(f.cache);
  const cacheGate = deferred();
  const cacheRead = deferred();
  f.cache.get = async (...args) => {
    const result = await originalGet(...args);
    cacheRead.resolve();
    await cacheGate.promise;
    return result;
  };
  const pendingCache = f.manager.resolve(target);
  await cacheRead.promise;
  f.manager.invalidateRouting();
  cacheGate.resolve();
  await assert.rejects(pendingCache, { code: 'ROUTING_INVALIDATED' });
});

test('shutdown aborts gallery work, rejects late admission, and drains the owned completion', async (t) => {
  const f = await fixture(t, [provider('gallery')]);
  const gate = deferred();
  const entered = deferred();
  let signal;
  f.manager.instances.get('gallery').resolve = async (_target, options) => {
    signal = options.signal;
    entered.resolve();
    await gate.promise;
    return { kind: 'inscriptions', canonical: 'satnav://inscriptions', inscriptions: [] };
  };
  t.after(() => gate.resolve());
  const resolving = f.manager.resolve(discoveryTarget());
  await entered.promise;
  let drained = false;
  const rawShutdown = f.manager.shutdown();
  assert.equal(f.manager.shutdown(), rawShutdown);
  const shutdown = rawShutdown.then(() => { drained = true; });
  assert.equal(signal.aborted, true);
  await assert.rejects(f.manager.resolve(discoveryTarget('page=1')), { code: 'APP_SHUTTING_DOWN' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  gate.resolve();
  await assert.rejects(resolving, { code: 'ROUTING_INVALIDATED' });
  await shutdown;
  assert.equal(drained, true);
  assert.equal(f.manager.activeOperations.size, 0);
});
