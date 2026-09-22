import { waitForStartupChildClose } from './startup-diagnostic-support.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Node's SIGTERM uses TerminateProcess on Windows; it cannot exercise Electron's
// before-quit cleanup. WM_CLOSE requests the normal close path for this owned PID.
export async function requestWindowsWindowClose(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error('Invalid owned application PID');
  const command = `$ErrorActionPreference = 'Stop'; $application = Get-Process -Id ${child.pid}; if (-not $application.CloseMainWindow()) { throw 'Application did not accept WM_CLOSE' }`;
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { timeout: 5_000, maxBuffer: 64 * 1024 });
  return true;
}

export function observePackagedChild(child) {
  const state = { closeConfirmed: false, code: null, signal: null, spawnError: null };
  child.on('error', (error) => { state.spawnError = error?.code ?? 'SPAWN_FAILED'; });
  child.on('close', (code, signal) => { state.closeConfirmed = true; state.code = code; state.signal = signal; });
  return state;
}

export async function shutdownPackagedChild(child, observation, { timeoutMs = 15_000, postKillMs = 3_000, requestClose = () => child.kill('SIGTERM') } = {}) {
  if (observation.closeConfirmed) return { closeConfirmed: true, code: observation.code, signal: observation.signal, forced: false, timedOut: false, spawnError: observation.spawnError, killError: null, initialSignalError: null };
  const closing = waitForStartupChildClose(child, timeoutMs, postKillMs);
  let initialSignalError = null;
  if (child.exitCode === null && child.signalCode === null) {
    try { if (!await requestClose()) initialSignalError = 'KILL_NOT_SENT'; }
    catch (error) { initialSignalError = error?.code ?? 'KILL_FAILED'; }
  }
  const result = await closing;
  return { ...result, spawnError: result.spawnError ?? observation.spawnError, initialSignalError };
}

export function detachUnconfirmedPackagedChild(child) {
  const detached = { child: false, stdout: false, stderr: false };
  if (typeof child?.unref === 'function') { child.unref(); detached.child = true; }
  for (const name of ['stdout', 'stderr']) {
    if (typeof child?.[name]?.unref === 'function') { child[name].unref(); detached[name] = true; }
  }
  return detached;
}

export async function finalizePackagedEvidence(finalize, reportFailure, unconfirmedChildren) {
  try { return await finalize(); }
  catch (error) {
    await reportFailure(error);
    throw error;
  } finally {
    for (const child of unconfirmedChildren) detachUnconfirmedPackagedChild(child);
  }
}

export function requireConfirmedChildClose(result) {
  if (result.closeConfirmed) return;
  const error = new Error('Owned packaged process close was not confirmed; refusing profile reuse or another launch');
  error.code = 'PACKAGED_CHILD_CLOSE_UNCONFIRMED';
  error.fatal = true;
  throw error;
}
