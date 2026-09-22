import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from '../shared/errors.js';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const OBJECT_NAME_RE = /^[0-9a-f]{64}$/;
const STAGING_NAME_RE = /^[0-9a-f]{64}\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:tmp|previous)$/i;
const RECOVERY_PRIMARY = Symbol('cacheRecoveryPrimary');
const RECOVERY_LIMIT = 20;

function recordRecovery(errors, stage, error, file) {
  errors.total = (errors.total ?? 0) + 1;
  if (errors.length < RECOVERY_LIMIT) errors.push({
    stage,
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'CACHE_RECOVERY_FAILED',
    message: String(error?.message ?? error).slice(0, 512),
    ...(file ? { file } : {})
  });
  // A failed recovery step may have performed its own failed cleanup. Keep
  // those bounded records when demoting our wrapper to a secondary failure.
  if (error?.[RECOVERY_PRIMARY]) {
    const nested = error.details.recoveryErrors;
    for (const item of nested) recordRecovery(errors, `${stage}/${item.stage}`.slice(0, 160), {
      code: item.code, message: item.message
    }, item.file);
    errors.total += Math.max(0, error.details.recoveryErrorCount - nested.length);
  }
}

function recoveryFailure(error, errors, details = {}) {
  const primary = error?.[RECOVERY_PRIMARY] ?? error;
  const previous = error?.details ?? {};
  const combined = {
    ...previous, ...details,
    recoveryErrors: [...(previous.recoveryErrors ?? []), ...errors].slice(0, RECOVERY_LIMIT),
    recoveryErrorCount: (previous.recoveryErrorCount ?? previous.recoveryErrors?.length ?? 0) + (errors.total ?? errors.length)
  };
  // Do not introduce a status 500 on native I/O errors: callers distinguish
  // cache persistence from remote-provider health failures using this field.
  const result = primary instanceof AppError
    ? new AppError(primary.code, primary.message, { cause: primary, status: primary.status, retryable: primary.retryable, details: combined })
    : new Error(String(primary?.message ?? primary), { cause: primary });
  if (!(primary instanceof AppError)) {
    for (const field of ['code', 'status', 'retryable']) if (primary?.[field] !== undefined) result[field] = primary[field];
    result.details = combined;
  }
  result[RECOVERY_PRIMARY] = primary;
  return result;
}

function hitMetadataWarning(error) {
  // This record crosses cache.stats into diagnostics. Keep useful I/O codes,
  // not raw filesystem messages, cache keys, payloads, or local paths.
  const recoveryErrors = (error?.details?.recoveryErrors ?? []).slice(0, RECOVERY_LIMIT).map((item) => ({
    stage: String(item.stage).slice(0, 160),
    code: String(item.code).slice(0, 80)
  }));
  return {
    code: 'CACHE_HIT_METADATA_WRITE_FAILED',
    message: 'Verified cached content is available, but access statistics could not be saved.',
    causeCode: String(error?.code ?? 'CACHE_METADATA_WRITE_FAILED').slice(0, 80),
    recoveryErrors,
    recoveryErrorCount: error?.details?.recoveryErrorCount ?? recoveryErrors.length
  };
}

export class DiskCache {
  constructor(directory, options = {}, logger) {
    this.directory = directory;
    this.dataDirectory = path.join(directory, 'objects');
    this.indexFile = path.join(directory, 'index.json');
    this.maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 64 * 1024 * 1024;
    this.logger = logger;
    this.entries = {};
    this.queue = Promise.resolve();
    this.mutations = Promise.resolve();
    this.metadataPersistenceWarning = null;
  }

  async init() {
    await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
      // Valid JSON is not necessarily an index map (notably, null). Repair
      // unusable roots like a missing/malformed index instead of failing startup.
      this.entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.entries = {};
    }
    await this.#repair();
  }

  async configure({ maxBytes, maxEntryBytes }) {
    if (Number.isSafeInteger(maxBytes)) this.maxBytes = maxBytes;
    if (Number.isSafeInteger(maxEntryBytes)) this.maxEntryBytes = maxEntryBytes;
    await this.prune();
  }

  async get(key, options = {}) {
    return this.#mutate(async () => {
      const id = digest(key);
      const entry = this.entries[id];
      if (!entry) return null;
      let data;
      try {
        data = await fs.readFile(path.join(this.dataDirectory, id));
      } catch (error) {
        // An unreadable object is not necessarily missing or corrupt. Preserve
        // verified offline data across transient access/device failures so an
        // explicit retry can succeed after the underlying problem is resolved.
        if (error?.code !== 'ENOENT') throw error;
      }
      const sha256 = data ? digest(data) : null;
      if (!data || (entry.sha256 && entry.sha256 !== sha256)) {
        delete this.entries[id];
        await fs.rm(path.join(this.dataDirectory, id), { force: true }).catch(() => {});
        await this.#writeIndex();
        return null;
      }
      if (!entry.sha256) entry.sha256 = sha256;
      const expired = entry.expiresAt !== null && Date.now() > entry.expiresAt;
      if (expired && !options.allowStale) return null;
      entry.lastAccessedAt = Date.now();
      entry.hits = (entry.hits ?? 0) + 1;
      let metadataPersistenceWarning;
      try { await this.#writeIndex(); }
      catch (error) {
        // Only verified-hit bookkeeping is best effort. Payload reads and
        // missing/corrupt-object repair above retain their failure contracts.
        metadataPersistenceWarning = hitMetadataWarning(error);
        const reportTransition = !this.metadataPersistenceWarning;
        this.metadataPersistenceWarning = metadataPersistenceWarning;
        if (reportTransition) {
          // Enqueue the production logger synchronously, but do not make
          // readable offline bytes depend on another filesystem write.
          try {
            void Promise.resolve(this.logger?.warn('cache.hit_metadata_write_failed', structuredClone(metadataPersistenceWarning))).catch(() => {});
          } catch {}
        }
      }
      return {
        data, meta: structuredClone(entry.meta ?? {}), stale: expired, createdAt: entry.createdAt,
        ...(metadataPersistenceWarning ? { metadataPersistenceWarning: structuredClone(metadataPersistenceWarning) } : {})
      };
    });
  }

  async put(key, data, meta = {}, ttlMs = null, options = {}) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length > this.maxEntryBytes) return { cached: false, reason: 'entry-too-large' };
    return this.#mutate(async () => {
      const id = digest(key);
      const temporary = path.join(this.dataDirectory, `${id}.${process.pid}.${crypto.randomUUID()}.tmp`);
      const objectPath = path.join(this.dataDirectory, id);
      const backup = path.join(this.dataDirectory, `${id}.${process.pid}.${crypto.randomUUID()}.previous`);
      const previousEntry = this.entries[id] ? structuredClone(this.entries[id]) : null;
      const evicted = [];
      let previousMoved = false;
      let installed = false;
      let temporaryOwned = false;
      let indexCommitted = false;
      try {
        await options.validate?.();
        await this.#writeTemporary(temporary, buffer);
        temporaryOwned = true;
        await options.validate?.();
        if (previousEntry) {
          await this.#stageObject(objectPath, backup);
          previousMoved = true;
          await options.validate?.();
        }
        await fs.rename(temporary, objectPath);
        temporaryOwned = false;
        installed = true;
        await options.validate?.();
        const now = Date.now();
        this.entries[id] = {
          key,
          bytes: buffer.length,
          sha256: digest(buffer),
          createdAt: now,
          lastAccessedAt: now,
          expiresAt: ttlMs === null ? null : now + ttlMs,
          hits: 0,
          meta
        };
        await this.#pruneEntries(async (victimId, entry) => {
          const victimBackup = path.join(this.dataDirectory, `${victimId}.${process.pid}.${crypto.randomUUID()}.previous`);
          await this.#stageObject(path.join(this.dataDirectory, victimId), victimBackup);
          evicted.push({ id: victimId, entry: structuredClone(entry), backup: victimBackup });
        });
        await options.validate?.();
        await this.#writeIndex();
        indexCommitted = true;
        await options.validate?.();
      } catch (error) {
        const errors = [];
        const restoredEntries = [];
        const invalidatedEntries = [];
        const retainedBackups = [];
        const affected = [{ id, entry: previousEntry, backup: previousMoved ? backup : null }, ...evicted.filter((victim) => victim.id !== id)];
        // Revoke authority first. A failed filesystem restoration must not leave
        // metadata claiming that obsolete or missing bytes have been restored.
        for (const affectedEntry of affected) delete this.entries[affectedEntry.id];
        if (installed) await this.#removeOwned(objectPath, errors, 'remove-new');
        for (const affectedEntry of affected) {
          const canonical = path.join(this.dataDirectory, affectedEntry.id);
          let restored = true;
          if (affectedEntry.backup) {
            try { await fs.rename(affectedEntry.backup, canonical); }
            catch (restoreError) {
              restored = false;
              retainedBackups.push(affectedEntry.backup);
              recordRecovery(errors, 'restore-previous', restoreError, affectedEntry.backup);
            }
          }
          if (affectedEntry.entry && restored) {
            try {
              await this.#verifyObject(canonical, affectedEntry.entry);
              this.entries[affectedEntry.id] = affectedEntry.entry;
              restoredEntries.push(affectedEntry.id);
            } catch (verifyError) {
              restored = false;
              recordRecovery(errors, 'verify-restored', verifyError, canonical);
            }
          }
          if (affectedEntry.entry && !restored) invalidatedEntries.push(affectedEntry.id);
        }
        let rollbackIndexCommitted = false;
        try { await this.#writeIndex(); rollbackIndexCommitted = true; }
        catch (indexError) { recordRecovery(errors, 'rollback-index', indexError, this.indexFile); }
        if (temporaryOwned) await this.#removeOwned(temporary, errors, 'cleanup-temporary');
        // A self-evicted replacement is never the previous value. Other backups
        // were consumed by successful rename, or retained after failed restore.
        for (const victim of evicted) if (victim.id === id) await this.#removeOwned(victim.backup, errors, 'cleanup-invalidated');
        const cacheRollback = {
          indexCommitted, rollbackIndexCommitted,
          restoredEntries: restoredEntries.slice(0, RECOVERY_LIMIT), restoredEntryCount: restoredEntries.length,
          invalidatedEntries: invalidatedEntries.slice(0, RECOVERY_LIMIT), invalidatedEntryCount: invalidatedEntries.length,
          retainedBackups: retainedBackups.slice(0, RECOVERY_LIMIT), retainedBackupCount: retainedBackups.length,
          restartRecoveryConfirmed: rollbackIndexCommitted && invalidatedEntries.length === 0
        };
        let failure = recoveryFailure(error, errors, { cacheRollback });
        if (failure.details.recoveryErrorCount) {
          try { await this.logger?.warn('cache.rollback_incomplete', failure.details); }
          catch (logError) {
            const loggingErrors = [];
            recordRecovery(loggingErrors, 'recovery-log', logError);
            failure = recoveryFailure(failure, loggingErrors);
          }
        }
        throw failure;
      }
      // Publication and validation succeeded. Cleanup failure cannot reverse
      // this commit; callers receive a successful cache result plus warnings.
      const cleanupErrors = [];
      if (previousMoved) await this.#removeOwned(backup, cleanupErrors, 'cleanup-previous');
      for (const victim of evicted) await this.#removeOwned(victim.backup, cleanupErrors, 'cleanup-evicted');
      if (cleanupErrors.length) {
        try { await this.logger?.warn('cache.cleanup_incomplete', { id, cleanupErrors, cleanupErrorCount: cleanupErrors.total }); }
        catch (logError) { recordRecovery(cleanupErrors, 'cleanup-log', logError); }
        return { cached: true, id, cleanupErrors, cleanupErrorCount: cleanupErrors.total };
      }
      return { cached: true, id };
    });
  }

  async delete(key) {
    await this.#mutate(async () => {
      const id = digest(key);
      delete this.entries[id];
      await fs.rm(path.join(this.dataDirectory, id), { force: true });
      await this.#writeIndex();
    });
  }

  async clear() {
    await this.#mutate(async () => {
      await this.queue;
      await fs.rm(this.directory, { recursive: true, force: true });
      this.entries = {};
      try { await this.init(); }
      catch (error) {
        // Removal completed. A later initialization failure cannot undo it,
        // and callers need that acknowledgement to report usable recovery.
        throw new AppError('CACHE_REINITIALIZATION_FAILED', 'Cached content was removed, but cache storage could not be reinitialized', {
          cause: error,
          retryable: true,
          details: {
            cacheClearCommitted: true,
            cacheReady: false,
            cause: {
              code: String(error?.code ?? 'CACHE_INIT_FAILED').slice(0, 80),
              message: String(error?.message ?? error).slice(0, 1024),
              ...(error?.details?.recoveryErrors ? {
                recoveryErrors: error.details.recoveryErrors,
                recoveryErrorCount: error.details.recoveryErrorCount
              } : {})
            }
          }
        });
      }
    });
  }

  async flush() {
    await this.mutations;
    await this.queue;
  }

  async prune() {
    await this.#mutate(async () => {
      const changed = await this.#pruneEntries();
      if (changed) await this.#writeIndex();
    });
  }

  async #pruneEntries(remove = (id) => fs.rm(path.join(this.dataDirectory, id), { force: true })) {
    const entries = Object.entries(this.entries);
    let total = entries.reduce((sum, [, entry]) => sum + (entry.bytes ?? 0), 0);
    if (total <= this.maxBytes) return false;
    let changed = false;
    entries.sort((a, b) => (a[1].lastAccessedAt ?? 0) - (b[1].lastAccessedAt ?? 0));
    for (const [id, entry] of entries) {
      if (total <= this.maxBytes * 0.9) break;
      await remove(id, entry);
      total -= entry.bytes ?? 0;
      delete this.entries[id];
      changed = true;
    }
    return changed;
  }

  stats() {
    const values = Object.values(this.entries);
    return {
      entries: values.length,
      bytes: values.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      maxBytes: this.maxBytes,
      maxEntryBytes: this.maxEntryBytes,
      hits: values.reduce((sum, entry) => sum + (entry.hits ?? 0), 0),
      directory: this.directory,
      ...(this.metadataPersistenceWarning ? { metadataPersistenceWarning: structuredClone(this.metadataPersistenceWarning) } : {})
    };
  }

  async #repair() {
    const valid = {};
    for (const [id, entry] of Object.entries(this.entries)) {
      if (!OBJECT_NAME_RE.test(id) || !entry || typeof entry !== 'object') continue;
      try {
        const objectPath = path.join(this.dataDirectory, id);
        const stat = await fs.lstat(objectPath);
        const data = stat.isFile() && stat.size === entry.bytes ? await fs.readFile(objectPath) : null;
        if (data) {
          const sha256 = digest(data);
          if (!entry.sha256 || entry.sha256 === sha256) valid[id] = { ...entry, sha256 };
          else await fs.rm(objectPath, { force: true });
        }
      } catch {}
    }
    this.entries = valid;
    try {
      const directoryEntries = await fs.readdir(this.dataDirectory, { withFileTypes: true });
      for (const directoryEntry of directoryEntries) {
        const name = directoryEntry.name;
        const unindexedObject = OBJECT_NAME_RE.test(name) && !Object.hasOwn(valid, name);
        if (!unindexedObject && !STAGING_NAME_RE.test(name)) continue;
        const objectPath = path.join(this.dataDirectory, name);
        try {
          const stat = await fs.lstat(objectPath);
          if (directoryEntry.isFile() && stat.isFile()) await fs.rm(objectPath);
        } catch {}
      }
    } catch {}
    await this.#writeIndex();
  }

  async #writeIndex() {
    const temporary = `${this.indexFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await this.#writeTemporary(temporary, JSON.stringify(this.entries), 'utf8');
    try { await fs.rename(temporary, this.indexFile); }
    catch (error) {
      const errors = [];
      await this.#removeOwned(temporary, errors, 'cleanup-index-temporary');
      throw recoveryFailure(error, errors);
    }
    // The whole current map (including accumulated in-memory access counters)
    // is published only after rename succeeds. Flush alone is not that promise.
    this.metadataPersistenceWarning = null;
  }

  async #writeTemporary(file, data, encoding) {
    let handle;
    let owned = false;
    try {
      handle = await fs.open(file, 'wx', 0o600);
      owned = true;
      await handle.writeFile(data, encoding ? { encoding } : undefined);
      await handle.close();
      handle = null;
    } catch (error) {
      const errors = [];
      if (handle) {
        try { await handle.close(); }
        catch (closeError) { recordRecovery(errors, 'close-temporary', closeError, file); }
      }
      if (owned) await this.#removeOwned(file, errors, 'cleanup-temporary');
      throw recoveryFailure(error, errors);
    }
  }

  async #stageObject(canonical, backup) {
    // Reserve the backup exclusively before replacing our own empty inode.
    await this.#writeTemporary(backup, Buffer.alloc(0));
    try { await fs.rename(canonical, backup); }
    catch (error) {
      const errors = [];
      await this.#removeOwned(backup, errors, 'cleanup-backup-reservation');
      throw recoveryFailure(error, errors);
    }
  }

  async #verifyObject(file, entry) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== entry.bytes) throw new Error('Restored cache object type or size mismatch');
    const data = await fs.readFile(file);
    if (digest(data) !== entry.sha256) throw new Error('Restored cache object digest mismatch');
  }

  async #removeOwned(file, errors, stage) {
    try { await fs.rm(file, { force: true }); }
    catch (error) { recordRecovery(errors, stage, error, file); }
  }

  #mutate(operation) {
    const pending = this.mutations.then(operation, operation);
    this.mutations = pending.catch(() => {});
    return pending;
  }
}
