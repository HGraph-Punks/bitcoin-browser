import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBoundedOutput } from './startup-diagnostic-support.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = path.join(root, 'release', 'packaged-startup-diagnostic-report.json');
const executableArgument = process.argv.find((argument) => argument.startsWith('--executable='))?.slice('--executable='.length);
const RESIDENCY_MS = 5_000;
const STOP_DEADLINE_MS = 15_000;
const MAX_LOG_BYTES_PER_LAUNCH = 128 * 1024;
const MAX_LOG_RECORDS_PER_LAUNCH = 100;

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function findDeveloperExecutable() {
  if (executableArgument) return path.resolve(executableArgument);
  const artifactDirectory = path.join(root, 'release', 'developer');
  if (process.platform === 'darwin') {
    const directories = (await fs.readdir(artifactDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
      .map((entry) => entry.name)
      .sort();
    for (const directory of directories) {
      const candidate = path.join(artifactDirectory, directory, 'Bitcoin Browser.app', 'Contents', 'MacOS', 'Bitcoin Browser');
      if (await exists(candidate)) return candidate;
    }
  } else if (process.platform === 'win32') {
    const candidate = path.join(artifactDirectory, 'win-unpacked', 'Bitcoin Browser.exe');
    if (await exists(candidate)) return candidate;
  } else {
    for (const name of ['bitcoin-browser', 'Bitcoin Browser']) {
      const candidate = path.join(artifactDirectory, 'linux-unpacked', name);
      if (await exists(candidate)) return candidate;
    }
  }
  throw new Error(`No developer executable found under ${artifactDirectory}; pass --executable=/absolute/path.`);
}

async function seedState(profile, withWalletFixture) {
  const stateDirectory = path.join(profile, 'state');
  const extensions = [];
  if (withWalletFixture) {
    const extensionPath = await fs.realpath(path.join(root, 'tests', 'fixtures', 'wallet-extension'));
    extensions.push({
      id: 'packaged-startup-wallet',
      name: 'Packaged startup fixture wallet',
      version: '1.0.0',
      path: extensionPath,
      manifestVersion: 3,
      installedAt: new Date(0).toISOString()
    });
  }
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDirectory, 'state.json'), `${JSON.stringify({
    schemaVersion: 3,
    settings: { localOnly: true },
    providers: [],
    extensions
  })}\n`, { flag: 'wx', mode: 0o600 });
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function normalizedLocation(value) {
  if (value === 'about:blank' || value === 'app://app/renderer/index.html'
    || value === 'https://wallet.satoshi.invalid/index.html' || value === 'ord://content/[redacted]') return value;
  if (typeof value === 'string' && /^(?:[a-z][a-z0-9+.-]*:)\/\/\[redacted\]$/i.test(value)) return value.slice(0, 80);
  return 'unknown';
}

function normalizeLifecycle(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((record) => ({
    phase: typeof record?.phase === 'string' ? record.phase.slice(0, 40) : 'unknown',
    elapsedMs: finiteInteger(record?.elapsedMs),
    sequence: finiteInteger(record?.sequence),
    location: normalizedLocation(record?.location),
    frameProcessId: finiteInteger(record?.frameProcessId),
    frameRoutingId: finiteInteger(record?.frameRoutingId),
    mainFrame: typeof record?.mainFrame === 'boolean' ? record.mainFrame : null
  }));
}

function normalizeKnownRecord(record) {
  if (record?.event === 'app.start') {
    return {
      event: 'app.start',
      version: typeof record.version === 'string' ? record.version.slice(0, 40) : null,
      electron: typeof record.electron === 'string' ? record.electron.slice(0, 40) : null,
      platform: typeof record.platform === 'string' ? record.platform.slice(0, 20) : null
    };
  }
  if (record?.event === 'app.shutdown') {
    return {
      event: 'app.shutdown',
      phase: typeof record.phase === 'string' ? record.phase.slice(0, 80) : null,
      pid: finiteInteger(record.pid),
      elapsedMs: finiteInteger(record.elapsedMs)
    };
  }
  if (record?.event === 'renderer.bootstrap') {
    return {
      event: 'renderer.bootstrap',
      code: ['SANDBOX_BUNDLE_SCRIPT_FAILED', 'SANDBOX_STARTUP_DATA_NULL', 'APPLICATION_PRELOAD_ERROR'].includes(record.code) ? record.code : 'UNKNOWN_BOOTSTRAP_DIAGNOSTIC',
      pid: finiteInteger(record.pid),
      webContentsId: finiteInteger(record.webContentsId),
      webContentsType: typeof record.webContentsType === 'string' ? record.webContentsType.slice(0, 40) : null,
      session: typeof record.session === 'string' ? record.session.slice(0, 40) : null,
      location: normalizedLocation(record.location),
      frameProcessId: finiteInteger(record.frameProcessId),
      frameRoutingId: finiteInteger(record.frameRoutingId),
      mainFrame: typeof record.mainFrame === 'boolean' ? record.mainFrame : null,
      captureElapsedMs: finiteInteger(record.captureElapsedMs),
      captureSequence: finiteInteger(record.captureSequence),
      lifecycle: normalizeLifecycle(record.lifecycle),
      lifecycleDropped: finiteInteger(record.lifecycleDropped)
    };
  }
  return null;
}

async function collectKnownLogs(logFile, offset, ownedPid) {
  let handle;
  try { handle = await fs.open(logFile, 'r'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { nextOffset: offset, bytesRead: 0, truncated: false, records: [] };
    throw error;
  }
  try {
    const stat = await handle.stat();
    const available = Math.max(0, stat.size - offset);
    const length = Math.min(available, MAX_LOG_BYTES_PER_LAUNCH);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const records = [];
    let parseTruncated = false;
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line) continue;
      if (line.length > 32_768) { parseTruncated = true; continue; }
      try {
        const normalized = normalizeKnownRecord(JSON.parse(line));
        if (!normalized) continue;
        if (normalized.event !== 'app.start' && normalized.pid !== ownedPid) continue;
        if (records.length >= MAX_LOG_RECORDS_PER_LAUNCH) { parseTruncated = true; continue; }
        records.push(normalized);
      } catch { parseTruncated = true; }
    }
    return { nextOffset: stat.size, bytesRead, truncated: available > length || parseTruncated, records };
  } finally {
    await handle.close();
  }
}

function waitForClose(child) {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function waitUntilOrTimeout(promise, timeoutMs, timeoutValue) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function launchOnce(executable, profile, run, logOffset) {
  const startedAt = Date.now();
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--no-first-run', '--disable-breakpad'], {
    cwd: root,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = createBoundedOutput();
  const stderr = createBoundedOutput();
  child.stdout?.on('data', (chunk) => stdout.append(chunk));
  child.stderr?.on('data', (chunk) => stderr.append(chunk));
  const close = waitForClose(child);
  const ownedPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
  let spawnError = null;
  child.once('error', (error) => { spawnError = error?.code ?? 'SPAWN_FAILED'; });

  const residency = await waitUntilOrTimeout(close.then(() => false), RESIDENCY_MS, true);
  let sigtermSent = false;
  let forcedSigkill = false;
  let stopStartedAt = null;
  if (residency && child.exitCode === null && child.signalCode === null) {
    stopStartedAt = Date.now();
    sigtermSent = child.kill('SIGTERM');
  }
  const stopped = await waitUntilOrTimeout(
    close.then((result) => ({ ...result, deadline: false })),
    STOP_DEADLINE_MS,
    { code: null, signal: null, deadline: true }
  );
  let result = stopped;
  if (stopped.deadline && child.exitCode === null && child.signalCode === null) {
    forcedSigkill = child.kill('SIGKILL');
    result = { ...(await close), deadline: true };
  }
  const closedAt = Date.now();
  const logs = await collectKnownLogs(path.join(profile, 'logs', 'satoshi-browser.jsonl'), logOffset, ownedPid);
  const stderrSandboxBundleCount = (stderr.text.match(/sandboxed_renderer\.bundle\.js script failed to run/gi) ?? []).length;
  const stderrStartupDataNullCount = (stderr.text.match(/binding\.startupData[^\n]{0,160}(?:is null|null)/gi) ?? []).length;
  return {
    report: {
      run,
      pid: ownedPid,
      residentForObservationWindow: residency,
      functionalReadinessObserved: false,
      sigtermSent,
      forcedSigkill,
      stopDeadlineExceeded: result.deadline,
      code: result.code,
      signal: result.signal,
      durationMs: closedAt - startedAt,
      stopDurationMs: stopStartedAt === null ? null : closedAt - stopStartedAt,
      spawnError,
      stdout: { bytesSeen: stdout.totalBytesSeen, truncated: stdout.truncated },
      stderr: { bytesSeen: stderr.totalBytesSeen, truncated: stderr.truncated },
      stderrSandboxSignatures: {
        sandboxBundleScriptFailed: stderrSandboxBundleCount,
        startupDataNull: stderrStartupDataNullCount
      },
      logRead: { bytesRead: logs.bytesRead, truncated: logs.truncated },
      appStartCount: logs.records.filter((record) => record.event === 'app.start').length,
      events: logs.records
    },
    logOffset: logs.nextOffset
  };
}

async function main() {
  const executable = await findDeveloperExecutable();
  await fs.access(executable);
  const cases = [];
  let temporaryProfilesRemoved = 0;
  for (const testCase of [
    { name: 'clean-no-extension', withWalletFixture: false },
    { name: 'seeded-wallet-fixture', withWalletFixture: true }
  ]) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), `satoshi-packaged-startup-${testCase.name}-`));
    await fs.chmod(profile, 0o700);
    try {
      await seedState(profile, testCase.withWalletFixture);
      const launches = [];
      let logOffset = 0;
      for (let run = 1; run <= 3; run += 1) {
        const result = await launchOnce(executable, profile, run, logOffset);
        launches.push(result.report);
        logOffset = result.logOffset;
        console.error(`${testCase.name} launch ${run}/3: resident=${result.report.residentForObservationWindow} appStart=${result.report.appStartCount} exit=${result.report.code ?? result.report.signal ?? 'none'} forced=${result.report.forcedSigkill}`);
      }
      cases.push({ case: testCase.name, launches });
    } finally {
      await fs.rm(profile, { recursive: true, force: true });
      temporaryProfilesRemoved += 1;
    }
  }
  const launches = cases.flatMap((testCase) => testCase.launches);
  const bootstrapRecords = launches.reduce((count, launch) => count + launch.events.filter((event) => event.event === 'renderer.bootstrap').length, 0);
  const stderrSandboxSignatures = launches.reduce((count, launch) => count
    + launch.stderrSandboxSignatures.sandboxBundleScriptFailed + launch.stderrSandboxSignatures.startupDataNull, 0);
  const qualificationPassed = launches.length === 6 && launches.every((launch) => launch.residentForObservationWindow
    && launch.appStartCount >= 1 && !launch.stdout.truncated && !launch.stderr.truncated && !launch.logRead.truncated
    && launch.sigtermSent && launch.code === 0 && launch.signal === null && !launch.forcedSigkill && launch.spawnError === null);
  const bootstrapReproduced = bootstrapRecords > 0 || stderrSandboxSignatures > 0;
  const report = {
    generatedAt: new Date().toISOString(),
    executable: { kind: 'developer-executable', platform: process.platform, arch: process.arch },
    remoteDebugging: false,
    cdpAttached: false,
    observationWindowMs: RESIDENCY_MS,
    stopDeadlineMs: STOP_DEADLINE_MS,
    limitation: 'Fixed process residency and allowlisted application logs do not prove renderer or functional readiness.',
    summary: {
      total: launches.length,
      resident: launches.filter((launch) => launch.residentForObservationWindow).length,
      appStarts: launches.reduce((count, launch) => count + launch.appStartCount, 0),
      cleanExits: launches.filter((launch) => launch.code === 0 && launch.signal === null).length,
      forced: launches.filter((launch) => launch.forcedSigkill).length,
      bootstrapRecords,
      stderrSandboxSignatures,
      temporaryProfilesRemoved,
      qualificationPassed,
      bootstrapReproduced
    },
    cases
  };
  await fs.mkdir(path.dirname(reportFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report.summary));
  if (!qualificationPassed || bootstrapReproduced) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error?.code ?? 'DIAGNOSTIC_FAILED' }));
  process.exitCode = 1;
});
