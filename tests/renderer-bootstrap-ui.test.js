import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/renderer/state.js';
import { MAX_TABS } from '../src/shared/constants.js';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, `Missing source section: ${start}`);
  return source.slice(begin, finish);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// Real bootstrap, subscriptions and navigation, with deterministic IPC and DOM
// collaborators. Packaged tests separately exercise actual window recreation.
function fixture() {
  const model = new Store({ tabs: [], activeTabId: null, requestSequence: {}, results: {}, loading: {}, graphs: {} });
  const bootstraps = [], parses = [], resolutions = [], toasts = [], saves = [];
  let nextId = 0;
  const subscriptions = { command: [], link: [], wallet: [], dom: [], monitor: [], window: [] };
  const nodes = new Map();
  const elements = new Proxy({}, { get: (_object, target) => {
    if (!nodes.has(target)) nodes.set(target, { dataset: {}, addEventListener: (event, listener) => subscriptions.dom.push({ target, event, listener }), classList: { contains: value => value === 'hidden' }, setAttribute() {}, blur() {}, focus() {}, select() {} });
    return nodes.get(target);
  } });
  const context = {
    providerCleanupRecovery: new Map(), providerOutcomeRecovery: null,
    MODEL: model, elements, MAX_TABS, navigationIntentSequence: 0, navigationIntents: new Map(), pendingEntityRequests: new Map(),
    state: () => model.get(), activeTab: () => model.get().tabs.find(tab => tab.id === model.get().activeTabId),
    patch: value => model.patch(value),
    document: { addEventListener: (event, listener) => subscriptions.dom.push({ target: 'document', event, listener }), querySelectorAll: () => [] },
    window: { addEventListener: (event, listener) => subscriptions.window.push({ event, listener }) },
    createProviderStatusMonitor: options => ({ start: () => subscriptions.monitor.push(options), stop() {} }),
    refreshProviderStatus: async () => {},
    api: {
      app: {
        bootstrap() { const request = deferred(); bootstraps.push(request); return request.promise; },
        onCommand: listener => subscriptions.command.push(listener),
        onDeepLink: listener => subscriptions.link.push(listener)
      },
      wallet: { onState: listener => subscriptions.wallet.push(listener) },
      tabs: { save: async (tabs, activeId) => { saves.push({ tabs: structuredClone(tabs), activeId }); } },
      navigation: {
        parse(input) { const request = { input, ...deferred() }; parses.push(request); return request.promise; },
        resolve(input) { const request = { input, ...deferred() }; resolutions.push(request); return request.promise; },
        // An acknowledgement is not a drain: retain deferred outcomes to test
        // the original late-publication ownership controls independently.
        cancelResolve: async () => ({ requested: true })
      }
    },
    id: () => `bootstrap-id-${++nextId}`,
    applyTheme() {}, renderChrome() {}, renderPage() {}, renderDrawer() {}, closeSuggestions() {},
    toggleBookmark() {}, updateSuggestions() {}, reload() {}, toggleDeveloper() {}, openPalette() {},
    refreshCacheStats: async () => {}, recordHistory: async () => {}, refreshProviders: async () => {},
    toast: (...args) => toasts.push(args), clear() {}, renderError: error => error, normalizeError: error => error,
    context: {}, setTimeout, Date
  };
  const actions = vm.runInNewContext(`(() => {
    ${section('function cancelTabResolution(', '\nfunction patch(')}
    ${section('let providerCleanupPublicationSequence =', '\nfunction validProviderSnapshot(')}
    ${section('let rendererEventsInstalled =', '\nfunction state(')}
    ${section('function safeTab(', '\nfunction scheduleTabSave(')}
    ${section('function scheduleTabSave(', '\nfunction closeTab(')}
    ${section('function titleFor(', '\nasync function recordHistory(')}
    ${section('function executeCommand(', '\nbootstrap();')}
    return { bootstrap, handleShellDeepLink, newTab, navigate };
  })()`, context);
  const data = {
    state: { settings: { restoreSession: true, offlineMode: true }, tabs: [{ id: 'saved', target: 'sat:0', history: ['sat:0'], historyIndex: 0 }],
      activeTabId: 'saved', history: [], bookmarks: [] },
    providers: [], providerCleanup: { cleanups: [] }, cache: {}, wallet: null, services: []
  };
  return { ...actions, model, bootstraps, parses, resolutions, toasts, subscriptions, data, saves, elements };
}

const internal = name => ({ kind: 'internal', value: name, canonical: `satnav://${name}`, display: name });
const sat = { kind: 'sat', value: 0, canonical: 'sat:0', display: 'Sat 0' };
async function tick() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test('cold deep links wait for state bootstrap and only the latest bounded intent navigates', async () => {
  const f = fixture();
  const pending = f.bootstrap();
  f.subscriptions.link[0]('satnav://history');
  f.subscriptions.link[0]('satnav://bookmarks');
  for (const invalid of [null, {}, 'https://example.invalid', 'satnav://bad\nlink', `satnav://${'x'.repeat(4096)}`]) f.subscriptions.link[0](invalid);
  assert.equal(f.parses.length, 0);
  assert.equal(f.model.get().tabs.length, 0);
  f.bootstraps[0].resolve(f.data);
  await tick();
  assert.deepEqual(f.parses.map(request => request.input), ['satnav://bookmarks']);
  f.parses[0].resolve(internal('bookmarks'));
  await pending;
  assert.equal(f.model.get().tabs.length, 1);
  assert.equal(f.model.get().tabs[0].id, 'saved');
  assert.equal(f.model.get().tabs[0].target, 'satnav://bookmarks');
  assert.equal(f.resolutions.length, 0);
});

test('native platform placement waits for bootstrap metadata and retains a safe unknown fallback', async () => {
  for (const platform of ['darwin', 'win32', 'linux', undefined]) {
    const f = fixture();
    if (platform) f.data.application = { platform };
    f.data.state.tabs[0] = { id: 'saved', target: 'satnav://history', history: ['satnav://history'], historyIndex: 0 };
    const pending = f.bootstrap();
    assert.equal(f.elements.app.dataset.platform, undefined);
    f.bootstraps[0].resolve(f.data);
    await tick();
    assert.equal(f.elements.app.dataset.platform, platform ?? 'unknown');
    assert.equal(f.parses[0].input, 'satnav://history');
    f.parses[0].resolve(internal('history'));
    await pending;
    assert.equal(f.elements.app.inert, false);
    assert.deepEqual(f.toasts, []);
  }
});

test('a deep link during restored-target parsing supersedes the older parse', async () => {
  const f = fixture();
  const pending = f.bootstrap();
  f.bootstraps[0].resolve(f.data);
  await tick();
  assert.equal(f.parses[0].input, 'sat:0');
  const linked = f.subscriptions.link[0]('satnav://providers');
  f.parses[1].resolve(internal('providers'));
  await linked;
  f.parses[0].resolve(sat);
  await pending;
  assert.equal(f.model.get().tabs[0].target, 'satnav://providers');
  assert.equal(f.resolutions.length, 0);
});

test('a deep link during restored provider resolution cannot be overwritten by its late result', async () => {
  const f = fixture();
  const pending = f.bootstrap();
  f.bootstraps[0].resolve(f.data);
  await tick();
  f.parses[0].resolve(sat);
  await tick();
  assert.equal(f.resolutions.length, 1);
  const linked = f.subscriptions.link[0]('satnav://bookmarks');
  f.parses[1].resolve(internal('bookmarks'));
  await linked;
  f.resolutions[0].resolve({ target: sat, entity: {}, attempts: [] });
  await pending;
  assert.equal(f.model.get().tabs[0].target, 'satnav://bookmarks');
  assert.equal(f.model.get().results.saved.target.canonical, 'satnav://bookmarks');
});

test('bootstrap failure retains pending link; retry installs no duplicate handlers and is single-flight', async () => {
  const f = fixture();
  const failed = f.bootstrap();
  f.subscriptions.link[0]('satnav://history');
  const domCount = f.subscriptions.dom.length;
  f.bootstraps[0].reject(new Error('Fixture state unavailable'));
  await failed;
  assert.equal(f.toasts[0][0], 'Bitcoin Browser could not start');
  const retry = f.bootstrap();
  await f.bootstrap();
  assert.equal(f.bootstraps.length, 2);
  assert.deepEqual([f.subscriptions.command.length, f.subscriptions.link.length, f.subscriptions.wallet.length], [1, 1, 1]);
  assert.equal(f.subscriptions.dom.length, domCount);
  f.bootstraps[1].resolve(f.data);
  await tick();
  assert.equal(f.parses[0].input, 'satnav://history');
  f.parses[0].resolve(internal('history'));
  await retry;
  assert.equal(f.model.get().tabs[0].target, 'satnav://history');
});

test('ordinary restoration runs exactly once when no deep link is pending', async () => {
  const f = fixture();
  f.data.state.tabs[0] = { id: 'saved', target: 'satnav://history', history: ['satnav://history'], historyIndex: 0 };
  const pending = f.bootstrap();
  f.bootstraps[0].resolve(f.data);
  await tick();
  f.parses[0].resolve(internal('history'));
  await pending;
  assert.deepEqual(f.parses.map(request => request.input), ['satnav://history']);
  assert.deepEqual([...f.model.get().tabs[0].history], ['satnav://history']);
  assert.deepEqual(f.toasts, []);
});

test('early native commands, keyboard, buttons and navigation cannot overwrite the uninitialized saved session', async () => {
  const f = fixture();
  const pending = f.bootstrap();
  assert.equal(f.elements.app.inert, true);
  f.subscriptions.command[0]('new-tab');
  f.subscriptions.dom.find(entry => entry.target === 'new-tab' && entry.event === 'click').listener({});
  f.subscriptions.dom.find(entry => entry.target === 'document' && entry.event === 'keydown').listener({ key: 't', metaKey: true, preventDefault: assert.fail });
  f.subscriptions.dom.find(entry => entry.target === 'omnibox' && entry.event === 'keydown').listener({ key: 'Enter', preventDefault: assert.fail });
  assert.equal(f.newTab(), null);
  await f.navigate('satnav://history');
  assert.equal(f.saves.length, 0);
  assert.equal(f.parses.length, 0);
  assert.equal(f.model.get().tabs.length, 0);
  f.data.state.tabs[0] = { id: 'saved', target: 'satnav://history', history: ['satnav://history'], historyIndex: 0 };
  f.bootstraps[0].resolve(f.data);
  await tick();
  f.parses[0].resolve(internal('history'));
  await pending;
  assert.equal(f.elements.app.inert, false);
  assert.ok(f.saves.every(save => save.tabs[0].id === 'saved'));
  f.subscriptions.command[0]('new-tab');
  assert.equal(f.model.get().tabs.length, 2);
  assert.equal(f.saves.at(-1).tabs.length, 2);
  f.parses[1].resolve({ kind: 'home', canonical: 'satnav://home', display: 'Home' });
  await tick();
});
