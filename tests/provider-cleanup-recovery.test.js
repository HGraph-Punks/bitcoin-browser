import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/main/state-store.js';
import { SecureStore } from '../src/main/secure-store.js';
import { ProviderManager } from '../src/main/provider-manager.js';

const provider = { id: 'cleanup-source', name: 'Synthetic cleanup source', type: 'bitcoin-core', network: 'mainnet',
  baseUrl: 'https://cleanup.fixture.invalid', cookieFile: '', local: false, priority: 1, enabled: true, capabilities: ['block'] };
const credentials = { username: 'synthetic-user', password: 'synthetic-password' };
const key = `provider-credential-state:${provider.id}`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, config = provider, pair = credentials) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cleanup-recovery-'));
  const stores = [];
  const reopen = async () => {
    const state = new StateStore(path.join(directory, 'state'), null);
    const secrets = new SecureStore(path.join(directory, 'secure'), { isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`synthetic:${value}`), decryptString: value => value.toString().replace(/^synthetic:/, '') }, null);
    await state.init(); await secrets.init(); stores.push(state, secrets);
    return { state, secrets, manager: new ProviderManager(state, secrets, null) };
  };
  t.after(async () => { await Promise.all(stores.map(s => s.queue)); await fs.rm(directory, { recursive: true, force: true }); });
  const f = await reopen();
  await f.state.mutate(draft => { draft.providers = []; draft.settings.localOnly = false; });
  await f.manager.upsert({ provider: config, credentials: pair });
  await f.state.updateSettings({ preferredProviderId: config.id });
  return { ...f, reopen, directory };
}

async function interruptedRemoval(f) {
  const original = f.secrets.deletePrefix;
  f.secrets.deletePrefix = async () => { throw Object.assign(new Error('Synthetic cleanup failure'), { code: 'EIO' }); };
  try { await assert.rejects(f.manager.remove(provider.id), { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED' }); }
  finally { f.secrets.deletePrefix = original; }
}

function reviewed(f) {
  const item = f.manager.cleanupList().find(item => item.id === provider.id);
  assert.ok(item, 'A confirmed removed-source cleanup must remain discoverable');
  assert.ok(item.token); return { id: item.id, token: item.token };
}

test('interrupted removal persists a non-secret obligation atomically with source/preference removal across restart', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  const reopened = await f.reopen();
  assert.deepEqual(reopened.state.get(['providers']), []);
  assert.equal(reopened.state.get(['settings', 'preferredProviderId']), null);
  const records = reopened.state.get(['providerCleanups']);
  assert.equal(records?.length, 1, 'Restart must retain the cleanup obligation outside renderer memory');
  assert.deepEqual(Object.keys(records[0]).sort(), ['generation', 'id']);
  assert.equal(records[0].id, provider.id);
  assert.match(records[0].generation, /^[a-f0-9-]{36}$/);
  assert.equal(reopened.manager.cleanupList()[0].generation, records[0].generation);
  assert.equal(reopened.secrets.has(key), true);
});

test('dedicated cleanup deletes only reviewed absent-source fields and acknowledges the exact ledger generation', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  await f.secrets.set('provider:unrelated:password', 'synthetic-unrelated');
  const request = reviewed(f); await f.manager.cleanup(request);
  const reopened = await f.reopen();
  assert.deepEqual(reopened.manager.cleanupList(), []);
  assert.equal(reopened.secrets.has(key), false);
  assert.equal(reopened.secrets.has(`provider:${provider.id}:username`), false);
  assert.equal(reopened.secrets.has(`provider:${provider.id}:password`), false);
  assert.equal(reopened.secrets.get('provider:unrelated:password'), 'synthetic-unrelated');
  await reopened.manager.upsert({ provider, credentials });
  assert.equal(reopened.manager.list()[0].routingBlocked, undefined);
  await assert.rejects(reopened.manager.cleanup(request), { code: 'PROVIDER_CLEANUP_STALE' });
  assert.equal(reopened.secrets.get(`provider:${provider.id}:password`), credentials.password);
});

test('a confirmed pending cleanup blocks ordinary reuse and direct source insertion', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  const reopened = await f.reopen();
  await assert.rejects(reopened.manager.upsert({ provider, credentials }), { code: 'PROVIDER_CLEANUP_REQUIRED' });
  await assert.rejects(reopened.state.mutate(draft => { draft.providers.push(provider); }), { code: 'PROVIDER_CLEANUP_REQUIRED' });
  assert.deepEqual(reopened.state.get(['providers']), []);
  await reopened.manager.cleanup(reviewed(reopened));
  await reopened.state.mutate(draft => { draft.providers.push(provider); });
  assert.equal(reopened.state.get(['providers', 0, 'id']), provider.id);
});

test('general absent-source remove refuses unresolved cleanup instead of racing a replacement configuration', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  await assert.rejects(f.manager.remove(provider.id), { code: 'PROVIDER_CLEANUP_REQUIRED' });
  assert.equal(f.secrets.has(key), true);
});

test('explicit historical-ID review is read-only, does not enumerate or decrypt, and requires fresh cleanup approval', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  // Model an older primary without the newly introduced non-secret ledger.
  await f.state.mutate(draft => { delete draft.providerCleanups; });
  const beforeState = await fs.readFile(f.state.file, 'utf8');
  const beforeSecrets = await fs.readFile(f.secrets.file, 'utf8');
  const originalGet = f.secrets.get;
  f.secrets.get = () => { throw new Error('Review must not decrypt'); };
  let review;
  try { review = f.manager.reviewCleanup(provider.id); }
  finally { f.secrets.get = originalGet; }
  assert.equal(review.generation, null); assert.ok(review.token);
  assert.equal(await fs.readFile(f.state.file, 'utf8'), beforeState);
  assert.equal(await fs.readFile(f.secrets.file, 'utf8'), beforeSecrets);
  await f.manager.cleanup({ id: review.id, token: review.token });
  assert.deepEqual(f.manager.cleanupList(), []); assert.equal(f.secrets.has(key), false);
});

test('ordinary credential-free public removal remains possible without OS encryption and repeated removal is benign', async t => {
  const f = await fixture(t, { ...provider, type: 'mempool' }, {});
  f.secrets.safeStorage.isEncryptionAvailable = () => false;
  await f.manager.remove(provider.id); await f.manager.remove(provider.id);
  assert.deepEqual(f.state.get(['providers']), []);
});

test('cleanup token changes after retained credentials change and consumed failed requests cannot replay', async t => {
  const f = await fixture(t); await interruptedRemoval(f); const stale = reviewed(f);
  await f.secrets.set(`provider:${provider.id}:password`, 'synthetic-changed');
  await assert.rejects(f.manager.cleanup(stale), { code: 'PROVIDER_CLEANUP_STALE' });
  const fresh = reviewed(f); assert.notEqual(fresh.token, stale.token);
  const original = f.state.beginProviderCleanup;
  f.state.beginProviderCleanup = async () => { throw Object.assign(new Error('Synthetic ledger failure'), { code: 'EIO' }); };
  await assert.rejects(f.manager.cleanup(fresh));
  f.state.beginProviderCleanup = original;
  await assert.rejects(f.manager.cleanup(fresh), { code: 'PROVIDER_CLEANUP_STALE' });
  await f.manager.cleanup(reviewed(f)); assert.equal(f.secrets.has(key), false);
});

test('cleanup owns shutdown and same-ID admission through final ledger acknowledgement', async t => {
  const f = await fixture(t); await interruptedRemoval(f); const request = reviewed(f);
  const entered = deferred(), release = deferred();
  const original = f.state.completeProviderCleanup.bind(f.state);
  f.state.completeProviderCleanup = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const cleanup = f.manager.cleanup(request); await entered.promise;
  await assert.rejects(f.manager.cleanup(request), { code: 'PROVIDER_BUSY' });
  await assert.rejects(f.manager.upsert({ provider, credentials }), { code: 'PROVIDER_BUSY' });
  await assert.rejects(f.manager.remove(provider.id), { code: 'PROVIDER_BUSY' });
  let stopped = false; const shutdown = f.manager.shutdown().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release.resolve(); await cleanup; await shutdown;
  assert.equal(stopped, true); assert.deepEqual((await f.reopen()).manager.cleanupList(), []);
});

test('historical cleanup rejects a replacement committed ahead of its queued absence reservation', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  await f.state.mutate(draft => { delete draft.providerCleanups; });
  const review = f.manager.reviewCleanup(provider.id);
  const entered = deferred(), release = deferred();
  const replacement = { ...provider, name: 'Queued replacement', baseUrl: 'https://replacement.fixture.invalid' };
  const insertion = f.state.mutate(async draft => { entered.resolve(); await release.promise; draft.providers.push(replacement); });
  t.after(() => release.resolve()); await entered.promise;
  const cleanup = f.manager.cleanup({ id: review.id, token: review.token });
  const rejected = assert.rejects(cleanup, { code: 'PROVIDER_CLEANUP_STALE' });
  release.resolve(); await insertion; await rejected;
  assert.equal(f.state.get(['providers', 0, 'baseUrl']), replacement.baseUrl);
  assert.equal(f.secrets.get(`provider:${provider.id}:password`), credentials.password);
  assert.equal(f.secrets.has(key), true);
  await assert.rejects(f.manager.cleanup({ id: review.id, token: review.token }), { code: 'PROVIDER_CLEANUP_STALE' });
});

test('configured removal rejects a queued configuration change and rolls back its tombstone', async t => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  const edit = f.state.mutate(async draft => { entered.resolve(); await release.promise; draft.providers[0].name = 'Changed before removal'; });
  t.after(() => release.resolve()); await entered.promise;
  const rejected = assert.rejects(f.manager.remove(provider.id), { code: 'PROVIDER_CLEANUP_STALE' });
  release.resolve(); await edit; await rejected;
  assert.equal(f.state.get(['providers', 0, 'name']), 'Changed before removal');
  assert.equal(JSON.parse(f.secrets.get(key)).status, 'active');
  assert.equal(f.secrets.get(`provider:${provider.id}:password`), credentials.password);
  assert.deepEqual(f.manager.cleanupList(), []);
});

test('queued insertion cannot remove a pending ledger and reuse its ID in the same mutation', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  const entered = deferred(), release = deferred();
  const holding = f.state.mutate(async () => { entered.resolve(); await release.promise; });
  t.after(() => release.resolve()); await entered.promise;
  const insertion = f.state.mutate(draft => { draft.providerCleanups = []; draft.providers.push(provider); });
  const rejected = assert.rejects(insertion, { code: 'PROVIDER_CLEANUP_REQUIRED' });
  release.resolve(); await holding; await rejected;
  assert.equal(f.state.getProviderCleanups().length, 1);
  assert.deepEqual(f.state.get(['providers']), []);
});

for (const stage of ['tombstone', 'prefix', 'metadata', 'acknowledgement']) {
  test(`dedicated cleanup ${stage} failure retains a durable obligation and requires new review after restart`, async t => {
    const f = await fixture(t); await interruptedRemoval(f);
    const request = reviewed(f);
    const failure = Object.assign(new Error(`Synthetic ${stage} failure`), { code: 'EIO' });
    if (stage === 'tombstone') f.secrets.transaction = async () => { throw failure; };
    if (stage === 'prefix') f.secrets.deletePrefix = async () => { throw failure; };
    if (stage === 'metadata') f.secrets.delete = async () => { throw failure; };
    if (stage === 'acknowledgement') f.state.completeProviderCleanup = async () => { throw failure; };
    await assert.rejects(f.manager.cleanup(request), error => error.code === 'PROVIDER_CREDENTIAL_CLEANUP_FAILED'
      && error.details.providerMutationCommitted === true && error.details.cleanupCompleted === false && error.cause === failure);
    const reopened = await f.reopen();
    assert.equal(reopened.state.getProviderCleanups().length, 1);
    assert.deepEqual(reopened.state.get(['providers']), []);
    await assert.rejects(reopened.manager.cleanup(request), { code: 'PROVIDER_CLEANUP_STALE' });
    await reopened.manager.cleanup(reviewed(reopened));
    assert.deepEqual((await f.reopen()).manager.cleanupList(), []);
    assert.equal(reopened.secrets.has(key), false);
    assert.equal(reopened.secrets.has(`provider:${provider.id}:password`), false);
  });
}

test('unreadable retained storage never becomes an empty cleanup success or deletion review', async t => {
  const f = await fixture(t); await interruptedRemoval(f); const request = reviewed(f);
  await fs.writeFile(f.secrets.file, '{synthetic unreadable storage', 'utf8');
  const reopened = await f.reopen();
  assert.equal(reopened.secrets.loadStatus, 'unavailable');
  assert.throws(() => reopened.manager.cleanupList(), { code: 'SECURE_STORAGE_STATE_UNAVAILABLE' });
  assert.throws(() => reopened.manager.reviewCleanup(provider.id), { code: 'SECURE_STORAGE_STATE_UNAVAILABLE' });
  await assert.rejects(reopened.manager.cleanup(request), { code: 'SECURE_STORAGE_STATE_UNAVAILABLE' });
  await assert.rejects(reopened.manager.remove(provider.id), { code: 'SECURE_STORAGE_STATE_UNAVAILABLE' });
  assert.equal(await fs.readFile(reopened.secrets.file, 'utf8'), '{synthetic unreadable storage');
  assert.equal(reopened.state.getProviderCleanups().length, 1);
});

test('cleanup list and exact-ID review use presence metadata without native availability probes or decryption', async t => {
  const f = await fixture(t); await interruptedRemoval(f);
  f.secrets.get = () => { throw new Error('No decryption during review'); };
  f.secrets.available = () => { throw new Error('No OS availability probe during review'); };
  const first = reviewed(f), second = f.manager.reviewCleanup(provider.id);
  assert.equal(first.token, second.token);
  assert.equal(second.conflict, false);
});

test('configured-ID cleanup conflict and malformed ledger cannot authorize retained credential deletion', async t => {
  const f = await fixture(t);
  await f.state.mutate(draft => { draft.providerCleanups = [{ id: provider.id, generation: '11111111-1111-4111-8111-111111111111' }]; });
  const review = f.manager.cleanupList()[0];
  assert.equal(review.conflict, true); assert.equal(review.token, null);
  assert.equal(f.manager.list()[0].routingError.code, 'PROVIDER_CLEANUP_CONFLICT');
  assert.throws(() => f.manager.reviewCleanup(provider.id), { code: 'PROVIDER_CLEANUP_STALE' });
  await assert.rejects(f.manager.upsert({ provider, credentials }), { code: 'PROVIDER_CLEANUP_REQUIRED' });
  await f.state.mutate(draft => { draft.providerCleanups = { invalid: true }; });
  assert.throws(() => f.manager.cleanupList(), { code: 'PROVIDER_CLEANUP_STATE_INVALID' });
  assert.equal(f.manager.list()[0].routingError.code, 'PROVIDER_CLEANUP_STATE_INVALID');
  assert.equal(f.secrets.get(`provider:${provider.id}:password`), credentials.password);
});

test('invalid cleanup authority is rejected before consuming the legitimate review or changing storage', async t => {
  const f = await fixture(t); await interruptedRemoval(f); const request = reviewed(f);
  const before = await fs.readFile(f.secrets.file, 'utf8');
  for (const invalid of [null, [], {}, { ...request, id: 'bad:id' }, { ...request, token: '' }, { ...request, generation: 'injected' }, { ...request, credentials }]) {
    await assert.rejects(f.manager.cleanup(invalid), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(await fs.readFile(f.secrets.file, 'utf8'), before);
  await f.manager.cleanup(request);
  assert.deepEqual(f.manager.cleanupList(), []);
});

for (const operation of ['remove', 'cleanup']) {
  test(`empty decrypted recovery metadata cannot survive acknowledged ${operation}`, async t => {
    const f = await fixture(t, { ...provider, type: 'mempool' }, {});
    await f.secrets.set(key, '');
    assert.equal(f.secrets.has(key), true);
    if (operation === 'remove') await f.manager.remove(provider.id);
    else {
      await f.state.removeProvider(provider.id);
      const review = f.manager.reviewCleanup(provider.id);
      await f.manager.cleanup({ id: review.id, token: review.token });
    }
    assert.equal(f.secrets.has(key), false, 'Acknowledged cleanup must delete present but empty metadata');
    assert.deepEqual(f.manager.cleanupList(), []);
  });
}
