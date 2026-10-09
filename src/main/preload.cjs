'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const C = {
  APP_BOOTSTRAP: 'app:bootstrap', APP_COMMAND: 'app:command', APP_DEEP_LINK: 'app:deep-link', APP_OPEN_EXTERNAL: 'app:open-external', APP_REVEAL_PATH: 'app:reveal-path',
  NAV_PARSE: 'navigation:parse', ENTITY_RESOLVE: 'entity:resolve', CONTENT_SAVE: 'content:save',
  ENTITY_RESOLVE_PREPARE: 'entity:resolve-prepare', ENTITY_RESOLVE_CANCEL: 'entity:resolve-cancel',
  AI_PREPARE: 'ai:prepare', AI_RUN: 'ai:run', AI_PROGRESS: 'ai:progress', AI_CANCEL: 'ai:cancel',
  PROVIDERS_LIST: 'providers:list', PROVIDERS_SNAPSHOT: 'providers:snapshot', PROVIDERS_HEALTH: 'providers:health', PROVIDERS_UPSERT: 'providers:upsert', PROVIDERS_REMOVE: 'providers:remove', PROVIDERS_PREFERRED: 'providers:preferred',
  PROVIDERS_RECOVER: 'providers:recover',
  PROVIDERS_CLEANUP_REVIEW: 'providers:cleanup-review', PROVIDERS_CLEANUP: 'providers:cleanup',
  SETTINGS_UPDATE: 'settings:update', TABS_SAVE: 'tabs:save',
  NODE_SETUP: 'node-setup:action',
  HISTORY_LIST: 'history:list', HISTORY_RECORD: 'history:record', HISTORY_CLEAR: 'history:clear',
  BOOKMARKS_LIST: 'bookmarks:list', BOOKMARKS_TOGGLE: 'bookmarks:toggle',
  CACHE_STATS: 'cache:stats', CACHE_CLEAR: 'cache:clear', RESOLVER_GRAPH: 'resolver:graph', PSBT_INSPECT: 'psbt:inspect',
  EXTENSIONS_LIST: 'extensions:list', EXTENSIONS_INSTALL: 'extensions:install', EXTENSIONS_REMOVE: 'extensions:remove',
  WALLET_OPEN: 'wallet:open', WALLET_DISCOVER: 'wallet:discover', WALLET_CONNECT: 'wallet:connect', WALLET_DISCONNECT: 'wallet:disconnect', WALLET_SIGN_PSBT: 'wallet:sign-psbt', WALLET_SIGN_MESSAGE: 'wallet:sign-message', WALLET_STATE: 'wallet:state',
  LOCAL_SERVICES_LIST: 'local-services:list', LOCAL_SERVICES_UPSERT: 'local-services:upsert', LOCAL_SERVICES_REMOVE: 'local-services:remove', LOCAL_SERVICES_START: 'local-services:start', LOCAL_SERVICES_STOP: 'local-services:stop',
  DIAGNOSTICS_EXPORT: 'diagnostics:export'
};

function serializableError(value, fallbackCode = 'INTERNAL_ERROR') {
  const source = value && typeof value === 'object' ? value : {};
  const status = Number(source.status);
  return {
    name: 'SatBrowserError',
    code: typeof source.code === 'string' && source.code ? source.code : fallbackCode,
    message: typeof source.message === 'string' && source.message ? source.message : 'Application request failed',
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
    retryable: Boolean(source.retryable),
    details: source.details ?? null
  };
}

async function invoke(channel, payload) {
  let envelope;
  try {
    envelope = await ipcRenderer.invoke(channel, payload);
  } catch (error) {
    // Electron serializes native Error rejections across contextBridge without
    // preserving custom fields. Reject with a structured-cloneable record so
    // callers retain actionable error metadata in packaged applications.
    throw serializableError(error, 'IPC_TRANSPORT_ERROR');
  }
  if (envelope && envelope.ok) return envelope.result;
  throw serializableError(envelope?.error);
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const navigationRequests = new Map();
function navigationError(code, message, status = 499) {
  return serializableError({ code, message, status });
}
function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    throw navigationError('VALIDATION_ERROR', 'Navigation request ID is invalid', 400);
  }
}
function cancelMainResolution(entry) {
  // Share both successful and failed cancellation dispatch; never repeat a
  // control mutation automatically because its acknowledgment failed.
  if (!entry.cancellation) entry.cancellation = invoke(C.ENTITY_RESOLVE_CANCEL, { handle: entry.handle });
  return entry.cancellation;
}
async function cancelNavigation(requestId) {
  validateRequestId(requestId);
  const entry = navigationRequests.get(requestId);
  if (!entry) return { requested: false };
  entry.cancelled = true;
  await entry.preparation;
  await cancelMainResolution(entry);
  return { requested: true };
}
async function resolveNavigation(input, options, requestId) {
  if (requestId === undefined) return invoke(C.ENTITY_RESOLVE, { input, options });
  validateRequestId(requestId);
  if (navigationRequests.has(requestId)) throw navigationError('NAVIGATION_REQUEST_CONFLICT', 'Navigation request is already pending', 409);
  if (navigationRequests.size >= 128) throw navigationError('NAVIGATION_REQUEST_LIMIT', 'Too many navigation requests are pending', 429);
  const entry = { cancelled: false, handle: null, cancellation: null, preparation: null };
  // Install local intent ownership before invoking IPC. The main-issued handle
  // is hidden from the renderer and no provider work starts during preparation.
  navigationRequests.set(requestId, entry);
  entry.preparation = invoke(C.ENTITY_RESOLVE_PREPARE, { input, options }).then(prepared => {
    if (!Number.isSafeInteger(prepared?.handle) || prepared.handle < 1) {
      throw navigationError('IPC_INVALID_RESPONSE', 'Navigation preparation returned an invalid handle', 502);
    }
    entry.handle = prepared.handle;
  });
  try {
    await entry.preparation;
    if (entry.cancelled) {
      // Cancellation while preparation was in flight cannot resurrect work.
      await cancelMainResolution(entry);
      throw navigationError('NAVIGATION_CANCELLED', 'Navigation was cancelled');
    }
    const result = await invoke(C.ENTITY_RESOLVE, { handle: entry.handle });
    if (entry.cancelled) throw navigationError('NAVIGATION_CANCELLED', 'Navigation was cancelled');
    return result;
  } catch (error) {
    const failure = serializableError(error);
    if (entry.handle !== null) {
      try { await cancelMainResolution(entry); }
      catch (cancelError) {
        if (cancelError !== error) failure.details = { ...failure.details, cancellationError: serializableError(cancelError) };
      }
    }
    throw failure;
  } finally {
    if (navigationRequests.get(requestId) === entry) navigationRequests.delete(requestId);
  }
}

if(typeof location==='undefined' || location.href==='app://app/renderer/index.html'){
contextBridge.exposeInMainWorld('satBrowser', {
  creator: {open:()=>invoke('creator:open')},
  app: {
    bootstrap: () => invoke(C.APP_BOOTSTRAP),
    openExternal: (url) => invoke(C.APP_OPEN_EXTERNAL, { url }),
    revealPath: (kind) => invoke(C.APP_REVEAL_PATH, { kind }),
    onCommand: (callback) => subscribe(C.APP_COMMAND, callback),
    onDeepLink: (callback) => subscribe(C.APP_DEEP_LINK, callback)
  },
  navigation: { parse: (input) => invoke(C.NAV_PARSE, { input }), resolve: resolveNavigation, cancelResolve: cancelNavigation },
  ai: {
    prepare: (request) => invoke(C.AI_PREPARE, request), run: (handle) => invoke(C.AI_RUN, { handle }),
    progress: (handle) => invoke(C.AI_PROGRESS, { handle }), cancel: (handle) => invoke(C.AI_CANCEL, { handle })
  },
  content: { save: (inscriptionId) => invoke(C.CONTENT_SAVE, { inscriptionId }) },
  providers: {
    list: () => invoke(C.PROVIDERS_LIST), snapshot: () => invoke(C.PROVIDERS_SNAPSHOT), health: () => invoke(C.PROVIDERS_HEALTH),
    upsert: (provider, credentials) => invoke(C.PROVIDERS_UPSERT, { provider, credentials }),
    recover: (request) => invoke(C.PROVIDERS_RECOVER, request),
    reviewCleanup: (id) => invoke(C.PROVIDERS_CLEANUP_REVIEW, { id }),
    cleanup: (request) => invoke(C.PROVIDERS_CLEANUP, request),
    remove: (id) => invoke(C.PROVIDERS_REMOVE, { id }), preferred: (id) => invoke(C.PROVIDERS_PREFERRED, { id })
  },
  settings: { update: (patch) => invoke(C.SETTINGS_UPDATE, patch) },
  nodeSetup: { run: (action, payload = {}) => invoke(C.NODE_SETUP, { ...payload, action }) },
  tabs: { save: (tabs, activeTabId) => invoke(C.TABS_SAVE, { tabs, activeTabId }) },
  history: { list: () => invoke(C.HISTORY_LIST), record: (entry) => invoke(C.HISTORY_RECORD, entry), clear: () => invoke(C.HISTORY_CLEAR) },
  bookmarks: { list: () => invoke(C.BOOKMARKS_LIST), toggle: (entry) => invoke(C.BOOKMARKS_TOGGLE, entry) },
  cache: { stats: () => invoke(C.CACHE_STATS), clear: () => invoke(C.CACHE_CLEAR) },
  resolver: { graph: (inscriptionId, options) => invoke(C.RESOLVER_GRAPH, { inscriptionId, options }) },
  psbt: { inspect: (psbt) => invoke(C.PSBT_INSPECT, { psbt }) },
  extensions: { list: () => invoke(C.EXTENSIONS_LIST), install: () => invoke(C.EXTENSIONS_INSTALL), remove: (id) => invoke(C.EXTENSIONS_REMOVE, { id }) },
  wallet: {
    open: () => invoke(C.WALLET_OPEN), discover: () => invoke(C.WALLET_DISCOVER), connect: (walletId) => invoke(C.WALLET_CONNECT, { walletId }),
    disconnect: () => invoke(C.WALLET_DISCONNECT), signPsbt: (payload) => invoke(C.WALLET_SIGN_PSBT, payload), signMessage: (payload) => invoke(C.WALLET_SIGN_MESSAGE, payload),
    onState: (callback) => subscribe(C.WALLET_STATE, callback)
  },
  services: {
    list: () => invoke(C.LOCAL_SERVICES_LIST), upsert: (service) => invoke(C.LOCAL_SERVICES_UPSERT, service), remove: (id) => invoke(C.LOCAL_SERVICES_REMOVE, { id }),
    start: (id) => invoke(C.LOCAL_SERVICES_START, { id }), stop: (id) => invoke(C.LOCAL_SERVICES_STOP, { id })
  },
  diagnostics: { export: () => invoke(C.DIAGNOSTICS_EXPORT) }
});
}

// CREATOR_PRELOAD_INSERTION_POINT
if(typeof location!=='undefined' && location.href==='app://app/creator/generated/renderer/index.html'){
"use strict";

// source/main/preload.ts
var import_electron = require("electron");
var allowed = /* @__PURE__ */ new Set(["app.browse", "preview.loaded", "app.creator-session", "project.import-builder", "app.bootstrap", "project.create", "project.read", "project.settings", "project.file", "project.history", "project.export", "project.open-dialog", "project.import-folder", "file.list", "file.copy-path", "file.rename", "file.remove", "asset.import-dialog", "asset.remove", "library.add", "library.open-source", "library.copy", "library.open", "build.create", "build.export", "preview.start", "preview.reload", "preview.bounds", "preview.inspect", "preview.screenshot", "app.theme", "app.close-ready", "agent.list", "agent.create", "agent.revoke"]);
for (const command of ["backend.status", "backend.configure", "backend.receive", "deployment.list", "deployment.plan", "deployment.quote", "deployment.request-review", "deployment.status", "deployment.resume", "deployment.authorize", "deployment.refresh", "deployment.copy-id", "deployment.open", "deployment.export-receipt", "operation.get", "operation.cancel"]) allowed.add(command);
allowed.add("deployment.requote");
allowed.add("deployment.resume-owner");
for (const command of ["project.history-list", "project.checkpoint", "project.checkpoint-remove", "project.restore", "project.diff", "project.revision-file", "project.export-draft"]) allowed.add(command);
for (const command of ["file.merge-prepare", "file.merge-inspect", "file.merge-read", "file.merge-apply"]) allowed.add(command);
allowed.add("project.inspect");
for (const command of ["collection.configure", "collection.duplicate", "collection.import-images", "collection.import-metadata", "rune.configure", "metaprotocol.configure", "protocol.copy-payload", "protocol.export-payload"]) allowed.add(command);
for (const command of ["draft.save", "draft.list", "draft.remove"]) allowed.add(command);
var api = {
  invoke(command, payload) {
    if (!allowed.has(command)) return Promise.resolve({ ok: false, error: { code: "UNKNOWN_COMMAND", message: "This command is not available." } });
    return import_electron.ipcRenderer.invoke("builder:command", command, payload);
  },
  onChange(listener) {
    const handler = (_event, value) => listener(value);
    import_electron.ipcRenderer.on("builder:changed", handler);
    return () => import_electron.ipcRenderer.removeListener("builder:changed", handler);
  }
};
if (location.href === "app://app/creator/generated/renderer/index.html") import_electron.contextBridge.exposeInMainWorld("builder", api);

}
