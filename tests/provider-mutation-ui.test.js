import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PROVIDER_CAPABILITIES, providerCapabilitiesFor, defaultProviderCapabilitiesFor } from '../src/shared/constants.js';
import { assertString } from '../src/shared/validation.js';
import * as recoveryHelpers from '../src/shared/provider-recovery.js';
import { providerHealthPresentation } from '../src/renderer/source-status.js';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const dom = fs.readFileSync(new URL('../src/renderer/dom.js', import.meta.url), 'utf8');
const views = fs.readFileSync(new URL('../src/renderer/views.js', import.meta.url), 'utf8');
function extract(start, end) { const a = source.indexOf(start); const b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); }
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

class N {
  constructor(tag, text = '') { this.tagName = tag.toUpperCase(); this.textContent = text; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.attributes = new Map(); this.checked = false; this.disabled = false; this._value = ''; }
  get value() { return this.tagName === 'SELECT' ? (this.children.find((n) => n.selected)?.value ?? this.children[0]?.value ?? '') : this._value; }
  set value(value) { this._value = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (['id', 'type'].includes(key)) this[key] = value; }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) { const out = []; const walk = (n) => { if (n !== this && (selector === '[data-capability]' ? Object.hasOwn(n.dataset, 'capability') : n.tagName === selector.toUpperCase())) out.push(n); n.children.forEach(walk); }; walk(this); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const text = (node) => node.textContent + node.children.map(text).join('');
const initial = { id: 'source-a', name: 'Source A', type: 'mock', network: 'mainnet', baseUrl: '', priority: 10, enabled: true, capabilities: ['block'], cookieFile: '' };
const cleanupGeneration = '29da2d6f-f98a-4dbc-83ce-000000000001';
const cleanupToken = '29da2d6f-f98a-4dbc-83ce-000000000002';
const nextCleanupToken = '29da2d6f-f98a-4dbc-83ce-000000000003';
const cleanupDescriptor = (overrides = {}) => ({ id: initial.id, generation: cleanupGeneration, token: cleanupToken, conflict: false, message: 'Synthetic cleanup pending.', ...overrides });

function fixture(provider = initial) {
  const document = { createElement: (tag) => Object.assign(new N(tag), { ownerDocument: document }), createTextNode: (value) => new N('#text', String(value)), getElementById: () => null, activeElement: null };
  const helpers = vm.runInNewContext(`(() => { ${dom.replaceAll('export ', '')}; return { h, clear, button }; })()`, { document, Node: N, Intl });
  const main = { providers: [structuredClone(provider)], settings: { network: 'mainnet', preferredProviderId: null }, cleanups: [] };
  const model = structuredClone(main);
  const toasts = [];
  const calls = { upsert: 0, remove: 0, list: 0, health: 0, snapshot: 0, preferred: [], recover: [], cleanup: [], reviewCleanup: [] };
  let modal = null;
  let listFailure = false;
  let cleanupFailure = false;
  let cleanupReadFailure = false;
  let heldCleanup = null;
  let heldReviewCleanup = null;
  let cleanupRejection = null;
  let reviewResponse = cleanupDescriptor({ generation: null });
  let reviewFailure = null;
  let snapshotTransform = (value) => value;
  let heldRemove = null;
  let heldUpsert = null;
  let heldRecovery = null;
  let recoveryFailure = null;
  let heldSnapshot = null;
  let snapshotFailure = false;
  let malformed = false;
  let transform = (value) => value;
  let rejected = false;
  let route = 'providers';
  let repaints = 0;
  const snapshot = () => snapshotTransform({ providers: listFailure ? null : structuredClone(main.providers), settings: structuredClone(main.settings), cleanups: cleanupReadFailure ? null : structuredClone(main.cleanups),
    ...(listFailure || cleanupReadFailure ? { stateReadErrors: {
      ...(listFailure ? { providers: { code: 'TEST_READ', message: 'Synthetic snapshot unavailable' } } : {}),
      ...(cleanupReadFailure ? { cleanups: { code: 'TEST_CLEANUP_READ', message: 'Synthetic cleanup snapshot unavailable' } } : {})
    } } : {}) });
  const outcome = (operation, providerId, committed = true) => transform(malformed ? {} : { ...snapshot(), operation, providerId, providerMutationCommitted: committed });
  const scope = { ...helpers, ...recoveryHelpers, document, PROVIDER_CAPABILITIES, providerCapabilitiesFor, defaultProviderCapabilitiesFor,
    state: () => model, routeName: () => route, renderPage: () => { repaints++; }, patch: (value, options = {}) => { Object.assign(model, value); if (options.page) repaints++; }, toast: (...args) => toasts.push(args),
    reloadResolvableTarget() {}, runPendingRoutingMaintenance() {},
    modalHeader: (a, b) => helpers.h('header', {}, a, b),
    installModal: (...children) => { modal = helpers.h('section', {}, ...children); }, hideModal: () => { modal = null; },
    api: { providers: {
      async preferred(id) { calls.preferred.push(id); main.settings.preferredProviderId = id; return outcome('preferred', id); },
      async upsert(provider) { calls.upsert++; if (heldUpsert) await heldUpsert.promise; const id = assertString(provider.id, 'provider.id', { min: 3, max: 80 }); if (rejected) throw Object.assign(new Error('Synthetic rejected edit'), { code: 'PROVIDER_BUSY', details: outcome('upsert', id, false) }); main.providers = [{ ...structuredClone(provider), id }]; return outcome('upsert', id); },
      async recover(request) {
        calls.recover.push(structuredClone(request));
        if (heldRecovery) await heldRecovery.promise;
        if (recoveryFailure) throw Object.assign(new Error('Synthetic rejected recovery'), { code: recoveryFailure, details: outcome('recover', request.id, false) });
        main.providers = main.providers.map((provider) => {
          if (provider.id !== request.id) return provider;
          const { routingBlocked, routingError, credentialRecovery, health, ...config } = provider;
          return { ...config, credentialsStored: request.mode === 'replace-basic' };
        });
        return outcome('recover', request.id);
      },
      async snapshot() { calls.snapshot++; if (heldSnapshot) await heldSnapshot.promise; if (snapshotFailure) throw new Error('Synthetic read-only refresh failure'); return snapshot(); },
      async list() { calls.list++; if (listFailure) throw new Error('Synthetic snapshot unavailable'); return structuredClone(main.providers); },
      async health() { calls.health++; },
      async cleanup(request) {
        calls.cleanup.push(structuredClone(request));
        if (heldCleanup) await heldCleanup.promise;
        if (cleanupRejection) throw Object.assign(new Error('Synthetic rejected cleanup'), { code: cleanupRejection, details: outcome('cleanup', request.id, false) });
        if (cleanupFailure) throw Object.assign(new Error('Synthetic credential cleanup failed'), { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED', details: { ...outcome('cleanup', request.id), cleanupCompleted: false } });
        main.cleanups = main.cleanups.filter((entry) => entry.id !== request.id);
        return outcome('cleanup', request.id);
      },
      async reviewCleanup(id) {
        calls.reviewCleanup.push(id);
        if (heldReviewCleanup) await heldReviewCleanup.promise;
        if (reviewFailure) throw new Error(reviewFailure);
        return structuredClone(reviewResponse);
      },
      async remove(id) {
        calls.remove++; if (heldRemove) await heldRemove.promise;
        main.providers = main.providers.filter((p) => p.id !== id); if (main.settings.preferredProviderId === id) main.settings.preferredProviderId = null;
        if (cleanupFailure) {
          main.cleanups = [cleanupDescriptor({ id })];
          throw Object.assign(new Error('Synthetic credential cleanup failed'), { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED', details: { ...outcome('remove', id), providerRemoved: true } });
        }
        return outcome('remove', id);
      }
    } }
  };
  const actions = vm.runInNewContext(`(() => {
    let modalGeneration = 0, providerRefreshSequence = 0, authorityMutationSequence = 0;
    let authorityMutationTail = Promise.resolve();
    const pendingProviderMutations = new Map(), providerCleanupRecovery = new Map();
    let providerOutcomeRecovery = null, providerSnapshotPending = false;
    function showModal(...children) { installModal(...children); return ++modalGeneration; }
    function closeModal() { hideModal(); modalGeneration++; }
    ${extract('function queueAuthorityMutation(task) {', '\nfunction activeTab()')}
    ${extract('async function refreshProviders(', '\nfunction modalHeader(')}
    ${extract('let formFieldSequence = 0;', '\nasync function updateSettings(')}
    return { setPreferred, toggleProvider, openProviderModal, openProviderRecoveryModal, confirmProviderRemoval, recoverProviderSnapshot, retryProviderCleanup, openProviderCleanupLookup, refreshProviders, publishProviderCleanupBootstrap,
      publishSnapshot: (snapshot) => { if (validProviderSnapshot(snapshot)) publishProviderSnapshot(snapshot); else markProviderOutcomeUnknown('Synthetic invalid snapshot'); },
      recovery: () => providerOutcomeRecovery, cleanups: () => [...providerCleanupRecovery.values()],
      snapshotPending: () => providerSnapshotPending, pending: () => pendingProviderMutations.size, holdAuthority: (gate) => queueAuthorityMutation(() => gate), replace: () => showModal(h('p', {}, 'Replacement')) };
  })()`, scope);
  const renderProviders = vm.runInNewContext(`(${views.slice(views.indexOf('export function renderProviders(') + 7, views.indexOf('\nfunction settingRow('))})`, {
    ...helpers, ...recoveryHelpers, providerHealthPresentation,
    pageHeader: (eyebrow, title, description, actions) => helpers.h('header', {}, eyebrow, title, description, actions),
    card: (...values) => helpers.h('div', {}, values), section: (...values) => helpers.h('section', {}, values),
    badge: (value) => helpers.h('span', {}, value), emptyState: (...values) => helpers.h('div', {}, values),
    settingRow: (...values) => helpers.h('div', {}, values), toggleControl: () => helpers.h('button')
  });
  return { ...actions, main, model, calls, toasts, document, modal: () => modal,
    view: () => renderProviders(model, { ...actions, providerMutationRecovery: actions.recovery,
      providerCleanupFailures: actions.cleanups, providerSnapshotPending: actions.snapshotPending,
      providerMutationPending: () => actions.pending() > 0, updateSettings() {}, refreshProviders() {} }),
    failLists() { listFailure = true; }, failCleanup() { cleanupFailure = true; },
    failCleanupReads(value = true) { cleanupReadFailure = value; },
    rejectCleanup(code = 'PROVIDER_CLEANUP_STALE') { cleanupRejection = code; },
    restoreCleanupRejection() { cleanupRejection = null; },
    holdCleanup() { heldCleanup = deferred(); return heldCleanup.resolve; },
    holdReviewCleanup() { heldReviewCleanup = deferred(); return heldReviewCleanup.resolve; },
    reviewResponse(value) { reviewResponse = value; }, reviewFailure(value) { reviewFailure = value; },
    transformSnapshot(value) { snapshotTransform = value; },
    restoreReads() { listFailure = false; }, restoreCleanup() { cleanupFailure = false; },
    malformed() { malformed = true; }, reject() { rejected = true; },
    transform(value) { transform = value; },
    route(value) { route = value; }, repaints: () => repaints,
    holdUpsert() { heldUpsert = deferred(); return heldUpsert.resolve; },
    holdRecovery() { heldRecovery = deferred(); return heldRecovery.resolve; },
    rejectRecovery(code = 'SECURE_STORAGE_WRITE_FAILED') { recoveryFailure = code; },
    restoreRecovery() { recoveryFailure = null; },
    holdSnapshot() { heldSnapshot = deferred(); return heldSnapshot.resolve; },
    failSnapshot(value = true) { snapshotFailure = value; },
    holdRemoval() { heldRemove = deferred(); return heldRemove.resolve; }
  };
}
function click(f, label) { const button = f.modal()?.querySelectorAll('button').find((n) => text(n) === label); assert.ok(button, label); return button.listeners.click(); }
function cleanupControls(f) {
  return { acknowledgement: f.modal().querySelectorAll('input').find((node) => node.type === 'checkbox'),
    submit: f.modal().querySelectorAll('button').find((node) => text(node) === 'Delete retained sign-in storage') };
}
function acknowledgeCleanup(f) { const controls = cleanupControls(f); controls.acknowledgement.checked = true; controls.acknowledgement.listeners.change(); return controls; }
async function cleanupFixture(entry = cleanupDescriptor()) {
  const f = fixture(); f.main.providers = []; f.model.providers = []; f.main.cleanups = [entry];
  await f.recoverProviderSnapshot(); return f;
}

test('restart bootstrap publishes pending cleanup independently of provider configuration', async () => {
  const f = fixture(); f.main.providers = []; f.model.providers = [];
  const bootstrapData = { state: { settings: { ...f.model.settings, restoreSession: true, offlineMode: true },
    tabs: [{ id: 'restart-tab', target: 'satnav://providers', historyIndex: 0 }], activeTabId: 'restart-tab', history: [], bookmarks: [] },
    providers: [], providerCleanup: { cleanups: [cleanupDescriptor()] }, cache: {}, wallet: null, services: [] };
  const renderedCleanupCounts = [];
  const boot = vm.runInNewContext(`(() => {
    let bootstrapRunning = false, navigationReady = false, pendingShellDeepLink = null;
    ${extract('async function bootstrap() {', '\nbootstrap();')}
    return bootstrap;
  })()`, {
    elements: { app: new N('main') }, api: { app: { bootstrap: async () => bootstrapData } }, installEvents() {},
    safeTab: (tab) => tab, state: () => f.model, MODEL: { set: (value) => Object.assign(f.model, value) },
    publishProviderCleanupBootstrap: f.publishProviderCleanupBootstrap,
    applyTheme() {}, renderChrome() {}, renderDrawer() {}, renderPage: () => renderedCleanupCounts.push(f.cleanups().length),
    activeTab: () => f.model.tabs[0], navigate: async () => {}, toast() {}, startProviderStatusMonitor() {}
  });
  await boot();
  assert.equal(f.cleanups().length, 1); assert.equal(f.cleanups()[0].token, cleanupToken);
  assert.deepEqual(renderedCleanupCounts, [1]);
  assert.equal(f.calls.snapshot, 0); assert.equal(f.calls.reviewCleanup.length, 0); assert.equal(f.calls.cleanup.length, 0);
  assert.match(text(f.view()), /Source source-a was removed/);
  f.retryProviderCleanup(initial.id); assert.equal(cleanupControls(f).acknowledgement.checked, false);
});

test('missing or failed bootstrap cleanup state preserves known obligations and requires read-only recovery', async () => {
  for (const snapshot of [undefined, {}, { cleanups: [{}] }, { cleanups: null, stateReadErrors: { cleanups: { code: 'READ', message: 'Synthetic read failure' } } }]) {
    const f = await cleanupFixture(); const retained = f.cleanups()[0];
    f.publishProviderCleanupBootstrap(snapshot);
    assert.equal(f.cleanups()[0], retained); assert.ok(f.recovery());
    await f.toggleProvider(initial); assert.equal(f.calls.upsert, 0);
    await f.recoverProviderSnapshot(); assert.equal(f.recovery(), null); assert.equal(f.cleanups()[0].id, initial.id);
  }
});

test('lost remove response is discovered by snapshot refresh without replaying removal or cleanup', async () => {
  const f = fixture(); f.failCleanup(); f.malformed();
  f.confirmProviderRemoval(initial); await click(f, 'Remove permanently');
  assert.equal(f.main.providers.length, 0); assert.equal(f.main.cleanups.length, 1);
  assert.equal(f.cleanups().length, 0); assert.ok(f.recovery());
  await f.recoverProviderSnapshot();
  assert.equal(f.model.providers.length, 0); assert.equal(f.cleanups()[0].token, cleanupToken);
  assert.equal(f.calls.remove, 1); assert.equal(f.calls.cleanup.length, 0); assert.equal(f.recovery(), null);
});

test('health and list refreshes never erase pending cleanup state or resolve its read failure', async () => {
  const f = await cleanupFixture(); f.failCleanupReads(); await f.recoverProviderSnapshot();
  const retained = f.cleanups()[0]; const recovery = f.recovery();
  await f.refreshProviders();
  assert.equal(f.calls.health, 1); assert.equal(f.calls.list, 1);
  assert.equal(f.cleanups()[0], retained); assert.equal(f.recovery(), recovery);
  assert.equal(f.calls.remove, 0); assert.equal(f.calls.cleanup.length, 0);
});

test('cleanup read failure publishes independent fields while retaining the old cleanup map', async () => {
  const f = await cleanupFixture(); f.failCleanupReads();
  f.main.settings.preferredProviderId = 'source-b';
  f.main.providers = [{ ...initial, id: 'source-b' }];
  await f.recoverProviderSnapshot();
  assert.equal(f.model.providers[0].id, 'source-b'); assert.equal(f.model.settings.preferredProviderId, 'source-b');
  assert.equal(f.cleanups()[0].token, cleanupToken); assert.ok(f.recovery());
  f.failCleanupReads(false); f.main.cleanups = []; await f.recoverProviderSnapshot();
  assert.equal(f.cleanups().length, 0); assert.equal(f.recovery(), null);
});

test('omitted, malformed, duplicate and contradictory cleanup snapshots retain the map and block mutations', async () => {
  const invalid = [
    (value) => { const { cleanups, ...rest } = value; return rest; },
    (value) => ({ ...value, cleanups: null }),
    (value) => ({ ...value, cleanups: [{}] }),
    (value) => ({ ...value, cleanups: [cleanupDescriptor(), cleanupDescriptor()] }),
    (value) => ({ ...value, cleanups: [cleanupDescriptor({ id: '../source-a' })] }),
    (value) => ({ ...value, cleanups: [cleanupDescriptor({ generation: null })] }),
    (value) => ({ ...value, cleanups: [cleanupDescriptor({ token: 'not-a-token' })] }),
    (value) => ({ ...value, cleanups: [cleanupDescriptor({ conflict: true })] }),
    (value) => ({ ...value, stateReadErrors: { cleanups: { code: 'READ', message: 'Contradictory read error' } } })
  ];
  for (const transform of invalid) {
    const f = await cleanupFixture(); const retained = f.cleanups()[0];
    f.transformSnapshot(transform); await f.recoverProviderSnapshot();
    assert.equal(f.cleanups()[0], retained); assert.ok(f.recovery());
    f.retryProviderCleanup(initial.id); assert.equal(f.modal(), null);
    await f.setPreferred(null); assert.equal(f.calls.preferred.length, 0);
    assert.equal(f.calls.cleanup.length, 0);
  }
});

test('cleanup is an exact ID-only acknowledged deletion and cancellation cannot authorize later actions', async () => {
  const f = await cleanupFixture(); f.retryProviderCleanup(initial.id);
  let controls = cleanupControls(f);
  assert.equal(controls.submit.disabled, true); assert.equal(controls.acknowledgement.checked, false);
  assert.match(text(f.modal()), /Exact source IDsource-a/);
  assert.match(text(f.modal()), /No endpoint or account identity can be confirmed/);
  assert.match(text(f.modal()), /Bitcoin Core cookie files.*preserved/);
  await controls.submit.listeners.click(); assert.equal(f.calls.cleanup.length, 0);
  controls = acknowledgeCleanup(f); const cancel = f.modal().querySelectorAll('button').find((node) => text(node) === 'Cancel');
  await cancel.listeners.click(); f.replace(); const replacement = f.modal();
  await controls.submit.listeners.click(); await cancel.listeners.click();
  assert.equal(f.modal(), replacement); assert.equal(f.calls.cleanup.length, 0);
  f.retryProviderCleanup(initial.id); controls = cleanupControls(f);
  assert.equal(controls.acknowledgement.checked, false);
  acknowledgeCleanup(f); await controls.submit.listeners.click();
  assert.deepEqual(f.calls.cleanup, [{ id: initial.id, token: cleanupToken }]);
  assert.equal(f.calls.remove, 0); assert.equal(f.cleanups().length, 0); assert.equal(f.modal(), null);
});

test('cleanup double-submit and late completion preserve a newer source draft, focus and unrelated route', async () => {
  const f = await cleanupFixture(); const release = f.holdCleanup();
  f.retryProviderCleanup(initial.id); const controls = acknowledgeCleanup(f);
  const first = controls.submit.listeners.click(); await controls.submit.listeners.click(); await Promise.resolve();
  assert.equal(f.calls.cleanup.length, 1); assert.equal(controls.submit.disabled, true);
  await click(f, 'Close'); f.openProviderModal();
  const replacement = f.modal(); const draft = replacement.querySelectorAll('input')[1]; draft.value = 'Unrelated draft';
  draft.focus(); f.route('settings'); const repaints = f.repaints();
  release(); await first; controls.acknowledgement.listeners.change(); await controls.submit.listeners.click();
  assert.equal(f.calls.cleanup.length, 1); assert.equal(f.modal(), replacement); assert.equal(draft.value, 'Unrelated draft');
  assert.equal(f.document.activeElement, draft); assert.equal(f.repaints(), repaints); assert.equal(controls.submit.disabled, true);
});

test('queued cleanup rejects changed tokens, generations, removed obligations, configured conflicts and closed reviews', async () => {
  const changes = [
    (f) => { f.main.cleanups = [cleanupDescriptor({ token: nextCleanupToken })]; f.publishSnapshot(f.main); },
    (f) => { f.main.cleanups = [cleanupDescriptor({ generation: nextCleanupToken })]; f.publishSnapshot(f.main); },
    (f) => { f.main.cleanups = []; f.publishSnapshot(f.main); },
    (f) => { f.model.providers = [structuredClone(initial)]; },
    (f) => { f.main.cleanups = [cleanupDescriptor({ conflict: true, token: null })]; f.publishSnapshot(f.main); },
    (f) => { f.replace(); }
  ];
  for (const change of changes) {
    const f = await cleanupFixture(); const gate = deferred(); const held = f.holdAuthority(gate.promise);
    f.retryProviderCleanup(initial.id); const controls = acknowledgeCleanup(f); const mutation = controls.submit.listeners.click();
    change(f); gate.resolve(); await Promise.all([held, mutation]);
    assert.equal(f.calls.cleanup.length, 0); assert.equal(f.calls.remove, 0); assert.equal(controls.submit.disabled, true);
    await controls.submit.listeners.click(); assert.equal(f.calls.cleanup.length, 0);
    assert.equal(f.toasts.at(-1)[0], 'Cleanup review expired');
  }
});

test('a stale cleanup rejection publishes a fresh token but cannot submit it without a new acknowledgment', async () => {
  const f = await cleanupFixture(); f.retryProviderCleanup(initial.id); const controls = acknowledgeCleanup(f);
  f.main.cleanups = [cleanupDescriptor({ token: nextCleanupToken })]; f.rejectCleanup();
  await controls.submit.listeners.click();
  assert.equal(f.calls.cleanup[0].token, cleanupToken); assert.equal(f.cleanups()[0].token, nextCleanupToken);
  assert.match(text(f.modal()), /fresh deletion review/); assert.equal(controls.submit.disabled, true);
  controls.acknowledgement.listeners.change(); await controls.submit.listeners.click(); assert.equal(f.calls.cleanup.length, 1);
  await click(f, 'Close'); f.restoreCleanupRejection(); f.retryProviderCleanup(initial.id);
  const fresh = cleanupControls(f); assert.equal(fresh.acknowledgement.checked, false);
  acknowledgeCleanup(f); await fresh.submit.listeners.click();
  assert.equal(f.calls.cleanup.length, 2); assert.equal(f.calls.cleanup[1].token, nextCleanupToken);
});

test('partial cleanup commitment reports saved cleanup state without claiming storage deletion completed', async () => {
  const f = await cleanupFixture(); f.failCleanup(); f.retryProviderCleanup(initial.id);
  const controls = acknowledgeCleanup(f); await controls.submit.listeners.click();
  assert.equal(f.toasts.at(-1)[0], 'Cleanup state saved; recovery needed');
  assert.equal(f.cleanups().length, 1); assert.equal(f.calls.cleanup.length, 1);
  await f.recoverProviderSnapshot(); assert.equal(f.calls.cleanup.length, 1);
});

test('lost cleanup response retains the warning until read-only refresh and never replays deletion', async () => {
  const f = await cleanupFixture(); f.malformed(); f.retryProviderCleanup(initial.id);
  const controls = acknowledgeCleanup(f); await controls.submit.listeners.click();
  assert.equal(f.main.cleanups.length, 0); assert.equal(f.cleanups().length, 1); assert.ok(f.recovery());
  assert.match(text(f.modal()), /This cleanup will not be sent again/);
  await f.recoverProviderSnapshot();
  assert.equal(f.cleanups().length, 0); assert.equal(f.recovery(), null);
  await controls.submit.listeners.click();
  assert.equal(f.calls.cleanup.length, 1); assert.equal(f.calls.remove, 0);
});

test('late cleanup rejection preserves a replacement modal and requires another explicit review', async () => {
  const f = await cleanupFixture(); const release = f.holdCleanup(); f.rejectCleanup();
  f.retryProviderCleanup(initial.id); const controls = acknowledgeCleanup(f); const cleanup = controls.submit.listeners.click();
  await Promise.resolve(); f.replace(); const replacement = f.modal(); release(); await cleanup;
  assert.equal(f.modal(), replacement); assert.equal(text(replacement), 'Replacement');
  await controls.submit.listeners.click(); assert.equal(f.calls.cleanup.length, 1); assert.equal(f.calls.remove, 0);
});

test('conflicted or unavailable-token descriptors expose no deletion action and preserve source controls', async () => {
  for (const entry of [cleanupDescriptor({ conflict: true, token: null }), cleanupDescriptor({ token: null })]) {
    const f = await cleanupFixture(entry); const view = f.view();
    assert.equal(view.querySelectorAll('button').some((node) => text(node) === 'Review credential cleanup'), false);
    f.retryProviderCleanup(initial.id); assert.equal(f.modal(), null); assert.equal(f.calls.cleanup.length, 0);
    assert.ok(view.querySelectorAll('button').some((node) => text(node).endsWith('Add source')));
  }
  const f = await cleanupFixture(); f.model.providers = [structuredClone(initial)];
  const view = f.view(); assert.match(text(view), /conflicts with a configured source/);
  for (const label of ['Edit', 'Prefer']) assert.ok(view.querySelectorAll('button').some((node) => text(node) === label));
  assert.equal(view.querySelectorAll('button').some((node) => text(node) === 'Review credential cleanup'), false);
});

test('advanced historical lookup is collapsed, exact and read-only until a separate deletion acknowledgment', async () => {
  const f = fixture(); f.main.providers = []; f.model.providers = [];
  const advanced = f.view().querySelector('details');
  assert.equal(advanced.getAttribute('open'), null); assert.equal(f.calls.reviewCleanup.length, 0);
  advanced.querySelector('button').listeners.click();
  const input = f.modal().querySelector('input'); input.value = initial.id;
  await click(f, 'Review exact source ID');
  assert.deepEqual(f.calls.reviewCleanup, [initial.id]); assert.equal(f.calls.cleanup.length, 0); assert.equal(f.calls.remove, 0);
  assert.equal(f.cleanups().length, 0, 'A historical review does not invent a durable cleanup record');
  assert.match(text(f.modal()), /does not establish when or whether a source was removed/);
  const controls = cleanupControls(f); assert.equal(controls.acknowledgement.checked, false); assert.equal(controls.submit.disabled, true);
  acknowledgeCleanup(f); await controls.submit.listeners.click();
  assert.deepEqual(f.calls.cleanup, [{ id: initial.id, token: cleanupToken }]); assert.equal(f.calls.remove, 0);
});

test('historical lookup rejects invalid IDs and configured IDs without eager API calls', async () => {
  for (const id of ['', ' source-a ', '../source-a', 'ab', 'x'.repeat(81), initial.id]) {
    const f = fixture(); f.openProviderCleanupLookup(); f.modal().querySelector('input').value = id;
    await click(f, 'Review exact source ID'); assert.equal(f.calls.reviewCleanup.length, 0); assert.equal(f.calls.cleanup.length, 0);
    assert.ok(/Enter the exact source ID|This ID is configured/.test(text(f.modal())));
  }
});

test('historical lookup owns delayed results and cannot replace a newer modal or reuse a cancelled result', async () => {
  for (const reject of [false, true]) {
    const f = fixture(); f.model.providers = []; f.main.providers = [];
    const release = f.holdReviewCleanup(); if (reject) f.reviewFailure('Synthetic unavailable historical state');
    f.openProviderCleanupLookup(); f.modal().querySelector('input').value = initial.id;
    const lookup = click(f, 'Review exact source ID'); await click(f, 'Review exact source ID');
    await click(f, 'Cancel'); f.openProviderModal(); const replacement = f.modal();
    const draft = replacement.querySelectorAll('input')[1]; draft.value = 'Keep this draft';
    release(); await lookup;
    assert.equal(f.calls.reviewCleanup.length, 1); assert.equal(f.modal(), replacement); assert.equal(draft.value, 'Keep this draft');
    assert.equal(f.calls.cleanup.length, 0);
  }
});

test('historical lookup refuses malformed, mismatched, conflicted and absent-storage responses', async () => {
  for (const response of [{}, cleanupDescriptor({ generation: null, id: 'source-b' }), cleanupDescriptor({ generation: null, conflict: true, token: null }), null]) {
    const f = fixture(); f.model.providers = []; f.main.providers = [];
    if (response) f.reviewResponse(response); else f.reviewFailure('No retained app-owned storage for this ID.');
    f.openProviderCleanupLookup(); f.modal().querySelector('input').value = initial.id;
    await click(f, 'Review exact source ID');
    assert.equal(cleanupControls(f).submit, undefined); assert.equal(f.calls.cleanup.length, 0); assert.equal(f.cleanups().length, 0);
    assert.match(text(f.modal()), /No current deletion review|No retained app-owned storage/);
  }
});

test('historical review expires on source-state publication both during lookup and before queued cleanup', async () => {
  const f = fixture(); f.main.providers = []; f.model.providers = [];
  const release = f.holdReviewCleanup(); f.openProviderCleanupLookup(); f.modal().querySelector('input').value = initial.id;
  const lookup = click(f, 'Review exact source ID'); await f.recoverProviderSnapshot(); release(); await lookup;
  assert.match(text(f.modal()), /Source state changed during the lookup/); assert.equal(f.calls.cleanup.length, 0);
  await click(f, 'Review exact source ID');
  const gate = deferred(); const held = f.holdAuthority(gate.promise);
  const controls = acknowledgeCleanup(f); const cleanup = controls.submit.listeners.click();
  f.publishSnapshot(f.main); gate.resolve(); await Promise.all([held, cleanup]);
  assert.equal(f.calls.cleanup.length, 0); assert.match(text(f.modal()), /deletion review expired/);
});

test('successful source Save publishes committed descriptor and closes its owner', async () => {
  const f = fixture(); f.openProviderModal(initial);
  await click(f, 'Save source');
  assert.equal(f.calls.upsert, 1);
  assert.deepEqual(f.model.providers, f.main.providers);
  assert.equal(f.modal(), null);
  assert.equal(f.toasts.at(-1)[0], 'Source saved');
  assert.equal(f.calls.list, 0, 'The committed envelope needs no second list read');
});

test('Prefer A then Remove A publishes the cleared authoritative preference', async () => {
  const f = fixture(); await f.setPreferred(initial.id);
  assert.equal(f.model.settings.preferredProviderId, initial.id);
  f.confirmProviderRemoval(initial); await click(f, 'Remove permanently');
  assert.equal(f.main.settings.preferredProviderId, null);
  assert.equal(f.model.settings.preferredProviderId, null);
  assert.deepEqual(f.model.providers, []);
});

test('committed Toggle followed by failed list read does not present stale enabled state as settled', async () => {
  const f = fixture(); f.failLists();
  await f.toggleProvider(initial);
  assert.equal(f.main.providers[0].enabled, false);
  assert.ok(f.model.providers[0]?.enabled === false || /saved|updated|committed|refresh|recovery|outcome/i.test(f.toasts.at(-1)?.[0] ?? ''), 'Committed toggle must publish state or explicit reconciliation/outcome recovery');
});

test('committed Save followed by failed list reads is distinguished from rejected Save', async () => {
  const f = fixture(); f.openProviderModal(initial); f.failLists();
  await click(f, 'Save source');
  assert.equal(f.calls.upsert, 1);
  assert.ok(/saved|committed|refresh|recovery|outcome/i.test(f.toasts.at(-1)?.[0] ?? ''), 'Successful upsert must not be described only as Could not save');
  assert.equal(f.modal(), null);
  assert.ok(f.recovery());
  await f.toggleProvider(initial);
  assert.equal(f.calls.upsert, 1, 'Unknown snapshot blocks replay');
});

test('removed provider with cleanup and reconciliation failures exposes read-only recovery', async () => {
  const f = fixture(); f.failCleanup(); f.failLists();
  f.confirmProviderRemoval(initial); await click(f, 'Remove permanently');
  assert.equal(f.main.providers.length, 0);
  assert.ok(f.modal()?.querySelectorAll('button').some((n) => /refresh|recover|retry/i.test(text(n))) || /refresh|recover|retry/i.test(f.toasts.at(-1)?.[1] ?? ''), 'Unknown snapshot needs an explicit recovery affordance or instruction');
  assert.equal(f.calls.remove, 1);
  assert.equal(f.cleanups()[0].id, initial.id, 'Cleanup remains available without a provider card');
  f.restoreReads(); await f.recoverProviderSnapshot();
  assert.equal(f.calls.remove, 1, 'Snapshot recovery is read-only');
  assert.deepEqual(f.model.providers, []);
  assert.equal(f.recovery(), null);
  assert.equal(f.cleanups().length, 1);
  f.restoreCleanup(); await f.retryProviderCleanup(initial.id);
  const cleanup = acknowledgeCleanup(f); await cleanup.submit.listeners.click();
  assert.equal(f.calls.remove, 1, 'Cleanup never replays ordinary removal');
  assert.equal(f.calls.cleanup.length, 1, 'Cleanup requires a separately acknowledged mutation');
  assert.equal(f.cleanups().length, 0);
});

test('late successful removal cannot close a replacement modal', async () => {
  const f = fixture(); const release = f.holdRemoval(); f.confirmProviderRemoval(initial);
  const removal = click(f, 'Remove permanently'); f.replace(); const replacement = f.modal();
  release(); await removal;
  assert.equal(f.modal(), replacement);
  assert.deepEqual(f.model.providers, []);
});

test('pending same-source Toggle is deduplicated before queue admission', async () => {
  const f = fixture(); const release = f.holdUpsert();
  const a = f.toggleProvider(initial); const b = f.toggleProvider(initial);
  await Promise.resolve();
  assert.equal(f.calls.upsert, 1); assert.equal(f.pending(), 1);
  release(); await Promise.all([a, b]);
  assert.equal(f.main.providers[0].enabled, false); assert.equal(f.pending(), 0);
});

test('Save snapshots click-time fields, disables replay, and retains replacement modal', async () => {
  const f = fixture(); const release = f.holdUpsert(); f.openProviderModal(initial);
  const inputs = f.modal().querySelectorAll('input'); const name = inputs[1]; name.value = 'Clicked name';
  const save = f.modal().querySelectorAll('button').find((n) => text(n) === 'Save source');
  const a = save.listeners.click(); name.value = 'Later edit';
  assert.equal(save.disabled, true); await save.listeners.click();
  f.replace(); const replacement = f.modal(); release(); await a;
  assert.equal(f.calls.upsert, 1); assert.equal(f.main.providers[0].name, 'Clicked name');
  assert.equal(f.modal(), replacement);
  await save.listeners.click(); assert.equal(f.calls.upsert, 1, 'Detached completed action cannot replay');
});

test('different preference intents are preserved in FIFO order', async () => {
  const f = fixture(); const release = f.holdUpsert(); const hold = f.toggleProvider(initial);
  const a = f.setPreferred('source-a'); const b = f.setPreferred('source-b'); const c = f.setPreferred(null);
  release(); await Promise.all([hold, a, b, c]);
  assert.deepEqual(f.calls.preferred, ['source-a', 'source-b', null]);
  assert.equal(f.model.settings.preferredProviderId, null);
});

test('malformed committed response enters unknown-state recovery without trusting descriptor', async () => {
  const f = fixture(); f.malformed(); await f.toggleProvider(initial);
  assert.equal(f.main.providers[0].enabled, false); assert.equal(f.model.providers[0].enabled, true);
  assert.ok(f.recovery()); await f.setPreferred(initial.id); assert.equal(f.calls.preferred.length, 0);
  await f.recoverProviderSnapshot(); assert.equal(f.recovery(), null);
  assert.equal(f.model.providers[0].enabled, false); assert.equal(f.calls.upsert, 1);
});

test('rejected edit retains owner, original error, and authoritative snapshot', async () => {
  const f = fixture(); f.reject(); f.openProviderModal(initial); const owner = f.modal();
  await click(f, 'Save source');
  assert.equal(f.modal(), owner); assert.equal(f.recovery(), null);
  assert.equal(f.toasts.at(-1)[0], 'Could not save source');
  assert.equal(f.toasts.at(-1)[1], 'Synthetic rejected edit');
  assert.deepEqual(f.model.providers, f.main.providers);
});

test('delayed source publication on an unrelated route never repaints that page', async () => {
  const f = fixture(); const release = f.holdUpsert(); const update = f.toggleProvider(initial);
  f.route('inscription'); const before = f.repaints(); release(); await update;
  assert.equal(f.repaints(), before); assert.equal(f.model.providers[0].enabled, false);
});

test('mismatched operation, ID, commit marker, and malformed snapshots are never published', async () => {
  const invalid = [
    (value) => ({ ...value, operation: 'remove' }),
    (value) => ({ ...value, providerId: 'other' }),
    (value) => ({ ...value, providerMutationCommitted: 'true' }),
    (value) => ({ ...value, providers: [{}] }),
    (value) => ({ ...value, settings: [] }),
    (value) => ({ ...value, providers: null }),
    (value) => { const { cleanups, ...rest } = value; return rest; },
    (value) => ({ ...value, cleanups: null }),
    (value) => ({ ...value, cleanups: [{}] }),
    (value) => ({ ...value, stateReadErrors: { providers: { code: 'ERR', message: 'Contradictory populated snapshot' } } })
  ];
  for (const transform of invalid) {
    const f = fixture(); f.transform(transform); await f.toggleProvider(initial);
    assert.ok(f.recovery()); assert.equal(f.model.providers[0].enabled, true);
    await f.toggleProvider(initial); assert.equal(f.calls.upsert, 1);
  }
});

test('cleanup obligation prevents same-ID reuse and never removes a replacement configuration', async () => {
  const f = fixture(); f.failCleanup(); f.confirmProviderRemoval(initial); await click(f, 'Remove permanently');
  f.openProviderModal(initial); await click(f, 'Save source'); assert.equal(f.calls.upsert, 0);
  f.main.providers = [structuredClone(initial)]; await f.recoverProviderSnapshot();
  await f.retryProviderCleanup(initial.id); assert.equal(f.calls.remove, 1);
  assert.equal(f.main.providers.length, 1); assert.equal(f.cleanups().length, 1);
});

test('actual Sources view exposes snapshot-only recovery and separate removed-ID cleanup action', async () => {
  const f = fixture(); f.failCleanup(); f.failLists(); f.confirmProviderRemoval(initial);
  await click(f, 'Remove permanently');
  let view = f.view(); const buttonNamed = (name) => view.querySelectorAll('button').find((node) => text(node).endsWith(name));
  assert.match(text(view), /Cleanup for source ID source-a conflicts with a configured source/);
  assert.equal(buttonNamed('Add source').disabled, true);
  assert.equal(buttonNamed('Review credential cleanup'), undefined, 'An unavailable provider read retains the card and offers no deletion of its ID');
  f.restoreReads(); await buttonNamed('Refresh source state').listeners.click();
  assert.equal(f.calls.snapshot, 1); assert.equal(f.calls.remove, 1);
  view = f.view(); assert.equal(buttonNamed('Refresh source state'), undefined);
  assert.equal(buttonNamed('Review credential cleanup').disabled, false);
  assert.equal(buttonNamed('Review credential cleanup').getAttribute('aria-label'), 'Review credential cleanup for source-a');
  f.restoreCleanup(); await buttonNamed('Review credential cleanup').listeners.click();
  const cleanup = acknowledgeCleanup(f); await cleanup.submit.listeners.click();
  assert.equal(f.calls.remove, 1); assert.equal(f.calls.cleanup.length, 1); assert.equal(f.cleanups().length, 0);
});

test('Save matches the main process normalized identifier without treating the committed result as unknown', async () => {
  const f = fixture(); f.openProviderModal(initial);
  f.modal().querySelectorAll('input')[0].value = '  source-a  ';
  await click(f, 'Save source');
  assert.equal(f.main.providers[0].id, 'source-a');
  assert.equal(f.recovery(), null);
  assert.equal(f.modal(), null);
  assert.equal(f.toasts.at(-1)[0], 'Source saved');
});

test('queued cleanup rechecks replacement ownership when admitted, not only at click', async () => {
  const f = fixture(); f.failCleanup(); f.confirmProviderRemoval(initial); await click(f, 'Remove permanently');
  const gate = deferred(); const held = f.holdAuthority(gate.promise);
  f.retryProviderCleanup(initial.id);
  const cleanup = acknowledgeCleanup(f); const retry = cleanup.submit.listeners.click();
  f.model.providers = [structuredClone(initial)]; f.main.providers = [structuredClone(initial)];
  gate.resolve(); await Promise.all([held, retry]);
  assert.equal(f.calls.remove, 1, 'Queued cleanup cannot delete a newly published replacement');
  assert.equal(f.calls.cleanup.length, 0);
  assert.equal(f.main.providers.length, 1);
  assert.equal(f.cleanups().length, 1);
});

test('snapshot recovery is serialized, deduplicated, disables controls and blocks mutations until read completion', async () => {
  const f = fixture(); f.malformed(); await f.toggleProvider(initial);
  const release = f.holdSnapshot(); const read = f.recoverProviderSnapshot();
  await Promise.resolve(); await f.recoverProviderSnapshot(); await f.setPreferred(initial.id);
  assert.equal(f.calls.snapshot, 1); assert.equal(f.calls.preferred.length, 0);
  assert.equal(f.snapshotPending(), true);
  const refresh = f.view().querySelectorAll('button').find((node) => text(node) === 'Refresh source state');
  assert.equal(refresh.disabled, true);
  release(); await read;
  assert.equal(f.snapshotPending(), false); assert.equal(f.recovery(), null);
  assert.equal(f.model.providers[0].enabled, false);
});

test('failed read-only recovery remains actionable and never replays the committed mutation', async () => {
  const f = fixture(); f.failLists(); await f.toggleProvider(initial); f.failSnapshot();
  await f.recoverProviderSnapshot();
  assert.ok(f.recovery()); assert.equal(f.snapshotPending(), false);
  assert.equal(f.toasts.at(-1)[1], 'Synthetic read-only refresh failure');
  assert.equal(f.calls.upsert, 1);
  f.failSnapshot(false); f.restoreReads(); await f.recoverProviderSnapshot();
  assert.equal(f.recovery(), null); assert.equal(f.calls.upsert, 1);
});

test('settings-read failure publishes valid provider field but retains old settings until explicit recovery', async () => {
  const f = fixture(); await f.setPreferred(initial.id);
  f.transform((value) => ({ ...value, settings: null, stateReadErrors: { settings: { code: 'TEST_READ', message: 'Synthetic settings read unavailable' } } }));
  f.confirmProviderRemoval(initial); await click(f, 'Remove permanently');
  assert.deepEqual(f.model.providers, []);
  assert.equal(f.model.settings.preferredProviderId, initial.id, 'Unknown settings are retained and marked incomplete, not fabricated');
  assert.ok(f.recovery()); assert.equal(f.modal(), null);
  await f.recoverProviderSnapshot();
  assert.equal(f.model.settings.preferredProviderId, null); assert.equal(f.recovery(), null);
  assert.equal(f.calls.remove, 1);
});

test('replacement Add dialog reports same-ID pending edit without joining its callbacks or replaying fields', async () => {
  const f = fixture(); const release = f.holdUpsert(); f.openProviderModal();
  let inputs = f.modal().querySelectorAll('input'); inputs[0].value = 'source-a'; inputs[1].value = 'First name';
  const first = click(f, 'Save source'); await click(f, 'Cancel');
  f.openProviderModal(); inputs = f.modal().querySelectorAll('input'); inputs[0].value = 'source-a'; inputs[1].value = 'Second name';
  const replacement = f.modal(); const second = click(f, 'Save source');
  assert.match(f.toasts.at(-1)?.[1] ?? '', /this edit was not sent/i);
  assert.equal(f.modal(), replacement);
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.upsert, 1); assert.equal(f.main.providers[0].name, 'First name');
  assert.equal(f.modal(), replacement); assert.equal(inputs[1].value, 'Second name');
});

const recoveryToken = '1ec9667e-2b4e-4e44-a9b0-d79c61023111';
const nextRecoveryToken = '1ec9667e-2b4e-4e44-a9b0-d79c61023222';
function blockedSource(overrides = {}) {
  return { ...initial, type: 'bitcoin-core', name: 'Reviewed Core', baseUrl: 'http://127.0.0.1:8332', credentialsStored: true,
    routingBlocked: true, routingError: { code: 'PROVIDER_CREDENTIAL_RECOVERY_REQUIRED' },
    credentialRecovery: { token: recoveryToken, mode: 'replace-basic' }, ...overrides };
}
function recoveryControls(f) {
  const inputs = f.modal().querySelectorAll('input');
  return { username: inputs.find((input) => input.type !== 'checkbox' && input.type !== 'password'),
    password: inputs.find((input) => input.type === 'password'), acknowledgement: inputs.find((input) => input.type === 'checkbox'),
    submit: f.modal().querySelectorAll('button').find((node) => /^(Replace sign-in details|Clear stored sign-in details)$/.test(text(node))) };
}
function acknowledgeRecovery(controls, username = 'synthetic-rpc-user', password = 'synthetic-rpc-password') {
  if (controls.username) controls.username.value = username;
  if (controls.password) controls.password.value = password;
  controls.acknowledgement.checked = true;
  controls.acknowledgement.listeners.change();
}

test('credential-blocked cards explain each recovery state and retain existing source controls', () => {
  const cases = [
    ['PROVIDER_CREDENTIAL_RECOVERY_REQUIRED', /previous sign-in change did not finish/i],
    ['PROVIDER_CREDENTIAL_STATE_INVALID', /cannot read the saved sign-in recovery information/i],
    ['PROVIDER_CREDENTIAL_BINDING_MISMATCH', /different source address, network, or authentication method/i],
    ['PROVIDER_LEGACY_CREDENTIAL_RECOVERY_REQUIRED', /restored from older saved data/i],
    ['SECURE_STORAGE_ROLLBACK_FAILED', /could not restore the previous saved sign-in state/i]
  ];
  for (const [code, explanation] of cases) {
    const f = fixture(blockedSource({ routingError: { code }, health: { ok: false, error: { code } } }));
    const view = f.view(); const buttons = view.querySelectorAll('button');
    assert.match(text(view), explanation); assert.match(text(view), /SIGN-IN RECOVERY NEEDED/);
    assert.equal(text(view).includes(code), false, 'Recovery status is plain language rather than only an internal code');
    for (const label of ['Recover source', 'Edit', 'Prefer', 'Add source']) assert.ok(buttons.some((node) => text(node).endsWith(label)), label);
    assert.ok(buttons.some((node) => /Health check/.test(text(node))));
    assert.ok(buttons.some((node) => node.getAttribute('aria-label') === 'Toggle Reviewed Core'));
    buttons.find((node) => text(node) === 'Recover source').listeners.click();
    assert.match(text(f.modal()), explanation);
  }
  const healthy = fixture();
  assert.equal(healthy.view().querySelectorAll('button').some((node) => text(node) === 'Recover source'), false);
  const busy = fixture(blockedSource({ routingError: { code: 'PROVIDER_BUSY' } }));
  assert.equal(busy.view().querySelectorAll('button').some((node) => text(node) === 'Recover source'), false);
  for (const overrides of [{ credentialRecovery: undefined }, { credentialRecovery: { token: recoveryToken, mode: 'clear-stored' } }, { routingError: { code: '__proto__' } }]) {
    const unavailable = fixture(blockedSource(overrides));
    assert.equal(unavailable.view().querySelectorAll('button').some((node) => text(node) === 'Recover source'), false);
  }
});

test('Core recovery reviews destination, requires acknowledgment and both fresh values, and publishes committed state', async () => {
  const provider = blockedSource(); const f = fixture(provider);
  f.main.settings.preferredProviderId = provider.id; f.model.settings.preferredProviderId = provider.id;
  f.openProviderRecoveryModal(provider);
  const controls = recoveryControls(f);
  for (const detail of [provider.name, provider.baseUrl, provider.network, 'RPC username and password']) assert.ok(text(f.modal()).includes(detail));
  assert.equal(controls.username.value, ''); assert.equal(controls.password.value, '');
  assert.equal(controls.acknowledgement.checked, false); assert.equal(controls.submit.disabled, true);
  await controls.submit.listeners.click(); assert.equal(f.calls.recover.length, 0);
  acknowledgeRecovery(controls, ' synthetic user ', ' synthetic password ');
  assert.equal(controls.submit.disabled, false);
  const saved = controls.submit.listeners.click();
  assert.equal(controls.username.value, ''); assert.equal(controls.password.value, '');
  assert.equal(controls.submit.disabled, true);
  await saved;
  assert.deepEqual(f.calls.recover, [{ id: provider.id, token: recoveryToken, mode: 'replace-basic', credentials: { username: ' synthetic user ', password: ' synthetic password ' } }]);
  assert.deepEqual(f.model.providers, f.main.providers); assert.equal(f.model.providers[0].routingBlocked, undefined);
  assert.equal(f.model.settings.preferredProviderId, provider.id);
  for (const key of ['baseUrl', 'network', 'cookieFile', 'enabled', 'priority']) assert.equal(f.model.providers[0][key], provider[key]);
  assert.equal(f.calls.upsert, 0); assert.equal(f.calls.snapshot, 0); assert.equal(f.modal(), null);
  assert.equal(f.toasts.at(-1)[0], 'Source recovered');
});

test('replacement credentials reject partial, oversized, colon and control input without sending or retaining values', async () => {
  for (const [username, password] of [
    ['', 'test'], ['test', ''], ['test:name', 'test'], ['test\nname', 'test'], ['test', 'test\u007f'],
    ['u'.repeat(257), 'test'], ['test', 'p'.repeat(4097)]
  ]) {
    const f = fixture(blockedSource()); f.openProviderRecoveryModal(f.model.providers[0]);
    const controls = recoveryControls(f); acknowledgeRecovery(controls, username, password);
    await controls.submit.listeners.click();
    assert.equal(f.calls.recover.length, 0); assert.equal(f.pending(), 0);
    assert.equal(controls.username.value, ''); assert.equal(controls.password.value, '');
    assert.match(text(f.modal()), /Neither field can be empty|no colon or control characters|no control characters/);
  }
  assert.equal(recoveryHelpers.providerRecoveryCredentialError('u'.repeat(256), 'p'.repeat(4096)), null);
});

test('Core recovery offers a separate acknowledged no-stored-authentication review without reusing the Basic draft', async () => {
  const f = fixture(blockedSource()); f.openProviderRecoveryModal(f.model.providers[0]);
  const previous = recoveryControls(f); acknowledgeRecovery(previous);
  await click(f, 'Use no stored sign-in details');
  assert.equal(previous.username.value, ''); assert.equal(previous.password.value, '');
  const controls = recoveryControls(f);
  assert.equal(controls.username, undefined); assert.equal(controls.password, undefined);
  assert.equal(controls.acknowledgement.checked, false); assert.equal(controls.submit.disabled, true);
  assert.match(text(f.modal()), /does not change server authentication requirements/);
  await previous.submit.listeners.click(); assert.equal(f.calls.recover.length, 0);
  acknowledgeRecovery(controls); await controls.submit.listeners.click();
  assert.deepEqual(f.calls.recover, [{ id: initial.id, token: recoveryToken, mode: 'clear-stored' }]);
  assert.equal(f.calls.upsert, 0); assert.equal(f.modal(), null);
});

test('returning from no-stored-authentication recovery requires fresh Basic fields and acknowledgment', async () => {
  const f = fixture(blockedSource()); f.openProviderRecoveryModal(f.model.providers[0]);
  await click(f, 'Use no stored sign-in details');
  const noAuth = recoveryControls(f); acknowledgeRecovery(noAuth);
  await click(f, 'Use RPC sign-in instead');
  const basic = recoveryControls(f);
  assert.equal(basic.username.value, ''); assert.equal(basic.password.value, '');
  assert.equal(basic.acknowledgement.checked, false); assert.equal(basic.submit.disabled, true);
  await noAuth.submit.listeners.click(); assert.equal(f.calls.recover.length, 0);
  acknowledgeRecovery(basic); await basic.submit.listeners.click();
  assert.equal(f.calls.recover[0].mode, 'replace-basic');
});

test('cancelling recovery clears inputs and detached controls cannot submit or close a newer modal', async () => {
  const f = fixture(blockedSource()); f.openProviderRecoveryModal(f.model.providers[0]);
  const controls = recoveryControls(f); acknowledgeRecovery(controls);
  const cancel = f.modal().querySelectorAll('button').find((node) => text(node) === 'Cancel');
  await cancel.listeners.click();
  assert.equal(f.modal(), null); assert.equal(f.calls.recover.length, 0);
  assert.equal(controls.username.value, ''); assert.equal(controls.password.value, '');
  f.replace(); const replacement = f.modal();
  await controls.submit.listeners.click(); await cancel.listeners.click();
  assert.equal(f.modal(), replacement); assert.equal(f.calls.recover.length, 0);
});

test('recovery double-submit is deduplicated and late success preserves a newer modal and route', async () => {
  const f = fixture(blockedSource()); const release = f.holdRecovery();
  f.openProviderRecoveryModal(f.model.providers[0]);
  const controls = recoveryControls(f); acknowledgeRecovery(controls);
  const first = controls.submit.listeners.click();
  await controls.submit.listeners.click(); await Promise.resolve();
  assert.equal(f.calls.recover.length, 1); assert.equal(f.pending(), 1);
  const view = f.view();
  for (const label of ['Recover source', 'Edit', 'Prefer']) assert.equal(view.querySelectorAll('button').find((node) => text(node) === label).disabled, true);
  await f.toggleProvider(f.model.providers[0]); assert.equal(f.calls.upsert, 0);
  f.replace(); const replacement = f.modal(); f.route('inscription'); const before = f.repaints();
  release(); await first; await controls.submit.listeners.click();
  assert.equal(f.modal(), replacement); assert.equal(f.repaints(), before);
  assert.equal(f.pending(), 0); assert.equal(f.calls.recover.length, 1);
  assert.equal(f.model.providers[0].routingBlocked, undefined);
});

test('queued recovery refuses changed review fields, removed source, mode or token without adopting new state', async () => {
  const changes = [
    (provider) => { provider.credentialRecovery.token = nextRecoveryToken; },
    (provider) => { provider.baseUrl = 'http://127.0.0.1:18332'; },
    (provider) => { provider.network = 'testnet'; },
    (provider) => { provider.name = 'Changed source'; },
    (provider) => { provider.enabled = false; },
    (provider) => { provider.cookieFile = '/synthetic/core/.cookie'; provider.credentialRecovery.mode = 'clear-stored'; },
    (provider) => { provider.routingBlocked = false; }
  ];
  for (const change of [...changes, null]) {
    const f = fixture(blockedSource()); const gate = deferred(); const held = f.holdAuthority(gate.promise);
    f.openProviderRecoveryModal(f.model.providers[0]);
    const controls = recoveryControls(f); acknowledgeRecovery(controls); const pending = controls.submit.listeners.click();
    if (change) change(f.model.providers[0]); else f.model.providers = [];
    gate.resolve(); await Promise.all([held, pending]);
    assert.equal(f.calls.recover.length, 0); assert.equal(controls.submit.disabled, true);
    assert.match(text(f.modal()), /source changed after you reviewed it/);
    await controls.submit.listeners.click(); assert.equal(f.calls.recover.length, 0);
  }
});

test('stale recovery publishes a new token but requires explicitly reopening and acknowledging a new review', async () => {
  const f = fixture(blockedSource()); f.openProviderRecoveryModal(f.model.providers[0]);
  const controls = recoveryControls(f); acknowledgeRecovery(controls);
  f.main.providers[0].credentialRecovery.token = nextRecoveryToken;
  f.rejectRecovery('PROVIDER_RECOVERY_STALE');
  await controls.submit.listeners.click();
  assert.equal(f.calls.recover[0].token, recoveryToken);
  assert.equal(f.model.providers[0].credentialRecovery.token, nextRecoveryToken);
  assert.match(text(f.modal()), /review expired.*reopen Recover source/);
  assert.equal(controls.submit.disabled, true);
  controls.acknowledgement.listeners.change(); assert.equal(controls.submit.disabled, true);
  await controls.submit.listeners.click(); assert.equal(f.calls.recover.length, 1);
  await click(f, 'Close'); f.restoreRecovery(); f.openProviderRecoveryModal(f.model.providers[0]);
  const fresh = recoveryControls(f);
  assert.equal(fresh.acknowledgement.checked, false); assert.equal(fresh.password.value, '');
  acknowledgeRecovery(fresh); await fresh.submit.listeners.click();
  assert.equal(f.calls.recover.length, 2); assert.equal(f.calls.recover[1].token, nextRecoveryToken);
  assert.equal(f.modal(), null);
});

test('failed recovery keeps the reviewed owner with explicit reopen guidance and no replay', async () => {
  for (const code of ['SECURE_STORAGE_WRITE_FAILED', 'SECURE_STORAGE_ROLLBACK_FAILED', 'PROVIDER_RECOVERY_NOT_REQUIRED']) {
    const f = fixture(blockedSource()); f.rejectRecovery(code); f.openProviderRecoveryModal(f.model.providers[0]);
    const owner = f.modal(); const controls = recoveryControls(f); acknowledgeRecovery(controls);
    await controls.submit.listeners.click();
    assert.equal(f.modal(), owner); assert.equal(f.recovery(), null);
    assert.equal(controls.submit.disabled, true); assert.equal(controls.password.value, '');
    assert.match(text(owner), /reopen Recover source to review the latest source state/);
    assert.equal(f.toasts.at(-1)[0], 'Could not recover source');
    assert.equal(f.toasts.at(-1)[1], 'Synthetic rejected recovery');
    await controls.submit.listeners.click(); assert.equal(f.calls.recover.length, 1);
  }
});

test('late recovery rejection never replaces or closes a newer modal', async () => {
  const f = fixture(blockedSource()); const release = f.holdRecovery(); f.rejectRecovery('PROVIDER_RECOVERY_STALE');
  f.openProviderRecoveryModal(f.model.providers[0]); const controls = recoveryControls(f); acknowledgeRecovery(controls);
  const pending = controls.submit.listeners.click(); f.replace(); const replacement = f.modal();
  release(); await pending;
  assert.equal(f.modal(), replacement); assert.equal(text(replacement), 'Replacement');
  assert.equal(f.calls.recover.length, 1);
});

test('cookie and public-source recovery explicitly clear app storage with no credentials property', async () => {
  for (const config of [
    { type: 'bitcoin-core', cookieFile: '/synthetic/bitcoin/.cookie' },
    { type: 'ord-server', baseUrl: 'http://127.0.0.1:8080' },
    { type: 'mempool', baseUrl: 'http://127.0.0.1:8081' },
    { type: 'mock', baseUrl: '' }
  ]) {
    const provider = blockedSource({ ...config, credentialRecovery: { token: recoveryToken, mode: 'clear-stored' } });
    const f = fixture(provider); f.openProviderRecoveryModal(provider);
    const controls = recoveryControls(f);
    assert.equal(controls.username, undefined); assert.equal(controls.password, undefined);
    assert.equal(f.modal().querySelectorAll('input').length, 1);
    assert.match(text(f.modal()), /Clear only this app’s saved RPC username and password, and repair its recovery information/);
    assert.match(text(f.modal()), /approve clearing only this app’s stored RPC sign-in details/);
    if (config.cookieFile) {
      assert.ok(text(f.modal()).includes(config.cookieFile));
      assert.match(text(f.modal()), /file and its path are preserved/);
    }
    assert.equal(controls.submit.disabled, true);
    acknowledgeRecovery(controls); await controls.submit.listeners.click();
    assert.deepEqual(f.calls.recover, [{ id: provider.id, token: recoveryToken, mode: 'clear-stored' }]);
    assert.equal(f.model.providers[0].cookieFile, provider.cookieFile);
    assert.equal(f.calls.upsert, 0); assert.equal(f.calls.remove, 0);
  }
});

test('committed recovery with failed readback offers read-only reconciliation without mutation replay', async () => {
  const f = fixture(blockedSource()); f.failLists(); f.openProviderRecoveryModal(f.model.providers[0]);
  const controls = recoveryControls(f); acknowledgeRecovery(controls); await controls.submit.listeners.click();
  assert.equal(f.modal(), null); assert.ok(f.recovery()); assert.equal(f.calls.recover.length, 1);
  assert.equal(f.main.providers[0].routingBlocked, undefined);
  f.openProviderRecoveryModal(f.model.providers[0]); assert.equal(f.modal(), null);
  f.failSnapshot(); await f.recoverProviderSnapshot();
  assert.ok(f.recovery()); assert.equal(f.calls.recover.length, 1);
  f.restoreReads(); f.failSnapshot(false); await f.recoverProviderSnapshot();
  assert.equal(f.recovery(), null); assert.equal(f.calls.recover.length, 1);
  assert.equal(f.model.providers[0].routingBlocked, undefined);
});

test('malformed recovery response leaves a spent dialog and requires read-only refresh', async () => {
  const f = fixture(blockedSource()); f.malformed(); f.openProviderRecoveryModal(f.model.providers[0]);
  const controls = recoveryControls(f); acknowledgeRecovery(controls); await controls.submit.listeners.click();
  assert.ok(f.recovery()); assert.match(text(f.modal()), /Refresh source state.*will not be sent again/);
  await controls.submit.listeners.click(); await f.recoverProviderSnapshot();
  assert.equal(f.calls.recover.length, 1); assert.equal(f.recovery(), null);
  assert.equal(controls.submit.disabled, true);
});

test('advanced Edit explains blocked credentials and opens a separate blank recovery review', () => {
  const provider = blockedSource(); const f = fixture(provider); f.openProviderModal(provider);
  assert.match(text(f.modal()), /Saving this form with blank credentials does not complete recovery/);
  assert.ok(f.modal().querySelectorAll('button').some((node) => text(node) === 'Save source'));
  assert.ok(f.modal().querySelectorAll('button').some((node) => text(node) === 'Remove'));
  const password = f.modal().querySelectorAll('input').find((node) => node.type === 'password');
  assert.equal(password.getAttribute('placeholder'), 'Use Recover source to restore access');
  password.value = 'synthetic-unsaved-edit';
  f.modal().querySelectorAll('button').find((node) => text(node) === 'Recover source').listeners.click();
  assert.equal(recoveryControls(f).password.value, '');
  assert.equal(recoveryControls(f).acknowledgement.checked, false);
  assert.equal(f.calls.upsert, 0); assert.equal(f.calls.recover.length, 0);
});
