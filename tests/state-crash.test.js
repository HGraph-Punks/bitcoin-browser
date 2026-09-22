import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { StateStore } from '../src/main/state-store.js';

const node22 = process.execPath;
const childFixture = fileURLToPath(new URL('./fixtures/state-crash.mjs', import.meta.url));

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-state-crash-'));
}

function markerQueue(lines) {
  const buffered = [];
  const waiting = [];
  lines.on('line', (line) => {
    const resolve = waiting.shift();
    if (resolve) resolve(line);
    else buffered.push(line);
  });
  return {
    next() {
      if (buffered.length) return Promise.resolve(buffered.shift());
      return new Promise((resolve) => waiting.push(resolve));
    }
  };
}

async function startFixture(t, directory, mode) {
  const child = spawn(node22, [childFixture, directory, mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const childClosed = once(child, 'close');
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'fixture child must have one exact PID');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  const markers = markerQueue(lines);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await childClosed;
    lines.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const baseline = await markers.next();
  assert.equal(baseline, 'BASELINE', stderr);
  return { child, markers, stderr: () => stderr };
}

test('SIGKILL at a deterministic pre-rename barrier preserves the last committed primary', { timeout: 15_000 }, async (t) => {
  const directory = await temporaryDirectory();
  const fixture = await startFixture(t, directory, 'interrupt-write');
  fixture.child.stdin.end('go\n');
  assert.equal(await fixture.markers.next(), 'STARTING');
  const blocked = await fixture.markers.next();
  assert.match(blocked, /^RENAME_BLOCKED state\.json\.\d+\.\d+\.tmp$/);
  const temporary = blocked.slice('RENAME_BLOCKED '.length);
  const stagedState = JSON.parse(await fs.readFile(path.join(directory, temporary), 'utf8'));
  const primaryBeforeKill = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  assert.equal(stagedState.settings.theme, 'dark', 'barrier must occur after the complete temporary write');
  assert.equal(primaryBeforeKill.settings.theme, 'light', 'barrier must occur before final primary rename');
  const exited = once(fixture.child, 'exit');
  assert.equal(fixture.child.kill('SIGKILL'), true);
  const [, signal] = await exited;
  assert.ok(signal === 'SIGKILL' || process.platform === 'win32', fixture.stderr());

  const primaryBeforeRecovery = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  const backupBeforeRecovery = JSON.parse(await fs.readFile(path.join(directory, 'state.backup.json'), 'utf8'));
  assert.equal(primaryBeforeRecovery.settings.theme, 'light');
  assert.equal(backupBeforeRecovery.settings.theme, 'light');
  assert.ok((await fs.stat(path.join(directory, temporary))).isFile());

  const recovered = new StateStore(directory, null);
  await recovered.init();
  assert.deepEqual(recovered.recoveryStatus, { source: 'primary', reason: null });
  assert.equal(recovered.get(['settings', 'theme']), 'light');
  assert.equal(recovered.get(['localServices']).some(({ id }) => id === 'crash-fixture'), false);
  await assert.rejects(fs.lstat(path.join(directory, temporary)), { code: 'ENOENT' });
});

test('a state mutation acknowledged before SIGKILL is available after restart', { timeout: 15_000 }, async (t) => {
  const directory = await temporaryDirectory();
  const fixture = await startFixture(t, directory, 'committed-write');
  fixture.child.stdin.write('go\n');
  assert.equal(await fixture.markers.next(), 'STARTING');
  assert.equal(await fixture.markers.next(), 'COMMITTED');
  const exited = once(fixture.child, 'exit');
  assert.equal(fixture.child.kill('SIGKILL'), true);
  const [, signal] = await exited;
  assert.ok(signal === 'SIGKILL' || process.platform === 'win32', fixture.stderr());

  const recovered = new StateStore(directory, null);
  await recovered.init();
  assert.deepEqual(recovered.recoveryStatus, { source: 'primary', reason: null });
  assert.equal(recovered.get(['settings', 'theme']), 'dark');
});
