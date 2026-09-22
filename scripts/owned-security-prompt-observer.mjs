import { execFile as nodeExecFile } from 'node:child_process';

export const EXPECTED_APP_NAME = 'Bitcoin Browser';
export const OBSERVER_MODES = Object.freeze(['observe', 'deny-once']);
export const MAX_OBSERVATIONS = 30;

// Output is four integers only: SecurityAgent window count, matching-window
// count, matching Deny-button count, and whether the one permitted action ran.
// Static text is compared only with the fixed expected app name and is never
// returned. Text fields and credential/item values are never inspected.
export const SECURITY_AGENT_SCRIPT = String.raw`
on matchesExpectedApp(labelValue, expectedName)
  if labelValue is expectedName then return true
  if labelValue starts with (expectedName & " ") then return true
  if labelValue contains (quote & expectedName & quote) then return true
  if labelValue contains ("“" & expectedName & "”") then return true
  return false
end matchesExpectedApp

on run argv
  set actionMode to item 1 of argv
  set expectedName to "Bitcoin Browser"
  set windowCount to 0
  set matchingCount to 0
  set denyCount to 0
  set didDeny to 0
  tell application "System Events"
    if exists process "SecurityAgent" then
      tell process "SecurityAgent"
        set promptWindows to every window
        set windowCount to count of promptWindows
        if windowCount is 1 then
          set promptWindow to item 1 of promptWindows
          set matchesExpected to false
          set labelLimit to count of static texts of promptWindow
          if labelLimit > 20 then error "PROMPT_LABEL_LIMIT"
          repeat with labelIndex from 1 to labelLimit
            set labelValue to value of static text labelIndex of promptWindow as text
            if my matchesExpectedApp(labelValue, expectedName) then set matchesExpected to true
          end repeat
          if matchesExpected then
            set matchingCount to 1
            set matchingDenyButtons to every button of promptWindow whose name is "Deny"
            set denyCount to count of matchingDenyButtons
            if actionMode is "deny-once" and denyCount is 1 then
              click item 1 of matchingDenyButtons
              set didDeny to 1
            end if
          end if
        end if
      end tell
    end if
  end tell
  return (windowCount as text) & "," & (matchingCount as text) & "," & (denyCount as text) & "," & (didDeny as text)
end run`;

function defaultExecFile(file, args, options) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}

function parseObservation(output, elapsedMs, mode) {
  const value = String(output ?? '').trim();
  const match = /^(\d+),(\d+),(\d+),([01])$/.exec(value);
  if (!match) throw new Error('PROMPT_OBSERVER_INVALID_OUTPUT');
  const [windowCount, matchingWindowCount, denyButtonCount] = match.slice(1, 4).map(Number);
  if ([windowCount, matchingWindowCount, denyButtonCount].some((item) => !Number.isSafeInteger(item) || item > 20)) {
    throw new Error('PROMPT_OBSERVER_INVALID_OUTPUT');
  }
  const denied = match[4] === '1';
  if (matchingWindowCount > windowCount || (matchingWindowCount === 0 && denyButtonCount !== 0)
    || denied && (mode !== 'deny-once' || windowCount !== 1 || matchingWindowCount !== 1 || denyButtonCount !== 1)) {
    throw new Error('PROMPT_OBSERVER_INVALID_OUTPUT');
  }
  return {
    elapsedMs,
    present: windowCount > 0,
    matching: matchingWindowCount === 1,
    windowCount,
    matchingWindowCount,
    denyButtonAvailable: denyButtonCount === 1,
    denyButtonCount,
    denied
  };
}

function boundedPositiveInteger(value, fallback, name, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return Math.min(number, maximum);
}

function cancelledResult(mode, appName, observations, actionMayHaveRun = false) {
  return {
    mode, appName, status: 'cancelled',
    acted: mode === 'deny-once' && actionMayHaveRun ? null : false,
    observations,
    error: 'PROMPT_OBSERVER_CANCELLED'
  };
}

async function waitForPoll(sleep, ms, signal) {
  if (!signal) { await sleep(ms); return false; }
  if (signal.aborted) return true;
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(true);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(sleep(ms)).then(() => false), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function observeOwnedSecurityPrompt(options = {}) {
  const mode = options.mode ?? 'observe';
  const appName = options.appName ?? EXPECTED_APP_NAME;
  const signal = options.signal;
  if (!OBSERVER_MODES.includes(mode)) throw new TypeError('mode must be observe or deny-once');
  if (appName !== EXPECTED_APP_NAME) throw new TypeError(`appName must be exactly ${EXPECTED_APP_NAME}`);
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if ((options.platform ?? process.platform) !== 'darwin') {
    return { mode, appName, status: 'unsupported-platform', acted: false, observations: [], error: 'PROMPT_OBSERVER_UNSUPPORTED_PLATFORM' };
  }

  const execFile = options.execFile ?? defaultExecFile;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadlineMs = boundedPositiveInteger(options.deadlineMs, 8_000, 'deadlineMs', 8_000);
  const pollMs = boundedPositiveInteger(options.pollMs, 200, 'pollMs', 1_000);
  const execTimeoutMs = boundedPositiveInteger(options.execTimeoutMs, 1_000, 'execTimeoutMs', 2_000);
  const startedAt = now();
  const observations = [];
  let deadlineBudgetExhausted = false;
  if (signal?.aborted) return cancelledResult(mode, appName, observations);

  while (observations.length < MAX_OBSERVATIONS && now() - startedAt < deadlineMs) {
    if (signal?.aborted) return cancelledResult(mode, appName, observations);
    let sample;
    let queryStarted = false;
    try {
      const remainingMs = deadlineMs - (now() - startedAt);
      // Do not start a final accessibility query with an artificially tiny
      // timeout. That turns ordinary monitor expiry into an ambiguous action.
      if (remainingMs < execTimeoutMs) { deadlineBudgetExhausted = true; break; }
      queryStarted = true;
      const result = await execFile('/usr/bin/osascript', ['-e', SECURITY_AGENT_SCRIPT, '--', mode], {
        timeout: Math.min(execTimeoutMs, remainingMs),
        killSignal: 'SIGKILL',
        maxBuffer: 1_024,
        encoding: 'utf8',
        windowsHide: true,
        ...(signal ? { signal } : {})
      });
      if (signal?.aborted) return cancelledResult(mode, appName, observations, queryStarted);
      sample = parseObservation(result?.stdout, Math.max(0, now() - startedAt), mode);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        return cancelledResult(mode, appName, observations, queryStarted);
      }
      return {
        mode,
        appName,
        status: error?.killed || error?.code === 'ETIMEDOUT' ? 'exec-timeout' : 'observer-error',
        acted: mode === 'deny-once' ? null : false,
        observations,
        error: error?.killed || error?.code === 'ETIMEDOUT' ? 'PROMPT_OBSERVER_EXEC_TIMEOUT' : 'PROMPT_OBSERVER_UNAVAILABLE'
      };
    }
    observations.push(sample);
    if (sample.windowCount > 1 || sample.matchingWindowCount > 1) {
      return { mode, appName, status: 'ambiguous', acted: false, observations, error: 'PROMPT_OBSERVER_AMBIGUOUS' };
    }
    if (sample.present) {
      if (!sample.matching) return { mode, appName, status: 'nonmatching', acted: false, observations, error: null };
      if (sample.denied) return { mode, appName, status: 'denied', acted: true, observations, error: null };
      return { mode, appName, status: 'observed', acted: false, observations, error: null };
    }
    const remaining = deadlineMs - (now() - startedAt);
    if (remaining > 0 && await waitForPoll(sleep, Math.min(pollMs, remaining), signal)) {
      return cancelledResult(mode, appName, observations);
    }
  }
  if (signal?.aborted) return cancelledResult(mode, appName, observations);
  const deadlineReached = deadlineBudgetExhausted || now() - startedAt >= deadlineMs;
  return {
    mode, appName,
    status: deadlineReached ? 'deadline' : 'observation-limit',
    acted: false,
    observations,
    error: deadlineReached ? 'PROMPT_OBSERVER_DEADLINE' : 'PROMPT_OBSERVER_OBSERVATION_LIMIT'
  };
}
