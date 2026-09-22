import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionManager } from '../src/main/extension-manager.js';

async function manifestFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Lifecycle fixture wallet', version: '1.0.0'
  }));
  return { directory, real: await fs.realpath(directory) };
}

function transactionalStore(initial = []) {
  let state = { extensions: structuredClone(initial) };
  let failure = null;
  let mutations = 0;
  return {
    get(parts) { return structuredClone(state[parts[0]]); },
    async mutate(mutator) {
      mutations += 1;
      const draft = structuredClone(state);
      await mutator(draft);
      if (failure) { const error = failure; failure = null; throw error; }
      state = draft;
    },
    failNext(error) { failure = error; },
    snapshot() { return structuredClone(state); },
    mutationCount() { return mutations; }
  };
}

function sessionFixture({ ids = ['fixture-wallet-id'] } = {}) {
  const runtime = new Map();
  const calls = { loads: [], removes: [] };
  let unloadFailure = null;
  let loadIndex = 0;
  const extensions = {
    async loadExtension(extensionPath, options) {
      calls.loads.push({ extensionPath, options });
      const loaded = { id: ids[Math.min(loadIndex++, ids.length - 1)], name: 'Runtime wallet', version: '1.0.0' };
      runtime.set(loaded.id, loaded);
      return loaded;
    },
    removeExtension(id) {
      calls.removes.push(id);
      if (unloadFailure) throw unloadFailure;
      runtime.delete(id);
    }
  };
  return { session: { extensions }, runtime, calls, failUnload(error) { unloadFailure = error; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('failed install persistence rolls back the newly loaded runtime and remains absent from configured list', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  const manager = new ExtensionManager(runtime.session, store, null);
  const persistenceError = new Error('fixture persistence failed');
  store.failNext(persistenceError);

  await assert.rejects(manager.install(fixture.directory), (error) => error === persistenceError);

  assert.deepEqual(store.snapshot().extensions, []);
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.loaded.has('fixture-wallet-id'), false);
  assert.equal(runtime.runtime.has('fixture-wallet-id'), false);
  assert.deepEqual(runtime.calls.removes, ['fixture-wallet-id']);
  assert.deepEqual(runtime.calls.loads, [{ extensionPath: fixture.real, options: { allowFileAccess: false } }]);
});

test('failed runtime unload rejects removal and preserves configured and loaded truth', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  const manager = new ExtensionManager(runtime.session, store, null);
  await manager.install(fixture.directory);
  const before = manager.list();
  const unloadError = new Error('fixture unload failed');
  runtime.failUnload(unloadError);

  await assert.rejects(manager.remove('fixture-wallet-id'), (error) => error === unloadError);

  assert.deepEqual(store.snapshot().extensions, before.map(({ loaded: _loaded, runtime: _runtime, ...entry }) => entry));
  assert.deepEqual(manager.list(), before);
  assert.equal(manager.loaded.has('fixture-wallet-id'), true);
  assert.equal(runtime.runtime.has('fixture-wallet-id'), true);
  assert.deepEqual(runtime.calls.removes, ['fixture-wallet-id']);
});

test('failed install rollback remains visibly removable when runtime cleanup also fails', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  const persistenceError = new Error('fixture persistence failed');
  const cleanupError = new Error('fixture cleanup failed');
  store.failNext(persistenceError);
  runtime.failUnload(cleanupError);
  const manager = new ExtensionManager(runtime.session, store, null);

  await assert.rejects(manager.install(fixture.directory), (error) => {
    assert.equal(error.code, 'EXTENSION_ROLLBACK_FAILED');
    assert.equal(error.details.committed, false);
    return true;
  });

  assert.deepEqual(store.snapshot().extensions, []);
  assert.equal(runtime.runtime.has('fixture-wallet-id'), true);
  assert.deepEqual(manager.list().map(({ id, loaded, persisted, error }) => ({ id, loaded, persisted, code: error?.code })), [{
    id: 'fixture-wallet-id', loaded: true, persisted: false, code: 'EXTENSION_ROLLBACK_FAILED'
  }]);

  runtime.failUnload(null);
  store.failNext(new Error('store must not be used for an unpersisted runtime'));
  assert.deepEqual(await manager.remove('fixture-wallet-id'), []);
  assert.equal(runtime.runtime.has('fixture-wallet-id'), false);
  assert.deepEqual(store.snapshot().extensions, []);
  assert.equal(store.mutationCount(), 1);
});

test('remove persistence failure reports the runtime-off configured state and retry removes config only', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  const manager = new ExtensionManager(runtime.session, store, null);
  await manager.install(fixture.directory);
  store.failNext(new Error('fixture removal save failed'));

  await assert.rejects(manager.remove('fixture-wallet-id'), (error) => {
    assert.equal(error.code, 'EXTENSION_REMOVE_SAVE_FAILED');
    assert.deepEqual(error.details, {
      id: 'fixture-wallet-id', committed: false, runtimeChanged: true, restartMayRestore: true
    });
    return true;
  });

  assert.equal(runtime.runtime.has('fixture-wallet-id'), false);
  assert.deepEqual(manager.list().map(({ id, loaded, error }) => ({ id, loaded, code: error?.code })), [{
    id: 'fixture-wallet-id', loaded: false, code: 'EXTENSION_REMOVE_SAVE_FAILED'
  }]);
  assert.deepEqual(await manager.remove('fixture-wallet-id'), []);
  assert.deepEqual(runtime.calls.removes, ['fixture-wallet-id']);
});

test('configured but unloaded extension is removable without a runtime unload', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore([{
    id: 'configured-only', name: 'Configured only', version: '1.0.0', path: fixture.real,
    manifestVersion: 3, installedAt: '2026-01-01T00:00:00.000Z'
  }]);
  const runtime = sessionFixture();
  const manager = new ExtensionManager(runtime.session, store, null);

  assert.deepEqual(await manager.remove('configured-only'), []);
  assert.deepEqual(runtime.calls.removes, []);
});

test('install save failure for an already owned runtime keeps configured state and exposes latest known runtime truth', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  let loads = 0;
  runtime.session.extensions.loadExtension = async () => {
    loads += 1;
    const loaded = loads === 1
      ? { id: 'fixture-wallet-id', name: 'Original runtime', version: '1.0.0' }
      : { id: 'fixture-wallet-id', name: 'Conflicting response', version: '9.9.9' };
    runtime.runtime.set(loaded.id, loaded);
    return loaded;
  };
  const manager = new ExtensionManager(runtime.session, store, null);
  await manager.install(fixture.directory);
  const before = manager.list()[0];
  store.failNext(new Error('fixture second save failed'));

  await assert.rejects(manager.install(fixture.directory), { code: 'EXTENSION_SAVE_FAILED' });

  assert.deepEqual(runtime.calls.removes, []);
  const after = manager.list()[0];
  assert.equal(after.loaded, true);
  assert.deepEqual(after.runtime, { ...runtime.runtime.get('fixture-wallet-id'), path: fixture.real });
  assert.equal(after.name, before.name);
  assert.equal(after.version, before.version);
  assert.equal(after.error.code, 'EXTENSION_SAVE_FAILED');
});

test('same runtime ID returned for a different requested directory does not persist the wrong path', async (t) => {
  const first = await manifestFixture(t);
  const second = await manifestFixture(t);
  const store = transactionalStore();
  const calls = { removes: [] };
  const session = { extensions: {
    async loadExtension() {
      return { id: 'shared-runtime', name: 'Shared runtime', version: '1.0.0', path: first.real };
    },
    removeExtension(id) { calls.removes.push(id); }
  } };
  const manager = new ExtensionManager(session, store, null);
  await manager.install(first.directory);

  await assert.rejects(manager.install(second.directory), (error) => {
    assert.equal(error.code, 'EXTENSION_SAVE_FAILED');
    assert.equal(error.cause?.code, 'EXTENSION_CONFIGURATION_CHANGED');
    return true;
  });

  assert.deepEqual(calls.removes, []);
  assert.equal(manager.loaded.has('shared-runtime'), true);
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0].path, first.real);
  assert.equal(manager.list()[0].runtime.path, first.real);
});

test('restore reconciliation conflict rolls back the newly assigned runtime and keeps configured failure visible', async (t) => {
  const fixture = await manifestFixture(t);
  const original = {
    id: 'persisted-id', name: 'Persisted', version: '0.9.0', path: fixture.real,
    manifestVersion: 3, installedAt: '2026-01-01T00:00:00.000Z'
  };
  const store = transactionalStore([original]);
  const runtime = sessionFixture({ ids: ['new-runtime-id'] });
  const originalMutate = store.mutate;
  store.mutate = async (mutator) => {
    await originalMutate((draft) => {
      draft.extensions = [];
      return mutator(draft);
    });
  };
  const manager = new ExtensionManager(runtime.session, store, null);

  await manager.init();

  assert.equal(runtime.runtime.has('new-runtime-id'), false);
  assert.deepEqual(runtime.calls.removes, ['new-runtime-id']);
  assert.deepEqual(manager.list().map(({ id, loaded, error }) => ({ id, loaded, code: error?.code })), [{
    id: 'persisted-id', loaded: false, code: 'EXTENSION_RESTORE_FAILED'
  }]);
});

test('operations are serialized and a failed operation does not poison the queue', { timeout: 2_000 }, async (t) => {
  const first = await manifestFixture(t);
  const second = await manifestFixture(t);
  const store = transactionalStore();
  const firstLoad = deferred();
  const firstEntered = deferred();
  const calls = [];
  const session = { extensions: {
    async loadExtension(extensionPath) {
      calls.push(extensionPath);
      if (calls.length === 1) {
        firstEntered.resolve();
        await firstLoad.promise;
      }
      return { id: `runtime-${calls.length}`, name: 'Runtime', version: '1.0.0' };
    },
    removeExtension() {}
  } };
  const manager = new ExtensionManager(session, store, null);
  const missing = manager.install(path.join(first.directory, 'missing'));
  const installFirst = manager.install(first.directory);
  const installSecond = manager.install(second.directory);
  await assert.rejects(missing, { code: 'EXTENSION_NOT_FOUND' });
  await firstEntered.promise;
  assert.deepEqual(calls, [first.real]);
  firstLoad.resolve();
  await Promise.all([installFirst, installSecond]);
  assert.deepEqual(calls, [first.real, second.real]);
});

test('shutdown closes admission synchronously, drains accepted install, and is stable', { timeout: 2_000 }, async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const gate = deferred();
  const entered = deferred();
  const calls = { removes: [] };
  const session = { extensions: {
    async loadExtension() {
      entered.resolve();
      await gate.promise;
      return { id: 'pending-runtime', name: 'Pending', version: '1.0.0' };
    },
    removeExtension(id) { calls.removes.push(id); }
  } };
  const manager = new ExtensionManager(session, store, null);
  const install = manager.install(fixture.directory);
  const shutdown = manager.shutdown();

  assert.equal(manager.shutdown(), shutdown);
  await assert.rejects(manager.install(fixture.directory), { code: 'EXTENSIONS_SHUTTING_DOWN' });
  await assert.rejects(manager.remove('pending-runtime'), { code: 'EXTENSIONS_SHUTTING_DOWN' });
  await assert.rejects(manager.init(), { code: 'EXTENSIONS_SHUTTING_DOWN' });
  await entered.promise;
  let shutdownSettled = false;
  void shutdown.finally(() => { shutdownSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);
  assert.deepEqual(calls.removes, []);
  gate.resolve();
  assert.equal((await install).id, 'pending-runtime');
  await shutdown;
  assert.deepEqual(calls.removes, ['pending-runtime']);
  assert.equal(manager.list()[0].loaded, false);
});

test('shutdown drains delayed persistence and an already queued remove in admission order', { timeout: 2_000 }, async (t) => {
  const fixture = await manifestFixture(t);
  const persistenceEntered = deferred();
  const persistenceGate = deferred();
  let state = { extensions: [] };
  let mutations = 0;
  const events = [];
  const store = {
    get(parts) { return structuredClone(state[parts[0]]); },
    async mutate(mutator) {
      mutations += 1;
      const draft = structuredClone(state);
      await mutator(draft);
      if (mutations === 1) {
        events.push('persist-entered');
        persistenceEntered.resolve();
        await persistenceGate.promise;
      }
      state = draft;
      events.push(`persist-${mutations}`);
    }
  };
  const session = { extensions: {
    async loadExtension() {
      events.push('loaded');
      return { id: 'queued-runtime', name: 'Queued', version: '1.0.0' };
    },
    removeExtension(id) { events.push(`removed-${id}`); }
  } };
  const manager = new ExtensionManager(session, store, null);
  const install = manager.install(fixture.directory);
  await persistenceEntered.promise;
  const remove = manager.remove('queued-runtime');
  const shutdown = manager.shutdown();
  assert.deepEqual(events, ['loaded', 'persist-entered']);

  persistenceGate.resolve();
  await install;
  assert.deepEqual(await remove, []);
  await shutdown;

  assert.deepEqual(events, ['loaded', 'persist-entered', 'persist-1', 'removed-queued-runtime', 'persist-2']);
  assert.deepEqual(manager.list(), []);
});

test('same-directory different-ID install rolls back the newcomer without hiding the existing runtime', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture({ ids: ['existing-runtime', 'new-runtime'] });
  const manager = new ExtensionManager(runtime.session, store, null);
  await manager.install(fixture.directory);

  await assert.rejects(manager.install(fixture.directory), { code: 'EXTENSION_CONFIGURATION_CHANGED' });

  assert.equal(manager.loaded.has('existing-runtime'), true);
  assert.equal(manager.loaded.has('new-runtime'), false);
  assert.equal(runtime.runtime.has('existing-runtime'), true);
  assert.equal(runtime.runtime.has('new-runtime'), false);
  assert.deepEqual(runtime.calls.removes, ['new-runtime']);
  assert.deepEqual(manager.list().map(({ id, loaded }) => ({ id, loaded })), [{ id: 'existing-runtime', loaded: true }]);
});

test('positive unload readback rejects removal without changing saved or owned state', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  runtime.session.extensions.getExtension = (id) => runtime.runtime.get(id) ?? null;
  runtime.session.extensions.removeExtension = (id) => { runtime.calls.removes.push(id); };
  const manager = new ExtensionManager(runtime.session, store, null);
  await manager.install(fixture.directory);

  await assert.rejects(manager.remove('fixture-wallet-id'), { code: 'EXTENSION_UNLOAD_FAILED' });

  assert.equal(manager.loaded.has('fixture-wallet-id'), true);
  assert.equal(runtime.runtime.has('fixture-wallet-id'), true);
  assert.equal(manager.list()[0].loaded, true);
  assert.equal(store.snapshot().extensions.length, 1);
});

test('shutdown attempts every owned runtime and rejects after unload failures', async (t) => {
  const first = await manifestFixture(t);
  const second = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture({ ids: ['first-runtime', 'second-runtime'] });
  const manager = new ExtensionManager(runtime.session, store, null);
  await manager.install(first.directory);
  await manager.install(second.directory);
  runtime.session.extensions.removeExtension = (id) => {
    runtime.calls.removes.push(id);
    if (id === 'first-runtime') throw new Error('first unload failed');
    runtime.runtime.delete(id);
  };

  await assert.rejects(manager.shutdown(), AggregateError);

  assert.deepEqual(runtime.calls.removes, ['first-runtime', 'second-runtime']);
  assert.equal(manager.loaded.has('first-runtime'), true);
  assert.equal(manager.loaded.has('second-runtime'), false);
});

test('logger failures cannot replace a committed install or removal result', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  const manager = new ExtensionManager(runtime.session, store, {
    info() { throw new Error('fixture logger failed'); }
  });

  assert.equal((await manager.install(fixture.directory)).loaded, true);
  assert.deepEqual(await manager.remove('fixture-wallet-id'), []);
});

test('asynchronous logger rejection cannot replace a committed lifecycle result', async (t) => {
  const fixture = await manifestFixture(t);
  const store = transactionalStore();
  const runtime = sessionFixture();
  const manager = new ExtensionManager(runtime.session, store, {
    async info() { throw new Error('fixture async logger failed'); }
  });

  assert.equal((await manager.install(fixture.directory)).loaded, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await manager.remove('fixture-wallet-id'), []);
});

test('null manifest is rejected as incomplete before any runtime load', async (t) => {
  const fixture = await manifestFixture(t);
  await fs.writeFile(path.join(fixture.directory, 'manifest.json'), 'null');
  const runtime = sessionFixture();
  const manager = new ExtensionManager(runtime.session, transactionalStore(), null);

  await assert.rejects(manager.install(fixture.directory), { code: 'INVALID_EXTENSION' });
  assert.deepEqual(runtime.calls.loads, []);
});
