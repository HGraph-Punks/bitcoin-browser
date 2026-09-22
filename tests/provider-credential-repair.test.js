import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/main/state-store.js';
import { SecureStore } from '../src/main/secure-store.js';
import { ProviderManager } from '../src/main/provider-manager.js';

const core = { id: 'repair-core', name: 'Synthetic Core', type: 'bitcoin-core', network: 'mainnet',
  baseUrl: 'https://repair.fixture.invalid', enabled: true, priority: 1, local: false, capabilities: ['block'], cookieFile: '' };
const oldPair = { username: 'synthetic-old-user', password: 'synthetic-old-password' };
const newPair = { username: 'synthetic-new-user', password: 'synthetic-new-password' };
const stateKey = (id = core.id) => `provider-credential-state:${id}`;
const basic = (pair) => `Basic ${Buffer.from(`${pair.username}:${pair.password}`).toString('base64')}`;
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

async function fixture(t, config = core, credentials = oldPair) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-provider-repair-'));
  const stores = [];
  const reopen = async () => {
    const state = new StateStore(path.join(directory, 'state'), null);
    const secrets = new SecureStore(path.join(directory, 'secure'), {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`fixture:${text}`),
      decryptString: (bytes) => bytes.toString().replace(/^fixture:/, '')
    }, null);
    stores.push(state, secrets);
    await state.init(); await secrets.init();
    return { state, secrets, manager: new ProviderManager(state, secrets, null) };
  };
  t.after(async () => { await Promise.all(stores.map((store) => store.queue)); await fs.rm(directory, { recursive: true, force: true }); });
  const f = await reopen();
  await f.state.mutate((draft) => { draft.providers = []; draft.settings.localOnly = false; draft.settings.preferredProviderId = null; });
  await f.manager.upsert({ provider: config, credentials });
  await f.state.updateSettings({ preferredProviderId: config.id });
  return { ...f, reopen, config };
}

async function block(f, kind = 'pending') {
  const key = stateKey(f.config.id);
  if (kind === 'invalid') await f.secrets.set(key, '{synthetic invalid metadata');
  else if (kind === 'legacy') await f.secrets.delete(key);
  else {
    const metadata = JSON.parse(f.secrets.get(key));
    if (kind === 'mismatch') metadata.binding = 'synthetic-other-binding';
    else metadata.status = kind;
    await f.secrets.set(key, JSON.stringify(metadata));
  }
}

function intent(f, credentials = newPair) {
  const descriptor = f.manager.list().find(({ id }) => id === f.config.id);
  assert.ok(descriptor.credentialRecovery, 'A configured blocked source needs an explicit recovery action');
  const { token, mode } = descriptor.credentialRecovery;
  return { id: f.config.id, token, mode, ...(mode === 'replace-basic' ? { credentials } : {}) };
}

async function assertUsable(f, pair = newPair) {
  const provider = f.manager.candidates('block').find(({ id }) => id === f.config.id);
  assert.ok(provider, 'Repaired source must be eligible');
  assert.equal(await provider.authorizationHeader(), basic(pair));
  assert.equal(f.manager.list().find(({ id }) => id === f.config.id).credentialRecovery, undefined);
}

for (const kind of ['pending', 'tombstone', 'invalid', 'mismatch', 'legacy']) {
  test(`explicit ${kind} recovery replaces authentication while retaining configuration and preference across restart`, async (t) => {
    const f = await fixture(t); await block(f, kind);
    const before = f.state.get(['providers']);
    const request = intent(f);
    await f.manager.recover(request);
    assert.deepEqual(f.state.get(['providers']), before);
    assert.equal(f.state.get(['settings', 'preferredProviderId']), f.config.id);
    await assertUsable(f);
    await assertUsable({ ...await f.reopen(), config: f.config });
  });
}

test('ordinary Edit cannot accidentally consume an interrupted recovery state', async (t) => {
  const f = await fixture(t); await block(f);
  await assert.rejects(f.manager.upsert({ provider: f.config, credentials: newPair }), { code: 'PROVIDER_CREDENTIAL_RECOVERY_REQUIRED' });
  assert.equal(f.secrets.get(`provider:${f.config.id}:password`), oldPair.password);
});

for (const config of [
  { ...core, cookieFile: '/synthetic/existing.cookie' },
  { ...core, type: 'ord-server', capabilities: ['output'], cookieFile: '' },
  { ...core, type: 'mempool', cookieFile: '' }
]) {
  test(`clear-stored recovery retains ${config.type}/${config.cookieFile ? 'cookie' : 'public'} source and removes both saved Basic fields`, async (t) => {
    const f = await fixture(t, config);
    // Include dormant Basic values even when this adapter does not use them.
    await f.secrets.transaction({ [`provider:${core.id}:username`]: oldPair.username, [`provider:${core.id}:password`]: oldPair.password }, async () => {});
    await block(f, 'invalid');
    const before = f.state.get(['providers']); const request = intent(f);
    assert.equal(request.mode, 'clear-stored'); assert.equal(Object.hasOwn(request, 'credentials'), false);
    await assert.rejects(f.manager.recover({ ...request, mode: 'replace-basic', credentials: newPair }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(f.manager.recover({ ...request, credentials: undefined }), { code: 'VALIDATION_ERROR' });
    await f.manager.recover(request);
    const reopened = await f.reopen();
    assert.deepEqual(reopened.state.get(['providers']), before, 'Do not replace legacy Ord output with its migrated runtime descriptor');
    assert.equal(reopened.secrets.has(`provider:${core.id}:username`), false);
    assert.equal(reopened.secrets.has(`provider:${core.id}:password`), false);
    assert.equal(reopened.manager.list()[0].routingBlocked, undefined);
    assert.equal(JSON.parse(reopened.secrets.get(stateKey())).status, 'active');
  });
}

test('partial, malformed and wrong-mode recovery requests do not change credentials or consume valid review', async (t) => {
  const f = await fixture(t); await block(f); const request = intent(f);
  const before = await fs.readFile(f.secrets.file, 'utf8');
  for (const bad of [
    { ...request, credentials: { username: 'only-user' } },
    { ...request, credentials: { ...newPair, username: 'user:colon' } },
    { ...request, credentials: { ...newPair, password: 'bad\ncontrol' } },
    { ...request, credentials: { ...newPair, password: 'x'.repeat(4097) } },
    { ...request, credentials: { ...newPair, token: 'unexpected' } },
    { ...request, mode: 'clear-stored', credentials: undefined },
    { ...request, provider: { ...core, baseUrl: 'https://unreviewed.fixture.invalid' } }
  ]) await assert.rejects(f.manager.recover(bad), { code: 'VALIDATION_ERROR' });
  assert.equal(await fs.readFile(f.secrets.file, 'utf8'), before);
  await f.manager.recover(request); await assertUsable(f);
});

test('healthy sources have no repair action and recovery cannot resurrect a removed source', async (t) => {
  const f = await fixture(t);
  assert.equal(f.manager.list()[0].credentialRecovery, undefined);
  await block(f); const request = intent(f);
  await f.manager.remove(core.id);
  await assert.rejects(f.manager.recover(request), { code: 'PROVIDER_RECOVERY_STALE' });
  assert.deepEqual(f.state.get(['providers']), []);
});

for (const change of ['configuration', 'credentials', 'rollback-episode']) {
  test(`stale review after ${change} is rejected without adopting a replacement token`, async (t) => {
    const f = await fixture(t); await block(f); const request = intent(f);
    if (change === 'configuration') await f.state.mutate((draft) => { draft.providers[0].name = 'Changed source'; });
    else if (change === 'credentials') await f.secrets.set(`provider:${core.id}:password`, 'synthetic-elsewhere');
    else {
      await assert.rejects(f.secrets.transaction({ [`provider:${core.id}:password`]: 'synthetic-intermediate' }, async () => { throw new Error('Synthetic rollback'); }), /Synthetic rollback/);
    }
    const before = await fs.readFile(f.secrets.file, 'utf8');
    await assert.rejects(f.manager.recover(request), { code: 'PROVIDER_RECOVERY_STALE' });
    assert.equal(await fs.readFile(f.secrets.file, 'utf8'), before);
    const fresh = intent(f); assert.notEqual(fresh.token, request.token);
    await f.manager.recover(fresh); await assertUsable(f);
  });
}

test('unrelated secret publication does not invalidate another source review', async (t) => {
  const f = await fixture(t); await block(f); const request = intent(f);
  await f.secrets.set('provider:unrelated:password', 'synthetic-unrelated');
  assert.equal(intent(f).token, request.token);
  await f.manager.recover(request); await assertUsable(f);
});

test('consumed review cannot repair a later identical recovery episode', async (t) => {
  const f = await fixture(t); await block(f); const request = intent(f);
  await f.manager.recover(request); await block(f);
  await assert.rejects(f.manager.recover(request), { code: 'PROVIDER_RECOVERY_STALE' });
  await f.manager.recover(intent(f)); await assertUsable(f);
});

test('a retained old-destination adapter cannot read newly repaired credentials', async (t) => {
  const f = await fixture(t); const retained = f.manager.instances.get(core.id);
  await f.state.mutate((draft) => { draft.providers[0].baseUrl = 'https://changed.fixture.invalid'; });
  f.manager.refresh();
  await f.manager.recover(intent(f));
  assert.equal(await retained.authorizationHeader(), null);
  await assertUsable(f);
});

test('recovery owns same-ID admission and shutdown drain until active metadata is finalized', async (t) => {
  const f = await fixture(t); await block(f); const request = intent(f);
  const entered = deferred(); const release = deferred(); const original = f.secrets.set.bind(f.secrets);
  t.mock.method(f.secrets, 'set', async (...args) => { entered.resolve(); await release.promise; return original(...args); });
  const recovery = f.manager.recover(request); await entered.promise;
  await assert.rejects(f.manager.recover(request), { code: 'PROVIDER_BUSY' });
  await assert.rejects(f.manager.upsert({ provider: core, credentials: newPair }), { code: 'PROVIDER_BUSY' });
  await assert.rejects(f.manager.remove(core.id), { code: 'PROVIDER_BUSY' });
  assert.equal(await f.manager.instances.get(core.id).authorizationHeader(), null);
  let drained = false; const shutdown = f.manager.shutdown().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release.resolve(); await recovery; await shutdown;
  assert.equal(drained, true);
  await assertUsable({ ...await f.reopen(), config: f.config });
});

test('configuration changes while recovery waits for the state queue are not overwritten', async (t) => {
  const f = await fixture(t); await block(f); const request = intent(f);
  const entered = deferred(); const release = deferred();
  const competing = f.state.mutate(async (draft) => { entered.resolve(); await release.promise; draft.providers[0].baseUrl = 'https://concurrent.fixture.invalid'; });
  await entered.promise;
  const repair = f.manager.recover(request); const rejected = assert.rejects(repair, { code: 'PROVIDER_RECOVERY_STALE' });
  release.resolve(); await competing; await rejected;
  assert.equal(f.state.get(['providers', 0, 'baseUrl']), 'https://concurrent.fixture.invalid');
  assert.equal(f.secrets.get(`provider:${core.id}:password`), oldPair.password);
  assert.equal(f.manager.candidates('block').length, 0);
});

for (const stage of ['initial-secret', 'state', 'rollback', 'active-marker', 'refresh']) {
  test(`${stage} failure preserves truthful recovery outcome and durable routing protection`, async (t) => {
    const f = await fixture(t); await block(f); const request = intent(f);
    const injected = Object.assign(new Error('Synthetic recovery I/O failure'), { code: 'EIO' });
    if (stage === 'active-marker') t.mock.method(f.secrets, 'set', async () => { throw injected; });
    else if (stage === 'refresh') t.mock.method(f.manager, 'refresh', () => { throw injected; });
    else {
      const original = fs.rename; let secretWrites = 0;
      t.mock.method(fs, 'rename', async (from, to) => {
        if (to === f.secrets.file) secretWrites++;
        if ((stage === 'initial-secret' && to === f.secrets.file && secretWrites === 1)
          || ((stage === 'state' || stage === 'rollback') && to === f.state.file)
          || (stage === 'rollback' && to === f.secrets.file && secretWrites === 2)) throw injected;
        return original(from, to);
      });
    }
    const failure = await f.manager.recover(request).catch((error) => error);
    assert.equal(failure.details?.providerMutationCommitted === true, stage === 'active-marker' || stage === 'refresh');
    if (stage === 'rollback') assert.equal(failure.code, 'SECURE_STORAGE_ROLLBACK_FAILED');
    else if (stage === 'active-marker' || stage === 'refresh') {
      assert.equal(failure.code, 'INTERNAL_ERROR', 'Committed outcomes use the existing public error serializer');
      assert.equal(failure.cause, injected, 'Keep the original native error as the local cause');
    } else assert.equal(failure.code, 'EIO');
    t.mock.restoreAll();
    if (!['active-marker', 'refresh'].includes(stage)) {
      await assert.rejects(f.manager.recover(request), { code: 'PROVIDER_RECOVERY_STALE' }, 'An admitted failed episode consumes its review');
    }
    const reopened = { ...await f.reopen(), config: f.config };
    if (stage === 'refresh') await assertUsable(reopened);
    else {
      assert.equal(reopened.manager.candidates('block').length, 0);
      assert.equal(await reopened.manager.instances.get(core.id).authorizationHeader(), null);
    }
    assert.deepEqual(reopened.state.get(['providers']), [f.config]);
});
}

test('unavailable encryption cannot clear or replace authentication through recovery', async (t) => {
  const f = await fixture(t); await block(f); const request = intent(f);
  const before = await fs.readFile(f.secrets.file, 'utf8');
  f.secrets.safeStorage.isEncryptionAvailable = () => false;
  await assert.rejects(f.manager.recover(request), { code: 'PROVIDER_RECOVERY_STALE' });
  const unavailableReview = intent(f);
  await assert.rejects(f.manager.recover(unavailableReview), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  assert.equal(await fs.readFile(f.secrets.file, 'utf8'), before);
  f.secrets.safeStorage.isEncryptionAvailable = () => true;
  await f.manager.recover(intent(f)); await assertUsable(f);
});

test('restored volatile rollback quarantine has an explicit repair without changing normal upsert behavior', async (t) => {
  const f = await fixture(t);
  f.manager.blockedProviders.add(core.id);
  f.manager.blockedProviderErrors.set(core.id, { code: 'SECURE_STORAGE_ROLLBACK_FAILED', message: 'Synthetic interrupted rollback' });
  const request = intent(f);
  await f.manager.recover(request);
  assert.equal(f.manager.blockedProviders.has(core.id), false);
  await assertUsable(f);
});

for (const config of [
  { ...core, type: 'ord-server' },
  { ...core, type: 'mempool' },
  { ...core, cookieFile: '/synthetic/existing.cookie' }
]) {
  test(`clear-stored recovery preserves later credential-free ${config.type}/${config.cookieFile ? 'cookie' : 'public'} edits`, async (t) => {
    const f = await fixture(t, config, {});
    // The same ordinary edit works before recovery without introducing Basic auth.
    await f.manager.upsert({ provider: { ...config, baseUrl: 'https://before.fixture.invalid' }, credentials: {} });
    await block(f, 'invalid'); await f.manager.recover(intent(f));
    const edited = { ...config, baseUrl: 'https://after.fixture.invalid', network: 'signet',
      ...(config.cookieFile ? { cookieFile: '/synthetic/replacement.cookie' } : {}) };
    await f.manager.upsert({ provider: edited, credentials: {} });
    const reopened = await f.reopen();
    assert.deepEqual(reopened.state.get(['providers']), [edited]);
    assert.equal(reopened.manager.list()[0].routingBlocked, undefined);
    assert.equal(reopened.secrets.has(`provider:${core.id}:username`), false);
    assert.equal(reopened.secrets.has(`provider:${core.id}:password`), false);
  });
}

test('Core recovery can explicitly preserve no stored authentication without inventing a Basic pair', async (t) => {
  const f = await fixture(t, core, {});
  assert.equal(await f.manager.instances.get(core.id).authorizationHeader(), null);
  await block(f, 'invalid');
  const { id, token } = intent(f);
  await f.manager.recover({ id, token, mode: 'clear-stored' });
  assert.equal(await f.manager.candidates('block')[0].authorizationHeader(), null);
  const edited = { ...core, baseUrl: 'https://no-auth-edited.fixture.invalid' };
  await f.manager.upsert({ provider: edited, credentials: {} });
  const reopened = await f.reopen();
  assert.equal(reopened.manager.list()[0].routingBlocked, undefined);
  assert.equal(await reopened.manager.candidates('block')[0].authorizationHeader(), null);
  assert.equal(reopened.secrets.has(`provider:${core.id}:username`), false);
  assert.equal(reopened.secrets.has(`provider:${core.id}:password`), false);
});

for (const stage of ['state', 'active-marker']) {
  test(`post-recovery credential-free edit retains transaction protection on ${stage} failure`, async (t) => {
    const config = { ...core, type: 'mempool' };
    const f = await fixture(t, config, {});
    await block(f, 'invalid'); await f.manager.recover(intent(f));
    const injected = Object.assign(new Error('Synthetic post-recovery edit failure'), { code: 'EIO' });
    if (stage === 'state') t.mock.method(f.state, 'upsertProvider', async () => { throw injected; });
    else t.mock.method(f.secrets, 'set', async () => { throw injected; });
    const edited = { ...config, baseUrl: 'https://failed-edit.fixture.invalid' };
    const failure = await f.manager.upsert({ provider: edited, credentials: {} }).catch((error) => error);
    assert.equal(failure.details?.providerMutationCommitted === true, stage === 'active-marker');
    assert.equal(failure.code, stage === 'state' ? 'EIO' : 'INTERNAL_ERROR');
    t.mock.restoreAll();
    const reopened = await f.reopen();
    assert.deepEqual(reopened.state.get(['providers']), [stage === 'state' ? config : edited]);
    assert.equal(reopened.manager.list()[0].routingBlocked === true, stage === 'active-marker');
    assert.equal(reopened.secrets.has(`provider:${core.id}:username`), false);
    assert.equal(reopened.secrets.has(`provider:${core.id}:password`), false);
  });
}
