import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBackPackagedLibraryChecks,
  runPackagedLibraryChecks
} from '../scripts/packaged-library-checks.mjs';

function fixtureState(bookmarks = [], history = [], behavior = {}) {
  const state = { route: 'entity', target: '', bookmarked: false, bookmarks: [...bookmarks], history: [...history] };
  const cdp = {
    async evaluate(source) {
      if (source.includes('library:bookmark-add')) { state.bookmarks.push(state.target); state.bookmarked = true; return true; }
      if (source.includes('library:bookmark-remove')) { state.bookmarks = state.bookmarks.filter((item) => item !== state.target); state.bookmarked = false; return true; }
      if (source.includes('library:route:bookmarks')) { state.route = 'bookmarks'; return true; }
      if (source.includes('library:route:history')) { state.route = 'history'; return true; }
      if (source.includes('library:route:home')) { state.route = 'home'; return true; }
      if (source.includes('library:home-row')) {
        const section = /const sectionTitle = "([^"]+)"/.exec(source)?.[1];
        const canonical = /const canonical = "([^"]+)"/.exec(source)?.[1];
        const candidates = section === 'Recent' ? (behavior.homeRecentOverride ?? state.history)
          : section === 'Bookmarks' ? (behavior.homeBookmarksOverride ?? state.bookmarks) : [];
        if (!candidates.includes(canonical)) return false;
        if (behavior.noOpHomeCard) return true;
        state.route = 'entity'; state.target = canonical; state.bookmarked = state.bookmarks.includes(canonical); state.history.unshift(canonical); return true;
      }
      if (source.includes('library:all-history')) {
        if (behavior.missingAllHistory || state.route !== 'home' || !state.history.length) return false;
        state.route = 'history'; return true;
      }
      if (source.includes('library:clear-history')) { if (state.route !== 'history' || !state.history.length) return false; state.history = []; return true; }
      if (source.includes('library:open-bookmark')) {
        const canonical = /const canonical = "([^"]+)"/.exec(source)?.[1];
        if (!state.bookmarks.includes(canonical)) return false;
        state.route = 'entity'; state.target = canonical; state.bookmarked = true; state.history.unshift(canonical); return true;
      }
      if (source.includes('library:snapshot')) {
        const heading = state.route === 'bookmarks' ? 'Bookmarks' : state.route === 'history' ? 'History'
          : state.route === 'home' ? 'Find your way around Bitcoin.' : 'Fixture';
        const page = state.route === 'bookmarks'
          ? (state.bookmarks.length ? state.bookmarks.join('\n') : 'No bookmarks')
          : state.route === 'history' ? (state.history.length ? state.history.join('\n') : 'History is empty')
            : state.route === 'home' ? [...state.history, ...state.bookmarks].join('\n') : `Fixture ${state.target}`;
        const visibleCanonicals = state.route === 'bookmarks' ? [...state.bookmarks] : state.route === 'history' ? [...state.history] : [];
        const homeSections = state.route === 'home' ? [
          { title: 'Recent', canonicals: (behavior.homeRecentOverride ?? state.history).slice(0, 6) },
          { title: 'Bookmarks', canonicals: (behavior.homeBookmarksOverride ?? state.bookmarks).slice(0, 6) }
        ] : [];
        return { busy: 'false', heading, page, target: state.target, bookmarked: state.bookmarked, bookmarkCount: String(state.bookmarks.length || ''), visibleCanonicals, homeSections };
      }
      throw new Error(`Unexpected evaluation: ${source.slice(0, 80)}`);
    }
  };
  return { state, cdp };
}

function harness(fixture) {
  const targets = [
    { input: 'sat:991001', expectedText: '991001' },
    { input: 'sat:991002', expectedText: '991002' }
  ];
  return {
    cdp: fixture.cdp,
    targets,
    assert(value, message) { assert.ok(value, message); },
    async poll(action, predicate) {
      const value = await action();
      assert.ok(predicate(value), `poll predicate failed: ${JSON.stringify(value)}`);
      return value;
    },
    async navigateShell(_cdp, input) {
      fixture.state.route = 'entity';
      fixture.state.target = input;
      fixture.state.bookmarked = fixture.state.bookmarks.includes(input);
      fixture.state.history.unshift(input);
      return { busy: 'false', target: input, page: `Fixture ${input}` };
    }
  };
}

test('packaged library workflow uses reachable UI to add/list bookmark, list history, and clear history', async () => {
  const fixture = fixtureState();
  const expectation = await runPackagedLibraryChecks(harness(fixture));
  assert.deepEqual(expectation, {
    schemaVersion: 1,
    bookmarkCanonical: 'sat:991001',
    secondCanonical: 'sat:991002',
    bookmarkExpectedAfterRestart: true,
    historyExpectedEmptyAfterRestart: true
  });
  assert.deepEqual(fixture.state.bookmarks, ['sat:991001']);
  assert.deepEqual(fixture.state.history, []);
});

test('restart readback first observes empty history, matches exact canonical, and preserves unrelated bookmarks', async () => {
  const fixture = fixtureState(['sat:9910010', 'sat:991001', 'sat:unrelated'], []);
  const result = await readBackPackagedLibraryChecks(harness(fixture), {
    schemaVersion: 1,
    bookmarkCanonical: 'sat:991001',
    secondCanonical: 'sat:991002',
    bookmarkExpectedAfterRestart: true,
    historyExpectedEmptyAfterRestart: true
  });
  assert.deepEqual(result, { bookmarkRestored: true, historyRestoredEmpty: true, cleanupComplete: true });
  assert.deepEqual(fixture.state.bookmarks, ['sat:9910010', 'sat:unrelated']);
  assert.deepEqual(fixture.state.history, []);
});

test('restart readback rejects nonempty persisted history before opening the bookmark', async () => {
  const fixture = fixtureState(['sat:991001'], ['sat:stale']);
  await assert.rejects(readBackPackagedLibraryChecks(harness(fixture), {
    schemaVersion: 1,
    bookmarkCanonical: 'sat:991001',
    secondCanonical: 'sat:991002',
    bookmarkExpectedAfterRestart: true,
    historyExpectedEmptyAfterRestart: true
  }), /poll predicate failed/);
  assert.deepEqual(fixture.state.bookmarks, ['sat:991001']);
  assert.deepEqual(fixture.state.history, ['sat:stale']);
});

test('first pass rejects a fixture target that was already bookmarked', async () => {
  const fixture = fixtureState(['sat:991001'], []);
  await assert.rejects(runPackagedLibraryChecks(harness(fixture)), /must not already be bookmarked/);
  assert.deepEqual(fixture.state.bookmarks, ['sat:991001']);
});

test('first pass rejects prefix-only Home card identities instead of substring matching', async () => {
  const fixture = fixtureState([], [], {
    homeRecentOverride: ['sat:9910010', 'sat:9910020'],
    homeBookmarksOverride: ['sat:9910010']
  });
  await assert.rejects(runPackagedLibraryChecks(harness(fixture)), /poll predicate failed/);
  assert.deepEqual(fixture.state.bookmarks, ['sat:991001']);
  assert.deepEqual(fixture.state.history, ['sat:991002', 'sat:991001']);
});

test('failed Home readback retains bounded evidence without weakening the canonical check', async () => {
  const fixture = fixtureState([], ['x'.repeat(8000)], { homeRecentOverride: [] });
  await assert.rejects(runPackagedLibraryChecks(harness(fixture)), error => {
    assert.equal(error.evidence.expectedHeading, 'Find your way around Bitcoin.');
    assert.equal(error.evidence.lastSnapshot.heading, 'Find your way around Bitcoin.');
    assert.equal(error.evidence.lastSnapshot.page.length, 4096);
    assert.deepEqual(error.evidence.lastSnapshot.homeSections[0].canonicals, []);
    return true;
  });
});

test('first pass requires the real Home All history control before clearing history', async () => {
  const fixture = fixtureState([], [], { missingAllHistory: true });
  await assert.rejects(runPackagedLibraryChecks(harness(fixture)), /Home All history control was not reachable/);
  assert.deepEqual(fixture.state.bookmarks, ['sat:991001']);
  assert.ok(fixture.state.history.includes('sat:991001'));
  assert.ok(fixture.state.history.includes('sat:991002'));
});

test('Home card click must leave Home and load the entity, even when the omnibox already matches', async () => {
  const fixture = fixtureState([], [], { noOpHomeCard: true });
  await assert.rejects(runPackagedLibraryChecks(harness(fixture)), /poll predicate failed/);
  assert.equal(fixture.state.route, 'home');
  assert.equal(fixture.state.target, 'sat:991002');
  assert.ok(fixture.state.history.includes('sat:991001'));
});

test('workflow rejects missing harness authority, duplicate targets, and malformed restart expectations', async () => {
  const fixture = fixtureState();
  const options = harness(fixture);
  await assert.rejects(runPackagedLibraryChecks({ ...options, targets: [options.targets[0], options.targets[0]] }), /unique fixture targets/);
  await assert.rejects(readBackPackagedLibraryChecks(options, { schemaVersion: 1 }), /invalid packaged library restart expectation/);
});
