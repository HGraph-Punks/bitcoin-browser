import path from 'node:path';
import {
  app,
  protocol,
  safeStorage,
  session
} from 'electron';
import {
  APP_PARTITION,
  APP_SCHEME,
  CONTENT_SCHEME,
  DEEP_LINK_SCHEME,
  IPC,
  WALLET_PARTITION
} from '../shared/constants.js';
import { Logger } from './logger.js';
import { StateStore } from './state-store.js';
import { SecureStore } from './secure-store.js';
import { DiskCache } from './cache.js';
import { ProviderManager } from './provider-manager.js';
import { RecursiveResolver } from './resolver.js';
import { installAppProtocol } from './app-protocol.js';
import { installContentProtocol } from './content-protocol.js';
import { CONTENT_NETWORK_REQUEST_FILTER, createContentNetworkPolicyApplier, isContentRequestAllowed } from './content-network-policy.js';
import { installWalletProtocol } from './wallet-protocol.js';
import { ExtensionManager } from './extension-manager.js';
import { WalletManager } from './wallet-manager.js';
import { createQuitWatchdog, createSignalShutdownHandler, handleServiceBeforeQuit, LocalServiceManager, shutdownApplicationManagers } from './local-service-manager.js';
import { createMainWindow, createShellWindowController, extractDeepLinkArgument, flushWindowBounds, installApplicationMenu } from './window.js';
import { registerIpc } from './ipc.js';
import { installRendererDiagnostics, recordShellDocumentLoaded } from './renderer-diagnostics.js';

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } },
  { scheme: CONTENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

app.enableSandbox();
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow = null;
let pendingDeepLink = extractDeepLinkArgument(process.argv);
let localServiceManager = null;
let extensionManager = null;
let walletManager = null;
let logger = null;
let stateStore = null;
let secureStore = null;
let cache = null;
let providerManager = null;
let ipcLifecycle = null;
let healthTimer = null;
let appSession = null;
let walletSession = null;
let shutdownStartedAt = null;
const shellWindows = createShellWindowController({
  createWindow: createMainWindow,
  initialDeepLinks: pendingDeepLink ? [pendingDeepLink] : [],
  onWindow: (window) => { mainWindow = window; },
  onShellLoaded: (window) => recordShellDocumentLoaded(window.webContents, logger)
});
pendingDeepLink = null;
installRendererDiagnostics(app, {
  logger: () => logger,
  sessionLabel: (value) => value === appSession ? 'app' : value === walletSession ? 'wallet' : 'other'
});
const logShutdownPhase = (phase, elapsedMs) => {
  if (shutdownStartedAt === null) shutdownStartedAt = Date.now();
  const measuredElapsed = elapsedMs ?? Date.now() - shutdownStartedAt;
  const fields = { phase, pid: process.pid, elapsedMs: Math.max(0, measuredElapsed) };
  try { return Promise.resolve(logger?.info('app.shutdown', fields)).catch(() => console.error('app.shutdown', fields)); }
  catch { console.error('app.shutdown', fields); return Promise.resolve(); }
};
const quitWatchdog = createQuitWatchdog({ app, onPhase: (phase) => logShutdownPhase(phase) });
const requestSignalShutdown = createSignalShutdownHandler({
  app,
  logger: { info: (_event, fields) => logShutdownPhase(fields.phase) },
  quitWatchdog
});

process.once('SIGTERM', requestSignalShutdown);
process.once('SIGINT', requestSignalShutdown);

function sendDeepLink(url) {
  shellWindows.openDeepLink(url);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  sendDeepLink(url);
});

app.on('second-instance', (_event, argv) => {
  const deepLink = extractDeepLinkArgument(argv);
  if (deepLink) sendDeepLink(deepLink);
  else shellWindows.focusOrCreate();
});

app.whenReady().then(async () => {
  const appRoot = app.getAppPath();
  const dataDirectory = app.getPath('userData');
  const logDirectory = path.join(dataDirectory, 'logs');
  logger = new Logger(logDirectory);
  await logger.init();
  await logger.info('app.start', { version: app.getVersion(), electron: process.versions.electron, platform: process.platform });

  stateStore = new StateStore(path.join(dataDirectory, 'state'), logger);
  await stateStore.init();
  secureStore = new SecureStore(path.join(dataDirectory, 'secure'), safeStorage, logger);
  await secureStore.init();
  const settings = stateStore.get(['settings']);
  cache = new DiskCache(path.join(dataDirectory, 'cache'), { maxBytes: settings.cacheMaxBytes, maxEntryBytes: settings.maxResourceBytes }, logger);
  await cache.init();
  providerManager = new ProviderManager(stateStore, secureStore, logger, cache);
  const resolver = new RecursiveResolver(providerManager, cache, stateStore, logger);

  appSession = session.fromPartition(APP_PARTITION, { cache: true });
  walletSession = session.fromPartition(WALLET_PARTITION, { cache: true });
  installAppProtocol(appSession, appRoot, logger);
  installContentProtocol(appSession, resolver, stateStore, logger);
  installWalletProtocol(walletSession, appRoot, logger);

  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
  appSession.on('will-download', (event, item) => {
    event.preventDefault();
    logger.warn('content.download_blocked', { url: item.getURL(), mime: item.getMimeType(), bytes: item.getTotalBytes() });
  });
  appSession.webRequest.onBeforeRequest(CONTENT_NETWORK_REQUEST_FILTER, (details, callback) => {
    callback({ cancel: !isContentRequestAllowed(details, stateStore.get(['settings'])) });
  });
  walletSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  walletSession.setPermissionCheckHandler(() => false);

  extensionManager = new ExtensionManager(walletSession, stateStore, logger);
  await extensionManager.init();
  if (app.__servicesStopping || app.__servicesShutdownComplete) return;

  const preloadPath = path.join(appRoot, 'src', 'main', 'preload.cjs');
  installApplicationMenu(() => mainWindow);

  walletManager = new WalletManager({
    walletSession,
    preloadPath: path.join(appRoot, 'src', 'wallet', 'preload.cjs'),
    stateStore,
    logger,
    extensionManager,
    mainWindow: () => mainWindow,
    signingEnabled: process.env.SATOSHI_BROWSER_ENABLE_WALLET_SIGNING === '1' && !app.isPackaged
  });
  localServiceManager = new LocalServiceManager(stateStore, logger, (services) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.APP_COMMAND, { type: 'services-updated', services });
  });

  ipcLifecycle = registerIpc({
    app,
    getMainWindow: () => mainWindow,
    stateStore,
    secureStore,
    cache,
    providerManager,
    resolver,
    extensionManager,
    walletManager,
    localServiceManager,
    dataDirectory,
    logDirectory,
    logger,
    applyContentNetworkPolicy: createContentNetworkPolicyApplier(() => appSession.closeAllConnections())
  });

  shellWindows.initialize({ stateStore, logger, preloadPath });

  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  localServiceManager.autoStart().catch((error) => logger.warn('service.autostart_error', { message: error.message }));
  providerManager.healthAll().catch(() => {});
  healthTimer = setInterval(() => providerManager.healthAll().catch(() => {}), 60_000);
  healthTimer.unref();

  app.on('activate', () => {
    shellWindows.activate();
  });
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('before-quit', (event) => {
  shellWindows.beginShutdown();
  quitWatchdog.arm();
  handleServiceBeforeQuit(event, {
    app,
    localServiceManager,
    extensionManager,
    walletManager,
    logger,
    quitWatchdog,
    onPhase: (phase, elapsedMs) => logShutdownPhase(phase, elapsedMs),
    shutdown: () => {
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      return shutdownApplicationManagers({
        shutdownProvider: () => providerManager?.shutdown(),
        shutdownIpc: () => ipcLifecycle?.shutdown(),
        shutdownWallet: () => walletManager?.shutdown(),
        flushBounds: () => flushWindowBounds(mainWindow),
        shutdownServices: () => localServiceManager?.shutdown(),
        shutdownExtensions: () => extensionManager?.shutdown(),
        persistenceTasks: [() => secureStore?.flush(), () => cache?.flush(), () => stateStore?.flush?.()],
        finalTasks: [() => logger?.flush()],
        onPhase: (phase) => logShutdownPhase(phase)
      });
    }
  });
});

app.on('browser-window-created', (_event, window) => {
  const phase = (name) => {
    if (shutdownStartedAt === null) return;
    const fields = { phase: name, pid: process.pid, elapsedMs: Math.max(0, Date.now() - shutdownStartedAt), windowId: Number(window.id) };
    try { void Promise.resolve(logger?.info('app.shutdown', fields)).catch(() => console.error('app.shutdown', fields)); }
    catch { console.error('app.shutdown', fields); }
  };
  window.on('close', () => phase('window-close'));
  window.on('closed', () => phase('window-closed'));
  window.webContents.on('will-prevent-unload', () => phase('will-prevent-unload'));
});

app.on('will-quit', () => {
  void logShutdownPhase('will-quit');
});

app.on('quit', () => {
  quitWatchdog.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
