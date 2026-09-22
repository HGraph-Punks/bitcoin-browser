import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const dom = fs.readFileSync(new URL('../src/renderer/dom.js', import.meta.url), 'utf8');
function extract(start, end) { const a = app.indexOf(start); const b = app.indexOf(end, a); assert.ok(a >= 0 && b > a); return app.slice(a, b); }
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

class N {
  constructor(tag = '#text', text = '') { this.tagName = tag === '#text' ? undefined : tag.toUpperCase(); this.textContent = text; this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; this.listeners = {}; this.className = ''; this.value = ''; this.checked = false; this.disabled = false; this.classes = new Set(); this.classList = { add: (...v) => v.forEach((x) => this.classes.add(x)), remove: (...v) => v.forEach((x) => this.classes.delete(x)), contains: (v) => this.classes.has(v) }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'type') this.type = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  querySelectorAll(selector) { const out = []; const walk = (n) => { if (n !== this && match(n, selector)) out.push(n); for (const c of n.children ?? []) walk(c); }; walk(this); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function match(n, s) { if (!n.tagName) return false; if (s === 'input') return n.tagName === 'INPUT'; if (s === 'button') return n.tagName === 'BUTTON'; return n.tagName === s.toUpperCase(); }
function text(n) { return n.tagName ? n.children.map(text).join('') : n.textContent; }
function fixture() {
  const document = { createElement: (t) => new N(t), createTextNode: (v) => new N('#text', String(v)), createDocumentFragment: () => new N('fragment'), getElementById: () => null };
  const helpers = vm.runInNewContext(`(() => { ${dom.replaceAll('export ', '')}; return { h, clear, button }; })()`, { document, Node: N, Intl, Date, BigInt, Set });
  const elements = { modal: new N('div'), page: new N('main'), 'modal-backdrop': new N('div'), 'palette-backdrop': new N('div'), 'palette-input': new N('input'), app: new N('main') };
  elements['modal-backdrop'].classList.add('hidden'); elements['palette-backdrop'].classList.add('hidden');
  const patches = []; const toasts = []; const closes = [];
  const upserts = [deferred()]; const lists = [deferred()]; const removes = [deferred()];
  const scope = {
    ...helpers, document, elements,
    api: { services: {
      upsert: (...args) => { const index = scope.upsertArgs.push(args) - 1; return upserts[index].promise; },
      list: () => { const index = scope.listCalls++; return lists[index].promise; },
      remove: (...args) => { const index = scope.removeArgs.push(args) - 1; return removes[index].promise; }
    } },
    upsertArgs: [], removeArgs: [], listCalls: 0,
    MODEL: { patch: (value) => patches.push([value]) }, state: () => ({ services: patches.at(-1)?.[0]?.services ?? [] }), context: {}, updateServicesView: () => true, renderPage() {}, toast: (...args) => toasts.push(args),
    routeName: () => 'services',
    modalHeader: (a, b) => helpers.h('header', {}, a, b),
    rememberOverlayFocus() {}, focusOverlay() {}, restoreOverlayFocus() { closes.push(true); },
    renderPalette() {}
  };
  const actions = vm.runInNewContext(`(() => {
    let modalGeneration = 0; let pendingServiceRefresh = false; const pendingServiceActions = new Map();
    const navigationReady = true;
    ${extract('function showModal(', '\nlet formFieldSequence = 0;')}
    ${extract('function openPalette(', '\nfunction paletteCandidates(')}
    ${extract('let formFieldSequence = 0;', '\nconst ALL_PROVIDER_CAPABILITIES')}
    ${extract('function refreshServicesView(', '\nasync function startService(')}
    ${extract('function executeCommand(', '\nfunction handleShellDeepLink(')}
    return { openServiceModal, confirmServiceRemoval, closeModal, executeCommand, replaceModal: () => showModal(h('p', {}, 'replacement')),
      paletteTransfer: openPalette, generation: () => modalGeneration };
  })()`, scope);
  return { ...actions, scope, upsert: upserts[0], list: lists[0], remove: removes[0], patches, toasts, closes,
    nextUpsert() { const value = deferred(); upserts.push(value); return value; },
    nextList() { const value = deferred(); lists.push(value); return value; },
    nextRemove() { const value = deferred(); removes.push(value); return value; },
    visible: () => elements['modal-backdrop'].classList.contains('hidden') ? null : elements.modal, replace: () => actions.replaceModal() };
}
function click(root, label) { const button = root.querySelectorAll('button').find((n) => text(n) === label); assert.ok(button, label); return button.listeners.click(); }

test('service save closes its owning dialog only after publishing authoritative services and truthful captured feedback', async () => {
  const f = fixture(); f.openServiceModal(); const modal = f.visible();
  const inputs = modal.querySelectorAll('input'); inputs[0].value = 'svc'; inputs[1].value = 'Captured name';
  modal.querySelector('textarea').value = 'one\ntwo'; inputs.at(-2).checked = true; inputs.at(-1).checked = true;
  const pending = click(modal, 'Save service'); inputs[1].value = 'Later edit';
  f.upsert.resolve(); f.list.resolve([{ id: 'svc' }]); await pending;
  assert.equal(f.closes.length, 1); assert.equal(JSON.stringify(f.patches), JSON.stringify([[{ services: [{ id: 'svc' }] }]]));
  assert.equal(f.toasts[0][0], 'Local service saved'); assert.equal(f.toasts[0][1], 'Captured name');
  assert.equal(f.scope.upsertArgs[0][0].name, 'Captured name');
  assert.equal(JSON.stringify(f.scope.upsertArgs[0][0].args), JSON.stringify(['one', 'two']));
  assert.equal(f.scope.upsertArgs[0][0].enabled, true); assert.equal(f.scope.upsertArgs[0][0].autoStart, true);
});

test('late save success cannot close a replacement dialog but still publishes and reports success', async () => {
  const f = fixture(); f.openServiceModal(); const pending = click(f.visible(), 'Save service'); f.replace(); const replacement = f.visible();
  f.upsert.resolve(); f.list.resolve([{ id: 'new' }]); await pending;
  assert.equal(f.visible(), replacement); assert.equal(f.closes.length, 0); assert.equal(f.patches.length, 1); assert.equal(f.toasts.at(-1)[0], 'Local service saved');
});

test('late removal success cannot close a replacement dialog and publishes the returned list', async () => {
  const f = fixture(); const service = { id: 'svc', name: 'Service' }; f.confirmServiceRemoval(service); const pending = click(f.visible(), 'Remove permanently'); f.replace(); const replacement = f.visible();
  f.remove.resolve([]); await pending;
  assert.equal(f.visible(), replacement); assert.equal(f.closes.length, 0); assert.equal(JSON.stringify(f.scope.removeArgs), JSON.stringify([['svc']])); assert.equal(JSON.stringify(f.patches), JSON.stringify([[{ services: [] }]]));
});

test('upsert rejection keeps the editable owner open and permits a fresh retry', async () => {
  const f = fixture(); f.openServiceModal(); const owner = f.visible(); const first = click(owner, 'Save service');
  f.upsert.reject(new Error('upsert denied')); await first;
  assert.equal(f.visible(), owner); assert.equal(f.closes.length, 0); assert.deepEqual(f.toasts.at(-1).slice(0, 2), ['Could not save local service', 'upsert denied']);
  const retryTransport = f.nextUpsert(); const retry = click(owner, 'Save service'); assert.equal(f.scope.upsertArgs.length, 2);
  retryTransport.resolve(); f.list.resolve([]); await retry; assert.equal(f.closes.length, 1);
});

test('duplicate Save clicks while pending submit exactly once and never close newer ownership', async () => {
  const f = fixture(); f.openServiceModal(); const modal = f.visible(); const name = modal.querySelectorAll('input')[1]; name.value = 'First';
  const first = click(modal, 'Save service'); name.value = 'Second'; const second = click(modal, 'Save service');
  assert.deepEqual(f.scope.upsertArgs.map(([value]) => value.name), ['First']);
  f.replace(); f.upsert.resolve(); f.list.resolve([]); await Promise.all([first, second]);
  assert.equal(f.closes.length, 0); assert.equal(f.visible() !== null, true);
});

test('committed save with failed list keeps locked form, reports refresh failure, and retries list only', async () => {
  const f = fixture(); f.openServiceModal({ id: 'svc', name: 'Service', executable: '/bin/true', cwd: '', args: [], enabled: true, autoStart: false }); const owner = f.visible(); const pending = click(owner, 'Save service');
  assert.equal(owner.querySelectorAll('button').find((node) => text(node) === 'Cancel').disabled, false, 'Cancel remains usable');
  f.upsert.resolve(); f.list.reject(new Error('refresh unavailable')); await pending;
  assert.equal(f.visible(), owner); assert.equal(f.scope.upsertArgs.length, 1); assert.equal(f.toasts.at(-1)[0], 'Local service saved, but refresh failed');
  assert.equal([...owner.querySelectorAll('input'), ...owner.querySelectorAll('textarea')].length, 7);
  assert.ok([...owner.querySelectorAll('input'), ...owner.querySelectorAll('textarea')].every((control) => control.disabled));
  assert.equal(owner.querySelectorAll('button').find((node) => text(node) === 'Remove').disabled, true);
  const retryButton = owner.querySelectorAll('button').find((node) => text(node) === 'Retry refresh'); assert.ok(retryButton);
  const retryList = f.nextList(); const retry = retryButton.listeners.click(); const duplicate = retryButton.listeners.click(); retryList.reject(new Error('still unavailable')); await Promise.all([retry, duplicate]);
  assert.equal(f.scope.listCalls, 2, 'duplicate refresh click suppressed'); assert.equal(f.scope.upsertArgs.length, 1);
  const finalList = f.nextList(); const finalRetry = retryButton.listeners.click(); finalList.resolve([{ id: 'svc' }]); await finalRetry;
  assert.equal(f.scope.upsertArgs.length, 1); assert.equal(f.scope.listCalls, 3); assert.equal(f.patches.length, 1); assert.equal(f.closes.length, 1);
});

test('Cancel then reopen invalidates a detached Save callback and stale controls cannot begin another mutation', async () => {
  const f = fixture(); f.openServiceModal(); const stale = f.visible(); const staleSave = stale.querySelectorAll('button').find((node) => text(node) === 'Save service'); const pending = staleSave.listeners.click();
  click(stale, 'Cancel'); f.openServiceModal(); const replacement = f.visible();
  f.upsert.resolve(); f.list.resolve([]); await pending;
  assert.equal(f.visible(), replacement); assert.equal(f.patches.length, 1, 'committed result still publishes');
  await staleSave.listeners.click();
  assert.equal(f.scope.upsertArgs.length, 1, 'detached stale action is generation-rejected');
});

test('remove rejection keeps its confirmation open and duplicate Remove clicks invoke once', async () => {
  const f = fixture(); const service = { id: 'svc', name: 'Captured service' }; f.confirmServiceRemoval(service); const owner = f.visible();
  const first = click(owner, 'Remove permanently'); const duplicate = click(owner, 'Remove permanently');
  assert.equal(f.scope.removeArgs.length, 1); f.remove.reject(new Error('remove denied')); await Promise.all([first, duplicate]);
  assert.equal(f.visible(), owner); assert.equal(f.closes.length, 0); assert.deepEqual(f.toasts.at(-1).slice(0, 2), ['Could not remove service', 'remove denied']);
  const retryTransport = f.nextRemove(); const retry = click(owner, 'Remove permanently'); retryTransport.resolve([]); await retry;
  assert.equal(f.scope.removeArgs.length, 2); assert.deepEqual(f.toasts.at(-1), ['Local service removed', 'Captured service', 'success']);
});

test('normal removal closes its owner, publishes returned services, and reports captured success', async () => {
  const f = fixture(); const service = { id: 'svc', name: 'Captured service' }; f.confirmServiceRemoval(service); const pending = click(f.visible(), 'Remove permanently'); service.name = 'Mutated later';
  f.remove.resolve([{ id: 'other' }]); await pending;
  assert.equal(f.closes.length, 1); assert.equal(JSON.stringify(f.patches), JSON.stringify([[{ services: [{ id: 'other' }] }]]));
  assert.deepEqual(f.toasts.at(-1), ['Local service removed', 'Captured service', 'success']);
});

test('Cancel during pending save followed by reopen survives the late rejection', async () => {
  const f = fixture(); f.openServiceModal(); const owner = f.visible(); const pending = click(owner, 'Save service');
  click(owner, 'Cancel'); f.openServiceModal(); const replacement = f.visible();
  f.upsert.reject(new Error('late save rejection')); await pending;
  assert.equal(f.visible(), replacement); assert.equal(f.closes.length, 1);
  assert.deepEqual(f.toasts.at(-1).slice(0, 2), ['Could not save local service', 'late save rejection']);
});

test('Cancel during pending removal followed by reopen survives the late rejection', async () => {
  const f = fixture(); f.confirmServiceRemoval({ id: 'svc', name: 'Service' }); const owner = f.visible(); const pending = click(owner, 'Remove permanently');
  click(owner, 'Cancel'); f.openServiceModal(); const replacement = f.visible();
  f.remove.reject(new Error('late remove rejection')); await pending;
  assert.equal(f.visible(), replacement); assert.equal(f.closes.length, 1);
  assert.deepEqual(f.toasts.at(-1).slice(0, 2), ['Could not remove service', 'late remove rejection']);
});

test('retained Save and Remove callbacks cannot start mutations after their dialogs close', async () => {
  const saveFixture = fixture(); saveFixture.openServiceModal(); const saveOwner = saveFixture.visible();
  const staleSave = saveOwner.querySelectorAll('button').find((node) => text(node) === 'Save service'); click(saveOwner, 'Cancel'); await staleSave.listeners.click();
  assert.equal(saveFixture.scope.upsertArgs.length, 0);

  const removeFixture = fixture(); removeFixture.confirmServiceRemoval({ id: 'svc', name: 'Service' }); const removeOwner = removeFixture.visible();
  const staleRemove = removeOwner.querySelectorAll('button').find((node) => text(node) === 'Remove permanently'); click(removeOwner, 'Cancel'); await staleRemove.listeners.click();
  assert.equal(removeFixture.scope.removeArgs.length, 0);
});

test('palette transfer invalidates modal ownership while a committed save still publishes', async () => {
  const f = fixture(); f.openServiceModal(); const pending = click(f.visible(), 'Save service');
  f.paletteTransfer(); f.upsert.resolve(); f.list.resolve([{ id: 'svc' }]); await pending;
  assert.equal(f.visible(), null); assert.equal(f.closes.length, 1, 'only the transfer closes the modal');
  assert.equal(f.patches.length, 1); assert.equal(f.toasts.at(-1)[0], 'Local service saved');
  assert.equal(f.scope.elements['palette-backdrop'].classList.contains('hidden'), false);
  assert.equal(f.scope.elements.app.inert, true);
  assert.equal(f.scope.elements['palette-input'].getAttribute('aria-expanded'), 'true');
});

test('Cancel without reopening dismisses pending save and removal without discarding their committed state', async () => {
  for (const operation of ['save', 'remove']) {
    const f = fixture();
    if (operation === 'save') f.openServiceModal();
    else f.confirmServiceRemoval({ id: 'svc', name: 'Service' });
    const owner = f.visible();
    const pending = click(owner, operation === 'save' ? 'Save service' : 'Remove permanently');
    click(owner, 'Cancel');
    const dismissedGeneration = f.generation();
    if (operation === 'save') { f.upsert.resolve(); f.list.resolve([]); }
    else f.remove.resolve([]);
    await pending;
    assert.equal(f.visible(), null);
    assert.equal(f.generation(), dismissedGeneration, 'late completion does not close again');
    assert.equal(f.closes.length, 1);
    assert.equal(f.patches.length, 1);
  }
});

test('service events remain publishable during pending and committed-refresh-recovery modal states', async () => {
  const f = fixture(); f.openServiceModal(); const pending = click(f.visible(), 'Save service');
  const eventServices = [{ id: 'other', status: 'running' }];
  f.executeCommand({ type: 'services-updated', services: eventServices });
  assert.equal(f.patches[0][0].services, eventServices);
  f.upsert.resolve(); f.list.reject(new Error('refresh failed')); await pending;
  f.executeCommand({ type: 'services-updated', services: [] });
  assert.equal(f.patches.length, 2);
  assert.equal(f.visible() !== null, true);
  assert.equal(f.scope.upsertArgs.length, 1);
  assert.equal(f.scope.listCalls, 1);
});
