import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { finalizePackagedEvidence } from '../scripts/packaged-smoke-child-lifecycle.mjs';
import { readStartupInput } from '../scripts/startup-barrier-support.mjs';
import { STARTUP_BARRIER_MODES, STARTUP_CONTINUATION_MODE, startupFrameIdentity, startNativeContinuation, normalizeStartupContext, runStartupBarrierCase, validateStartupBarrierEvents } from '../scripts/startup-barrier-support.mjs';

const target = 'app://app/renderer/index.html';
function events() {
  return [1, 2].flatMap(phase => {
    const names = ['response-held', 'barrier-observer-start', 'barrier-native-attached', 'barrier-context', 'barrier-runtime-enabled',
      'response-released', 'barrier-context', 'preload-marker', 'did-finish-load', 'barrier-native-detached', 'barrier-observer-complete', 'barrier-window-closed'];
    return names.map((event, index) => ({ event, phase, webContentsId: phase + 10, elapsedMs: index * 250,
      responseState: index < 5 ? 'held' : 'released',
      ...(['response-held', 'response-released', 'preload-marker', 'did-finish-load'].includes(event)
        ? { rendererPid: 100 + phase, frameProcessId: phase, frameRoutingId: 1, frameUrl: index < 5 ? 'about:blank' : target } : {}),
      ...(event === 'barrier-context' ? { method: 'Runtime.executionContextCreated', contextId: index, frameId: `frame-${phase}`,
        isDefault: true, type: 'default', origin: index < 5 ? '[other]' : 'app://app', name: '[omitted]' } : {}),
      ...(event === 'barrier-observer-complete' ? { cleanClose: true } : {}) }));
  });
}

test('continuation qualifies two owned generations across release and both document milestones', () => {
  assert.equal(validateStartupBarrierEvents(events(), STARTUP_CONTINUATION_MODE), true);
  assert.equal(validateStartupBarrierEvents(events(), 'held-native-runtime'), false);
  const reversed = events();
  const a = reversed.findIndex(x => x.event === 'preload-marker');
  const b = reversed.findIndex(x => x.event === 'did-finish-load');
  [reversed[a], reversed[b]] = [reversed[b], reversed[a]];
  assert.equal(validateStartupBarrierEvents(reversed, STARTUP_CONTINUATION_MODE), true);
});

test('continuation rejects missing, duplicate, stale-owned and incorrectly ordered evidence', () => {
  const mutations = [
    xs => xs.filter(x => x.phase === 1),
    xs => [...xs, xs[0]],
    xs => xs.filter(x => x.event !== 'did-finish-load'),
    xs => xs.filter(x => !(x.event === 'barrier-context' && x.responseState === 'released')),
    xs => xs.map(x => x.event === 'barrier-context' ? { ...x, webContentsId: 999 } : x),
    xs => xs.map(x => x.event === 'barrier-context' ? { ...x, responseState: 'released' } : x),
    xs => xs.map(x => x.event === 'barrier-context' ? { ...x, method: 'Runtime.consoleAPICalled' } : x),
    xs => xs.map(x => x.phase === 2 ? { ...x, webContentsId: 11 } : x),
    xs => xs.map(x => x.event === 'did-finish-load' ? { ...x, rendererPid: null } : x),
    xs => xs.map(x => x.event === 'did-finish-load' ? { ...x, frameUrl: 'https://private.invalid/' } : x),
    xs => [...xs, { event: 'barrier-limit' }],
    xs => [...xs, { event: 'barrier-failure', code: 'BARRIER_NATIVE_EARLY_DETACH' }],
    xs => [...xs, { event: 'barrier-context', phase: 3 }],
    xs => { const detached = xs.splice(xs.findIndex(x => x.event === 'barrier-native-detached'), 1)[0]; xs.splice(5, 0, detached); return xs; }
  ];
  for (const mutate of mutations) assert.equal(validateStartupBarrierEvents(mutate(events()), STARTUP_CONTINUATION_MODE), false);
});

test('actual continuation case completes both generations with attachment crossing real fixture milestones', async () => {
  const app = new EventEmitter(); const ipcMain = new EventEmitter(); const handlers = {}; const output = []; const instances = [];
  let exits = 0;
  Object.assign(app, { enableSandbox() {}, whenReady: async () => {}, quit() {}, exit() { exits++; } });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); instances.push(this); const n = instances.length;
      const wc = new EventEmitter(); this.webContents = wc; wc.id = n;
      wc.mainFrame = { url: 'about:blank', processId: n, routingId: 1 }; wc.getOSProcessId = () => 100 + n;
      wc.setWindowOpenHandler = () => {};
      wc.debugger = debuggerFixture().api;
      app.emit('web-contents-created', {}, wc);
    }
    async loadURL(url) {
      const response = await handlers.app({ url });
      assert.equal(response.status, 200);
      assert.equal(this.webContents.debugger.isAttached(), true, 'observer detached before response returned');
      this.webContents.mainFrame.url = url;
      this.webContents.debugger.emit('message', {}, 'Runtime.executionContextsCleared', {});
      this.webContents.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 2, origin: 'app://app', auxData: { frameId: 'F', isDefault: true, type: 'default' } } });
      ipcMain.emit('wallet-startup:preload', { sender: this.webContents, senderFrame: this.webContents.mainFrame }, { href: url, sandboxed: true, contextIsolated: true });
      this.webContents.emit('did-finish-load');
    }
    close() { assert.equal(this.webContents.debugger.isAttached(), false); this.emit('closed'); }
  }
  const electron = { app, BrowserWindow, ipcMain, protocol: { registerSchemesAsPrivileged() {} },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} },
      protocol: { handle: async (scheme, fn) => { handlers[scheme] = fn; } } }) } };
  const source = runStartupBarrierCase.toString();
  assert.equal(source.split("await import('electron')").length, 2);
  const run = vm.runInNewContext(`(${source.replace("await import('electron')", 'electron')})`, {
    electron, STARTUP_BARRIER_MODES, STARTUP_CONTINUATION_MODE, TARGET: target, startupFrameIdentity, normalizeStartupContext,
    startNativeContinuation: (api, emit, observe) => startNativeContinuation(api, emit, observe, async () => {}),
    deadline: async promise => promise, fs: { readFile: async () => '<!doctype html>' },
    Date, Response, setTimeout, clearTimeout, process: { pid: 1000, versions: { electron: 'fixture' } },
    console: { log: line => output.push(JSON.parse(line)) }
  });
  await run({ mode: STARTUP_CONTINUATION_MODE, port: 0, preloadPath: '/fixture/preload', htmlPath: '/fixture/index' });
  // Synthetic pauses intentionally do not satisfy the native duration gate.
  for (let i = 0; i < output.length; i++) output[i].elapsedMs = i * 250;
  assert.equal(exits, 0); assert.equal(instances.length, 2);
  assert.equal(validateStartupBarrierEvents(output, STARTUP_CONTINUATION_MODE), true);
  assert.equal(output.filter(x => x.event === 'preload-marker').length, 2);
});

test('frame identity emits only classified URLs and positive bounded native identifiers', () => {
  assert.deepEqual(startupFrameIdentity({ mainFrame: { url: 'https://secret.invalid/path', processId: 2, routingId: 3 }, getOSProcessId: () => 4 }),
    { rendererPid: 4, frameProcessId: 2, frameRoutingId: 3, frameUrl: '[other]' });
  assert.deepEqual(startupFrameIdentity({ get mainFrame() { throw Error('private'); }, getOSProcessId: () => -1 }),
    { rendererPid: null, frameProcessId: null, frameRoutingId: null, frameUrl: '[other]' });
});

function debuggerFixture() {
  const api = new EventEmitter(); let attached = false; const commands = [];
  api.attach = () => { attached = true; };
  api.detach = () => { attached = false; api.emit('detach'); };
  api.isAttached = () => attached;
  api.sendCommand = async method => { commands.push(method); api.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1 } }); };
  return { api, commands };
}

test('native continuation remains attached through caller release/load and sends only Runtime.enable', async () => {
  const { api, commands } = debuggerFixture(); const observed = []; const emitted = []; const pauses = [];
  const observer = await startNativeContinuation(api, event => emitted.push(event), (method, params) => observed.push([method, params]), async ms => pauses.push(ms));
  assert.equal(api.isAttached(), true);
  emitted.push('response-released', 'preload-marker', 'did-finish-load');
  api.emit('message', {}, 'Runtime.executionContextsCleared', {});
  await observer.finish();
  assert.deepEqual(commands, ['Runtime.enable']);
  assert.deepEqual(pauses, [250, 250]);
  assert.equal(observed.length, 2);
  assert.ok(emitted.indexOf('did-finish-load') < emitted.indexOf('barrier-native-detached'));
  assert.equal(emitted.at(-1), 'barrier-observer-complete');
  assert.equal(api.listenerCount('message'), 0); assert.equal(api.listenerCount('detach'), 0);
  assert.equal(api.isAttached(), false);
});

test('early detach and command failure cannot qualify and always release listeners', async () => {
  const fixture = debuggerFixture(); const emitted = [];
  const observer = await startNativeContinuation(fixture.api, event => emitted.push(event), () => {}, async () => {});
  fixture.api.detach();
  await assert.rejects(observer.finish(), /BARRIER_NATIVE_EARLY_DETACH/);
  assert.ok(emitted.includes('barrier-failure')); assert.equal(emitted.includes('barrier-observer-complete'), false);
  const failed = debuggerFixture(); failed.api.sendCommand = async () => { throw Error('fixture'); };
  await assert.rejects(startNativeContinuation(failed.api, () => {}, () => {}, async () => {}), /fixture/);
  assert.equal(failed.api.isAttached(), false); assert.equal(failed.api.listenerCount('message'), 0);
});

test('continuation requires explicit selection, fresh/reused profiles, no remote port and report-before-detach wrapper', async () => {
  const source = await fs.readFile(new URL('../scripts/diagnose-wallet-startup.mjs', import.meta.url), 'utf8');
  assert.match(source, /barrierSelection === 'all' \? STARTUP_BARRIER_MODES.filter\(mode => mode !== STARTUP_CONTINUATION_MODE\)/);
  assert.match(source, /selected.includes\(STARTUP_CONTINUATION_MODE\) && profileSelection !== 'fresh-reused'/);
  assert.match(source, /remoteDebugging: mode !== 'held-native-runtime' && mode !== STARTUP_CONTINUATION_MODE/);
  assert.match(source, /unconfirmedChildren.add\(child\)/);
  assert.match(source, /await finalizePackagedEvidence\(orchestrate/);
  assert.match(source, /unknownPids: \[...unconfirmedChildren\]/);
});

test('bounded provenance reader rejects links/oversize and detects exact changed bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-continuation-provenance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'fixture');
  await fs.writeFile(filename, 'fixture-one');
  const before = await readStartupInput(filename, 100);
  await assert.rejects(readStartupInput(filename, 3), /BOUNDED_REGULAR/);
  await fs.symlink(filename, path.join(directory, 'link'));
  await assert.rejects(readStartupInput(path.join(directory, 'link'), 100), /BOUNDED_REGULAR/);
  await fs.writeFile(filename, 'fixture-two');
  const after = await readStartupInput(filename, 100);
  assert.notEqual(before.sha256, after.sha256);
  assert.equal(before.bytes, 11);
});

test('actual orchestration stops unknown child, retains profile and reports before detaching even on write failure', async () => {
  const source = await fs.readFile(new URL('../scripts/diagnose-wallet-startup.mjs', import.meta.url), 'utf8');
  const orchestrator = source.slice(source.indexOf('async function orchestrate()'), source.indexOf('\nif (process.versions.electron)'));
  const wrapper = source.slice(source.lastIndexOf('  await finalizePackagedEvidence('), source.lastIndexOf('\n}'));
  for (const failWrite of [false, true]) {
    const order = []; let launches = 0; let report;
    const unconfirmedChildren = new Set(); const retainedProfiles = new Set();
    const child = { pid: 12345, unref: () => order.push('detach'), stdout: { unref() {} }, stderr: { unref() {} } };
    const fakeFs = {
      async access(filename) { if (filename === '/report.json') { const error = Error(); error.code = 'ENOENT'; throw error; } },
      async mkdtemp() { return '/owned-fixture'; },
      async writeFile(filename, contents) { if (filename === '/report.json') { order.push('report'); if (failWrite) throw Error('write failed'); report = JSON.parse(contents); } },
      async rm() { throw Error('must not remove unknown-child profile'); }
    };
    const run = vm.runInNewContext(`(async () => { ${orchestrator}\n${wrapper} })`, {
      fs: fakeFs, path, os, root: '/root', electronExecutable: '/electron', reportPath: '/report.json',
      barrierSelection: STARTUP_CONTINUATION_MODE, STARTUP_CONTINUATION_MODE, STARTUP_BARRIER_MODES,
      argument: () => 'fresh-reused', unconfirmedChildren, retainedProfiles, Buffer, Date,
      readStartupInput: async () => ({ data: Buffer.from('prefix') }), buildAppPreloadProbe: data => data,
      captureStartupContinuationInputs: async () => ({ version: '44.2.0' }),
      launch: async () => { launches++; unconfirmedChildren.add(child); return { closeConfirmed: false, markerValid: false, electron: '44.2.0' }; },
      finalizePackagedEvidence, process: { exitCode: 0, stderr: { write: text => { order.push('fallback'); assert.deepEqual(JSON.parse(text).unknownPids, [12345]); } } },
      console: { log() {} }
    });
    if (failWrite) await assert.rejects(run(), /write failed/); else await run();
    assert.equal(launches, 1); assert.ok(retainedProfiles.has('/owned-fixture'));
    assert.deepEqual(order, failWrite ? ['report', 'fallback', 'detach'] : ['report', 'detach']);
    if (report) { assert.equal(report.complete, false); assert.equal(report.temporaryProfilesRemoved, false); assert.equal(report.profiles[0].retainReason, 'OWNED_CLOSE_UNCONFIRMED'); }
  }
});
