import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DiskCache } from '../src/main/cache.js';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const options = { maxBytes: 1024 * 1024, maxEntryBytes: 1024 };
const staging = (label, suffix) => `${digest(label)}.123.12345678-1234-4234-8234-123456789abc.${suffix}`;

async function fixture(t, indexText) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-index-root-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const objects = path.join(directory, 'objects');
  await fs.mkdir(objects);
  await fs.writeFile(path.join(directory, 'index.json'), indexText);
  const removed = [digest('orphan'), staging('temporary', 'tmp'), staging('previous', 'previous')];
  for (const name of removed) await fs.writeFile(path.join(objects, name), 'synthetic orphan');
  const preserved = ['operator-note.txt', digest('directory'), digest('symlink'), staging('symlink-staging', 'tmp')];
  await fs.writeFile(path.join(objects, preserved[0]), 'operator note');
  await fs.mkdir(path.join(objects, preserved[1]));
  await fs.writeFile(path.join(objects, preserved[1], 'keep.txt'), 'directory sentinel');
  await fs.symlink(preserved[0], path.join(objects, preserved[2]));
  await fs.symlink(preserved[0], path.join(objects, preserved[3]));
  return { directory, objects, removed, preserved };
}

async function verifyRepairAndUse(f, expectedEntries = 0) {
  const cache = new DiskCache(f.directory, options);
  await cache.init();
  assert.equal(cache.stats().entries, expectedEntries);
  const names = await fs.readdir(f.objects);
  for (const name of f.removed) assert.equal(names.includes(name), false, `Removed regular orphan: ${name}`);
  for (const name of f.preserved) assert.equal(names.includes(name), true, `Preserved non-owned entry: ${name}`);
  assert.equal(await fs.readFile(path.join(f.objects, f.preserved[0]), 'utf8'), 'operator note');
  assert.equal(await fs.readFile(path.join(f.objects, f.preserved[1], 'keep.txt'), 'utf8'), 'directory sentinel');
  for (const name of f.preserved.slice(2)) {
    assert.equal((await fs.lstat(path.join(f.objects, name))).isSymbolicLink(), true);
    assert.equal(await fs.readlink(path.join(f.objects, name)), f.preserved[0]);
  }
  const repaired = JSON.parse(await fs.readFile(path.join(f.directory, 'index.json'), 'utf8'));
  assert.equal(Array.isArray(repaired), false);
  assert.equal(Object.keys(repaired).length, expectedEntries);
  const put = await cache.put('new-key', Buffer.from('new bytes'), { fixture: true });
  assert.equal(put.cached, true);
  assert.equal((await cache.get('new-key')).data.toString(), 'new bytes');
  await cache.flush();
  const reopened = new DiskCache(f.directory, options);
  await reopened.init();
  assert.equal((await reopened.get('new-key')).data.toString(), 'new bytes');
  assert.equal(reopened.stats().entries, expectedEntries + 1);
  await reopened.flush();
  return reopened;
}

test('JSON null cache index recovers with exact orphan cleanup and usable persistent cache', async (t) => {
  await verifyRepairAndUse(await fixture(t, 'null'));
});

test('malformed JSON and non-map scalar/array roots normalize to a usable empty cache', async (t) => {
  for (const input of ['{broken', 'false', 'true', '0', '"text"', '[]', '[{"bytes":1}]']) {
    const f = await fixture(t, input);
    await verifyRepairAndUse(f);
  }
});

test('valid empty object retains recovery cleanup and persistent put/get behavior', async (t) => {
  await verifyRepairAndUse(await fixture(t, '{}'));
});

test('valid nonempty index retains its verified object while repairing unrelated cache-shaped orphans', async (t) => {
  const key = 'existing-key'; const data = Buffer.from('existing verified bytes');
  const entry = { key, bytes: data.length, sha256: digest(data), createdAt: 1, lastAccessedAt: 1, expiresAt: null, hits: 0, meta: { retained: true } };
  const f = await fixture(t, JSON.stringify({ [digest(key)]: entry }));
  await fs.writeFile(path.join(f.objects, digest(key)), data);
  const reopened = await verifyRepairAndUse(f, 1);
  const hit = await reopened.get(key);
  assert.equal(hit.data.toString(), data.toString());
  assert.deepEqual(hit.meta, { retained: true });
  await reopened.flush();
});
