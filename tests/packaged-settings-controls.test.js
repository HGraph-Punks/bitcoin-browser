import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_CASES, runPackagedSettingsControlChecks } from '../scripts/packaged-settings-controls.mjs';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { validateSettingsPatch } from '../src/shared/validation.js';

function fixture({ noOpLabel = null, rejectLabel = null, cleanupFailure = false, providers = [], cacheEntries = 0, historyCount = 0,
  staleRenderedOnRestore = false, instrumentationCleanupFailure = false, invalidInstallThrows = false, invalidInstallLost = false,
  rejectAfterMutation = false, initialSettings = DEFAULT_SETTINGS } = {}) {
  const state = { settings: structuredClone(initialSettings) };
  const rendered = structuredClone(initialSettings);
  const initial = structuredClone(initialSettings);
  const calls = [];
  let updateCount = 0;
  let instrumentationInstalled = false;
  let primaryTriggered = false;
  const cdp = { async evaluate(expression) {
    if (expression.startsWith('Promise.all([')) return { settings: structuredClone(state.settings), historyCount,
      providers: structuredClone(providers), cache: { entries: cacheEntries } };
    if (expression === 'window.satBrowser.app.bootstrap().then((value) => value.state.settings)') return structuredClone(state.settings);
    if (expression.includes('settings-controls:route')) { calls.push('route'); return true; }
    if (expression.includes("#page h1")) return 'Settings';
    if (expression.includes("querySelectorAll('#page [aria-label]')") && expression.includes('.map(')) return CONTROL_CASES.map(([label]) => label).sort();
    if (expression.includes('settings-controls:set')) {
      const label = JSON.parse(expression.match(/const label = ("(?:[^"\\]|\\.)*")/)[1]);
      const kind = JSON.parse(expression.match(/const kind = ("(?:[^"\\]|\\.)*")/)[1]);
      const value = JSON.parse(expression.match(/const value = ([^;]+);/)[1]);
      calls.push(`set:${label}`);
      const [, key] = CONTROL_CASES.find(([candidate]) => candidate === label);
      const isRestoration = value === initial[key] && state.settings[key] !== initial[key];
      const shouldReject = label === rejectLabel && !primaryTriggered;
      if (shouldReject && !rejectAfterMutation) primaryTriggered = true;
      if ((shouldReject && !rejectAfterMutation) || (cleanupFailure && primaryTriggered && isRestoration)) {
        throw new Error(cleanupFailure ? 'fixture cleanup failed' : `fixture rejected ${label}`);
      }
      if (label !== noOpLabel) {
        const patch = validateSettingsPatch({ [key]: value });
        Object.assign(state.settings, patch);
        Object.assign(rendered, patch);
      }
      if (shouldReject && rejectAfterMutation) { primaryTriggered = true; throw new Error(`fixture rejected ${label}`); }
      return { ok: true, tag: kind === 'switch' ? 'BUTTON' : kind === 'number' ? 'INPUT' : 'SELECT' };
    }
    if (expression.includes('settings-controls:rendered-state')) return !staleRenderedOnRestore && JSON.stringify(rendered) === JSON.stringify(state.settings);
    if (expression.includes('settings-controls:invalid-number')) {
      calls.push('invalid');
      if (invalidInstallThrows) throw new Error('instrumentation install failed');
      if (invalidInstallLost) return false;
      instrumentationInstalled = true;
      return { installed: true, markedPrevious: true };
    }
    if (expression.includes('settings-controls:invalid-feedback')) return { fresh: true, text: 'Could not update settings Request timeout must be between bounds' };
    if (expression.includes('settings-controls:cleanup-instrumentation')) {
      calls.push('cleanup-instrumentation');
      if (instrumentationCleanupFailure) return false;
      instrumentationInstalled = false;
      return true;
    }
    if (expression.startsWith('window.satBrowser.settings.update(')) {
      updateCount += 1;
      const patch = JSON.parse(expression.match(/update\((.*)\)$/s)[1]);
      if (cleanupFailure && Object.keys(patch).length > 3) throw new Error('fixture cleanup failed');
      Object.assign(state.settings, validateSettingsPatch(patch)); calls.push(`restore:${Object.keys(patch).join(',')}`); return structuredClone(state.settings);
    }
    throw new Error(`Unexpected evaluation: ${expression.slice(0, 100)}`);
  } };
  return { state, rendered, calls, options: { cdp, assert: (condition, message) => assert.ok(condition, message),
    poll: async (action, predicate, _timeout, label) => { const value = await action(); assert.ok(predicate(value), label); return value; } },
    get updateCount() { return updateCount; }, get instrumentationInstalled() { return instrumentationInstalled; } };
}

test('packaged Settings helper drives all fourteen controls, rejects invalid timeout, and restores exact state', async () => {
  const f = fixture(); const initial = structuredClone(f.state.settings);
  const result = await runPackagedSettingsControlChecks(f.options);
  assert.equal(result.controls.length, 14);
  assert.deepEqual(result.controls.map(({ label }) => label), CONTROL_CASES.map(([label]) => label));
  assert.deepEqual(result.invalid, { key: 'requestTimeoutMs', fresh: true, unchanged: true });
  assert.equal(result.restored, true);
  assert.deepEqual(f.state.settings, initial);
  assert.deepEqual(f.rendered, initial);
  assert.equal(f.calls.filter((call) => call.startsWith('set:')).length, 28);
  assert.equal(f.instrumentationInstalled, false);
});

test('empty provider/cache/history baseline is required before any route mutation', async () => {
  for (const variant of [{ providers: [{}] }, { cacheEntries: 1 }, { historyCount: 1 }]) {
    const f = fixture(variant);
    await assert.rejects(runPackagedSettingsControlChecks(f.options), /empty provider, cache, and history/);
    assert.deepEqual(f.calls, []);
  }
});

test('a no-op real control cannot pass authoritative polling', async () => {
  const f = fixture({ noOpLabel: 'Theme' });
  await assert.rejects(runPackagedSettingsControlChecks(f.options));
  assert.deepEqual(f.state.settings, DEFAULT_SETTINGS);
});

test('control rejection preserves the primary error and restores only owned fields', async () => {
  const f = fixture({ rejectLabel: 'Offline mode' });
  await assert.rejects(runPackagedSettingsControlChecks(f.options), /fixture rejected Offline mode/);
  assert.deepEqual(f.state.settings, DEFAULT_SETTINGS);
  assert.ok(f.calls.includes('cleanup-instrumentation'));
});

test('cleanup failure is attached to the primary control failure', async () => {
  const f = fixture({ rejectLabel: 'Request timeout', rejectAfterMutation: true, cleanupFailure: true });
  await assert.rejects(runPackagedSettingsControlChecks(f.options), (error) => {
    assert.equal(error.message, 'fixture rejected Request timeout');
    assert.equal(error.evidence.cleanupError, 'fixture cleanup failed');
    return true;
  });
});

test('renderer publication must match authoritative update before inverse control action', async () => {
  const f = fixture({ staleRenderedOnRestore: true });
  await assert.rejects(runPackagedSettingsControlChecks(f.options), /rendered update/);
  assert.deepEqual(f.state.settings, DEFAULT_SETTINGS);
  assert.deepEqual(f.rendered, DEFAULT_SETTINGS);
});

test('settings and instrumentation cleanup failures are both retained', async () => {
  const f = fixture({ rejectLabel: 'Request timeout', rejectAfterMutation: true, cleanupFailure: true, instrumentationCleanupFailure: true });
  await assert.rejects(runPackagedSettingsControlChecks(f.options), (error) => {
    assert.equal(error.message, 'fixture rejected Request timeout');
    assert.equal(error.evidence.settingsCleanupError, 'fixture cleanup failed');
    assert.equal(error.evidence.instrumentationCleanupError, 'Settings instrumentation ownership cleanup failed');
    return true;
  });
});

test('privacy cleanup restores valid manual overrides after profile-derived settlement', async () => {
  const initialSettings = { ...DEFAULT_SETTINGS, privacyMode: 'strict', localOnly: false, contentNetworkPolicy: 'https-only' };
  const f = fixture({ initialSettings, rejectLabel: 'Privacy profile', rejectAfterMutation: true });
  await assert.rejects(runPackagedSettingsControlChecks(f.options), /fixture rejected Privacy profile/);
  assert.deepEqual(f.state.settings, initialSettings);
  assert.deepEqual(f.rendered, initialSettings);
  assert.equal(f.instrumentationInstalled, false);
  assert.ok(f.calls.includes('set:Local only'));
  assert.ok(f.calls.includes('set:Content network policy'));
});

test('instrumentation cleanup failure cannot pass and retains explicit evidence', async () => {
  const f = fixture({ instrumentationCleanupFailure: true });
  await assert.rejects(runPackagedSettingsControlChecks(f.options), (error) => {
    assert.equal(error.message, 'Settings instrumentation ownership cleanup failed');
    assert.equal(error.evidence.cleanupError, 'Settings instrumentation ownership cleanup failed');
    return true;
  });
  assert.equal(f.instrumentationInstalled, true);
});

test('thrown or lost feedback instrumentation installation fails and cleanup still runs', async () => {
  for (const variant of [{ invalidInstallThrows: true }, { invalidInstallLost: true }]) {
    const f = fixture(variant);
    await assert.rejects(runPackagedSettingsControlChecks(f.options), /instrumentation install failed|instrumentation or control was not reachable/);
    assert.ok(f.calls.includes('cleanup-instrumentation'));
    assert.equal(f.instrumentationInstalled, false);
    assert.deepEqual(f.state.settings, DEFAULT_SETTINGS);
    assert.deepEqual(f.rendered, DEFAULT_SETTINGS);
  }
});
