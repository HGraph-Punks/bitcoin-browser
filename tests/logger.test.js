import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/main/logger.js';

test('logger flush waits for already queued writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-logger-flush-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = new Logger(directory);
  await logger.init();
  let release;
  logger.queue = new Promise((resolve) => { release = resolve; });
  void logger.info('shutdown.fixture', { retained: true });

  let flushed = false;
  const flushing = logger.flush().then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  release();
  await flushing;

  const entries = await fs.readFile(logger.file, 'utf8');
  assert.match(entries, /"event":"shutdown.fixture"/);
  assert.match(entries, /"retained":true/);
});
