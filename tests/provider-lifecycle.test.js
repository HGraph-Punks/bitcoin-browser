import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderManager } from '../src/main/provider-manager.js';
import { SecureStore } from '../src/main/secure-store.js';
import { StateStore } from '../src/main/state-store.js';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`fixture-protected:${value}`),
    decryptString: (value) => value.toString().replace(/^fixture-protected:/, '')
  };
}

function mockProvider(id, overrides = {}) {
  return {
    id,
    name: `Fixture ${id}`,
    type: 'mock',
    network: 'mainnet',
    baseUrl: '',
    enabled: true,
    priority: 10,
    local: true,
    capabilities: ['block'],
    ...overrides
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-provider-lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, 'state');
  const secretsDirectory = path.join(directory, 'secrets');
  const stateStore = new StateStore(stateDirectory, null);
  const secureStore = new SecureStore(secretsDirectory, fakeSafeStorage(), null);
  await Promise.all([stateStore.init(), secureStore.init()]);
  await stateStore.mutate((draft) => { draft.providers = []; });
  return {
    stateDirectory,
    secretsDirectory,
    stateStore,
    secureStore,
    manager: new ProviderManager(stateStore, secureStore, null)
  };
}

test('provider lifecycle persists edits and preference, then removes only exact credentials', async (t) => {
  const current = await fixture(t);
  const alphaId = 'fixture-alpha';
  const betaId = 'fixture-beta';

  await current.manager.upsert({
    provider: mockProvider(alphaId),
    credentials: { username: 'fixture-alice', password: 'fixture-alpha-token' }
  });
  await current.manager.upsert({
    provider: mockProvider(betaId, { priority: 20 }),
    credentials: { username: 'fixture-bob', password: 'fixture-beta-token' }
  });
  await current.manager.upsert({
    provider: mockProvider(alphaId, { name: 'Edited fixture alpha', priority: 3 }),
    credentials: { username: 'fixture-alice-edited' }
  });
  await current.stateStore.updateSettings({ preferredProviderId: alphaId });

  const persistedState = new StateStore(current.stateDirectory, null);
  const persistedSecrets = new SecureStore(current.secretsDirectory, fakeSafeStorage(), null);
  await Promise.all([persistedState.init(), persistedSecrets.init()]);
  const persistedManager = new ProviderManager(persistedState, persistedSecrets, null);
  assert.deepEqual(persistedManager.list().map(({ id }) => id).sort(), [alphaId, betaId]);
  assert.equal(persistedManager.list().find(({ id }) => id === alphaId).name, 'Edited fixture alpha');
  assert.equal(persistedState.get(['settings', 'preferredProviderId']), alphaId);
  assert.equal(persistedSecrets.get(`provider:${alphaId}:username`), 'fixture-alice-edited');
  assert.equal(persistedSecrets.get(`provider:${alphaId}:password`), 'fixture-alpha-token');
  assert.equal(persistedSecrets.get(`provider:${betaId}:password`), 'fixture-beta-token');

  await persistedManager.remove(alphaId);
  assert.equal(persistedState.get(['settings', 'preferredProviderId']), null);
  assert.equal(persistedSecrets.get(`provider:${alphaId}:username`), null);
  assert.equal(persistedSecrets.get(`provider:${alphaId}:password`), null);
  assert.equal(persistedSecrets.get(`provider:${betaId}:username`), 'fixture-bob');
  assert.equal(persistedSecrets.get(`provider:${betaId}:password`), 'fixture-beta-token');
  assert.deepEqual(persistedManager.list().map(({ id }) => id), [betaId]);

  await persistedManager.remove(alphaId);
  assert.deepEqual(persistedManager.list().map(({ id }) => id), [betaId]);
  assert.equal(persistedSecrets.get(`provider:${betaId}:password`), 'fixture-beta-token');

  await persistedManager.remove(betaId);
  assert.deepEqual(persistedManager.list(), []);
  assert.deepEqual(persistedState.get(['providers']), []);

  const finalState = new StateStore(current.stateDirectory, null);
  const finalSecrets = new SecureStore(current.secretsDirectory, fakeSafeStorage(), null);
  await Promise.all([finalState.init(), finalSecrets.init()]);
  const finalManager = new ProviderManager(finalState, finalSecrets, null);
  assert.deepEqual(finalState.get(['providers']), []);
  assert.deepEqual(finalManager.list(), []);
  assert.equal(finalSecrets.get(`provider:${betaId}:username`), null);
  assert.equal(finalSecrets.get(`provider:${betaId}:password`), null);
});
