import test from 'node:test';
import assert from 'node:assert/strict';
import { localServiceEnvironment } from '../src/main/local-service-manager.js';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';
import { NodeSoftware } from '../src/main/node-software.js';

test('guided Ord launch discards ambient ORD settings but retains normal environment and advanced service behavior', () => {
  const draft = defaultNodeSetupDraft({ rootDirectory: '/fixture/nodes' });
  draft.core.executable = '/fixture/bitcoind'; draft.ord.executable = '/fixture/ord';
  const plan = buildNodeSetupPlan(draft, { platform: 'darwin' });
  const environment = { PATH: '/fixture', NODE_OPTIONS: 'synthetic', ORD_COOKIE_FILE: 'synthetic-unread', ORD_BITCOIN_RPC_PASSWORD: 'synthetic', ORD_INDEX_SATS: '1' };
  assert.deepEqual(localServiceEnvironment(environment, plan.services[1], { plan }), { PATH: '/fixture' });
  assert.deepEqual(localServiceEnvironment(environment, plan.services[0], { plan }), { PATH: '/fixture', ORD_COOKIE_FILE: 'synthetic-unread', ORD_BITCOIN_RPC_PASSWORD: 'synthetic', ORD_INDEX_SATS: '1' });
  assert.deepEqual(localServiceEnvironment(environment, { ...plan.services[1], args: ['user-edited'] }, { plan }), { PATH: '/fixture', ORD_COOKIE_FILE: 'synthetic-unread', ORD_BITCOIN_RPC_PASSWORD: 'synthetic', ORD_INDEX_SATS: '1' });
  assert.match(plan.files[1].content, /\n\{\}\n$/);
});

test('installer shutdown preserves cleanup failures but accepts ordinary cancellation', async () => {
  const software = new NodeSoftware({ directory: '/synthetic/unwritten' });
  const failure = Object.assign(new Error('synthetic retained files'), { code: 'SOFTWARE_INSTALL_CLEANUP_FAILED' });
  software.pending.set('core', Promise.reject(failure));
  software.pending.set('ord', Promise.reject(Object.assign(new Error('synthetic cancellation'), { code: 'APP_SHUTTING_DOWN' })));
  await assert.rejects(software.shutdown(), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure);
});
