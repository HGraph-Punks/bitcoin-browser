import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderManager } from '../src/main/provider-manager.js';
import { SecureStore } from '../src/main/secure-store.js';
import { StateStore } from '../src/main/state-store.js';

const provider = {
  id: 'credential-boundary-fixture', name: 'Synthetic Core', type: 'bitcoin-core',
  network: 'mainnet', baseUrl: 'https://first.fixture.invalid', enabled: true,
  priority: 1, local: false, capabilities: ['block'], cookieFile: ''
};
const credentials = { username: 'synthetic-user', password: 'synthetic-password' };
const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`synthetic:${text}`),
  decryptString: (buffer) => buffer.toString().replace(/^synthetic:/, '')
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-credential-boundary-'));
  const stores = [];
  const reopen = async () => {
    const state = new StateStore(path.join(directory, 'state'), null);
    const secrets = new SecureStore(path.join(directory, 'secure'), fakeEncryption, null);
    await state.init();
    await secrets.init();
    stores.push(state, secrets);
    return { state, secrets, manager: new ProviderManager(state, secrets, null) };
  };
  t.after(async () => {
    await Promise.all(stores.map((store) => store.queue));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const current = await reopen();
  await current.state.mutate((draft) => { draft.providers = []; draft.settings.localOnly = false; });
  current.manager.refresh();
  return { ...current, reopen };
}

test('post-state-commit credential marker failure stays committed and blocked after actual disk reopen', async (t) => {
  const current = await fixture(t);
  await current.manager.upsert({ provider, credentials });
  const edited = { ...provider, baseUrl: 'https://second.fixture.invalid' };
  t.mock.method(current.secrets, 'set', async () => { throw Object.assign(new Error('Synthetic marker write failure'), { code: 'EIO' }); });
  await assert.rejects(current.manager.upsert({ provider: edited, credentials: { username: 'synthetic-new-user', password: 'synthetic-new-password' } }), (error) => {
    // The established public envelope normalizes native errors; main retains
    // the original cause separately from the committed outcome metadata.
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.cause.code, 'EIO');
    assert.equal(error.details.providerMutationCommitted, true);
    assert.equal(error.details.providerId, provider.id);
    return true;
  });
  assert.equal(current.state.get(['providers'])[0].baseUrl, edited.baseUrl);
  assert.deepEqual(current.manager.candidates('block'), []);
  const reopened = await current.reopen();
  assert.equal(reopened.state.get(['providers'])[0].baseUrl, edited.baseUrl);
  assert.deepEqual(reopened.manager.candidates('block'), []);
  assert.equal(reopened.manager.list()[0].routingError.code, 'PROVIDER_CREDENTIAL_RECOVERY_REQUIRED');
});

test('unavailable encryption does not prevent deleting an ordinary public provider', async (t) => {
  const current = await fixture(t);
  const publicProvider = { ...provider, id: 'public-fixture', type: 'mempool', capabilities: ['block'] };
  await current.manager.upsert({ provider: publicProvider });
  t.mock.method(current.secrets, 'available', () => false);
  await current.manager.remove(publicProvider.id);
  assert.deepEqual(current.manager.list(), []);
  const reopened = await current.reopen();
  assert.deepEqual(reopened.manager.list(), []);
});

test('retained adapter cannot acquire replacement destination credentials after commit', async (t) => {
  const current = await fixture(t);
  await current.manager.upsert({ provider, credentials });
  const retained = current.manager.candidates('block')[0];
  const edited = { ...provider, baseUrl: 'https://second.fixture.invalid' };
  const replacement = { username: 'synthetic-new-user', password: 'synthetic-new-password' };
  await current.manager.upsert({ provider: edited, credentials: replacement });
  assert.equal(await retained.authorizationHeader(), null);
  assert.equal(await current.manager.candidates('block')[0].authorizationHeader(), `Basic ${Buffer.from(`${replacement.username}:${replacement.password}`).toString('base64')}`);
});
