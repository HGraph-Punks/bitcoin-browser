import { randomUUID } from 'node:crypto';

const CONTROL_CASES = Object.freeze([
  ['Bitcoin network', 'network', 'select', ['mainnet', 'testnet', 'signet', 'regtest']],
  ['Theme', 'theme', 'select', ['system', 'dark', 'light']],
  ['Restore tabs', 'restoreSession', 'switch'],
  ['Privacy profile', 'privacyMode', 'select', ['strict', 'balanced', 'compatible']],
  ['Content network policy', 'contentNetworkPolicy', 'select', ['blocked', 'https-only']],
  ['Local only', 'localOnly', 'switch'],
  ['Offline mode', 'offlineMode', 'switch'],
  ['Maximum recursion depth', 'maxRecursionDepth', 'number', [1, 128]],
  ['Maximum recursion nodes', 'maxRecursionNodes', 'number', [1, 10000]],
  ['Concurrent requests', 'maxConcurrentContentRequests', 'number', [1, 64]],
  ['Cache capacity', 'cacheMaxBytes', 'select', [268435456, 1073741824, 5368709120, 21474836480]],
  ['Maximum resource size', 'maxResourceBytes', 'select', [16777216, 67108864, 268435456, 1073741824]],
  ['Developer mode', 'developerMode', 'switch'],
  ['Request timeout', 'requestTimeoutMs', 'number', [1000, 120000]]
]);

function exactJson(value) {
  if (Array.isArray(value)) return `[${value.map(exactJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${exactJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function requireOptions(options) {
  for (const key of ['poll', 'assert']) if (typeof options?.[key] !== 'function') throw new TypeError(`packaged Settings controls require ${key}`);
  if (!options?.cdp || typeof options.cdp.evaluate !== 'function') throw new TypeError('packaged Settings controls require cdp.evaluate');
  return options;
}

async function settings(cdp) {
  return cdp.evaluate('window.satBrowser.app.bootstrap().then((value) => value.state.settings)');
}

async function route(options) {
  options.assert(await options.cdp.evaluate(`(() => { /*settings-controls:route*/
    const control = document.querySelector('[data-route="settings"]'); if (!control) return false; control.click(); return true;
  })()`), 'Settings route was not reachable');
  await options.poll(() => options.cdp.evaluate("document.querySelector('#page h1')?.textContent"), (value) => value === 'Settings', undefined, 'Settings page');
}

function alternate(current, values) {
  return values.find((value) => String(value) !== String(current));
}

function privacyDerived(privacyMode) {
  return { privacyMode, localOnly: privacyMode === 'strict',
    contentNetworkPolicy: privacyMode === 'compatible' ? 'https-only' : 'blocked' };
}

async function setControl(options, label, kind, value) {
  return options.cdp.evaluate(`(() => { /*settings-controls:set*/
    const label = ${JSON.stringify(label)}; const kind = ${JSON.stringify(kind)}; const value = ${JSON.stringify(value)};
    const controls = [...document.querySelectorAll('#page [aria-label]')].filter((node) => node.getAttribute('aria-label') === label);
    if (controls.length !== 1) return { ok: false, count: controls.length };
    const control = controls[0];
    if (kind === 'switch') control.click();
    else { control.value = String(value); control.dispatchEvent(new Event('change', { bubbles: true })); }
    return { ok: true, tag: control.tagName, role: control.getAttribute('role'), value: kind === 'switch' ? control.getAttribute('aria-checked') : control.value };
  })()`);
}

async function renderedMatches(options, expected) {
  return options.cdp.evaluate(`(() => { /*settings-controls:rendered-state*/
    const expected = ${JSON.stringify(expected)};
    const cases = ${JSON.stringify(CONTROL_CASES.map(([label, key, kind]) => ({ label, key, kind })))};
    for (const item of cases) {
      const controls = [...document.querySelectorAll('#page [aria-label]')].filter((node) => node.getAttribute('aria-label') === item.label);
      if (controls.length !== 1) return false;
      const actual = item.kind === 'switch' ? controls[0].getAttribute('aria-checked') === 'true' : controls[0].value;
      if (String(actual) !== String(expected[item.key])) return false;
    }
    const expectedTheme = expected.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : expected.theme;
    return document.documentElement.dataset.theme === expectedTheme;
  })()`);
}

async function restoreThroughControls(options, before, key, kind) {
  await setControl(options, CONTROL_CASES.find((item) => item[1] === key)[0], kind, before[key]);
  if (key === 'privacyMode') {
    const derived = { ...before, ...privacyDerived(before.privacyMode) };
    await options.poll(() => settings(options.cdp), (current) => Object.entries(privacyDerived(before.privacyMode))
      .every(([itemKey, itemValue]) => current[itemKey] === itemValue), undefined, 'Privacy profile derived restoration');
    await options.poll(() => renderedMatches(options, derived), Boolean, undefined, 'Privacy profile rendered derived restoration');
    let current = await settings(options.cdp);
    if (current.localOnly !== before.localOnly) {
      await setControl(options, 'Local only', 'switch', before.localOnly);
      await options.poll(() => settings(options.cdp), (value) => value.localOnly === before.localOnly, undefined, 'Local only override restoration');
      current = await settings(options.cdp);
      await options.poll(() => renderedMatches(options, current), Boolean, undefined, 'Local only rendered override restoration');
    }
    if (current.contentNetworkPolicy !== before.contentNetworkPolicy) {
      await setControl(options, 'Content network policy', 'select', before.contentNetworkPolicy);
      await options.poll(() => settings(options.cdp), (value) => value.contentNetworkPolicy === before.contentNetworkPolicy,
        undefined, 'Content network policy override restoration');
      current = await settings(options.cdp);
      await options.poll(() => renderedMatches(options, current), Boolean, undefined, 'Content network policy rendered override restoration');
    }
  }
  await options.poll(() => settings(options.cdp), (current) => exactJson(current) === exactJson(before), undefined, `${key} exact authoritative restoration`);
  await options.poll(() => renderedMatches(options, before), Boolean, undefined, `${key} rendered restoration`);
}

export async function runPackagedSettingsControlChecks(rawOptions) {
  const options = requireOptions(rawOptions);
  const preflight = await options.cdp.evaluate(`Promise.all([window.satBrowser.app.bootstrap(), window.satBrowser.providers.list(), window.satBrowser.cache.stats()])
    .then(([bootstrap, providers, cache]) => ({ settings: bootstrap.state.settings, historyCount: bootstrap.state.history.length, providers, cache }))`);
  options.assert(preflight.providers.length === 0 && preflight.cache.entries === 0 && preflight.historyCount === 0,
    'Packaged Settings controls require an empty provider, cache, and history baseline');
  const initial = preflight.settings;
  const evidence = [];
  const ownedKeys = new Set();
  const instrumentationToken = randomUUID();
  let primaryFailure;
  try {
    await route(options);
    const inventory = await options.cdp.evaluate(`(() => [...document.querySelectorAll('#page [aria-label]')]
      .filter((node) => node.matches('select,input,button[role="switch"]')).map((node) => node.getAttribute('aria-label')).sort())()`);
    options.assert(exactJson(inventory) === exactJson(CONTROL_CASES.map(([label]) => label).sort()), 'Settings editable control inventory is not exactly fourteen controls');
    for (const [label, key, kind, values] of CONTROL_CASES) {
      const before = await settings(options.cdp);
      const value = kind === 'switch' ? !before[key] : alternate(before[key], values);
      options.assert(value !== undefined, `${label} has no alternate fixture value`);
      ownedKeys.add(key);
      if (key === 'privacyMode') { ownedKeys.add('localOnly'); ownedKeys.add('contentNetworkPolicy'); }
      const changed = await setControl(options, label, kind, value);
      options.assert(changed?.ok === true, `${label} was not reachable exactly once`);
      const expected = key === 'privacyMode' ? { privacyMode: value, localOnly: value === 'strict',
        contentNetworkPolicy: value === 'compatible' ? 'https-only' : 'blocked' } : { [key]: value };
      await options.poll(() => settings(options.cdp), (current) => Object.entries(expected).every(([expectedKey, expectedValue]) => current[expectedKey] === expectedValue),
        undefined, `${label} authoritative update`);
      await options.poll(() => renderedMatches(options, { ...before, ...expected }), Boolean, undefined, `${label} rendered update`);
      await restoreThroughControls(options, before, key, kind);
      evidence.push({ label, key, kind, authoritative: true, restored: true });
    }

    const beforeInvalid = await settings(options.cdp);
    const invalid = await options.cdp.evaluate(`(() => { /*settings-controls:invalid-number*/
      const control = document.querySelector('#page [aria-label="Request timeout"]'); if (!control) return false;
      if (document.querySelector('[data-settings-controls-owner]')) return false;
      const previous = document.querySelector('#toasts .toast:last-child');
      if (previous) previous.dataset.settingsControlsOwner = ${JSON.stringify(instrumentationToken)};
      control.value = '999'; control.dispatchEvent(new Event('change', { bubbles: true }));
      return { installed: true, markedPrevious: Boolean(previous) };
    })()`);
    options.assert(invalid?.installed === true, 'Invalid Request timeout instrumentation or control was not reachable');
    const feedback = await options.poll(() => options.cdp.evaluate(`(() => ({ /*settings-controls:invalid-feedback*/
      text: document.querySelector('#toasts .toast:last-child')?.textContent ?? '',
      fresh: Boolean(document.querySelector('#toasts .toast:last-child'))
        && document.querySelector('#toasts .toast:last-child')?.dataset.settingsControlsOwner !== ${JSON.stringify(instrumentationToken)}
    }))()`), (value) => value.fresh && /Could not update settings|timeout|between/i.test(value.text), undefined, 'fresh invalid Settings feedback');
    options.assert(exactJson(await settings(options.cdp)) === exactJson(beforeInvalid), 'Invalid Settings input changed authoritative state');
    options.assert(exactJson(beforeInvalid) === exactJson(initial), 'Settings controls did not restore their initial state');
    return { schemaVersion: 1, controls: evidence, invalid: { key: 'requestTimeoutMs', fresh: feedback.fresh, unchanged: true }, restored: true,
      scope: 'Real packaged DOM controls and authoritative preload readback; CDP-dispatched events are not native text input or restart persistence.' };
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    let instrumentationCleanupError = null;
    try {
      const cleaned = await options.cdp.evaluate(`(() => { /*settings-controls:cleanup-instrumentation*/
        const nodes = [...document.querySelectorAll('[data-settings-controls-owner]')];
        if (nodes.some((node) => node.dataset.settingsControlsOwner !== ${JSON.stringify(instrumentationToken)})) return false;
        for (const node of nodes) delete node.dataset.settingsControlsOwner;
        return !document.querySelector('[data-settings-controls-owner]');
      })()`);
      if (!cleaned) throw new Error('Settings instrumentation ownership cleanup failed');
    } catch (error) { instrumentationCleanupError = error; }
    let settingsCleanupError = null;
    try {
      if (ownedKeys.size && exactJson(await settings(options.cdp)) !== exactJson(initial)) {
        await route(options);
        for (const [label, key, kind] of CONTROL_CASES) {
          if (!ownedKeys.has(key)) continue;
          const current = await settings(options.cdp);
          if (current[key] !== initial[key]) {
            const changed = await setControl(options, label, kind, initial[key]);
            options.assert(changed?.ok === true, `${label} cleanup control was not reachable exactly once`);
            const expected = key === 'privacyMode' ? privacyDerived(initial.privacyMode) : { [key]: initial[key] };
            await options.poll(() => settings(options.cdp), (value) => Object.entries(expected).every(([itemKey, itemValue]) => value[itemKey] === itemValue),
              undefined, `${label} cleanup authoritative update`);
            const authoritative = await settings(options.cdp);
            await options.poll(() => renderedMatches(options, authoritative), Boolean, undefined, `${label} cleanup rendered update`);
          }
        }
      }
      await options.poll(() => settings(options.cdp), (restored) => exactJson(restored) === exactJson(initial), undefined,
        'Settings control cleanup did not restore initial state');
      await options.poll(() => renderedMatches(options, initial), Boolean, undefined, 'Settings rendered cleanup restoration');
    } catch (error) { settingsCleanupError = error; }
    if (settingsCleanupError || instrumentationCleanupError) {
      const cleanupError = settingsCleanupError ?? instrumentationCleanupError;
      const cleanupEvidence = {
        cleanupError: String(cleanupError.message).slice(0, 1024),
        settingsCleanupError: settingsCleanupError ? String(settingsCleanupError.message).slice(0, 1024) : null,
        instrumentationCleanupError: instrumentationCleanupError ? String(instrumentationCleanupError.message).slice(0, 1024) : null,
        ownedSettingsKeys: [...ownedKeys].sort()
      };
      if (primaryFailure) primaryFailure.evidence = { ...(primaryFailure.evidence ?? {}), ...cleanupEvidence };
      else { cleanupError.evidence = cleanupEvidence; throw cleanupError; }
    }
  }
}

export { CONTROL_CASES };
