import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasShellDocumentLoaded, readShellDocumentLoaded, MAX_STARTUP_LOG_BYTES } from '../scripts/packaged-startup-readiness.mjs';

const startedAt = Date.parse('2026-09-05T00:00:00Z');
const valid = { event: 'app.shell_document_loaded', pid: 123, webContentsId: 1,
  time: new Date(startedAt + 1).toISOString(), location: 'app://app/renderer/index.html' };

test('startup observation accepts only the exact owned shell-load record after spawn', () => {
  assert.equal(hasShellDocumentLoaded(JSON.stringify(valid), 123, startedAt), true);
  for (const change of [{ pid: 124 }, { webContentsId: 0 }, { event: 'app.start' },
    { location: 'app://app/renderer/index.html?untrusted' }, { location: 'https://example.invalid/' },
    { time: new Date(startedAt - 1).toISOString() }, { time: 'invalid' }]) {
    assert.equal(hasShellDocumentLoaded(JSON.stringify({ ...valid, ...change }), 123, startedAt), false);
  }
  assert.equal(hasShellDocumentLoaded(JSON.stringify(valid), 0, startedAt), false);
});

test('startup observation rejects malformed and over-budget records without using raw log payloads', () => {
  assert.equal(hasShellDocumentLoaded('null\n[]\nnot-json', 123, startedAt), false);
  assert.equal(hasShellDocumentLoaded('x'.repeat(MAX_STARTUP_LOG_BYTES + 1), 123, startedAt), false);
  assert.equal(hasShellDocumentLoaded('partial\n' + JSON.stringify(valid) + '\n', 123, startedAt), true);
});

test('startup log reader bounds file reads and ignores an incomplete tail prefix', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-startup-readiness-'));
  const file = path.join(directory, 'fixture.jsonl');
  try {
    assert.equal(await readShellDocumentLoaded(file, 123, startedAt), false);
    await fs.writeFile(file, 'x'.repeat(MAX_STARTUP_LOG_BYTES + 17) + '\n' + JSON.stringify(valid) + '\n');
    assert.equal(await readShellDocumentLoaded(file, 123, startedAt), true);
    assert.equal(await readShellDocumentLoaded(file, 124, startedAt), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
