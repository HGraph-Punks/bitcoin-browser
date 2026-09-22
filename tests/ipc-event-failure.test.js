import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../src/shared/navigation.js';
import { assertString } from '../src/shared/validation.js';
import { Logger } from '../src/main/logger.js';
import { shutdownApplicationManagers } from '../src/main/local-service-manager.js';
import os from 'node:os';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';

const source = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export function registerIpc', 'function registerIpc');
const walletSource = fs.readFileSync(new URL('../src/main/wallet-manager.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export class WalletManager', 'class WalletManager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ handleBridgeEvent, handleReady = () => true, warn, logger }) {
  const listeners = new Map();
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(module, injected) {
    const { path, ipcMain, IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString } = injected;
    const dialog = {}, shell = {};
    const inspectPsbt = () => {}, buildDiagnostics = async () => {}, writeDiagnostics = async () => {}, writeContentFile = async () => {};
    ${source}
    module.exports = registerIpc;
  })`, { URL, process, structuredClone, Date, Promise, Buffer });
  wrapper(module, {
    path, IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString,
    ipcMain: { handle() {}, on: (channel, listener) => listeners.set(channel, listener) }
  });
  const lifecycle = module.exports({
    walletManager: { handleBridgeEvent, handleReady },
    logger: logger ?? { warn },
    getMainWindow: () => null
  });
  return { lifecycle, listeners };
}

function actualReadyFixture() {
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(module, injected) {
    const { path, crypto, BrowserWindow, dialog, IPC, WALLET_ORIGIN, WALLET_PARTITION, AppError, inspectPsbt, sanitizeJson } = injected;
    ${walletSource}
    module.exports = WalletManager;
  })`, { setTimeout, clearTimeout, Promise, structuredClone });
  wrapper(module, {
    path, crypto, BrowserWindow: class {}, dialog: {}, IPC,
    WALLET_ORIGIN: 'https://wallet.invalid', WALLET_PARTITION: 'persist:wallet', AppError,
    inspectPsbt: () => ({}), sanitizeJson: (value) => value
  });
  let listError = null;
  let sendError = null;
  const sent = [];
  const sender = {
    id: 41,
    send(channel, message) {
      if (sendError) throw sendError;
      sent.push([channel, message]);
    }
  };
  const manager = new module.exports({
    walletSession: {}, preloadPath: '/fixture/preload.cjs', stateStore: {}, logger: null,
    extensionManager: {
      list() {
        if (listError) throw listError;
        return [{ id: 'loaded', loaded: true }, { id: 'disabled', loaded: false }];
      }
    },
    mainWindow: () => null
  });
  manager.window = { isDestroyed: () => false, webContents: sender };
  return {
    manager, sender, sent,
    failList(error) { listError = error; },
    failSend(error) { sendError = error; }
  };
}

test('global shutdown logger flush owns a failed wallet event report after IPC drain settles', async (t) => {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'satoshi-ipc-event-log-'));
  const logging = deferred();
  const logger = new Logger(directory);
  t.after(async () => {
    logging.resolve();
    try { await logger.flush(); }
    finally { await fsPromises.rm(directory, { recursive: true, force: true }); }
  });
  await logger.init();
  logger.queue = logging.promise;
  const f = fixture({
    handleBridgeEvent: async () => { throw new Error('synthetic bridge event failure'); },
    logger
  });
  f.listeners.get(IPC.WALLET_BRIDGE_EVENT)({ sender: { id: 7 } }, { type: 'fixture' });
  await new Promise((resolve) => setImmediate(resolve));

  let settled = false;
  const shutdown = shutdownApplicationManagers({
    shutdownIpc: () => f.lifecycle.shutdown(),
    finalTasks: [() => logger.flush()]
  }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the global logger drain must own the queued failure report');
  logging.resolve();
  await shutdown;
  const records = (await fsPromises.readFile(logger.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.some((record) => record.event === 'wallet.bridge_event_failed'
    && record.message === 'synthetic bridge event failure'), true);
});

test('actual WalletManager ready publication exposes list and sender failures, then retries without losing trust', () => {
  for (const kind of ['list', 'send']) {
    const f = actualReadyFixture();
    const failure = new Error(`synthetic ${kind} failure`);
    if (kind === 'list') f.failList(failure);
    else f.failSend(failure);
    assert.throws(() => f.manager.handleReady(f.sender), failure);
    if (kind === 'list') f.failList(null);
    else f.failSend(null);
    assert.equal(f.manager.handleReady(f.sender), true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0][0], IPC.WALLET_BRIDGE_COMMAND);
    assert.equal(f.sent[0][1].action, 'refresh');
    assert.equal(f.sent[0][1].payload.extensionCount, 1);
    assert.equal(f.manager.handleReady({ id: 999, send: assert.fail }), false);
  }
});

test('wallet ready listener contains synchronous manager failures instead of escaping ipcMain dispatch', () => {
  const warnings = [];
  const f = fixture({
    handleBridgeEvent: async () => {},
    handleReady: () => { throw new Error('synthetic ready publication failure'); },
    warn: (event, fields) => { warnings.push([event, fields]); }
  });
  assert.doesNotThrow(() => f.listeners.get(IPC.WALLET_BRIDGE_READY)({ sender: { id: 7 } }));
  assert.equal(warnings.length, 1);
});

test('wallet ready remains a synchronous gated notification and late ready is ignored', async () => {
  let ready = 0;
  const f = fixture({
    handleBridgeEvent: async () => {},
    handleReady: () => { ready += 1; return true; },
    warn: async () => {}
  });
  f.listeners.get(IPC.WALLET_BRIDGE_READY)({ sender: { id: 7 } });
  assert.equal(ready, 1);
  await f.lifecycle.shutdown();
  f.listeners.get(IPC.WALLET_BRIDGE_READY)({ sender: { id: 7 } });
  assert.equal(ready, 1);
});

test('real registerIpc contains actual WalletManager ready faults and permits trusted retry only', () => {
  const actual = actualReadyFixture();
  const warnings = [];
  const f = fixture({
    handleBridgeEvent: (...args) => actual.manager.handleBridgeEvent(...args),
    handleReady: (sender) => actual.manager.handleReady(sender),
    warn: (event, fields) => { warnings.push([event, fields]); }
  });
  actual.failList(new Error('synthetic extension list failure'));
  assert.doesNotThrow(() => f.listeners.get(IPC.WALLET_BRIDGE_READY)({ sender: actual.sender }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'wallet.bridge_ready_failed');
  assert.equal(warnings[0][1].message, 'synthetic extension list failure');
  actual.failList(null);
  f.listeners.get(IPC.WALLET_BRIDGE_READY)({ sender: actual.sender });
  assert.equal(actual.sent.length, 1);
  f.listeners.get(IPC.WALLET_BRIDGE_READY)({ sender: { id: 999, send: assert.fail } });
  assert.equal(actual.sent.length, 1);
});

test('failed bridge event bounds warning fields and contains a rejected warning continuation', async () => {
  const warnings = [];
  const message = 'x'.repeat(2_000);
  const f = fixture({
    handleBridgeEvent: async () => { throw new Error(message); },
    warn: async (event, fields) => {
      warnings.push([event, fields]);
      throw new Error('synthetic diagnostic failure');
    }
  });
  f.listeners.get(IPC.WALLET_BRIDGE_EVENT)({ sender: { id: 7 } }, { type: 'fixture' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'wallet.bridge_event_failed');
  assert.equal(warnings[0][1].message, 'x'.repeat(1_024));
  await f.lifecycle.shutdown();
});

for (const warningFailure of ['sync', 'async']) {
  test(`wallet ready containment tolerates ${warningFailure} warning failure`, async () => {
    const f = fixture({
      handleBridgeEvent: async () => {},
      handleReady: () => { throw new Error('synthetic ready publication failure'); },
      warn: warningFailure === 'sync'
        ? () => { throw new Error('synthetic synchronous warning failure'); }
        : async () => { throw new Error('synthetic asynchronous warning failure'); }
    });
    assert.doesNotThrow(() => f.listeners.get(IPC.WALLET_BRIDGE_READY)({ sender: { id: 7 } }));
    await new Promise((resolve) => setImmediate(resolve));
  });
}
