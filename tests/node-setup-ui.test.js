import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';

class TestNode {
  constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this._text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {}; this.value = ''; this.checked = false; this.disabled = false; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  click() { return this.listeners.click?.({ currentTarget: this }); }
  querySelectorAll(selector) {
    const match = node => selector.startsWith('.') ? String(node.className ?? '').split(/\s+/).includes(selector.slice(1))
      : selector.startsWith('[') ? Object.hasOwn(node.attributes, selector.slice(1, -1)) : node.tagName === selector.toUpperCase();
    return this.children.flatMap(node => [...(match(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
const { renderNodeSetup } = await import('../src/renderer/node-setup.js');

const easyRecommendation = () => ({ rootDirectory: '/fixture/nodes', eligible: true, reasons: [], version: '31.1',
  availableBytes: 100 * 1024 ** 3, memoryBytes: 8 * 1024 ** 3, logicalCpus: 8, dbCacheMiB: 512, validationThreads: 4, archiveFits: false });
const easyInspection = easy => ({ defaults: defaultNodeSetupDraft({ rootDirectory: '/fixture/nodes' }), catalog: {}, detected: {}, easy: easy ?? easyRecommendation() });

const tick = () => new Promise(resolve => setImmediate(resolve));
const button = (root, label) => root.querySelectorAll('button').find(node => node.textContent === label
  || node.querySelectorAll('strong').some(strong => strong.textContent === label));
function fixture(handler = async () => null) {
  const calls = []; const navigation = []; const external = [];
  const root = renderNodeSetup({
    model: { activeTabId: 'tab-owned' }, navigate: value => navigation.push(value), openExternal: value => external.push(value),
    nodeSetup: async (action, payload) => { calls.push([action, structuredClone(payload)]); return handler(action, payload); }
  });
  return { root, calls, navigation, external };
}

test('mount performs only readonly inspection and exposes owner, five stages, and advanced routes', async () => {
  const f = fixture(async action => action === 'inspect' ? { defaults: {}, catalog: { core: null, ord: null }, detected: { core: [], ord: [] }, saved: null } : assert.fail(action));
  assert.equal(f.root.className, 'node-setup'); assert.equal(f.root.dataset.owner, 'tab-owned');
  await tick(); assert.deepEqual(f.calls.map(([action]) => action), ['inspect']);
  assert.equal(f.root.querySelectorAll('li').length, 5);
  button(f.root, 'Advanced local services').click(); button(f.root, 'Advanced data sources').click();
  assert.deepEqual(f.navigation, ['satnav://services', 'satnav://providers']); f.root.dispose();
});

test('capacity-aware front door makes one recommendation without downloads or configuration on mount', async () => {
  const f = fixture(async action => action === 'inspect' ? easyInspection() : assert.fail(action)); await tick();
  assert.equal(f.root.dataset.step, 'recommended'); assert.ok(button(f.root, 'Set up Bitcoin Core'));
  assert.equal(button(f.root, 'Set up Bitcoin Core').disabled, false);
  assert.match(f.root.textContent, /100 GiB/); assert.match(f.root.textContent, /8 GiB/);
  assert.match(f.root.textContent, /No hardware profile is uploaded/); assert.match(f.root.textContent, /hundreds of gigabytes/);
  assert.match(f.root.textContent, /Total storage can grow/); assert.match(f.root.textContent, /not mining/);
  assert.equal(f.root.querySelectorAll('progress').length, 0); assert.equal(f.root.querySelectorAll('input')[0].checked, false);
  assert.ok(f.root.textContent.indexOf('Set up Bitcoin Core') < f.root.textContent.indexOf('Start with 30 GiB free.'));
  assert.deepEqual(f.calls.map(([action]) => action), ['inspect']);
  button(f.root, 'Not now').click(); assert.deepEqual(f.navigation, ['satnav://home']); f.root.dispose();
});

test('customize preserves all four workflow choices, software modes and advanced routes', async () => {
  const f = fixture(async action => action === 'inspect' ? easyInspection() : null); await tick();
  button(f.root, 'Customize setup').click();
  for (const label of ['Bitcoin Core + Ord', 'Bitcoin Core only', 'Ord only', 'Not now', 'Advanced local services', 'Advanced data sources']) assert.ok(button(f.root, label), label);
  await button(f.root, 'Continue').click(); assert.ok(button(f.root, 'Choose installed program')); assert.ok(button(f.root, 'Use running service'));
  assert.deepEqual(f.calls.map(([action]) => action), ['inspect']); f.root.dispose();
});

test('unavailable capacity blocks easy setup with clear recovery and does not display unknown as zero', async () => {
  const r = { ...easyRecommendation(), eligible: false, availableBytes: null, memoryBytes: null, reasons: ['Choose an accessible drive.'] };
  const f = fixture(async action => action === 'inspect' ? easyInspection(r) : null); await tick();
  assert.equal(button(f.root, 'Set up Bitcoin Core').disabled, true); await button(f.root, 'Set up Bitcoin Core').click();
  assert.match(f.root.textContent, /Not available/); assert.doesNotMatch(f.root.querySelector('.easy-node-capacity').textContent, /0 GiB/);
  assert.match(f.root.textContent, /Choose an accessible drive/); assert.ok(button(f.root, 'Change folder')); assert.ok(button(f.root, 'Customize setup'));
  assert.deepEqual(f.calls.map(([action]) => action), ['inspect']); f.root.dispose();
});

test('folder changes recheck the selected drive and cancelled pickers preserve the prior recommendation', async () => {
  let cancelled = true;
  const f = fixture(async (action, payload) => {
    if (action === 'inspect') return easyInspection();
    if (action === 'pick') return { path: cancelled ? null : '/other/drive' };
    if (action === 'capacity') return { ...easyRecommendation(), rootDirectory: payload.rootDirectory, availableBytes: 2048 * 1024 ** 3, archiveFits: true };
    assert.fail(action);
  }); await tick();
  await button(f.root, 'Change folder').click(); assert.equal(f.calls.some(([action]) => action === 'capacity'), false);
  assert.match(f.root.textContent, /\/fixture\/nodes/);
  cancelled = false; await button(f.root, 'Change folder').click();
  assert.deepEqual(f.calls.find(([action]) => action === 'capacity')[1], { rootDirectory: '/other/drive' });
  assert.match(f.root.textContent, /\/other\/drive/); assert.match(f.root.textContent, /1 TiB archive/); f.root.dispose();
});

test('one setup click uses the main-owned token, publishes live progress, and keeps stop controls', async () => {
  const d = defaultNodeSetupDraft({ rootDirectory: '/fixture/nodes' }); d.choice = 'core'; d.core.storage = 'pruned'; d.core.executable = '/fixture/bitcoind';
  const f = fixture(async (action, payload) => {
    if (action === 'inspect') return easyInspection();
    if (action === 'easy-preview') { assert.equal(payload.autoStart, true); return { token: 'owned-token' }; }
    if (action === 'easy-start') return { committed: true, setupId: 'saved-core', setup: { plan: { draft: d } }, status: { core: { phase: 'syncing', progress: .25, blocks: 25, headers: 100 } } };
    if (action === 'stop') return { core: { phase: 'stopped' } };
    assert.fail(action);
  }); await tick();
  const checkbox = f.root.querySelectorAll('input')[0]; checkbox.checked = true; checkbox.listeners.change({ currentTarget: checkbox });
  await button(f.root, 'Set up Bitcoin Core').click();
  assert.equal(f.root.dataset.step, '5'); assert.match(f.root.textContent, /first sync can take hours or days/);
  assert.doesNotMatch(f.root.textContent, /Starting services is a separate action/);
  assert.equal(button(f.root, 'Start services').disabled, true); assert.ok(button(f.root, 'Stop managed services'));
  assert.deepEqual(f.calls.find(([action]) => action === 'easy-start')[1], { token: 'owned-token' });
  assert.equal(f.calls.some(([action]) => ['install', 'apply', 'start', 'easy-cancel'].includes(action)), false);
  await button(f.root, 'Stop managed services').click(); assert.equal(button(f.root, 'Start services').disabled, false);
  f.root.dispose();
});

test('download refusal returns an actionable error and never calls separate apply or start', async () => {
  const f = fixture(async action => {
    if (action === 'inspect') return easyInspection();
    if (action === 'easy-preview') return { token: 'token' };
    if (action === 'easy-start') throw new Error('Software download failed. Check the connection and try again.');
    assert.fail(action);
  }); await tick(); await button(f.root, 'Set up Bitcoin Core').click();
  assert.match(f.root.textContent, /Software download failed/); assert.equal(button(f.root, 'Set up Bitcoin Core').disabled, false);
  assert.deepEqual(f.calls.map(([action]) => action), ['inspect', 'easy-preview', 'easy-start']); f.root.dispose();
});

test('leaving while preparation is pending cancels the returned token and never starts the setup', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture(async action => {
    if (action === 'inspect') return easyInspection();
    if (action === 'easy-preview') return held;
    if (action === 'easy-cancel') return { cancelled: true };
    assert.fail(action);
  }); await tick(); const starting = button(f.root, 'Set up Bitcoin Core').click(); f.root.dispose();
  release({ token: 'late-token' }); await starting;
  assert.deepEqual(f.calls.map(([action]) => action), ['inspect', 'easy-preview', 'easy-cancel']);
  assert.equal(f.calls.at(-1)[1].token, 'late-token');
});

test('saved-but-unavailable startup enters existing recovery UI rather than offering reinstall', async () => {
  const f = fixture(async action => {
    if (action === 'inspect') return easyInspection();
    if (action === 'easy-preview') return { token: 'token' };
    if (action === 'easy-start') throw Object.assign(new Error('refresh failed'), { details: { setupCommitted: true, setupId: 'saved-node' } });
    assert.fail(action);
  }); await tick(); await button(f.root, 'Set up Bitcoin Core').click();
  assert.equal(f.root.dataset.step, '5'); assert.match(f.root.textContent, /do not install again/);
  assert.equal(button(f.root, 'Set up Bitcoin Core'), undefined); assert.ok(button(f.root, 'Refresh status')); f.root.dispose();
});

test('a saved or invalid setup never gets an easy reinstall prompt', async () => {
  for (const extra of [{ saved: { id: 'old', plan: { draft: {} } } }, { recovery: 'Definition changed.' }]) {
    const f = fixture(async action => action === 'inspect' ? { ...easyInspection(), ...extra } : null); await tick();
    assert.equal(button(f.root, 'Set up Bitcoin Core'), undefined); assert.ok(button(f.root, 'Advanced local services')); f.root.dispose();
  }
});

test('a slow capacity inspection cannot pull a user out of the existing walkthrough', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture(async action => action === 'inspect' ? held : null);
  await button(f.root, 'Continue').click(); release(easyInspection()); await tick();
  assert.equal(f.root.dataset.step, '2'); assert.equal(button(f.root, 'Set up Bitcoin Core'), undefined); f.root.dispose();
});

test('easy progress updates retain disclosure and control nodes and never invent percentages', async t => {
  const timers = new Set();
  t.mock.method(globalThis, 'setTimeout', callback => { const timer = { callback }; timers.add(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
  let finish; const held = new Promise(resolve => { finish = resolve; }); let stage = 'downloading';
  const f = fixture(async action => {
    if (action === 'inspect') return easyInspection();
    if (action === 'easy-preview') return { token: 'owned' };
    if (action === 'easy-start') return held;
    if (action === 'easy-status') return { phase: stage, canCancel: stage === 'downloading' };
    if (action === 'easy-cancel') return { cancelled: true };
    assert.fail(action);
  }); t.after(() => { f.root.dispose(); finish(null); });
  await tick(); const starting = button(f.root, 'Set up Bitcoin Core').click(); await tick();
  const details = f.root.querySelector('details'), primary = button(f.root, 'Set up Bitcoin Core'), cancel = button(f.root, 'Cancel setup'); details.open = true;
  const fire = async () => { const timer = [...timers][0]; assert.ok(timer); timers.delete(timer); await timer.callback(); };
  await fire(); assert.match(f.root.textContent, /Downloading and verifying/);
  assert.equal(f.root.querySelector('details'), details); assert.equal(details.open, true); assert.equal(button(f.root, 'Cancel setup'), cancel);
  stage = 'saving'; await fire(); assert.match(f.root.textContent, /Saving your dedicated/);
  assert.equal(cancel.hidden, true); assert.equal(cancel.disabled, true); assert.equal(button(f.root, 'Set up Bitcoin Core'), primary);
  assert.match(fs.readFileSync(new URL('../src/renderer/node-setup.css', import.meta.url), 'utf8'), /\.easy-node-setup \[hidden\]\{display:none!important\}/);
  assert.equal(f.root.querySelectorAll('progress').length, 0);
  finish(null); await starting;
});

test('Not now leaves configuration untouched and only navigates Home', async () => {
  const f = fixture(async action => action === 'inspect' ? { saved: null, catalog: {}, detected: {} } : assert.fail(action)); await tick();
  button(f.root, 'Not now').click(); button(f.root, 'Continue browsing').click();
  assert.deepEqual(f.calls.map(([action]) => action), ['inspect']); assert.deepEqual(f.navigation, ['satnav://home']); f.root.dispose();
});

test('select options retain explicit selected state after children are appended and repeated renders', async () => {
  const f = fixture(async action => action === 'inspect' ? { defaults: { network: 'signet', rootDirectory: '/fixture/nodes', core: { mode: 'existing', rpcUrl: 'http://127.0.0.1:38332' } }, catalog: {}, detected: {} } : null);
  await tick(); await button(f.root, 'Continue').click();
  const mode = f.root.querySelectorAll('select')[0];
  assert.equal(mode.children.find(option => option.value === 'existing').selected, true);
  await button(f.root, 'Continue').click();
  const network = f.root.querySelectorAll('select')[0];
  assert.equal(network.children.find(option => option.value === 'signet').selected, true);
  f.root.dispose();
});

test('late readonly inspection cannot overwrite a draft choice made while inspection is pending', async () => {
  let release;
  const inspection = new Promise(resolve => { release = resolve; });
  const f = fixture(async action => action === 'inspect' ? inspection : assert.fail(action));
  button(f.root, 'Not now').click();
  release({ defaults: { choice: 'core', network: 'testnet' }, catalog: {}, detected: {}, saved: null });
  await tick();
  assert.ok(button(f.root, 'Continue browsing'));
  assert.match(button(f.root, 'Not now').className, /selected/);
  f.root.dispose();
});

test('draft survives rerenders and explicit pick, preview, apply, and start actions remain separate', async () => {
  const f = fixture(async (action, payload) => {
    if (action === 'inspect') return { catalog: { core: { version: '1' }, ord: { version: '1' } }, detected: { core: [], ord: [] }, saved: null };
    if (action === 'pick') return { path: payload.kind === 'directory' ? '/owned/parent' : `/owned/${payload.kind}` };
    if (action === 'preview') return { token: 'preview-token', summary: { choice: payload.draft.choice, network: payload.draft.network }, services: [], providers: [], warnings: ['Review warning'], disk: { availableBytes: 10, requiredBytes: 20 }, directories: [] };
    if (action === 'apply') return { setupId: 'setup-1', committed: true, services: [], providers: [] };
    if (action === 'start') return { setupId: 'setup-1', core: { phase: 'starting' }, ord: { phase: 'stopped' } };
    return null;
  });
  await tick();
  await button(f.root, 'Continue').click();
  await button(f.root, 'Choose installed program').click();
  const chooseButtons = f.root.querySelectorAll('button').filter(node => node.textContent === 'Choose installed program');
  await chooseButtons.at(-1).click();
  await button(f.root, 'Continue').click();
  await button(f.root, 'Choose parent folder').click();
  await button(f.root, 'Continue').click();
  assert.match(f.root.textContent, /Review warning/);
  await button(f.root, 'Save setup').click();
  assert.match(f.root.textContent, /Saved does not mean synchronized or ready/);
  assert.equal(f.calls.some(([action]) => action === 'start'), false);
  await button(f.root, 'Start services').click();
  assert.equal(f.calls.filter(([action]) => action === 'start').length, 1);
  const preview = f.calls.find(([action]) => action === 'preview')[1].draft;
  assert.equal(preview.rootDirectory, '/owned/parent'); assert.equal(preview.core.executable, '/owned/core-executable'); assert.equal(preview.ord.executable, '/owned/ord-executable');
  f.root.dispose();
});

test('Ord-only managed mode explains and validates its existing Core dependency', async () => {
  const f = fixture(async action => action === 'inspect' ? { catalog: {}, detected: {}, saved: null } : action === 'pick' ? { path: '/owned/value' } : null); await tick();
  button(f.root, 'Ord only').click(); await button(f.root, 'Continue').click();
  assert.equal(f.root.querySelectorAll('.node-setup-panel').length, 1);
  await button(f.root, 'Choose installed program').click(); await button(f.root, 'Continue').click();
  assert.match(f.root.textContent, /Existing Bitcoin Core required/); assert.match(f.root.textContent, /does not install Core/);
  await button(f.root, 'Choose parent folder').click(); await button(f.root, 'Continue').click();
  assert.match(f.root.textContent, /cookie file/); assert.equal(f.calls.some(([action]) => action === 'preview'), false); f.root.dispose();
});

test('saved setup resumes without apply, status requests do not overlap, and dispose stops late publication', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture(async action => {
    if (action === 'inspect') return { catalog: {}, detected: {}, saved: { id: 'saved-1', plan: { draft: {} }, createdAt: 'now' } };
    if (action === 'status') { await held; return { setupId: 'saved-1', core: { phase: 'ready' }, ord: { phase: 'ready' } }; }
    return null;
  });
  await tick(); button(f.root, 'Resume existing setup').click();
  const first = button(f.root, 'Refresh status').click();
  button(f.root, 'Refresh status').click();
  assert.equal(f.calls.filter(([action]) => action === 'status').length, 1);
  assert.equal(f.calls.some(([action]) => action === 'apply' || action === 'start'), false);
  f.root.dispose(); release(); await first;
  assert.equal(f.calls.filter(([action]) => action === 'status').length, 1);
});

test('existing Core exposes cookie authentication and detected executables are selectable', async () => {
  const f = fixture(async action => action === 'inspect' ? { catalog: {}, detected: { core: ['/detected/core'], ord: [] }, saved: null } : null);
  await tick(); await button(f.root, 'Continue').click();
  const modes = f.root.querySelectorAll('select');
  assert.equal(new Set(modes.map(node => node.id)).size, 2);
  button(f.root, 'Use detected core: /detected/core').click();
  modes[0].value = 'existing'; modes[0].listeners.change({ currentTarget: modes[0] });
  await button(f.root, 'Continue').click();
  assert.ok(button(f.root, 'Choose cookie file')); assert.match(f.root.textContent, /Core authentication/);
  f.root.dispose();
});

test('network updates untouched default port but preserves a custom port', async () => {
  const f = fixture(async action => action === 'inspect' ? { catalog: {}, detected: {}, saved: null } : null);
  await tick(); await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click();
  let network = f.root.querySelectorAll('select')[0]; network.value = 'testnet'; network.listeners.change({ currentTarget: network });
  let port = f.root.querySelectorAll('input').find(node => node.getAttribute('type') === 'number'); assert.equal(port.value, 18332);
  port.value = '9999'; port.listeners.input({ currentTarget: port });
  network = f.root.querySelectorAll('select')[0]; network.value = 'signet'; network.listeners.change({ currentTarget: network });
  port = f.root.querySelectorAll('input').find(node => node.getAttribute('type') === 'number'); assert.equal(port.value, 9999);
  assert.doesNotMatch(f.root.textContent, /hundreds of GB|1\.5 TiB/); assert.match(f.root.textContent, /Start managed services/);
  f.root.dispose();
});

test('cancelled picker does not invent a selected executable', async () => {
  const f = fixture(async (action) => action === 'inspect' ? { catalog: {}, detected: {}, saved: null } : action === 'pick' ? { path: null } : null);
  await tick(); await button(f.root, 'Continue').click(); await button(f.root, 'Choose installed program').click();
  assert.doesNotMatch(f.root.textContent, /node-setup-path/); f.root.dispose();
});

test('committed apply readback failure enters recovery and never replays apply', async () => {
  const f = fixture(async (action, payload) => {
    if (action === 'inspect') return { catalog: {}, detected: { core: ['/core'], ord: ['/ord'] }, saved: null };
    if (action === 'pick') return { path: '/parent' };
    if (action === 'preview') return { token: 't', summary: {}, warnings: [], disk: null };
    if (action === 'apply') { const error = new Error('readback'); error.details = { setupCommitted: true, setupId: 'saved' }; throw error; }
    return null;
  });
  await tick(); await button(f.root, 'Continue').click(); button(f.root, 'Use detected core: /core').click(); button(f.root, 'Use detected ord: /ord').click();
  await button(f.root, 'Continue').click(); await button(f.root, 'Choose parent folder').click(); await button(f.root, 'Continue').click(); await button(f.root, 'Save setup').click();
  assert.match(f.root.textContent, /do not submit the setup again/); assert.equal(f.calls.filter(([action]) => action === 'apply').length, 1); f.root.dispose();
});

test('choice guidance states conservative combined capacity', async () => {
  const f = fixture(async action => action === 'inspect' ? { catalog: {}, detected: {}, saved: null } : null);
  await tick(); assert.match(f.root.textContent, /1\.5 TiB/); assert.match(f.root.textContent, /toward 2 TiB/); f.root.dispose();
});

test('progress exposes finite counters and progress but tolerates unknown values', async () => {
  const f = fixture(async action => {
    if (action === 'inspect') return { catalog: {}, detected: {}, saved: { id: 'saved', plan: { draft: {} } } };
    if (action === 'status') return { core: { phase: 'syncing', progress: 0.5, blocks: 100, headers: 200 }, ord: { phase: 'ready', height: 90 } };
    return null;
  });
  await tick(); button(f.root, 'Resume existing setup').click(); await button(f.root, 'Refresh status').click();
  const progress = f.root.querySelector('progress'); assert.ok(progress); assert.equal(progress.value, 0.5); assert.equal(progress.getAttribute('max'), '1');
  assert.match(f.root.textContent, /Blocks 100 of 200 headers/); assert.match(f.root.textContent, /Indexed through height 90/);
  assert.ok(button(f.root, 'Explore inscriptions')); button(f.root, 'Continue browsing').click(); assert.deepEqual(f.navigation, ['satnav://home']); f.root.dispose();
});

function labelledControl(root, label) {
  const wrapper = root.querySelectorAll('.node-setup-field').find(node => node.children[0]?.textContent === label);
  return wrapper?.children[1] ?? null;
}
function change(control, value) { assert.ok(control); control.value = value; control.listeners.change({ currentTarget: control }); }
async function regtestUiFixture() {
  const defaults = defaultNodeSetupDraft({ rootDirectory: '/owned/ui-regtest', network: 'regtest' });
  defaults.core.executable = '/owned/bin/core'; defaults.ord.executable = '/owned/bin/ord';
  const f = fixture(async (action, payload) => action === 'inspect' ? { defaults, catalog: {}, detected: {}, saved: null }
    : action === 'pick' && payload.kind === 'cookie' ? { path: '/owned/existing-regtest/.cookie' }
    : action === 'preview' ? { token: 'regtest-preview', ...buildNodeSetupPlan(payload.draft) } : null);
  await tick(); await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click();
  return f;
}

test('regtest walkthrough shows labelled advanced peer control and preserves it into the real plan preview', async t => {
  const f = await regtestUiFixture(); t.after(() => f.root.dispose());
  const peers = labelledControl(f.root, 'Core peer connections');
  assert.equal(peers.value, 'disabled');
  assert.equal(peers.children.find(option => option.value === 'disabled').selected, true);
  assert.ok(peers.parentElement.parentElement.children.some(node => node.tagName === 'SUMMARY' && node.textContent === 'Advanced settings'));
  assert.match(f.root.textContent, /not an OS firewall/);
  await button(f.root, 'Continue').click();
  assert.equal(f.calls.find(([action]) => action === 'preview')[1].draft.core.peerConnections, 'disabled');
  assert.match(f.root.textContent, /Off — local test chain only/);
  assert.match(f.root.textContent, /cannot synchronize from peers/);
  button(f.root, 'Back').click();
  change(labelledControl(f.root, 'Core peer connections'), 'automatic');
  await button(f.root, 'Continue').click();
  assert.equal(f.calls.filter(([action]) => action === 'preview').at(-1)[1].draft.core.peerConnections, 'automatic');
  assert.match(f.root.textContent, /Automatic — allow peer traffic/);
  assert.doesNotMatch(f.root.textContent, /cannot synchronize from peers/);
});

test('network switching defaults a new regtest to off, clears other networks and remembers explicit regtest intent', async t => {
  const f = fixture(async action => action === 'inspect' ? { catalog: {}, detected: {}, saved: null } : null);
  t.after(() => f.root.dispose());
  await tick(); await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click();
  assert.equal(labelledControl(f.root, 'Core peer connections'), null);
  change(labelledControl(f.root, 'Network'), 'regtest');
  assert.equal(labelledControl(f.root, 'Core peer connections').value, 'disabled');
  change(labelledControl(f.root, 'Core peer connections'), 'automatic');
  change(labelledControl(f.root, 'Network'), 'signet');
  assert.equal(labelledControl(f.root, 'Core peer connections'), null);
  change(labelledControl(f.root, 'Network'), 'regtest');
  assert.equal(labelledControl(f.root, 'Core peer connections').value, 'automatic');
  change(labelledControl(f.root, 'Network'), 'regtest');
  assert.equal(labelledControl(f.root, 'Core peer connections').value, 'automatic');
});

test('leaving regtest removes its hidden option from public-network preview', async t => {
  const f = await regtestUiFixture(); t.after(() => f.root.dispose());
  change(labelledControl(f.root, 'Network'), 'mainnet');
  assert.equal(labelledControl(f.root, 'Core peer connections'), null);
  await button(f.root, 'Continue').click();
  const input = f.calls.find(([action]) => action === 'preview')[1].draft;
  assert.equal(Object.hasOwn(input.core, 'peerConnections'), false);
  assert.equal(input.network, 'mainnet');
  assert.doesNotMatch(f.root.textContent, /Off — local test chain only|peer connections and DNS seeding disabled/);
});

test('Ord-only and existing Core hide dormant peer selection and never claim external-service isolation', async t => {
  for (const route of ['ord', 'existing']) {
    const f = await regtestUiFixture(); t.after(() => f.root.dispose());
    button(f.root, 'Back').click();
    if (route === 'existing') change(labelledControl(f.root, 'Core setup mode'), 'existing');
    else { button(f.root, 'Back').click(); button(f.root, 'Ord only').click(); await button(f.root, 'Continue').click(); }
    await button(f.root, 'Continue').click();
    assert.equal(labelledControl(f.root, 'Core peer connections'), null);
    assert.doesNotMatch(f.root.textContent, /Off disables peer connections/);
    // UI cookie selection is a mocked picker path, never a credential read.
    await button(f.root, 'Choose cookie file').click();
    await button(f.root, 'Continue').click();
    const input = f.calls.find(([action]) => action === 'preview')[1].draft;
    assert.equal(input.core.peerConnections, 'disabled');
    assert.equal(buildNodeSetupPlan(input).core.managed, false);
    assert.doesNotMatch(f.root.textContent, /Off — local test chain only|peer connections and DNS seeding disabled/);
  }
});

test('test-chain guidance updates across network switches while custom connections remain intact', async t => {
  const defaults = defaultNodeSetupDraft({ rootDirectory: '/owned/ui-guidance' });
  defaults.core.rpcPort = 9999; defaults.core.rpcUrl = 'http://localhost:9999';
  defaults.core.executable = '/owned/core'; defaults.ord.executable = '/owned/ord';
  const f = fixture(async (action, payload) => action === 'inspect' ? { defaults, catalog: {}, detected: {} }
    : action === 'preview' ? { token: 'preview', ...buildNodeSetupPlan(payload.draft) } : null);
  t.after(() => f.root.dispose());
  await tick(); assert.match(f.root.textContent, /mainnet.*1\.5 TiB/i);
  await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click();
  for (const network of ['regtest', 'signet', 'testnet']) {
    change(labelledControl(f.root, 'Network'), network);
    assert.doesNotMatch(f.root.textContent, /hundreds of GB|1\.5 TiB|hours or days/);
    assert.match(f.root.textContent, /2 GiB/);
    assert.equal(labelledControl(f.root, 'Core RPC port').value, 9999);
  }
  button(f.root, 'Back').click(); change(labelledControl(f.root, 'Core setup mode'), 'existing');
  assert.equal(labelledControl(f.root, 'Running Core RPC URL').value, 'http://localhost:9999');
});

test('existing-only walkthrough omits new storage controls and checks connections after saving', async t => {
  const defaults = defaultNodeSetupDraft({ rootDirectory: '' });
  defaults.choice = 'ord'; defaults.ord.mode = 'existing';
  const f = fixture(async (action, payload) => action === 'inspect' ? { defaults, catalog: {}, detected: {} }
    : action === 'preview' ? { token: 'existing', summary: {}, warnings: [], services: [], disk: { requiredBytes: 0, availableBytes: null } }
    : action === 'apply' ? { committed: true, setupId: 'existing', setup: { plan: { draft: defaults } } }
    : action === 'start' ? { ord: { phase: 'connected' } } : null);
  t.after(() => f.root.dispose());
  await tick(); await button(f.root, 'Continue').click(); await button(f.root, 'Continue').click();
  assert.equal(labelledControl(f.root, 'Parent folder'), null);
  assert.equal(button(f.root, 'Choose parent folder'), undefined);
  assert.match(f.root.textContent, /No new node data folders/);
  assert.doesNotMatch(f.root.textContent, /hundreds of GB|hours or days/);
  await button(f.root, 'Continue').click();
  assert.equal(f.calls.filter(([action]) => action === 'preview').length, 1);
  await button(f.root, 'Save setup').click();
  assert.ok(button(f.root, 'Check connections'));
  assert.equal(button(f.root, 'Stop managed services'), undefined);
  await button(f.root, 'Check connections').click();
  assert.equal(f.calls.filter(([action]) => action === 'start').length, 1);
  assert.doesNotMatch(f.root.textContent, /have not been checked yet/);
  assert.match(f.root.textContent, /connected/);
});

test('resumed Core-only ready actions follow the saved setup rather than the unsaved default choice', async t => {
  const savedDraft = defaultNodeSetupDraft({ rootDirectory: '/owned/resumed-core' });
  savedDraft.choice = 'core'; savedDraft.core.mode = 'existing';
  const f = fixture(async action => action === 'inspect' ? { catalog: {}, detected: {}, saved: { id: 'saved-core', plan: { draft: savedDraft } } }
    : action === 'status' ? { core: { phase: 'ready' }, ord: { phase: 'not-selected' } } : null);
  t.after(() => f.root.dispose());
  await tick(); button(f.root, 'Resume existing setup').click();
  await button(f.root, 'Refresh status').click();
  assert.ok(button(f.root, 'Check connections'));
  assert.ok(button(f.root, 'Explore inscriptions'));
  assert.equal(button(f.root, 'Start services'), undefined);
});

for (const action of ['start', 'stop']) {
  for (const outcome of ['success', 'failure']) {
    test(`a pre-${action} status ${outcome} cannot replace the lifecycle result`, async t => {
      let settle;
      const pending = new Promise((resolve, reject) => { settle = outcome === 'success' ? resolve : reject; });
      const phase = action === 'start' ? 'syncing' : 'stopped';
      const current = { setupId: 'saved', core: { phase, message: `Current ${action} outcome` }, ord: { phase: 'stopped' } };
      const f = fixture(async name => name === 'inspect'
        ? { catalog: {}, detected: {}, saved: { id: 'saved', plan: { draft: {} } } }
        : name === 'status' ? pending : name === action ? current : assert.fail(name));
      t.after(() => f.root.dispose());
      await tick(); button(f.root, 'Resume existing setup').click();
      const refresh = button(f.root, 'Refresh status').click();
      await button(f.root, action === 'start' ? 'Start services' : 'Stop managed services').click();
      assert.match(f.root.textContent, new RegExp(`Current ${action} outcome`));
      settle(outcome === 'success'
        ? { setupId: 'saved', core: { phase: 'ready', message: 'Obsolete ready observation' }, ord: { phase: 'ready' } }
        : new Error('Obsolete status failure'));
      await refresh;
      assert.doesNotMatch(f.root.textContent, /Obsolete/);
      assert.match(f.root.textContent, new RegExp(`Current ${action} outcome`));
      assert.equal(button(f.root, 'Explore inscriptions'), undefined);
      assert.equal(f.calls.filter(([name]) => name === action).length, 1);
    });
  }
}

test('successful status retry clears only its own read error without replaying a lifecycle action', async t => {
  let reads = 0;
  const f = fixture(async name => {
    if (name === 'inspect') return { catalog: {}, detected: {}, saved: { id: 'saved', plan: { draft: {} } } };
    if (name === 'status') {
      reads += 1;
      if (reads === 1) throw new Error('Status read failed');
      return { setupId: 'saved', core: { phase: 'syncing', message: 'Status recovered' }, ord: { phase: 'stopped' } };
    }
    assert.fail(name);
  });
  t.after(() => f.root.dispose());
  await tick(); button(f.root, 'Resume existing setup').click();
  await button(f.root, 'Refresh status').click();
  assert.match(f.root.textContent, /Status read failed/);
  await button(f.root, 'Refresh status').click();
  assert.match(f.root.textContent, /Status recovered/);
  assert.doesNotMatch(f.root.textContent, /Status read failed/);
  assert.deepEqual(f.calls.map(([name]) => name), ['inspect', 'status', 'status']);
});

test('read-only status recovery cannot erase an unresolved lifecycle failure', async t => {
  const f = fixture(async name => {
    if (name === 'inspect') return { catalog: {}, detected: {}, saved: { id: 'saved', plan: { draft: {} } } };
    if (name === 'stop') throw new Error('Stop did not complete cleanly');
    if (name === 'status') return { setupId: 'saved', core: { phase: 'stopped', message: 'Currently stopped' }, ord: { phase: 'stopped' } };
    assert.fail(name);
  });
  t.after(() => f.root.dispose());
  await tick(); button(f.root, 'Resume existing setup').click();
  await button(f.root, 'Stop managed services').click();
  await button(f.root, 'Refresh status').click();
  assert.match(f.root.textContent, /Currently stopped/);
  assert.match(f.root.textContent, /Stop did not complete cleanly/);
  assert.equal(f.calls.filter(([name]) => name === 'stop').length, 1);
});

test('automatic polling pauses during lifecycle work and previous ready actions disappear immediately', async t => {
  const timers = new Set();
  t.mock.method(globalThis, 'setTimeout', callback => { const timer = { callback }; timers.add(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); });
  let finish;
  const started = new Promise(resolve => { finish = resolve; });
  const f = fixture(async name => name === 'inspect'
    ? { catalog: {}, detected: {}, saved: { id: 'saved', plan: { draft: {} } } }
    : name === 'status' ? { setupId: 'saved', core: { phase: 'ready' }, ord: { phase: 'ready' } }
      : name === 'start' ? started : assert.fail(name));
  t.after(() => { f.root.dispose(); finish(null); });
  await tick(); button(f.root, 'Resume existing setup').click();
  await button(f.root, 'Refresh status').click();
  assert.ok(button(f.root, 'Explore inscriptions'));
  const action = button(f.root, 'Start services').click();
  assert.equal(button(f.root, 'Explore inscriptions'), undefined);
  assert.match(f.root.textContent, /Not checked yet/);
  const timer = [...timers][0]; timers.delete(timer); await timer.callback();
  assert.equal(f.calls.filter(([name]) => name === 'status').length, 1);
  finish({ setupId: 'saved', core: { phase: 'syncing' }, ord: { phase: 'stopped' } });
  await action;
  assert.equal(timers.size, 1);
  const next = [...timers][0]; timers.delete(next); await next.callback();
  assert.equal(f.calls.filter(([name]) => name === 'status').length, 2);
  assert.ok(button(f.root, 'Explore inscriptions'));
});
