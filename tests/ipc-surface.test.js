import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../src/shared/navigation.js';
import { assertString } from '../src/shared/validation.js';

const EVENT_ONLY = new Set([
  IPC.APP_COMMAND,
  IPC.APP_DEEP_LINK,
  IPC.WALLET_STATE,
  IPC.WALLET_BRIDGE_READY,
  IPC.WALLET_BRIDGE_EVENT,
  IPC.WALLET_BRIDGE_COMMAND
]);

const FACADE_TO_CHANNEL = Object.freeze({
  'creator.open': 'creator:open',
  'app.bootstrap': IPC.APP_BOOTSTRAP,
  'app.openExternal': IPC.APP_OPEN_EXTERNAL,
  'app.revealPath': IPC.APP_REVEAL_PATH,
  'navigation.parse': IPC.NAV_PARSE,
  'navigation.resolve': IPC.ENTITY_RESOLVE,
  'navigation.cancelResolve': IPC.ENTITY_RESOLVE_CANCEL,
  'ai.prepare': IPC.AI_PREPARE,
  'ai.run': IPC.AI_RUN,
  'ai.progress': IPC.AI_PROGRESS,
  'ai.cancel': IPC.AI_CANCEL,
  'content.save': IPC.CONTENT_SAVE,
  'providers.list': IPC.PROVIDERS_LIST,
  'providers.snapshot': IPC.PROVIDERS_SNAPSHOT,
  'providers.health': IPC.PROVIDERS_HEALTH,
  'providers.upsert': IPC.PROVIDERS_UPSERT,
  'providers.recover': IPC.PROVIDERS_RECOVER,
  'providers.reviewCleanup': IPC.PROVIDERS_CLEANUP_REVIEW,
  'providers.cleanup': IPC.PROVIDERS_CLEANUP,
  'providers.remove': IPC.PROVIDERS_REMOVE,
  'providers.preferred': IPC.PROVIDERS_PREFERRED,
  'settings.update': IPC.SETTINGS_UPDATE,
  'nodeSetup.run': IPC.NODE_SETUP,
  'tabs.save': IPC.TABS_SAVE,
  'history.list': IPC.HISTORY_LIST,
  'history.record': IPC.HISTORY_RECORD,
  'history.clear': IPC.HISTORY_CLEAR,
  'bookmarks.list': IPC.BOOKMARKS_LIST,
  'bookmarks.toggle': IPC.BOOKMARKS_TOGGLE,
  'cache.stats': IPC.CACHE_STATS,
  'cache.clear': IPC.CACHE_CLEAR,
  'resolver.graph': IPC.RESOLVER_GRAPH,
  'psbt.inspect': IPC.PSBT_INSPECT,
  'extensions.list': IPC.EXTENSIONS_LIST,
  'extensions.install': IPC.EXTENSIONS_INSTALL,
  'extensions.remove': IPC.EXTENSIONS_REMOVE,
  'wallet.open': IPC.WALLET_OPEN,
  'wallet.discover': IPC.WALLET_DISCOVER,
  'wallet.connect': IPC.WALLET_CONNECT,
  'wallet.disconnect': IPC.WALLET_DISCONNECT,
  'wallet.signPsbt': IPC.WALLET_SIGN_PSBT,
  'wallet.signMessage': IPC.WALLET_SIGN_MESSAGE,
  'services.list': IPC.LOCAL_SERVICES_LIST,
  'services.upsert': IPC.LOCAL_SERVICES_UPSERT,
  'services.remove': IPC.LOCAL_SERVICES_REMOVE,
  'services.start': IPC.LOCAL_SERVICES_START,
  'services.stop': IPC.LOCAL_SERVICES_STOP,
  'diagnostics.export': IPC.DIAGNOSTICS_EXPORT
});

function executePreload(file, exposedName, invokeResult = () => ({ ok: true, result: null })) {
  const calls = [];
  const subscriptions = [];
  let facade;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        assert.equal(name, exposedName);
        facade = value;
      }
    },
    ipcRenderer: {
      invoke(channel, payload) {
        calls.push({ type: 'invoke', channel, payload });
        return Promise.resolve(invokeResult(channel, payload));
      },
      send(channel, payload) {
        calls.push({ type: 'send', channel, payload });
      },
      on(channel, listener) {
        subscriptions.push({ channel, listener });
      },
      removeListener() {}
    }
  };
  const source = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(`(function(require) { ${source}\n})`, {})((id) => {
    assert.equal(id, 'electron');
    return electron;
  });
  return { facade, calls, subscriptions };
}

function registeredMainSurface() {
  const handlers = new Map();
  const listeners = new Map();
  let source = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '');
  source = source.replace('export function registerIpc', 'function registerIpc');
  source += '\nmodule.exports = { registerIpc };';
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(module, injected) {
    const { path, dialog, ipcMain, shell, IPC, AppError, serializeError, INSCRIPTION_ID_RE, parseNavigationInput, assertString, inspectPsbt, buildDiagnostics, writeDiagnostics, writeContentFile } = injected;
    ${source}
  })`, { URL, process, structuredClone, Date, Promise, Buffer });
  wrapper(module, {
    path, dialog: {}, shell: {}, IPC, AppError, serializeError,
    INSCRIPTION_ID_RE, parseNavigationInput, assertString,
    inspectPsbt() {}, async buildDiagnostics() {}, async writeDiagnostics() {}, async writeContentFile() {},
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
        handlers.set(channel, handler);
      },
      on(channel, listener) {
        assert.equal(listeners.has(channel), false, `duplicate listener: ${channel}`);
        listeners.set(channel, listener);
      }
    }
  });
  let collaboratorReads = 0;
  const options = new Proxy({}, {
    get() {
      collaboratorReads += 1;
      throw new Error('untrusted request reached a collaborator');
    }
  });
  module.exports.registerIpc(options);
  return { handlers, listeners, collaboratorReads: () => collaboratorReads };
}

test('IPC constants partition exactly into registered invoke handlers and explicit event-only channels', () => {
  const { handlers, listeners } = registeredMainSurface();
  const constants = new Set(Object.values(IPC));
  assert.equal(constants.size, Object.values(IPC).length, 'IPC channel constants must be unique');
  const invokes = new Set([...constants].filter((channel) => !EVENT_ONLY.has(channel)));
  assert.deepEqual([...handlers.keys()].sort(), [...invokes].sort());
  assert.deepEqual([...listeners.keys()].sort(), [IPC.WALLET_BRIDGE_EVENT, IPC.WALLET_BRIDGE_READY].sort());
  assert.equal(constants.size, handlers.size + EVENT_ONLY.size);
  assert.equal(handlers.size, 48);
  assert.equal(EVENT_ONLY.size, 6);
});

test('application preload exposes only the reviewed facade and maps every request method to its exact channel', async () => {
  const setup = executePreload(new URL('../src/main/preload.cjs', import.meta.url), 'satBrowser');
  assert.deepEqual(Object.keys(setup.facade).sort(), [
    'ai', 'app', 'bookmarks', 'cache', 'content', 'creator', 'diagnostics', 'extensions', 'history',
    'navigation', 'nodeSetup', 'providers', 'psbt', 'resolver', 'services', 'settings', 'tabs', 'wallet'
  ]);
  const subscriberPaths = new Set(['app.onCommand', 'app.onDeepLink', 'wallet.onState']);
  const methods = [];
  for (const [namespace, group] of Object.entries(setup.facade)) {
    for (const [method, fn] of Object.entries(group)) {
      const name = `${namespace}.${method}`;
      methods.push(name);
      if (subscriberPaths.has(name)) fn(() => {});
      else if (name === 'navigation.cancelResolve') {
        const before = setup.calls.length;
        assert.equal((await fn('fixture')).requested, false);
        assert.equal(setup.calls.length, before, 'unknown request cancellation must not send IPC');
      }
      else {
        const before = setup.calls.length;
        await fn('fixture', 'fixture');
        assert.equal(setup.calls.length, before + 1, `${name} must invoke once`);
        assert.equal(setup.calls.at(-1).type, 'invoke', name);
        assert.equal(setup.calls.at(-1).channel, FACADE_TO_CHANNEL[name], name);
      }
    }
  }
  assert.deepEqual(methods.sort(), [...Object.keys(FACADE_TO_CHANNEL), ...subscriberPaths].sort());
  assert.deepEqual(
    setup.calls.filter((call) => call.type === 'invoke').map((call) => call.channel).sort(),
    Object.entries(FACADE_TO_CHANNEL).filter(([name]) => name !== 'navigation.cancelResolve').map(([, channel]) => channel).sort()
  );
  assert.deepEqual(setup.subscriptions.map(({ channel }) => channel).sort(), [IPC.APP_COMMAND, IPC.APP_DEEP_LINK, IPC.WALLET_STATE].sort());
  assert.equal(setup.calls.some((call) => call.type === 'send'), false);
});

test('tracked navigation uses only hidden preparation, resolve, and exact cancellation channels', async () => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const setup = executePreload(new URL('../src/main/preload.cjs', import.meta.url), 'satBrowser', channel => {
    if (channel === IPC.ENTITY_RESOLVE_PREPARE) return { ok: true, result: { handle: 37 } };
    if (channel === IPC.ENTITY_RESOLVE) return held;
    return { ok: true, result: { requested: true } };
  });
  const result = setup.facade.navigation.resolve('sat:1', undefined, 'fixture');
  const rejected = assert.rejects(result, error => error.code === 'NAVIGATION_CANCELLED');
  try {
    await new Promise(resolve => setImmediate(resolve));
    await setup.facade.navigation.cancelResolve('fixture');
  } finally { finish({ ok: true, result: null }); }
  await rejected;
  assert.deepEqual(setup.calls.map(call => call.channel), [IPC.ENTITY_RESOLVE_PREPARE, IPC.ENTITY_RESOLVE, IPC.ENTITY_RESOLVE_CANCEL]);
  assert.deepEqual(JSON.parse(JSON.stringify(setup.calls.map(call => call.payload))), [{ input: 'sat:1' }, { handle: 37 }, { handle: 37 }]);
  assert.equal('prepare' in setup.facade.navigation, false);
});

test('wallet preload exposes only ready, emit, and command subscription on the three bridge channels', () => {
  const setup = executePreload(new URL('../src/wallet/preload.cjs', import.meta.url), 'walletHost');
  assert.deepEqual(Object.keys(setup.facade).sort(), ['emit', 'onCommand', 'ready']);
  setup.facade.ready();
  setup.facade.emit({ type: 'fixture' });
  setup.facade.onCommand(() => {});
  assert.deepEqual(setup.calls.map(({ channel }) => channel), [IPC.WALLET_BRIDGE_READY, IPC.WALLET_BRIDGE_EVENT]);
  assert.deepEqual(setup.subscriptions.map(({ channel }) => channel), [IPC.WALLET_BRIDGE_COMMAND]);
});

test('every invoke handler rejects an untrusted sender before reading any collaborator', async () => {
  const setup = registeredMainSurface();
  const event = {
    senderFrame: { url: 'https://attacker.invalid/' },
    sender: { getURL: () => 'https://attacker.invalid/' }
  };
  for (const [channel, handler] of setup.handlers) {
    const response = await handler(event, {});
    assert.equal(response.ok, false, channel);
    assert.equal(response.error.code, 'UNTRUSTED_IPC_SENDER', channel);
    assert.equal(response.error.status, 403, channel);
  }
  assert.equal(setup.collaboratorReads(), 0);
});
