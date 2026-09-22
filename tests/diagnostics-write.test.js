import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DIAGNOSTICS_BYTES, writeDiagnostics } from '../src/main/diagnostics.js';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-diagnostics-write-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('diagnostics atomic replacement creates mode-0600 files and tightens existing permissions', async (t) => {
  const directory = await temporaryDirectory(t);
  for (const existing of [false, true]) {
    const destination = path.join(directory, existing ? 'existing.json' : 'new.json');
    if (existing) await fs.writeFile(destination, 'old', { mode: 0o644 });
    await writeDiagnostics(destination, { existing });
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { existing });
    if (process.platform === 'win32') {
      t.diagnostic('Windows does not implement POSIX owner-only mode bits; native DACL qualification remains required.');
    } else {
      assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    }
  }
  assert.deepEqual((await fs.readdir(directory)).sort(), ['existing.json', 'new.json']);
});

test('diagnostics replacement never follows an existing destination symlink', async (t) => {
  const directory = await temporaryDirectory(t);
  const sentinel = path.join(directory, 'sentinel.txt');
  const destination = path.join(directory, 'diagnostics.json');
  await fs.writeFile(sentinel, 'unchanged');
  await fs.symlink(sentinel, destination);
  await writeDiagnostics(destination, { safe: true });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { safe: true });
});

test('failed atomic write preserves the old destination and cleans its exact temporary file', async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, 'diagnostics.json');
  await fs.writeFile(destination, 'old diagnostics');
  const realOpen = fs.open.bind(fs);
  const injected = {
    ...fs,
    async open(file, flags, mode) {
      const handle = await realOpen(file, flags, mode);
      return { close: () => handle.close(), sync: () => handle.sync(), writeFile: async () => { throw new Error('fixture write failure'); } };
    }
  };
  await assert.rejects(writeDiagnostics(destination, { replacement: true }, { fs: injected, randomId: () => 'fixture' }), /fixture write failure/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'old diagnostics');
  assert.deepEqual(await fs.readdir(directory), ['diagnostics.json']);
});

test('exclusive temporary collision does not remove a file this export did not create', async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, 'diagnostics.json');
  const collision = path.join(directory, '.diagnostics.json.fixture.tmp');
  await fs.writeFile(collision, 'other owner', { mode: 0o600 });
  await assert.rejects(writeDiagnostics(destination, { safe: true }, { randomId: () => 'fixture' }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(collision, 'utf8'), 'other owner');
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('oversized and unserializable diagnostics fail before opening a temporary file', async () => {
  let opens = 0;
  const injected = { open: async () => { opens += 1; throw new Error('must not open'); } };
  await assert.rejects(
    writeDiagnostics('/tmp/unused-diagnostics.json', { value: 'x'.repeat(MAX_DIAGNOSTICS_BYTES) }, { fs: injected }),
    { code: 'DIAGNOSTICS_TOO_LARGE', status: 413 }
  );
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(writeDiagnostics('/tmp/unused-diagnostics.json', cyclic, { fs: injected }), TypeError);
  assert.equal(opens, 0);
});
