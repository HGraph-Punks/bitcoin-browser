import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PROVIDER_CAPABILITIES, defaultProviderCapabilitiesFor, providerCapabilitiesFor } from '../src/shared/constants.js';

// Exercise the real settings action with renderer collaborators replaced by
// deterministic spies. Native layout/controls remain packaged-smoke coverage.
const appSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const start = appSource.indexOf('async function updateSettings(partial) {');
const end = appSource.indexOf('\nasync function runPendingRoutingMaintenance(', start);
assert.ok(start >= 0 && end > start);
const actionSource = appSource.slice(start, end);

test('provider editor offers only supported capabilities and Ord-specific satpoints', () => {
  const begin = appSource.indexOf('const ALL_PROVIDER_CAPABILITIES =');
  const finish = appSource.indexOf('\nfunction refreshProviderMutationView(', begin);
  assert.ok(begin >= 0 && finish > begin);
  const values = vm.runInNewContext(`(() => { ${appSource.slice(begin, finish)}; return { all: ALL_PROVIDER_CAPABILITIES, ord: capabilitiesFor('ord-server'), mempool: capabilitiesFor('mempool'), core: capabilitiesFor('bitcoin-core') }; })()`,
    { PROVIDER_CAPABILITIES, defaultProviderCapabilitiesFor, providerCapabilitiesFor });
  assert.deepEqual([...values.all], [...PROVIDER_CAPABILITIES]);
  assert.ok(values.ord.includes('satpoint'));
  assert.ok(!values.mempool.includes('satpoint') && !values.core.includes('satpoint'));
  assert.ok(Object.values(values).every((capabilities) => !capabilities.includes('fees')));
  assert.deepEqual([...providerCapabilitiesFor('mempool')], ['block', 'transaction', 'output', 'address']);
  assert.deepEqual([...providerCapabilitiesFor('bitcoin-core')], ['block', 'transaction', 'transaction-raw', 'output']);
  assert.deepEqual([...providerCapabilitiesFor('mock')], [...PROVIDER_CAPABILITIES]);
  const helperBegin = appSource.indexOf('function incompatibleProviderCapabilities(');
  const helperEnd = appSource.indexOf('\n}', helperBegin) + 2;
  const incompatible = vm.runInNewContext(`(${appSource.slice(helperBegin, helperEnd)})`, { providerCapabilitiesFor });
  assert.deepEqual([...incompatible({ type: 'mempool', capabilities: ['block', 'satpoint', 'rune'] })], ['satpoint', 'rune']);
  assert.match(appSource, /provider-capability-warning[^]*Saving repairs the declaration/);
});

test('tab session changes dispatch immediately without a close-lost debounce', async () => {
  const begin = appSource.indexOf('function scheduleTabSave() {');
  const finish = appSource.indexOf('\nfunction newTab(', begin);
  assert.ok(begin >= 0 && finish > begin);
  const model = { tabs: [{ id: 'fixture', target: 'sat:1' }], activeTabId: 'fixture' };
  const calls = [];
  const action = vm.runInNewContext(`(${appSource.slice(begin, finish)})`, {
    state: () => model,
    api: { tabs: { save: (tabs, activeId) => { calls.push({ tabs, activeId }); return Promise.resolve(); } } },
    toast: () => assert.fail('unexpected failure'),
    setTimeout: () => assert.fail('tab save must not wait for a renderer timer')
  });
  const saved = action();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tabs, model.tabs);
  assert.equal(calls[0].activeId, model.activeTabId);
  await saved;
});

async function exercise(response) {
  const effects = { patches: [], toasts: [], themes: 0, reloads: 0, renders: 0 };
  const action = vm.runInNewContext(`(${actionSource})`, {
    providerRefreshSequence: 0,
    modalGeneration: 0,
    authorityMutationSequence: 0,
    routingMaintenanceVersion: 0,
    queueAuthorityMutation: async (task) => { await task(0); effects.reloads += 1; },
    api: { settings: { update: async () => { throw response; } } },
    patch: (value) => effects.patches.push(value),
    applyTheme: () => { effects.themes += 1; },
    refreshProviders: async () => {},
    reloadResolvableTarget: () => { effects.reloads += 1; },
    toast: (...args) => effects.toasts.push(args),
    renderPage: () => { effects.renders += 1; }
  });
  await action({ offlineMode: true, developerMode: true });
  return effects;
}

test('renderer reflects committed privacy settings when cache maintenance fails', async () => {
  const settings = { offlineMode: true, developerMode: true, network: 'mainnet' };
  const effects = await exercise({ code: 'SETTINGS_CACHE_MAINTENANCE_FAILED', message: 'Settings saved; fixture maintenance failure', details: { settingsCommitted: true, settings } });
  assert.equal(effects.patches[0].settings, settings);
  assert.equal(effects.patches[0].developerOpen, true);
  assert.equal(effects.themes, 1);
  assert.equal(effects.reloads, 1);
  assert.equal(effects.renders, 0);
  assert.equal(effects.toasts[0][0], 'Settings saved; cache maintenance failed');
});

test('renderer reflects committed privacy settings but warns when browser network cutoff fails', async () => {
  const settings = { offlineMode: true, developerMode: true, network: 'mainnet' };
  const effects = await exercise({
    code: 'SETTINGS_NETWORK_CUTOFF_FAILED',
    message: 'Settings saved; fixture connection close failure',
    details: { settingsCommitted: true, settings, maintenance: 'content-network' }
  });
  assert.equal(effects.patches[0].settings, settings);
  assert.equal(effects.patches[0].developerOpen, true);
  assert.equal(effects.themes, 1);
  assert.equal(effects.reloads, 1);
  assert.equal(effects.renders, 0);
  assert.equal(effects.toasts[0][0], 'Settings saved; network cutoff failed');
});

test('renderer does not invent applied settings after persistence fails', async () => {
  const effects = await exercise({ code: 'STATE_IO_FAILED', message: 'Fixture state write failure' });
  assert.equal(effects.patches.length, 0);
  assert.equal(effects.renders, 1);
  assert.equal(effects.toasts[0][0], 'Could not update settings');
});

async function exerciseProviderCleanup(replaceModal = false) {
  const begin = appSource.indexOf('function refreshProviderMutationView() {');
  const finish = appSource.indexOf('\nfunction openProviderModal(', begin);
  assert.ok(begin >= 0 && finish > begin);
  const removalBegin = appSource.indexOf('function confirmProviderRemoval(provider) {');
  const removalEnd = appSource.indexOf('\nasync function updateSettings(', removalBegin);
  assert.ok(removalBegin >= 0 && removalEnd > removalBegin);
  const effects = { patches: [], closed: 0, reloads: 0, toasts: [], lists: 0, removes: 0 };
  const provider = { id: 'removed-fixture', name: 'Removed source' };
  const model = { providers: [provider], settings: { network: 'mainnet', preferredProviderId: provider.id } };
  const buttons = new Map();
  const scope = {
    providerRefreshSequence: 0,
    modalGeneration: 0,
    pendingProviderMutations: new Map(), providerCleanupRecovery: new Map(),
    providerOutcomeRecovery: null, providerSnapshotPending: false,
    queueAuthorityMutation: (task) => task(), state: () => model,
    routeName: () => 'providers', renderPage: () => {},
    button: (label, options) => { buttons.set(label, options); return options; },
    h: () => ({}), modalHeader: () => ({}),
    showModal: () => ++scope.modalGeneration,
    api: { providers: {
      list: async () => { effects.lists += 1; assert.fail('committed response must not trigger another list request'); },
      remove: async () => {
        effects.removes += 1;
        if (replaceModal) scope.modalGeneration += 1;
        throw { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED', message: 'Fixture cleanup failure', details: {
          providerMutationCommitted: true, operation: 'remove', providerId: provider.id, providerRemoved: true,
          providers: [], settings: { network: 'mainnet', preferredProviderId: null },
          cleanups: [{ id: provider.id, generation: '29da2d6f-f98a-4dbc-83ce-000000000001', token: '29da2d6f-f98a-4dbc-83ce-000000000002', conflict: false, message: 'Fixture cleanup failure' }]
        } };
      }
    } },
    patch: (value) => { effects.patches.push(value); Object.assign(model, value); },
    closeModal: () => { effects.closed += 1; },
    reloadResolvableTarget: () => { effects.reloads += 1; },
    toast: (...args) => effects.toasts.push(args)
  };
  const action = vm.runInNewContext(`(() => {
    ${appSource.slice(begin, finish)}
    ${appSource.slice(removalBegin, removalEnd)}
    return confirmProviderRemoval;
  })()`, scope);
  action(provider);
  await buttons.get('Remove permanently').onClick();
  assert.equal(effects.lists, 0);
  assert.equal(effects.removes, 1);
  assert.equal(scope.providerCleanupRecovery.has(provider.id), true);
  assert.equal(model.settings.preferredProviderId, null);
  return effects;
}

test('provider cleanup failure publishes authoritative snapshots and reports committed removal', async () => {
  const effects = await exerciseProviderCleanup();
  assert.equal(effects.patches[0].providers.length, 0);
  assert.equal(effects.closed, 1);
  assert.equal(effects.reloads, 1);
  assert.equal(effects.toasts[0][0], 'Source removed; recovery needed');
  assert.equal(effects.toasts[0][1], 'Fixture cleanup failure');
});

test('late provider cleanup reconciliation cannot close a replacement modal', async () => {
  const effects = await exerciseProviderCleanup(true);
  assert.equal(effects.patches.length, 1);
  assert.equal(effects.closed, 0);
  assert.equal(effects.reloads, 1);
  assert.equal(effects.toasts[0][0], 'Source removed; recovery needed');
});
