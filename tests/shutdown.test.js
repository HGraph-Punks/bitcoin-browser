import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createQuitWatchdog, createSignalShutdownHandler, handleServiceBeforeQuit, settleShutdownStages, shutdownApplicationManagers } from '../src/main/local-service-manager.js';

function deferredTurn() {
  const callbacks = [];
  return {
    defer(callback) { callbacks.push(callback); },
    run() {
      assert.equal(callbacks.length, 1);
      callbacks.shift()();
    }
  };
}

test('whole-quit watchdog remains armed until its explicit completion clear', () => {
  const calls = [];
  let callback;
  const watchdog = createQuitWatchdog({
    app: { exit: (code) => calls.push(`exit:${code}`) },
    timeoutMs: 12_000,
    setTimer: (action, timeout) => { calls.push(`arm:${timeout}`); callback = action; return 7; },
    clearTimer: (timer) => calls.push(`clear:${timer}`),
    onPhase: (phase) => calls.push(`phase:${phase}`)
  });
  assert.equal(watchdog.arm(), true);
  assert.equal(watchdog.arm(), false);
  assert.equal(watchdog.isArmed(), true);
  assert.equal(watchdog.clear(), true);
  assert.equal(watchdog.isArmed(), false);
  assert.deepEqual(calls, ['arm:12000', 'clear:7']);

  watchdog.arm();
  callback();
  assert.equal(watchdog.isArmed(), false);
  assert.deepEqual(calls.slice(-2), ['phase:forced-fallback', 'exit:1']);
});

test('Electron lifecycle wiring retains watchdog through will-quit and clears it on quit', () => {
  const source = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  const willQuit = source.slice(source.indexOf("app.on('will-quit'"), source.indexOf("app.on('quit'"));
  const quit = source.slice(source.indexOf("app.on('quit'"), source.indexOf("app.on('window-all-closed'"));
  assert.doesNotMatch(willQuit, /quitWatchdog\.clear/);
  assert.match(willQuit, /logShutdownPhase\('will-quit'\)/);
  assert.match(quit, /quitWatchdog\.clear\(\)/);
});

test('native before-quit and signal shutdown share one forcing watchdog', () => {
  const calls = [];
  let timers = 0;
  const app = { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) };
  const watchdog = createQuitWatchdog({ app, setTimer: () => { timers += 1; return timers; }, clearTimer: () => {} });
  watchdog.arm();
  const signal = createSignalShutdownHandler({ app, quitWatchdog: watchdog, logger: null });
  signal();
  assert.equal(timers, 1);
  assert.deepEqual(calls, ['quit']);
});

test('signal shutdown arms its fallback before quit and ignores repeated signals', () => {
  const calls = [];
  let fallback;
  let clock = 100;
  const handler = createSignalShutdownHandler({
    app: { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) },
    logger: { info: (_event, fields) => calls.push(`phase:${fields.phase}:${fields.pid}:${fields.elapsedMs}`) },
    setTimer: (callback, timeout) => { calls.push(`timer:${timeout}`); fallback = callback; },
    now: () => clock,
    timeoutMs: 12_000,
    pid: 42
  });
  assert.equal(handler(), true);
  assert.equal(handler(), false);
  assert.deepEqual(calls, ['phase:signal-requested:42:0', 'timer:12000', 'quit']);
  clock = 12_100;
  fallback();
  assert.deepEqual(calls.slice(-2), ['phase:forced-fallback:42:12000', 'exit:1']);
});

test('signal shutdown still arms and exits when phase logging throws', () => {
  const calls = [];
  let fallback;
  const handler = createSignalShutdownHandler({
    app: { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) },
    logger: { info: () => { throw new Error('logger unavailable'); } },
    consoleTarget: { error: (_event, fields) => calls.push(`console:${fields.phase}`) },
    setTimer: (callback) => { calls.push('timer'); fallback = callback; },
    now: () => 1,
    pid: 42
  });
  handler();
  assert.deepEqual(calls, ['console:signal-requested', 'timer', 'quit']);
  fallback();
  assert.equal(calls.at(-2), 'console:forced-fallback');
  assert.equal(calls.at(-1), 'exit:1');
});

test('successful service shutdown defers the second app quit past the canceled before-quit callback', async () => {
  const turn = deferredTurn();
  const calls = [];
  const app = {
    __servicesStopping: false,
    quit() { calls.push('quit'); },
    exit(code) { calls.push(`exit:${code}`); }
  };
  const event = { preventDefault() { calls.push('prevent'); } };
  const localServiceManager = { logger: null, shutdown: () => Promise.resolve() };

  assert.equal(handleServiceBeforeQuit(event, { app, localServiceManager, defer: turn.defer }), true);
  assert.deepEqual(calls, ['prevent']);
  await Promise.resolve();
  assert.deepEqual(calls, ['prevent']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['prevent']);
  turn.run();
  assert.deepEqual(calls, ['prevent', 'quit']);

  assert.equal(handleServiceBeforeQuit(event, { app, localServiceManager, defer: turn.defer }), false);
  assert.deepEqual(calls, ['prevent', 'quit']);
});

test('default shutdown observes and awaits a deferred extension drain before retry quit', async () => {
  const turn = deferredTurn();
  let releaseExtension;
  const extensionDrain = new Promise((resolve) => { releaseExtension = resolve; });
  const calls = [];
  const app = { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) };
  const extensionManager = { shutdown() { calls.push('extension'); return extensionDrain; } };
  const localServiceManager = { shutdown() { calls.push('services'); return Promise.resolve(); } };

  handleServiceBeforeQuit({ preventDefault: () => calls.push('prevent') }, {
    app, extensionManager, localServiceManager, defer: turn.defer
  });
  assert.deepEqual(calls, ['prevent', 'extension', 'services']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes('quit'), false);
  releaseExtension();
  await new Promise((resolve) => setImmediate(resolve));
  turn.run();
  assert.equal(calls.at(-1), 'quit');
});

test('extension-only partial initialization is synchronously admitted and drained', async () => {
  const turn = deferredTurn();
  let release;
  const calls = [];
  const extensionManager = { shutdown() { calls.push('extension'); return new Promise((resolve) => { release = resolve; }); } };
  const app = { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) };
  const handled = handleServiceBeforeQuit({ preventDefault: () => calls.push('prevent') }, {
    app, extensionManager, defer: turn.defer
  });
  assert.equal(handled, true);
  assert.deepEqual(calls, ['prevent', 'extension'], 'extension admission closes before the helper returns');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  turn.run();
  assert.equal(calls.at(-1), 'quit');
});

test('default shutdown retains simultaneous extension and service failures', async () => {
  const turn = deferredTurn();
  const extensionFailure = new Error('extension drain failed');
  const serviceFailure = new Error('service drain failed');
  const observed = [];
  const app = { quit() {}, exit: (code) => observed.push(`exit:${code}`) };
  const consoleTarget = { error(_message, error) { observed.push(error); } };
  const logger = { error: async (_event, fields) => observed.push(fields.message) };
  handleServiceBeforeQuit({ preventDefault() {} }, {
    app,
    extensionManager: { shutdown: () => Promise.reject(extensionFailure) },
    localServiceManager: { shutdown: () => Promise.reject(serviceFailure), logger },
    logger, consoleTarget, defer: turn.defer
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed[0] instanceof AggregateError, true);
  assert.deepEqual(observed[0].errors, [extensionFailure, serviceFailure]);
  assert.equal(observed[1], 'Application lifecycle shutdown failed');
  turn.run();
  assert.equal(observed.at(-1), 'exit:1');
});

test('a never-settling extension drain is covered by the existing shutdown timeout', async () => {
  const turn = deferredTurn();
  const calls = [];
  const app = { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) };
  handleServiceBeforeQuit({ preventDefault: () => calls.push('prevent') }, {
    app,
    extensionManager: { shutdown: () => new Promise(() => {}) },
    localServiceManager: { shutdown: () => Promise.resolve() },
    logger: { error: async (_event, fields) => calls.push(`log:${fields.message}`) },
    consoleTarget: { error: (_message, error) => calls.push(`console:${error.code}`) },
    defer: turn.defer, timeoutMs: 30, logTimeoutMs: 5
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, ['prevent', 'console:SHUTDOWN_TIMEOUT', 'log:Application shutdown timed out']);
  turn.run();
  assert.equal(calls.at(-1), 'exit:1');
});

test('failed service shutdown logs before deferring a nonzero exit', async () => {
  const turn = deferredTurn();
  const calls = [];
  const failure = new Error('fixture cleanup failed');
  const app = {
    __servicesStopping: false,
    quit() { calls.push('quit'); },
    exit(code) { calls.push(`exit:${code}`); }
  };
  const logger = {
    async error(event, fields) { calls.push(`log:${event}:${fields.message}`); }
  };
  const consoleTarget = { error(message, error) { calls.push(`console:${message}:${error.message}`); } };
  const event = { preventDefault() { calls.push('prevent'); } };
  const localServiceManager = { logger, shutdown: () => Promise.reject(failure) };

  handleServiceBeforeQuit(event, { app, localServiceManager, defer: turn.defer, consoleTarget });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    'prevent',
    'console:Application shutdown failed::fixture cleanup failed',
    'log:service.shutdown_failed:fixture cleanup failed'
  ]);
  turn.run();
  assert.equal(calls.at(-1), 'exit:1');
  assert.equal(calls.includes('quit'), false);
});

test('quit remains gated until every persistence drain completes', async () => {
  const turn = deferredTurn();
  const drain = {};
  drain.promise = new Promise((resolve) => { drain.resolve = resolve; });
  const calls = [];
  const app = { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) };
  const event = { preventDefault: () => calls.push('prevent') };

  handleServiceBeforeQuit(event, { app, shutdown: () => drain.promise, defer: turn.defer });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['prevent']);
  assert.equal(handleServiceBeforeQuit(event, { app, shutdown: () => Promise.resolve(), defer: turn.defer }), true);
  assert.deepEqual(calls, ['prevent', 'prevent']);

  drain.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['prevent', 'prevent']);
  turn.run();
  assert.deepEqual(calls, ['prevent', 'prevent', 'quit']);
});

test('shutdown timeout is bounded, logged, and exits nonzero', async () => {
  const turn = deferredTurn();
  const calls = [];
  const app = { quit: () => calls.push('quit'), exit: (code) => calls.push(`exit:${code}`) };
  const event = { preventDefault: () => calls.push('prevent') };
  const logger = { error: async (_event, fields) => calls.push(`log:${fields.message}`) };
  const consoleTarget = { error: (_message, error) => calls.push(`console:${error.code}`) };

  handleServiceBeforeQuit(event, {
    app,
    shutdown: () => new Promise(() => {}),
    logger,
    consoleTarget,
    defer: turn.defer,
    timeoutMs: 30,
    logTimeoutMs: 5
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, ['prevent', 'console:SHUTDOWN_TIMEOUT', 'log:Application shutdown timed out']);
  turn.run();
  assert.equal(calls.at(-1), 'exit:1');
  assert.equal(calls.includes('quit'), false);
});

test('staged shutdown observes early failures and still attempts every later flush', async () => {
  let release;
  const heldIpc = new Promise((resolve) => { release = resolve; });
  const earlyBoundsFailure = Promise.reject(new Error('bounds failed early'));
  const attempted = [];
  const draining = settleShutdownStages(
    [heldIpc, earlyBoundsFailure, Promise.resolve()],
    [
      () => { attempted.push('secure'); throw new Error('synchronous secure flush failure'); },
      () => { attempted.push('cache'); return Promise.resolve(); }
    ],
    [() => { attempted.push('logger'); }]
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempted, []);
  release();
  await assert.rejects(draining, AggregateError);
  assert.deepEqual(attempted, ['secure', 'cache', 'logger']);
});

test('startup drain closes admission before manager shutdown and delays persistence', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const calls = [];
  const draining = shutdownApplicationManagers({
    shutdownStartup: () => { calls.push('startup'); return held; },
    shutdownProvider: () => calls.push('provider'),
    shutdownIpc: () => calls.push('ipc'),
    shutdownWallet: () => calls.push('wallet'),
    flushBounds: () => calls.push('bounds'),
    shutdownServices: () => calls.push('services'),
    shutdownExtensions: () => calls.push('extensions'),
    persistenceTasks: [() => calls.push('state')],
    finalTasks: [() => calls.push('logger')]
  });
  assert.deepEqual(calls, ['startup', 'provider', 'ipc', 'wallet', 'bounds', 'services', 'extensions']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes('state'), false);
  release();
  await draining;
  assert.deepEqual(calls.slice(-2), ['state', 'logger']);
});

test('startup and cleanup failures are both retained after all later flush attempts', async () => {
  const startupFailure = new Error('startup initialization failed');
  const cleanupFailure = new Error('extension disposal failed');
  const calls = [];
  await assert.rejects(shutdownApplicationManagers({
    shutdownStartup: () => Promise.reject(startupFailure),
    shutdownWallet: () => calls.push('wallet'),
    shutdownExtensions: () => { calls.push('extensions'); throw cleanupFailure; },
    persistenceTasks: [() => calls.push('state')],
    finalTasks: [() => calls.push('logger')]
  }), (error) => error instanceof AggregateError && error.errors.length === 2 &&
    error.errors.includes(startupFailure) && error.errors.includes(cleanupFailure));
  assert.deepEqual(calls, ['wallet', 'extensions', 'state', 'logger']);
});

test('production shutdown orchestrator waits for extension drain before persistence and logging', async () => {
  let releaseExtension;
  const extensionDrain = new Promise((resolve) => { releaseExtension = resolve; });
  const attempted = [];
  const draining = shutdownApplicationManagers({
    shutdownProvider: () => attempted.push('provider'),
    shutdownIpc: () => { attempted.push('ipc'); return Promise.resolve(); },
    flushBounds: () => attempted.push('bounds'),
    shutdownServices: () => attempted.push('services'),
    shutdownExtensions: () => { attempted.push('extensions'); return extensionDrain; },
    persistenceTasks: [() => attempted.push('secure'), () => attempted.push('cache'), () => attempted.push('state')],
    finalTasks: [() => attempted.push('logger')]
  });
  assert.deepEqual(attempted, ['provider', 'ipc', 'bounds', 'services', 'extensions']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attempted, ['provider', 'ipc', 'bounds', 'services', 'extensions']);
  releaseExtension();
  await draining;
  assert.deepEqual(attempted, ['provider', 'ipc', 'bounds', 'services', 'extensions', 'secure', 'cache', 'state', 'logger']);
});

test('production shutdown orchestrator retains synchronous partial-init failures and continues drains', async () => {
  const extensionFailure = new Error('extension synchronous failure');
  const attempted = [];
  await assert.rejects(shutdownApplicationManagers({
    shutdownIpc: () => attempted.push('ipc'),
    shutdownExtensions: () => { attempted.push('extensions'); throw extensionFailure; },
    persistenceTasks: [() => attempted.push('state')],
    finalTasks: [() => attempted.push('logger')]
  }), (error) => error instanceof AggregateError && error.errors.includes(extensionFailure));
  assert.deepEqual(attempted, ['ipc', 'extensions', 'state', 'logger']);
});

test('production shutdown closes wallet admission before extension cleanup and waits for its drain', async (t) => {
  let release;
  const heldWallet = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const calls = [];
  const draining = shutdownApplicationManagers({
    shutdownIpc: () => calls.push('ipc'),
    shutdownWallet: () => { calls.push('wallet'); return heldWallet; },
    shutdownExtensions: () => calls.push('extensions'),
    persistenceTasks: [() => calls.push('state')],
    finalTasks: [() => calls.push('logger')]
  });
  assert.deepEqual(calls, ['ipc', 'wallet', 'extensions']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['ipc', 'wallet', 'extensions']);
  release();
  await draining;
  assert.deepEqual(calls, ['ipc', 'wallet', 'extensions', 'state', 'logger']);
});

test('wallet shutdown failure cannot skip extension cleanup or persistence', async () => {
  const failure = new Error('wallet disposal failed');
  const calls = [];
  await assert.rejects(shutdownApplicationManagers({
    shutdownWallet: () => { throw failure; },
    shutdownExtensions: () => calls.push('extensions'),
    persistenceTasks: [() => calls.push('state')],
    finalTasks: [() => calls.push('logger')]
  }), (error) => error instanceof AggregateError && error.errors.includes(failure));
  assert.deepEqual(calls, ['extensions', 'state', 'logger']);
});

test('default before-quit supports wallet-only partial initialization', async () => {
  const calls = [];
  const app = { quit: () => calls.push('quit'), exit: () => calls.push('exit') };
  const pending = [];
  assert.equal(handleServiceBeforeQuit({ preventDefault: () => calls.push('prevent') }, {
    app, walletManager: { shutdown: async () => { calls.push('wallet'); } },
    defer: (callback) => pending.push(callback)
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['prevent', 'wallet']);
  assert.equal(pending.length, 1);
  pending[0]();
  assert.deepEqual(calls, ['prevent', 'wallet', 'quit']);
});

test('staged shutdown emits ordered completion phases', async () => {
  const phases = [];
  await settleShutdownStages(
    [Promise.resolve()],
    [() => Promise.resolve()],
    [() => Promise.resolve()],
    { onPhase: async (phase) => phases.push(phase) }
  );
  assert.deepEqual(phases, ['lifecycle-drain-done', 'persistence-done', 'logger-done']);
});

test('failing phase observers cannot skip persistence or final drains', async () => {
  const attempted = [];
  let observations = 0;
  await settleShutdownStages(
    [Promise.resolve().then(() => attempted.push('lifecycle'))],
    [() => attempted.push('persistence')],
    [() => attempted.push('final')],
    { onPhase: () => {
      observations += 1;
      if (observations === 1) throw new Error('synchronous observer failure');
      return Promise.reject(new Error('asynchronous observer failure'));
    } }
  );
  assert.deepEqual(attempted, ['lifecycle', 'persistence', 'final']);
  assert.equal(observations, 3);
});

test('rejected before-quit phase observers do not become unhandled or block retry quit', async () => {
  const turn = deferredTurn();
  const calls = [];
  const app = { quit: () => calls.push('quit'), exit: () => {} };
  handleServiceBeforeQuit({ preventDefault: () => calls.push('prevent') }, {
    app,
    shutdown: () => Promise.resolve(),
    defer: turn.defer,
    onPhase: () => Promise.reject(new Error('observer unavailable'))
  });
  await new Promise((resolve) => setImmediate(resolve));
  turn.run();
  assert.deepEqual(calls, ['prevent', 'quit']);
});

test('successful retry records return from native app quit', async () => {
  const turn = deferredTurn();
  const phases = [];
  handleServiceBeforeQuit({ preventDefault() {} }, {
    app: { quit() {}, exit() {} },
    shutdown: () => Promise.resolve(),
    defer: turn.defer,
    onPhase: (phase) => phases.push(phase)
  });
  await new Promise((resolve) => setImmediate(resolve));
  turn.run();
  await Promise.resolve();
  assert.deepEqual(phases, ['before-quit-start', 'retry-quit', 'retry-quit-returned']);
});

test('synchronous logger failure still reaches deferred nonzero exit', async () => {
  const turn = deferredTurn();
  const app = { exitCode: null, exit(code) { this.exitCode = code; }, quit() {} };
  const event = { preventDefault() {} };
  const logger = { error() { throw new Error('logger unavailable'); } };
  handleServiceBeforeQuit(event, {
    app,
    logger,
    shutdown: () => Promise.reject(new Error('shutdown failed')),
    consoleTarget: { error() {} },
    defer: turn.defer
  });
  await new Promise((resolve) => setImmediate(resolve));
  turn.run();
  assert.equal(app.exitCode, 1);
  assert.equal(app.__servicesStopping, true);
});
