import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';

export class ExtensionManager {
  constructor(walletSession, stateStore, logger) {
    this.session = walletSession;
    this.stateStore = stateStore;
    this.logger = logger;
    this.loaded = new Map();
    this.runtimeEntries = new Map();
    this.failures = new Map();
    this.queue = Promise.resolve();
    this.shuttingDown = false;
    this.shutdownPromise = null;
  }

  init() {
    return this.#enqueue(async () => {
      for (const entry of this.stateStore.get(['extensions']) ?? []) {
        try {
          await this.#load(entry.path, entry);
        } catch (error) {
          // A failed restore must remain visible even when the runtime received a new ID.
          if (!this.failures.has(entry.id)) {
            this.#recordFailure(entry.id, new AppError('EXTENSION_RESTORE_FAILED', 'The configured extension could not be restored', { cause: error }),
              'Remove this configuration and reinstall the extension when its directory and storage are available.');
          }
          this.#log('warn', 'extension.restore_failed', { path: entry.path, message: error.message });
        }
      }
    });
  }

  list() {
    const configured = this.stateStore.get(['extensions']) ?? [];
    const entries = configured.map((entry) => ({
      ...entry,
      loaded: this.loaded.has(entry.id),
      runtime: this.loaded.has(entry.id) ? { ...this.loaded.get(entry.id) } : null,
      ...this.#failureSnapshot(entry.id)
    }));
    const configuredIds = new Set(configured.map((entry) => entry.id));
    for (const [id, runtime] of this.loaded) {
      if (configuredIds.has(id)) continue;
      entries.push({ ...this.runtimeEntries.get(id), loaded: true, runtime: { ...runtime }, persisted: false, ...this.#failureSnapshot(id) });
    }
    return entries;
  }

  install(directory) {
    return this.#enqueue(() => this.#load(directory));
  }

  remove(id) {
    return this.#enqueue(async () => {
      const wasLoaded = this.loaded.has(id);
      this.#unload(id);
      // An unpersisted runtime must be removable even while the state store is failing.
      if ((this.stateStore.get(['extensions']) ?? []).some((entry) => entry.id === id)) {
        try {
          await this.stateStore.mutate((draft) => {
            draft.extensions = draft.extensions.filter((entry) => entry.id !== id);
          });
        } catch (cause) {
          const error = new AppError('EXTENSION_REMOVE_SAVE_FAILED', 'The extension is unloaded, but its removal could not be saved', {
            cause, retryable: true,
            details: { id, committed: false, runtimeChanged: wasLoaded, restartMayRestore: true }
          });
          this.#recordFailure(id, error, 'The extension may load again after restart. Retry Remove to save the removal.');
          throw error;
        }
      }
      this.failures.delete(id);
      return this.list();
    });
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    // Close admission before yielding; accepted operations retain their normal result.
    this.shuttingDown = true;
    this.shutdownPromise = this.queue.then(() => {
      const failures = [];
      for (const id of this.loaded.keys()) {
        try { this.#unload(id); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Extension shutdown could not unload all runtimes');
    });
    return this.shutdownPromise;
  }

  #enqueue(operation) {
    if (this.shuttingDown) {
      return Promise.reject(new AppError('EXTENSIONS_SHUTTING_DOWN', 'Extension changes are unavailable while the application is shutting down', { status: 503 }));
    }
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  #unload(id) {
    if (!this.loaded.has(id)) return;
    const extensions = this.session.extensions ?? this.session;
    extensions.removeExtension(id);
    if (typeof extensions.getExtension === 'function' && extensions.getExtension(id)) {
      throw new AppError('EXTENSION_UNLOAD_FAILED', 'The extension is still loaded after the unload request', { details: { id } });
    }
    this.loaded.delete(id);
    this.runtimeEntries.delete(id);
  }

  #recordFailure(id, error, recovery) {
    this.failures.set(id, { error: { code: error.code, message: error.message }, recovery });
  }

  #failureSnapshot(id) {
    const failure = this.failures.get(id);
    return failure ? { error: { ...failure.error }, recovery: failure.recovery } : {};
  }

  #log(level, event, fields) {
    // Diagnostics must not replace a committed lifecycle result or its primary error.
    try { void Promise.resolve(this.logger?.[level]?.(event, fields)).catch(() => {}); } catch {}
  }

  async #load(directory, restoring = null) {
    const resolved = path.resolve(String(directory ?? ''));
    let real;
    try { real = await fs.realpath(resolved); } catch {
      throw new AppError('EXTENSION_NOT_FOUND', 'Selected wallet extension directory does not exist', { status: 404 });
    }
    const manifestPath = path.join(real, 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch {
      throw new AppError('INVALID_EXTENSION', 'Selected directory does not contain a valid manifest.json', { status: 400 });
    }
    if (!manifest || ![2, 3].includes(manifest.manifest_version) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new AppError('INVALID_EXTENSION', 'Wallet extension manifest is incomplete or unsupported', { status: 400 });
    }
    const runtime = await (this.session.extensions ?? this.session).loadExtension(real, { allowFileAccess: false });
    // Electron may return an existing runtime for a colliding ID. Its descriptor,
    // not the selected directory, describes the code that is actually known loaded.
    const runtimePath = typeof runtime.path === 'string' && runtime.path ? path.resolve(runtime.path) : real;
    const matchesDirectory = runtimePath === real;
    const entry = {
      id: runtime.id,
      name: runtime.name || (matchesDirectory ? manifest.name : runtime.id),
      version: runtime.version || (matchesDirectory ? manifest.version : 'unknown'),
      path: runtimePath,
      manifestVersion: runtime.manifest?.manifest_version ?? (matchesDirectory ? manifest.manifest_version : null),
      installedAt: restoring?.installedAt ?? new Date().toISOString()
    };
    const previouslyOwned = this.loaded.has(runtime.id);
    this.loaded.set(runtime.id, { id: runtime.id, name: runtime.name, version: runtime.version, path: runtimePath });
    this.runtimeEntries.set(runtime.id, entry);
    try {
      if (!matchesDirectory) {
        throw new AppError('EXTENSION_CONFIGURATION_CHANGED', 'The loaded extension does not match the selected directory', { status: 409 });
      }
      await this.stateStore.mutate((draft) => {
        const conflictingRuntime = [...this.loaded.values()].some((item) => item.id !== entry.id && item.path === real);
        if (conflictingRuntime) {
          throw new AppError('EXTENSION_CONFIGURATION_CHANGED', 'Another loaded extension already owns this directory; remove it before reinstalling', { status: 409 });
        }
        if (restoring) {
          const index = draft.extensions.findIndex((item) => item.id === restoring.id && item.path === restoring.path);
          if (index === -1 || draft.extensions.some((item, position) => position !== index && item.id === entry.id)) {
            throw new AppError('EXTENSION_CONFIGURATION_CHANGED', 'The extension configuration changed before restoration could be saved', { status: 409 });
          }
          draft.extensions[index] = entry;
        } else {
          draft.extensions = draft.extensions.filter((item) => item.id !== entry.id && item.path !== entry.path);
          draft.extensions.push(entry);
        }
      });
    } catch (cause) {
      if (previouslyOwned) {
        const error = new AppError('EXTENSION_SAVE_FAILED', 'The loaded extension could not be reconciled with its saved configuration', {
          cause, details: { id: entry.id, committed: false, runtimeChanged: true }
        });
        this.#recordFailure(entry.id, error, 'The loaded runtime was retained. Remove the extension or retry installation to reconcile its configuration.');
        throw error;
      }
      try { this.#unload(entry.id); } catch (cleanupError) {
        const error = new AppError('EXTENSION_ROLLBACK_FAILED', 'The extension could not be saved and remains loaded because cleanup failed', {
          cause: new AggregateError([cause, cleanupError], 'Extension persistence and rollback failed'),
          details: { id: entry.id, committed: false, runtimeChanged: true }
        });
        this.#recordFailure(entry.id, error, 'Remove the still-loaded extension, then retry installation when storage is available.');
        throw error;
      }
      throw cause;
    }
    this.failures.delete(entry.id);
    if (restoring) this.failures.delete(restoring.id);
    this.#log('info', 'extension.loaded', { id: entry.id, name: entry.name, version: entry.version });
    return { ...entry, loaded: true };
  }
}
