import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { validateAiRequest, AI_DEFAULT_CONFIG } from '../src/shared/local-ai.js';
import { NavigationRequests } from '../src/main/navigation-requests.js';

const mainSource = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function registerIpc', 'function registerIpc');
const preloadSource = fs.readFileSync(new URL('../src/main/preload.cjs', import.meta.url), 'utf8');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function sender(url = 'app://app/renderer/index.html') {
  const sender = new EventEmitter(); sender.isDestroyed = () => false; sender.getURL = () => url;
  sender.mainFrame = { url, processId: 1, routingId: 2, detached: false };
  return { sender, senderFrame: sender.mainFrame };
}
function fixture(t, run = async value => ({ models: [{ id: 'fixture' }], action: value.action })) {
  const handlers = new Map(); const event = sender();
  const register = vm.runInNewContext(`(() => { ${mainSource}; return registerIpc; })()`, {
    IPC, AppError, serializeError, validateAiRequest, NavigationRequests, structuredClone,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} }
  });
  const lifecycle = register({ getMainWindow: () => null, localAi: { run } }); t.after(() => lifecycle.shutdown());
  let facade;
  vm.runInNewContext(preloadSource, { require(name) {
    assert.equal(name, 'electron'); return {
      ipcRenderer: { invoke: (channel, payload) => handlers.get(channel)(event, payload), on() {}, removeListener() {} },
      contextBridge: { exposeInMainWorld: (_name, value) => { facade = value; } }
    };
  } });
  return { event, api: facade.ai, lifecycle, invoke: (channel, payload, owner = event) => handlers.get(channel)(owner, payload) };
}
const connect = () => ({ action: 'connect', config: AI_DEFAULT_CONFIG });

test('real AI preload/IPC preparation performs no model work, consumes once and retires progress', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return { models: [{ id: 'one' }] }; });
  const { handle } = await f.api.prepare(connect()); assert.equal(calls, 0);
  const progress = await f.api.progress(handle); assert.equal(progress.phase, 'prepared');
  const result = await f.api.run(handle); assert.equal(result.models[0].id, 'one'); assert.equal(calls, 1);
  assert.equal(await f.api.progress(handle), null);
  await assert.rejects(f.api.run(handle), { code: 'NAVIGATION_CANCELLED' });
});

test('AI progress cannot reveal input/token/config and cannot be read or cancelled by another document', async t => {
  const entered = gate(), held = gate();
  const f = fixture(t, async (_input, _signal, progress) => { progress.phase = 'thinking'; entered.resolve(); await held.promise; return {}; });
  const { handle } = await f.api.prepare({ action: 'chat', config: { ...AI_DEFAULT_CONFIG, model: 'test' }, token: 'synthetic-token', prompt: 'PRIVATE_PROMPT', history: [], allowLookups: false });
  const running = f.api.run(handle); await entered.promise;
  try {
    const progress = await f.api.progress(handle); assert.equal(progress.phase, 'thinking');
    assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_PROMPT|synthetic-token|baseUrl|history|config/);
    for (const channel of [IPC.AI_PROGRESS, IPC.AI_RUN, IPC.AI_CANCEL]) {
      const different = await f.invoke(channel, { handle }, sender()); assert.equal(different.error.code, 'NAVIGATION_OWNER_INVALID');
      const child = await f.invoke(channel, { handle }, { ...f.event, senderFrame: { ...f.event.senderFrame } }); assert.equal(child.error.code, 'NAVIGATION_OWNER_INVALID');
    }
  } finally { held.resolve(); await running; }
});

test('untrusted inscription/wallet frames cannot access any AI channel before payload validation', async t => {
  const f = fixture(t, () => assert.fail('no model access'));
  for (const url of ['ord://content/anything', 'https://wallet.satoshi.invalid', 'https://example.com', 'file:///tmp/test.html'])
    for (const channel of [IPC.AI_PREPARE, IPC.AI_RUN, IPC.AI_PROGRESS, IPC.AI_CANCEL]) {
      const result = await f.invoke(channel, { invalid: true }, sender(url)); assert.equal(result.error.code, 'UNTRUSTED_IPC_SENDER');
    }
});

test('cancel before AI run and navigation after prepare cannot resurrect work', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; });
  const first = await f.api.prepare(connect()); await f.api.cancel(first.handle);
  await assert.rejects(f.api.run(first.handle), { code: 'NAVIGATION_CANCELLED' });
  const next = await f.api.prepare(connect()); f.event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await assert.rejects(f.api.run(next.handle), { code: 'NAVIGATION_CANCELLED' }); assert.equal(calls, 0);
});

test('AI IPC shutdown aborts admitted inference and drains ignored-abort settlement before closing', async t => {
  const entered = gate(), held = gate(); let signal;
  const f = fixture(t, async (_input, activeSignal) => { signal = activeSignal; entered.resolve(); await held.promise; return { late: true }; });
  const { handle } = await f.api.prepare(connect()); const running = f.api.run(handle); await entered.promise;
  const drain = f.lifecycle.shutdown(); assert.equal(signal.aborted, true); let drained = false; drain.then(() => { drained = true; });
  await assert.rejects(f.api.prepare(connect()), { code: 'APP_SHUTTING_DOWN' }); await Promise.resolve(); assert.equal(drained, false);
  held.resolve(); await assert.rejects(running, { code: 'NAVIGATION_CANCELLED' }); await drain; assert.equal(f.event.sender.eventNames().length, 0);
});

test('malformed payloads, unauthorized controls, and exhausted preparation capacity are rejected', async t => {
  const f = fixture(t, () => assert.fail('no model work'));
  await assert.rejects(f.api.prepare({ ...connect(), tools: [] }), { code: 'AI_VALIDATION' });
  for (const channel of [IPC.AI_RUN, IPC.AI_PROGRESS, IPC.AI_CANCEL]) {
    const result = await f.invoke(channel, { handle: 1, network: 'mainnet' }); assert.equal(result.error.code, 'VALIDATION_ERROR');
    const invalid = await f.invoke(channel, { handle: '1' }); assert.equal(invalid.error.code, 'INVALID_NAVIGATION_HANDLE');
  }
  for (let i = 0; i < 4; i++) await f.api.prepare(connect());
  await assert.rejects(f.api.prepare(connect()), { code: 'NAVIGATION_BUSY' });
});
