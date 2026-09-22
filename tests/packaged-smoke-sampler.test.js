import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sampleOwnedProcess } from '../scripts/packaged-smoke-sampler.mjs';

function fakeChild() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.pid = 456;
  child.exitCode = null; child.signalCode = null;
  child.kill = (signal) => { child.signalCode = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
  return child;
}

test('sampler fixes executable, owned pid, destination, and bounds combined output', async () => {
  const child = fakeChild(); let invocation;
  const pending = sampleOwnedProcess(123, '/owned/sample.txt', { maxOutputBytes: 5, timeoutMs: 50, postKillMs: 5,
    spawnImpl: (...args) => { invocation = args; queueMicrotask(() => { child.stdout.emit('data', 'abcdef'); child.exitCode = 0; child.emit('close', 0, null); }); return child; } });
  const { result } = await pending;
  assert.deepEqual(invocation, ['/usr/bin/sample', ['123', '1', '1', '-mayDie', '-file', '/owned/sample.txt'], { stdio: ['ignore', 'pipe', 'pipe'] }]);
  assert.equal(result.file, '/owned/sample.txt'); assert.equal(result.output, 'abcde'); assert.equal(result.outputTruncated, true);
  assert.equal(result.closeConfirmed, true); assert.equal(result.exitCode, 0);
  assert.equal(result.targetPid, 123); assert.equal(result.samplerPid, 456); assert.equal(result.timedOut, false);
  assert.ok(Number.isSafeInteger(result.durationMs) && result.durationMs >= 0);
});

test('sampler hard timeout uses shared SIGKILL watchdog and retains intended file on failure', async () => {
  const child = fakeChild(); child.kill = () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; };
  const { result } = await sampleOwnedProcess(9, '/owned/failed.txt', { timeoutMs: 2, postKillMs: 3, spawnImpl: () => child });
  assert.equal(result.file, '/owned/failed.txt'); assert.equal(result.closeConfirmed, false); assert.equal(result.killError, 'EPERM');
  assert.equal(result.targetPid, 9); assert.equal(result.samplerPid, 456); assert.equal(result.timedOut, true);
});

test('sampler rejects unsafe targets before spawning', async () => {
  let spawns = 0; const spawnImpl = () => { spawns += 1; return fakeChild(); };
  await assert.rejects(sampleOwnedProcess(0, '/owned/a', { spawnImpl }), TypeError);
  await assert.rejects(sampleOwnedProcess(1, 'relative', { spawnImpl }), TypeError);
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 60_001 }, { timeoutMs: 1.5 }, { postKillMs: 0 }, { postKillMs: 60_001 }, { postKillMs: 1.5 }]) {
    await assert.rejects(sampleOwnedProcess(1, '/owned/a', { spawnImpl, ...options }), TypeError);
  }
  assert.equal(spawns, 0);
});
