import path from 'node:path';
import { spawn } from 'node:child_process';
import { waitForStartupChildClose } from './startup-diagnostic-support.mjs';

export async function sampleOwnedProcess(pid, file, { spawnImpl = spawn, timeoutMs = 10_000, postKillMs = 3_000, maxOutputBytes = 8_192 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('pid must be a positive safe integer');
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096) throw new TypeError('sample file must be a bounded absolute path');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError('invalid sampler timeout');
  if (!Number.isSafeInteger(postKillMs) || postKillMs <= 0 || postKillMs > 60_000) throw new TypeError('invalid sampler post-kill timeout');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > 128 * 1024) throw new TypeError('invalid sampler output bound');
  const started = Date.now();
  const child = spawnImpl('/usr/bin/sample', [String(pid), '1', '1', '-mayDie', '-file', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; let retained = 0; let total = 0;
  const append = (chunk) => {
    const data = Buffer.from(chunk); total += data.length;
    if (retained >= maxOutputBytes) return;
    const value = data.subarray(0, maxOutputBytes - retained); chunks.push(value); retained += value.length;
  };
  child.stdout?.on('data', append); child.stderr?.on('data', append);
  const closed = await waitForStartupChildClose(child, timeoutMs, postKillMs);
  return { child, result: { file, targetPid: pid, samplerPid: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
    durationMs: Math.max(0, Date.now() - started), timedOut: closed.timedOut,
    exitCode: closed.code, signal: closed.signal, forced: closed.forced,
    closeConfirmed: closed.closeConfirmed, spawnError: closed.spawnError, killError: closed.killError,
    output: Buffer.concat(chunks, retained).toString('utf8'), outputTruncated: total > retained } };
}
