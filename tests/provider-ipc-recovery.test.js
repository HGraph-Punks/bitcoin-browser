import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { APP_NAME, IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../src/shared/navigation.js';
import { assertString } from '../src/shared/validation.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { StateStore } from '../src/main/state-store.js';

const snapshotChannel = IPC.PROVIDERS_SNAPSHOT ?? 'providers:snapshot';
const ipcSource = (await fs.readFile(new URL('../src/main/ipc.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export function registerIpc', 'function registerIpc');

const provider = (id = 'provider-ipc-recovery') => ({
  id,
  name: 'Provider IPC recovery',
  type: 'mock',
  network: 'mainnet',
  baseUrl: '',
  priority: 10,
  enabled: true,
  local: true,
  capabilities: ['block']
});

function syntheticSecureStore() {
  let cleanupError = null;
  let cleanupCalls = 0;
  const entries = new Map();
  return {
    loadStatus: 'primary',
    availabilityStatus: () => true,
    get cleanupCalls() { return cleanupCalls; },
    has: (key) => entries.has(key),
    get: (key) => entries.get(key) ?? null,
    failCleanup(error) { cleanupError = error; },
    seed(key, value = 'synthetic-encrypted-value') { entries.set(key, value); },
    async transaction(updates, callback) {
      const previous = new Map(entries);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) entries.delete(key);
        else entries.set(key, String(value));
      }
      try { return await callback(); }
      catch (error) {
        entries.clear();
        for (const [key, value] of previous) entries.set(key, value);
        throw error;
      }
    },
    async deletePrefix(prefix) {
      cleanupCalls += 1;
      if (cleanupError) throw cleanupError;
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    }
  };
}

async function fixture(t, initialProviders = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-ipc-recovery-'));
  const stateStore = new StateStore(directory, null);
  await stateStore.init();
  await stateStore.mutate((draft) => {
    draft.providers = structuredClone(initialProviders);
    draft.settings.preferredProviderId = initialProviders[0]?.id ?? null;
  });
  const secureStore = syntheticSecureStore();
  const providerManager = new ProviderManager(stateStore, secureStore, null);
  const handlers = new Map();
  const registerIpc = vm.runInNewContext(`${ipcSource}\nregisterIpc`, {
    APP_NAME, IPC: { ...IPC, PROVIDERS_SNAPSHOT: snapshotChannel }, AppError, serializeError, INSCRIPTION_ID_RE,
    parseNavigationInput, assertString, Promise, URL, process, structuredClone,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: {}, shell: {}, fs: {}, path, inspectPsbt: () => ({}), buildDiagnostics: async () => ({}), writeDiagnostics: async () => {}
  });
  const lifecycle = registerIpc({
    app: { getName: () => 'Fixture', getVersion: () => '1', getPath: () => directory, isPackaged: false },
    getMainWindow: () => null,
    stateStore,
    secureStore,
    providerManager,
    resolver: { configure: async () => {}, resolve: async () => ({}), inspectGraph: async () => ({}) },
    cache: { directory, stats: () => ({}), clear: async () => {} },
    walletManager: { snapshot: () => ({}), discover: async () => {}, handleBridgeEvent: async () => {} },
    extensionManager: { list: () => [] },
    localServiceManager: { list: () => [] },
    dataDirectory: directory,
    logDirectory: directory,
    applyContentNetworkPolicy: async () => {}
  });
  const event = { senderFrame: { url: 'app://app/renderer/index.html' }, sender: { getURL: () => 'app://app/renderer/index.html' } };
  const invoke = async (channel, payload = {}, url = 'app://app/renderer/index.html') => {
    const handler = handlers.get(channel);
    assert.equal(typeof handler, 'function', `${channel} must be registered`);
    return handler({ senderFrame: { url }, sender: { getURL: () => url } }, payload);
  };
  t.after(async () => {
    await lifecycle.shutdown();
    await providerManager.shutdown();
    await stateStore.queue;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { stateStore, secureStore, providerManager, invoke, lifecycle };
}

function assertOutcome(value, { committed, operation, providerId, providersNullable = false, settingsNullable = false }) {
  assert.equal(value.providerMutationCommitted, committed);
  assert.equal(value.operation, operation);
  assert.equal(value.providerId, providerId);
  if (providersNullable) assert.equal(value.providers, null);
  else assert.ok(Array.isArray(value.providers));
  if (settingsNullable) assert.equal(value.settings, null);
  else assert.ok(value.settings !== null && typeof value.settings === 'object' && !Array.isArray(value.settings));
  assert.ok(Array.isArray(value.cleanups));
}

async function cleanupFixture(t) {
  const original = provider('explicit-cleanup');
  const f = await fixture(t, [original]);
  f.secureStore.seed(`provider:${original.id}:password`, 'synthetic-retained-password');
  f.secureStore.failCleanup(new AppError('SYNTHETIC_CLEANUP_FAILED', 'Synthetic cleanup failure'));
  const removed = await f.invoke(IPC.PROVIDERS_REMOVE, { id: original.id });
  assert.equal(removed.error.code, 'PROVIDER_CREDENTIAL_CLEANUP_FAILED');
  f.secureStore.failCleanup(null);
  const entry = removed.error.details.cleanups[0];
  assert.ok(entry.token);
  return { ...f, original, request: { id: entry.id, token: entry.token } };
}

test('bootstrap exposes removed-source cleanup separately without recreating its configuration', async t => {
  const f = await cleanupFixture(t);
  const result = await f.invoke(IPC.APP_BOOTSTRAP);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.providers, []);
  assert.equal(result.result.providerCleanup.cleanups[0].token, f.request.token);
  const reviewed = await f.invoke(IPC.PROVIDERS_CLEANUP_REVIEW, { id: f.request.id });
  assert.equal(reviewed.result.token, f.request.token);
  assert.equal(f.secureStore.has(`provider:${f.request.id}:password`), true);
});

test('dedicated cleanup IPC preserves identity and committed snapshot; replay cannot delete a replacement', async t => {
  const f = await cleanupFixture(t);
  const result = await f.invoke(IPC.PROVIDERS_CLEANUP, f.request);
  assert.equal(result.ok, true);
  assertOutcome(result.result, { committed: true, operation: 'cleanup', providerId: f.request.id });
  assert.equal(result.result.cleanups.length, 0);
  assert.equal(f.secureStore.has(`provider:${f.request.id}:password`), false);
  await f.providerManager.upsert({ provider: f.original, credentials: {} });
  const replay = await f.invoke(IPC.PROVIDERS_CLEANUP, f.request);
  assert.equal(replay.error.code, 'PROVIDER_CLEANUP_STALE');
  assertOutcome(replay.error.details, { committed: false, operation: 'cleanup', providerId: f.request.id });
  assert.equal(f.stateStore.get(['providers', 0, 'id']), f.request.id);
});

test('cleanup IPC partial failure publishes a durable obligation and new unconsumed review', async t => {
  const f = await cleanupFixture(t);
  f.secureStore.failCleanup(new AppError('SYNTHETIC_CLEANUP_FAILED', 'Synthetic repeated failure'));
  const response = await f.invoke(IPC.PROVIDERS_CLEANUP, f.request);
  assert.equal(response.error.code, 'PROVIDER_CREDENTIAL_CLEANUP_FAILED');
  assertOutcome(response.error.details, { committed: true, operation: 'cleanup', providerId: f.request.id });
  assert.equal(response.error.details.cleanupCompleted, false);
  assert.notEqual(response.error.details.cleanups[0].token, f.request.token);
  assert.equal(f.secureStore.has(`provider:${f.request.id}:password`), true);
});

test('cleanup read failure remains independent in bootstrap and provider snapshots without replay', async t => {
  const f = await cleanupFixture(t);
  const calls = f.secureStore.cleanupCalls;
  f.secureStore.loadStatus = 'unavailable';
  const snapshot = await f.invoke(IPC.PROVIDERS_SNAPSHOT);
  assert.equal(snapshot.ok, true); assert.equal(snapshot.result.cleanups, null);
  assert.equal(snapshot.result.stateReadErrors.cleanups.code, 'SECURE_STORAGE_STATE_UNAVAILABLE');
  assert.deepEqual(snapshot.result.providers, []);
  assert.equal(snapshot.result.settings.preferredProviderId, null);
  const bootstrap = await f.invoke(IPC.APP_BOOTSTRAP);
  assert.equal(bootstrap.ok, true); assert.equal(bootstrap.result.providerCleanup.cleanups, null);
  assert.equal(bootstrap.result.providerCleanup.stateReadErrors.cleanups.code, 'SECURE_STORAGE_STATE_UNAVAILABLE');
  assert.equal(f.secureStore.cleanupCalls, calls);
});

test('cleanup channels reject malformed or untrusted requests before deletion and preserve review authority', async t => {
  const f = await cleanupFixture(t); const before = f.secureStore.cleanupCalls;
  const untrusted = await f.invoke(IPC.PROVIDERS_CLEANUP, f.request, 'ord://content/');
  assert.equal(untrusted.error.code, 'UNTRUSTED_IPC_SENDER');
  const malformed = await f.invoke(IPC.PROVIDERS_CLEANUP_REVIEW, { id: f.request.id, injected: true });
  assert.equal(malformed.error.code, 'VALIDATION_ERROR');
  const invalid = await f.invoke(IPC.PROVIDERS_CLEANUP, { ...f.request, token: '' });
  assert.equal(invalid.error.code, 'VALIDATION_ERROR');
  assert.equal(invalid.error.details.providerMutationCommitted, false);
  assert.equal(f.secureStore.cleanupCalls, before);
  assert.equal((await f.invoke(IPC.PROVIDERS_CLEANUP, f.request)).ok, true);
});

test('IPC shutdown owns cleanup through final durable acknowledgement and response publication', async t => {
  const f = await cleanupFixture(t);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const complete = f.stateStore.completeProviderCleanup.bind(f.stateStore);
  f.stateStore.completeProviderCleanup = async (...args) => { entered(); await held; return complete(...args); };
  const action = f.invoke(IPC.PROVIDERS_CLEANUP, f.request); await started;
  let drained = false; const shutdown = f.lifecycle.shutdown().then(() => { drained = true; });
  try {
    await Promise.resolve(); assert.equal(drained, false);
    const late = await f.invoke(IPC.PROVIDERS_CLEANUP_REVIEW, { id: f.request.id });
    assert.equal(late.error.code, 'APP_SHUTTING_DOWN');
  } finally { release(); await Promise.allSettled([action, shutdown]); }
  assert.equal((await action).ok, true);
  assert.equal((await action).result.cleanups.length, 0);
});

test('committed removal cleanup failure reports authoritative providers and cleared preference', async (t) => {
  const original = provider('remove-recovery');
  const f = await fixture(t, [original]);
  f.secureStore.seed(`provider:${original.id}:password`);
  f.secureStore.failCleanup(new AppError('SYNTHETIC_CLEANUP_FAILED', 'Synthetic cleanup failed'));

  const response = await f.invoke(IPC.PROVIDERS_REMOVE, { id: original.id });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROVIDER_CREDENTIAL_CLEANUP_FAILED');
  assert.equal(response.error.details.id, original.id);
  assert.equal(response.error.details.providerRemoved, true);
  assertOutcome(response.error.details, { committed: true, operation: 'remove', providerId: original.id });
  assert.deepEqual(response.error.details.providers, []);
  assert.equal(response.error.details.settings.preferredProviderId, null);
  assert.deepEqual(f.stateStore.get(['providers']), []);
  assert.equal(f.stateStore.get(['settings', 'preferredProviderId']), null);
});

test('successful upsert returns the complete authoritative mutation outcome', async (t) => {
  const f = await fixture(t);
  const added = provider('upsert-outcome');

  const response = await f.invoke(IPC.PROVIDERS_UPSERT, { provider: added, credentials: {} });

  assert.equal(response.ok, true);
  assertOutcome(response.result, { committed: true, operation: 'upsert', providerId: added.id });
  assert.deepEqual(response.result.providers.map(({ id }) => id), [added.id]);
  assert.equal(response.result.settings.preferredProviderId, null);
});

async function recoveryFixture(t) {
  const original = provider('explicit-recovery');
  const f = await fixture(t, [original]);
  f.secureStore.seed(`provider:${original.id}:username`, 'synthetic-user');
  f.secureStore.seed(`provider:${original.id}:password`, 'synthetic-password');
  f.secureStore.seed(`provider-credential-state:${original.id}`, '{synthetic invalid metadata');
  const descriptor = f.providerManager.list()[0];
  return { ...f, request: { id: original.id, ...descriptor.credentialRecovery } };
}

test('explicit recovery IPC preserves configuration and preference and clears only reviewed stored authentication', async (t) => {
  const f = await recoveryFixture(t); const before = f.stateStore.get(['providers']);
  const response = await f.invoke(IPC.PROVIDERS_RECOVER, f.request);
  assert.equal(response.ok, true);
  assertOutcome(response.result, { committed: true, operation: 'recover', providerId: f.request.id });
  assert.deepEqual(f.stateStore.get(['providers']), before);
  assert.equal(response.result.settings.preferredProviderId, f.request.id);
  assert.equal(f.secureStore.has(`provider:${f.request.id}:password`), false);
  assert.equal(response.result.providers[0].routingBlocked, undefined);
});

test('stale recovery rejection includes an uncommitted authoritative snapshot', async (t) => {
  const f = await recoveryFixture(t);
  await f.stateStore.mutate((draft) => { draft.providers[0].name = 'Changed fixture'; });
  const response = await f.invoke(IPC.PROVIDERS_RECOVER, f.request);
  assert.equal(response.ok, false); assert.equal(response.error.code, 'PROVIDER_RECOVERY_STALE');
  assertOutcome(response.error.details, { committed: false, operation: 'recover', providerId: f.request.id });
  assert.equal(f.secureStore.has(`provider:${f.request.id}:password`), true);
  assert.notEqual(response.error.details.providers[0].credentialRecovery.token, f.request.token);
});

test('recovery finalization failure is committed but still visibly blocked in the IPC snapshot', async (t) => {
  const f = await recoveryFixture(t);
  f.secureStore.set = async () => { throw new AppError('SYNTHETIC_FINALIZATION_FAILED', 'Synthetic marker failure'); };
  const response = await f.invoke(IPC.PROVIDERS_RECOVER, f.request);
  assert.equal(response.ok, false); assert.equal(response.error.code, 'SYNTHETIC_FINALIZATION_FAILED');
  assertOutcome(response.error.details, { committed: true, operation: 'recover', providerId: f.request.id });
  assert.equal(response.error.details.providers[0].routingBlocked, true);
  assert.equal(response.error.details.providers[0].routingError.code, 'PROVIDER_CREDENTIAL_RECOVERY_REQUIRED');
});

test('committed recovery with failed readback requires only snapshot refresh, never recovery replay', async (t) => {
  const f = await recoveryFixture(t); let recoveries = 0;
  const originalRecover = f.providerManager.recover.bind(f.providerManager);
  const originalList = f.providerManager.list.bind(f.providerManager);
  f.providerManager.recover = async (...args) => { recoveries++; return originalRecover(...args); };
  f.providerManager.list = () => { throw new AppError('SYNTHETIC_READ_FAILED', 'Synthetic readback failure'); };
  const response = await f.invoke(IPC.PROVIDERS_RECOVER, f.request);
  assert.equal(response.ok, true);
  assertOutcome(response.result, { committed: true, operation: 'recover', providerId: f.request.id, providersNullable: true });
  f.providerManager.list = originalList;
  const refreshed = await f.invoke(IPC.PROVIDERS_SNAPSHOT);
  assert.equal(refreshed.result.providers[0].routingBlocked, undefined);
  assert.equal(recoveries, 1);
});

test('successful preferred-provider change returns the same mutation outcome contract', async (t) => {
  const original = provider('preferred-outcome');
  const f = await fixture(t, [original]);

  const response = await f.invoke(IPC.PROVIDERS_PREFERRED, { id: null });

  assert.equal(response.ok, true);
  assertOutcome(response.result, { committed: true, operation: 'preferred', providerId: null });
  assert.equal(response.result.settings.preferredProviderId, null);
  assert.deepEqual(response.result.providers.map(({ id }) => id), [original.id]);
});

test('read-only provider snapshot reports authoritative state without mutation', async (t) => {
  const original = provider('snapshot-outcome');
  const f = await fixture(t, [original]);
  const before = f.stateStore.snapshot();

  const response = await f.invoke(snapshotChannel);

  assert.equal(response.ok, true);
  assert.deepEqual(response.result.providers.map(({ id }) => id), [original.id]);
  assert.equal(response.result.settings.preferredProviderId, original.id);
  assert.deepEqual(f.stateStore.snapshot(), before);
});

test('post-commit preferred snapshot failure retains commit truth and original read error', async (t) => {
  const original = provider('preferred-read-failure');
  const f = await fixture(t, [original]);
  const realList = f.providerManager.list.bind(f.providerManager);
  f.providerManager.list = () => { throw new AppError('PROVIDER_LIST_READ_FAILED', 'Synthetic provider list failure', { status: 500 }); };

  const response = await f.invoke(IPC.PROVIDERS_PREFERRED, { id: null });

  assert.equal(response.ok, true);
  assertOutcome(response.result, { committed: true, operation: 'preferred', providerId: null, providersNullable: true });
  assert.equal(response.result.settings.preferredProviderId, null);
  assert.equal(response.result.stateReadErrors.providers.code, 'PROVIDER_LIST_READ_FAILED');
  assert.equal(f.stateStore.get(['settings', 'preferredProviderId']), null);
  f.providerManager.list = realList;
});

test('post-commit runtime refresh failure reconciles the descriptor snapshot without replaying persistence', async (t) => {
  const f = await fixture(t);
  const added = provider('refresh-recovery');
  const realUpsert = f.stateStore.upsertProvider.bind(f.stateStore);
  const realGet = f.stateStore.get.bind(f.stateStore);
  let persistenceCalls = 0;
  let failProviderRead = false;
  f.stateStore.upsertProvider = async (value) => {
    persistenceCalls += 1;
    const result = await realUpsert(value);
    failProviderRead = true;
    return result;
  };
  f.stateStore.get = (segments) => {
    if (failProviderRead && segments[0] === 'providers') {
      failProviderRead = false;
      throw new AppError('PROVIDER_RUNTIME_REFRESH_FAILED', 'Synthetic runtime refresh failed', { status: 500 });
    }
    return realGet(segments);
  };

  const response = await f.invoke(IPC.PROVIDERS_UPSERT, { provider: added, credentials: {} });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROVIDER_RUNTIME_REFRESH_FAILED');
  assertOutcome(response.error.details, { committed: true, operation: 'upsert', providerId: added.id });
  assert.deepEqual(response.error.details.providers.map(({ id }) => id), [added.id]);
  assert.equal(response.error.details.stateReadErrors, undefined);
  assert.equal(persistenceCalls, 1);
  const observed = await f.invoke(snapshotChannel);
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.result.providers.map(({ id }) => id), [added.id]);
  assert.equal(persistenceCalls, 1, 'observer-only recovery must not replay provider persistence');
});

test('post-commit descriptor failure is annotated and a healthy snapshot reconciles without replay', async (t) => {
  const f = await fixture(t);
  const added = provider('descriptor-recovery');
  const realUpsert = f.stateStore.upsertProvider.bind(f.stateStore);
  const realRefresh = f.providerManager.refresh.bind(f.providerManager);
  let writes = 0;
  let injectDescriptorFailure = true;
  f.stateStore.upsertProvider = async (value) => { writes += 1; return realUpsert(value); };
  f.providerManager.refresh = () => {
    realRefresh();
    if (!injectDescriptorFailure) return;
    injectDescriptorFailure = false;
    const instance = f.providerManager.instances.get(added.id);
    const realDescriptor = instance.descriptor.bind(instance);
    let failOnce = true;
    instance.descriptor = (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new AppError('PROVIDER_DESCRIPTOR_FAILED', 'Synthetic descriptor failed', { status: 500 });
      }
      return realDescriptor(...args);
    };
  };

  const response = await f.invoke(IPC.PROVIDERS_UPSERT, { provider: added, credentials: {} });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROVIDER_DESCRIPTOR_FAILED');
  assertOutcome(response.error.details, { committed: true, operation: 'upsert', providerId: added.id });
  assert.deepEqual(response.error.details.providers.map(({ id }) => id), [added.id]);
  assert.equal(writes, 1);
  assert.equal((await f.invoke(snapshotChannel)).ok, true);
  assert.equal(writes, 1);
});

test('committed removal performs credential cleanup before a failed refresh and snapshot recovery', async (t) => {
  const original = provider('remove-refresh-recovery');
  const f = await fixture(t, [original]);
  f.secureStore.seed(`provider:${original.id}:password`);
  const realGet = f.stateStore.get.bind(f.stateStore);
  const realRemove = f.stateStore.removeProvider.bind(f.stateStore);
  let removes = 0;
  let failProviderRead = false;
  f.stateStore.removeProvider = async (...args) => {
    removes += 1;
    await realRemove(...args);
    failProviderRead = true;
  };
  f.stateStore.get = (segments) => {
    if (failProviderRead && segments[0] === 'providers') {
      failProviderRead = false;
      throw new AppError('PROVIDER_REMOVE_REFRESH_FAILED', 'Synthetic removal refresh failed', { status: 500 });
    }
    return realGet(segments);
  };

  const response = await f.invoke(IPC.PROVIDERS_REMOVE, { id: original.id });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROVIDER_REMOVE_REFRESH_FAILED');
  assertOutcome(response.error.details, { committed: true, operation: 'remove', providerId: original.id });
  assert.deepEqual(response.error.details.providers, []);
  assert.equal(f.secureStore.cleanupCalls, 1);
  assert.equal(removes, 1);
  const observed = await f.invoke(snapshotChannel);
  assert.deepEqual(observed.result.providers, []);
  assert.equal(f.secureStore.cleanupCalls, 1, 'snapshot recovery must not replay credential cleanup');
  assert.equal(removes, 1);
});

test('uncommitted state failure remains primary when both authoritative reads fail', async (t) => {
  const f = await fixture(t);
  const primary = new AppError('STATE_WRITE_FAILED', 'Synthetic state write failed', { status: 507, retryable: true });
  const realGet = f.stateStore.get.bind(f.stateStore);
  let readsFail = false;
  f.stateStore.upsertProvider = async () => { readsFail = true; throw primary; };
  f.providerManager.list = () => {
    if (readsFail) throw new AppError('PROVIDER_LIST_READ_FAILED', 'Synthetic provider read failed');
    return [];
  };
  f.stateStore.get = (segments) => {
    if (readsFail && segments[0] === 'settings') throw new AppError('SETTINGS_READ_FAILED', 'Synthetic settings read failed');
    return realGet(segments);
  };

  const response = await f.invoke(IPC.PROVIDERS_UPSERT, { provider: provider('state-failure'), credentials: {} });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'STATE_WRITE_FAILED');
  assert.equal(response.error.status, 507);
  assert.equal(response.error.retryable, true);
  assert.equal(response.error.details.providerMutationCommitted, false);
  assert.equal(response.error.details.providers, null);
  assert.equal(response.error.details.settings, null);
  assert.equal(response.error.details.stateReadErrors.providers.code, 'PROVIDER_LIST_READ_FAILED');
  assert.equal(response.error.details.stateReadErrors.settings.code, 'SETTINGS_READ_FAILED');
  assert.deepEqual(f.stateStore.snapshot().providers, []);
});

for (const failed of [['providers'], ['settings'], ['providers', 'settings']]) {
  test(`provider snapshot exposes ${failed.join(' and ')} read failure without fabricated state`, async (t) => {
    const original = provider(`snapshot-${failed.join('-')}`);
    const f = await fixture(t, [original]);
    const realGet = f.stateStore.get.bind(f.stateStore);
    const realList = f.providerManager.list.bind(f.providerManager);
    let listCalls = 0;
    f.providerManager.list = () => {
      listCalls += 1;
      if (failed.includes('providers')) throw new AppError('PROVIDER_LIST_READ_FAILED', 'Synthetic provider read failed');
      return realList();
    };
    f.stateStore.get = (segments) => {
      if (failed.includes('settings') && segments[0] === 'settings') throw new AppError('SETTINGS_READ_FAILED', 'Synthetic settings read failed');
      return realGet(segments);
    };
    const before = f.stateStore.snapshot();

    const response = await f.invoke(snapshotChannel, { malformedIgnoredInput: { nested: true } });

    assert.equal(response.ok, true);
    assert.equal(response.result.providers, failed.includes('providers') ? null : response.result.providers);
    if (failed.includes('providers')) assert.equal(response.result.stateReadErrors.providers.code, 'PROVIDER_LIST_READ_FAILED');
    else assert.deepEqual(response.result.providers.map(({ id }) => id), [original.id]);
    if (failed.includes('settings')) {
      assert.equal(response.result.settings, null);
      assert.equal(response.result.stateReadErrors.settings.code, 'SETTINGS_READ_FAILED');
    } else assert.equal(response.result.settings.preferredProviderId, original.id);
    assert.equal(listCalls, 1);
    assert.deepEqual(f.stateStore.snapshot(), before);
  });
}

test('snapshot is observer-only and never replays a completed mutation', async (t) => {
  const f = await fixture(t);
  const realUpsert = f.stateStore.upsertProvider.bind(f.stateStore);
  let writes = 0;
  f.stateStore.upsertProvider = async (value) => { writes += 1; return realUpsert(value); };
  const added = provider('snapshot-no-replay');
  assert.equal((await f.invoke(IPC.PROVIDERS_UPSERT, { provider: added, credentials: {} })).ok, true);

  const first = await f.invoke(snapshotChannel);
  const second = await f.invoke(snapshotChannel);

  assert.deepEqual(first.result, second.result);
  assert.equal(writes, 1);
});

test('snapshot rejects untrusted and post-shutdown admission without reading state', async (t) => {
  const f = await fixture(t, [provider('snapshot-admission')]);
  let reads = 0;
  const realList = f.providerManager.list.bind(f.providerManager);
  f.providerManager.list = () => { reads += 1; return realList(); };

  const untrusted = await f.invoke(snapshotChannel, {}, 'ord://content/r/blockheight');
  assert.equal(untrusted.error.code, 'UNTRUSTED_IPC_SENDER');
  assert.equal(reads, 0);
  await f.lifecycle.shutdown();
  const late = await f.invoke(snapshotChannel);
  assert.equal(late.error.code, 'APP_SHUTTING_DOWN');
  assert.equal(reads, 0);
});

test('IPC shutdown drains an admitted held provider mutation and its snapshot', async (t) => {
  const f = await fixture(t);
  const realUpsert = f.stateStore.upsertProvider.bind(f.stateStore);
  let release;
  let entered;
  const admitted = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  f.stateStore.upsertProvider = async (value) => {
    entered();
    await held;
    return realUpsert(value);
  };
  const added = provider('shutdown-drain');
  const mutation = f.invoke(IPC.PROVIDERS_UPSERT, { provider: added, credentials: {} });
  await admitted;
  let drained = false;
  const shutdown = f.lifecycle.shutdown().then(() => { drained = true; });
  try {
    await Promise.resolve();
    assert.equal(drained, false);
    const late = await f.invoke(snapshotChannel);
    assert.equal(late.error.code, 'APP_SHUTTING_DOWN');
  } finally {
    release();
    await Promise.allSettled([mutation, shutdown]);
  }
  const response = await mutation;
  assert.equal(response.ok, true);
  assert.deepEqual(response.result.providers.map(({ id }) => id), [added.id]);
  await shutdown;
  assert.equal(drained, true);
});

test('preferred update post-persistence read failure remains committed with authoritative recovery', async (t) => {
  const original = provider('preferred-post-read');
  const f = await fixture(t, [original]);
  const realMutate = f.stateStore.mutate.bind(f.stateStore);
  const realGet = f.stateStore.get.bind(f.stateStore);
  let failNextSettingsRead = false;
  f.stateStore.mutate = async (mutator) => {
    const result = await realMutate(mutator);
    failNextSettingsRead = true;
    return result;
  };
  f.stateStore.get = (segments) => {
    if (failNextSettingsRead && segments[0] === 'settings') {
      failNextSettingsRead = false;
      throw new AppError('SETTINGS_POST_COMMIT_READ_FAILED', 'Synthetic committed settings read failed', { status: 500 });
    }
    return realGet(segments);
  };

  const response = await f.invoke(IPC.PROVIDERS_PREFERRED, { id: null });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SETTINGS_POST_COMMIT_READ_FAILED');
  assertOutcome(response.error.details, { committed: true, operation: 'preferred', providerId: null });
  assert.equal(response.error.details.settings.preferredProviderId, null);
  assert.deepEqual(response.error.details.providers.map(({ id }) => id), [original.id]);
  assert.equal(f.stateStore.snapshot().settings.preferredProviderId, null);
});

test('preferred update pre-commit rejection remains uncommitted and preserves preference', async (t) => {
  const original = provider('preferred-precommit');
  const f = await fixture(t, [original]);
  f.stateStore.mutate = async () => {
    throw new AppError('STATE_WRITE_REJECTED', 'Synthetic pre-commit rejection', { status: 507, retryable: true });
  };

  const response = await f.invoke(IPC.PROVIDERS_PREFERRED, { id: null });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'STATE_WRITE_REJECTED');
  assertOutcome(response.error.details, { committed: false, operation: 'preferred', providerId: null });
  assert.equal(response.error.details.settings.preferredProviderId, original.id);
  assert.deepEqual(response.error.details.providers.map(({ id }) => id), [original.id]);
  assert.equal(f.stateStore.snapshot().settings.preferredProviderId, original.id);
});

test('empty and malformed provider identifiers return validation envelopes without mutation', async (t) => {
  const original = provider('validation-control');
  const f = await fixture(t, [original]);
  const before = f.stateStore.snapshot();
  const cases = [
    [IPC.PROVIDERS_UPSERT, { provider: { ...original, id: '' } }],
    [IPC.PROVIDERS_UPSERT, { provider: { ...original, id: null } }],
    [IPC.PROVIDERS_REMOVE, { id: '   ' }],
    [IPC.PROVIDERS_REMOVE, { id: { nested: true } }],
    [IPC.PROVIDERS_PREFERRED, {}],
    [IPC.PROVIDERS_PREFERRED, { id: '  ' }]
  ];
  for (const [channel, payload] of cases) {
    const response = await f.invoke(channel, payload);
    assert.equal(response.ok, false, channel);
    assert.equal(response.error.code, 'VALIDATION_ERROR', channel);
    assert.equal(response.error.status, 400, channel);
  }
  assert.deepEqual(f.stateStore.snapshot(), before);
});

test('StateStore settings commit callback runs exactly once and never before validation or persistence success', async (t) => {
  const f = await fixture(t);
  let committed = 0;
  const result = await f.stateStore.updateSettings({ theme: 'dark' }, () => { committed += 1; });
  assert.equal(committed, 1);
  assert.equal(result.theme, 'dark');

  await assert.rejects(f.stateStore.updateSettings({ theme: 'invalid-theme' }, () => { committed += 1; }), { code: 'VALIDATION_ERROR' });
  assert.equal(committed, 1);

  const realMutate = f.stateStore.mutate.bind(f.stateStore);
  f.stateStore.mutate = async () => { throw new AppError('STATE_WRITE_REJECTED', 'Synthetic persistence rejection'); };
  await assert.rejects(f.stateStore.updateSettings({ theme: 'light' }, () => { committed += 1; }), { code: 'STATE_WRITE_REJECTED' });
  assert.equal(committed, 1);
  f.stateStore.mutate = realMutate;
});

test('preferred second routing invalidation failure is reported as committed', async (t) => {
  const original = provider('preferred-invalidation');
  const f = await fixture(t, [original]);
  const realInvalidate = f.providerManager.invalidateRouting.bind(f.providerManager);
  let invalidations = 0;
  f.providerManager.invalidateRouting = () => {
    invalidations += 1;
    if (invalidations === 2) throw new AppError('ROUTING_PUBLICATION_FAILED', 'Synthetic second invalidation failed', { status: 500 });
    return realInvalidate();
  };

  const response = await f.invoke(IPC.PROVIDERS_PREFERRED, { id: null });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ROUTING_PUBLICATION_FAILED');
  assertOutcome(response.error.details, { committed: true, operation: 'preferred', providerId: null });
  assert.equal(response.error.details.settings.preferredProviderId, null);
  assert.equal(f.stateStore.snapshot().settings.preferredProviderId, null);
  assert.equal(invalidations, 2);
});

test('persistent refresh failure blocks stale routing and later healthy snapshots do not churn routing', async (t) => {
  const original = provider('persistent-old');
  const replacement = provider('persistent-new');
  const f = await fixture(t, [original]);
  const realGet = f.stateStore.get.bind(f.stateStore);
  const realUpsert = f.stateStore.upsertProvider.bind(f.stateStore);
  let failProviderReads = false;
  let writes = 0;
  f.stateStore.upsertProvider = async (value) => {
    writes += 1;
    await realUpsert(value);
    failProviderReads = true;
  };
  f.stateStore.get = (segments) => {
    if (failProviderReads && segments[0] === 'providers') {
      throw new AppError('PERSISTENT_PROVIDER_READ_FAILED', 'Synthetic persistent provider read failed', { status: 500 });
    }
    return realGet(segments);
  };

  const mutation = await f.invoke(IPC.PROVIDERS_UPSERT, { provider: replacement, credentials: {} });
  assert.equal(mutation.ok, false);
  assert.equal(mutation.error.details.providerMutationCommitted, true);
  assert.equal(mutation.error.details.providers, null);
  assert.equal(mutation.error.details.stateReadErrors.providers.code, 'PERSISTENT_PROVIDER_READ_FAILED');
  assert.throws(() => f.providerManager.candidates('block'), { code: 'PERSISTENT_PROVIDER_READ_FAILED' });
  assert.equal(writes, 1);

  failProviderReads = false;
  const recovered = await f.invoke(snapshotChannel);
  assert.deepEqual(recovered.result.providers.map(({ id }) => id).sort(), [replacement.id, original.id]);
  const revision = f.providerManager.routingGeneration;
  const healthy = await f.invoke(snapshotChannel);
  assert.deepEqual(healthy.result, recovered.result);
  assert.equal(f.providerManager.routingGeneration, revision);
  assert.equal(writes, 1);
});
