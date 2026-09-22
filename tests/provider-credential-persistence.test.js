import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProviderManager } from '../src/main/provider-manager.js';
import { SecureStore } from '../src/main/secure-store.js';
import { StateStore } from '../src/main/state-store.js';

const FIXTURE_ROOT = '/synthetic/provider-credential-persistence';
const OLD_CREDENTIALS = { username: 'fixture-old-user', password: 'fixture-old-password' };
const NEW_CREDENTIALS = { username: 'fixture-new-user', password: 'fixture-new-password' };
const OLD_PROVIDER = {
  id: 'fixture-core', name: 'Fixture Core', type: 'bitcoin-core', network: 'mainnet',
  baseUrl: 'https://old.fixture.invalid', enabled: true, priority: 1,
  local: false, capabilities: ['block'], cookieFile: ''
};
const NEW_PROVIDER = { ...OLD_PROVIDER, baseUrl: 'https://new.fixture.invalid' };
const FALLBACK = {
  id: 'fixture-fallback', name: 'Fixture fallback', type: 'mock', network: 'mainnet',
  baseUrl: '', enabled: true, priority: 20, local: true, capabilities: ['block']
};

function basic(credentials) {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

function filesystemError(code, message) {
  return Object.assign(new Error(message), { code });
}

// These mocks model persistent files across store reconstruction. Every file is
// synthetic, every secret is a fixture, and no OS storage or transport is used.
function memoryFilesystem(t) {
  const files = new Map();
  const renameFailures = [];
  const checked = (file) => {
    assert.equal(typeof file, 'string');
    assert.ok(file === FIXTURE_ROOT || file.startsWith(`${FIXTURE_ROOT}/`), `Unexpected filesystem target: ${file}`);
    return file;
  };
  const read = (file) => {
    checked(file);
    if (!files.has(file)) throw filesystemError('ENOENT', 'Synthetic file is missing');
    return files.get(file);
  };
  t.mock.method(fs, 'mkdir', async (directory) => { checked(directory); });
  t.mock.method(fs, 'readFile', async (file) => read(file));
  t.mock.method(fs, 'writeFile', async (file, data) => {
    files.set(checked(file), String(data));
  });
  t.mock.method(fs, 'copyFile', async (source, destination) => {
    files.set(checked(destination), read(source));
  });
  t.mock.method(fs, 'rename', async (source, destination) => {
    checked(source);
    checked(destination);
    if (renameFailures[0] === destination) {
      renameFailures.shift();
      throw filesystemError('EACCES', 'Synthetic persistence failure');
    }
    files.set(destination, read(source));
    files.delete(source);
  });
  t.mock.method(fs, 'readdir', async (directory) => {
    checked(directory);
    return [...files.keys()].filter((file) => path.dirname(file) === directory)
      .map((file) => ({ name: path.basename(file), isFile: () => true }));
  });
  t.mock.method(fs, 'lstat', async (file) => {
    read(file);
    return { isFile: () => true };
  });
  t.mock.method(fs, 'rm', async (file) => { files.delete(checked(file)); });
  return {
    failRenames(...destinations) { renameFailures.push(...destinations.map(checked)); },
    assertFailuresConsumed() { assert.deepEqual(renameFailures, [], 'Every injected failure must have occurred'); },
    corrupt(file) { read(file); files.set(file, '{synthetic corrupt JSON'); }
  };
}

async function fixture(t, { legacyPrimary = false } = {}) {
  const disk = memoryFilesystem(t);
  const loaded = [];
  const reopen = async () => {
    const stateStore = new StateStore(`${FIXTURE_ROOT}/state`, null);
    const secureStore = new SecureStore(`${FIXTURE_ROOT}/secure`, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`fixture-protected:${value}`),
      decryptString: (value) => value.toString().replace(/^fixture-protected:/, '')
    }, null);
    loaded.push({ stateStore, secureStore });
    await stateStore.init();
    await secureStore.init();
    return { stateStore, secureStore, manager: new ProviderManager(stateStore, secureStore, null) };
  };
  // Await existing queues without StateStore.flush(), which would deliberately
  // replace the old backup and erase the backup-recovery condition under test.
  t.after(async () => {
    await Promise.all(loaded.flatMap(({ stateStore, secureStore }) => [stateStore.queue, secureStore.queue]));
  });
  if (legacyPrimary) {
    // A real old-release primary lacks recovery provenance. Overriding the
    // transient recoveryStatus on a defaults-created store is not equivalent.
    await fs.writeFile(`${FIXTURE_ROOT}/state/state.json`, JSON.stringify({
      schemaVersion: 3, settings: { localOnly: false }, providers: [FALLBACK]
    }));
  }
  const current = await reopen();
  await current.stateStore.updateSettings({ localOnly: false });
  await current.stateStore.mutate((draft) => { draft.providers = [FALLBACK]; });
  await current.manager.upsert({ provider: OLD_PROVIDER, credentials: OLD_CREDENTIALS });
  return { ...current, disk, reopen };
}

async function routedCredentialDestinations(manager) {
  const observations = [];
  for (const provider of manager.candidates('block')) {
    if (provider.type !== 'bitcoin-core') continue;
    observations.push({
      id: provider.id,
      destination: provider.config.baseUrl,
      authorization: await provider.authorizationHeader()
    });
  }
  return observations;
}

async function assertCoherentRoute(manager, provider, credentials) {
  assert.deepEqual(await routedCredentialDestinations(manager), [{
    id: provider.id, destination: provider.baseUrl, authorization: basic(credentials)
  }]);
  assert.ok(manager.candidates('block').some(({ id }) => id === FALLBACK.id));
}

test('full credential and endpoint edits remain coherent after reopening both stores', async (t) => {
  const current = await fixture(t);
  await current.manager.upsert({ provider: NEW_PROVIDER, credentials: NEW_CREDENTIALS });
  await assertCoherentRoute(current.manager, NEW_PROVIDER, NEW_CREDENTIALS);
  const reopened = await current.reopen();
  await assertCoherentRoute(reopened.manager, NEW_PROVIDER, NEW_CREDENTIALS);
});

test('ordinary partial and blank credential edits retain the known password after reopening', async (t) => {
  const current = await fixture(t);
  const credentials = { ...OLD_CREDENTIALS, username: 'fixture-edited-user' };
  await current.manager.upsert({ provider: OLD_PROVIDER, credentials: { username: credentials.username } });
  await current.manager.upsert({ provider: OLD_PROVIDER, credentials: { username: '', password: '' } });
  await assertCoherentRoute(current.manager, OLD_PROVIDER, credentials);
  const reopened = await current.reopen();
  await assertCoherentRoute(reopened.manager, OLD_PROVIDER, credentials);
});

test('security-relevant destination changes require a complete replacement pair before state mutation', async (t) => {
  const current = await fixture(t);
  await assert.rejects(current.manager.upsert({ provider: NEW_PROVIDER, credentials: {} }), { code: 'PROVIDER_CREDENTIAL_REENTRY_REQUIRED' });
  await assert.rejects(current.manager.upsert({ provider: NEW_PROVIDER, credentials: { password: NEW_CREDENTIALS.password } }), { code: 'PROVIDER_CREDENTIAL_REENTRY_REQUIRED' });
  assert.deepEqual(current.stateStore.get(['providers']).find(({ id }) => id === OLD_PROVIDER.id), OLD_PROVIDER);
  await assertCoherentRoute(current.manager, OLD_PROVIDER, OLD_CREDENTIALS);
});

test('legacy primary credentials cannot be rebound to another endpoint without complete re-entry', async (t) => {
  const current = await fixture(t, { legacyPrimary: true });
  await current.secureStore.delete(`provider-credential-state:${OLD_PROVIDER.id}`);
  await assert.rejects(current.manager.upsert({ provider: NEW_PROVIDER, credentials: {} }), { code: 'PROVIDER_CREDENTIAL_REENTRY_REQUIRED' });
  await assert.rejects(current.manager.upsert({ provider: NEW_PROVIDER, credentials: { username: NEW_CREDENTIALS.username } }), { code: 'PROVIDER_CREDENTIAL_REENTRY_REQUIRED' });
  await assertCoherentRoute(current.manager, OLD_PROVIDER, OLD_CREDENTIALS);
});

test('switching bound basic authentication to cookie authentication deletes dormant secrets atomically', async (t) => {
  const current = await fixture(t); const cookie = { ...OLD_PROVIDER, cookieFile: '/synthetic/bitcoin.cookie' };
  await current.manager.upsert({ provider: cookie, credentials: {} });
  assert.equal(current.secureStore.get(`provider:${OLD_PROVIDER.id}:username`), null);
  assert.equal(current.secureStore.get(`provider:${OLD_PROVIDER.id}:password`), null);
  const reopened = await current.reopen();
  const descriptor = reopened.manager.list().find(({ id }) => id === OLD_PROVIDER.id);
  assert.equal(descriptor.cookieFile, cookie.cookieFile); assert.equal(descriptor.credentialsStored, false); assert.equal(descriptor.routingBlocked, undefined);
});

test('switching legacy basic authentication to cookie authentication also clears unbound dormant secrets', async (t) => {
  const current = await fixture(t, { legacyPrimary: true });
  await current.secureStore.delete(`provider-credential-state:${OLD_PROVIDER.id}`);
  await current.manager.upsert({ provider: { ...OLD_PROVIDER, cookieFile: '/synthetic/legacy.cookie' }, credentials: {} });
  assert.equal(current.secureStore.get(`provider:${OLD_PROVIDER.id}:username`), null);
  assert.equal(current.secureStore.get(`provider:${OLD_PROVIDER.id}:password`), null);
});

test('public providers can be removed while encryption is unavailable without credential writes', async (t) => {
  const current = await fixture(t); current.secureStore.safeStorage.isEncryptionAvailable = () => false;
  await current.manager.remove(FALLBACK.id);
  assert.equal(current.stateStore.get(['providers']).some(({ id }) => id === FALLBACK.id), false);
});

test('non-security label edits and partial credentials preserve the bound destination', async (t) => {
  const current = await fixture(t); const edited = { ...OLD_PROVIDER, name: 'Renamed fixture', priority: 7 };
  await current.manager.upsert({ provider: edited, credentials: { username: NEW_CREDENTIALS.username } });
  await assertCoherentRoute(current.manager, edited, { username: NEW_CREDENTIALS.username, password: OLD_CREDENTIALS.password });
});

test('pending credential transaction blocks even a retained adapter from reading the new secret pair', async (t) => {
  const current = await fixture(t); const retained = current.manager.instances.get(OLD_PROVIDER.id);
  let release; let enteredResolve; const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const originalUpsert = current.stateStore.upsertProvider.bind(current.stateStore);
  t.mock.method(current.stateStore, 'upsertProvider', async (provider) => { await new Promise((resolve) => { release = resolve; enteredResolve(); }); return originalUpsert(provider); });
  const mutation = current.manager.upsert({ provider: NEW_PROVIDER, credentials: NEW_CREDENTIALS });
  await entered;
  assert.equal(await retained.authorizationHeader(), null);
  assert.deepEqual(current.manager.candidates('block').filter(({ id }) => id === OLD_PROVIDER.id), []);
  release(NEW_PROVIDER); await mutation;
  await assertCoherentRoute(current.manager, NEW_PROVIDER, NEW_CREDENTIALS);
});

test('state commit followed by active-marker failure remains committed and blocked across restart', async (t) => {
  const current = await fixture(t); const markerError = filesystemError('EIO', 'Synthetic active-marker failure');
  t.mock.method(current.secureStore, 'set', async () => { throw markerError; });
  const failure = await current.manager.upsert({ provider: NEW_PROVIDER, credentials: NEW_CREDENTIALS }).catch((error) => error);
  assert.equal(failure.code, 'INTERNAL_ERROR'); assert.equal(failure.cause, markerError);
  assert.equal(failure.details.providerMutationCommitted, true); assert.equal(failure.details.providerId, OLD_PROVIDER.id);
  assert.equal(current.stateStore.get(['providers']).find(({ id }) => id === OLD_PROVIDER.id).baseUrl, NEW_PROVIDER.baseUrl);
  assert.deepEqual(await routedCredentialDestinations(current.manager), []);
  const reopened = await current.reopen();
  assert.deepEqual(await routedCredentialDestinations(reopened.manager), []);
  assert.equal(reopened.manager.list().find(({ id }) => id === OLD_PROVIDER.id).routingError.code, 'PROVIDER_CREDENTIAL_RECOVERY_REQUIRED');
});

test('malformed encrypted binding metadata fails closed without hiding stored-credential presence', async (t) => {
  const current = await fixture(t);
  await current.secureStore.set(`provider-credential-state:${OLD_PROVIDER.id}`, '{malformed fixture metadata');
  assert.deepEqual(await routedCredentialDestinations(current.manager), []);
  const descriptor = current.manager.list().find(({ id }) => id === OLD_PROVIDER.id);
  assert.equal(descriptor.credentialsStored, true);
  assert.equal(descriptor.routingError.code, 'PROVIDER_CREDENTIAL_STATE_INVALID');
});

test('unbound legacy credentials remain usable on primary state but fail closed after backup recovery', async (t) => {
  const current = await fixture(t, { legacyPrimary: true });
  await current.secureStore.delete(`provider-credential-state:${OLD_PROVIDER.id}`);
  await assertCoherentRoute(current.manager, OLD_PROVIDER, OLD_CREDENTIALS);
  await current.stateStore.updateSettings({ requestTimeoutMs: 6_000 });
  current.disk.corrupt(current.stateStore.file);
  const reopened = await current.reopen();
  assert.equal(reopened.stateStore.recoveryStatus.source, 'backup');
  assert.deepEqual(await routedCredentialDestinations(reopened.manager), []);
  assert.equal(reopened.manager.list().find(({ id }) => id === OLD_PROVIDER.id).routingError.code, 'PROVIDER_LEGACY_CREDENTIAL_RECOVERY_REQUIRED');
});

test('successful credential rollback restores the old route across store reconstruction', async (t) => {
  const current = await fixture(t);
  current.disk.failRenames(current.stateStore.file);
  await assert.rejects(current.manager.upsert({ provider: NEW_PROVIDER, credentials: NEW_CREDENTIALS }), { code: 'EACCES' });
  current.disk.assertFailuresConsumed();
  await assertCoherentRoute(current.manager, OLD_PROVIDER, OLD_CREDENTIALS);
  const reopened = await current.reopen();
  await assertCoherentRoute(reopened.manager, OLD_PROVIDER, OLD_CREDENTIALS);
});

test('failed credential rollback cannot route the new pair to the old endpoint after reopening', async (t) => {
  const current = await fixture(t);
  current.disk.failRenames(current.stateStore.file, current.secureStore.file);
  await assert.rejects(current.manager.upsert({ provider: NEW_PROVIDER, credentials: NEW_CREDENTIALS }), {
    code: 'SECURE_STORAGE_ROLLBACK_FAILED'
  });
  current.disk.assertFailuresConsumed();
  const beforeReopen = await routedCredentialDestinations(current.manager);
  const reopened = await current.reopen();
  const afterReopen = await routedCredentialDestinations(reopened.manager);

  assert.deepEqual(beforeReopen, [], 'The affected provider must be quarantined after failed rollback');
  assert.ok(reopened.manager.candidates('block').some(({ id }) => id === FALLBACK.id));
  assert.deepEqual(afterReopen, [], 'Reopening must retain the unresolved provider quarantine');
});

for (const recovery of ['corrupt', 'missing']) {
  test(`${recovery} primary recovery never sends a successfully edited credential pair to the older backup endpoint`, async (t) => {
    const current = await fixture(t);
    await current.manager.upsert({ provider: NEW_PROVIDER, credentials: NEW_CREDENTIALS });
    await assertCoherentRoute(current.manager, NEW_PROVIDER, NEW_CREDENTIALS);
    if (recovery === 'corrupt') current.disk.corrupt(current.stateStore.file);
    else await fs.rm(current.stateStore.file);
    const reopened = await current.reopen();
    const observations = await routedCredentialDestinations(reopened.manager);

    assert.equal(reopened.stateStore.recoveryStatus.source, 'backup');
    assert.ok(reopened.manager.candidates('block').some(({ id }) => id === FALLBACK.id));
    assert.deepEqual(observations.filter(({ authorization, destination }) =>
      authorization === basic(NEW_CREDENTIALS) && destination !== NEW_PROVIDER.baseUrl), [],
    'An older backup configuration must not acquire credentials authorized for the edited endpoint');
  });
}
