import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderManager } from '../src/main/provider-manager.js';
import { AppError } from '../src/shared/errors.js';

const settings = {
  network: 'mainnet',
  localOnly: false,
  offlineMode: false,
  preferredProviderId: null,
  requestTimeoutMs: 5_000,
  maxResourceBytes: 1024 * 1024
};

const provider = (id, priority = 10) => ({
  id,
  name: `Provider ${id}`,
  type: 'mock',
  network: 'mainnet',
  baseUrl: '',
  priority,
  enabled: true,
  local: true,
  capabilities: ['block']
});

function memoryState(initialProviders) {
  let providers = structuredClone(initialProviders);
  let nextUpsertError = null;
  let nextRemoveError = null;
  let cleanups = [];
  return {
    get([key]) {
      return structuredClone(key === 'settings' ? settings : key === 'providers' ? providers : undefined);
    },
    getProviderCleanups: () => structuredClone(cleanups),
    async beginProviderCleanup(record, expectedGeneration) {
      assert.equal(providers.some(item => item.id === record.id), false);
      assert.equal(cleanups.find(item => item.id === record.id)?.generation ?? null, expectedGeneration);
      cleanups = [...cleanups.filter(item => item.id !== record.id), structuredClone(record)];
    },
    async completeProviderCleanup(id, generation) {
      assert.equal(cleanups.find(item => item.id === id)?.generation, generation);
      cleanups = cleanups.filter(item => item.id !== id);
    },
    failNextUpsert(error) { nextUpsertError = error; },
    failNextRemove(error) { nextRemoveError = error; },
    async upsertProvider(value) {
      if (nextUpsertError) {
        const error = nextUpsertError;
        nextUpsertError = null;
        throw error;
      }
      const index = providers.findIndex((item) => item.id === value.id);
      if (index === -1) providers.push(structuredClone(value));
      else providers[index] = structuredClone(value);
    },
    async removeProvider(id, record) {
      if (nextRemoveError) {
        const error = nextRemoveError;
        nextRemoveError = null;
        throw error;
      }
      providers = providers.filter((item) => item.id !== id);
      if (record) cleanups = [...cleanups.filter(item => item.id !== id), structuredClone(record)];
    }
  };
}

function rollbackThenMemoryCredentials(initial = {}) {
  const entries = new Map(Object.entries(initial));
  let rollbackFailure = true;
  let cleanupFailure = false;
  let transactionCalls = 0;
  let cleanupCalls = 0;
  let queue = Promise.resolve();
  return {
    entries,
    loadStatus: 'primary',
    has: key => entries.has(key),
    get transactionCalls() { return transactionCalls; },
    get cleanupCalls() { return cleanupCalls; },
    failCleanup(value) { cleanupFailure = value; },
    get(key) { return entries.get(key) ?? null; },
    async transaction(updates, callback) {
      transactionCalls += 1;
      if (rollbackFailure) {
        rollbackFailure = false;
        throw new AppError('SECURE_STORAGE_ROLLBACK_FAILED', 'Synthetic credential rollback failed', { status: 500 });
      }
      const operation = queue.then(async () => {
        const previous = new Map(entries);
        for (const [key, value] of Object.entries(updates)) {
          if (value === null) entries.delete(key);
          else entries.set(key, String(value));
        }
        try {
          return await callback();
        } catch (error) {
          entries.clear();
          for (const [key, value] of previous) entries.set(key, value);
          throw error;
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async deletePrefix(prefix) {
      cleanupCalls += 1;
      if (cleanupFailure) throw new Error('Synthetic credential cleanup failed');
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    }
  };
}

async function establishRollbackQuarantine(manager, value) {
  await assert.rejects(
    manager.upsert({ provider: value, credentials: { password: 'synthetic-replacement' } }),
    { code: 'SECURE_STORAGE_ROLLBACK_FAILED' }
  );
  assert.deepEqual(manager.candidates('block'), []);
  assert.equal(manager.list()[0].routingError.code, 'SECURE_STORAGE_ROLLBACK_FAILED');
}

test('failed credential-free edit cannot clear an existing rollback quarantine', async () => {
  const original = provider('quarantined-edit');
  const state = memoryState([original]);
  const secure = rollbackThenMemoryCredentials();
  const manager = new ProviderManager(state, secure, null);
  await establishRollbackQuarantine(manager, original);

  state.failNextUpsert(new AppError('STATE_WRITE_FAILED', 'Synthetic state failure'));
  await assert.rejects(manager.upsert({ provider: { ...original, name: 'Edited name' } }), { code: 'STATE_WRITE_FAILED' });

  assert.deepEqual(manager.candidates('block'), []);
  assert.equal(manager.list()[0].routingBlocked, true);
  assert.equal(manager.list()[0].routingError.code, 'SECURE_STORAGE_ROLLBACK_FAILED');
});

test('failed removal cannot clear an existing rollback quarantine', async () => {
  const original = provider('quarantined-remove');
  const state = memoryState([original]);
  const manager = new ProviderManager(state, rollbackThenMemoryCredentials(), null);
  await establishRollbackQuarantine(manager, original);

  state.failNextRemove(new AppError('STATE_WRITE_FAILED', 'Synthetic state failure'));
  await assert.rejects(manager.remove(original.id), { code: 'STATE_WRITE_FAILED' });

  assert.deepEqual(manager.candidates('block'), []);
  assert.equal(manager.list()[0].routingBlocked, true);
  assert.equal(manager.list()[0].routingError.code, 'SECURE_STORAGE_ROLLBACK_FAILED');
});

test('failed credential cleanup prevents credential-free reuse until removal cleanup is retried', async () => {
  const original = provider('orphan-zero');
  const state = memoryState([original]);
  const secure = rollbackThenMemoryCredentials({ [`provider:${original.id}:password`]: 'synthetic-old-password' });
  // Consume the synthetic rollback-only transaction mode with a harmless successful path.
  await secure.transaction({}, async () => {}).catch(() => {});
  secure.failCleanup(true);
  const manager = new ProviderManager(state, secure, null);

  await assert.rejects(manager.remove(original.id), { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED' });
  await assert.rejects(manager.upsert({ provider: original, credentials: {} }));
  assert.deepEqual(state.get(['providers']), []);
  assert.equal(secure.get(`provider:${original.id}:password`), 'synthetic-old-password');

  secure.failCleanup(false);
  const review = manager.reviewCleanup(original.id);
  await manager.cleanup({ id: review.id, token: review.token });
  await manager.upsert({ provider: original, credentials: {} });
  assert.equal(manager.list()[0].credentialsStored, false);
});

test('failed credential cleanup rejects partial-credential reuse without mutating secrets', async () => {
  const original = provider('orphan-partial');
  const state = memoryState([original]);
  const usernameKey = `provider:${original.id}:username`;
  const passwordKey = `provider:${original.id}:password`;
  const secure = rollbackThenMemoryCredentials({ [usernameKey]: 'synthetic-old-user', [passwordKey]: 'synthetic-old-password' });
  await secure.transaction({}, async () => {}).catch(() => {});
  secure.failCleanup(true);
  const manager = new ProviderManager(state, secure, null);

  await assert.rejects(manager.remove(original.id), { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED' });
  const transactionsBeforeReuse = secure.transactionCalls;
  await assert.rejects(manager.upsert({ provider: original, credentials: { password: 'synthetic-new-password' } }));

  assert.equal(secure.transactionCalls, transactionsBeforeReuse);
  assert.equal(secure.get(usernameKey), 'synthetic-old-user');
  assert.equal(secure.get(passwordKey), 'synthetic-old-password');
  assert.deepEqual(state.get(['providers']), []);
});

test('ordinary partial credential edit remains supported outside recovery', async () => {
  const original = provider('partial-edit');
  const state = memoryState([original]);
  const usernameKey = `provider:${original.id}:username`;
  const passwordKey = `provider:${original.id}:password`;
  const secure = rollbackThenMemoryCredentials({ [usernameKey]: 'synthetic-user', [passwordKey]: 'synthetic-old-password' });
  await secure.transaction({}, async () => {}).catch(() => {});
  const manager = new ProviderManager(state, secure, null);

  await manager.upsert({ provider: { ...original, name: 'Edited provider' }, credentials: { password: 'synthetic-new-password' } });

  assert.equal(secure.get(usernameKey), 'synthetic-user');
  assert.equal(secure.get(passwordKey), 'synthetic-new-password');
  assert.equal(manager.list()[0].name, 'Edited provider');
});

test('different provider ids can commit through the independent store queues without lost state', async () => {
  const first = provider('different-first', 1);
  const second = provider('different-second', 2);
  const state = memoryState([first, second]);
  const secure = rollbackThenMemoryCredentials();
  await secure.transaction({}, async () => {}).catch(() => {});
  const manager = new ProviderManager(state, secure, null);

  await Promise.all([
    manager.upsert({ provider: { ...first, name: 'First committed' }, credentials: { password: 'synthetic-first' } }),
    manager.upsert({ provider: { ...second, name: 'Second committed' }, credentials: {} })
  ]);

  assert.deepEqual(state.get(['providers']).map((item) => [item.id, item.name]), [
    [first.id, 'First committed'],
    [second.id, 'Second committed']
  ]);
  assert.deepEqual(manager.candidates('block').map((item) => item.id), [first.id, second.id]);
});
