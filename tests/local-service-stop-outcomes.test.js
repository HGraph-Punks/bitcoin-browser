import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import { LocalServiceManager, handleServiceBeforeQuit } from '../src/main/local-service-manager.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { IPC } from '../src/shared/constants.js';
import { assertString } from '../src/shared/validation.js';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(source, id = 'fixture') {
  const state = { localServices: [{ id, name: id, executable: process.execPath,
    args: ['-e', source], cwd: os.tmpdir(), enabled: true, autoStart: false }] };
  const store = { get: parts => structuredClone(state[parts[0]]), async mutate(callback) { callback(state); } };
  return { state, manager: new LocalServiceManager(store, null) };
}

async function ready(t, manager, id = 'fixture') {
  t.after(async () => {
    const children = [...manager.processes.values()];
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(children.map(child => manager.completions.get(child)));
    assert.equal(manager.processes.size, 0, 'fixture cleanup retains no child');
  });
  await manager.start(id);
  const deadline = Date.now() + 5_000;
  while (!manager.logs.get(id)?.some(entry => entry.text.includes('fixture-ready'))) {
    assert.ok(Date.now() < deadline, 'fixture installs its signal handler before Stop');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function onTerm(body) {
  return `process.on('SIGTERM', () => { ${body} }); process.stdout.write('fixture-ready\\n'); setInterval(() => {}, 1000);`;
}

// These controls use real POSIX signal handlers. Windows requires its separate
// native stop mechanism qualification; Node's Windows kill does not deliver one.
const posix = { skip: process.platform === 'win32', timeout: 15_000 };

test('a nonzero child exit during Stop rejects and retains failure after close', posix, async t => {
  const { manager } = fixture(onTerm("process.stderr.write('stop failed\\n'); process.exit(7)"));
  await ready(t, manager);
  await assert.rejects(manager.stop('fixture'), error => {
    assert.equal(error.code, 'SERVICE_STOP_FAILED');
    assert.equal(error.details.exitCode, 7);
    assert.equal(error.details.signal, null);
    return true;
  });
  const status = manager.status('fixture');
  assert.equal(status.status, 'failed'); assert.equal(status.pid, null);
  assert.equal(status.exitCode, 7); assert.equal(status.signal, null);
  assert.match(status.error, /code 7/);
  assert.match(manager.list()[0].logs.map(entry => entry.text).join(''), /stop failed/);
  assert.equal((await manager.stop('fixture')).status, 'failed', 'no-op preserves observation without replay');
  await manager.shutdown();
  assert.equal(manager.hasActiveLifecycle(), false, 'an already reported failure does not poison later shutdown');
});

test('concurrent stops share the same abnormal close rejection', posix, async t => {
  const { manager } = fixture(onTerm('setTimeout(() => process.exit(7), 20)'));
  await ready(t, manager);
  const first = manager.stop('fixture'); const second = manager.stop('fixture');
  assert.equal(first, second);
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(results[0].reason, results[1].reason);
  assert.equal(manager.processes.size, 0);
});

test('Remove preserves configuration and logs when its child fails during stop', posix, async t => {
  const { manager, state } = fixture(onTerm('process.exit(7)'));
  await ready(t, manager);
  await assert.rejects(manager.remove('fixture'), { code: 'SERVICE_STOP_FAILED' });
  assert.equal(state.localServices.length, 1);
  assert.equal(manager.status('fixture').exitCode, 7);
  assert.ok(manager.logs.get('fixture').length);
  await manager.remove('fixture');
  assert.deepEqual(state.localServices, [], 'a later explicit removal can clear the already closed service');
});

test('shutdown reports abnormal stop while still draining the other owned child', posix, async t => {
  const { manager, state } = fixture(onTerm('process.exit(7)'));
  state.localServices.push({ ...state.localServices[0], id: 'other', args: ['-e', onTerm('process.exit(0)')] });
  await ready(t, manager); await ready(t, manager, 'other');
  await assert.rejects(manager.shutdown(), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(cause => cause.code === 'SERVICE_STOP_FAILED'));
    return true;
  });
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.status('fixture').status, 'failed');
  assert.equal(manager.status('other').status, 'stopped');
});

test('shutdown does not swallow an admitted Remove stop failure', posix, async t => {
  const { manager, state } = fixture(onTerm('setTimeout(() => process.exit(7), 20)'));
  await ready(t, manager);
  const removing = manager.remove('fixture');
  const shutdown = manager.shutdown();
  const results = await Promise.allSettled([removing, shutdown]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(state.localServices.length, 1);
  assert.equal(manager.processes.size, 0);
});

test('shutdown preserves a still-admitted removal failure after its stop reservation releases', posix, async t => {
  const { manager, state } = fixture(onTerm('process.exit(7)')); await ready(t, manager);
  const removal = manager.remove('fixture');
  const stop = manager.stopping.get('fixture');
  let admission;
  const shutdown = stop.catch(() => {
    admission = { processes: manager.processes.size, stopping: manager.stopping.size, removing: manager.removing.size };
    return manager.shutdown();
  });
  const results = await Promise.allSettled([removal, shutdown]);
  assert.deepEqual(admission, { processes: 0, stopping: 0, removing: 1 });
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.errors.length, 1);
  assert.equal(results[1].reason.errors[0], results[0].reason);
  assert.equal(state.localServices.length, 1);
});

test('an unexpected signal during Stop is not reported as clean', posix, async t => {
  const { manager } = fixture(onTerm("process.kill(process.pid, 'SIGHUP')"));
  await ready(t, manager);
  await assert.rejects(manager.stop('fixture'), { code: 'SERVICE_STOP_FAILED' });
  assert.equal(manager.status('fixture').signal, 'SIGHUP');
  assert.equal(manager.status('fixture').status, 'failed');
  assert.equal(manager.status('fixture').pid, null);
});

test('forced escalation closes ownership but rejects a clean-stop claim', posix, async t => {
  const { manager } = fixture(onTerm('/* deliberately ignore the requested stop */'));
  await ready(t, manager);
  await assert.rejects(manager.stop('fixture'), error => {
    assert.equal(error.code, 'SERVICE_STOP_FAILED');
    assert.equal(error.details.forcedTerminationRequested, true);
    return true;
  });
  assert.equal(manager.processes.size, 0);
  assert.equal(manager.status('fixture').signal, 'SIGKILL');
  assert.equal(manager.status('fixture').status, 'failed');
  assert.equal(manager.list()[0].forcedTerminationRequested, true);
  await manager.shutdown();
});

for (const [name, source, code, signal] of [
  ['zero exit from handler', onTerm('process.exit(0)'), 0, null],
  ['default requested SIGTERM', "process.stdout.write('fixture-ready\\n'); setInterval(() => {}, 1000)", null, 'SIGTERM']
]) test(`Stop preserves expected ${name} behavior`, posix, async t => {
  const { manager } = fixture(source); await ready(t, manager);
  const result = await manager.stop('fixture');
  assert.equal(result.status, 'stopped'); assert.equal(result.error, null);
  assert.equal(result.exitCode, code); assert.equal(result.signal, signal);
  assert.equal(result.pid, null);
});

test('stopAll joins a child-closed but still-admitted stop and preserves rejection', async () => {
  const { manager } = fixture('process.exit(0)'); const stop = deferred();
  manager.stopping.set('fixture', stop.promise);
  let settled = false;
  const all = manager.stopAll().finally(() => { settled = true; });
  const observed = Promise.allSettled([all, stop.promise]);
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeStop = settled;
  stop.reject(new AppError('SERVICE_STOP_FAILED', 'fixture abnormal close'));
  const results = await observed;
  manager.stopping.delete('fixture');
  assert.equal(settledBeforeStop, false);
  assert.equal(results[0].status, 'rejected');
  await manager.shutdown();
});

test('shutdown preserves an unexpected non-aggregate stopAll failure', async () => {
  const { manager } = fixture('process.exit(0)');
  const cause = new AppError('SERVICE_STOP_FAILED', 'synthetic synchronous stop admission failure');
  manager.processes.set('fixture', {});
  manager.stop = () => { throw cause; };
  try {
    await assert.rejects(manager.shutdown(), error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [cause]); return true;
    });
  } finally { manager.processes.clear(); }
});

test('start cannot replace a closed child while the previous stop still owns its ID', async () => {
  const { manager } = fixture('process.exit(0)'); const stop = deferred();
  manager.stopping.set('fixture', stop.promise);
  try {
    await assert.rejects(manager.start('fixture'), { code: 'SERVICE_STOPPING' });
    assert.equal(manager.processes.size, 0);
  } finally {
    stop.resolve(); manager.stopping.delete('fixture'); await manager.stopAll();
  }
});

test('a synchronous signal failure keeps ownership and reports a retryable failure', posix, async t => {
  const { manager } = fixture(onTerm('process.exit(0)')); await ready(t, manager);
  const child = manager.processes.get('fixture'); const kill = child.kill.bind(child);
  child.kill = () => { throw Object.assign(new Error('fixture signal permission denied'), { code: 'EPERM' }); };
  try {
    await assert.rejects(manager.stop('fixture'), { code: 'SERVICE_STOP_FAILED' });
    assert.equal(manager.status('fixture').status, 'failed');
    assert.equal(manager.status('fixture').pid, child.pid);
    assert.match(manager.status('fixture').error, /permission denied/);
  } finally { child.kill = kill; }
  assert.equal((await manager.stop('fixture')).status, 'stopped');
});

test('stop reservation precedes synchronous publication and prevents reentrant start or duplicate stop', posix, async t => {
  const { manager } = fixture(onTerm('process.exit(0)')); await ready(t, manager);
  let joined; let restart;
  manager.onChange = () => {
    if (manager.status('fixture').status !== 'stopping' || joined) return;
    joined = manager.stop('fixture');
    restart = manager.start('fixture').then(() => null, error => error);
  };
  const stopping = manager.stop('fixture');
  assert.equal(joined, stopping);
  assert.equal((await restart).code, 'SERVICE_STOPPING');
  assert.equal((await stopping).status, 'stopped');
});

test('the exact old child owns its stop result through close publication', posix, async t => {
  const { manager } = fixture(onTerm('process.exit(7)')); await ready(t, manager);
  const child = manager.processes.get('fixture'); let replacement;
  child.once('close', () => { replacement = manager.start('fixture').then(() => null, error => error); });
  await assert.rejects(manager.stop('fixture'), error => error.code === 'SERVICE_STOP_FAILED' && error.details.exitCode === 7);
  assert.equal((await replacement).code, 'SERVICE_STOPPING');
  assert.equal(manager.status('fixture').exitCode, 7);
  assert.equal(manager.processes.size, 0);
});

test('an emitted process error cannot be erased by a later zero exit', posix, async t => {
  const { manager } = fixture(onTerm('process.exit(0)')); await ready(t, manager);
  const child = manager.processes.get('fixture'); const kill = child.kill.bind(child);
  child.kill = signal => {
    child.emit('error', Object.assign(new Error('fixture asynchronous kill error'), { code: 'EPERM' }));
    return kill(signal);
  };
  try {
    await assert.rejects(manager.stop('fixture'), error => {
      assert.equal(error.code, 'SERVICE_STOP_FAILED'); assert.equal(error.details.exitCode, 0);
      assert.match(error.message, /asynchronous kill error/); return true;
    });
  } finally { child.kill = kill; }
  assert.equal(manager.status('fixture').status, 'failed');
  assert.equal(manager.status('fixture').exitCode, 0);
  assert.equal(manager.status('fixture').signal, null);
  assert.equal(manager.status('fixture').pid, null);
});

test('registered service IPC returns abnormal-close details and list keeps the closed failure', posix, async t => {
  const { manager } = fixture(onTerm('process.exit(7)')); await ready(t, manager);
  const handlers = new Map();
  const ipcSource = fs.readFileSync(new URL('../src/main/ipc.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export function registerIpc', 'function registerIpc');
  const register = new Function('ipcMain', 'IPC', 'AppError', 'serializeError', 'assertString',
    `${ipcSource}\nreturn registerIpc;`)(
    { handle: (channel, handler) => handlers.set(channel, handler), on() {} }, IPC, AppError, serializeError, assertString);
  const lifecycle = register({ localServiceManager: manager });
  const event = { senderFrame: { url: 'app://app/renderer/index.html' } };
  const denied = await handlers.get(IPC.LOCAL_SERVICES_STOP)({ senderFrame: { url: 'https://untrusted.invalid/' } }, { id: 'fixture' });
  assert.equal(denied.error.code, 'UNTRUSTED_IPC_SENDER');
  assert.equal(manager.status('fixture').status, 'running');
  const stopped = await handlers.get(IPC.LOCAL_SERVICES_STOP)(event, { id: 'fixture' });
  assert.equal(stopped.ok, false); assert.equal(stopped.error.code, 'SERVICE_STOP_FAILED');
  assert.equal(stopped.error.details.exitCode, 7); assert.equal(stopped.error.details.pid, null);
  const listed = await handlers.get(IPC.LOCAL_SERVICES_LIST)(event, {});
  assert.equal(listed.result[0].status, 'failed'); assert.equal(listed.result[0].pid, null);
  await lifecycle.shutdown();
});

test('actual manager stop failure reaches a nonzero before-quit outcome after child close', posix, async t => {
  const { manager } = fixture(onTerm('process.exit(7)')); await ready(t, manager);
  const finished = deferred(); const calls = [];
  const app = { quit() { calls.push('quit'); }, exit(code) { calls.push(['exit', code]); finished.resolve(); } };
  const handled = handleServiceBeforeQuit({ preventDefault() { calls.push('prevent'); } }, {
    app, localServiceManager: manager, consoleTarget: { error(...args) { calls.push(['error', args[0]]); } }
  });
  assert.equal(handled, true); await finished.promise;
  assert.equal(calls.includes('quit'), false);
  assert.deepEqual(calls.at(-1), ['exit', 1]);
  assert.equal(manager.processes.size, 0);
  assert.equal(app.__servicesShutdownComplete, undefined);
});
