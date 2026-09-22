import path from 'node:path';
import { BrowserWindow, Menu } from 'electron';
import { APP_NAME, APP_PARTITION, IPC } from '../shared/constants.js';

const boundsPersistence = new WeakMap();

export function createWindowBoundsPersistence(window, stateStore, logger, delayMs = 400) {
  let timer;
  let queue = Promise.resolve();
  let frozen = false;
  const capture = () => {
    clearTimeout(timer);
    timer = undefined;
    if (frozen) return queue;
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return queue;
    const bounds = window.getBounds();
    const persist = () => stateStore.mutate((draft) => { draft.windowBounds = bounds; });
    const operation = queue.then(persist, persist);
    queue = operation.catch(() => {});
    return operation;
  };
  const schedule = () => {
    if (frozen) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void capture().catch((error) => logger?.warn('window.bounds_save_failed', { message: error.message })); }, delayMs);
  };
  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('close', () => {
    if (!frozen) void capture().catch((error) => logger?.warn('window.bounds_save_failed', { message: error.message }));
  });
  const flush = () => {
    const operation = capture();
    frozen = true;
    clearTimeout(timer);
    timer = undefined;
    return operation;
  };
  return { capture, flush };
}

export function flushWindowBounds(window) {
  return boundsPersistence.get(window)?.flush() ?? Promise.resolve();
}

const MAX_DEEP_LINK_LENGTH = 4096;

function validDeepLink(value) {
  return typeof value === 'string'
    && value.length <= MAX_DEEP_LINK_LENGTH
    && /^satnav:\/\/[^\s\u0000-\u001f\u007f]*$/i.test(value);
}

export function extractDeepLinkArgument(argv, additionalData) {
  // Electron/Chromium can rewrite second-instance argv on Windows. Preserve
  // the validated original URL through the lock's explicit JSON payload.
  if (validDeepLink(additionalData?.deepLink)) return additionalData.deepLink;
  if (!Array.isArray(argv)) return null;
  return argv.find((argument) => validDeepLink(argument)) ?? null;
}

export function createShellWindowController(options) {
  let windowOptions = null;
  let currentWindow = null;
  let stopping = false;
  let shellLoaded = false;
  const initialDeepLink = Array.isArray(options.initialDeepLinks) ? options.initialDeepLinks.at(-1) : null;
  let pendingDeepLink = validDeepLink(initialDeepLink) ? initialDeepLink : null;
  let focusWhenLoaded = Boolean(pendingDeepLink);

  const focus = (window) => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const deliverPending = (window) => {
    if (stopping || currentWindow !== window || window.isDestroyed() || !shellLoaded) return;
    if (!pendingDeepLink) return;
    const link = pendingDeepLink;
    pendingDeepLink = null;
    window.webContents.send(IPC.APP_DEEP_LINK, link);
  };
  const create = () => {
    if (stopping || !windowOptions) return null;
    shellLoaded = false;
    const window = options.createWindow({
      ...windowOptions,
      onShellLoading: (loadingWindow) => {
        if (loadingWindow !== currentWindow || stopping || loadingWindow.isDestroyed()) return;
        shellLoaded = false;
      },
      onShellLoaded: (loadedWindow) => {
        if (loadedWindow !== currentWindow || stopping || loadedWindow.isDestroyed()) return;
        shellLoaded = true;
        options.onShellLoaded?.(loadedWindow);
        deliverPending(loadedWindow);
        if (focusWhenLoaded) {
          focusWhenLoaded = false;
          focus(loadedWindow);
        }
      }
    });
    currentWindow = window;
    options.onWindow?.(window);
    return window;
  };
  const ensure = () => {
    if (stopping || !windowOptions) return null;
    if (!currentWindow || currentWindow.isDestroyed()) return create();
    return currentWindow;
  };

  return {
    initialize(value) {
      if (windowOptions || stopping) return currentWindow;
      windowOptions = value;
      return ensure();
    },
    openDeepLink(url) {
      if (stopping || !validDeepLink(url)) return null;
      pendingDeepLink = url;
      focusWhenLoaded = true;
      const window = ensure();
      if (!window) return null;
      deliverPending(window);
      if (shellLoaded) {
        focusWhenLoaded = false;
        focus(window);
      }
      return window;
    },
    focusOrCreate() {
      const window = ensure();
      if (window && !shellLoaded) focusWhenLoaded = true;
      else focus(window);
      return window;
    },
    activate() {
      const window = ensure();
      if (window && !shellLoaded) focusWhenLoaded = true;
      else focus(window);
      return window;
    },
    beginShutdown() {
      stopping = true;
      pendingDeepLink = null;
      focusWhenLoaded = false;
    },
    get current() { return currentWindow; },
    get pendingCount() { return pendingDeepLink ? 1 : 0; }
  };
}

export function createMainWindow(options) {
  const saved = options.stateStore.get(['windowBounds']);
  const window = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 920,
    x: saved?.x,
    y: saved?.y,
    minWidth: 740,
    minHeight: 560,
    show: false,
    backgroundColor: '#090b0e',
    title: APP_NAME,
    icon: options.iconPath,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 15, y: 16 },
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#0b0e12', symbolColor: '#d9e0e8', height: 44 },
    webPreferences: {
      preload: options.preloadPath,
      partition: APP_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://app/renderer/')) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => options.logger?.error('renderer.gone', details));
  if (typeof options.onShellLoaded === 'function') {
    window.webContents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
      const mainFrame = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
      const sameDocument = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace;
      if (mainFrame && sameDocument === false) options.onShellLoading?.(window);
    });
    window.webContents.on('did-finish-load', () => options.onShellLoaded(window));
  }
  window.once('ready-to-show', () => window.show());
  boundsPersistence.set(window, createWindowBoundsPersistence(window, options.stateStore, options.logger));
  window.loadURL('app://app/renderer/index.html');
  return window;
}

export function installApplicationMenu(getWindow) {
  const send = (command) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.APP_COMMAND, command);
  };
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu', label: APP_NAME, submenu: [
      { label: `About ${APP_NAME}`, click: () => send('about') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide', label: `Hide ${APP_NAME}` }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit', label: `Quit ${APP_NAME}` }
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Focus Omnibox', accelerator: 'CmdOrCtrl+L', click: () => send('focus-omnibox') },
      { label: 'Reload Data', accelerator: 'CmdOrCtrl+R', click: () => send('reload') },
      { label: 'Command Palette', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('command-palette') },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }
    ] },
    { label: 'Navigate', submenu: [
      { label: 'Back', accelerator: 'Alt+Left', click: () => send('back') },
      { label: 'Forward', accelerator: 'Alt+Right', click: () => send('forward') },
      { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => send('home') }
    ] },
    { label: 'Tools', submenu: [
      { label: 'Wallet', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('wallet') },
      { label: 'Providers', click: () => send('providers') },
      { label: 'Developer Inspector', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('developer') },
      { type: 'separator' }, { role: 'toggleDevTools' }
    ] },
    { role: 'help', submenu: [
      { label: 'Documentation', click: () => send('documentation') },
      { label: 'Sponsors', click: () => send('sponsors') },
      { label: `About ${APP_NAME}`, click: () => send('about') }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
