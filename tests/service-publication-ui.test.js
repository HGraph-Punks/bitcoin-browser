import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/renderer/state.js';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function extract(a, b) { const x = source.indexOf(a); const y = source.indexOf(b, x); assert.ok(x >= 0 && y > x); return source.slice(x, y); }
function deferred() { let resolve; let reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; }
class Node {
  constructor(tag = 'div', text = '') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false; this.text = text; }
  append(...c) { this.children.push(...c.flat(Infinity).filter(Boolean)); }
  replaceChildren(...c) { this.children = c.flat(Infinity).filter(Boolean); }
  querySelectorAll(tag) { const out = []; const walk = (n) => { if (n !== this && n.tagName === tag.toUpperCase()) out.push(n); for (const c of n.children ?? []) walk(c); }; walk(this); return out; }
  querySelector(tag) { return this.querySelectorAll(tag)[0] ?? null; }
}
function label(n) { return n.children.length ? n.children.map(label).join('') : n.text; }

function fixture(route = 'home') {
  let modalGeneration = 0; let modal;
  const calls = { patch: [], viewRefresh: 0, repaint: 0, toast: [], start: [], stop: [], upsert: [], remove: [], list: 0 };
  const MODEL = new Store({ services: [] }); MODEL.subscribe((value) => calls.patch.push([value]));
  const transports = { action: deferred(), list: deferred() };
  const h = (tag, attrs = {}, ...children) => { const n = new Node(tag); n.value = attrs.value ?? ''; n.checked = Boolean(attrs.checked); n.disabled = Boolean(attrs.disabled); for (const [k, v] of Object.entries(attrs)) if (k.startsWith('on')) n.listeners[k.slice(2).toLowerCase()] = v; n.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false).map((c) => c instanceof Node ? c : new Node('span', String(c)))); return n; };
  const button = (text, options = {}) => h('button', { disabled: options.disabled, onClick: options.onClick }, text);
  const scope = {
    h, button, inputField: (value, attrs) => h('input', { ...attrs, value }), checkbox: (text, checked) => h('label', {}, h('input', { checked }), text), formField: (_l, input) => h('div', {}, input), modalHeader: () => h('header'),
    hostShowModal: (...children) => { modal = h('div', {}, children); }, hostCloseModal: () => { modal = null; }, clear: (node, ...children) => { node.replaceChildren(...children.map((c) => c instanceof Node ? c : new Node('span', String(c)))); return node; },
    MODEL, state: () => MODEL.get(), routeName: () => route,
    elements: { page: new Node('main') }, context: {}, updateServicesView: () => { calls.viewRefresh += 1; return true; }, renderPage: () => { calls.repaint += 1; }, toast: (...a) => calls.toast.push(a),
    api: { services: {
      start: (id) => { calls.start.push(id); return transports.action.promise; }, stop: (id) => { calls.stop.push(id); return transports.action.promise; },
      upsert: (v) => { calls.upsert.push(v); return transports.action.promise; }, remove: (id) => { calls.remove.push(id); return transports.action.promise; },
      list: () => { calls.list += 1; return transports.list.promise; }
    } }
  };
  const actions = vm.runInNewContext(`(() => { let modalGeneration = 0; let pendingServiceRefresh = false; const pendingServiceActions = new Map(); function showModal(...children) { modalGeneration += 1; hostShowModal(...children); return modalGeneration; } function closeModal() { modalGeneration += 1; hostCloseModal(); } ${extract('function refreshServicesView(', '\nasync function updateSuggestions(')} return { openServiceModal, confirmServiceRemoval, refreshServicesView, refreshServices, startService, stopService }; })()`, scope);
  return { actions, calls, transports, scope, modal: () => modal, route: (v) => { route = v; } };
}
function click(root, name) { const b = root.querySelectorAll('button').find((n) => label(n) === name); assert.ok(b, name); return b.listeners.click(); }

for (const action of ['startService', 'stopService']) test(`${action} publishes services without repainting an unrelated current page`, async () => {
  const f = fixture('home'); const pending = f.actions[action]('svc'); f.transports.action.resolve(); f.transports.list.resolve([{ id: 'svc' }]); await pending;
  assert.equal(f.calls.patch.length, 1); assert.equal(f.calls.repaint, 0); assert.deepEqual(f.calls.patch[0][0].services, [{ id: 'svc' }]);
});

test('service Save completion after route change publishes without replacing Home/content UI', async () => {
  const f = fixture('services'); f.actions.openServiceModal(); const owner = f.modal(); const pending = click(owner, 'Save service'); click(owner, 'Cancel'); f.route('content'); f.transports.action.resolve(); f.transports.list.resolve([{ id: 'svc' }]); await pending;
  assert.equal(f.calls.patch.length, 1); assert.equal(f.calls.repaint, 0); assert.equal(f.calls.toast.at(-1)[0], 'Local service saved');
});

test('service Remove completion avoids Home repaint while Services receives a targeted refresh', async () => {
  const f = fixture('services'); f.actions.confirmServiceRemoval({ id: 'svc', name: 'Service' }); const owner = f.modal(); const pending = click(owner, 'Remove permanently'); click(owner, 'Cancel'); f.route('home'); f.transports.action.resolve([]); await pending;
  assert.equal(f.calls.repaint, 0); assert.deepEqual(f.calls.patch[0][0].services, []);
  const services = fixture('services'); const start = services.actions.startService('svc'); services.transports.action.resolve(); services.transports.list.resolve([]); await start;
  assert.ok(services.calls.viewRefresh > 0, 'services route receives targeted refreshes'); assert.equal(services.calls.repaint, 0);
});

test('service action failure reports truthfully and does not publish or repaint', async () => {
  const f = fixture('home'); const pending = f.actions.startService('svc'); f.transports.action.reject(new Error('start failed')); await pending;
  assert.equal(f.calls.patch.length, 0); assert.equal(f.calls.repaint, 0); assert.deepEqual(f.calls.toast.at(-1).slice(0, 2), ['Could not start service', 'start failed']);
});

test('manual Refresh retries a lifecycle refresh failure without resubmitting the mutation', async () => {
  const f = fixture('home'); const action = f.actions.startService('svc'); f.transports.action.resolve(); f.transports.list.reject(new Error('list failed')); await action;
  assert.equal(f.calls.start.length, 1); assert.equal(f.calls.toast.at(-1)[0], 'Start request completed, but refresh failed');
  const retry = deferred(); f.scope.api.services.list = () => { f.calls.list += 1; return retry.promise; };
  const refresh = f.actions.refreshServices(); const duplicate = f.actions.refreshServices(); retry.resolve([{ id: 'svc', status: 'running' }]); await Promise.all([refresh, duplicate]);
  assert.equal(f.calls.start.length, 1); assert.equal(f.calls.list, 2); assert.equal(f.calls.patch.length, 1); assert.equal(f.calls.toast.at(-1)[0], 'Local services refreshed');
});

test('lifecycle guard suppresses the same ID while allowing an independent service ID', async () => {
  const f = fixture('home'); const a = deferred(); const b = deferred();
  f.scope.api.services.start = (id) => { f.calls.start.push(id); return id === 'a' ? a.promise : b.promise; };
  f.scope.api.services.list = async () => [{ id: 'a', status: 'running' }, { id: 'b', status: 'running' }];
  const first = f.actions.startService('a'); const duplicate = f.actions.startService('a'); const independent = f.actions.startService('b');
  const opposite = f.actions.stopService('a');
  assert.deepEqual(f.calls.start, ['a', 'b']); a.resolve(); b.resolve(); await Promise.all([first, duplicate, independent]);
  await opposite; assert.equal(f.calls.stop.length, 0);
  assert.equal(f.calls.patch.length, 2);
});

test('completed lifecycle request reports authoritative non-running status without claiming success', async () => {
  const f = fixture('home'); const pending = f.actions.startService('svc'); f.transports.action.resolve(); f.transports.list.resolve([{ id: 'svc', status: 'stopped' }]); await pending;
  assert.equal(f.calls.toast.at(-1)[0], 'Start request completed');
  assert.match(f.calls.toast.at(-1)[1], /Current status: stopped/);
});

test('Services view falls back to renderPage only when its targeted updater cannot handle the page', () => {
  const offRoute = fixture('home'); offRoute.scope.updateServicesView = () => { offRoute.calls.viewRefresh += 1; return false; }; offRoute.actions.refreshServicesView();
  assert.equal(offRoute.calls.viewRefresh, 0); assert.equal(offRoute.calls.repaint, 0);
  const services = fixture('services'); services.scope.updateServicesView = () => { services.calls.viewRefresh += 1; return false; }; services.actions.refreshServicesView();
  assert.equal(services.calls.viewRefresh, 1); assert.equal(services.calls.repaint, 1);
});

test('manual list-only refresh rejection releases its latch for a successful retry without mutation', async () => {
  const f = fixture('home'); const failed = f.actions.refreshServices(); const duplicate = f.actions.refreshServices(); f.transports.list.reject(new Error('offline')); await Promise.all([failed, duplicate]);
  assert.equal(f.calls.list, 1); assert.equal(f.calls.start.length + f.calls.stop.length + f.calls.upsert.length + f.calls.remove.length, 0);
  const retry = deferred(); f.scope.api.services.list = () => { f.calls.list += 1; return retry.promise; }; const operation = f.actions.refreshServices(); retry.resolve([]); await operation;
  assert.equal(f.calls.list, 2); assert.equal(f.calls.toast.at(-1)[0], 'Local services refreshed');
});

for (const [action, status, title] of [['startService', 'running', 'Local service started'], ['stopService', 'stopped', 'Local service stopped']]) {
  test(`${action} reports success only from its authoritative expected status`, async () => {
    const f = fixture('home'); const operation = f.actions[action]('svc'); f.transports.action.resolve(); f.transports.list.resolve([{ id: 'svc', status, pid: null }]); await operation;
    assert.equal(f.calls.toast.at(-1)[0], title);
  });
}

test('Stop completion with failed status and a live PID does not claim the service stopped', async () => {
  const f = fixture('home'); const operation = f.actions.stopService('svc'); f.transports.action.resolve(); f.transports.list.resolve([{ id: 'svc', status: 'failed', pid: 42, error: 'still alive' }]); await operation;
  assert.equal(f.calls.toast.at(-1)[0], 'Stop request completed'); assert.equal(f.calls.toast.at(-1)[2], 'error');
});

test('Stop rejection after abnormal child close does not claim success or repeat the operation', async () => {
  const f = fixture('services'); const operation = f.actions.stopService('svc');
  f.transports.action.reject(Object.assign(new Error('Service did not stop cleanly: Process exited with code 7 and signal none'), { code: 'SERVICE_STOP_FAILED' }));
  await operation;
  assert.equal(f.calls.stop.length, 1); assert.equal(f.calls.list, 0);
  assert.equal(f.calls.toast.at(-1)[0], 'Could not stop service');
  assert.match(f.calls.toast.at(-1)[1], /code 7/);
  assert.equal(f.calls.toast.at(-1)[2], 'error');
  f.transports.list.resolve([{ id: 'svc', status: 'failed', pid: null, exitCode: 7 }]);
  await f.actions.refreshServices();
  assert.equal(f.calls.stop.length, 1, 'explicit refresh is read-only');
  assert.equal(f.calls.patch.at(-1)[0].services[0].exitCode, 7);
});

test('a no-op Stop of an already closed failure preserves its warning instead of clean-stop success', async () => {
  const f = fixture('home'); const operation = f.actions.stopService('svc');
  f.transports.action.resolve();
  f.transports.list.resolve([{ id: 'svc', status: 'failed', pid: null, error: 'Forced termination was requested' }]);
  await operation;
  assert.equal(f.calls.toast.at(-1)[0], 'Stop request completed');
  assert.equal(f.calls.toast.at(-1)[2], 'error');
  assert.match(f.calls.toast.at(-1)[1], /Forced termination/);
});
