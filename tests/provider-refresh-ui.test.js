import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function refreshProviders(');
const end = source.indexOf('\nfunction modalHeader(', begin);
const settingsBegin = source.indexOf('async function updateSettings(partial) {');
const settingsEnd = source.indexOf('\nfunction reloadResolvableTarget()', settingsBegin);
const queueBegin = source.indexOf('function queueAuthorityMutation(task) {');
const queueEnd = source.indexOf('\nfunction activeTab()', queueBegin);
const mutationBegin = source.indexOf('function refreshProviderMutationView() {');
const mutationEnd = source.indexOf('\nfunction openProviderModal(', mutationBegin);
assert.ok(begin >= 0 && end > begin);
assert.ok(settingsBegin >= 0 && settingsEnd > settingsBegin);
assert.ok(queueBegin >= 0 && queueEnd > queueBegin);
assert.ok(mutationBegin >= 0 && mutationEnd > mutationBegin);

function descriptor(value) {
  return { name: value.id, type: 'mock', network: 'mainnet', enabled: true, capabilities: ['block'], ...value };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function fixture() {
  const model = { settings: { network: 'mainnet', preferredProviderId: null }, providers: [] };
  const health = [];
  const lists = [];
  const preferred = [];
  const settingsUpdates = [];
  const toasts = [];
  const patches = [];
  const viewUpdates = [];
  let reloads = 0;
  const context = {
    state: () => model,
    routeName: () => 'providers',
    patch(update, options) { Object.assign(model, update); patches.push({ update, options }); },
    toast: (...args) => toasts.push(args),
    elements: { page: {} },
    updateProviderHealthViews: (_page, providers) => viewUpdates.push(providers),
    api: {
      providers: {
        health() { const request = deferred(); health.push(request); return request.promise; },
        list() { const request = deferred(); lists.push(request); return request.promise; },
        preferred(id) {
          const pending = deferred();
          const envelope = (value, committed) => ({
            providerMutationCommitted: committed, operation: 'preferred', providerId: id,
            settings: value.settings, providers: value.providers.map(descriptor), cleanups: []
          });
          const request = { id, promise: pending.promise,
            resolve: (value) => pending.resolve(envelope(value, true)),
            reject: (error) => pending.reject(Object.assign(error, {
              details: envelope({ settings: model.settings, providers: model.providers }, false)
            }))
          };
          preferred.push(request); return request.promise;
        }
      },
      settings: { update(partial) { const request = { partial, ...deferred() }; settingsUpdates.push(request); return request.promise; } }
    },
    reloadResolvableTarget() { reloads += 1; },
    applyTheme() {},
    renderPage() {}
  };
  const actions = vm.runInNewContext(`(() => { let providerRefreshSequence = 0; let authorityMutationTail = Promise.resolve(); let authorityMutationSequence = 0; let routingMaintenanceVersion = 0; let completedRoutingMaintenanceVersion = 0;
    const pendingProviderMutations = new Map(), providerCleanupRecovery = new Map();
    let providerOutcomeRecovery = null, providerSnapshotPending = false;
    ${source.slice(queueBegin, queueEnd)} ${source.slice(begin, end)} ${source.slice(mutationBegin, mutationEnd)} ${source.slice(settingsBegin, settingsEnd)}; return { refreshProviders, refreshProviderStatus, setPreferred, updateSettings }; })()`, context);
  return {
    model, health, lists, preferred, settingsUpdates, toasts, patches, viewUpdates, context, get reloads() { return reloads; }, ...actions
  };
}

test('background publication replaces stale startup auth status without running a new health request or repainting controls', async () => {
  const f = fixture();
  f.model.providers = [descriptor({ id: 'guided-core-mainnet', health: { ok: false, error: { code: 'PROVIDER_AUTH_ERROR' } } })];
  const fresh = { ...f.model.providers[0], health: { ok: true, initialBlockDownload: true, verificationProgress: 0.9 } };
  const pending = f.refreshProviderStatus(); f.lists[0].resolve([fresh]); await pending;
  assert.equal(f.model.providers[0].health.ok, true);
  assert.equal(f.health.length, 0); assert.equal(f.toasts.length, 0); assert.equal(f.viewUpdates.length, 1);
  assert.equal(f.patches[0].options.page, false); assert.equal(f.patches[0].options.developer, false);
});

test('background status never changes configuration or replaces sign-in recovery', async () => {
  for (const change of [{ baseUrl: 'http://127.0.0.1:9999' }, { enabled: false }, { routingBlocked: true }, { network: 'signet' }]) {
    const f = fixture(); const original = descriptor({ id: 'node', health: { ok: false } }); f.model.providers = [original];
    const pending = f.refreshProviderStatus(); f.lists[0].resolve([{ ...original, ...change, health: { ok: true } }]); await pending;
    assert.equal(f.model.providers[0], original); assert.equal(f.patches.length, 0);
  }
});

test('manual health checks invalidate an older passive snapshot', async () => {
  const f = fixture(); const original = descriptor({ id: 'node', health: { ok: false } }); f.model.providers = [original];
  const passive = f.refreshProviderStatus(); const manual = f.refreshProviders();
  f.lists[0].resolve([{ ...original, health: { ok: true } }]); await passive;
  assert.equal(f.patches.length, 0);
  await advanceToList(f.health[0]); f.lists[1].resolve([{ ...original, health: { ok: true } }]); await manual;
  assert.equal(f.patches.length, 1); assert.equal(f.viewUpdates.length, 0);
});

test('unchanged background status causes no UI mutations', async () => {
  const f = fixture(); f.model.providers = [descriptor({ id: 'node', health: { ok: true } })];
  const pending = f.refreshProviderStatus(); f.lists[0].resolve(structuredClone(f.model.providers)); await pending;
  assert.equal(f.patches.length, 0); assert.equal(f.viewUpdates.length, 0);
});

async function advanceToList(health) {
  health.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test('an older provider refresh cannot overwrite a newer completed refresh', async () => {
  const fixtureState = fixture();
  const older = fixtureState.refreshProviders();
  await advanceToList(fixtureState.health[0]);
  assert.equal(fixtureState.lists.length, 1);

  const newer = fixtureState.refreshProviders();
  await advanceToList(fixtureState.health[1]);
  const current = [{ id: 'current', enabled: true, network: 'mainnet', health: { ok: true } }];
  fixtureState.lists[1].resolve(current);
  await newer;
  assert.deepEqual(fixtureState.model.providers, current);

  fixtureState.lists[0].resolve([{ id: 'obsolete', enabled: true, network: 'mainnet', health: { ok: false } }]);
  await older;
  assert.deepEqual(fixtureState.model.providers, current);
  assert.equal(fixtureState.patches.length, 1);
  assert.equal(fixtureState.toasts.filter(([title]) => title === 'Source check complete').length, 1);
  assert.match(fixtureState.toasts.at(-1)[1], /^1 healthy source on mainnet\.$/);
});

test('an obsolete provider refresh failure cannot replace newer success feedback', async () => {
  const fixtureState = fixture();
  const older = fixtureState.refreshProviders();
  const newer = fixtureState.refreshProviders();

  fixtureState.health[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const current = [{ id: 'current', enabled: false, network: 'mainnet', health: { ok: false } }];
  fixtureState.lists[0].resolve(current);
  await newer;

  fixtureState.health[0].reject(new Error('obsolete health failure'));
  await older;
  assert.deepEqual(fixtureState.model.providers, current);
  assert.equal(fixtureState.toasts.some(([title]) => title === 'Source check failed'), false);
  assert.equal(fixtureState.toasts.at(-1)[0], 'Source check complete');
});

test('an admitted provider mutation invalidates an older refresh snapshot', async () => {
  const fixtureState = fixture();
  const refresh = fixtureState.refreshProviders();
  await advanceToList(fixtureState.health[0]);

  const mutation = fixtureState.setPreferred('mutated');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.preferred[0].id, 'mutated');
  fixtureState.lists[0].resolve([{ id: 'pre-mutation-snapshot', enabled: false, network: 'mainnet' }]);
  await refresh;

  const authoritative = [descriptor({ id: 'mutated', enabled: true, network: 'mainnet', health: { ok: true } })];
  fixtureState.preferred[0].resolve({ settings: fixtureState.model.settings, providers: authoritative });
  await mutation;

  assert.deepEqual(fixtureState.model.providers, authoritative);
  assert.equal(fixtureState.patches.length, 1);
  assert.deepEqual(fixtureState.patches[0].update.providers, authoritative);
  assert.equal(fixtureState.toasts.some(([title]) => title === 'Source check complete'), false);
});

test('latest refresh failure remains visible and suppresses an older success', async () => {
  const fixtureState = fixture();
  const older = fixtureState.refreshProviders();
  await advanceToList(fixtureState.health[0]);
  const newer = fixtureState.refreshProviders();
  fixtureState.health[1].reject(new Error('current health failure'));
  await newer;

  fixtureState.lists[0].resolve([{ id: 'obsolete' }]);
  await older;
  assert.equal(fixtureState.patches.length, 0);
  assert.deepEqual(fixtureState.toasts.at(-1), ['Source check failed', 'current health failure', 'error']);
  assert.equal(fixtureState.toasts.some(([title]) => title === 'Source check complete'), false);
});

test('an offline routing update invalidates pending refresh even though it starts no replacement refresh', async () => {
  const fixtureState = fixture();
  const refresh = fixtureState.refreshProviders();
  await advanceToList(fixtureState.health[0]);

  const update = fixtureState.updateSettings({ offlineMode: true });
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.settingsUpdates[0].resolve({ ...fixtureState.model.settings, offlineMode: true });
  await update;
  assert.equal(fixtureState.health.length, 1);

  fixtureState.lists[0].resolve([{ id: 'obsolete-before-offline' }]);
  await refresh;
  assert.equal(fixtureState.model.settings.offlineMode, true);
  assert.deepEqual(fixtureState.model.providers, []);
  assert.equal(fixtureState.toasts.some(([title]) => title === 'Source check complete'), false);
});

test('preferred-provider publication invalidates a refresh started while the mutation was pending', async () => {
  const fixtureState = fixture();
  const mutation = fixtureState.setPreferred('authoritative');
  const refresh = fixtureState.refreshProviders();
  await advanceToList(fixtureState.health[0]);

  const authoritative = [descriptor({ id: 'authoritative', enabled: true, network: 'mainnet', health: { ok: true } })];
  fixtureState.preferred[0].resolve({ settings: fixtureState.model.settings, providers: authoritative });
  await mutation;
  fixtureState.lists[0].resolve([{ id: 'snapshot-before-preference-commit' }]);
  await refresh;

  assert.deepEqual(fixtureState.model.providers, authoritative);
  assert.equal(fixtureState.patches.length, 1);
  assert.equal(fixtureState.toasts.some(([title]) => title === 'Source check complete'), false);
});

test('offline-settings publication invalidates a refresh started while persistence was pending', async () => {
  const fixtureState = fixture();
  const update = fixtureState.updateSettings({ offlineMode: true });
  const refresh = fixtureState.refreshProviders();
  await advanceToList(fixtureState.health[0]);

  fixtureState.settingsUpdates[0].resolve({ ...fixtureState.model.settings, offlineMode: true });
  await update;
  fixtureState.lists[0].resolve([{ id: 'snapshot-before-offline-commit' }]);
  await refresh;

  assert.equal(fixtureState.model.settings.offlineMode, true);
  assert.deepEqual(fixtureState.model.providers, []);
  assert.equal(fixtureState.toasts.some(([title]) => title === 'Source check complete'), false);
});

test('authority mutations admit in user-intent order', async () => {
  const fixtureState = fixture();
  const first = fixtureState.setPreferred('first');
  const second = fixtureState.setPreferred('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.preferred.length, 1);
  fixtureState.preferred[0].resolve({ settings: fixtureState.model.settings, providers: [{ id: 'first' }] });
  await first;
  assert.equal(fixtureState.preferred.length, 2);
  fixtureState.preferred[1].resolve({ settings: fixtureState.model.settings, providers: [{ id: 'second' }] });
  await second;
  assert.equal(fixtureState.model.providers[0].id, 'second');
});

test('provider and Settings mutations share one publication queue in both directions', async () => {
  const providerFirst = fixture();
  const provider = providerFirst.setPreferred('queued-provider');
  const settings = providerFirst.updateSettings({ theme: 'dark' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerFirst.preferred.length, 1);
  assert.equal(providerFirst.settingsUpdates.length, 0);
  providerFirst.preferred[0].resolve({ settings: providerFirst.model.settings, providers: [{ id: 'queued-provider' }] });
  await provider;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerFirst.settingsUpdates.length, 1);
  providerFirst.settingsUpdates[0].resolve({ ...providerFirst.model.settings, theme: 'dark' });
  await settings;

  const settingsFirst = fixture();
  const settingsOperation = settingsFirst.updateSettings({ theme: 'dark' });
  const providerOperation = settingsFirst.setPreferred('queued-provider');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settingsFirst.settingsUpdates.length, 1);
  assert.equal(settingsFirst.preferred.length, 0);
  settingsFirst.settingsUpdates[0].resolve({ ...settingsFirst.model.settings, theme: 'dark' });
  await settingsOperation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settingsFirst.preferred.length, 1);
  settingsFirst.preferred[0].resolve({ settings: settingsFirst.model.settings, providers: [{ id: 'queued-provider' }] });
  await providerOperation;
});

test('committed Settings maintenance failure publishes before the next authority mutation', async () => {
  const fixtureState = fixture();
  const settings = fixtureState.updateSettings({ offlineMode: true });
  const provider = fixtureState.setPreferred('after-maintenance');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.preferred.length, 0);
  fixtureState.settingsUpdates[0].reject({
    code: 'SETTINGS_NETWORK_CUTOFF_FAILED', message: 'fixture cutoff failed',
    details: { settingsCommitted: true, settings: { ...fixtureState.model.settings, offlineMode: true } }
  });
  await settings;
  assert.equal(fixtureState.model.settings.offlineMode, true);
  assert.equal(fixtureState.toasts.at(-1)[0], 'Settings saved; network cutoff failed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.preferred.length, 1);
  fixtureState.preferred[0].resolve({ settings: fixtureState.model.settings, providers: [{ id: 'after-maintenance' }] });
  await provider;
  assert.equal(fixtureState.model.providers[0].id, 'after-maintenance');
});

test('queued Settings intent snapshots its caller-supplied patch at admission', async () => {
  const fixtureState = fixture();
  const partial = { theme: 'dark' };
  const update = fixtureState.updateSettings(partial);
  partial.theme = 'light';
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(fixtureState.settingsUpdates[0].partial), JSON.stringify({ theme: 'dark' }));
  fixtureState.settingsUpdates[0].resolve({ ...fixtureState.model.settings, theme: 'dark' });
  await update;
});

test('held post-commit health cannot block a later offline update from reaching main', async () => {
  const fixtureState = fixture();
  const online = fixtureState.updateSettings({ network: 'testnet' });
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.settingsUpdates[0].resolve({ ...fixtureState.model.settings, network: 'testnet', offlineMode: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.health.length, 1);

  const offline = fixtureState.updateSettings({ offlineMode: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.settingsUpdates.length, 2);
  fixtureState.settingsUpdates[1].resolve({ ...fixtureState.model.settings, offlineMode: true });
  await offline;
  assert.equal(fixtureState.model.settings.offlineMode, true);
  assert.equal(fixtureState.reloads, 1);

  fixtureState.health[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.lists[0].resolve([{ id: 'obsolete-online-health' }]);
  await online;
  assert.deepEqual(fixtureState.model.providers, []);
  assert.equal(fixtureState.reloads, 1);
});

test('non-routing Settings successor discharges an inherited routing-maintenance obligation', async () => {
  const fixtureState = fixture();
  const network = fixtureState.updateSettings({ network: 'testnet' });
  const theme = fixtureState.updateSettings({ theme: 'dark' });
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.settingsUpdates[0].resolve({ ...fixtureState.model.settings, network: 'testnet', offlineMode: false });
  await network;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.health.length, 0);
  fixtureState.settingsUpdates[1].resolve({ ...fixtureState.model.settings, theme: 'dark' });
  await theme;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.health.length, 1);
  fixtureState.health[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.lists[0].resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.reloads, 1);
});

test('rejected provider successor still discharges prior routing maintenance', async () => {
  const fixtureState = fixture();
  const network = fixtureState.updateSettings({ network: 'testnet' });
  const provider = fixtureState.setPreferred('rejected');
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.settingsUpdates[0].resolve({ ...fixtureState.model.settings, network: 'testnet', offlineMode: false });
  await network;
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.preferred[0].reject(new Error('current preference failure'));
  await provider;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.health.length, 1);
  fixtureState.health[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.lists[0].resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.reloads, 1);
  assert.equal(fixtureState.toasts.some(([title]) => title === 'Could not update routing'), true);
});
