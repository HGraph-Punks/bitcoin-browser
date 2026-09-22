import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecureStore } from '../src/main/secure-store.js';
import { AppError } from '../src/shared/errors.js';

function encryptedStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`protected:${value}`),
    decryptString: (value) => value.toString().replace(/^protected:/, '')
  };
}

test('secure store fails closed when OS encryption is unavailable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-secure-unavailable-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SecureStore(directory, encryptedStorage(false), null);
  await store.init();
  assert.equal(store.availabilityStatus(), null);
  await assert.rejects(store.set('provider:test:password', 'secret'), { code: 'SECURE_STORAGE_UNAVAILABLE', status: 503 });
  assert.equal(store.availabilityStatus(), false);
  assert.equal(store.get('provider:test:password'), null);
});

test('secure store persists only encrypted values and supports prefix deletion', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-secure-persist-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SecureStore(directory, encryptedStorage(), null);
  await store.init();
  await Promise.all([
    store.set('provider:one:username', 'alice'),
    store.set('provider:one:password', 'correct horse'),
    store.set('provider:two:password', 'battery staple')
  ]);
  assert.equal(store.availabilityStatus(), true);
  assert.equal(store.has('provider:one:username'), true);
  assert.equal(store.get('provider:one:username'), 'alice');
  const raw = await fs.readFile(path.join(directory, 'secrets.json'), 'utf8');
  assert.doesNotMatch(raw, /alice|correct horse|battery staple/);
  await store.deletePrefix('provider:one:');
  assert.equal(store.get('provider:one:username'), null);
  assert.equal(store.get('provider:one:password'), null);
  assert.equal(store.get('provider:two:password'), 'battery staple');
});

test('one rejected secure-store flush does not poison later writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-secure-queue-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SecureStore(directory, encryptedStorage(), null);
  await store.init();
  store.queue = Promise.reject(new Error('injected prior failure'));
  await assert.rejects(store.set('first', 'value'), /injected prior failure/);
  await store.set('second', 'recovered');
  assert.equal(store.get('second'), 'recovered');
});

test('credential pairs commit together and roll back when the state mutation fails', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-secure-transaction-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SecureStore(directory, encryptedStorage(), null);
  await store.init();
  await store.transaction({
    'provider:test:username': 'old-user',
    'provider:test:password': 'old-password'
  }, async () => {});

  await assert.rejects(store.transaction({
    'provider:test:username': 'new-user',
    'provider:test:password': 'new-password'
  }, async () => {
    assert.equal(store.get('provider:test:username'), 'new-user');
    assert.equal(store.get('provider:test:password'), 'new-password');
    throw new AppError('STATE_WRITE_FAILED', 'injected state failure');
  }), { code: 'STATE_WRITE_FAILED' });

  assert.equal(store.get('provider:test:username'), 'old-user');
  assert.equal(store.get('provider:test:password'), 'old-password');
  const persisted = await fs.readFile(path.join(directory, 'secrets.json'), 'utf8');
  assert.doesNotMatch(persisted, /old-user|old-password|new-user|new-password/);
  assert.match(persisted, /cHJvdGVjdGVkOm9sZC11c2Vy/);
});
