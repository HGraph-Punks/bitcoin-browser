import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_LOCAL_SERVICES,
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  MAX_HISTORY,
  MAX_TABS,
  STATE_SCHEMA_VERSION
} from '../shared/constants.js';
import { AppError } from '../shared/errors.js';
import { validateProviderConfig, validateSettingsPatch, validateProviderCleanupRecords } from '../shared/validation.js';

function clone(value) {
  return structuredClone(value);
}

const STATE_TEMPORARY_RE = /^state\.json\.[1-9]\d*\.\d+\.tmp$/;
const MAX_CANONICAL_LENGTH = 4_096;
const LIBRARY_SCAN_MULTIPLIER = 10;

function parsePersistedState(raw) {
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Persisted state must be a JSON object');
  }
  return migrate(parsed);
}

function defaultState() {
  const tabId = crypto.randomUUID();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    settings: clone(DEFAULT_SETTINGS),
    providers: clone(DEFAULT_PROVIDERS),
    localServices: clone(DEFAULT_LOCAL_SERVICES),
    tabs: [{
      id: tabId,
      title: 'Start',
      target: 'satnav://home',
      history: ['satnav://home'],
      historyIndex: 0,
      pinned: false,
      lastAccessedAt: Date.now()
    }],
    activeTabId: tabId,
    history: [],
    bookmarks: [],
    extensions: [],
    wallet: { lastWalletId: null, accounts: [], connectedAt: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function safeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const settings = clone(DEFAULT_SETTINGS);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in source)) continue;
    try { Object.assign(settings, validateSettingsPatch({ [key]: source[key] })); } catch {}
  }
  settings.telemetryEnabled = false;
  return settings;
}

function safeTabs(value) {
  if (!Array.isArray(value) || value.length === 0) return defaultState().tabs;
  return value.slice(0, MAX_TABS).map((tab) => {
    const sourceHistory = Array.isArray(tab?.history) && tab.history.length ? tab.history : ['satnav://home'];
    const removedHistoryEntries = Math.max(0, sourceHistory.length - 200);
    const history = sourceHistory.slice(-200).map((item) => String(item).slice(0, 4_096));
    const requestedIndex = Number.isSafeInteger(tab?.historyIndex)
      ? tab.historyIndex - removedHistoryEntries
      : history.length - 1;
    return {
      id: String(tab?.id || crypto.randomUUID()).slice(0, 80),
      title: String(tab?.title ?? 'Untitled').slice(0, 160),
      target: String(tab?.target ?? history.at(-1) ?? 'satnav://home').slice(0, 4_096),
      history,
      historyIndex: Math.max(0, Math.min(requestedIndex, history.length - 1)),
      pinned: Boolean(tab?.pinned),
      lastAccessedAt: Number.isFinite(tab?.lastAccessedAt) ? tab.lastAccessedAt : Date.now()
    };
  });
}

function safeLibraryEntry(entry, type) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.canonical !== 'string' || entry.canonical.length === 0 || entry.canonical.length > MAX_CANONICAL_LENGTH) return null;
  const canonical = entry.canonical;
  const timestampKey = type === 'history' ? 'visitedAt' : 'createdAt';
  const timestamp = typeof entry[timestampKey] === 'string' && Number.isFinite(Date.parse(entry[timestampKey]))
    ? entry[timestampKey]
    : new Date(0).toISOString();
  return {
    id: typeof entry.id === 'string' && entry.id.length > 0
      ? entry.id.slice(0, 80)
      : crypto.randomUUID(),
    canonical,
    title: String(entry.title ?? canonical).slice(0, 200),
    kind: String(entry.kind ?? 'unknown').slice(0, 80),
    ...(type === 'history'
      ? {
          providerId: entry.providerId ? String(entry.providerId).slice(0, 80) : null,
          visitedAt: timestamp
        }
      : { createdAt: timestamp })
  };
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];
  const history = [];
  const scanLimit = Math.min(value.length, MAX_HISTORY * LIBRARY_SCAN_MULTIPLIER);
  for (let index = 0; index < scanLimit && history.length < MAX_HISTORY; index += 1) {
    const safe = safeLibraryEntry(value[index], 'history');
    if (safe) history.push(safe);
  }
  return history;
}

function safeBookmarks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const bookmarks = [];
  const scanLimit = Math.min(value.length, 10_000 * LIBRARY_SCAN_MULTIPLIER);
  for (let index = 0; index < scanLimit; index += 1) {
    const safe = safeLibraryEntry(value[index], 'bookmark');
    if (!safe || seen.has(safe.canonical)) continue;
    seen.add(safe.canonical);
    bookmarks.push(safe);
    if (bookmarks.length === 10_000) break;
  }
  return bookmarks;
}

function migrate(input) {
  const state = input && typeof input === 'object' ? clone(input) : defaultState();
  // This is a presence-only, sticky recovery marker, never a user preference.
  // An old primary without the field retains its separate legacy policy;
  // malformed/falsy marker values must not turn recovery into authorization.
  if (Object.hasOwn(state, 'legacyCredentialRecoveryRequired')) state.legacyCredentialRecoveryRequired = true;
  const hasProviderConfiguration = Object.hasOwn(state, 'providers');
  const version = Number(state.schemaVersion ?? 0);
  if (version < 1) {
    state.settings = { ...clone(DEFAULT_SETTINGS), ...(state.settings ?? {}) };
    state.providers = Array.isArray(state.providers)
      ? state.providers
      : (hasProviderConfiguration ? [] : clone(DEFAULT_PROVIDERS));
  }
  if (version < 2) {
    state.localServices = Array.isArray(state.localServices) ? state.localServices : clone(DEFAULT_LOCAL_SERVICES);
    state.extensions = Array.isArray(state.extensions) ? state.extensions : [];
    state.wallet = state.wallet ?? { lastWalletId: null, accounts: [], connectedAt: null };
  }
  if (version < 3) {
    state.settings.contentNetworkPolicy = state.settings.contentNetworkPolicy ?? 'blocked';
    state.settings.telemetryEnabled = false;
  }
  state.schemaVersion = STATE_SCHEMA_VERSION;
  state.settings = safeSettings(state.settings);
  state.providers = (Array.isArray(state.providers)
    ? state.providers
    : (hasProviderConfiguration ? [] : clone(DEFAULT_PROVIDERS)))
    .map((provider) => {
      try { return validateProviderConfig(provider); } catch { return null; }
    })
    .filter(Boolean);
  if (!state.providers.some((provider) => provider.id === state.settings.preferredProviderId)) {
    state.settings.preferredProviderId = null;
  }
  state.tabs = safeTabs(state.tabs);
  state.activeTabId = state.tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : state.tabs[0].id;
  state.history = safeHistory(state.history);
  state.bookmarks = safeBookmarks(state.bookmarks);
  state.localServices = Array.isArray(state.localServices) ? state.localServices : clone(DEFAULT_LOCAL_SERVICES);
  state.extensions = Array.isArray(state.extensions) ? state.extensions : [];
  state.wallet = state.wallet && typeof state.wallet === 'object' ? state.wallet : { lastWalletId: null, accounts: [], connectedAt: null };
  return state;
}

export class StateStore {
  constructor(directory, logger) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    this.backup = path.join(directory, 'state.backup.json');
    this.logger = logger;
    this.state = defaultState();
    this.recoveryStatus = { source: 'defaults', reason: 'missing' };
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let recovery = 'primary';
    let primaryReason = null;
    let invalidBackup = false;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.state = parsePersistedState(raw);
    } catch (error) {
      primaryReason = error?.code === 'ENOENT' ? 'missing' : 'invalid';
      if (error?.code !== 'ENOENT') {
        await this.logger?.warn('state.load_failed', { message: error.message });
      }
      try {
        const raw = await fs.readFile(this.backup, 'utf8');
        this.state = parsePersistedState(raw);
        recovery = 'backup';
      } catch (backupError) {
        invalidBackup = backupError?.code !== 'ENOENT';
        this.state = defaultState();
        recovery = 'default';
      }
    }
    this.recoveryStatus = {
      source: recovery === 'default' ? 'defaults' : recovery,
      reason: recovery === 'primary' ? null : (invalidBackup ? 'invalid' : primaryReason)
    };
    // Persist provenance in the same atomic write that repairs the primary,
    // before startup initializes the separate credential store. Defaults must
    // mark too: missing state files do not establish that no old secrets exist.
    if (recovery !== 'primary') this.state.legacyCredentialRecoveryRequired = true;
    const preserveBackup = recovery === 'backup' || invalidBackup;
    await this.#writeAtomic({ preserveBackup });
    if (recovery === 'default' && primaryReason === 'missing' && !invalidBackup) {
      await fs.copyFile(this.file, this.backup);
    }
    await this.#cleanupTemporaryFiles();
    return this.snapshot();
  }

  snapshot() {
    return clone(this.state);
  }

  get legacyCredentialRecoveryRequired() {
    return Object.hasOwn(this.state, 'legacyCredentialRecoveryRequired');
  }

  get(pathSegments = []) {
    let value = this.state;
    for (const segment of pathSegments) value = value?.[segment];
    return clone(value);
  }

  async mutate(mutator) {
    const operation = this.queue.then(async () => {
      const draft = clone(this.state);
      const result = await mutator(draft);
      if (this.legacyCredentialRecoveryRequired) draft.legacyCredentialRecoveryRequired = true;
      draft.schemaVersion = STATE_SCHEMA_VERSION;
      draft.updatedAt = new Date().toISOString();
      const nextState = migrate(draft);
      const existingIds = new Set(this.state.providers.map(provider => provider.id));
      const added = nextState.providers.filter(provider => !existingIds.has(provider.id));
      if (added.length) {
        const pending = [...this.getProviderCleanups(), ...validateProviderCleanupRecords(nextState.providerCleanups)];
        if (added.some(provider => pending.some(item => item.id === provider.id))) {
          throw new AppError('PROVIDER_CLEANUP_REQUIRED', 'Finish the pending removed-source cleanup before reusing its identifier.', { status: 409 });
        }
      }
      await this.#writeAtomic({}, nextState);
      this.state = nextState;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async updateSettings(patch, onCommitted = null) {
    const safePatch = validateSettingsPatch(patch);
    await this.mutate((draft) => {
      draft.settings = { ...draft.settings, ...safePatch };
    });
    // Internal callers that distinguish persistence from readback must learn
    // the commit before get() can fail. This hook is never sourced from IPC data.
    onCommitted?.();
    return this.get(['settings']);
  }

  async upsertProvider(provider) {
    const safeProvider = validateProviderConfig(provider);
    await this.mutate((draft) => {
      const index = draft.providers.findIndex((item) => item.id === safeProvider.id);
      if (index >= 0) draft.providers[index] = safeProvider;
      else draft.providers.push(safeProvider);
    });
    return safeProvider;
  }

  getProviderCleanups() {
    return validateProviderCleanupRecords(this.state.providerCleanups);
  }

  async beginProviderCleanup(record, expectedGeneration) {
    const [safe] = validateProviderCleanupRecords([record]);
    await this.mutate(draft => {
      const records = validateProviderCleanupRecords(draft.providerCleanups);
      const previous = records.find(item => item.id === safe.id);
      if (draft.providers.some(provider => provider.id === safe.id) || (previous?.generation ?? null) !== expectedGeneration) {
        throw new AppError('PROVIDER_CLEANUP_STALE', 'This source or its cleanup state changed. Review it again before cleanup.', { status: 409 });
      }
      draft.providerCleanups = validateProviderCleanupRecords([...records.filter(item => item.id !== safe.id), safe]);
    });
  }

  async completeProviderCleanup(id, generation) {
    await this.mutate(draft => {
      const records = validateProviderCleanupRecords(draft.providerCleanups);
      if (draft.providers.some(provider => provider.id === id) || records.find(item => item.id === id)?.generation !== generation) {
        throw new AppError('PROVIDER_CLEANUP_STALE', 'Cleanup ownership changed before it could be acknowledged.', { status: 409 });
      }
      draft.providerCleanups = records.filter(item => item.id !== id);
    });
  }

  async removeProvider(id, cleanupRecord = null, expectedProvider = undefined) {
    await this.mutate((draft) => {
      const current = draft.providers.find(provider => provider.id === id);
      if (expectedProvider !== undefined && JSON.stringify(current) !== JSON.stringify(expectedProvider)) {
        throw new AppError('PROVIDER_CLEANUP_STALE', 'The source changed before removal. Review the current source.', { status: 409 });
      }
      if (cleanupRecord) {
        const [safe] = validateProviderCleanupRecords([cleanupRecord]);
        if (safe.id !== id) throw new AppError('PROVIDER_CLEANUP_STALE', 'Cleanup identifier does not match removal.', { status: 409 });
        draft.providerCleanups = validateProviderCleanupRecords([...validateProviderCleanupRecords(draft.providerCleanups).filter(item => item.id !== id), safe]);
      }
      draft.providers = draft.providers.filter((provider) => provider.id !== id);
      if (draft.settings.preferredProviderId === id) draft.settings.preferredProviderId = null;
    });
  }

  async saveTabs(tabs, activeTabId) {
    if (!Array.isArray(tabs) || tabs.length < 1 || tabs.length > MAX_TABS) {
      throw new AppError('VALIDATION_ERROR', `tabs must contain 1-${MAX_TABS} entries`, { status: 400 });
    }
    const safeTabs = tabs.map((tab) => {
      const sourceHistory = Array.isArray(tab?.history) && tab.history.length ? tab.history : ['satnav://home'];
      const removedHistoryEntries = Math.max(0, sourceHistory.length - 200);
      const history = sourceHistory.slice(-200).map((item) => String(item).slice(0, 4_096));
      const requestedIndex = Number.isSafeInteger(tab?.historyIndex)
        ? tab.historyIndex - removedHistoryEntries
        : history.length - 1;
      return {
        id: String(tab?.id ?? '').slice(0, 80),
        title: String(tab?.title ?? 'Untitled').slice(0, 160),
        target: String(tab?.target ?? 'satnav://home').slice(0, 4_096),
        history,
        historyIndex: Math.max(0, Math.min(requestedIndex, history.length - 1)),
        pinned: Boolean(tab?.pinned),
        lastAccessedAt: Number.isFinite(tab?.lastAccessedAt) ? tab.lastAccessedAt : Date.now()
      };
    });
    if (safeTabs.some((tab) => !tab.id)) throw new AppError('VALIDATION_ERROR', 'Every tab must have an id', { status: 400 });
    await this.mutate((draft) => {
      draft.tabs = safeTabs;
      draft.activeTabId = safeTabs.some((tab) => tab.id === activeTabId) ? activeTabId : safeTabs[0].id;
    });
  }

  async recordHistory(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError('VALIDATION_ERROR', 'History entry must be an object', { status: 400 });
    }
    if (typeof entry.canonical !== 'string' || entry.canonical.length === 0 || entry.canonical.length > MAX_CANONICAL_LENGTH) {
      throw new AppError('VALIDATION_ERROR', `History canonical target must contain 1-${MAX_CANONICAL_LENGTH} characters`, { status: 400 });
    }
    const safeEntry = {
      id: crypto.randomUUID(),
      canonical: entry.canonical,
      title: String(entry.title ?? entry.canonical ?? 'Untitled').slice(0, 200),
      kind: String(entry.kind ?? 'unknown').slice(0, 80),
      providerId: entry.providerId ? String(entry.providerId).slice(0, 80) : null
    };
    return this.mutate((draft) => {
      const now = Date.now();
      const safe = { ...safeEntry, visitedAt: new Date(now).toISOString() };
      const latest = draft.history[0];
      const elapsed = now - Date.parse(latest?.visitedAt);
      if (latest?.canonical === safe.canonical && elapsed >= 0 && elapsed < 5_000) {
        draft.history[0] = safe;
      } else {
        draft.history.unshift(safe);
        draft.history = draft.history.slice(0, MAX_HISTORY);
      }
      return safe;
    });
  }

  async toggleBookmark(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError('VALIDATION_ERROR', 'Bookmark entry must be an object', { status: 400 });
    }
    if (typeof entry.canonical !== 'string' || entry.canonical.length === 0 || entry.canonical.length > MAX_CANONICAL_LENGTH) {
      throw new AppError('VALIDATION_ERROR', `Bookmark canonical target must contain 1-${MAX_CANONICAL_LENGTH} characters`, { status: 400 });
    }
    const canonical = entry.canonical;
    return this.mutate((draft) => {
      let bookmarked = false;
      const index = draft.bookmarks.findIndex((item) => item.canonical === canonical);
      if (index >= 0) {
        draft.bookmarks.splice(index, 1);
      } else {
        draft.bookmarks.unshift({
          id: crypto.randomUUID(),
          canonical,
          title: String(entry.title ?? canonical).slice(0, 200),
          kind: String(entry.kind ?? 'unknown').slice(0, 80),
          createdAt: new Date().toISOString()
        });
        bookmarked = true;
      }
      draft.bookmarks = draft.bookmarks.slice(0, 10_000);
      return { bookmarked, bookmarks: clone(draft.bookmarks) };
    });
  }

  async flush() {
    const operation = this.queue.then(() => this.#writeAtomic());
    this.queue = operation.catch(() => {});
    return operation;
  }

  async #writeAtomic(options = {}, state = this.state) {
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(state, null, 2) + '\n';
    if (!options.preserveBackup) {
      try { await fs.copyFile(this.file, this.backup); } catch {}
    }
    await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  async #cleanupTemporaryFiles() {
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      await this.logger?.warn('state.temp_cleanup_failed', { failures: 1, message: error.message }).catch(() => {});
      return;
    }
    let failures = 0;
    for (const entry of entries) {
      if (!STATE_TEMPORARY_RE.test(entry.name)) continue;
      const temporary = path.join(this.directory, entry.name);
      try {
        const stat = await fs.lstat(temporary);
        if (entry.isFile() && stat.isFile()) await fs.rm(temporary);
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      await this.logger?.warn('state.temp_cleanup_failed', { failures }).catch(() => {});
    }
  }
}
