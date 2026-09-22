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

const ipcSource = (await fs.readFile(new URL('../src/main/ipc.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export function registerIpc', 'function registerIpc');

function fixture(extensionManager, walletManager, selectDirectory) {
  const handlers = new Map();
  const registerIpc = vm.runInNewContext(`${ipcSource}\nregisterIpc`, {
    IPC, AppError, serializeError, assertString, Promise,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectDirectory] }) }
  });
  registerIpc({ getMainWindow: () => null, extensionManager, walletManager });
  const event = { senderFrame: { url: 'app://app/renderer/index.html' } };
  return (channel, payload) => handlers.get(channel)(event, payload);
}

async function extensionFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-extension-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Recovery fixture', version: '1'
  }));
  const state = { extensions: [] };
  const calls = [];
  const manager = new ExtensionManager({ extensions: {
    async loadExtension(real) {
      calls.push('load');
      return { id: 'recovery-fixture', name: 'Recovery fixture', version: '1', path: real, manifest: { manifest_version: 3 } };
    },
    removeExtension(id) { calls.push(`unload:${id}`); },
    getExtension() { return null; }
  } }, {
    get: () => structuredClone(state.extensions),
    async mutate(action) { action(state); calls.push('persist'); }
  }, null);
  return { directory, state, calls, manager };
}

test('committed install reports authoritative recovery state when wallet refresh fails', async (t) => {
  const f = await extensionFixture(t);
  const lease = { id: 1 };
  const invoke = fixture(f.manager, {
    beginExtensionChange() { return lease; },
    async endExtensionChange(actual, options) {
      assert.equal(actual, lease);
      assert.equal(options.refresh, true);
      throw new AppError('WALLET_BRIDGE_UNAVAILABLE', 'bridge unavailable', { status: 503, retryable: true });
    },
    snapshot() { return { state: null, discovered: [] }; }
  }, f.directory);

  const response = await invoke(IPC.EXTENSIONS_INSTALL);

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EXTENSION_WALLET_REFRESH_FAILED');
  assert.equal(response.error.details.extensionMutationCommitted, true);
  assert.equal(response.error.details.operation, 'install');
  assert.equal(response.error.details.extensionId, 'recovery-fixture');
  assert.equal(response.error.details.walletRefreshPending, true);
  assert.equal(response.error.details.recovery, 'wallet:discover');
  assert.equal(response.error.details.cause.code, 'WALLET_BRIDGE_UNAVAILABLE');
  assert.equal(response.error.details.extensions[0].id, 'recovery-fixture');
  assert.deepEqual(response.error.details.wallet, { state: null, discovered: [] });
  assert.deepEqual(f.calls, ['load', 'persist']);
  assert.equal(f.state.extensions.length, 1, 'the extension mutation committed despite the failure envelope');
  assert.equal((await invoke(IPC.EXTENSIONS_LIST)).result[0].id, 'recovery-fixture');
});

test('committed removal reports authoritative recovery state without resubmitting removal', async (t) => {
  const f = await extensionFixture(t);
  await f.manager.install(f.directory);
  f.calls.length = 0;
  const invoke = fixture(f.manager, {
    beginExtensionChange() { return 'remove-lease'; },
    async endExtensionChange(lease, options) {
      assert.equal(lease, 'remove-lease');
      assert.equal(options.refresh, true);
      throw new AppError('WALLET_REFRESH_FAILED', 'wallet refresh failed', { status: 503, retryable: true });
    },
    snapshot() { return { state: null, discovered: [] }; }
  }, f.directory);

  const response = await invoke(IPC.EXTENSIONS_REMOVE, { id: 'recovery-fixture' });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EXTENSION_WALLET_REFRESH_FAILED');
  assert.equal(response.error.details.extensionMutationCommitted, true);
  assert.equal(response.error.details.operation, 'remove');
  assert.equal(response.error.details.extensionId, 'recovery-fixture');
  assert.equal(response.error.details.walletRefreshPending, true);
  assert.equal(response.error.details.recovery, 'wallet:discover');
  assert.deepEqual(response.error.details.extensions, []);
  assert.deepEqual(f.calls, ['unload:recovery-fixture', 'persist']);
  assert.deepEqual(f.state.extensions, [], 'the removal committed despite the failure envelope');
  assert.deepEqual((await invoke(IPC.EXTENSIONS_LIST)).result, []);
});

test('mutation failure remains primary while lease settlement failure is secondary', async (t) => {
  const f = await extensionFixture(t);
  f.manager.install = async () => { throw new AppError('INVALID_EXTENSION', 'bad manifest', { status: 400, details: { field: 'manifest' } }); };
  let ended = 0;
  const invoke = fixture(f.manager, {
    beginExtensionChange() { return 'failed-install'; },
    async endExtensionChange(lease, options) {
      ended += 1;
      assert.equal(lease, 'failed-install');
      assert.equal(options.refresh, true);
      throw new AppError('WALLET_PERSIST_FAILED', 'wallet persistence failed', { status: 503 });
    },
    snapshot() { return { state: null, discovered: [] }; }
  }, f.directory);

  const response = await invoke(IPC.EXTENSIONS_INSTALL);

  assert.equal(response.error.code, 'INVALID_EXTENSION');
  assert.equal(response.error.status, 400);
  assert.equal(response.error.details.field, 'manifest');
  assert.equal(response.error.details.extensionMutationCommitted, false);
  assert.equal(response.error.details.operation, 'install');
  assert.equal(response.error.details.walletRefreshPending, true);
  assert.equal(response.error.details.refreshError.code, 'WALLET_PERSIST_FAILED');
  assert.equal(response.error.details.recovery, 'wallet:discover');
  assert.equal(ended, 1);
  assert.deepEqual(f.state.extensions, []);
});

test('cancelled picker never begins wallet extension-change authority', async (t) => {
  const f = await extensionFixture(t);
  let began = 0;
  const handlers = new Map();
  const registerIpc = vm.runInNewContext(`${ipcSource}\nregisterIpc`, {
    IPC, AppError, serializeError, assertString, Promise,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  });
  registerIpc({
    getMainWindow: () => null, extensionManager: f.manager,
    walletManager: { beginExtensionChange() { began += 1; }, snapshot() { return {}; } }
  });
  const response = await handlers.get(IPC.EXTENSIONS_INSTALL)({ senderFrame: { url: 'app://app/renderer/index.html' } }, {});
  assert.equal(response.error.code, 'USER_REJECTED');
  assert.equal(began, 0);
  assert.deepEqual(f.calls, []);
});
