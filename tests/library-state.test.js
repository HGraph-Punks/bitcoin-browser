import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/main/state-store.js';
import { MAX_HISTORY, STATE_SCHEMA_VERSION } from '../src/shared/constants.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-library-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('migration rejects malformed library entries and repairs duplicate bookmarks', async (t) => {
  const directory = await fixture(t);
  const validHistory = Array.from({ length: MAX_HISTORY + 2 }, (_, index) => ({
    id: `history-${index}`,
    canonical: `block:${index}`,
    title: `Block ${index}`,
    kind: 'block',
    providerId: 'fixture',
    visitedAt: '2026-01-01T00:00:00.000Z'
  }));
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    history: [null, 'bad', {}, { canonical: '' }, ...validHistory],
    bookmarks: [
      null,
      42,
      { canonical: 'sat:1', title: 'Newest', kind: 'sat', createdAt: '2026-01-02T00:00:00.000Z' },
      { canonical: 'sat:1', title: 'Older duplicate', kind: 'sat', createdAt: '2026-01-01T00:00:00.000Z' },
      { canonical: 'sat:2', title: 'Second', createdAt: 'not-a-date' },
      { canonical: '' }
    ]
  };
  await fs.writeFile(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`);

  const store = new StateStore(directory, null);
  await store.init();

  assert.equal(store.get(['history']).length, MAX_HISTORY);
  assert.equal(store.get(['history', 0, 'canonical']), 'block:0');
  assert.deepEqual(store.get(['bookmarks']).map(({ canonical, title }) => ({ canonical, title })), [
    { canonical: 'sat:1', title: 'Newest' },
    { canonical: 'sat:2', title: 'Second' }
  ]);
  assert.equal(store.get(['bookmarks', 1, 'createdAt']), '1970-01-01T00:00:00.000Z');

  const restarted = new StateStore(directory, null);
  await restarted.init();
  assert.deepEqual(restarted.get(['bookmarks']), store.get(['bookmarks']));
  assert.deepEqual(restarted.get(['history']), store.get(['history']));
});

test('removing a migrated duplicate bookmark removes the canonical target completely', async (t) => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'state.json'), `${JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    bookmarks: [
      { id: 'one', canonical: 'sat:1', title: 'One', kind: 'sat', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'two', canonical: 'sat:1', title: 'Two', kind: 'sat', createdAt: '2026-01-02T00:00:00.000Z' }
    ]
  })}\n`);
  const store = new StateStore(directory, null);
  await store.init();

  const result = await store.toggleBookmark({ canonical: 'sat:1' });
  assert.deepEqual(result, { bookmarked: false, bookmarks: [] });
  assert.deepEqual(store.get(['bookmarks']), []);

  const restarted = new StateStore(directory, null);
  await restarted.init();
  assert.deepEqual(restarted.get(['bookmarks']), []);
});

test('concurrent bookmark responses describe each committed transaction', async (t) => {
  const directory = await fixture(t);
  const store = new StateStore(directory, null);
  await store.init();

  const [added, removed] = await Promise.all([
    store.toggleBookmark({ canonical: 'sat:1', title: 'One', kind: 'sat' }),
    store.toggleBookmark({ canonical: 'sat:1', title: 'One', kind: 'sat' })
  ]);

  assert.equal(added.bookmarked, true);
  assert.deepEqual(added.bookmarks.map((entry) => entry.canonical), ['sat:1']);
  assert.deepEqual(removed, { bookmarked: false, bookmarks: [] });
  assert.deepEqual(store.get(['bookmarks']), []);
});

test('rapid adjacent history visits coalesce without globally removing older visits', async (t) => {
  const directory = await fixture(t);
  const store = new StateStore(directory, null);
  await store.init();

  const first = await store.recordHistory({ canonical: 'sat:1', title: 'First', kind: 'sat' });
  await store.recordHistory({ canonical: 'sat:2', title: 'Second', kind: 'sat' });
  const repeated = await store.recordHistory({ canonical: 'sat:1', title: 'Repeated later', kind: 'sat' });
  const coalesced = await store.recordHistory({ canonical: 'sat:1', title: 'Rapid repeat', kind: 'sat' });

  assert.notEqual(first.id, repeated.id);
  assert.notEqual(repeated.id, coalesced.id);
  assert.deepEqual(store.get(['history']).map((entry) => entry.canonical), ['sat:1', 'sat:2', 'sat:1']);
  assert.equal(store.get(['history', 0, 'title']), 'Rapid repeat');
});

test('queued history uses one commit-time clock for persistence and response', async (t) => {
  const directory = await fixture(t);
  let now = Date.parse('2026-01-01T00:00:01.000Z');
  t.mock.method(Date, 'now', () => now);
  const store = new StateStore(directory, null);
  await store.init();
  await store.recordHistory({ canonical: 'sat:1', title: 'First', kind: 'sat' });

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const blocker = store.mutate(async () => held);
  const queued = store.recordHistory({ canonical: 'sat:1', title: 'After queue', kind: 'sat' });
  now = Date.parse('2026-01-01T00:00:07.000Z');
  release();
  await blocker;

  const committed = await queued;
  assert.equal(committed.visitedAt, '2026-01-01T00:00:07.000Z');
  assert.deepEqual(store.get(['history']).map((item) => item.visitedAt), [
    '2026-01-01T00:00:07.000Z',
    '2026-01-01T00:00:01.000Z'
  ]);
});

test('a future-dated latest entry does not absorb a current visit', async (t) => {
  const directory = await fixture(t);
  const now = Date.parse('2026-01-01T00:00:01.000Z');
  t.mock.method(Date, 'now', () => now);
  const store = new StateStore(directory, null);
  await store.init();
  await store.mutate((draft) => {
    draft.history = [{
      id: 'future',
      canonical: 'sat:1',
      title: 'Future',
      kind: 'sat',
      providerId: null,
      visitedAt: '2026-01-01T00:00:02.000Z'
    }];
  });

  const current = await store.recordHistory({ canonical: 'sat:1', title: 'Current', kind: 'sat' });
  assert.equal(current.visitedAt, '2026-01-01T00:00:01.000Z');
  assert.deepEqual(store.get(['history']).map((item) => item.title), ['Current', 'Future']);
});

test('library methods reject non-object input with validation errors', async (t) => {
  const directory = await fixture(t);
  const store = new StateStore(directory, null);
  await store.init();

  await assert.rejects(store.recordHistory(null), (error) => error.code === 'VALIDATION_ERROR' && error.status === 400);
  await assert.rejects(store.toggleBookmark(null), (error) => error.code === 'VALIDATION_ERROR' && error.status === 400);
  await assert.rejects(store.recordHistory({ canonical: 1 }), (error) => error.code === 'VALIDATION_ERROR' && error.status === 400);
  await assert.rejects(store.toggleBookmark({ canonical: 'x'.repeat(4_097) }), (error) => error.code === 'VALIDATION_ERROR' && error.status === 400);
});

test('migration collects bounded valid history and rejects truncation collisions', async (t) => {
  const directory = await fixture(t);
  const validHistory = Array.from({ length: MAX_HISTORY }, (_, index) => ({
    canonical: `block:${index}`,
    visitedAt: '2026-01-01T00:00:00.000Z'
  }));
  const sharedPrefix = 'x'.repeat(4_096);
  await fs.writeFile(path.join(directory, 'state.json'), `${JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    history: [null, {}, ...validHistory, { canonical: 'not-scanned', visitedAt: '2026-01-01T00:00:00.000Z' }],
    bookmarks: [
      { canonical: `${sharedPrefix}a`, createdAt: '2026-01-01T00:00:00.000Z' },
      { canonical: `${sharedPrefix}b`, createdAt: '2026-01-01T00:00:00.000Z' },
      { canonical: 'sat:valid', createdAt: '2026-01-01T00:00:00.000Z' }
    ]
  })}\n`);

  const store = new StateStore(directory, null);
  await store.init();

  assert.equal(store.get(['history']).length, MAX_HISTORY);
  assert.equal(store.get(['history', 0, 'canonical']), 'block:0');
  assert.equal(store.get(['history', MAX_HISTORY - 1, 'canonical']), `block:${MAX_HISTORY - 1}`);
  assert.deepEqual(store.get(['bookmarks']).map((entry) => entry.canonical), ['sat:valid']);
});
