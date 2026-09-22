import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/main/state-store.js';
import { MAX_HISTORY, MAX_TABS } from '../src/shared/constants.js';

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-state-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new StateStore(directory, null) };
}

test('recovers a corrupt primary from backup without overwriting the valid backup', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.init();
  await store.updateSettings({ theme: 'light' });
  await store.flush();
  const valid = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
  await fs.writeFile(path.join(directory, 'state.backup.json'), valid);
  await fs.writeFile(path.join(directory, 'state.json'), '{corrupt');
  const recovered = new StateStore(directory, null);
  await recovered.init();
  assert.deepEqual(recovered.recoveryStatus, { source: 'backup', reason: 'invalid' });
  assert.equal(recovered.get(['settings', 'theme']), 'light');
  assert.doesNotThrow(() => JSON.parse(valid));
  const preservedBackup = await fs.readFile(path.join(directory, 'state.backup.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(preservedBackup));
});

test('a missing primary recovers from backup and reports the recovery source', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.init();
  await store.updateSettings({ theme: 'light' });
  await store.flush();
  await fs.unlink(path.join(directory, 'state.json'));

  const recovered = new StateStore(directory, null);
  await recovered.init();
  assert.equal(recovered.get(['settings', 'theme']), 'light');
  assert.deepEqual(recovered.recoveryStatus, { source: 'backup', reason: 'missing' });
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).settings.theme, 'light');
});

test('non-object primary JSON recovers from a valid backup', async (t) => {
  for (const [label, malformed] of [['array', '[]'], ['null', 'null'], ['number', '42']]) {
    await t.test(label, async (t) => {
      const { directory, store } = await temporaryStore(t);
      await store.init();
      await store.updateSettings({ theme: 'light' });
      await store.flush();
      await fs.writeFile(path.join(directory, 'state.json'), malformed);

      const recovered = new StateStore(directory, null);
      await recovered.init();
      assert.equal(recovered.get(['settings', 'theme']), 'light');
      assert.deepEqual(recovered.recoveryStatus, { source: 'backup', reason: 'invalid' });
    });
  }
});

test('both corrupt files fall back to defaults without destroying backup evidence', async (t) => {
  const { directory } = await temporaryStore(t);
  const corruptBackup = '{bad backup';
  await fs.writeFile(path.join(directory, 'state.json'), '{bad primary');
  await fs.writeFile(path.join(directory, 'state.backup.json'), corruptBackup);

  const store = new StateStore(directory, null);
  await store.init();
  assert.equal(store.get(['settings', 'theme']), 'system');
  assert.deepEqual(store.recoveryStatus, { source: 'defaults', reason: 'invalid' });
  assert.equal(await fs.readFile(path.join(directory, 'state.backup.json'), 'utf8'), corruptBackup);
  const primary = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(primary));
});

test('non-object primary and backup fall back to defaults while retaining backup evidence', async (t) => {
  const { directory } = await temporaryStore(t);
  await fs.writeFile(path.join(directory, 'state.json'), '[]');
  await fs.writeFile(path.join(directory, 'state.backup.json'), 'null');

  const store = new StateStore(directory, null);
  await store.init();
  assert.equal(store.get(['settings', 'theme']), 'system');
  assert.deepEqual(store.recoveryStatus, { source: 'defaults', reason: 'invalid' });
  assert.equal(await fs.readFile(path.join(directory, 'state.backup.json'), 'utf8'), 'null');
  const primary = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(Array.isArray(primary), false);
  assert.equal(typeof primary, 'object');
});

test('new stores report a clean missing-state fallback and create both files', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.init();
  assert.deepEqual(store.recoveryStatus, { source: 'defaults', reason: 'missing' });
  const primary = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
  const backup = await fs.readFile(path.join(directory, 'state.backup.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(primary));
  assert.doesNotThrow(() => JSON.parse(backup));
});

test('startup removes only regular StateStore temporary files', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.init();
  const removable = 'state.json.123.456.tmp';
  const unrelated = 'state.json.0.456.tmp';
  const note = 'operator-note.txt';
  const symlink = 'state.json.789.101112.tmp';
  const directoryName = 'state.json.321.654.tmp';
  await fs.writeFile(path.join(directory, removable), 'interrupted');
  await fs.writeFile(path.join(directory, unrelated), 'not-owned');
  await fs.writeFile(path.join(directory, note), 'operator data');
  await fs.symlink(note, path.join(directory, symlink));
  await fs.mkdir(path.join(directory, directoryName));

  const restarted = new StateStore(directory, null);
  await restarted.init();
  const names = new Set(await fs.readdir(directory));
  assert.equal(names.has(removable), false);
  assert.equal(names.has(unrelated), true);
  assert.equal(names.has(note), true);
  assert.equal(names.has(symlink), true);
  assert.equal(names.has(directoryName), true);
  assert.equal((await fs.lstat(path.join(directory, symlink))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(directory, note), 'utf8'), 'operator data');
});

test('atomic persistence leaves restartable primary and backup snapshots', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.init();
  await store.updateSettings({ theme: 'dark' });
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).settings.theme, 'dark');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'state.backup.json'), 'utf8')).settings.theme, 'system');
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);

  await store.flush();
  await fs.writeFile(path.join(directory, 'state.json'), '{interrupted write');
  const recovered = new StateStore(directory, null);
  await recovered.init();
  assert.equal(recovered.get(['settings', 'theme']), 'dark');
  assert.deepEqual(recovered.recoveryStatus, { source: 'backup', reason: 'invalid' });
});

test('a rejected mutation does not poison later state writes', async (t) => {
  const { store } = await temporaryStore(t);
  await store.init();
  await assert.rejects(store.mutate(() => { throw new Error('fixture failure'); }), /fixture failure/);
  const settings = await store.updateSettings({ theme: 'dark' });
  assert.equal(settings.theme, 'dark');
});

test('persisted settings and tab history indices are normalized', async (t) => {
  const { directory } = await temporaryStore(t);
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({
    schemaVersion: 3,
    settings: { maxConcurrentContentRequests: 'unbounded', telemetryEnabled: true },
    tabs: [{ id: 'tab', title: 'Tab', target: 'block:1', history: ['block:0', 'block:1'], historyIndex: 99 }],
    activeTabId: 'tab'
  }));
  const store = new StateStore(directory, null);
  await store.init();
  assert.equal(store.get(['settings', 'maxConcurrentContentRequests']), 12);
  assert.equal(store.get(['settings', 'telemetryEnabled']), false);
  assert.equal(store.get(['tabs', 0, 'historyIndex']), 1);
  assert.ok(store.get(['providers']).length > 0, 'absent provider configuration receives defaults');
});

test('removing the final provider persists an empty list and repairs the preference', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await store.init();
  const provider = store.get(['providers', 0]);
  const providerId = provider.id;
  await store.mutate((draft) => {
    draft.providers = [provider];
    draft.settings.preferredProviderId = providerId;
  });
  await store.removeProvider(providerId);
  assert.deepEqual(store.get(['providers']), []);
  assert.equal(store.get(['settings', 'preferredProviderId']), null);

  const restarted = new StateStore(directory, null);
  await restarted.init();
  assert.deepEqual(restarted.get(['providers']), []);
  assert.equal(restarted.get(['settings', 'preferredProviderId']), null);
});

test('invalid persisted provider entries fail safe without re-enabling defaults', async (t) => {
  const { directory } = await temporaryStore(t);
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({
    schemaVersion: 3,
    settings: { preferredProviderId: 'invalid-provider' },
    providers: [{ id: 'invalid-provider', type: 'not-a-provider' }]
  }));
  const store = new StateStore(directory, null);
  await store.init();
  assert.deepEqual(store.get(['providers']), []);
  assert.equal(store.get(['settings', 'preferredProviderId']), null);
});

test('migration bounds collections while preserving newest history, bookmarks, and tab selection', async (t) => {
  const { directory } = await temporaryStore(t);
  const history = Array.from({ length: MAX_HISTORY + 3 }, (_, index) => ({
    id: `history-${index}`,
    canonical: `block:${index}`,
    visitedAt: '2026-01-01T00:00:00.000Z'
  }));
  const bookmarks = Array.from({ length: 10_003 }, (_, index) => ({
    id: `bookmark-${index}`,
    canonical: `sat:${index}`,
    createdAt: '2026-01-01T00:00:00.000Z'
  }));
  const tabHistory = Array.from({ length: 250 }, (_, index) => `block:${index}`);
  const tabs = Array.from({ length: MAX_TABS + 2 }, (_, index) => ({
    id: `tab-${index}`,
    title: `Tab ${index}`,
    target: index === 0 ? 'block:225' : `block:${index}`,
    history: index === 0 ? tabHistory : [`block:${index}`],
    historyIndex: index === 0 ? 225 : 0
  }));
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify({
    schemaVersion: 3,
    settings: {},
    history,
    bookmarks,
    tabs,
    activeTabId: 'tab-63'
  }));

  const store = new StateStore(directory, null);
  await store.init();
  assert.equal(store.get(['history']).length, MAX_HISTORY);
  assert.equal(store.get(['history', 0, 'id']), 'history-0');
  assert.equal(store.get(['history', MAX_HISTORY - 1, 'id']), `history-${MAX_HISTORY - 1}`);
  assert.equal(store.get(['bookmarks']).length, 10_000);
  assert.equal(store.get(['bookmarks', 9_999, 'id']), 'bookmark-9999');
  assert.equal(store.get(['tabs']).length, MAX_TABS);
  assert.equal(store.get(['activeTabId']), 'tab-63');
  assert.equal(store.get(['tabs', 0, 'history']).length, 200);
  assert.equal(store.get(['tabs', 0, 'historyIndex']), 175);
  assert.equal(store.get(['tabs', 0, 'history', 175]), 'block:225');
});
