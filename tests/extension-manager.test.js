import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionManager } from '../src/main/extension-manager.js';

function memoryState(initial = []) {
  const state = { extensions: structuredClone(initial) };
  return {
    state,
    get(parts) { return structuredClone(state[parts[0]]); },
    async mutate(mutator) { await mutator(state); }
  };
}

test('extension manager validates, persists, lists, restores, and removes a wallet extension', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture wallet', version: '1.2.3' }));
  const removed = [];
  const session = {
    extensions: {
      async loadExtension(extensionPath, options) {
        assert.equal(extensionPath, await fs.realpath(directory));
        assert.deepEqual(options, { allowFileAccess: false });
        return { id: 'fixture-wallet-id', name: 'Fixture wallet runtime', version: '1.2.3' };
      },
      removeExtension(id) { removed.push(id); }
    },
    loadExtension() { throw new Error('deprecated loader must not be used'); },
    removeExtension() { throw new Error('deprecated remover must not be used'); }
  };
  const stateStore = memoryState();
  const manager = new ExtensionManager(session, stateStore, null);
  const installed = await manager.install(directory);
  assert.equal(installed.loaded, true);
  assert.equal(manager.list()[0].runtime.id, 'fixture-wallet-id');

  const restored = new ExtensionManager(session, stateStore, null);
  await restored.init();
  assert.equal(restored.list()[0].loaded, true);
  assert.equal(restored.list()[0].runtime.id, 'fixture-wallet-id');

  assert.deepEqual(await restored.remove('fixture-wallet-id'), []);
  assert.deepEqual(removed, ['fixture-wallet-id']);

  await manager.install(directory);
  await manager.shutdown();
  assert.equal(manager.list()[0].loaded, false);
  assert.deepEqual(removed, ['fixture-wallet-id', 'fixture-wallet-id']);
});

test('extension manager rejects missing and malformed manifests', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = new ExtensionManager({ loadExtension() { throw new Error('must not load'); } }, memoryState(), null);
  await assert.rejects(manager.install(path.join(directory, 'missing')), { code: 'EXTENSION_NOT_FOUND' });
  await assert.rejects(manager.install(directory), { code: 'INVALID_EXTENSION' });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 4, name: 'Bad', version: '1' }));
  await assert.rejects(manager.install(directory), { code: 'INVALID_EXTENSION' });
});

test('extension manager retains compatibility with Electron sessions predating the extensions facade', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-legacy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Legacy fixture', version: '1.0.0' }));
  const session = {
    async loadExtension() { return { id: 'legacy-fixture', name: 'Legacy fixture', version: '1.0.0' }; },
    removeExtension() {}
  };
  const manager = new ExtensionManager(session, memoryState(), null);
  assert.equal((await manager.install(directory)).id, 'legacy-fixture');
});

test('extension manager reconciles persisted metadata when Electron assigns a new id on restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-reassigned-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Manifest name', version: '2.0.0' }));
  const realDirectory = await fs.realpath(directory);
  const installedAt = '2025-01-02T03:04:05.000Z';
  const stateStore = memoryState([{
    id: 'stale-wallet-id',
    name: 'Stale wallet name',
    version: '1.0.0',
    path: realDirectory,
    manifestVersion: 3,
    installedAt
  }]);
  const removed = [];
  const session = {
    extensions: {
      async loadExtension() {
        return { id: 'live-wallet-id', name: 'Live wallet name', version: '2.0.0' };
      },
      removeExtension(id) { removed.push(id); }
    }
  };

  const manager = new ExtensionManager(session, stateStore, null);
  await manager.init();

  assert.deepEqual(manager.list(), [{
    id: 'live-wallet-id',
    name: 'Live wallet name',
    version: '2.0.0',
    path: realDirectory,
    manifestVersion: 3,
    installedAt,
    loaded: true,
    runtime: { id: 'live-wallet-id', name: 'Live wallet name', version: '2.0.0', path: realDirectory }
  }]);
  assert.deepEqual(await manager.remove('live-wallet-id'), []);
  assert.deepEqual(removed, ['live-wallet-id']);
});
