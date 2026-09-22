import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError, toAppError, errorFromSerialized } from '../src/shared/errors.js';

const cacheSource = (await fs.readFile(new URL('../src/main/cache.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export class DiskCache', 'class DiskCache');
const ipcSource = (await fs.readFile(new URL('../src/main/ipc.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function registerIpc', 'function registerIpc');
const renderer = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function actual(start, end) {
  const a = renderer.indexOf(start); const b = renderer.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return renderer.slice(a, b);
}

async function fixture(t, mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-clear-recovery-'));
  const objects = path.join(directory, 'objects'); const index = path.join(directory, 'index.json');
  const id = crypto.createHash('sha256').update('key').digest('hex');
  let armed = false; let deleted = false; let faults = 0; let readFaults = 0; let clearFailure = null;
  let clearCalls = 0; let removalCalls = 0; let deletionGate = null; let releaseDeletion = () => {}; let enteredDeletion = () => {};
  const primary = Object.assign(new Error(`Synthetic clear ${mode} failure`), { code: 'EACCES' });
  const readFailure = Object.assign(new Error('Synthetic cache statistics read failure'), { code: 'EIO' });
  const io = { ...fs,
    async rm(file, ...args) {
      if (file === directory) { removalCalls++; if (deletionGate) { enteredDeletion(); await deletionGate; } }
      if (armed && file === directory && mode === 'before-delete') { faults++; throw primary; }
      if (armed && file === directory && mode === 'partial-delete') {
        await fs.unlink(path.join(objects, id)); faults++; throw primary;
      }
      await fs.rm(file, ...args); if (armed && file === directory) deleted = true;
    },
    async mkdir(file, ...args) {
      if (armed && deleted && ['mkdir', 'mkdir-stats'].includes(mode) && file === objects) { faults++; throw primary; }
      return fs.mkdir(file, ...args);
    },
    async open(file, ...args) {
      if (armed && deleted && mode === 'index' && file.startsWith(`${index}.`)) { faults++; throw primary; }
      return fs.open(file, ...args);
    }
  };
  const Cache = vm.runInNewContext(`(() => { ${cacheSource}; return DiskCache; })()`, {
    fs: io, path, crypto, process: { pid: process.pid }, Buffer, structuredClone, AppError, serializeError, toAppError
  });
  const cache = new Cache(directory);
  const realStats = cache.stats.bind(cache);
  cache.stats = () => {
    if (armed && deleted && ['stats', 'mkdir-stats'].includes(mode)) { readFaults++; throw readFailure; }
    return realStats();
  };
  const realClear = cache.clear.bind(cache);
  cache.clear = async () => { clearCalls++; try { return await realClear(); } catch (error) { clearFailure = error; throw error; } };
  const handlers = new Map();
  const registerIpc = vm.runInNewContext(`(() => { ${ipcSource}; return registerIpc; })()`, {
    IPC, AppError, serializeError, path, structuredClone,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} }
  });
  const lifecycle = registerIpc({ cache, getMainWindow: () => null });
  t.after(async () => {
    releaseDeletion();
    try { await lifecycle.shutdown(); await cache.flush(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await cache.init(); await cache.put('key', Buffer.from('synthetic retained content'));
  const model = { cache: cache.stats() }; const replies = []; const toasts = [];
  let pageRebuilds = 0; let targetedUpdates = 0;
  const page = { identity: 'unchanged current page' };
  const invoke = async (channel) => {
    const reply = await handlers.get(channel)({ senderFrame: { url: 'app://app/renderer/index.html' } }, {});
    replies.push(reply); if (!reply.ok) throw errorFromSerialized(reply.error); return reply.result;
  };
  const clear = vm.runInNewContext(`(() => {
    ${actual('function publishCache(', '\nasync function refreshCacheStats(')}
    ${actual('async function clearCache()', '\nasync function refreshProviders(')}
    return clearCache;
  })()`, {
    MODEL: { patch: (update) => Object.assign(model, update) },
    elements: { page, 'cache-status': { textContent: '' } }, formatCache: (value) => `${value.entries} entries`,
    updateCacheViews: (node) => { assert.equal(node, page); targetedUpdates++; },
    renderPage: () => { pageRebuilds++; }, patch: () => { pageRebuilds++; },
    toast: (...args) => toasts.push(args), api: { cache: { clear: () => invoke(IPC.CACHE_CLEAR), stats: () => invoke(IPC.CACHE_STATS) } }
  });
  const exists = async () => {
    try { await fs.stat(path.join(objects, id)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return { cache, model, replies, toasts, exists, clear, realStats, primary, readFailure, lifecycle, clearFailure: () => clearFailure,
    holdDeletion() {
      deletionGate = new Promise((resolve) => { releaseDeletion = resolve; });
      const entered = new Promise((resolve) => { enteredDeletion = resolve; });
      return { entered, release: releaseDeletion };
    },
    arm: () => { armed = true; }, disarm: () => { armed = false; },
    observations: () => ({ deleted, faults, readFaults, clearCalls, removalCalls, pageRebuilds, targetedUpdates }) };
}

async function assertNoReplay(f) {
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.observations().clearCalls, 1);
  assert.equal(f.observations().removalCalls, 1);
}

for (const mode of ['mkdir', 'index']) {
  test(`clear deletion followed by ${mode} failure publishes partial outcome and remains explicitly retryable`, async (t) => {
    const f = await fixture(t, mode); f.arm(); await f.clear();
    await assertNoReplay(f);
    assert.equal(f.replies[0].error.details.cause.code, 'EACCES');
    assert.equal(f.replies[0].error.details.cause.message, f.primary.message);
    const initial = { deleted: f.observations().deleted, faults: f.observations().faults,
      originalPresent: await f.exists(), mainEntries: f.cache.stats().entries, renderedEntries: f.model.cache.entries,
      committed: f.replies[0].error?.details?.cacheClearCommitted ?? null,
      cacheReady: f.replies[0].error?.details?.cacheReady ?? null,
      successFeedback: f.toasts.some(([title]) => title === 'Content cache cleared'),
      recoveryFeedback: f.toasts.some(([title, message]) => /cleared|reinitial|recovery|retry/i.test(`${title} ${message}`)) };
    f.disarm(); await f.clear();
    const retry = { ok: f.replies.at(-1).ok, mainEntries: f.cache.stats().entries, renderedEntries: f.model.cache.entries };
    await f.cache.put('after-retry', Buffer.from('usable')); const usable = (await f.cache.get('after-retry')).data.toString();
    assert.deepEqual({ initial, retry, usable, pageRebuilds: f.observations().pageRebuilds }, {
      initial: { deleted: true, faults: 1, originalPresent: false, mainEntries: 0, renderedEntries: 0, committed: true, cacheReady: false, successFeedback: false, recoveryFeedback: true },
      retry: { ok: true, mainEntries: 0, renderedEntries: 0 }, usable: 'usable', pageRebuilds: 0
    });
  });
}

test('failure before deletion retains cache and never claims committed Clear; explicit retry succeeds', async (t) => {
  const f = await fixture(t, 'before-delete'); f.arm(); await f.clear();
  await assertNoReplay(f);
  assert.equal(f.replies[0].error.details.cacheReady, null);
  const initial = { deleted: f.observations().deleted, originalPresent: await f.exists(), mainEntries: f.cache.stats().entries,
    renderedEntries: f.model.cache.entries, claimedCommit: f.replies[0].error?.details?.cacheClearCommitted === true,
    successFeedback: f.toasts.some(([title]) => title === 'Content cache cleared') };
  f.disarm(); await f.clear();
  assert.deepEqual(initial, { deleted: false, originalPresent: true, mainEntries: 1, renderedEntries: 1, claimedCommit: false, successFeedback: false });
  assert.equal(f.replies.at(-1).ok, true); assert.equal(await f.exists(), false); assert.equal(f.model.cache.entries, 0);
});

test('ordinary successful Clear publishes empty statistics without rebuilding the current page', async (t) => {
  const f = await fixture(t, 'success'); f.arm(); await f.clear();
  await assertNoReplay(f);
  assert.equal(f.replies[0].ok, true); assert.equal(await f.exists(), false);
  assert.equal(f.cache.stats().entries, 0); assert.equal(f.model.cache.entries, 0);
  assert.equal(f.observations().pageRebuilds, 0); assert.equal(f.observations().targetedUpdates, 1);
  assert.equal(f.toasts.at(-1)[0], 'Content cache cleared');
});

test('completed Clear with unavailable statistics reports commitment and unknown snapshot without fabricated publication', async (t) => {
  const f = await fixture(t, 'stats'); f.arm(); await f.clear();
  await assertNoReplay(f);
  const failure = f.replies[0].error;
  const initial = { deleted: f.observations().deleted, originalPresent: await f.exists(), mainEntries: f.realStats().entries,
    renderedEntries: f.model.cache.entries, committed: failure?.details?.cacheClearCommitted ?? null,
    cacheReady: failure?.details?.cacheReady ?? null,
    snapshotUnknown: failure?.details?.cache === null,
    readError: failure?.details?.cacheReadError?.message ?? null,
    recoveryFeedback: f.toasts.some(([title, message]) => /cleared|reinitial|recovery|retry/i.test(`${title} ${message}`)) };
  f.disarm(); await f.clear();
  assert.deepEqual({ initial, retrySucceeded: f.replies.at(-1).ok, retryRendered: f.model.cache.entries }, {
    initial: { deleted: true, originalPresent: false, mainEntries: 0, renderedEntries: 1, committed: true, cacheReady: true,
      snapshotUnknown: true, readError: f.readFailure.message, recoveryFeedback: true },
    retrySucceeded: true, retryRendered: 0
  });
});

test('partial directory-removal failure never claims complete Clear or publishes stale statistics as authoritative', async (t) => {
  const f = await fixture(t, 'partial-delete'); f.arm(); await f.clear();
  await assertNoReplay(f);
  const initial = { completeRemoval: f.observations().deleted, originalPresent: await f.exists(), mainEntries: f.realStats().entries,
    renderedEntries: f.model.cache.entries, committed: f.replies[0].error?.details?.cacheClearCommitted ?? null,
    cacheReady: f.replies[0].error?.details?.cacheReady ?? null,
    snapshotUnknown: f.replies[0].error?.details?.cache === null,
    successFeedback: f.toasts.some(([title]) => title === 'Content cache cleared') };
  f.disarm(); await f.clear();
  assert.deepEqual({ initial, retrySucceeded: f.replies.at(-1).ok, retryRendered: f.model.cache.entries }, {
    initial: { completeRemoval: false, originalPresent: false, mainEntries: 1, renderedEntries: 1,
      committed: null, cacheReady: null, snapshotUnknown: true, successFeedback: false }, retrySucceeded: true, retryRendered: 0
  });
});

test('statistics read failure cannot replace the original post-deletion initialization failure', async (t) => {
  const f = await fixture(t, 'mkdir-stats'); f.arm(); await f.clear();
  await assertNoReplay(f);
  const failure = f.replies[0].error;
  assert.equal(failure.details.cause.code, 'EACCES');
  assert.equal(failure.details.cause.message, f.primary.message);
  assert.equal(failure.details.cacheReady, false);
  assert.notEqual(failure.details.cause.message, failure.details.cacheReadError.message);
  const initial = { originalCause: f.clearFailure()?.cause === f.primary,
    code: failure?.code, readError: failure?.details?.cacheReadError?.message ?? null,
    committed: failure?.details?.cacheClearCommitted ?? null, snapshotUnknown: failure?.details?.cache === null };
  f.disarm(); await f.clear();
  assert.deepEqual({ initial, retrySucceeded: f.replies.at(-1).ok }, {
    initial: { originalCause: true, code: 'CACHE_REINITIALIZATION_FAILED', readError: f.readFailure.message,
      committed: true, snapshotUnknown: true }, retrySucceeded: true
  });
});

test('IPC shutdown drains an admitted held Clear and rejects new Clear admission without replay', { timeout: 3000 }, async (t) => {
  const f = await fixture(t, 'success'); const gate = f.holdDeletion(); f.arm();
  const clearing = f.clear(); await gate.entered;
  let drained = false; const shutdown = f.lifecycle.shutdown().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false); assert.equal(await f.exists(), true);
  await f.clear(); assert.equal(f.replies[0].error.code, 'APP_SHUTTING_DOWN');
  assert.equal(f.observations().clearCalls, 1); assert.equal(f.observations().removalCalls, 1);
  gate.release(); await Promise.all([clearing, shutdown]);
  assert.equal(drained, true); assert.equal(f.replies.filter((reply) => reply.ok).length, 1);
  assert.equal(await f.exists(), false); assert.equal(f.model.cache.entries, 0);
  assert.equal(f.observations().removalCalls, 1);
});
