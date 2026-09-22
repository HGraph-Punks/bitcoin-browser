import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeJson } from '../shared/validation.js';

export class Logger {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    this.file = path.join(directory, 'satoshi-browser.jsonl');
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  write(level, event, fields = {}) {
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      ...sanitizeJson(fields, { maxDepth: 8, maxKeys: 2_000 })
    }) + '\n';
    this.queue = this.queue.then(async () => {
      await this.#rotateIfNeeded(Buffer.byteLength(entry));
      await fs.appendFile(this.file, entry, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => {});
    return this.queue;
  }

  info(event, fields) { return this.write('info', event, fields); }
  warn(event, fields) { return this.write('warn', event, fields); }
  error(event, fields) { return this.write('error', event, fields); }
  debug(event, fields) {
    if (process.env.SATOSHI_BROWSER_DEV === '1') return this.write('debug', event, fields);
    return Promise.resolve();
  }

  async flush() {
    await this.queue;
  }

  async #rotateIfNeeded(incomingBytes) {
    let size = 0;
    try { size = (await fs.stat(this.file)).size; } catch {}
    if (size + incomingBytes <= this.maxBytes) return;
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.file}.${index}`;
      const destination = `${this.file}.${index + 1}`;
      try { await fs.rename(source, destination); } catch {}
    }
    try { await fs.rename(this.file, `${this.file}.1`); } catch {}
    try { await fs.rm(`${this.file}.${this.maxFiles + 1}`, { force: true }); } catch {}
  }
}
