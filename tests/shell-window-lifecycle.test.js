import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(new URL('../src/main/window.js', import.meta.url), 'utf8');
const helperBegin = source.indexOf('const MAX_DEEP_LINK_LENGTH');
const begin = source.indexOf('export function createShellWindowController(');
const end = source.indexOf('\nexport function createMainWindow(', begin);
assert.ok(helperBegin >= 0 && begin > helperBegin && end > begin);
const factorySource = source.slice(helperBegin, end)
  .replace('export function extractDeepLinkArgument', 'function extractDeepLinkArgument')
  .replace('export function createShellWindowController', 'function createShellWindowController');
const factory = vm.runInNewContext(`${factorySource}\ncreateShellWindowController`, {
  IPC: { APP_DEEP_LINK: 'app:deep-link' }
});

function fakeWindow(id) {
  const sent = [];
  const window = {
    id, destroyed: false, loading: true, minimized: false, sent,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
    restore() { this.minimized = false; this.restored = true; }, show() { this.shown = true; }, focus() { this.focused = true; },
    webContents: { isLoading: () => window.loading, send: (...args) => sent.push(args) }
  };
  return window;
}

function fixture(initialDeepLinks = []) {
  const windows = [];
  const loaded = [];
  const controller = factory({
    initialDeepLinks,
    createWindow(options) {
      const window = fakeWindow(windows.length + 1);
      window.start = () => { window.loading = true; options.onShellLoading(window); };
      window.finish = () => { window.loading = false; options.onShellLoaded(window); };
      windows.push(window);
      return window;
    },
    onShellLoaded: (window) => loaded.push(window.id)
  });
  return { controller, windows, loaded };
}

test('cold links retain only the latest intent and wait for initial shell load', () => {
  const { controller, windows, loaded } = fixture(['satnav://cold']);
  controller.openDeepLink('satnav://queued');
  assert.equal(windows.length, 0);
  controller.initialize({ preloadPath: 'fixture' });
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].sent, []);
  windows[0].finish();
  assert.deepEqual(windows[0].sent.map((entry) => entry[1]), ['satnav://queued']);
  assert.deepEqual(loaded, [1]);
  assert.equal(windows[0].focused, true);
});

test('warm link recreates a destroyed shell and delivers once after load', () => {
  const { controller, windows } = fixture();
  controller.initialize({});
  windows[0].finish();
  windows[0].destroyed = true;
  controller.openDeepLink('satnav://warm');
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[1].sent, []);
  windows[1].finish();
  assert.deepEqual(windows[1].sent.map((entry) => entry[1]), ['satnav://warm']);
  windows[1].finish();
  assert.deepEqual(windows[1].sent.map((entry) => entry[1]), ['satnav://warm']);
});

test('stale old-window load callback cannot consume a link queued for its replacement', () => {
  const { controller, windows, loaded } = fixture();
  controller.initialize({});
  windows[0].destroyed = true;
  controller.openDeepLink('satnav://replacement');
  windows[0].finish();
  assert.deepEqual(windows[0].sent, []);
  windows[1].finish();
  assert.deepEqual(windows[1].sent.map((entry) => entry[1]), ['satnav://replacement']);
  assert.deepEqual(loaded, [2]);
});

test('ordinary shell load does not focus, while explicit activation does', () => {
  const { controller, windows } = fixture();
  controller.initialize({});
  windows[0].finish();
  assert.equal(windows[0].shown, undefined);
  assert.equal(windows[0].focused, undefined);

  controller.focusOrCreate();
  assert.equal(windows[0].shown, true);
  assert.equal(windows[0].focused, true);

  windows[0].destroyed = true;
  controller.activate();
  assert.equal(windows[1].focused, undefined);
  windows[1].finish();
  assert.equal(windows[1].focused, true);
});

test('invalid and oversized deep links cannot queue or create a shell', () => {
  const { controller, windows } = fixture([42, 'https://example.test']);
  for (const value of [null, 7, '', 'https://example.test', 'satnav://bad\nvalue', `satnav://${'a'.repeat(4088)}`]) {
    assert.equal(controller.openDeepLink(value), null);
  }
  assert.equal(controller.pendingCount, 0);
  assert.equal(windows.length, 0);
  assert.ok(controller.openDeepLink(`SATNAV://${'a'.repeat(4087)}`) === null);
  assert.equal(controller.pendingCount, 1);
  controller.initialize({});
  windows[0].finish();
  assert.equal(windows[0].sent.length, 1);
});

test('focus and activation safely recreate closed shells but shutdown cannot resurrect one', () => {
  const { controller, windows } = fixture();
  controller.initialize({});
  windows[0].destroyed = true;
  assert.equal(controller.focusOrCreate().id, 2);
  windows[1].destroyed = true;
  assert.equal(controller.activate().id, 3);
  windows[2].destroyed = true;
  controller.beginShutdown();
  assert.equal(controller.pendingCount, 0);
  assert.equal(controller.focusOrCreate(), null);
  assert.equal(controller.openDeepLink('satnav://ignored'), null);
  assert.equal(windows.length, 3);
});

test('shutdown discards a pre-initialization pending intent', () => {
  const { controller, windows } = fixture();
  controller.openDeepLink('satnav://pending');
  assert.equal(controller.pendingCount, 1);
  controller.beginShutdown();
  assert.equal(controller.pendingCount, 0);
  assert.equal(controller.initialize({}), null);
  assert.deepEqual(windows, []);
});

test('main window attaches the shell-load callback before starting navigation', () => {
  const createBegin = source.indexOf('export function createMainWindow(');
  const createEnd = source.indexOf('\nexport function installApplicationMenu(', createBegin);
  const order = [];
  let browserOptions;
  class BrowserWindow {
    constructor(options) {
      browserOptions = options;
      this.webContents = {
        setWindowOpenHandler() {},
        on: (event, callback) => { if (event === 'did-finish-load') { order.push('listener'); this.loaded = callback; } },
      };
    }
    once() {}
    loadURL() { order.push('load'); }
  }
  const createMainWindow = vm.runInNewContext(`(${source.slice(createBegin, createEnd).replace('export function createMainWindow', 'function')})`, {
    BrowserWindow, APP_NAME: 'Bitcoin Browser', APP_PARTITION: 'persist:test', process: { platform: 'linux' },
    boundsPersistence: new WeakMap(), createWindowBoundsPersistence: () => ({})
  });
  const window = createMainWindow({ stateStore: { get: () => null }, logger: null, preloadPath: '/fixture/preload.cjs', iconPath: '/fixture/bitcoin-browser-logo.png', onShellLoaded: () => {} });
  assert.deepEqual(order, ['listener', 'load']);
  assert.equal(browserOptions.title, 'Bitcoin Browser');
  assert.equal(browserOptions.icon, '/fixture/bitcoin-browser-logo.png');
  assert.equal(browserOptions.webPreferences.nodeIntegration, false);
  assert.equal(browserOptions.webPreferences.contextIsolation, true);
  assert.equal(browserOptions.webPreferences.sandbox, true);
  assert.equal(browserOptions.webPreferences.webSecurity, true);
  assert.equal(typeof window.loaded, 'function');
});

test('real main-window and controller composition delivers a link after a same-window reload', () => {
  const createBegin = source.indexOf('export function createMainWindow(');
  const createEnd = source.indexOf('\nexport function installApplicationMenu(', createBegin);
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.loading = true;
      this.destroyed = false;
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.isLoading = () => this.loading;
      this.webContents.send = (...args) => this.sent.push(args);
      this.webContents.setWindowOpenHandler = () => {};
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    loadURL() {}
  }
  const createMainWindow = vm.runInNewContext(`(${source.slice(createBegin, createEnd).replace('export function createMainWindow', 'function')})`, {
    BrowserWindow, APP_NAME: 'Bitcoin Browser', APP_PARTITION: 'persist:test', process: { platform: 'linux' },
    boundsPersistence: new WeakMap(), createWindowBoundsPersistence: () => ({})
  });
  const controller = factory({
    createWindow: createMainWindow,
    initialDeepLinks: []
  });
  const window = controller.initialize({ stateStore: { get: () => null }, logger: null, preloadPath: '/fixture' });
  window.loading = false;
  window.webContents.emit('did-finish-load');
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  controller.openDeepLink('satnav://during-reload');
  assert.deepEqual(window.sent, []);
  window.loading = true;
  window.webContents.emit('did-finish-load');
  assert.deepEqual(window.sent.map((entry) => entry[1]), ['satnav://during-reload']);
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  controller.openDeepLink('satnav://after-hash-change');
  window.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  controller.openDeepLink('satnav://during-subframe');
  assert.deepEqual(window.sent.map((entry) => entry[1]), ['satnav://during-reload', 'satnav://after-hash-change', 'satnav://during-subframe']);
  window.webContents.emit('did-start-navigation', {}, 'app://app/renderer/index.html', false, true);
  controller.openDeepLink('satnav://legacy-reload');
  assert.equal(window.sent.length, 3);
  window.webContents.emit('did-finish-load');
  assert.equal(window.sent.at(-1)[1], 'satnav://legacy-reload');
});

test('subframe loading cannot indefinitely queue a warm link after top-level load', () => {
  const { controller, windows } = fixture();
  controller.initialize({});
  windows[0].finish();
  windows[0].loading = true;
  controller.openDeepLink('satnav://while-subframe-loads');
  assert.deepEqual(windows[0].sent.map((entry) => entry[1]), ['satnav://while-subframe-loads']);
  assert.equal(controller.pendingCount, 0);
});

test('argv deep-link extraction is case-insensitive and type-safe', () => {
  const extract = vm.runInNewContext(`${factorySource}\nextractDeepLinkArgument`, {
    IPC: { APP_DEEP_LINK: 'app:deep-link' }
  });
  assert.equal(extract(['app', 3, 'SATNAV://inscription/abc']), 'SATNAV://inscription/abc');
  assert.equal(extract(['app', 'https://example.test']), null);
  assert.equal(extract(['app', 'satnav://bad\nvalue']), null);
  assert.equal(extract(['app', `satnav://${'a'.repeat(4088)}`]), null);
  assert.equal(extract(null), null);
  assert.equal(extract(['app', '--original-process-start-time=123'], { deepLink: 'satnav://about' }), 'satnav://about');
  assert.equal(extract(['app', 'satnav://home'], { deepLink: 'satnav://about' }), 'satnav://about');
  for (const deepLink of ['https://example.test', 'satnav://bad\nvalue', `satnav://${'a'.repeat(4088)}`, 42]) {
    assert.equal(extract(['app', 'satnav://home'], { deepLink }), 'satnav://home');
    assert.equal(extract(null, { deepLink }), null);
  }
});
