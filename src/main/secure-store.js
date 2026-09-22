import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';

export class SecureStore {
  #publication = 0;
  #entryRevisions = new Map();

  constructor(directory, safeStorage, logger) {
    this.file = path.join(directory, 'secrets.json');
    this.safeStorage = safeStorage;
    this.logger = logger;
    this.entries = {};
    this.queue = Promise.resolve();
    this.lastAvailability = null;
    this.loadStatus = 'not-initialized';
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let entries;
    try {
      entries = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)
        || Object.values(entries).some(value => typeof value !== 'string')) throw new Error('Stored credential file must contain an object of encoded entries');
      this.loadStatus = 'primary';
    } catch (error) {
      this.loadStatus = error?.code === 'ENOENT' ? 'missing' : 'unavailable';
      if (error?.code !== 'ENOENT') await this.logger?.warn('secrets.load_failed', { message: error.message });
      entries = {};
    }
    this.#publishEntries(entries);
  }

  // Internal revision identifiers, not credential values or their digests.
  // Rollback also advances affected keys, preventing stale recovery intent
  // from becoming valid again after an identical-looking failed episode.
  revisionFor(keys) {
    return keys.map((key) => this.#entryRevisions.get(key) ?? 0).join(':');
  }

  #publishEntries(entries) {
    this.#publication += 1;
    for (const key of new Set([...Object.keys(this.entries ?? {}), ...Object.keys(entries ?? {})])) {
      if (this.entries?.[key] !== entries?.[key]) this.#entryRevisions.set(key, this.#publication);
    }
    this.entries = entries;
  }

  available() {
    this.lastAvailability = Boolean(this.safeStorage?.isEncryptionAvailable?.());
    return this.lastAvailability;
  }

  availabilityStatus() {
    return this.lastAvailability;
  }

  has(key) {
    return typeof this.entries[key] === 'string' && this.entries[key].length > 0;
  }

  async set(key, value) {
    await this.transaction({ [key]: value }, async () => {});
  }

  get(key) {
    const encoded = this.entries[key];
    if (!encoded) return null;
    if (!this.available()) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch (error) {
      this.logger?.warn('secrets.decrypt_failed', { key, message: error.message });
      return null;
    }
  }

  async delete(key) {
    await this.transaction({ [key]: null }, async () => {});
  }

  async deletePrefix(prefix) {
    const operation = this.queue.then(async () => {
      const next = { ...this.entries };
      for (const key of Object.keys(next)) {
        if (key.startsWith(prefix)) delete next[key];
      }
      await this.#writeEntries(next);
      this.#publishEntries(next);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async flush() {
    await this.queue;
  }

  async transaction(updates, callback) {
    const encryptedUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        encryptedUpdates[key] = null;
        continue;
      }
      if (!this.available()) {
        throw new AppError('SECURE_STORAGE_UNAVAILABLE', 'Operating-system encryption is unavailable; the secret was not saved', { status: 503 });
      }
      encryptedUpdates[key] = this.safeStorage.encryptString(String(value)).toString('base64');
    }
    const operation = this.queue.then(async () => {
      const previous = { ...this.entries };
      const next = { ...previous };
      for (const [key, value] of Object.entries(encryptedUpdates)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      await this.#writeEntries(next);
      this.#publishEntries(next);
      try {
        return await callback();
      } catch (error) {
        try {
          await this.#writeEntries(previous);
          this.#publishEntries(previous);
        } catch (rollbackError) {
          throw new AppError('SECURE_STORAGE_ROLLBACK_FAILED', 'Provider credential rollback failed; the provider remains disabled', {
            status: 500,
            details: { causeCode: error?.code ?? null, rollbackMessage: rollbackError.message },
            cause: error
          });
        }
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async #writeEntries(entries) {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.file);
  }
}
