import test from 'node:test';
import assert from 'node:assert/strict';
import { runPackagedSettingsNavigationChecks } from '../scripts/packaged-settings-navigation-checks.mjs';

const sections = ['general', 'privacy', 'recursion', 'storage', 'developer'];
function fixture({ failSnapshot = false, failRestore = false, wrongMotion = false, lostInstallResponse = false } = {}) {
  const calls = [];
  let reduced = false;
  let id;
  let count = 0;
  const cdp = {
    async send(method, params) {
      calls.push(method);
      if (method === 'Emulation.setEmulatedMedia') reduced = params.features[0]?.value === 'reduce';
    },
    async evaluate(expression) {
      for (const name of ['route', 'install', 'prepare', 'snapshot', 'restore']) {
        if (!expression.includes(`settings-nav:${name}`)) continue;
        calls.push(name);
        if (name === 'route') return true;
        if (name === 'install') {
          if (lostInstallResponse) throw new Error('fixture install response lost after mutation');
          return sections.map((section) => ({ id: `settings-${section}`, type: 'button',
            headingId: `settings-${section}-heading`, tabIndex: -1, named: true, falselyActive: false }));
        }
        if (name === 'prepare') {
          id = JSON.parse(expression.match(/const id = ("[^"]+");/)[1]);
          count += 1;
          return { focused: true, reduced, x: 100, y: 100 };
        }
        if (name === 'snapshot') {
          if (failSnapshot) throw new Error('fixture CDP failure');
          return { count, overflow: false, focus: `${id}-heading`, visible: true,
            last: { target: id, focus: `${id}-heading`, behavior: wrongMotion ? 'smooth' : reduced ? 'instant' : 'smooth', immediateVisible: true } };
        }
        if (name === 'restore') { if (failRestore) throw new Error('fixture cleanup failure'); return undefined; }
      }
      if (expression.includes("#page h1")) return 'Settings';
      if (expression.includes("closest('.settings-group')")) return true;
      throw new Error(`Unexpected fixture evaluation: ${expression.slice(0, 80)}`);
    }
  };
  return { calls, options: { cdp, assert: (condition, message) => assert.ok(condition, message),
    poll: async (action, predicate) => { const value = await action(); assert.ok(predicate(value)); return value; } } };
}

test('Settings packaged orchestration covers all targets, pointer/Enter/Space/Tab and live preference reversal', async () => {
  const f = fixture();
  const result = await runPackagedSettingsNavigationChecks(f.options);
  assert.equal(result.activations.length, 11);
  assert.deepEqual(result.activations.slice(0, 5).map((item) => item.section), sections);
  assert.ok(result.activations.slice(0, 5).every((item) => item.reduced && item.input === 'pointer'));
  assert.deepEqual(result.activations.slice(5, 10).map((item) => item.input), ['Enter', 'Space', 'Enter', 'Space', 'Enter']);
  assert.equal(result.activations[10].reduced, true);
  assert.equal(f.calls.filter((name) => name === 'Input.dispatchMouseEvent').length, 12);
  assert.equal(f.calls.filter((name) => name === 'Input.dispatchKeyEvent').length, 32);
  assert.deepEqual(f.calls.slice(-3), ['restore', 'Emulation.setEmulatedMedia', 'Emulation.clearDeviceMetricsOverride']);
});

test('Settings packaged check rejects a smooth-scroll result under reduced motion and restores test overrides', async () => {
  const f = fixture({ wrongMotion: true });
  await assert.rejects(runPackagedSettingsNavigationChecks(f.options), /ignored the current motion preference/);
  assert.deepEqual(f.calls.slice(-3), ['restore', 'Emulation.setEmulatedMedia', 'Emulation.clearDeviceMetricsOverride']);
});

test('Settings packaged CDP failures keep evidence and restore prototype/media/viewport overrides', async () => {
  const f = fixture({ failSnapshot: true });
  await assert.rejects(runPackagedSettingsNavigationChecks(f.options), (error) => error.message === 'fixture CDP failure' && error.evidence.activations.length === 0);
  assert.deepEqual(f.calls.slice(-3), ['restore', 'Emulation.setEmulatedMedia', 'Emulation.clearDeviceMetricsOverride']);
});

test('Settings prototype cleanup failure is visible while media and viewport cleanup still run', async () => {
  const f = fixture({ failRestore: true });
  await assert.rejects(runPackagedSettingsNavigationChecks(f.options), /fixture cleanup failure/);
  assert.deepEqual(f.calls.slice(-3), ['restore', 'Emulation.setEmulatedMedia', 'Emulation.clearDeviceMetricsOverride']);
});

test('Settings cleanup probes renderer ownership even when the install response is lost', async () => {
  const f = fixture({ lostInstallResponse: true });
  await assert.rejects(runPackagedSettingsNavigationChecks(f.options), /install response lost after mutation/);
  assert.deepEqual(f.calls.slice(-3), ['restore', 'Emulation.setEmulatedMedia', 'Emulation.clearDeviceMetricsOverride']);
});

test('Settings functional and cleanup failures are both preserved', async () => {
  const f = fixture({ failSnapshot: true, failRestore: true });
  await assert.rejects(runPackagedSettingsNavigationChecks(f.options), (error) => {
    assert.equal(error.message, 'fixture CDP failure');
    assert.equal(error.evidence.activations.length, 0);
    assert.deepEqual(error.evidence.cleanupErrors, [{ phase: 'prototype', message: 'fixture cleanup failure' }]);
    return true;
  });
  assert.deepEqual(f.calls.slice(-3), ['restore', 'Emulation.setEmulatedMedia', 'Emulation.clearDeviceMetricsOverride']);
});
