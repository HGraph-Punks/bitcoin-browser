import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_APP_NAME,
  MAX_OBSERVATIONS,
  SECURITY_AGENT_SCRIPT,
  observeOwnedSecurityPrompt
} from '../scripts/owned-security-prompt-observer.mjs';

function clock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; }
  };
}

test('observe mode uses one fixed bounded osascript query and returns normalized fields only', async () => {
  const calls = [];
  const time = clock();
  const result = await observeOwnedSecurityPrompt({
    mode: 'observe', platform: 'darwin', ...time,
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '1,1,1,0' };
    }
  });
  assert.equal(result.status, 'observed');
  assert.equal(result.acted, false);
  assert.deepEqual(Object.keys(result.observations[0]).sort(), [
    'denied', 'denyButtonAvailable', 'denyButtonCount', 'elapsedMs', 'matching',
    'matchingWindowCount', 'present', 'windowCount'
  ]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args, ['-e', SECURITY_AGENT_SCRIPT, '--', 'observe']);
  assert.equal(calls[0].options.maxBuffer, 1_024);
  assert.ok(calls[0].options.timeout <= 2_000);
  assert.equal(calls[0].options.killSignal, 'SIGKILL');
  assert.match(SECURITY_AGENT_SCRIPT, /if windowCount is 1/);
  assert.match(SECURITY_AGENT_SCRIPT, /if labelLimit > 20 then error "PROMPT_LABEL_LIMIT"/);
  assert.doesNotMatch(SECURITY_AGENT_SCRIPT, /value of every static text/);
  assert.ok(SECURITY_AGENT_SCRIPT.indexOf('PROMPT_LABEL_LIMIT') < SECURITY_AGENT_SCRIPT.indexOf('value of static text labelIndex'));
  assert.doesNotMatch(SECURITY_AGENT_SCRIPT, /name of every static text|text field/i);
});

test('deny-once permits only one unique Deny action in one matching window', async () => {
  const time = clock();
  let calls = 0;
  const result = await observeOwnedSecurityPrompt({
    mode: 'deny-once', platform: 'darwin', ...time,
    execFile: async (_file, args) => {
      calls += 1;
      assert.equal(args.at(-1), 'deny-once');
      return { stdout: '1,1,1,1' };
    }
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.acted, true);
  assert.equal(calls, 1);
  assert.match(SECURITY_AGENT_SCRIPT, /button of promptWindow whose name is "Deny"/);
  assert.doesNotMatch(SECURITY_AGENT_SCRIPT, /click[\s\S]*Always Allow|click[\s\S]*Allow"/);
});

test('ambiguous and nonmatching windows never act', async () => {
  const time = clock();
  const ambiguous = await observeOwnedSecurityPrompt({ mode: 'deny-once', platform: 'darwin', ...time, execFile: async () => ({ stdout: '2,0,0,0' }) });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.acted, false);
  const nonmatching = await observeOwnedSecurityPrompt({ mode: 'deny-once', platform: 'darwin', ...clock(), execFile: async () => ({ stdout: '1,0,0,0' }) });
  assert.equal(nonmatching.status, 'nonmatching');
  assert.equal(nonmatching.acted, false);
});

test('invalid mode and application name are rejected before execution', async () => {
  let calls = 0;
  const execFile = async () => { calls += 1; };
  await assert.rejects(observeOwnedSecurityPrompt({ mode: 'allow', platform: 'darwin', execFile }), /mode/);
  await assert.rejects(observeOwnedSecurityPrompt({ appName: 'Another App', platform: 'darwin', execFile }), /appName/);
  assert.equal(calls, 0);
  assert.equal(EXPECTED_APP_NAME, 'Bitcoin Browser');
});

test('unsupported platforms are explicit and never execute a subprocess', async () => {
  let calls = 0;
  const result = await observeOwnedSecurityPrompt({ platform: 'linux', execFile: async () => { calls += 1; } });
  assert.equal(result.status, 'unsupported-platform');
  assert.equal(result.error, 'PROMPT_OBSERVER_UNSUPPORTED_PLATFORM');
  assert.equal(calls, 0);
});

test('deadline, permission failure, timeout, and malformed output are explicit and bounded', async () => {
  const time = clock();
  const deadline = await observeOwnedSecurityPrompt({
    ...time, platform: 'darwin', deadlineMs: 1_000, pollMs: 200,
    execFile: async () => ({ stdout: '0,0,0,0' })
  });
  assert.equal(deadline.status, 'deadline');
  assert.ok(deadline.observations.length <= MAX_OBSERVATIONS);
  assert.equal(deadline.error, 'PROMPT_OBSERVER_DEADLINE');

  const denied = Object.assign(new Error('not authorized and sensitive detail'), { code: 1 });
  const failure = await observeOwnedSecurityPrompt({ platform: 'darwin', execFile: async () => { throw denied; } });
  assert.equal(failure.status, 'observer-error');
  assert.equal(failure.error, 'PROMPT_OBSERVER_UNAVAILABLE');
  assert.equal(JSON.stringify(failure).includes('sensitive detail'), false);

  const timedOut = Object.assign(new Error('timeout detail'), { killed: true });
  const timeout = await observeOwnedSecurityPrompt({ mode: 'deny-once', platform: 'darwin', execFile: async () => { throw timedOut; } });
  assert.equal(timeout.status, 'exec-timeout');
  assert.equal(timeout.error, 'PROMPT_OBSERVER_EXEC_TIMEOUT');
  assert.equal(timeout.acted, null);

  const malformed = await observeOwnedSecurityPrompt({ platform: 'darwin', execFile: async () => ({ stdout: 'prompt title and secret' }) });
  assert.equal(malformed.status, 'observer-error');
  assert.equal(malformed.error, 'PROMPT_OBSERVER_UNAVAILABLE');
  assert.equal(JSON.stringify(malformed).includes('prompt title'), false);
});

test('extra output, impossible results, and invalid timing fail safely before retry or execution', async () => {
  const outputs = ['1,1,1,0\nsecret extra output', '0,0,0,1', '1,0,1,0', '1,1,1,1'];
  for (const stdout of outputs) {
    const result = await observeOwnedSecurityPrompt({ mode: 'observe', platform: 'darwin', execFile: async () => ({ stdout }) });
    assert.equal(result.status, 'observer-error', stdout);
    assert.equal(result.error, 'PROMPT_OBSERVER_UNAVAILABLE', stdout);
    assert.equal(JSON.stringify(result).includes('secret extra output'), false);
  }
  let calls = 0;
  for (const options of [{ deadlineMs: 0 }, { pollMs: NaN }, { execTimeoutMs: 1.5 }]) {
    await assert.rejects(observeOwnedSecurityPrompt({ ...options, platform: 'darwin', execFile: async () => { calls += 1; } }), /positive integer/);
  }
  assert.equal(calls, 0);
});

test('monitor expiry never starts an action with an insufficient final subprocess budget', async () => {
  const time = clock();
  let calls = 0;
  const result = await observeOwnedSecurityPrompt({ platform: 'darwin', mode: 'deny-once', ...time,
    deadlineMs: 1000, pollMs: 200, execTimeoutMs: 1000,
    execFile: async (_file, _args, options) => {
      calls += 1;
      assert.equal(options.timeout, 1000);
      return { stdout: '0,0,0,0' };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'deadline');
  assert.equal(result.acted, false);
});

test('pre-aborted signal returns cancelled without executing', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await observeOwnedSecurityPrompt({
    platform: 'darwin', mode: 'deny-once', signal: controller.signal,
    execFile: async () => { calls += 1; }
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.acted, false);
  assert.equal(result.error, 'PROMPT_OBSERVER_CANCELLED');
  assert.equal(calls, 0);
});

test('abort during polling wait prevents the next accessibility query', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await observeOwnedSecurityPrompt({
    platform: 'darwin', signal: controller.signal,
    execFile: async (_file, _args, options) => {
      calls += 1;
      assert.equal(options.signal, controller.signal);
      return { stdout: '0,0,0,0' };
    },
    sleep: async () => { controller.abort(); }
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.acted, false);
  assert.equal(calls, 1);
});

test('in-flight deny cancellation reports unknown action state and never retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await observeOwnedSecurityPrompt({
    platform: 'darwin', mode: 'deny-once', signal: controller.signal,
    execFile: async (_file, _args, options) => {
      calls += 1;
      assert.equal(options.signal, controller.signal);
      controller.abort();
      throw Object.assign(new Error('cancelled after possible click'), { name: 'AbortError', code: 'ABORT_ERR' });
    }
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.acted, null);
  assert.equal(result.observations.length, 0);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('possible click'), false);
});
