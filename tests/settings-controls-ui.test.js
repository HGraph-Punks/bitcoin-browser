import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import { validateSettingsPatch } from '../src/shared/validation.js';

const source = fs.readFileSync(new URL('../src/renderer/views.js', import.meta.url), 'utf8');
const toggleStart = source.indexOf('function toggleControl(');
const toggleEnd = source.indexOf('\nexport function updateProviderHealthViews(', toggleStart);
const settingsStart = source.indexOf('function settingRow(');
const settingsEnd = source.indexOf('\nexport function renderWallet(', settingsStart);
assert.ok(toggleStart >= 0 && toggleEnd > toggleStart && settingsStart >= 0 && settingsEnd > settingsStart);
const cacheStart = source.indexOf('function cacheDisplayValue(');
const cacheEnd = source.indexOf('\nexport function updateCacheViews(', cacheStart);
assert.ok(cacheStart >= 0 && cacheEnd > cacheStart);

// Execute the real view, select/number/switch handlers and shared validator.
// This virtual-tree collaborator does not emulate native input, persistence,
// layout or Electron; those remain separate packaged/native requirements.
function fixture(settings = DEFAULT_SETTINGS) {
  const effects = [];
  const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat(Infinity) });
  const render = vm.runInNewContext(`(() => {
    ${source.slice(cacheStart, cacheEnd)}
    ${source.slice(toggleStart, toggleEnd)}
    ${source.slice(settingsStart, settingsEnd).replace('export function renderSettings', 'function renderSettings')}
    return renderSettings;
  })()`, {
    h, button: (label, attrs = {}) => h('button', attrs, label),
    pageHeader: (_category, title, _description, actions) => h('header', {}, title, actions),
    badge: (text) => h('span', {}, text), formatBytes: () => '0 B'
  });
  const context = {
    updateSettings: (patch) => { effects.push({ kind: 'update', patch: { ...patch } }); return validateSettingsPatch(patch); },
    exportDiagnostics: () => effects.push({ kind: 'export' }),
    clearCache: () => effects.push({ kind: 'clear' }),
    revealPath: (path) => effects.push({ kind: 'reveal', path })
  };
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    node.children.forEach(visit);
  };
  visit(render({ settings: { ...settings }, cache: { bytes: 0 } }, context));
  return {
    effects, nodes,
    control(label) {
      const found = nodes.filter((node) => node.attrs.ariaLabel === label);
      assert.equal(found.length, 1, `one reachable control named ${label}`);
      return found[0];
    },
    action(label) {
      const found = nodes.filter((node) => node.tag === 'button' && node.children[0] === label);
      assert.equal(found.length, 1, `one action named ${label}`);
      return found[0];
    }
  };
}

const selectCases = [
  ['Bitcoin network', 'network', ['mainnet', 'testnet', 'signet', 'regtest']],
  ['Theme', 'theme', ['system', 'dark', 'light']],
  ['Privacy profile', 'privacyMode', ['strict', 'balanced', 'compatible']],
  ['Content network policy', 'contentNetworkPolicy', ['blocked', 'https-only']],
  ['Cache capacity', 'cacheMaxBytes', [268435456, 1073741824, 5368709120, 21474836480]],
  ['Maximum resource size', 'maxResourceBytes', [16777216, 67108864, 268435456, 1073741824]]
];
const numberCases = [
  ['Maximum recursion depth', 'maxRecursionDepth', 1, 128, 1],
  ['Maximum recursion nodes', 'maxRecursionNodes', 1, 10000, 1],
  ['Concurrent requests', 'maxConcurrentContentRequests', 1, 64, 1],
  ['Request timeout', 'requestTimeoutMs', 1000, 120000, 1000]
];
const switchCases = [
  ['Restore tabs', 'restoreSession'], ['Local only', 'localOnly'],
  ['Offline mode', 'offlineMode'], ['Developer mode', 'developerMode']
];

test('Settings has exactly the intended fourteen editable controls and no telemetry switch', () => {
  const f = fixture();
  const controls = f.nodes.filter((node) => node.tag === 'select' || node.tag === 'input' || node.attrs.role === 'switch');
  assert.deepEqual(controls.map((node) => node.attrs.ariaLabel).sort(),
    [...selectCases, ...numberCases, ...switchCases].map(([label]) => label).sort());
  assert.equal(controls.length, 14);
  assert.ok(f.nodes.some((node) => node.children.includes('NOT INCLUDED')));
  assert.ok(f.nodes.some((node) => node.children.includes('No analytics or telemetry transport is included in this beta build.')));
  assert.deepEqual(f.effects, [], 'rendering must not commit settings');
});

for (const [label, key, values] of selectCases) {
  test(`${label} exposes the exact options and forwards typed values to the matching setting`, () => {
    for (const value of values) {
      const initial = { ...DEFAULT_SETTINGS, [key]: value };
      const f = fixture(initial);
      const control = f.control(label);
      assert.equal(control.tag, 'select');
      assert.deepEqual(control.children.map((node) => String(node.attrs.value)), values.map(String));
      assert.equal(String(control.attrs.value), String(value));
      assert.deepEqual(control.children.filter((node) => node.attrs.selected).map((node) => String(node.attrs.value)), [String(value)]);
      const result = control.attrs.onChange({ currentTarget: { value: String(value) } });
      assert.deepEqual(f.effects, [{ kind: 'update', patch: { [key]: value } }]);
      const expected = key !== 'privacyMode' ? { [key]: value }
        : { privacyMode: value, localOnly: value === 'strict', contentNetworkPolicy: value === 'compatible' ? 'https-only' : 'blocked' };
      assert.deepEqual({ ...result }, expected);
      assert.deepEqual(initial, { ...DEFAULT_SETTINGS, [key]: value }, 'view handlers must not mutate their settings snapshot');
    }
  });
}

for (const [label, key, min, max, step] of numberCases) {
  test(`${label} retains exact numeric bounds and rejects invalid values through the real validator`, () => {
    const f = fixture();
    const control = f.control(label);
    assert.equal(control.tag, 'input');
    assert.equal(control.attrs.type, 'number');
    assert.deepEqual([control.attrs.min, control.attrs.max, control.attrs.step], [min, max, step]);
    assert.equal(control.attrs.value, DEFAULT_SETTINGS[key]);
    for (const value of [min, max]) {
      assert.deepEqual({ ...control.attrs.onChange({ currentTarget: { value: String(value) } }) }, { [key]: value });
      assert.deepEqual(f.effects.at(-1), { kind: 'update', patch: { [key]: value } });
    }
    for (const value of [min - 1, max + 1, min + 0.5, '', 'NaN', 'Infinity']) {
      assert.throws(() => control.attrs.onChange({ currentTarget: { value: String(value) } }),
        (error) => error.code === 'VALIDATION_ERROR' && error.status === 400, `${label} must reject ${JSON.stringify(value)}`);
    }
  });
}

for (const [label, key] of switchCases) {
  test(`${label} announces its actual state and toggles only its own boolean setting`, () => {
    for (const value of [false, true]) {
      const f = fixture({ ...DEFAULT_SETTINGS, [key]: value });
      const control = f.control(label);
      assert.equal(control.tag, 'button');
      assert.equal(control.attrs.type, 'button');
      assert.equal(control.attrs.role, 'switch');
      assert.equal(control.attrs['aria-checked'], String(value));
      assert.equal(control.attrs.className, value ? 'toggle on' : 'toggle');
      assert.deepEqual({ ...control.attrs.onClick() }, { [key]: !value });
      assert.deepEqual(f.effects, [{ kind: 'update', patch: { [key]: !value } }]);
    }
  });
}

test('Settings export, clear and reveal actions route to their exact collaborators without committing settings', () => {
  const f = fixture();
  for (const label of ['Export diagnostics', 'Clear content cache', 'Reveal data', 'Reveal logs']) f.action(label).attrs.onClick();
  assert.deepEqual(f.effects, [{ kind: 'export' }, { kind: 'clear' }, { kind: 'reveal', path: 'data' }, { kind: 'reveal', path: 'logs' }]);
});
