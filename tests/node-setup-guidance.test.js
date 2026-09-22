import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';
import { nodeSetupGuidance, nodeSetupDisplayWarnings } from '../src/shared/node-setup-guidance.js';

const GiB = 1024 ** 3;
function draft(network = 'mainnet') {
  const result = defaultNodeSetupDraft({ rootDirectory: '/synthetic/guidance', network });
  result.core.executable = '/synthetic/core'; result.ord.executable = '/synthetic/ord';
  result.core.cookieFile = '/synthetic/never-read.cookie';
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('mainnet recommendations cover only managed components and their selected indexes', () => {
  const cases = [
    ['both', 'managed', 'managed', 'archive', false, 1536],
    ['both', 'managed', 'managed', 'archive', true, 2048],
    ['both', 'existing', 'managed', 'archive', false, 512],
    ['both', 'managed', 'existing', 'pruned', true, 30],
    ['ord', 'managed', 'managed', 'archive', true, 1024],
    ['core', 'managed', 'managed', 'archive', true, 1024],
    ['core', 'managed', 'managed', 'pruned', false, 30]
  ];
  for (const [choice, coreMode, ordMode, storage, indexSats, gib] of cases) {
    const input = draft(); input.choice = choice; input.core.mode = coreMode;
    input.core.storage = storage; input.ord.mode = ordMode; input.ord.indexSats = indexSats;
    const guidance = nodeSetupGuidance(input);
    assert.equal(guidance.recommendedBytes, gib * GiB, JSON.stringify(cases));
    assert.equal(guidance.minimumFreeBytes, 2 * GiB);
  }
});

test('test-chain guidance has no invented capacity or fixed synchronization time', () => {
  for (const network of ['regtest', 'signet', 'testnet']) {
    const result = nodeSetupGuidance(draft(network));
    assert.equal(result.recommendedBytes, null);
    assert.equal(result.minimumFreeBytes, 2 * GiB);
    assert.match(result.storageText, /no fixed capacity estimate/);
    assert.doesNotMatch(result.storageText, /1\.5 TiB|hours or days/);
    assert.match(result.storageText, /does not guarantee.*or limit disk growth/);
  }
});

test('existing-only and neither never inherit dormant managed storage or indexes', () => {
  for (const choice of ['none', 'core', 'ord', 'both']) {
    const input = draft(); input.choice = choice;
    if (choice !== 'none') { input.core.mode = 'existing'; input.ord.mode = 'existing'; }
    input.ord.indexSats = true;
    const result = nodeSetupGuidance(input);
    assert.equal(result.managed, false); assert.equal(result.minimumFreeBytes, 0);
    assert.equal(result.recommendedBytes, 0);
    assert.match(result.storageText, /No new node data folders/);
    assert.doesNotMatch(result.storageText, /2 GiB|hours or days/);
  }
});

test('derived presentation leaves frozen hash-covered plans and compatibility warnings unchanged', () => {
  for (const network of ['mainnet', 'regtest', 'signet', 'testnet']) {
    const plan = freeze(buildNodeSetupPlan(draft(network)));
    const before = JSON.stringify(plan);
    nodeSetupGuidance(plan.draft);
    const shown = nodeSetupDisplayWarnings(plan.draft, plan.warnings);
    assert.equal(JSON.stringify(plan), before);
    assert.notEqual(shown, plan.warnings);
    if (network === 'regtest') {
      assert.match(shown.join(' '), /cannot synchronize from peers/);
      assert.match(shown.join(' '), /not an OS firewall; authenticated Core RPC can change network activity/);
    } else assert.match(shown.join(' '), /not a node P2P firewall/);
    if (network === 'testnet') assert.match(shown.join(' '), /deprecated/i);
    if (network === 'mainnet') assert.deepEqual(shown, plan.warnings);
    else assert.doesNotMatch(shown.join(' '), /hours or days/);
  }
});

test('non-mainnet warning filtering removes only the two obsolete exact advisories', () => {
  const plan = buildNodeSetupPlan(draft('regtest'));
  const arbitrary = ['Custom operator warning: indexing can take hours or days.', 'Preserve historical-lookup restrictions.'];
  assert.deepEqual(nodeSetupDisplayWarnings(plan.draft, arbitrary), arbitrary);
  assert.deepEqual(nodeSetupDisplayWarnings(plan.draft, undefined), []);
});
