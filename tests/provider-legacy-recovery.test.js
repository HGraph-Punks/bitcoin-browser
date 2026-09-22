import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/main/state-store.js';
import { SecureStore } from '../src/main/secure-store.js';
import { ProviderManager } from '../src/main/provider-manager.js';

const oldProvider = {
  id: 'legacy-recovery-fixture', name: 'Synthetic Core', type: 'bitcoin-core',
  baseUrl: 'https://old.fixture.invalid', network: 'mainnet', enabled: true,
  priority: 1, local: false, capabilities: ['block'], cookieFile: ''
};
const newProvider = { ...oldProvider, baseUrl: 'https://new.fixture.invalid' };
const credentials = { username: 'synthetic-new-user', password: 'synthetic-new-password' };
const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`synthetic:${value}`),
  decryptString: (value) => value.toString().replace(/^synthetic:/, '')
};

async function legacyFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-legacy-recovery-'));
  const stores = [];
  const reopen = async () => {
    const state = new StateStore(path.join(directory, 'state'), null);
    const secrets = new SecureStore(path.join(directory, 'secure'), fakeEncryption, null);
    stores.push(state, secrets);
    await state.init();
    await secrets.init();
    return { state, secrets, manager: new ProviderManager(state, secrets, null) };
  };
  t.after(async () => {
    await Promise.all(stores.map((store) => store.queue));
    await fs.rm(directory, { recursive: true, force: true });
  });
  // An actual old-release primary has no recovery-provenance field. Do not
  // simulate that by clearing the current implementation's recovery status.
  await fs.mkdir(path.join(directory, 'state'));
  await fs.writeFile(path.join(directory, 'state', 'state.json'), JSON.stringify({
    schemaVersion: 3, settings: { localOnly: false }, providers: [oldProvider]
  }));
  const current = await reopen();
  await current.state.upsertProvider(newProvider);
  // Reconstruct an older release's ID-keyed store using synthetic values only.
  // The newest primary has the new endpoint, while its backup has the old one.
  await current.secrets.transaction({
    [`provider:${newProvider.id}:username`]: credentials.username,
    [`provider:${newProvider.id}:password`]: credentials.password
  }, async () => {});
  return { ...current, reopen };
}

async function assertBlocked(current, id = oldProvider.id) {
  assert.equal(current.manager.candidates('block').some((provider) => provider.id === id), false);
  assert.equal(current.manager.list().find((provider) => provider.id === id).routingError.code,
    'PROVIDER_LEGACY_CREDENTIAL_RECOVERY_REQUIRED');
  assert.equal(await current.manager.instances.get(id).authorizationHeader(), null,
    'Credential access itself must be blocked, even through a retained adapter');
}

for (const loss of ['corrupt', 'missing']) {
  test(`${loss} primary cannot allow legacy credential reuse on the second or later startup`, async (t) => {
    const current = await legacyFixture(t);
    if (loss === 'corrupt') await fs.writeFile(current.state.file, '{synthetic corruption');
    else await fs.rm(current.state.file);
    const recovered = await current.reopen();
    assert.equal(recovered.state.recoveryStatus.source, 'backup');
    assert.equal(recovered.state.get(['providers'])[0].baseUrl, oldProvider.baseUrl);
    assert.deepEqual(recovered.manager.candidates('block'), [], 'First recovery must block the unbound pair');
    // Ordinary settings changes and successful recovery writeback must not
    // turn a recovered endpoint into proof of credential destination ownership.
    await recovered.state.updateSettings({ theme: 'light' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = await current.reopen();
      assert.equal(reopened.state.recoveryStatus.source, 'primary');
      assert.deepEqual(reopened.manager.candidates('block'), [], 'A later primary load must retain the recovery block');
      await assertBlocked(reopened);
    }
  });
}

test('unrecovered legacy primary retains the pending-policy compatibility behavior', async (t) => {
  const current = await legacyFixture(t);
  const reopened = await current.reopen();
  assert.equal(reopened.state.recoveryStatus.source, 'primary');
  const [provider] = reopened.manager.candidates('block');
  assert.equal(provider.config.baseUrl, newProvider.baseUrl);
  assert.equal(await provider.authorizationHeader(), `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`);
  assert.equal(reopened.secrets.has(`provider-credential-state:${newProvider.id}`), false, 'No implicit migration policy');
});

for (const loss of ['corrupt', 'missing']) {
  test(`${loss} primary and backup retain the legacy block when an omitted provider ID is reintroduced`, async (t) => {
    const current = await legacyFixture(t);
    for (const file of [current.state.file, current.state.backup]) {
      if (loss === 'corrupt') await fs.writeFile(file, '{synthetic corruption');
      else await fs.rm(file);
    }
    const recovered = await current.reopen();
    assert.equal(recovered.state.recoveryStatus.source, 'defaults');
    assert.equal(recovered.state.get(['providers']).some(({ id }) => id === oldProvider.id), false);
    await recovered.state.flush();
    const reopened = await current.reopen();
    assert.equal(reopened.state.recoveryStatus.source, 'primary');
    await reopened.manager.upsert({ provider: oldProvider, credentials: {} });
    await reopened.state.updateSettings({ localOnly: false });
    await assertBlocked(reopened);
    await assertBlocked(await current.reopen());
  });
}

test('state repair is protected before any credential-store or manager initialization', async (t) => {
  const current = await legacyFixture(t);
  await fs.rm(current.state.file);
  const stateOnly = new StateStore(current.state.directory, null);
  await stateOnly.init();
  assert.equal(stateOnly.recoveryStatus.source, 'backup');
  assert.equal(JSON.parse(await fs.readFile(stateOnly.file, 'utf8')).legacyCredentialRecoveryRequired, true);
  // Model restart immediately after state repair, before startup reaches the
  // separate secure store. No in-memory manager marker can protect this gap.
  const reopened = await current.reopen();
  assert.equal(reopened.state.recoveryStatus.source, 'primary');
  await assertBlocked(reopened);
});

test('re-entering one full pair repairs that source without releasing another legacy source', async (t) => {
  const current = await legacyFixture(t);
  const other = { ...oldProvider, id: 'other-legacy-fixture' };
  await current.secrets.transaction({
    [`provider:${other.id}:username`]: 'synthetic-other-user',
    [`provider:${other.id}:password`]: 'synthetic-other-password'
  }, async () => {});
  await fs.rm(current.state.file);
  const recovered = await current.reopen();
  await recovered.manager.upsert({ provider: other, credentials: {} });
  await recovered.manager.upsert({ provider: oldProvider, credentials: { username: 'synthetic-partial' } });
  await assertBlocked(recovered);
  await recovered.manager.upsert({ provider: oldProvider, credentials });
  const reopened = await current.reopen();
  const repaired = reopened.manager.candidates('block').find(({ id }) => id === oldProvider.id);
  assert.ok(repaired);
  assert.equal(await repaired.authorizationHeader(), `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`);
  await assertBlocked(reopened, other.id);
});

test('bound credentials and public providers retain legitimate routing after recovery', async (t) => {
  const current = await legacyFixture(t);
  await current.manager.upsert({ provider: newProvider, credentials });
  const publicProvider = { ...newProvider, id: 'public-fixture', baseUrl: 'https://public.fixture.invalid' };
  await current.manager.upsert({ provider: publicProvider, credentials: {} });
  await current.state.flush();
  await fs.rm(current.state.file);
  const recovered = await current.reopen();
  assert.equal(recovered.state.recoveryStatus.source, 'backup');
  for (const loaded of [recovered, await current.reopen()]) {
    assert.equal(loaded.manager.candidates('block').length, 2);
    assert.equal(await loaded.manager.instances.get(newProvider.id).authorizationHeader(),
      `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`);
    assert.equal(await loaded.manager.instances.get(publicProvider.id).authorizationHeader(), null);
  }
});

for (const marker of [false, null, 0, '', [], { unrecognized: true }]) {
  test(`malformed persisted recovery provenance ${JSON.stringify(marker)} cannot authorize unbound secrets`, async (t) => {
    const current = await legacyFixture(t);
    const persisted = JSON.parse(await fs.readFile(current.state.file, 'utf8'));
    persisted.legacyCredentialRecoveryRequired = marker;
    await fs.writeFile(current.state.file, JSON.stringify(persisted));
    const reopened = await current.reopen();
    assert.equal(reopened.state.recoveryStatus.source, 'primary');
    await assertBlocked(reopened);
    assert.equal(JSON.parse(await fs.readFile(current.state.file, 'utf8')).legacyCredentialRecoveryRequired, true);
  });
}

test('ordinary state mutation cannot remove established recovery provenance', async (t) => {
  const current = await legacyFixture(t);
  await fs.rm(current.state.file);
  const recovered = await current.reopen();
  await recovered.state.mutate((draft) => { delete draft.legacyCredentialRecoveryRequired; });
  await recovered.state.updateSettings({ theme: 'dark' });
  await recovered.state.flush();
  const reopened = await current.reopen();
  assert.equal(reopened.state.get(['settings', 'theme']), 'dark');
  await assertBlocked(reopened);
});

for (const stage of ['writeFile', 'rename']) {
  test(`failed recovery ${stage} never publishes a repaired primary without provenance`, async (t) => {
    const current = await legacyFixture(t);
    await fs.writeFile(current.state.file, '{synthetic corruption');
    const original = fs[stage];
    const injected = Object.assign(new Error('Synthetic repair I/O failure'), { code: 'EIO' });
    const mock = t.mock.method(fs, stage, async (...args) => {
      const target = stage === 'rename' ? args[1] : args[0];
      if (stage === 'rename' ? target === current.state.file : target.startsWith(`${current.state.file}.`)) {
        const staged = stage === 'rename' ? await fs.readFile(args[0], 'utf8') : args[1];
        assert.equal(JSON.parse(staged).legacyCredentialRecoveryRequired, true);
        throw injected;
      }
      return original(...args);
    });
    await assert.rejects(new StateStore(current.state.directory, null).init(), (error) => error === injected);
    mock.mock.restore();
    assert.equal(await fs.readFile(current.state.file, 'utf8'), '{synthetic corruption');
    await assertBlocked(await current.reopen());
    await assertBlocked(await current.reopen());
  });
}
