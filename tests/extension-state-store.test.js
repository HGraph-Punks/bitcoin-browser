import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/main/state-store.js';
import { ExtensionManager } from '../src/main/extension-manager.js';

// Real disk transactions, synthetic owned files, mocked Electron session only.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-state-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'extension');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Synthetic wallet', version: '1.0.0'
  }));
  const real = await fs.realpath(directory);
  const store = new StateStore(path.join(root, 'state'), null);
  await store.init();
  const primary = store.file;
  const blocked = path.join(root, 'rename-target-directory');
  await fs.mkdir(blocked);
  const runtime = new Map();
  const removes = [];
  let version = '1.0.0';
  const session = { extensions: {
    async loadExtension(selected, options) {
      assert.equal(selected, real);
      assert.deepEqual(options, { allowFileAccess: false });
      const extension = { id: 'synthetic-wallet', name: `Wallet ${version}`, version, path: real,
        manifest: { manifest_version: 3 } };
      runtime.set(extension.id, extension);
      return extension;
    },
    removeExtension(id) { removes.push(id); runtime.delete(id); },
    getExtension(id) { return runtime.get(id) ?? null; }
  } };
  return { store, primary, blocked, directory, real, runtime, removes, session,
    manager: new ExtensionManager(session, store, null),
    setVersion(value) { version = value; },
    async disk() { return JSON.parse(await fs.readFile(primary, 'utf8')); },
    async reopened() {
      const reopened = new StateStore(store.directory, null);
      await reopened.init();
      return reopened;
    }
  };
}

function assertRenameFailure(error, target) {
  assert.equal(error.syscall, 'rename');
  assert.equal(error.dest, target);
  assert.ok(['EISDIR', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY'].includes(error.code), error.code);
  assert.equal(typeof error.path, 'string');
  assert.equal(error.path.startsWith(`${target}.`), true);
  return true;
}

test('real StateStore failed extension install rolls back runtime and retry survives reopen', async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.primary, 'utf8');
  f.store.file = f.blocked;
  await assert.rejects(f.manager.install(f.directory), (error) => assertRenameFailure(error, f.blocked));
  assert.deepEqual(f.store.get(['extensions']), []);
  assert.equal(await fs.readFile(f.primary, 'utf8'), before);
  assert.deepEqual(f.manager.list(), []);
  assert.equal(f.runtime.size, 0);
  assert.deepEqual(f.removes, ['synthetic-wallet']);
  assert.equal((await fs.stat(f.blocked)).isDirectory(), true);

  f.store.file = f.primary;
  await f.manager.install(f.directory);
  assert.deepEqual((await f.disk()).extensions, f.store.get(['extensions']));
  const reopened = await f.reopened();
  assert.deepEqual(reopened.get(['extensions']), f.store.get(['extensions']));
  const restored = new ExtensionManager(f.session, reopened, null);
  await restored.init();
  assert.equal(restored.list()[0].loaded, true);
  assert.equal(restored.list()[0].runtime.path, f.real);
});

test('real StateStore unload success and removal save failure preserve config until retry and reopen', async (t) => {
  const f = await fixture(t);
  await f.manager.install(f.directory);
  const configured = f.store.get(['extensions']);
  const before = await fs.readFile(f.primary, 'utf8');
  f.store.file = f.blocked;
  await assert.rejects(f.manager.remove('synthetic-wallet'), (error) => {
    assert.equal(error.code, 'EXTENSION_REMOVE_SAVE_FAILED');
    assert.deepEqual(error.details, { id: 'synthetic-wallet', committed: false, runtimeChanged: true, restartMayRestore: true });
    return assertRenameFailure(error.cause, f.blocked);
  });
  assert.deepEqual(f.store.get(['extensions']), configured);
  assert.equal(await fs.readFile(f.primary, 'utf8'), before);
  assert.equal(f.runtime.size, 0);
  assert.equal(f.manager.loaded.size, 0);
  assert.equal(f.manager.list()[0].loaded, false);
  assert.equal(f.manager.list()[0].error.code, 'EXTENSION_REMOVE_SAVE_FAILED');

  f.store.file = f.primary;
  assert.deepEqual(await f.manager.remove('synthetic-wallet'), []);
  assert.deepEqual(f.removes, ['synthetic-wallet']);
  assert.deepEqual((await f.disk()).extensions, []);
  assert.deepEqual((await f.reopened()).get(['extensions']), []);
});

test('real StateStore failed reinstall retains returned runtime metadata without fabricating persisted rollback', async (t) => {
  const f = await fixture(t);
  await f.manager.install(f.directory);
  const configured = f.store.get(['extensions']);
  const before = await fs.readFile(f.primary, 'utf8');
  f.setVersion('2.0.0');
  f.store.file = f.blocked;
  await assert.rejects(f.manager.install(f.directory), (error) => {
    assert.equal(error.code, 'EXTENSION_SAVE_FAILED');
    return assertRenameFailure(error.cause, f.blocked);
  });
  assert.deepEqual(f.store.get(['extensions']), configured);
  assert.equal(await fs.readFile(f.primary, 'utf8'), before);
  const visible = f.manager.list()[0];
  assert.equal(visible.version, '1.0.0');
  assert.equal(visible.runtime.version, '2.0.0');
  assert.equal(visible.runtime.name, 'Wallet 2.0.0');
  assert.equal(visible.runtime.path, f.real);
  assert.equal(f.runtime.get('synthetic-wallet').version, '2.0.0');
  assert.deepEqual(f.removes, []);
  f.store.file = f.primary;
  await f.manager.install(f.directory);
  assert.equal(f.manager.list()[0].error, undefined);
  assert.equal((await f.disk()).extensions[0].version, '2.0.0');
  assert.equal((await f.reopened()).get(['extensions'])[0].version, '2.0.0');
});
