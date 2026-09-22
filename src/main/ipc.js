import path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import { APP_NAME, IPC } from '../shared/constants.js';
import { AppError, serializeError } from '../shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../shared/navigation.js';
import { assertString } from '../shared/validation.js';
import { inspectPsbt } from './psbt-inspector.js';
import { buildDiagnostics, writeDiagnostics } from './diagnostics.js';
import { writeContentFile } from './content-export.js';
import { NavigationRequests } from './navigation-requests.js';
import { validateAiRequest } from '../shared/local-ai.js';

function trustedAppSender(event) {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  return url.startsWith('app://app/renderer/');
}

export function registerIpc(options) {
  const mainWindow = () => options.getMainWindow();
  let stopping = false;
  const pending = new Set();
  let navigationRequests;
  let aiRequests;
  const aiRegistry = () => {
    if (stopping) throw new AppError('APP_SHUTTING_DOWN', 'The application is shutting down', { status: 503 });
    return aiRequests ??= new NavigationRequests({ maxEntries: 4,
      resolve: ({ input, progress }, signal) => options.localAi.run(input, signal, progress) });
  };
  const navigationRegistry = () => {
    if (stopping) throw new AppError('APP_SHUTTING_DOWN', 'The application is shutting down', { status: 503 });
    return navigationRequests ??= new NavigationRequests({
      resolve: ({ target, options: resolveOptions }, signal) => resolveTarget(target, { ...resolveOptions, signal })
    });
  };
  let settingsUpdates = Promise.resolve();
  const serializeSettingsUpdate = (action) => {
    const operation = settingsUpdates.then(action);
    settingsUpdates = operation.catch(() => {});
    return operation;
  };
  const admit = (action) => {
    const operation = Promise.resolve().then(action);
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  const admitImmediately = (action) => {
    // Register pending ownership before synchronous preparation captures the
    // sender document. There must be no await before that capture.
    let fulfill, reject;
    const operation = new Promise((resolve, fail) => { fulfill = resolve; reject = fail; });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    try { fulfill(action()); } catch (error) { reject(error); }
    return operation;
  };
  function handle(channel, handler, immediate = false) {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        if (!trustedAppSender(event)) throw new AppError('UNTRUSTED_IPC_SENDER', 'IPC request did not originate from the trusted application shell', { status: 403 });
        if (stopping) throw new AppError('APP_SHUTTING_DOWN', 'The application is shutting down', { status: 503 });
        const result = await (immediate ? admitImmediately : admit)(() => handler(event, payload ?? {}));
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: serializeError(error) };
      }
    });
  }

  handle(IPC.APP_BOOTSTRAP, async () => ({
    application: { name: APP_NAME, version: options.app.getVersion(), platform: process.platform, arch: process.arch, packaged: options.app.isPackaged },
    state: options.stateStore.snapshot(),
    stateRecovery: structuredClone(options.stateStore.recoveryStatus),
    providers: options.providerManager.list(),
    providerCleanup: cleanupSnapshot(),
    cache: options.cache.stats(),
    wallet: options.walletManager.snapshot(),
    extensions: options.extensionManager.list(),
    services: options.localServiceManager.list(),
    // Avoid blocking first paint on a locked or approval-gated OS keychain.
    // Availability is probed only when a user explicitly stores/exports secrets.
    secureStorageAvailable: options.secureStore.availabilityStatus()
  }));

  handle(IPC.APP_OPEN_EXTERNAL, async (_event, payload) => {
    const raw = assertString(payload.url, 'url', { min: 4, max: 4_096 });
    let url;
    try { url = new URL(raw); } catch { throw new AppError('INVALID_URL', 'External URL is invalid', { status: 400 }); }
    if (!['https:', 'http:', 'bitcoin:'].includes(url.protocol)) throw new AppError('UNSAFE_URL', 'Only HTTP(S) and bitcoin payment URLs can be opened externally', { status: 400 });
    const confirmation = await dialog.showMessageBox(mainWindow() ?? undefined, {
      type: url.protocol === 'http:' ? 'warning' : 'question',
      buttons: ['Cancel', 'Open externally'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Leave Bitcoin Browser?',
      message: url.protocol === 'bitcoin:' ? 'Open this payment request in your system wallet?' : 'Open this URL in your default web browser?',
      detail: url.toString()
    });
    if (confirmation.response !== 1) throw new AppError('USER_REJECTED', 'External navigation was cancelled', { status: 499 });
    await shell.openExternal(url.toString(), { activate: true });
    return true;
  });

  handle(IPC.APP_REVEAL_PATH, async (_event, payload) => {
    const directories = { cache: options.cache.directory, data: options.dataDirectory, logs: options.logDirectory };
    const directory = directories[payload.kind];
    if (!directory) throw new AppError('VALIDATION_ERROR', 'Unknown application directory', { status: 400 });
    const error = await shell.openPath(directory);
    if (error) throw new AppError('OPEN_PATH_FAILED', error, { status: 500 });
    return directory;
  });

  handle(IPC.NAV_PARSE, async (_event, payload) => parseNavigationInput(payload.input));
  // Same live-main-document ownership and prepare/cancel race protection as
  // navigation. Preparing performs no network/model work. Polling exposes only
  // browser-produced progress, never the prompt, history, API token, or config.
  handle(IPC.AI_PREPARE, (event, payload) => aiRegistry().prepare(event, {
    input: validateAiRequest(payload), progress: { phase: 'prepared', cards: [], browse: [], notes: [], answer: '' }
  }), true);
  handle(IPC.AI_RUN, (event, payload) => {
    navigationPayload(payload, ['handle']);
    return aiRegistry().resolve(event, payload.handle);
  });
  handle(IPC.AI_CANCEL, (event, payload) => {
    navigationPayload(payload, ['handle']);
    return aiRegistry().cancel(event, payload.handle);
  });
  handle(IPC.AI_PROGRESS, (event, payload) => {
    navigationPayload(payload, ['handle']);
    const entry = aiRegistry().lookup(event, payload.handle);
    return entry ? structuredClone(entry.request.progress) : null;
  });
  async function resolveTarget(target, resolveOptions) {
    if (['home', 'internal', 'search', 'collection', 'external-web', 'payment'].includes(target.kind)) return { target, entity: null, attempts: [] };
    const resolved = await options.providerManager.resolve(target, resolveOptions);
    return { target, ...resolved };
  }
  function navigationPayload(payload, allowed) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key))) {
      throw new AppError('VALIDATION_ERROR', 'Navigation request contains unsupported fields', { status: 400 });
    }
    return payload;
  }
  function navigationOptions(value) {
    const input = navigationPayload(value ?? {}, ['network', 'preferredProviderId', 'localOnly', 'timeoutMs', 'maxBytes']);
    const result = {};
    if (input.network !== undefined) {
      if (!['mainnet', 'testnet', 'signet', 'regtest'].includes(input.network)) throw new AppError('VALIDATION_ERROR', 'Unknown navigation network', { status: 400 });
      result.network = input.network;
    }
    if (input.preferredProviderId !== undefined) result.preferredProviderId = input.preferredProviderId === null
      ? null : assertString(input.preferredProviderId, 'preferredProviderId', { min: 3, max: 80 });
    if (input.localOnly !== undefined) {
      if (typeof input.localOnly !== 'boolean') throw new AppError('VALIDATION_ERROR', 'localOnly must be a boolean', { status: 400 });
      result.localOnly = input.localOnly;
    }
    for (const [key, max] of [['timeoutMs', 120_000], ['maxBytes', 1024 * 1024 * 1024]]) {
      if (input[key] === undefined) continue;
      if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > max) throw new AppError('VALIDATION_ERROR', `${key} is outside navigation limits`, { status: 400 });
      result[key] = input[key];
    }
    return result;
  }
  handle(IPC.ENTITY_RESOLVE_PREPARE, (event, payload) => {
    navigationPayload(payload, ['input', 'options']);
    const request = { target: parseNavigationInput(payload.input), options: navigationOptions(payload.options) };
    return navigationRegistry().prepare(event, request);
  }, true);
  handle(IPC.ENTITY_RESOLVE_CANCEL, (event, payload) => {
    navigationPayload(payload, ['handle']);
    return navigationRegistry().cancel(event, payload.handle);
  });
  handle(IPC.ENTITY_RESOLVE, async (event, payload) => {
    if (Object.hasOwn(payload, 'handle')) {
      navigationPayload(payload, ['handle']);
      return navigationRegistry().resolve(event, payload.handle);
    }
    // Preserve the existing two-argument facade. The interactive renderer uses
    // prepared requests so tab/document cancellation owns its provider signal.
    return resolveTarget(parseNavigationInput(payload.input), payload.options ?? {});
  });

  handle(IPC.CONTENT_SAVE, async (_event, payload) => {
    const inscriptionId = assertString(payload.inscriptionId, 'inscriptionId', { min: 66, max: 90, pattern: INSCRIPTION_ID_RE });
    const resource = await options.resolver.resolve(`/content/${inscriptionId}`, { accept: '*/*' });
    const mime = String(resource.headers?.['content-type'] ?? 'application/octet-stream').split(';', 1)[0].toLowerCase();
    const extension = ({
      'text/html': 'html', 'text/plain': 'txt', 'text/css': 'css', 'application/javascript': 'js', 'text/javascript': 'js',
      'application/json': 'json', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
      'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'application/pdf': 'pdf'
    })[mime] ?? 'bin';
    const selection = await dialog.showSaveDialog(mainWindow() ?? undefined, {
      title: 'Save inscription content',
      defaultPath: path.join(options.app.getPath('downloads'), `${inscriptionId}.${extension}`),
      filters: [{ name: `${mime} content`, extensions: [extension] }, { name: 'All files', extensions: ['*'] }]
    });
    if (selection.canceled || !selection.filePath) throw new AppError('USER_REJECTED', 'Content save was cancelled', { status: 499 });
    const saved = await writeContentFile(selection.filePath, resource.data);
    return { ...saved, mime };
  });

  handle(IPC.PROVIDERS_LIST, async () => options.providerManager.list());
  handle(IPC.PROVIDERS_SNAPSHOT, async () => providerSnapshot());
  handle(IPC.PROVIDERS_HEALTH, async () => options.providerManager.healthAll());
  handle(IPC.PROVIDERS_UPSERT, async (_event, payload) => {
    // Preserve a rejected edit's identity without moving validation outside its
    // outcome envelope. The manager validates the complete input before writes.
    const requestedId = (payload.provider ?? payload)?.id;
    const id = typeof requestedId === 'string' ? requestedId.trim() : null;
    return mutateProvider('upsert', id, () => options.providerManager.upsert(payload));
  });
  handle(IPC.PROVIDERS_RECOVER, async (_event, payload) => {
    const id = typeof payload.id === 'string' ? payload.id.trim() : null;
    return mutateProvider('recover', id, () => options.providerManager.recover(payload));
  });
  handle(IPC.PROVIDERS_REMOVE, async (_event, payload) => {
    const id = assertString(payload.id, 'id', { min: 3, max: 80 });
    return mutateProvider('remove', id, () => options.providerManager.remove(id));
  });
  handle(IPC.PROVIDERS_CLEANUP_REVIEW, async (_event, payload) => options.providerManager.reviewCleanup(payload));
  handle(IPC.PROVIDERS_CLEANUP, async (_event, payload) => {
    const id = typeof payload.id === 'string' ? payload.id.trim() : null;
    return mutateProvider('cleanup', id, () => options.providerManager.cleanup(payload));
  });
  handle(IPC.PROVIDERS_PREFERRED, async (_event, payload) => {
    const id = payload.id === null ? null : assertString(payload.id, 'id', { min: 3, max: 80 });
    return mutateProvider('preferred', id, async (markCommitted) => {
      options.providerManager.invalidateRouting();
      await options.stateStore.updateSettings({ preferredProviderId: id }, markCommitted);
      options.providerManager.invalidateRouting();
    });
  });

  function cleanupSnapshot() {
    try { return { cleanups: options.providerManager.cleanupList() }; }
    catch (error) { return { cleanups: null, stateReadErrors: { cleanups: serializeError(error) } }; }
  }

  function providerSnapshot() {
    let providers = null;
    let settings = null;
    const cleanup = cleanupSnapshot();
    const stateReadErrors = { ...cleanup.stateReadErrors };
    try { providers = options.providerManager.list(); }
    catch (error) { stateReadErrors.providers = serializeError(error); }
    try { settings = options.stateStore.get(['settings']); }
    catch (error) { stateReadErrors.settings = serializeError(error); }
    return { providers, settings, cleanups: cleanup.cleanups, ...(Object.keys(stateReadErrors).length ? { stateReadErrors } : {}) };
  }

  async function mutateProvider(operation, providerId, mutation) {
    let providerMutationCommitted = false;
    let mutationError;
    let failed = false;
    try {
      await mutation(() => { providerMutationCommitted = true; });
      providerMutationCommitted = true;
    } catch (error) {
      failed = true;
      mutationError = error;
      providerMutationCommitted ||= error?.details?.providerMutationCommitted === true
        || (operation === 'remove' && error?.code === 'PROVIDER_CREDENTIAL_CLEANUP_FAILED' && error.details?.providerRemoved === true);
    }
    // Snapshot failure does not undo a committed mutation. Keep reads within the
    // admitted IPC operation so shutdown owns the complete caller response.
    const outcome = { providerMutationCommitted, operation, providerId, ...providerSnapshot() };
    if (!failed) return outcome;
    const normalized = serializeError(mutationError);
    throw new AppError(normalized.code, normalized.message, {
      status: normalized.status,
      retryable: normalized.retryable,
      cause: mutationError,
      details: {
        ...(normalized.details && typeof normalized.details === 'object' && !Array.isArray(normalized.details) ? normalized.details : {}),
        ...outcome
      }
    });
  }

  handle(IPC.SETTINGS_UPDATE, async (_event, payload) => serializeSettingsUpdate(async () => {
    const changesRouting = ['network', 'localOnly', 'offlineMode', 'privacyMode', 'requestTimeoutMs', 'maxResourceBytes']
      .some((key) => Object.hasOwn(payload, key));
    if (changesRouting) options.providerManager.invalidateRouting();
    const previousSettings = options.stateStore.get(['settings']);
    const settings = await options.stateStore.updateSettings(payload);
    options.nodeSetup?.settingsChanged(settings);
    if (changesRouting) options.providerManager.invalidateRouting();
    const [cacheMaintenance, networkCutoff] = await Promise.allSettled([
      Promise.resolve().then(() => options.resolver.configure()),
      Promise.resolve().then(() => options.applyContentNetworkPolicy?.(previousSettings, settings))
    ]);
    if (networkCutoff.status === 'rejected') {
      throw new AppError('SETTINGS_NETWORK_CUTOFF_FAILED', 'Settings were saved, but existing browser content connections could not be closed', {
        status: 500,
        retryable: true,
        details: {
          settingsCommitted: true,
          settings,
          cause: serializeError(networkCutoff.reason),
          maintenance: 'content-network',
          ...(cacheMaintenance.status === 'rejected' ? { cacheCause: serializeError(cacheMaintenance.reason) } : {})
        }
      });
    }
    if (cacheMaintenance.status === 'rejected') {
      // Persistence already committed. Do not imply the privacy/network change
      // was rolled back just because disk-cache maintenance could not finish.
      throw new AppError('SETTINGS_CACHE_MAINTENANCE_FAILED', 'Settings were saved, but cache maintenance did not complete', {
        status: 500,
        retryable: true,
        details: { settingsCommitted: true, settings, cause: serializeError(cacheMaintenance.reason) }
      });
    }
    return settings;
  }));
  handle(IPC.TABS_SAVE, async (_event, payload) => {
    await options.stateStore.saveTabs(payload.tabs, payload.activeTabId);
    return true;
  });
  handle(IPC.HISTORY_LIST, async () => options.stateStore.get(['history']));
  handle(IPC.HISTORY_RECORD, async (_event, payload) => options.stateStore.recordHistory(payload));
  handle(IPC.HISTORY_CLEAR, async () => {
    await options.stateStore.mutate((draft) => { draft.history = []; });
    return [];
  });
  handle(IPC.BOOKMARKS_LIST, async () => options.stateStore.get(['bookmarks']));
  handle(IPC.BOOKMARKS_TOGGLE, async (_event, payload) => options.stateStore.toggleBookmark(payload));

  handle(IPC.CACHE_STATS, async () => options.cache.stats());
  handle(IPC.CACHE_CLEAR, async () => {
    let cacheClearCommitted = null;
    let cacheReady = null;
    try {
      await options.cache.clear();
      cacheClearCommitted = true;
      cacheReady = true;
      return options.cache.stats();
    } catch (error) {
      const normalized = serializeError(error);
      const details = normalized.details && typeof normalized.details === 'object' && !Array.isArray(normalized.details)
        ? normalized.details : {};
      if (cacheClearCommitted !== true && details.cacheClearCommitted === true) {
        cacheClearCommitted = true;
        cacheReady = details.cacheReady === false ? false : null;
      }
      let cache = null;
      let cacheReadError;
      // Recursive removal can partially succeed before rejecting. Do not
      // publish the old in-memory map as a verified snapshot in that case.
      if (cacheClearCommitted === true) {
        try { cache = options.cache.stats(); }
        catch (readError) { cacheReadError = serializeError(readError); }
      }
      throw new AppError(normalized.code, normalized.message, {
        cause: error, status: normalized.status, retryable: normalized.retryable,
        details: { ...details, cacheClearCommitted, cacheReady, cache, ...(cacheReadError ? { cacheReadError } : {}) }
      });
    }
  });
  handle(IPC.RESOLVER_GRAPH, async (_event, payload) => {
    const id = assertString(payload.inscriptionId, 'inscriptionId', { pattern: INSCRIPTION_ID_RE, max: 100 });
    return options.resolver.inspectGraph(id.toLowerCase(), payload.options ?? {});
  });
  handle(IPC.PSBT_INSPECT, async (_event, payload) => inspectPsbt(payload.psbt, options.stateStore.get(['settings', 'network'])));

  handle(IPC.EXTENSIONS_LIST, async () => options.extensionManager.list());
  handle(IPC.EXTENSIONS_INSTALL, async () => {
    const selection = await dialog.showOpenDialog(mainWindow() ?? undefined, {
      title: 'Select an unpacked Bitcoin wallet extension',
      properties: ['openDirectory'],
      message: 'The extension will load only inside the isolated Wallet Bridge partition.'
    });
    if (selection.canceled || selection.filePaths.length !== 1) throw new AppError('USER_REJECTED', 'Wallet extension selection was cancelled', { status: 499 });
    return mutateExtension('install', null, () => options.extensionManager.install(selection.filePaths[0]));
  });
  handle(IPC.EXTENSIONS_REMOVE, async (_event, payload) => {
    const id = assertString(payload.id, 'id', { min: 3, max: 160 });
    return mutateExtension('remove', id, () => options.extensionManager.remove(id));
  });

  async function mutateExtension(operation, requestedId, mutation) {
    let lease;
    try {
      lease = options.walletManager.beginExtensionChange();
    } catch (error) {
      const normalized = serializeError(error);
      const outcome = extensionOutcome();
      throw new AppError(normalized.code, normalized.message, {
        status: normalized.status,
        retryable: normalized.retryable,
        cause: error,
        details: {
          ...(normalized.details && typeof normalized.details === 'object' ? normalized.details : {}),
          extensionMutationCommitted: false,
          operation,
          extensionId: requestedId,
          ...outcome,
          walletRefreshPending: outcome.wallet?.extensionRecovery != null,
          ...(outcome.wallet?.extensionRecovery ? { recovery: 'wallet:discover' } : {})
        }
      });
    }
    let mutationResult;
    let mutationError;
    try {
      mutationResult = await mutation();
    } catch (error) {
      mutationError = error;
    }
    let refreshError;
    try {
      await options.walletManager.endExtensionChange(lease, { refresh: !stopping });
    } catch (error) {
      refreshError = error;
    }
    const { extensions, wallet, ...outcomeErrors } = extensionOutcome();
    const extensionId = operation === 'install' ? (mutationResult?.id ?? null) : requestedId;
    if (mutationError) {
      const normalized = serializeError(mutationError);
      throw new AppError(normalized.code, normalized.message, {
        status: normalized.status,
        retryable: normalized.retryable,
        cause: mutationError,
        details: {
          ...(normalized.details && typeof normalized.details === 'object' ? normalized.details : {}),
          extensionMutationCommitted: false,
          operation,
          extensionId,
          extensions,
          wallet,
          ...outcomeErrors,
          walletRefreshPending: Boolean(refreshError),
          ...(refreshError ? { refreshError: serializeError(refreshError), recovery: 'wallet:discover' } : {})
        }
      });
    }
    const result = {
      extensionMutationCommitted: true,
      operation,
      extensionId,
      extensions,
      wallet,
      ...outcomeErrors,
      walletRefreshPending: Boolean(refreshError)
    };
    if (refreshError) {
      throw new AppError('EXTENSION_WALLET_REFRESH_FAILED', 'The extension change was saved, but Wallet Bridge refresh failed', {
        status: 503,
        retryable: true,
        cause: refreshError,
        details: { ...result, cause: serializeError(refreshError), recovery: 'wallet:discover' }
      });
    }
    return result;
  }

  function extensionOutcome() {
    const errors = [];
    let extensions = null;
    let wallet = null;
    try { extensions = options.extensionManager.list(); } catch (error) { errors.push({ source: 'extensions', error: serializeError(error) }); }
    try { wallet = options.walletManager.snapshot(); } catch (error) { errors.push({ source: 'wallet', error: serializeError(error) }); }
    return { extensions, wallet, ...(errors.length ? { stateReadErrors: errors } : {}) };
  }

  handle(IPC.WALLET_OPEN, async () => { await options.walletManager.open(true); return options.walletManager.snapshot(); });
  handle(IPC.WALLET_DISCOVER, async () => options.walletManager.discover());
  handle(IPC.WALLET_CONNECT, async (_event, payload) => options.walletManager.connect(assertString(payload.walletId, 'walletId', { min: 1, max: 120 })));
  handle(IPC.WALLET_DISCONNECT, async () => options.walletManager.disconnect());
  handle(IPC.WALLET_SIGN_PSBT, async (_event, payload) => options.walletManager.signPsbt(payload));
  handle(IPC.WALLET_SIGN_MESSAGE, async (_event, payload) => options.walletManager.signMessage(payload));

  handle(IPC.LOCAL_SERVICES_LIST, async () => options.localServiceManager.list());
  handle(IPC.NODE_SETUP, async (_event, payload) => options.nodeSetup.run(payload));
  handle(IPC.LOCAL_SERVICES_UPSERT, async (_event, payload) => options.localServiceManager.upsert(payload));
  handle(IPC.LOCAL_SERVICES_REMOVE, async (_event, payload) => { await options.localServiceManager.remove(assertString(payload.id, 'id', { min: 1, max: 80 })); return options.localServiceManager.list(); });
  handle(IPC.LOCAL_SERVICES_START, async (_event, payload) => options.localServiceManager.start(assertString(payload.id, 'id', { min: 1, max: 80 })));
  handle(IPC.LOCAL_SERVICES_STOP, async (_event, payload) => options.localServiceManager.stop(assertString(payload.id, 'id', { min: 1, max: 80 })));

  handle(IPC.DIAGNOSTICS_EXPORT, async () => {
    const defaultPath = path.join(options.app.getPath('documents'), `bitcoin-browser-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const selection = await dialog.showSaveDialog(mainWindow() ?? undefined, {
      title: 'Export redacted diagnostics',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (selection.canceled || !selection.filePath) throw new AppError('USER_REJECTED', 'Diagnostics export was cancelled', { status: 499 });
    const diagnostics = await buildDiagnostics(options);
    await writeDiagnostics(selection.filePath, diagnostics);
    return selection.filePath;
  });

  function reportBridgeFailure(event, error) {
    // Fire-and-forget notifications have no invoke response. Queue a bounded
    // warning without allowing diagnostic failure to escape event dispatch.
    // The application's final logger flush owns normal queued logger writes.
    try {
      void Promise.resolve(options.logger?.warn(event, {
        message: String(error?.message ?? error).slice(0, 1_024)
      })).catch(() => {});
    } catch {}
  }

  ipcMain.on(IPC.WALLET_BRIDGE_READY, (event) => {
    if (stopping) return;
    try { options.walletManager.handleReady(event.sender); }
    catch (error) { reportBridgeFailure('wallet.bridge_ready_failed', error); }
  });
  ipcMain.on(IPC.WALLET_BRIDGE_EVENT, (event, payload) => {
    if (stopping) return;
    admit(() => options.walletManager.handleBridgeEvent(event.sender, payload))
      .catch((error) => reportBridgeFailure('wallet.bridge_event_failed', error));
  });
  return {
    shutdown() {
      stopping = true;
      const navigationDrain = navigationRequests?.shutdown();
      const aiDrain = aiRequests?.shutdown();
      return Promise.allSettled([...pending, ...(navigationDrain ? [navigationDrain] : []), ...(aiDrain ? [aiDrain] : [])]);
    }
  };
}
