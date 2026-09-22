import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNodeSetup } from '../src/renderer/node-setup.js';
import { defaultNodeSetupDraft, buildNodeSetupPlan } from '../src/main/node-setup-plan.js';
import { CORE_SNAPSHOT_BASES, SNAPSHOT_GUIDE_URL } from '../src/shared/node-snapshot.js';

// Bounded DOM collaborator: real view handlers, not native visual/layout proof.
class TestNode {
  constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this._text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.value = ''; this.disabled = false; }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(k, f) { this.listeners[k] = f; }
  click() { return this.listeners.click?.({ currentTarget: this }); }
  querySelectorAll(selector) { const match = n => selector.startsWith('.') ? (n.className ?? '').split(' ').includes(selector.slice(1)) : n.tagName === selector.toUpperCase(); return this.children.flatMap(n => [...(match(n) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const tick = () => new Promise(resolve => setImmediate(resolve));
const button = (root, label) => root.querySelectorAll('button').find(n => n.textContent === label || n.querySelector('strong')?.textContent === label);
const draft = () => {
  const d = defaultNodeSetupDraft({ rootDirectory: '/fixture/nodes' }); d.choice = 'core'; d.core.executable = '/fixture/core'; return d;
};
function fixture(handler, saved = null) {
  const calls = [], external = [];
  const root = renderNodeSetup({ model: { activeTabId: 'tab' }, navigate() {}, openExternal: url => external.push(url), nodeSetup: async (action, value) => {
    calls.push([action, value]);
    if (action === 'inspect') return { defaults: draft(), saved, detected: {}, catalog: {} };
    return handler(action, value);
  } });
  return { root, calls, external };
}
const saved = () => { const d = draft(); d.core.storage = 'pruned'; d.core.sync = 'snapshot'; return { id: 'saved', plan: { draft: d } }; };

test('compact choices are prominent and quick start reaches the real plan without starting or importing', async t => {
  let plan;
  const f = fixture(async (action, value) => { assert.equal(action, 'preview'); plan = buildNodeSetupPlan(value.draft); return { ...plan, token: 'preview', warnings: [], disk: null }; });
  t.after(() => f.root.dispose());
  await tick(); await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click();
  for (const label of ['Compact node', 'Quick-start compact node', 'Complete archive']) assert.ok(button(f.root, label));
  const quick = button(f.root, 'Quick-start compact node');
  let parent = quick; while (parent) { assert.notEqual(parent.tagName, 'DETAILS'); parent = parent.parentElement; }
  quick.click(); assert.match(f.root.textContent, /separately obtained snapshot|uncompressed UTXO snapshot/);
  assert.equal(f.external.length, 0); button(f.root, 'How to obtain a snapshot').click(); assert.deepEqual(f.external, [SNAPSHOT_GUIDE_URL]);
  await button(f.root, 'Continue').click(); assert.equal(plan.draft.core.sync, 'snapshot'); assert.equal(plan.draft.core.storage, 'pruned');
  assert.deepEqual(f.calls.map(c => c[0]), ['inspect', 'preview']); assert.match(f.root.textContent, /separate, confirmed action/); f.root.dispose();
});

test('changing network clears unsupported quick-start intent while preserving compact storage', async t => {
  let plan;
  const f = fixture(async (_action, value) => { plan = buildNodeSetupPlan(value.draft); return { ...plan, token: 'preview', warnings: [] }; });
  t.after(() => f.root.dispose());
  await tick(); await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click(); button(f.root, 'Quick-start compact node').click();
  const network = f.root.querySelector('select'); network.value = 'signet'; network.listeners.change({ currentTarget: network });
  assert.equal(button(f.root, 'Quick-start compact node'), undefined); assert.match(f.root.textContent, /mainnet with Core 31/);
  await button(f.root, 'Continue').click(); assert.equal(plan.draft.core.sync, undefined); assert.equal(plan.draft.core.storage, 'pruned'); f.root.dispose();
});

test('choosing managed Ord restores archive and keeps compact choices out of its dependency path', async t => {
  const f = fixture(async () => null); t.after(() => f.root.dispose()); await tick();
  button(f.root, 'Bitcoin Core + Ord').click(); await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click();
  assert.ok(button(f.root, 'Complete archive')); assert.equal(button(f.root, 'Quick-start compact node'), undefined); assert.equal(button(f.root, 'Compact node'), undefined);
  assert.match(f.root.textContent, /Managed Ord needs complete history/); f.root.dispose();
});

test('resumed quick-start workflow explicitly selects and imports once and keeps stop available', async t => {
  const f = fixture(async action => {
    if (action === 'snapshot-select') return { selection: { token: 'selected', name: '<img onerror=bad>.dat', bytes: 52, baseHeight: CORE_SNAPSHOT_BASES[0].height, message: 'Header recognized only' } };
    if (action === 'snapshot-load') return { snapshot: { phase: 'loading', message: 'Import in progress' } };
    return null;
  }, saved());
  t.after(() => f.root.dispose());
  await tick(); button(f.root, 'Resume existing setup').click(); assert.equal(f.calls.length, 1);
  await button(f.root, 'Choose snapshot file').click(); assert.equal(f.root.querySelector('img'), null);
  await button(f.root, 'Import snapshot').click();
  assert.deepEqual(f.calls.filter(c => c[0] === 'snapshot-load')[0][1], { setupId: 'saved', token: 'selected' });
  assert.equal(button(f.root, 'Import snapshot'), undefined); assert.equal(button(f.root, 'Start services').disabled, true);
  assert.equal(button(f.root, 'Stop managed services').disabled, false);
  assert.match(f.root.textContent, /does not stop Core/); f.root.dispose();
});

test('current but historically unvalidated status is shown separately from complete validation', async t => {
  let validated = false;
  const f = fixture(async () => ({ core: { phase: validated ? 'ready' : 'current-validating', current: true, historicalValidated: validated, backgroundBlocks: validated ? null : 600000 }, snapshot: { phase: validated ? 'validated' : 'validating' } }), saved());
  t.after(() => f.root.dispose());
  await tick(); button(f.root, 'Resume existing setup').click(); await button(f.root, 'Refresh status').click();
  assert.match(f.root.textContent, /Current with networkYesHistorical validationNot complete/); assert.match(f.root.textContent, /600,000/);
  assert.equal(button(f.root, 'Import snapshot'), undefined);
  validated = true; await button(f.root, 'Refresh status').click(); assert.match(f.root.textContent, /Historical validationComplete/); f.root.dispose();
});

test('late pre-import status cannot overwrite loading and navigation disposal does not dispatch cancellation or replay', async t => {
  let release;
  const f = fixture(async action => {
    if (action === 'status') return new Promise(resolve => { release = resolve; });
    if (action === 'snapshot-select') return { selection: { token: 'selected', name: 'snapshot.dat', bytes: 52, baseHeight: 935000 } };
    if (action === 'snapshot-load') return { snapshot: { phase: 'loading', message: 'Import in progress' } };
    return null;
  }, saved());
  t.after(() => f.root.dispose());
  await tick(); button(f.root, 'Resume existing setup').click(); const status = button(f.root, 'Refresh status').click();
  await button(f.root, 'Choose snapshot file').click(); await button(f.root, 'Import snapshot').click();
  release({ core: { phase: 'ready', current: true, historicalValidated: true }, snapshot: { phase: 'validated' } }); await status;
  assert.match(f.root.textContent, /Import in progress/); assert.doesNotMatch(f.root.textContent, /Historical validationComplete/);
  const count = f.calls.length; f.root.dispose(); await tick(); assert.equal(f.calls.length, count);
});
