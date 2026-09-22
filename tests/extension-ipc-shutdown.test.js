import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { assertString } from '../src/shared/validation.js';
import { ExtensionManager } from '../src/main/extension-manager.js';
import { shutdownApplicationManagers } from '../src/main/local-service-manager.js';

const ipcSource = (await fs.readFile(new URL('../src/main/ipc.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export function registerIpc', 'function registerIpc');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function ipcFixture(extensionManager, selection, calls) {
  const handlers = new Map();
  const registerIpc = vm.runInNewContext(`${ipcSource}\nregisterIpc`, {
    IPC, AppError, serializeError, assertString, Promise,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: { showOpenDialog: selection }
  });
  const lifecycle = registerIpc({
    getMainWindow: () => null, extensionManager,
    walletManager: {
      beginExtensionChange() { return {}; },
      async endExtensionChange(_lease, options) { calls.push(`wallet-end:${options.refresh}`); },
      snapshot() { return { state: null, discovered: [] }; },
      async discover() { calls.push('wallet-discover'); },
      async extensionsChanged() { calls.push('wallet-refresh'); }
    }
  });
  const event = { senderFrame: { url: 'app://app/renderer/index.html' } };
  return { lifecycle, invoke: (channel, payload) => handlers.get(channel)(event, payload) };
}

test('an IPC-admitted extension picker settles without starting a load after shutdown closes manager admission', { timeout: 2_000 }, async () => {
  const entered = deferred();
  const selection = deferred();
  const calls = [];
  const manager = new ExtensionManager({ extensions: {
    async loadExtension() { assert.fail('runtime must not load'); },
    removeExtension() { assert.fail('no runtime is owned'); }
  } }, { get: () => [] }, null);
  const ipc = ipcFixture(manager, () => { entered.resolve(); return selection.promise; }, calls);
  const install = ipc.invoke(IPC.EXTENSIONS_INSTALL);
  await entered.promise;
  let stopped = false;
  const shutdown = shutdownApplicationManagers({
    shutdownIpc: () => ipc.lifecycle.shutdown(),
    shutdownExtensions: () => manager.shutdown(),
    persistenceTasks: [() => calls.push('persist')],
    finalTasks: [() => calls.push('log')]
  }).then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.deepEqual(calls, []);
  const rejected = await ipc.invoke(IPC.EXTENSIONS_INSTALL);
  assert.equal(rejected.error.code, 'APP_SHUTTING_DOWN');
  selection.resolve({ canceled: false, filePaths: ['/unused/fixture-directory'] });
  const result = await install;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EXTENSIONS_SHUTTING_DOWN');
  await shutdown;
  assert.deepEqual(calls, ['wallet-end:false', 'persist', 'log']);
});

test('an already loading extension drains through IPC shutdown without opening wallet discovery afterward', { timeout: 2_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-ipc-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture', version: '1' }));
  const entered = deferred();
  const loaded = deferred();
  const calls = [];
  const state = { extensions: [] };
  const manager = new ExtensionManager({ extensions: {
    async loadExtension() { entered.resolve(); await loaded.promise; return { id: 'fixture-runtime', name: 'Fixture', version: '1' }; },
    removeExtension() { calls.push('unload'); }
  } }, {
    get: () => structuredClone(state.extensions),
    async mutate(action) { action(state); calls.push('commit'); }
  }, null);
  const ipc = ipcFixture(manager, async () => ({ canceled: false, filePaths: [directory] }), calls);
  const install = ipc.invoke(IPC.EXTENSIONS_INSTALL);
  await entered.promise;
  const shutdown = shutdownApplicationManagers({
    shutdownIpc: () => ipc.lifecycle.shutdown(),
    shutdownExtensions: () => manager.shutdown(),
    persistenceTasks: [() => calls.push('persist')],
    finalTasks: [() => calls.push('log')]
  });
  assert.deepEqual(calls, []);
  loaded.resolve();
  assert.equal((await install).ok, true, 'the already admitted mutation retains its committed result');
  await shutdown;
  assert.deepEqual(calls, ['commit', 'unload', 'wallet-end:false', 'persist', 'log']);
  assert.equal(manager.loaded.size, 0);
  assert.equal(state.extensions.length, 1, 'the installation remains configured for the next launch');
});

test('an admitted removal finishes saving during shutdown without reloading the wallet bridge', { timeout: 2_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-ipc-remove-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture', version: '1' }));
  const entered = deferred();
  const saved = deferred();
  const calls = [];
  const state = { extensions: [] };
  let removing = false;
  const manager = new ExtensionManager({ extensions: {
    async loadExtension() { return { id: 'fixture-runtime', name: 'Fixture', version: '1' }; },
    removeExtension() { calls.push('unload'); }
  } }, {
    get: () => structuredClone(state.extensions),
    async mutate(action) {
      if (removing) { entered.resolve(); await saved.promise; }
      action(state);
      if (removing) calls.push('commit');
    }
  }, null);
  await manager.install(directory);
  removing = true;
  const ipc = ipcFixture(manager, () => assert.fail('removal does not open a picker'), calls);
  const removal = ipc.invoke(IPC.EXTENSIONS_REMOVE, { id: 'fixture-runtime' });
  await entered.promise;
  const shutdown = shutdownApplicationManagers({
    shutdownIpc: () => ipc.lifecycle.shutdown(),
    shutdownExtensions: () => manager.shutdown(),
    persistenceTasks: [() => calls.push('persist')],
    finalTasks: [() => calls.push('log')]
  });
  assert.deepEqual(calls, ['unload']);
  saved.resolve();
  assert.equal((await removal).ok, true);
  await shutdown;
  assert.deepEqual(calls, ['unload', 'commit', 'wallet-end:false', 'persist', 'log']);
  assert.equal(manager.loaded.size, 0);
  assert.deepEqual(state.extensions, []);
});
