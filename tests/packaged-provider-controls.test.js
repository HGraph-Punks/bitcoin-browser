import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createDisabledEmptyProviderDraft, runPackagedProviderControlChecks, verifyDisabledEmptyProviderDraftAfterRestart } from '../scripts/packaged-provider-controls.mjs';
import { ProviderManager } from '../src/main/provider-manager.js';
import { StateStore } from '../src/main/state-store.js';

const fixtureProvider = { id: 'beta-provider-controls', name: 'Provider controls fixture',
  baseUrl: 'http://127.0.0.1:32123', priority: 37 };

test('real StateStore and ProviderManager expose the normalized credential-free legacy descriptor shape', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packaged-provider-controls-shape-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = { id: 'beta-legacy-shape', name: 'Legacy shape', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32124', priority: 5, enabled: true, local: true, capabilities: ['block', 'satpoint'], cookieFile: '' };
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 3, settings: { offlineMode: true }, providers: [provider] }));
  const store = new StateStore(directory, null);
  await store.init();
  const descriptor = new ProviderManager(store, { has: () => false, get: () => null }, null).list()[0];
  assert.deepEqual(store.get(['providers'])[0], provider);
  assert.deepEqual(descriptor, { ...provider, credentialsStored: false, health: null });
});

test('real StateStore restart retains a disabled-empty provider without default resurrection', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packaged-disabled-provider-shape-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const provider = { id: 'beta-disabled-shape', name: 'Disabled shape', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({ schemaVersion: 3, settings: { offlineMode: true }, providers: [provider] }));
  for (let index = 0; index < 2; index += 1) {
    const store = new StateStore(directory, null); await store.init();
    assert.deepEqual(store.get(['providers']), [provider]);
    assert.deepEqual(new ProviderManager(store, { has: () => false }, null).list(), [{ ...provider, credentialsStored: false, health: null }]);
  }
});

function harness({ failAt, initialPreferred = 'existing', staleFeedback = false, wrongAddedConfiguration = false, ambiguousCard = false,
  failCleanupRemove = false, noOpCancel = false, noOpClose = false, noOpSaveClose = false,
  mutateAddCancel = false, mutateRemoveCancel = false, suppressEmptyFeedback = false, legacyProvider = null,
  noOpLegacyDisable = false, noOpLegacyEnable = false, corruptLegacyRepair = false, suppressInvalidEnableFeedback = false,
  mutateEmptyEnable = false, mutateDraftPreexisting = false, failProviderListReadback = false, failDraftOpen = false,
  groupedCaptionExecution = false } = {}) {
  const initialProviders = [{ id: 'existing', name: 'Existing', type: 'mock', network: 'mainnet', baseUrl: '',
    priority: 1, enabled: true, local: true, capabilities: ['sat'], health: null }];
  const state = { providers: structuredClone(initialProviders), preferredProviderId: initialPreferred, network: 'mainnet', localOnly: true, offlineMode: true };
  if (legacyProvider) state.providers.push({ ...structuredClone(legacyProvider), credentialsStored: false, health: null });
  const calls = [];
  let invalidPending = false;
  let modal = { visible: false, heading: '', owned: false };
  let pendingFields = {};
  let pendingCapabilities;
  let pendingEnabled = true;
  let editingId = fixtureProvider.id;
  const defaults = {
    'ord-server': ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction-raw', 'output', 'satpoint', 'address', 'rune'],
    mempool: ['block', 'transaction', 'output', 'address'], 'bitcoin-core': ['block', 'transaction', 'transaction-raw', 'output'],
    mock: ['ord-recursion', 'inscription', 'sat', 'block', 'transaction', 'output', 'satpoint', 'address']
  };
  const supported = { ...defaults,
    mock: ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction', 'transaction-raw', 'output', 'satpoint', 'address', 'rune'] };
  const maybeFail = (name) => {
    if (failAt !== name) return;
    const error = new Error(`fixture ${name} failed`); error.evidence = { original: true }; throw error;
  };
  const evaluateGroupedCallback = (expression, values = {}, status = pendingEnabled) => {
    const controls = new Map(Object.keys(values).map((label, index) => [label, {
      value: `sentinel-${index}-${label}`, checked: false, changes: 0,
      dispatchEvent(event) { if (event?.type === 'change') this.changes += 1; }
    }]));
    controls.set('Status', { value: 'sentinel-status', checked: status, changes: 0,
      dispatchEvent(event) { if (event?.type === 'change') this.changes += 1; } });
    const fields = [...controls].map(([label, control]) => ({
      querySelector(selector) {
        if (selector === ':scope > .form-field-label') return { textContent: label };
        if (selector === 'input,select' || (selector === 'input[type="checkbox"]' && label === 'Status')) return control;
        return null;
      }
    }));
    const modalNode = { querySelectorAll: (selector) => selector === '.form-field' ? fields : [] };
    const document = {
      querySelector: (selector) => selector === '#modal' ? modalNode : null,
      querySelectorAll: (selector) => selector === '#modal .form-field' ? fields : []
    };
    const result = vm.runInNewContext(expression, { document, Event: class Event { constructor(type) { this.type = type; } } });
    return { result, controls };
  };
  const cdp = {
    async evaluate(expression) {
      if (expression.startsWith('Promise.all(')) return { ...structuredClone(state), providers: structuredClone(state.providers) };
      if (expression.includes('provider-controls:route')) { calls.push('route'); return true; }
      if (expression.includes('provider-controls:invalid-snapshot')) return { modalVisible: true, fresh: !staleFeedback, status: 'Could not save source invalid provider' };
      if (expression.includes('provider-controls:empty-capability-snapshot')) return { modalVisible: true, fresh: !suppressEmptyFeedback,
        status: 'Could not save source Choose at least one supported capability' };
      if (expression.includes('provider-controls:invalid-enable-snapshot')) return { fresh: !suppressInvalidEnableFeedback,
        status: 'Could not update source provider capabilities are not supported' };
      if (expression.includes('provider-controls:modal-state')) {
        const headings = JSON.parse(expression.match(/expected: (\[.*\])\.includes/)[1]);
        return { ...modal, expected: headings.includes(modal.heading) };
      }
      if (expression.includes('provider-controls:invalid-open') || expression.includes('provider-controls:cancel-open')
        || expression.includes('provider-controls:add-open') || expression.includes('provider-controls:disabled-draft-open')) {
        if (expression.includes('provider-controls:disabled-draft-open') && failDraftOpen) return false;
        calls.push(expression.match(/provider-controls:([a-z-]+)/)[1]); modal = { visible: true, heading: 'Add a data source', owned: true };
        pendingFields = {}; pendingCapabilities = defaults['ord-server']; pendingEnabled = true; return true;
      }
      if (expression.includes('provider-controls:null')) {
        const values = JSON.parse(expression.match(/const values = (\{.*\});/)[1]);
        if (groupedCaptionExecution) {
          const executed = evaluateGroupedCallback(expression, values);
          assert.equal(executed.result, true);
          for (const [label, requested] of Object.entries(values)) {
            const control = executed.controls.get(label);
            assert.equal(control.value, String(requested));
            assert.equal(control.changes, 1);
            values[label] = control.value;
          }
          calls.push('grouped-caption-fields');
        }
        pendingFields = { ...pendingFields, ...values };
        if (pendingFields['Adapter type']) pendingCapabilities = defaults[pendingFields['Adapter type']];
        calls.push(`fields:${pendingFields['Adapter type'] ?? 'same'}`); return true;
      }
      if (expression.includes('provider-controls:capabilities')) {
        pendingCapabilities = JSON.parse(expression.match(/const selected = (\[.*\]);/)[1]);
        calls.push(`capabilities:${pendingCapabilities.join(',')}`);
        return { available: supported[pendingFields['Adapter type'] ?? 'ord-server'], selected: pendingCapabilities };
      }
      if (expression.includes('provider-controls:disabled-draft-status')) {
        if (groupedCaptionExecution) {
          const executed = evaluateGroupedCallback(expression);
          assert.equal(executed.result, true);
          assert.equal(executed.controls.get('Status').checked, false);
          assert.equal(executed.controls.get('Status').changes, 1);
          pendingEnabled = executed.controls.get('Status').checked;
          calls.push('grouped-caption-status');
        } else pendingEnabled = false;
        calls.push('disabled-status'); return true;
      }
      if (expression.includes('provider-controls:Save source')) {
        const values = { ...pendingFields, ...JSON.parse(expression.match(/const values = (\{.*\});/)[1]) };
        calls.push(`save:${values.Identifier ?? 'edit'}`);
        if (values.Identifier === 'INVALID ID') { invalidPending = true; return true; }
        if (!values.Identifier && pendingCapabilities?.length === 0) return true;
        maybeFail(values.Identifier ? 'add' : 'edit');
        if (values.Identifier) state.providers.push({ id: values.Identifier, name: values.Name, type: values['Adapter type'] ?? 'ord-server',
          network: values['Bitcoin network'] ?? 'mainnet', baseUrl: values['Base URL'], cookieFile: '', credentialsStored: false,
          enabled: pendingEnabled, local: true, priority: Number(values.Priority), health: null, capabilities: pendingCapabilities,
          ...(wrongAddedConfiguration ? { baseUrl: 'http://127.0.0.1:9' } : {}) });
        else {
          const item = state.providers.find((entry) => entry.id === editingId);
          const type = values['Adapter type'] ?? item.type;
          Object.assign(item, { name: values.Name ?? item.name, type, network: values['Bitcoin network'] ?? item.network,
            baseUrl: type === 'mock' ? '' : (values['Base URL'] ?? item.baseUrl), priority: Number(values.Priority ?? item.priority),
            local: true, capabilities: pendingCapabilities ?? defaults[type] });
          if (corruptLegacyRepair && item.id === legacyProvider?.id) item.name = `${item.name} corrupted`;
        }
        if (!noOpSaveClose) modal.visible = false;
        if (values.Identifier?.startsWith('beta-disabled-draft') && mutateDraftPreexisting) state.providers.find((item) => item.id === 'existing').priority += 1;
        return true;
      }
      if (expression.includes('provider-controls:Cancel')) {
        calls.push(invalidPending ? 'cancel-invalid' : 'cancel');
        if (!invalidPending && modal.heading === 'Add a data source' && mutateAddCancel) state.preferredProviderId = null;
        if (!invalidPending && modal.heading === 'Provider controls fixture edited' && mutateRemoveCancel) state.preferredProviderId = 'corrupted';
        invalidPending = false; if (!noOpCancel) modal.visible = false; return true;
      }
      if (expression.includes('provider-controls:Remove permanently')) {
        calls.push('remove-permanently'); state.providers = state.providers.filter((item) => item.id !== fixtureProvider.id); modal.visible = false; return true;
      }
      if (expression.includes('provider-controls:Remove')) { calls.push('remove-confirmation'); modal.heading = 'Provider controls fixture edited'; return true; }
      if (expression.includes('provider-controls:card-name-action')) {
        const strings = [...expression.matchAll(/includes\(("(?:[^"\\]|\\.)*")\)|=== ("(?:[^"\\]|\\.)*")/g)].flatMap((match) => match.slice(1).filter(Boolean)).map(JSON.parse);
        const name = strings.at(-2); const label = strings.at(-1); calls.push(`card:${label}`);
        if (ambiguousCard) return false;
        maybeFail(label.toLowerCase());
        if (label === 'Prefer') state.preferredProviderId = fixtureProvider.id;
        if (label === 'Auto') state.preferredProviderId = null;
        const selected = state.providers.find((item) => item.name === name);
        if (label === 'Disable' || label === 'Enable') selected.enabled = label === 'Enable';
        if (label === 'Edit') modal = { visible: true, heading: `Edit ${selected?.name}`, owned: true };
        if (label === 'Edit') { editingId = selected.id; pendingFields = { 'Adapter type': selected.type }; pendingCapabilities = selected?.capabilities; }
        return true;
      }
      if (expression.includes('provider-controls:toggle-name')) {
        const name = JSON.parse(expression.match(/=== ("(?:[^"\\]|\\.)*");/)[1]);
        calls.push(`toggle:${name}`); const provider = state.providers.find((item) => item.name === name);
        if (provider.enabled && noOpLegacyDisable) return true;
        if (!provider.enabled && (provider.capabilities.includes('satpoint') || (provider.capabilities.length === 0 && !mutateEmptyEnable))) return true;
        if (!provider.enabled && noOpLegacyEnable) return true;
        provider.enabled = !provider.enabled; return true;
      }
      if (expression.includes('provider-controls:toggle')) {
        calls.push('toggle'); const provider = state.providers.find((item) => item.id === fixtureProvider.id); provider.enabled = !provider.enabled; return true;
      }
      if (expression.startsWith('window.satBrowser.providers.remove(')) {
        if (failCleanupRemove) throw new Error('fixture cleanup remove failed');
        calls.push('cleanup-remove'); const id = JSON.parse(expression.match(/remove\((.*)\)/)[1]); state.providers = state.providers.filter((item) => item.id !== id); return state.providers;
      }
      if (expression === 'window.satBrowser.providers.list()') {
        if (failProviderListReadback) throw new Error('fixture provider list readback failed');
        return structuredClone(state.providers);
      }
      if (expression.startsWith('window.satBrowser.settings.update(')) {
        calls.push('cleanup-settings'); Object.assign(state, JSON.parse(expression.match(/update\((.*)\)/)[1])); return state;
      }
      if (expression.startsWith('window.satBrowser.providers.preferred(')) {
        calls.push('cleanup-preference'); state.preferredProviderId = JSON.parse(expression.match(/preferred\((.*)\)/)[1]); return state;
      }
      if (expression.includes('provider-controls:cleanup-modal')) {
        calls.push('cleanup-modal');
        if (!modal.visible || !modal.owned) return false;
        if (!noOpClose) modal.visible = false;
        return true;
      }
      if (expression.includes('provider-controls:disabled-draft-cleanup-modal')) { modal.visible = false; calls.push('draft-cleanup-modal'); return true; }
      if (expression.includes('provider-controls:settings-route')) { calls.push('settings-route'); return true; }
      if (expression.includes('provider-controls:network-choice')) {
        state.network = JSON.parse(expression.match(/select\.value = ("[^"]+")/)[1]); calls.push(`network:${state.network}`); return true;
      }
      if (expression.includes('provider-controls:network-card')) return state.providers.filter((item) => item.name === 'Provider controls fixture edited' && item.network === state.network).length;
      if (expression.includes("#page h1")) return calls.at(-1) === 'settings-route' ? 'Settings' : 'Data sources';
      throw new Error(`Unexpected evaluation: ${expression.slice(0, 100)}`);
    }
  };
  return { state, calls, initialProviders, options: { cdp, fixtureProvider, ...(legacyProvider ? { legacyProvider } : {}),
    assert: (condition, message) => assert.ok(condition, message),
    poll: async (action, predicate) => { const value = await action(); assert.ok(predicate(value)); return value; } } };
}

test('disabled-empty draft uses actual Add controls, survives readback, rejects Enable, and cleans exact ownership', async () => {
  const provider = { id: 'beta-disabled-draft', name: 'Disabled draft', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness();
  const created = await createDisabledEmptyProviderDraft({ ...h.options, provider });
  assert.deepEqual(created.deferredCleanup, { providerId: provider.id, reason: 'ordinary-restart-readback' });
  assert.deepEqual(h.state.providers.find((item) => item.id === provider.id), { ...provider, credentialsStored: false, health: null });
  const verified = await verifyDisabledEmptyProviderDraftAfterRestart({ ...h.options, provider });
  assert.deepEqual(verified, { schemaVersion: 1, persisted: true, enabled: false, capabilities: [], invalidEnableRejected: true,
    preexistingStatePreserved: true, cleaned: true });
  assert.equal(h.state.providers.some((item) => item.id === provider.id), false);
  assert.ok(h.calls.includes('disabled-status'));
});

test('disabled draft executes real field and Status callbacks against a selector-aware grouped-caption fixture', async () => {
  const provider = { id: 'beta-disabled-caption', name: 'Disabled grouped caption', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness({ groupedCaptionExecution: true });
  await createDisabledEmptyProviderDraft({ ...h.options, provider });
  assert.ok(h.calls.includes('grouped-caption-fields'));
  assert.ok(h.calls.includes('grouped-caption-status'));
  assert.equal(h.state.providers.find((item) => item.id === provider.id).enabled, false);
});

for (const [label, fault] of [
  ['wrong saved draft shape', { wrongAddedConfiguration: true }],
  ['draft modal does not close', { noOpSaveClose: true }],
  ['disabled draft Enable mutates', { noOpLegacyEnable: false, noOpLegacyDisable: false, mutateEmptyEnable: true }],
  ['disabled draft Enable has no fresh feedback', { suppressInvalidEnableFeedback: true }]
]) test(`${label} cannot qualify disabled-empty restart`, async () => {
  const provider = { id: 'beta-disabled-draft', name: 'Disabled draft', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness(fault);
  if (fault.suppressInvalidEnableFeedback || fault.mutateEmptyEnable) {
    await createDisabledEmptyProviderDraft({ ...h.options, provider });
    await assert.rejects(verifyDisabledEmptyProviderDraftAfterRestart({ ...h.options, provider }));
  } else await assert.rejects(createDisabledEmptyProviderDraft({ ...h.options, provider }));
});

test('disabled draft creation rejects mutation of pre-existing configuration', async () => {
  const provider = { id: 'beta-disabled-draft', name: 'Disabled draft', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness({ mutateDraftPreexisting: true });
  await assert.rejects(createDisabledEmptyProviderDraft({ ...h.options, provider }), /changed pre-existing/);
});

test('disabled draft failure preserves cleanup readback errors on the primary failure', async () => {
  const provider = { id: 'beta-disabled-draft', name: 'Disabled draft', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness({ wrongAddedConfiguration: true, failProviderListReadback: true });
  const ownership = [];
  await assert.rejects(createDisabledEmptyProviderDraft({ ...h.options, provider, setOwnedProvider: (value) => ownership.push(value) }), (error) => {
    assert.ok(error.evidence.cleanupErrors.some((item) => item.phase === 'provider'));
    return true;
  });
  assert.deepEqual(ownership, [provider]);
});

test('disabled draft failed removal leaves exact ownership assigned for parent finalization', async () => {
  const provider = { id: 'beta-disabled-draft', name: 'Disabled draft', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness({ wrongAddedConfiguration: true, failCleanupRemove: true });
  const ownership = [];
  await assert.rejects(createDisabledEmptyProviderDraft({ ...h.options, provider, setOwnedProvider: (value) => ownership.push(value) }), (error) => {
    assert.ok(error.evidence.cleanupErrors.some((item) => item.phase === 'provider'));
    return true;
  });
  assert.deepEqual(ownership, [provider]);
  assert.equal(h.state.providers.some((item) => item.id === provider.id), true);
});

for (const collision of ['id', 'name']) test(`disabled draft ${collision} collision never establishes ownership or removes existing state`, async () => {
  const provider = { id: 'beta-disabled-collision', name: 'Disabled collision', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness();
  h.state.providers.push({ ...provider, id: collision === 'id' ? provider.id : 'beta-other-collision',
    name: collision === 'name' ? provider.name : 'Other collision', credentialsStored: false, health: null });
  const before = structuredClone(h.state.providers);
  let ownershipCalls = 0;
  await assert.rejects(createDisabledEmptyProviderDraft({ ...h.options, provider, setOwnedProvider: () => { ownershipCalls += 1; } }), /already exists/);
  assert.equal(ownershipCalls, 0);
  assert.deepEqual(h.state.providers, before);
  assert.equal(h.calls.includes('cleanup-remove'), false);
});

test('disabled draft setup failure releases established ownership after proven cleanup', async () => {
  const provider = { id: 'beta-disabled-setup', name: 'Disabled setup', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness({ failDraftOpen: true });
  const ownership = [];
  await assert.rejects(createDisabledEmptyProviderDraft({ ...h.options, provider, setOwnedProvider: (value) => ownership.push(value?.id ?? null) }));
  assert.deepEqual(ownership, [provider.id, null]);
  assert.equal(h.state.providers.some((item) => item.id === provider.id), false);
});

test('ownership callback rejection occurs before draft mutation', async () => {
  const provider = { id: 'beta-disabled-callback', name: 'Disabled callback', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32126', priority: 44, enabled: false, local: true, capabilities: [], cookieFile: '' };
  const h = harness();
  await assert.rejects(createDisabledEmptyProviderDraft({ ...h.options, provider, setOwnedProvider: () => { throw new Error('ownership rejected'); } }), /ownership rejected/);
  assert.equal(h.state.providers.some((item) => item.id === provider.id), false);
  assert.equal(h.calls.includes('route'), false);
});

test('packaged provider controls drive validation, cancel, CRUD, routing, and toggle UI with authoritative cleanup', async () => {
  const h = harness();
  const result = await runPackagedProviderControlChecks(h.options);
  assert.deepEqual(result.evidence.map((item) => item.branch), [
    'validation', 'add-cancel', 'add', 'empty-capability-rejected', 'edit-adapters-networks-capabilities', 'prefer-auto', 'disable-enable', 'remove-cancel-confirm'
  ]);
  assert.deepEqual(result.evidence[4].types, ['ord-server', 'mempool', 'bitcoin-core', 'mock']);
  assert.deepEqual(result.evidence[4].networks, ['mainnet', 'testnet', 'regtest']);
  assert.equal(result.authoritativeCleanupVerified, true);
  assert.deepEqual(h.state.providers, h.initialProviders);
  assert.equal(h.state.preferredProviderId, 'existing');
  assert.equal(h.state.localOnly, true);
  assert.equal(h.state.offlineMode, true);
  assert.equal(h.calls.filter((item) => item === 'toggle').length, 2);
  assert.ok(h.calls.includes('card:Prefer') && h.calls.includes('card:Auto'));
  assert.ok(h.calls.includes('capabilities:block,address') && h.calls.includes('capabilities:satpoint'));
  assert.ok(h.calls.includes('capabilities:transaction-raw,output'));
  assert.ok(h.calls.includes('network:testnet') && h.calls.includes('network:regtest') && h.calls.includes('network:mainnet'));
  assert.ok(h.calls.includes('remove-permanently'));
});

test('owned persisted legacy Mempool fixture is disabled unchanged, repaired while disabled, enabled, and removed', async () => {
  const legacyProvider = { id: 'beta-legacy-mempool', name: 'Legacy Mempool fixture', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32124', priority: 5, enabled: true, local: true, capabilities: ['block', 'satpoint'], cookieFile: '' };
  const h = harness({ legacyProvider });
  const result = await runPackagedProviderControlChecks(h.options);
  assert.deepEqual(result.evidence[0], { branch: 'legacy-disable-repair-enable', id: legacyProvider.id,
    invalidEnableRejected: true, retainedBeforeRepair: ['block', 'satpoint'], repaired: ['block'] });
  assert.ok(h.calls.includes(`toggle:${legacyProvider.name}`));
  assert.equal(h.calls.filter((item) => item === `toggle:${legacyProvider.name}`).length, 3);
  assert.ok(h.calls.includes('capabilities:block'));
  assert.deepEqual(h.state.providers, h.initialProviders);
});

test('successful restart contract retains only the repaired owned legacy record for caller readback', async () => {
  const legacyProvider = { id: 'beta-legacy-mempool', name: 'Legacy Mempool fixture', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32124', priority: 5, enabled: true, local: true, capabilities: ['block', 'satpoint'], cookieFile: '' };
  const h = harness({ legacyProvider });
  h.options.retainLegacyForRestart = true;
  const result = await runPackagedProviderControlChecks(h.options);
  assert.deepEqual(result.deferredCleanup, { providerId: legacyProvider.id, reason: 'restart-readback' });
  assert.deepEqual(h.state.providers, [...h.initialProviders, { ...legacyProvider, capabilities: ['block'], credentialsStored: false, health: null }]);
  assert.equal(h.calls.filter((item) => item === 'cleanup-remove').length, 1);
});

for (const [label, fault] of [
  ['no-op legacy disable', { noOpLegacyDisable: true }],
  ['incorrect legacy repair', { corruptLegacyRepair: true }],
  ['no-op repaired enable', { noOpLegacyEnable: true }],
  ['missing fresh invalid-enable feedback', { suppressInvalidEnableFeedback: true }]
]) test(`${label} cannot qualify the persisted legacy workflow`, async () => {
  const legacyProvider = { id: 'beta-legacy-mempool', name: 'Legacy Mempool fixture', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32124', priority: 5, enabled: true, local: true, capabilities: ['block', 'satpoint'], cookieFile: '' };
  const h = harness({ legacyProvider, ...fault });
  await assert.rejects(runPackagedProviderControlChecks(h.options));
  assert.deepEqual(h.state.providers, h.initialProviders);
});

test('wrong pre-seeded legacy configuration is rejected before UI mutation without claiming ownership', async () => {
  const legacyProvider = { id: 'beta-legacy-mempool', name: 'Legacy Mempool fixture', type: 'mempool', network: 'mainnet',
    baseUrl: 'http://127.0.0.1:32124', priority: 5, enabled: true, local: true, capabilities: ['block', 'satpoint'], cookieFile: '' };
  const h = harness({ legacyProvider });
  h.state.providers.find((item) => item.id === legacyProvider.id).baseUrl = 'http://127.0.0.1:32125';
  await assert.rejects(runPackagedProviderControlChecks(h.options), /exactly match/);
  assert.equal(h.state.providers.some((item) => item.id === legacyProvider.id), true);
  assert.equal(h.calls.includes('route'), false);
});

test('functional failure still removes only owned fixture and restores preference and mode settings', async () => {
  const h = harness({ failAt: 'edit' });
  await assert.rejects(runPackagedProviderControlChecks(h.options), (error) => {
    assert.equal(error.message, 'fixture edit failed');
    assert.equal(error.evidence.fixtureId, fixtureProvider.id);
    assert.deepEqual(error.evidence.steps.map((item) => item.branch), ['validation', 'add-cancel', 'add']);
    return true;
  });
  assert.deepEqual(h.state.providers, h.initialProviders);
  assert.equal(h.state.preferredProviderId, 'existing');
  assert.equal(h.state.localOnly, true);
  assert.equal(h.state.offlineMode, true);
  assert.deepEqual(h.calls.slice(-5), ['card:Edit', 'cleanup-modal', 'cleanup-remove', 'cleanup-settings', 'cleanup-preference']);
});

test('rejects unsafe fixture contracts before touching CDP', async () => {
  const h = harness();
  await assert.rejects(runPackagedProviderControlChecks({ ...h.options, fixtureProvider: { ...fixtureProvider, id: '../shared' } }), /fixtureProvider/);
  await assert.rejects(runPackagedProviderControlChecks({ ...h.options, fixtureProvider: { ...fixtureProvider, baseUrl: 'https://example.com' } }), /fixtureProvider/);
  await assert.rejects(runPackagedProviderControlChecks({ ...h.options, fixtureProvider: { ...fixtureProvider, baseUrl: 'http://user:pass@127.0.0.1:32123' } }), /fixtureProvider/);
  await assert.rejects(runPackagedProviderControlChecks({ ...h.options, fixtureProvider: { ...fixtureProvider, capabilities: ['sat'] } }), /capabilities/);
  await assert.rejects(runPackagedProviderControlChecks({ ...h.options, fixtureProvider: { ...fixtureProvider, name: 'n'.repeat(74) } }), /fixtureProvider/);
  await assert.rejects(runPackagedProviderControlChecks({ ...h.options, legacyProvider: { id: 'beta-legacy', name: 'Legacy', type: 'mempool',
    network: 'mainnet', baseUrl: 'http://127.0.0.1:32124', priority: 5, enabled: true, local: true, capabilities: ['block'] } }), /legacyProvider/);
  await assert.rejects(runPackagedProviderControlChecks({ ...h.options, retainLegacyForRestart: true }), /retainLegacyForRestart/);
  assert.deepEqual(h.calls, []);
});

test('stale pre-existing validation feedback cannot qualify a rejected submission', async () => {
  const h = harness({ staleFeedback: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options));
  assert.deepEqual(h.state.providers, h.initialProviders);
  assert.ok(h.calls.includes('cleanup-modal'));
});

test('wrong authoritative Add configuration is rejected and cleaned up', async () => {
  const h = harness({ wrongAddedConfiguration: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options));
  assert.deepEqual(h.state.providers, h.initialProviders);
});

test('ambiguous or prefix-like provider card matching cannot activate Edit', async () => {
  const h = harness({ ambiguousCard: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options), /Edit control was not reachable/);
  assert.deepEqual(h.state.providers, h.initialProviders);
});

test('primary failure evidence and cleanup failures are both retained', async () => {
  const h = harness({ failAt: 'edit', failCleanupRemove: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options), (error) => {
    assert.equal(error.message, 'fixture edit failed');
    assert.equal(error.evidence.original, true);
    assert.ok(error.evidence.cleanupErrors.some((item) => item.phase === 'remove-owned-provider'));
    assert.ok(error.evidence.cleanupErrors.some((item) => item.phase === 'verify-cleanup'));
    return true;
  });
});

test('a no-op Cancel click cannot pass while the owned modal remains visible', async () => {
  const h = harness({ noOpCancel: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options));
  assert.deepEqual(h.state.providers, h.initialProviders);
  assert.equal(h.calls.includes('cleanup-modal'), true);
});

test('a successful mutation cannot pass before its owned modal closes', async () => {
  const h = harness({ noOpSaveClose: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options));
  assert.deepEqual(h.state.providers, h.initialProviders);
});

test('Add cancellation requires exact providers and preference snapshots', async () => {
  const h = harness({ mutateAddCancel: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options), /Cancelled add changed providers or preference/);
});

test('Remove cancellation requires exact providers and preference snapshots', async () => {
  const h = harness({ mutateRemoveCancel: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options), /Cancelled remove changed providers or preference/);
});

test('a no-op owned modal close is retained as cleanup evidence', async () => {
  const h = harness({ staleFeedback: true, noOpClose: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options), (error) => {
    assert.ok(error.evidence.cleanupErrors.some((item) => item.phase === 'dismiss-owned-modal'));
    return true;
  });
});

test('suppressed empty-capability feedback cannot qualify the UI rejection', async () => {
  const h = harness({ suppressEmptyFeedback: true });
  await assert.rejects(runPackagedProviderControlChecks(h.options));
  assert.deepEqual(h.state.providers, h.initialProviders);
});

test('pre-existing owned id is rejected without mutation and still restores exact snapshot', async () => {
  const h = harness();
  h.state.providers.push({ ...fixtureProvider });
  const before = structuredClone(h.state.providers);
  await assert.rejects(runPackagedProviderControlChecks(h.options), /already exists/);
  assert.deepEqual(h.state.providers, before);
  assert.deepEqual(h.calls, []);
});
