import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('wrapper exits after recording an unconfirmed live child and detaching its owned handles', { timeout: 9000 }, async () => {
  const wrapper = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/packaged-wrapper-bound.mjs', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const messages = [];
  let ownedPid = null;
  let wrapperClosed = false;
  let deadlineExpired = false;
  let output = '';
  for (const stream of [wrapper.stdout, wrapper.stderr]) stream.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-4096);
  });
  wrapper.on('message', (message) => {
    messages.push(message);
    if (message.kind === 'owned-child' && Number.isSafeInteger(message.pid) && message.pid > 0) ownedPid = message.pid;
  });
  const closed = new Promise((resolve) => {
    wrapper.on('error', (error) => { output += `\n${error.code}`; });
    wrapper.once('close', (code, signal) => { wrapperClosed = true; resolve({ code, signal }); });
  });
  const hardLimit = new Promise((resolve) => {
    const timer = setTimeout(() => { deadlineExpired = true; resolve(null); }, 4000);
    closed.then(() => clearTimeout(timer));
  });
  try {
    const terminal = await Promise.race([closed, hardLimit]);
    assert.equal(deadlineExpired, false, `Wrapper failed to exit within its independent bound: ${output}`);
    assert.deepEqual(terminal, { code: 0, signal: null }, output);
    assert.ok(ownedPid, 'Wrapper must report the exact owned PID before detaching');
    const evidence = messages.find((message) => message.kind === 'result');
    assert.ok(evidence, 'Unconfirmed-close evidence must be recorded');
    assert.equal(evidence.pid, ownedPid);
    assert.equal(evidence.result.closeConfirmed, false);
    assert.equal(evidence.result.initialSignalError, 'EPERM');
    assert.equal(evidence.result.killError, 'EPERM');
    assert.equal(evidence.replacementLaunches, 0);
    assert.equal(evidence.blockedCode, 'PACKAGED_CHILD_CLOSE_UNCONFIRMED');
    assert.equal(evidence.closeObservedBeforeDetach, false);
    assert.deepEqual(messages.find((message) => message.kind === 'detached')?.detached,
      { child: true, stdout: true, stderr: true });
    // Proves wrapper termination was not caused by the child's own safety exit.
    assert.doesNotThrow(() => process.kill(ownedPid, 0));
  } finally {
    if (ownedPid !== null) {
      try { process.kill(ownedPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!wrapperClosed) wrapper.kill('SIGKILL');
    let cleanupTimer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error('Owned wrapper close unconfirmed after cleanup')), 2000);
      })]);
    } finally {
      clearTimeout(cleanupTimer);
      if (!wrapperClosed) {
        wrapper.unref(); wrapper.stdout.unref(); wrapper.stderr.unref();
        if (wrapper.connected) wrapper.disconnect();
      }
    }
  }
});
