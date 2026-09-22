import path from 'node:path';
import {
  app,
  dialog,
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
import { LocalAiManager } from './local-ai.js';
import { installRendererDiagnostics, recordShellDocumentLoaded } from './renderer-diagnostics.js';
import { createStartupLifecycle } from './startup-lifecycle.js';
import { NodeSoftware } from './node-software.js';
import { NodeSetupManager } from './node-setup-manager.js';
import { createNodeSetupDialogs } from './node-setup-dialogs.js';

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true } },
  { scheme: CONTENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

app.enableSandbox();
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const singleInstance = app.requestSingleInstanceLock({ deepLink: extractDeepLinkArgument(process.argv) });
if (!singleInstance) app.quit();

let mainWindow = null;
let pendingDeepLink = extractDeepLinkArgument(process.argv);
let localServiceManager = null;
let nodeSetup = null;
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
const startup = createStartupLifecycle();
const initialized = { logger: false, state: false, secure: false, cache: false };
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

app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  const deepLink = extractDeepLinkArgument(argv, additionalData);
  if (deepLink) sendDeepLink(deepLink);
  else shellWindows.focusOrCreate();
});

async function initializeApplication({ step }) {
  const appRoot = app.getAppPath();
  const dataDirectory = app.getPath('userData');
  const logDirectory = path.join(dataDirectory, 'logs');
  await step(async () => {
    logger = new Logger(logDirectory);
    await logger.init();
    initialized.logger = true;
  });
  await step(() => logger.info('app.start', { version: app.getVersion(), electron: process.versions.electron, platform: process.platform }));

  await step(async () => {
    stateStore = new StateStore(path.join(dataDirectory, 'state'), logger);
    await stateStore.init();
    initialized.state = true;
  });
  await step(async () => {
    secureStore = new SecureStore(path.join(dataDirectory, 'secure'), safeStorage, logger);
    await secureStore.init();
    initialized.secure = true;
  });
  await step(async () => {
    const settings = stateStore.get(['settings']);
    cache = new DiskCache(path.join(dataDirectory, 'cache'), { maxBytes: settings.cacheMaxBytes, maxEntryBytes: settings.maxResourceBytes }, logger);
    await cache.init();
    initialized.cache = true;
  });
  let resolver;
  await step(() => {
    providerManager = new ProviderManager(stateStore, secureStore, logger, cache);
    resolver = new RecursiveResolver(providerManager, cache, stateStore, logger);
  });

  await step(() => { appSession = session.fromPartition(APP_PARTITION, { cache: true }); });
  await step(() => { walletSession = session.fromPartition(WALLET_PARTITION, { cache: true }); });
  await step(() => installAppProtocol(appSession, appRoot, logger));
  await step(() => installContentProtocol(appSession, resolver, stateStore, logger));
  await step(() => installWalletProtocol(walletSession, appRoot, logger));

  await step(() => {
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
  });

  await step(async () => {
    extensionManager = new ExtensionManager(walletSession, stateStore, logger);
    await extensionManager.init();
  });

  const preloadPath = path.join(appRoot, 'src', 'main', 'preload.cjs');
  const iconPath = path.join(appRoot, 'src', 'renderer', 'assets', 'bitcoin-browser-logo.png');
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(iconPath);
  await step(() => installApplicationMenu(() => mainWindow));

  await step(() => {
    walletManager = new WalletManager({
      walletSession,
      preloadPath: path.join(appRoot, 'src', 'wallet', 'preload.cjs'),
      iconPath,
      stateStore,
      logger,
      extensionManager,
      mainWindow: () => mainWindow,
      signingEnabled: process.env.SATOSHI_BROWSER_ENABLE_WALLET_SIGNING === '1' && !app.isPackaged
    });
  });
  await step(() => {
    localServiceManager = new LocalServiceManager(stateStore, logger, (services) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.APP_COMMAND, { type: 'services-updated', services });
    });
  });

  await step(() => {
    nodeSetup = new NodeSetupManager({ stateStore, providerManager, localServiceManager,
      software: new NodeSoftware({ directory: path.join(dataDirectory, 'node-software') }),
      rootDirectory: path.join(dataDirectory, 'nodes'),
      ...createNodeSetupDialogs(dialog, () => mainWindow)
    });
  });

  await step(() => {
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
      nodeSetup,
      localAi: new LocalAiManager({ stateStore, providerManager, resolver }),
      dataDirectory,
      logDirectory,
      logger,
      applyContentNetworkPolicy: createContentNetworkPolicyApplier(() => appSession.closeAllConnections())
    });
  });

  await step(() => shellWindows.initialize({ stateStore, logger, preloadPath, iconPath }));

  await step(() => {
    if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    else app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  });

  await step(() => {
    localServiceManager.autoStart().catch((error) => logger.warn('service.autostart_error', { message: error.message }));
    nodeSetup.autoStart().catch((error) => logger.warn('node-setup.autostart_error', { code: error.code ?? 'NODE_SETUP_ERROR' }));
  });
  await step(() => { providerManager.healthAll().catch(() => {}); });
  await step(() => {
    healthTimer = setInterval(() => providerManager.healthAll().catch(() => {}), 60_000);
    healthTimer.unref();
    app.on('activate', () => {
      shellWindows.activate();
    });
  });
}

if (singleInstance) {
  app.whenReady().then(
    () => startup.run(initializeApplication),
    (error) => startup.run(() => { throw error; })
  ).catch((error) => {
    if (startup.isStopError(error)) return;
    console.error(error);
    // The startup drain retains this failure. Quit performs cleanup and exits
    // nonzero through the same bounded shutdown path as other lifecycle errors.
    if (!app.__servicesStopping && !app.__servicesShutdownComplete) app.quit();
  });
}

app.on('before-quit', (event) => {
  startup.stop();
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
        shutdownStartup: () => startup.stop(),
        shutdownNodeSetup: () => nodeSetup?.shutdown(),
        shutdownProvider: () => providerManager?.shutdown(),
        shutdownIpc: () => ipcLifecycle?.shutdown(),
        shutdownWallet: () => walletManager?.shutdown(),
        flushBounds: () => flushWindowBounds(mainWindow),
        shutdownServices: () => localServiceManager?.shutdown(),
        shutdownExtensions: () => extensionManager?.shutdown(),
        persistenceTasks: [
          () => initialized.secure ? secureStore.flush() : undefined,
          () => initialized.cache ? cache.flush() : undefined,
          () => initialized.state ? stateStore.flush() : undefined
        ],
        finalTasks: [() => initialized.logger ? logger.flush() : undefined],
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
