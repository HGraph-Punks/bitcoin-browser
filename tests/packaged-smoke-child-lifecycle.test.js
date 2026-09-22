import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { detachUnconfirmedPackagedChild, finalizePackagedEvidence, observePackagedChild, requireConfirmedChildClose, shutdownPackagedChild } from '../scripts/packaged-smoke-child-lifecycle.mjs';

function childFixture(kill) {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.kill = kill ?? (() => true);
  return child;
}

test('all finalization failures report ownership before detaching unresolved children', async () => {
  for (const stage of ['fixture-close', 'report-write']) {
    const events = [];
    const child = { unref: () => events.push('detach'), stdout: { unref() {} }, stderr: { unref() {} } };
    const error = Object.assign(new Error(stage), { code: stage });
    await assert.rejects(finalizePackagedEvidence(async () => { events.push(stage); throw error; },
      (failure) => { assert.equal(failure, error); events.push('fallback'); }, new Set([child])), error);
    assert.deepEqual(events, [stage, 'fallback', 'detach']);
  }
});

test('successful finalization completes reporting before detach and propagates its value', async () => {
  const events = [];
  const child = { unref: () => events.push('detach') };
  const result = await finalizePackagedEvidence(async () => { events.push('report'); return 7; },
    () => { throw new Error('Unexpected fallback'); }, new Set([child]));
  assert.equal(result, 7);
  assert.deepEqual(events, ['report', 'detach']);
});

test('spawn-time observation preserves an early close before shutdown begins', async () => {
  const child = childFixture(); const observation = observePackagedChild(child);
  child.exitCode = 0; child.emit('close', 0, null);
  const result = await shutdownPackagedChild(child, observation, { timeoutMs: 2, postKillMs: 2 });
  assert.equal(result.closeConfirmed, true); assert.equal(result.code, 0); assert.equal(result.initialSignalError, null);
});

test('spawn-time observation preserves an early spawn failure through close', async () => {
  const child = childFixture(); const observation = observePackagedChild(child);
  const error = new Error('missing executable'); error.code = 'ENOENT';
  child.emit('error', error); child.exitCode = -2; child.emit('close', -2, null);
  const result = await shutdownPackagedChild(child, observation, { timeoutMs: 2, postKillMs: 2 });
  assert.equal(result.closeConfirmed, true); assert.equal(result.spawnError, 'ENOENT'); assert.equal(result.code, -2);
});

test('exit alone does not confirm pipe closure', async () => {
  const child = childFixture(); const observation = observePackagedChild(child);
  const pending = shutdownPackagedChild(child, observation, { timeoutMs: 20, postKillMs: 5 });
  child.exitCode = 0; child.emit('exit', 0, null);
  setTimeout(() => child.emit('close', 0, null), 2);
  assert.equal((await pending).closeConfirmed, true);
});

test('shutdown after exit waits for close without sending a spurious signal', async () => {
  let kills = 0;
  const child = childFixture(() => { kills += 1; return false; }); const observation = observePackagedChild(child);
  child.exitCode = 0; child.emit('exit', 0, null);
  const pending = shutdownPackagedChild(child, observation, { timeoutMs: 20, postKillMs: 5 });
  setTimeout(() => child.emit('close', 0, null), 2);
  const result = await pending;
  assert.equal(kills, 0); assert.equal(result.closeConfirmed, true); assert.equal(result.initialSignalError, null);
});

test('denied signals leave closure unconfirmed and block replacement work', async () => {
  const child = childFixture(() => { const error = new Error('denied'); error.code = 'EPERM'; throw error; });
  const result = await shutdownPackagedChild(child, observePackagedChild(child), { timeoutMs: 2, postKillMs: 3 });
  assert.equal(result.closeConfirmed, false); assert.equal(result.initialSignalError, 'EPERM'); assert.equal(result.killError, 'EPERM');
  assert.throws(() => requireConfirmedChildClose(result), { code: 'PACKAGED_CHILD_CLOSE_UNCONFIRMED' });
});

test('an unconfirmed real owned child can be unrefed after reporting and then explicitly cleaned up', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); const realKill = child.kill.bind(child); const observation = observePackagedChild(child);
  child.kill = () => { const error = new Error('fixture denied'); error.code = 'EPERM'; throw error; };
  try {
    const result = await shutdownPackagedChild(child, observation, { timeoutMs: 2, postKillMs: 3 });
    assert.equal(result.closeConfirmed, false);
    assert.throws(() => requireConfirmedChildClose(result), { code: 'PACKAGED_CHILD_CLOSE_UNCONFIRMED' });
    assert.deepEqual(detachUnconfirmedPackagedChild(child), { child: true, stdout: true, stderr: true });
  } finally {
    child.ref(); child.stdout.ref(); child.stderr.ref();
    child.kill = realKill; realKill('SIGKILL'); await closed;
  }
});
