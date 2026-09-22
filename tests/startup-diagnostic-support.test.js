import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { normalizeStartupContext, validateStartupBarrierEvents, STARTUP_BARRIER_MODES, STARTUP_CONTINUATION_MODE } from '../scripts/startup-barrier-support.mjs';
import {
  boundedDiagnosticValue,
  buildAppPreloadProbe,
  createBoundedOutput,
  validateCdpObserver,
  validateStartupMarkers,
  waitForStartupChildClose
} from '../scripts/startup-diagnostic-support.mjs';

test('bounded output retains only the byte prefix and tracks hostile overflow', () => {
  const output = createBoundedOutput(5);
  output.append(Buffer.from('abc'));
  output.append(Buffer.from('defghijkl'));
  assert.equal(output.text, 'abcde');
  assert.equal(output.totalBytesSeen, 12);
  assert.equal(output.truncated, true);
  output.append(Buffer.alloc(1_000_000));
  assert.equal(output.text.length, 5);
  assert.equal(output.totalBytesSeen, 1_000_012);
});

test('bounded output uses byte limits for split UTF-8 chunks and safe defaults', () => {
  const split = createBoundedOutput(4);
  split.append(Buffer.from('🙂x'));
  assert.equal(split.text, '🙂');
  assert.equal(split.totalBytesSeen, 5);
  assert.equal(split.truncated, true);
  const defaults = createBoundedOutput();
  defaults.append(Buffer.alloc(128 * 1024 + 1, 97));
  assert.equal(Buffer.byteLength(defaults.text), 128 * 1024);
  assert.equal(defaults.truncated, true);
});

const validEvents = () => [
  { event: 'ignored', data: 'anything' },
  { event: 'preload-marker', phase: 1, webContentsId: 10, marker: { sandboxed: true, contextIsolated: true, href: 'data:text/html,one' } },
  { event: 'did-finish-load', phase: 1, webContentsId: 10 },
  { event: 'preload-marker', phase: 2, webContentsId: 11, marker: { sandboxed: true, contextIsolated: true, href: 'https://wallet.satoshi.invalid/' } },
  { event: 'did-finish-load', phase: 2, webContentsId: 11 },
  { event: 'finish', reason: 'second-preload-marker' }
];

test('startup marker validation requires exactly two phases, windows, and matching finish', () => {
  assert.equal(validateStartupMarkers(validEvents()), true);
  assert.equal(validateStartupMarkers([...validEvents(), validEvents()[1]]), false);
  assert.equal(validateStartupMarkers(validEvents().map((event) => event.phase === 2 ? { ...event, phase: 1 } : event)), false);
  assert.equal(validateStartupMarkers(validEvents().map((event) => event.phase === 2 ? { ...event, webContentsId: 10 } : event)), false);
  assert.equal(validateStartupMarkers(validEvents().filter((event) => event.event !== 'finish')), false);
  assert.equal(validateStartupMarkers([...validEvents(), { event: 'finish', reason: 'second-preload-marker' }]), false);
  assert.equal(validateStartupMarkers([...validEvents(), { event: 'finish', reason: 'timeout' }]), false);
  assert.equal(validateStartupMarkers(validEvents().filter((event) => event.event !== 'did-finish-load')), false);
  assert.equal(validateStartupMarkers(validEvents().map((event) => event.event === 'did-finish-load' && event.webContentsId === 11 ? { ...event, webContentsId: 10 } : event)), false);
});

test('startup marker validation rejects unsafe or oversized marker fields', () => {
  for (const marker of [
    { sandboxed: false, contextIsolated: true, href: 'ok' },
    { sandboxed: true, contextIsolated: false, href: 'ok' },
    { sandboxed: true, contextIsolated: true, href: 42 },
    { sandboxed: true, contextIsolated: true, href: 'x'.repeat(4_097) }
  ]) {
    const events = validEvents();
    events[1] = { ...events[1], marker };
    assert.equal(validateStartupMarkers(events), false);
  }
});

test('startup marker validation rejects explicit load and preload errors', () => {
  for (const event of ['load-error', 'preload-error', 'preload-marker-rejected']) {
    assert.equal(validateStartupMarkers([...validEvents(), { event }]), false);
  }
});

test('CDP observer validation requires the complete normalized attachment lifecycle', () => {
  const names = ['target-discovered', 'socket-open', 'runtime-enabled', 'page-enabled', 'log-enabled', 'facade-true', 'socket-closed'];
  const valid = {
    mode: 'full',
    exercised: true,
    facade: true,
    milestones: names.map((name, index) => ({ name, elapsedMs: name === 'socket-closed' ? 260 : index }))
  };
  assert.equal(validateCdpObserver(valid, 'full'), true);
  assert.equal(validateCdpObserver({ ...valid, exercised: false }), false);
  assert.equal(validateCdpObserver({ ...valid, facade: false }), false);
  assert.equal(validateCdpObserver({ ...valid, milestones: valid.milestones.slice(0, -1) }), false);
  assert.equal(validateCdpObserver({ ...valid, milestones: [...valid.milestones].reverse() }), false);
  assert.equal(validateCdpObserver({ ...valid, milestones: valid.milestones.map((item, index) => index === 3 ? { ...item, elapsedMs: -1 } : item) }), false);
  const discovery = { mode: 'discovery', exercised: true, facade: null, milestones: [{ name: 'target-discovered', elapsedMs: 12 }] };
  assert.equal(validateCdpObserver(discovery, 'discovery'), true);
  assert.equal(validateCdpObserver({ ...discovery, milestones: [...discovery.milestones, { name: 'socket-open', elapsedMs: 13 }] }, 'discovery'), false);
  const socket = { mode: 'socket', exercised: true, facade: null, milestones: [
    { name: 'target-discovered', elapsedMs: 12 }, { name: 'socket-open', elapsedMs: 14 }, { name: 'socket-closed', elapsedMs: 264 }
  ] };
  assert.equal(validateCdpObserver(socket, 'socket'), true);
  assert.equal(validateCdpObserver({ ...socket, facade: true }, 'socket'), false);
  assert.equal(validateCdpObserver({ ...socket, milestones: socket.milestones.map((item) => item.name === 'socket-closed' ? { ...item, elapsedMs: 263 } : item) }, 'socket'), false);
  const runtime = { mode: 'runtime', exercised: true, facade: null, milestones: [
    { name: 'target-discovered', elapsedMs: 12 }, { name: 'socket-open', elapsedMs: 14 },
    { name: 'runtime-enabled', elapsedMs: 16 }, { name: 'socket-closed', elapsedMs: 264 }
  ] };
  assert.equal(validateCdpObserver(runtime, 'runtime'), true);
  assert.equal(validateCdpObserver({ ...runtime, milestones: runtime.milestones.filter((item) => item.name !== 'runtime-enabled') }, 'runtime'), false);
  assert.equal(validateCdpObserver(socket, 'full'), false);
});

test('application preload probe preserves production bytes and emits only its synchronous marker after exposing the facade', () => {
  const production = fs.readFileSync(new URL('../src/main/preload.cjs', import.meta.url));
  const probe = buildAppPreloadProbe(production);
  assert.equal(probe.subarray(0, production.length).equals(production), true);
  const suffix = probe.subarray(production.length).toString('utf8');
  assert.match(suffix, /^\nipcRenderer\.send\('wallet-startup:preload'/);
  assert.doesNotMatch(suffix, /require\(|const\s+\{\s*contextBridge|let\s+ipcRenderer|const\s+ipcRenderer/);

  const events = [];
  const exposed = {};
  const ipcRenderer = {
    send(channel, marker) { events.push({ type: 'send', channel, marker, facadePresent: Boolean(exposed.satBrowser) }); },
    invoke() { events.push({ type: 'invoke' }); },
    on() { events.push({ type: 'subscribe' }); },
    removeListener() { events.push({ type: 'unsubscribe' }); }
  };
  const contextBridge = {
    exposeInMainWorld(name, value) { exposed[name] = value; events.push({ type: 'expose', name }); }
  };
  vm.runInNewContext(probe.toString('utf8'), {
    require(specifier) {
      assert.equal(specifier, 'electron');
      return { contextBridge, ipcRenderer };
    },
    location: { href: 'app://app/renderer/index.html' },
    process: { sandboxed: true, contextIsolated: true }
  });
  assert.equal(typeof exposed.satBrowser?.app?.bootstrap, 'function');
  assert.deepEqual(events.map((event) => event.type), ['expose', 'send']);
  assert.equal(events[1].channel, 'wallet-startup:preload');
  assert.equal(events[1].facadePresent, true);
  assert.deepEqual(structuredClone(events[1].marker), {
    href: 'app://app/renderer/index.html', sandboxed: true, contextIsolated: true
  });
});

test('diagnostic sanitizer bounds strings, arrays, keys, depth, cycles, and getters', () => {
  const cyclic = { text: 'x'.repeat(2_000), array: Array.from({ length: 80 }, (_, index) => index) };
  cyclic.self = cyclic;
  cyclic.deep = { one: { two: { three: { four: { five: 'hidden' } } } } };
  Object.defineProperty(cyclic, 'hostile', { enumerable: true, get() { throw new Error('getter ran'); } });
  Object.defineProperty(cyclic, '__proto__', { enumerable: true, value: { polluted: true } });
  for (let index = 0; index < 80; index += 1) cyclic[`key-${index}`] = index;
  const safe = boundedDiagnosticValue(cyclic);
  assert.equal(safe.text.length, 1_024);
  assert.equal(safe.array.length, 40);
  assert.equal(safe.self, '[Circular]');
  assert.equal(safe.deep.one.two.three.four, '[Depth limit]');
  assert.equal(safe.hostile, '[Thrown]');
  assert.equal(Object.getPrototypeOf(safe), null);
  assert.equal(Object.keys(safe).length, 40);
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test('diagnostic sanitizer stops traversing after the total node budget', () => {
  const value = Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => ({ value: 'x' })));
  const serialized = JSON.stringify(boundedDiagnosticValue(value));
  assert.match(serialized, /\[Node limit\]/);
  assert.ok(serialized.length < 20_000);
});

test('startup barrier context metadata omits arbitrary names, origins and payloads', () => {
  const value = normalizeStartupContext('Runtime.executionContextCreated', { context: {
    id: 7, name: 'private wallet label', origin: 'https://secret.example/token',
    auxData: { frameId: 'A-12', isDefault: false, type: 'isolated', secret: 'hidden' },
    extra: 'not retained'
  } });
  assert.deepEqual(value, { method: 'Runtime.executionContextCreated', contextId: 7, frameId: 'A-12',
    isDefault: false, type: 'isolated', origin: '[other]', name: '[omitted]' });
  assert.equal(normalizeStartupContext('Runtime.consoleAPICalled', { args: ['secret'] }), null);
  assert.equal(normalizeStartupContext('Runtime.executionContextCreated', { context: { id: -1, auxData: { frameId: 'x'.repeat(161) } } }).frameId, null);
  assert.equal(normalizeStartupContext('Runtime.executionContextDestroyed', { executionContextId: 9 }).contextId, 9);
  assert.equal(normalizeStartupContext('Runtime.executionContextsCleared', {}).contextId, null);
});

function barrierEvents(mode) {
  return [1, 2].flatMap(phase => {
    const observer = ['barrier-observer-start', mode === 'held-native-runtime' ? 'barrier-native-attached' : 'barrier-socket-open',
      ...(mode === 'held-socket' ? [] : ['barrier-runtime-enabled']),
      mode === 'held-native-runtime' ? 'barrier-native-detached' : 'barrier-socket-closed', 'barrier-observer-complete'];
    const names = mode === 'post-load-runtime'
      ? ['response-released', 'preload-marker', 'did-finish-load', ...observer, 'barrier-window-closed']
      : ['response-held', ...observer, 'response-released', 'preload-marker', 'did-finish-load', 'barrier-window-closed'];
    return names.map((event, index) => ({ event, phase, elapsedMs: index * 250, webContentsId: 10 + phase, ...(event === 'barrier-observer-complete' ? { cleanClose: true } : {}) }));
  });
}

test('startup barrier evidence requires each generation and transport completion before response release', () => {
  for (const mode of STARTUP_BARRIER_MODES.filter(value => value !== STARTUP_CONTINUATION_MODE)) {
    const events = barrierEvents(mode);
    assert.equal(validateStartupBarrierEvents(events, mode), true, mode);
    assert.equal(validateStartupBarrierEvents(events.filter(event => event.phase === 1), mode), false);
    assert.equal(validateStartupBarrierEvents([...events, events[0]], mode), false);
    assert.equal(validateStartupBarrierEvents(events.map(event => event.event === 'barrier-observer-complete' ? { ...event, cleanClose: false } : event), mode), false);
    assert.equal(validateStartupBarrierEvents(events.map(event => event.event === 'did-finish-load' ? { ...event, webContentsId: 50 } : event), mode), false);
    assert.equal(validateStartupBarrierEvents(events.map(event => ({ ...event, elapsedMs: 0 })), mode), false);
    assert.equal(validateStartupBarrierEvents(events.filter(event => !['barrier-native-detached', 'barrier-socket-closed'].includes(event.event)), mode), false);
    for (const event of ['barrier-failure', 'barrier-limit', 'barrier-deadline', 'preload-marker-rejected']) {
      assert.equal(validateStartupBarrierEvents([...events, { event }], mode), false);
    }
  }
  const events = barrierEvents('held-remote-runtime');
  const released = events.findIndex(event => event.event === 'response-released');
  [events[1], events[released]] = [events[released], events[1]];
  assert.equal(validateStartupBarrierEvents(events, 'held-remote-runtime'), false);
});

test('post-load control requires both load and preload, while socket control must not enable Runtime', () => {
  const events = barrierEvents('post-load-runtime');
  [events[1], events[3]] = [events[3], events[1]];
  assert.equal(validateStartupBarrierEvents(events, 'post-load-runtime'), false);
  assert.equal(validateStartupBarrierEvents([...barrierEvents('held-socket'), { event: 'barrier-runtime-enabled', phase: 1 }], 'held-socket'), false);
  assert.equal(validateStartupBarrierEvents(barrierEvents('held-remote-runtime').filter(event => event.event !== 'barrier-runtime-enabled'), 'held-remote-runtime'), false);
});

function fakeStartupChild(kill) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = signal => kill?.(signal, child) ?? true;
  return child;
}

test('owned startup child errors are recorded but cannot resolve ownership before close', async () => {
  const child = fakeStartupChild();
  let settled = false;
  const result = waitForStartupChildClose(child, 1000, 10).then(value => { settled = true; return value; });
  child.emit('error', { code: 'ENOENT' });
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('close', -2, null);
  assert.deepEqual(await result, { closeConfirmed: true, code: -2, signal: null, forced: false, timedOut: false, spawnError: 'ENOENT', killError: null });
});

test('owned startup timeout records forced termination and waits for confirmed close', async () => {
  const child = fakeStartupChild((signal, owned) => {
    assert.equal(signal, 'SIGKILL');
    owned.signalCode = signal;
    queueMicrotask(() => owned.emit('close', null, signal));
    return true;
  });
  const result = await waitForStartupChildClose(child, 5, 20);
  assert.equal(result.closeConfirmed, true);
  assert.equal(result.forced, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
});

test('failed kill and missing close return unconfirmed ownership within the second bound', async () => {
  const child = fakeStartupChild(() => false);
  const result = await waitForStartupChildClose(child, 5, 5);
  assert.equal(result.closeConfirmed, false);
  assert.equal(result.forced, true);
  assert.equal(result.killError, 'KILL_NOT_SENT');
  assert.doesNotThrow(() => child.emit('error', { code: 'LATE_ERROR' }));
  child.emit('close', null, 'SIGKILL');
  assert.equal(result.closeConfirmed, false);
});

test('an exit code without a close event is not confirmed cleanup and is not killed again', async () => {
  const child = fakeStartupChild(assert.fail);
  child.exitCode = 0;
  const result = await waitForStartupChildClose(child, 5, 5);
  assert.equal(result.closeConfirmed, false);
  assert.equal(result.code, 0);
  assert.equal(result.forced, false);
  assert.equal(result.timedOut, true);
});
