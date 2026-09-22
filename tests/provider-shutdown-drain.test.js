import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderManager } from '../src/main/provider-manager.js';
import { shutdownApplicationManagers } from '../src/main/local-service-manager.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const provider = (id) => ({
  id, name: id, type: 'mock', network: 'mainnet', baseUrl: '', enabled: true,
  priority: 10, local: true, capabilities: ['block', 'ord-recursion']
});

function fixture(ids = ['abort-aware', 'held'], options = {}) {
  const state = {
    settings: {
      network: 'mainnet', localOnly: false, offlineMode: false,
      preferredProviderId: null, requestTimeoutMs: 5_000, maxResourceBytes: 1024 * 1024
    },
    providers: ids.map(provider)
  };
  const store = {
    get: (parts) => structuredClone(state[parts[0]]),
    async upsertProvider(value) {
      const position = state.providers.findIndex(({ id }) => id === value.id);
      if (position < 0) state.providers.push(value); else state.providers[position] = value;
    },
    async removeProvider(id) { state.providers = state.providers.filter((value) => value.id !== id); },
    ...options.store
  };
  const secureStore = { loadStatus: 'primary', get: () => null, async transaction(_updates, persist) { return persist(); }, async deletePrefix() {}, ...options.secureStore };
  return new ProviderManager(store, secureStore, null);
}

async function turns(count = 3) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

test('healthAll and shutdown retain ownership until every admitted sibling settles', { timeout: 2_000 }, async (t) => {
  const manager = fixture();
  const entered = deferred();
  const held = deferred();
  let calls = 0;
  manager.instances.get('abort-aware').health = ({ signal }) => new Promise((_, reject) => {
    calls += 1;
    if (calls === 2) entered.resolve();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  manager.instances.get('held').health = async () => {
    calls += 1;
    if (calls === 2) entered.resolve();
    await held.promise;
    return { ok: true };
  };

  let healthSettled = false;
  const health = manager.healthAll().finally(() => { healthSettled = true; });
  await entered.promise;
  let shutdownSettled = false;
  const shutdown = Promise.resolve(manager.shutdown()).finally(() => { shutdownSettled = true; });
  t.after(async () => { held.resolve(); await Promise.allSettled([health, shutdown]); });
  await turns();

  assert.equal(healthSettled, false, 'outer health operation must retain its still-running sibling');
  assert.equal(shutdownSettled, false, 'shutdown must drain the admitted provider operation');
  held.resolve();
  await assert.rejects(health, { code: 'ROUTING_INVALIDATED' });
  await shutdown;
});

test('shutdown does not report completion while an abort-ignoring admitted operation remains active', { timeout: 2_000 }, async (t) => {
  const manager = fixture(['held']);
  const entered = deferred();
  const held = deferred();
  manager.instances.get('held').health = async () => {
    entered.resolve();
    await held.promise;
    return { ok: true };
  };
  const health = manager.healthAll();
  await entered.promise;
  let settled = false;
  const shutdown = Promise.resolve(manager.shutdown()).finally(() => { settled = true; });
  t.after(async () => { held.resolve(); await Promise.allSettled([health, shutdown]); });
  await turns();
  assert.equal(settled, false);
  held.resolve();
  await assert.rejects(health, { code: 'ROUTING_INVALIDATED' });
  await shutdown;
});

test('no-work shutdown is stable, resolves, and synchronously closes admission', async () => {
  const manager = fixture([]);
  const first = manager.shutdown();
  const second = manager.shutdown();
  assert.ok(first instanceof Promise);
  assert.equal(second, first);
  assert.throws(() => manager.captureRouting(), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.healthAll(), { code: 'APP_SHUTTING_DOWN' });
  await first;
});

test('shutdown drains simultaneous held resolve and fetchOrdPath work', { timeout: 2_000 }, async (t) => {
  const manager = fixture(['held']);
  const resolveGate = deferred();
  const fetchGate = deferred();
  const instance = manager.instances.get('held');
  instance.resolve = async () => resolveGate.promise;
  instance.fetchPath = async () => fetchGate.promise;
  const resolving = manager.resolve(parseNavigationInput('block:840000'));
  const fetching = manager.fetchOrdPath('/content/fixture');
  await turns();
  let drained = false;
  const shutdown = manager.shutdown().then(() => { drained = true; });
  t.after(async () => {
    resolveGate.resolve({ kind: 'block' });
    fetchGate.resolve({ data: Buffer.from('ok') });
    await Promise.allSettled([resolving, fetching, shutdown]);
  });
  await turns();
  assert.equal(drained, false);
  resolveGate.resolve({ kind: 'block' });
  await turns();
  assert.equal(drained, false, 'fetch remains owned after resolve transport completes');
  fetchGate.resolve({ data: Buffer.from('ok') });
  await assert.rejects(resolving, { code: 'ROUTING_INVALIDATED' });
  await assert.rejects(fetching, { code: 'ROUTING_INVALIDATED' });
  await shutdown;
});

test('shutdown drains admitted config-only and credential provider transactions', { timeout: 2_000 }, async (t) => {
  for (const credentials of [undefined, { username: 'fixture-user' }]) {
    const persisted = deferred();
    const manager = fixture([], {
      secureStore: { async transaction(_updates, save) { return save(); } }
    });
    const commit = manager.stateStore.upsertProvider.bind(manager.stateStore);
    manager.stateStore.upsertProvider = async (value) => { await persisted.promise; return commit(value); };
    const saving = manager.upsert({ provider: provider('new'), ...(credentials ? { credentials } : {}) });
    await turns();
    let drained = false;
    const shutdown = manager.shutdown().then(() => { drained = true; });
    t.after(async () => { persisted.resolve(); await Promise.allSettled([saving, shutdown]); });
    await turns();
    assert.equal(drained, false);
    persisted.resolve();
    assert.equal((await saving).id, 'new');
    await shutdown;
  }
});

test('shutdown drains rejected credential cleanup while remove retains its caller error', { timeout: 2_000 }, async (t) => {
  const cleanup = deferred();
  const cleanupError = new Error('fixture cleanup failed');
  const manager = fixture(['removed'], { secureStore: { has: (key) => key.startsWith('provider:removed:'), async deletePrefix() { await cleanup.promise; throw cleanupError; } } });
  const removing = manager.remove('removed');
  await turns();
  let drained = false;
  const shutdown = manager.shutdown().then(() => { drained = true; });
  t.after(async () => { cleanup.resolve(); await Promise.allSettled([removing, shutdown]); });
  await turns();
  assert.equal(drained, false);
  cleanup.resolve();
  await assert.rejects(removing, (error) => error.code === 'PROVIDER_CREDENTIAL_CLEANUP_FAILED' && error.cause === cleanupError);
  await shutdown;
});

test('shutdown rejects every late route even when persisted settings are offline', async () => {
  const manager = fixture([]);
  manager.stateStore.get = (parts) => parts[0] === 'settings'
    ? { network: 'mainnet', localOnly: false, offlineMode: true, preferredProviderId: null, requestTimeoutMs: 5_000, maxResourceBytes: 1024 }
    : [];
  await manager.shutdown();
  await assert.rejects(manager.resolve(parseNavigationInput('block:840000'), { network: 'testnet' }), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.fetchOrdPath('/content/fixture'), { code: 'APP_SHUTTING_DOWN' });
  await assert.rejects(manager.healthAll(), { code: 'APP_SHUTTING_DOWN' });
});

test('shutdown publishes its stable promise before synchronous abort-listener reentry', async (t) => {
  const manager = fixture(['reentrant']);
  let reentered;
  manager.instances.get('reentrant').health = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      reentered = manager.shutdown();
      reject(signal.reason);
    }, { once: true });
  });
  const health = manager.healthAll();
  await turns();
  const first = manager.shutdown();
  t.after(async () => { await Promise.allSettled([health, first]); });
  assert.equal(reentered, first);
  await assert.rejects(health, { code: 'ROUTING_INVALIDATED' });
  await first;
});

test('application shutdown does not begin persistence or logger work before provider drain', { timeout: 2_000 }, async (t) => {
  const manager = fixture(['held']);
  const entered = deferred();
  const held = deferred();
  manager.instances.get('held').health = async () => { entered.resolve(); await held.promise; return { ok: true }; };
  const health = manager.healthAll();
  await entered.promise;
  const calls = [];
  const cleanup = shutdownApplicationManagers({
    shutdownProvider: () => manager.shutdown(),
    persistenceTasks: [() => calls.push('persistence')],
    finalTasks: [() => calls.push('logger')]
  });
  t.after(async () => { held.resolve(); await Promise.allSettled([health, cleanup]); });
  await turns();
  assert.deepEqual(calls, []);
  held.resolve();
  await assert.rejects(health, { code: 'ROUTING_INVALIDATED' });
  await cleanup;
  assert.deepEqual(calls, ['persistence', 'logger']);
});
