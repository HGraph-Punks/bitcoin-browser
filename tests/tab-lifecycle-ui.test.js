import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { MAX_TABS } from '../src/shared/constants.js';

const appSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');

function cancellationContext(context) {
  context.forgetAiTab = () => {};
  const begin = appSource.indexOf('function cancelTabResolution(');
  const end = appSource.indexOf('\nfunction patch(', begin);
  assert.ok(begin >= 0 && end > begin);
  context.pendingEntityRequests = new Map();
  context.cancelTabResolution = vm.runInNewContext(`(${appSource.slice(begin, end)})`, context);
  return context;
}

test('newTab enforces the shared limit without changing or saving the current session', () => {
  const begin = appSource.indexOf('function newTab(');
  const end = appSource.indexOf('\nfunction closeTab(', begin);
  const tabs = Array.from({ length: MAX_TABS }, (_, index) => ({ id: `tab-${index}` }));
  const model = { tabs, activeTabId: tabs[0].id };
  const effects = { patches: 0, saves: 0, navigations: 0, toasts: [] };
  const newTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, {
    MAX_TABS, navigationReady: true, state: () => model, toast: (...args) => effects.toasts.push(args),
    patch: () => { effects.patches += 1; }, scheduleTabSave: () => { effects.saves += 1; },
    navigate: () => { effects.navigations += 1; }, safeTab: assert.fail, id: assert.fail, Date
  });
  assert.equal(newTab(), null);
  assert.equal(model.tabs.length, MAX_TABS);
  assert.deepEqual({ patches: effects.patches, saves: effects.saves, navigations: effects.navigations }, { patches: 0, saves: 0, navigations: 0 });
  assert.equal(effects.toasts[0][0], 'Tab limit reached');
  assert.match(effects.toasts[0][1], new RegExp(String(MAX_TABS)));
});

test('newTab works again immediately after capacity is available', () => {
  const begin = appSource.indexOf('function newTab(');
  const end = appSource.indexOf('\nfunction closeTab(', begin);
  const tabs = Array.from({ length: MAX_TABS - 1 }, (_, index) => ({ id: `tab-${index}` }));
  const model = { tabs, activeTabId: tabs[0].id };
  let saved = 0;
  let navigated = 0;
  const newTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, {
    MAX_TABS, navigationReady: true, state: () => model, toast: assert.fail, Date,
    id: () => 'new-tab', safeTab: (tab) => tab,
    patch(value) { Object.assign(model, typeof value === 'function' ? value(model) : value); },
    scheduleTabSave: () => { saved += 1; }, navigate: () => { navigated += 1; }
  });
  const created = newTab('sat:1');
  assert.equal(created.id, 'new-tab');
  assert.equal(model.tabs.length, MAX_TABS);
  assert.equal(model.activeTabId, 'new-tab');
  assert.equal(saved, 1);
  assert.equal(navigated, 1);
});

test('closing the active tab lazily resolves the selected unresolved restored tab', () => {
  const begin = appSource.indexOf('function closeTab(');
  const end = appSource.indexOf('\nfunction switchTab(', begin);
  const model = {
    tabs: [
      { id: 'active', target: 'sat:1', history: ['sat:1'], historyIndex: 0 },
      { id: 'restored', target: 'block:840000', history: ['block:840000'], historyIndex: 0 }
    ],
    activeTabId: 'active', results: { active: {} }, loading: {}, graphs: {}, requestSequence: { active: 1 }
  };
  const navigations = [];
  const context = {
    state: () => model, activeTab: () => model.tabs.find((tab) => tab.id === model.activeTabId),
    navigationIntents: new Map(),
    patch(value) { Object.assign(model, typeof value === 'function' ? value(model) : value); },
    scheduleTabSave: () => Promise.resolve(),
    navigate: (...args) => navigations.push(args), safeTab: assert.fail, id: assert.fail
  };
  const closeTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, cancellationContext(context));
  closeTab('active');
  assert.equal(model.activeTabId, 'restored');
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0][0], 'block:840000');
  assert.deepEqual({ ...navigations[0][1] }, { fromHistory: true, historyIndex: 0, record: false });
});

test('closing a background tab does not reload the resolved active tab', () => {
  const begin = appSource.indexOf('function closeTab(');
  const end = appSource.indexOf('\nfunction switchTab(', begin);
  const model = {
    tabs: [{ id: 'active' }, { id: 'background' }], activeTabId: 'active',
    results: { active: {} }, loading: {}, graphs: {}, requestSequence: {}
  };
  let navigations = 0;
  const context = {
    state: () => model, activeTab: () => model.tabs.find((tab) => tab.id === model.activeTabId),
    navigationIntents: new Map(),
    patch(value) { Object.assign(model, typeof value === 'function' ? value(model) : value); },
    scheduleTabSave: () => Promise.resolve(), navigate: () => { navigations += 1; },
    safeTab: assert.fail, id: assert.fail
  };
  const closeTab = vm.runInNewContext(`(${appSource.slice(begin, end)})`, cancellationContext(context));
  closeTab('background');
  assert.equal(navigations, 0);
});
