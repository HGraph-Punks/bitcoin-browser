import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';
import { StateStore } from '../src/main/state-store.js';
import { validateProviderMutation } from '../src/shared/validation.js';

const FLAGS = ['-networkactive=0', '-connect=0', '-dnsseed=0', '-fixedseeds=0', '-dns=0'];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function draft(network = 'regtest') {
  const value = defaultNodeSetupDraft({ rootDirectory: '/owned/legacy-regtest', network });
  value.core.executable = '/owned/bin/bitcoind'; value.ord.executable = '/owned/bin/ord';
  return value;
}

// Captured from the unmodified production builder on 2026-09-08 before adding
// peerConnections. These are whole-plan bytes, not only selected arguments.
const LEGACY_DIGESTS = {
  mainnet: ['4562d9f8ac6fe94dfeabe84cb1d91d3b8dbd6f44bfc92db3e94facd0bb35dde8', 'c57e4cf50ccef2ca987892cbfed60c1267f40552c6968a3ed3c2520b8fa18345'],
  testnet: ['4b5c7766111bae561321490f813cef70d66bd81949b8e7be8f7b250a568a5dd7', '5064497ca98febd9792aebd74f5acd4af5b8a1203c3e5e8681fd7b6704b62184'],
  signet: ['176568df878f5cd680807e1bdc2bf00953c29c98266cb82ad5d5d758c49df56f', '2d0b3880ef7434abc2bf4ffb2dc917d0340de3c178721438de474df2f2d4fc1e'],
  regtest: ['d3508e6a64eb9faf192de2d0a1b80f4131ee86bf46fec199d07d44791e57d870', '2e1fec335f5d798bf89d4b5a00c49a0c2af93e28269d868108ff3a03f7788a70']
};

test('only newly created regtest drafts default to disabled peer connections', () => {
  assert.equal(draft().core.peerConnections, 'disabled');
  for (const network of ['mainnet', 'testnet', 'signet']) assert.equal(Object.hasOwn(draft(network).core, 'peerConnections'), false);
});

test('disabled regtest adds exactly the reviewed five peer controls without changing RPC or Ord', () => {
  const input = draft(), before = structuredClone(input);
  const isolated = buildNodeSetupPlan(input);
  const legacyDraft = structuredClone(input); delete legacyDraft.core.peerConnections;
  const legacy = buildNodeSetupPlan(legacyDraft);
  assert.deepEqual(input, before);
  assert.deepEqual(isolated.services[0].args, [...legacy.services[0].args, ...FLAGS]);
  assert.deepEqual(isolated.services[1], legacy.services[1]);
  assert.deepEqual(isolated.providers, legacy.providers);
  assert.deepEqual(isolated.files, legacy.files);
  assert.equal(isolated.summary.corePeerConnections, 'disabled');
  assert.match(isolated.warnings.join(' '), /cannot synchronize from peers/);
  assert.match(isolated.warnings.join(' '), /not an OS firewall/);
  assert.match(isolated.warnings.join(' '), /authenticated Core RPC can change network activity/);
  assert.ok(!isolated.warnings.includes('Initial blockchain synchronization downloads many gigabytes and can take hours or days; storage estimates are not guarantees.'));
});

test('automatic regtest keeps peer-capable arguments and does not claim disabled networking', () => {
  const input = draft(); input.core.peerConnections = 'automatic';
  const automatic = buildNodeSetupPlan(input);
  const legacyDraft = structuredClone(input); delete legacyDraft.core.peerConnections;
  const legacy = buildNodeSetupPlan(legacyDraft);
  assert.deepEqual(automatic.services, legacy.services);
  assert.deepEqual(automatic.warnings, legacy.warnings);
  assert.equal(automatic.summary.corePeerConnections, 'automatic');
  assert.ok(FLAGS.every(flag => !automatic.services[0].args.includes(flag)));
});

test('peer-connection values reject coercion, objects, unknown strings, and undefined', () => {
  for (const value of [undefined, null, false, true, 0, [], {}, 'off', 'DISABLED', 'disabled\n', '-networkactive=0']) {
    const input = draft(); input.core.peerConnections = value;
    assert.throws(() => buildNodeSetupPlan(input), { code: 'INVALID_NODE_SETUP' });
  }
});

test('active disabled mode cannot silently disable a managed public-network Core', () => {
  for (const network of ['mainnet', 'testnet', 'signet']) {
    const input = draft(network); input.core.peerConnections = 'disabled';
    assert.throws(() => buildNodeSetupPlan(input), { code: 'INVALID_NODE_SETUP' });
    input.core.peerConnections = 'automatic';
    assert.ok(FLAGS.every(flag => !buildNodeSetupPlan(input).services[0].args.includes(flag)));
  }
});

test('dormant selection never controls or claims isolation for Core that is not managed', () => {
  for (const network of ['regtest', 'mainnet']) {
    for (const selected of ['none', 'ord', 'existing']) {
      const input = draft(network); input.core.peerConnections = 'disabled';
      if (selected === 'existing') input.core.mode = 'existing'; else input.choice = selected;
      input.core.cookieFile = '/owned/existing/.cookie';
      const plan = buildNodeSetupPlan(input);
      assert.equal(plan.core.managed, false);
      assert.equal(plan.draft.core.peerConnections, 'disabled');
      assert.equal(Object.hasOwn(plan.summary, 'corePeerConnections'), false);
      assert.ok(plan.services.every(service => FLAGS.every(flag => !service.args.includes(flag))));
      assert.doesNotMatch(plan.warnings.join(' '), /Regtest Core starts with peer connections/);
    }
  }
});

test('legacy absent-field plans retain exact prechange raw and normalized saved digests', () => {
  for (const [network, expected] of Object.entries(LEGACY_DIGESTS)) {
    const input = draft(network); delete input.core.peerConnections;
    const plan = buildNodeSetupPlan(input, { platform: 'darwin' });
    assert.equal(digest(plan), expected[0], `${network} raw plan`);
    plan.providers = plan.providers.map(validateProviderMutation);
    assert.equal(digest(plan), expected[1], `${network} normalized saved plan`);
    assert.equal(Object.hasOwn(plan.draft.core, 'peerConnections'), false);
    assert.equal(Object.hasOwn(plan.summary, 'corePeerConnections'), false);
  }
});

test('legacy plan identity and owned definitions survive actual StateStore reopen', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-regtest-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [network, expected] of Object.entries(LEGACY_DIGESTS)) {
    const input = draft(network); delete input.core.peerConnections;
    const plan = buildNodeSetupPlan(input, { platform: 'darwin' });
    plan.providers = plan.providers.map(validateProviderMutation);
    const record = { schemaVersion: 1, id: `legacy-${network}`, autoStart: false, createdAt: '2026-09-08T00:00:00.000Z', plan, planHash: expected[1] };
    const store = new StateStore(path.join(root, network), null); await store.init();
    await store.mutate(state => { state.nodeSetup = record; state.providers = plan.providers; state.localServices = plan.services; state.settings.network = network; });
    const reopened = new StateStore(store.directory, null); await reopened.init();
    const manager = new NodeSetupManager({ stateStore: reopened, platform: 'darwin' });
    const saved = manager.saved(record.id);
    assert.equal(saved.planHash, expected[1]); assert.deepEqual(saved.plan, plan);
    assert.doesNotThrow(() => manager.assertOwned(saved));
    await reopened.mutate(state => { state.localServices[0].args.push('-networkactive=0'); });
    assert.throws(() => manager.assertOwned(manager.saved(record.id)), { code: 'NODE_SETUP_CHANGED' });
  }
});

test('new isolated setup previews, applies and reopens with exact managed flag ownership', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-regtest-plan-save-'));
  let manager;
  t.after(async () => { await manager?.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const store = new StateStore(path.join(root, 'state'), null); await store.init();
  await store.mutate(state => { state.providers = []; state.localServices = []; });
  const providers = { providerMutations: new Set(), blockedProviders: new Set(), assertNoPendingCleanup() {}, invalidateRouting() {}, refresh() {}, list: () => store.get(['providers']) };
  const services = { editing: new Map(), starting: new Map(), stopping: new Map(), removing: new Map(), processes: new Map(), list: () => store.get(['localServices']), start() { assert.fail('No native execution is permitted in this storage test.'); } };
  manager = new NodeSetupManager({ stateStore: store, providerManager: providers, localServiceManager: services,
    rootDirectory: path.join(root, 'nodes'), confirm: async () => true, software: { async shutdown() {} } });
  const input = defaultNodeSetupDraft({ rootDirectory: path.join(root, 'nodes'), network: 'regtest' });
  // Only checked for executable-file existence by preview; never launched.
  input.core.executable = process.execPath; input.ord.executable = process.execPath;
  const preview = await manager.run({ action: 'preview', draft: input });
  assert.equal(preview.summary.corePeerConnections, 'disabled');
  const saved = await manager.run({ action: 'apply', token: preview.token });
  const reopened = new StateStore(store.directory, null); await reopened.init();
  const restored = new NodeSetupManager({ stateStore: reopened });
  const record = restored.saved(saved.setupId);
  assert.doesNotThrow(() => restored.assertOwned(record));
  await restored.assertFiles(record);
  assert.deepEqual(record.plan.services[0].args.slice(-5), FLAGS);
  assert.equal(record.planHash, digest(record.plan));
  await reopened.mutate(state => { state.nodeSetup.plan.draft.core.peerConnections = 'automatic'; });
  assert.throws(() => restored.saved(saved.setupId), { code: 'NODE_SETUP_CHANGED' });
});
