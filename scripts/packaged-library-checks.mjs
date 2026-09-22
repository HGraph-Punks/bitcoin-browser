function requireHarness(options) {
  for (const name of ['cdp', 'poll', 'navigateShell', 'assert']) {
    if (typeof options?.[name] !== (name === 'cdp' ? 'object' : 'function')) throw new TypeError(`packaged library check requires ${name}`);
  }
  const targets = options.targets;
  if (!Array.isArray(targets) || targets.length !== 2
    || targets.some((item) => typeof item?.input !== 'string' || !item.input || typeof item?.expectedText !== 'string' || !item.expectedText)
    || targets[0].input === targets[1].input) throw new TypeError('two unique fixture targets with input and expectedText are required');
  return options;
}

async function clickRoute(cdp, route) {
  return cdp.evaluate(`(() => { /*library:route:${route}*/
    const button = document.querySelector('[data-route="${route}"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function pageSnapshot(cdp) {
  return cdp.evaluate(`(() => ({ /*library:snapshot*/
    // The shell remains usable during lookup; only the progress indicator
    // tracks navigation loading after bootstrap.
    busy: document.querySelector('#page-loading')?.classList.contains('hidden') === false
      ? 'true' : document.querySelector('#app')?.getAttribute('aria-busy'),
    heading: document.querySelector('#page h1')?.textContent ?? '',
    page: document.querySelector('#page')?.innerText ?? '',
    target: document.querySelector('#omnibox')?.value ?? '',
    bookmarked: document.querySelector('#bookmark-current')?.classList.contains('bookmarked') === true,
    bookmarkCount: document.querySelector('#bookmark-count')?.textContent ?? '',
    visibleCanonicals: [...document.querySelectorAll('#page .list-row .row-copy > span')].slice(0, 200).map((node) => node.textContent ?? ''),
    homeSections: [...document.querySelectorAll('#page section.section')].slice(0, 20).map((section) => ({
      title: section.querySelector('.section-heading h2')?.textContent ?? '',
      canonicals: [...section.querySelectorAll('.list-row .row-copy > span')].slice(0, 20).map((node) => node.textContent ?? '')
    }))
  }))()`);
}

async function waitForPage(options, heading, predicate = () => true) {
  let lastSnapshot;
  try {
    return await options.poll(async () => (lastSnapshot = await pageSnapshot(options.cdp)),
      (value) => value.busy === 'false' && value.heading === heading && predicate(value), undefined, `library ${heading}`);
  } catch (error) {
    error.evidence = { expectedHeading: heading, lastSnapshot: lastSnapshot && { ...lastSnapshot, page: lastSnapshot.page?.slice(0, 4096) } };
    throw error;
  }
}

async function clearHistoryViaUi(options) {
  const clicked = await options.cdp.evaluate(`(() => { /*library:clear-history*/
    const button = [...document.querySelectorAll('#page button')].find((node) => node.textContent?.trim() === 'Clear history');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  options.assert(clicked === true, 'History clear control was not reachable');
  return waitForPage(options, 'History', (value) => value.page.includes('History is empty'));
}

async function clickHomeCanonical(options, sectionTitle, canonical) {
  return options.cdp.evaluate(`(() => { /*library:home-row*/
    const sectionTitle = ${JSON.stringify(sectionTitle)};
    const canonical = ${JSON.stringify(canonical)};
    const section = [...document.querySelectorAll('#page section.section')].find((node) => node.querySelector('.section-heading h2')?.textContent === sectionTitle);
    const row = [...(section?.querySelectorAll('.list-row.interactive') ?? [])].find((node) => node.querySelector('.row-copy > span')?.textContent === canonical);
    if (!row) return false;
    row.click();
    return true;
  })()`);
}

async function waitForHomeCardDestination(options, canonical, expectedText, label) {
  return options.poll(() => pageSnapshot(options.cdp), (value) => value.busy === 'false'
    && value.target === canonical && value.heading !== 'Find your way around Bitcoin.'
    && value.page.includes(expectedText) && !/Navigation error/i.test(value.page), undefined, label);
}

export async function runPackagedLibraryChecks(rawOptions) {
  const options = requireHarness(rawOptions);
  const [bookmarkTarget, secondTarget] = options.targets;
  const first = await options.navigateShell(options.cdp, bookmarkTarget.input, bookmarkTarget.expectedText);
  const canonical = first?.target;
  options.assert(typeof canonical === 'string' && canonical.length > 0, 'First fixture target did not expose a canonical omnibox value');
  const initial = await pageSnapshot(options.cdp);
  options.assert(initial.bookmarked === false, 'First fixture target must not already be bookmarked');

  const toggled = await options.cdp.evaluate(`(() => { /*library:bookmark-add*/
    const button = document.querySelector('#bookmark-current');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  options.assert(toggled === true, 'Bookmark control was not reachable for fixture target');
  await options.poll(() => pageSnapshot(options.cdp), (value) => value.bookmarked === true, undefined, 'bookmark added');

  const second = await options.navigateShell(options.cdp, secondTarget.input, secondTarget.expectedText);
  options.assert(second?.target && second.target !== canonical, 'Fixture targets did not resolve to distinct canonical targets');

  options.assert(await clickRoute(options.cdp, 'home'), 'Home navigation control was not reachable');
  const home = await waitForPage(options, 'Find your way around Bitcoin.', (value) => {
    const recent = value.homeSections.find((section) => section.title === 'Recent')?.canonicals ?? [];
    const bookmarks = value.homeSections.find((section) => section.title === 'Bookmarks')?.canonicals ?? [];
    return recent.includes(canonical) && recent.includes(second.target) && bookmarks.includes(canonical);
  });
  options.assert(home.homeSections.find((section) => section.title === 'Recent')?.canonicals.includes(second.target), 'Home Recent omitted the exact second fixture canonical');
  options.assert(await clickHomeCanonical(options, 'Recent', second.target), 'Home Recent exact canonical row was not interactive');
  await waitForHomeCardDestination(options, second.target, secondTarget.expectedText, 'Home Recent row opened');

  options.assert(await clickRoute(options.cdp, 'home'), 'Home navigation control was not reachable after Recent');
  await waitForPage(options, 'Find your way around Bitcoin.', (value) => value.homeSections.find((section) => section.title === 'Bookmarks')?.canonicals.includes(canonical));
  options.assert(await clickHomeCanonical(options, 'Bookmarks', canonical), 'Home Bookmarks exact canonical row was not interactive');
  await waitForHomeCardDestination(options, canonical, bookmarkTarget.expectedText, 'Home bookmark row opened');

  options.assert(await clickRoute(options.cdp, 'home'), 'Home navigation control was not reachable before All history');
  await waitForPage(options, 'Find your way around Bitcoin.');
  const allHistory = await options.cdp.evaluate(`(() => { /*library:all-history*/
    const section = [...document.querySelectorAll('#page section.section')].find((node) => node.querySelector('.section-heading h2')?.textContent === 'Recent');
    const button = [...(section?.querySelectorAll('button') ?? [])].find((node) => node.textContent?.trim() === 'All history');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  options.assert(allHistory === true, 'Home All history control was not reachable');
  await waitForPage(options, 'History', (value) => value.visibleCanonicals.includes(canonical) && value.visibleCanonicals.includes(second.target));

  options.assert(await clickRoute(options.cdp, 'bookmarks'), 'Bookmarks navigation control was not reachable');
  const bookmarks = await waitForPage(options, 'Bookmarks', (value) => value.visibleCanonicals.includes(canonical));
  options.assert(bookmarks.visibleCanonicals.includes(canonical), 'Bookmarks view omitted the exact canonical fixture target');

  options.assert(await clickRoute(options.cdp, 'history'), 'History navigation control was not reachable');
  const history = await waitForPage(options, 'History', (value) => value.visibleCanonicals.includes(canonical) && value.visibleCanonicals.includes(second.target));
  options.assert(history.visibleCanonicals.includes(canonical) && history.visibleCanonicals.includes(second.target), 'History view omitted an exact fixture navigation');
  await clearHistoryViaUi(options);

  return Object.freeze({
    schemaVersion: 1,
    bookmarkCanonical: canonical,
    secondCanonical: second.target,
    bookmarkExpectedAfterRestart: true,
    historyExpectedEmptyAfterRestart: true
  });
}

export async function readBackPackagedLibraryChecks(rawOptions, expectation) {
  const options = requireHarness(rawOptions);
  if (expectation?.schemaVersion !== 1 || typeof expectation.bookmarkCanonical !== 'string'
    || expectation.bookmarkExpectedAfterRestart !== true || expectation.historyExpectedEmptyAfterRestart !== true) {
    throw new TypeError('invalid packaged library restart expectation');
  }
  options.assert(await clickRoute(options.cdp, 'history'), 'History navigation control was not reachable after restart');
  const restoredHistory = await waitForPage(options, 'History', (value) => value.visibleCanonicals.length === 0 && value.page.includes('History is empty'));
  options.assert(restoredHistory.visibleCanonicals.length === 0, 'History was not empty at restart readback');

  options.assert(await clickRoute(options.cdp, 'bookmarks'), 'Bookmarks navigation control was not reachable after restart');
  const bookmarks = await waitForPage(options, 'Bookmarks', (value) => value.visibleCanonicals.includes(expectation.bookmarkCanonical));
  options.assert(bookmarks.visibleCanonicals.includes(expectation.bookmarkCanonical), 'Persisted exact bookmark was absent after restart');

  const opened = await options.cdp.evaluate(`(() => { /*library:open-bookmark*/
    const canonical = ${JSON.stringify(expectation.bookmarkCanonical)};
    const row = [...document.querySelectorAll('#page .list-row.interactive')].find((node) => node.querySelector('.row-copy > span')?.textContent === canonical);
    if (!row) return false;
    row.click();
    return true;
  })()`);
  options.assert(opened === true, 'Persisted bookmark row was not interactive');
  await options.poll(() => pageSnapshot(options.cdp), (value) => value.target === expectation.bookmarkCanonical && value.busy === 'false', undefined, 'persisted bookmark opened');
  const removed = await options.cdp.evaluate(`(() => { /*library:bookmark-remove*/
    const button = document.querySelector('#bookmark-current');
    if (!button || !button.classList.contains('bookmarked')) return false;
    button.click();
    return true;
  })()`);
  options.assert(removed === true, 'Persisted bookmark could not be toggled off');
  await options.poll(() => pageSnapshot(options.cdp), (value) => value.bookmarked === false, undefined, 'bookmark removed');

  options.assert(await clickRoute(options.cdp, 'history'), 'History navigation control was not reachable for cleanup');
  await waitForPage(options, 'History');
  await clearHistoryViaUi(options);
  options.assert(await clickRoute(options.cdp, 'bookmarks'), 'Bookmarks navigation control was not reachable after cleanup');
  await waitForPage(options, 'Bookmarks', (value) => !value.visibleCanonicals.includes(expectation.bookmarkCanonical));
  return { bookmarkRestored: true, historyRestoredEmpty: true, cleanupComplete: true };
}
