import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createBoundedOutput, waitForStartupChildClose } from './startup-diagnostic-support.mjs';
import { readStartupInput } from './startup-barrier-support.mjs';
import { detachUnconfirmedPackagedChild } from './packaged-smoke-child-lifecycle.mjs';
import { runStartupCompatibility, validateCompatibilityReport } from './startup-compatibility-support.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = fileURLToPath(import.meta.url);
const prefix = 'STARTUP_COMPATIBILITY_RESULT:';
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

// Opt-in native diagnostic, never invoked by the Node test suite. Running this
// requires separate native/profile authority. It does not exercise Runtime.enable
// and cannot qualify the original early-debugger failure or a runtime correction.
export function installCompatibilityInterruptHandlers(controller, target = process) {
  const handlers = ['SIGINT', 'SIGTERM'].map(name => {
    const handler = () => controller.abort(Object.assign(new Error('Compatibility diagnostic interrupted'),
      { code: 'COMPATIBILITY_INTERRUPTED', signal: name }));
    target.on(name, handler);
    return { name, handler };
  });
  return () => { for (const { name, handler } of handlers) target.removeListener(name, handler); };
}

export async function runCompatibilityDiagnostic({ runNative = false, reportPath, signal }, dependencies = {}) {
  if (!runNative) throw new Error('Explicit --run-native and native/profile authorization are required');
  if (!path.isAbsolute(reportPath ?? '') || !/^startup-compatibility-[a-zA-Z0-9-]+\.json$/.test(path.basename(reportPath))) {
    throw new Error('An absolute, new startup-compatibility-<name>.json report path is required');
  }
  const checkInterrupted = () => {
    if (signal?.aborted) throw Object.assign(new Error('Compatibility diagnostic interrupted'), { code: 'COMPATIBILITY_INTERRUPTED' });
  };
  checkInterrupted();
  const ownershipPath = reportPath.replace(/\.json$/, '-ownership.json');
  const interruptionPath = reportPath.replace(/\.json$/, '-interrupted.json');
  const io = dependencies.fs ?? fs;
  const launch = dependencies.spawn ?? spawn;
  const waitClose = dependencies.waitClose ?? waitForStartupChildClose;
  const readInput = dependencies.readInput ?? readStartupInput;
  const executable = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const framework = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
  const electronPackage = path.join(root, 'node_modules/electron/package.json');
  const installedVersion = path.join(root, 'node_modules/electron/dist/version');
  const inputs = [runner, path.join(root, 'scripts/startup-compatibility-support.mjs'),
    path.join(root, 'scripts/startup-diagnostic-support.mjs'), path.join(root, 'scripts/startup-barrier-support.mjs'),
    path.join(root, 'scripts/packaged-smoke-child-lifecycle.mjs'),
    path.join(root, 'tests/fixtures/wallet-startup/compatibility-preload.cjs'), executable, framework, electronPackage, installedVersion];
  const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const provenance = async () => {
    const captured = [];
    for (const filename of inputs) {
      checkInterrupted();
    const metadata = filename === electronPackage || filename === installedVersion;
    const { data, ...identity } = await readInput(filename, metadata ? 65536 : 512 * 1024 * 1024, metadata);
    if (metadata) {
      let version;
      try { version = filename === electronPackage ? JSON.parse(data.toString('utf8')).version : data.toString('utf8').trim().replace(/^v/, ''); }
      catch { version = null; }
      identity.version = typeof version === 'string' && versionPattern.test(version) ? version : null;
    }
      captured.push(identity);
    }
    checkInterrupted();
    return captured;
  };
  const runtimeIdentity = captured => {
    const version = captured.find(input => input.path === electronPackage)?.version;
    const architecture = captured.find(input => input.path === executable)?.architecture;
    const valid = Boolean(version && version === captured.find(input => input.path === installedVersion)?.version
      && ['arm64', 'x64'].includes(architecture) && architecture === captured.find(input => input.path === framework)?.architecture);
    return { electron: version ?? null, architecture: architecture ?? null, valid };
  };
  for (const filename of [reportPath, ownershipPath, interruptionPath]) {
    checkInterrupted();
    try { await io.lstat(filename); throw new Error('Refusing to overwrite existing diagnostic evidence'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const before = await provenance();
  const expectedRuntime = runtimeIdentity(before);
  if (!expectedRuntime.valid) {
    const rejected = { schemaVersion: 1, generatedAt: new Date().toISOString(), launchAttempted: false, nativeExecuted: false, complete: false,
      earlyDebuggerQualified: false, supportedRuntimeCorrectionQualified: false,
      error: { code: 'COMPATIBILITY_RUNTIME_IDENTITY_INVALID' }, provenance: { before }, runtime: { expected: expectedRuntime, consistent: false } };
    await io.writeFile(reportPath, JSON.stringify(rejected, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return rejected;
  }
  const stdout = createBoundedOutput(128 * 1024); const stderr = createBoundedOutput(128 * 1024);
  let profile = null; let child; let closing = null; let close = null; let fixture = null; let report;
  let launchAttempted = false; let ownershipPublished = false;
  let terminationRequested = false; let terminationError = null;
  let stdoutListener; let stderrListener; let stdoutStream; let stderrStream;
  const childAdmitted = () => Number.isSafeInteger(child?.pid) && child.pid > 0;
  const requestInterruption = () => {
    if (!signal?.aborted || !childAdmitted() || terminationRequested || close?.closeConfirmed
      || child.exitCode != null || child.signalCode != null) return;
    terminationRequested = true;
    try { if (!child.kill('SIGTERM')) terminationError = 'KILL_NOT_SENT'; }
    catch (error) { terminationError = /^[A-Z0-9_]{1,80}$/.test(error?.code) ? error.code : 'KILL_FAILED'; }
  };
  const retainInterruption = () => {
    report.cancellation = { aborted: signal?.aborted === true, terminationRequested, terminationError };
    if (signal?.aborted) { report.complete = false; report.interrupted = true; }
  };
  signal?.addEventListener('abort', requestInterruption);
  try {
    try {
      checkInterrupted();
      profile = await io.mkdtemp(path.join(os.tmpdir(), 'startup-compatibility-native-'));
      checkInterrupted();
      // Exclusive prepared ownership survives wrapper cancellation or failure
      // before a terminal result. The PID is separately emitted after admission.
      await io.writeFile(ownershipPath, JSON.stringify({ schemaVersion: 1, state: 'prepared',
        reportPath, profile, executable, runner, pid: null, generatedAt: new Date().toISOString() }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
      ownershipPublished = true;
      checkInterrupted();
      launchAttempted = true;
      child = launch(executable, [runner, '--compatibility-child', `--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      // Observe the exact child before any fallible pipe hookup or awaited work.
      closing = waitClose(child, 20000, 3000);
      requestInterruption();
      stdoutStream = child.stdout; stderrStream = child.stderr;
      stdoutListener = chunk => stdout.append(chunk); stderrListener = chunk => stderr.append(chunk);
      stdoutStream.on('data', stdoutListener); stderrStream.on('data', stderrListener);
      (dependencies.reportOwnership ?? (value => process.stderr.write(JSON.stringify(value) + '\n')))({
        code: 'COMPATIBILITY_CHILD_OWNERSHIP', pid: childAdmitted() ? child.pid : null, profile, ownershipPath, reportPath
      });
      requestInterruption();
      close = await closing;
      const lines = stdout.text.split(/\r?\n/).filter(line => line.startsWith(prefix));
      if (lines.length === 1) { try { fixture = JSON.parse(lines[0].slice(prefix.length)); } catch {} }
      const after = await provenance();
      const unchanged = JSON.stringify(before) === JSON.stringify(after);
      const runtimeConsistent = runtimeIdentity(after).valid
        && fixture?.runtime?.electron === expectedRuntime.electron && fixture?.runtime?.architecture === expectedRuntime.architecture;
      const complete = childAdmitted() && !signal?.aborted
        && close.closeConfirmed === true && close.code === 0 && close.signal === null
        && close.forced === false && close.timedOut === false && close.spawnError === null && close.killError === null
        && !stdout.truncated && !stderr.truncated && unchanged && runtimeConsistent && validateCompatibilityReport(fixture);
      report = { schemaVersion: 1, generatedAt: new Date().toISOString(), launchAttempted, nativeExecuted: childAdmitted(), complete,
        earlyDebuggerQualified: false, supportedRuntimeCorrectionQualified: false, profileMode: 'fresh',
        process: close, provenance: { before, after, unchanged }, runtime: { expected: expectedRuntime, actual: fixture?.runtime ?? null, consistent: runtimeConsistent }, fixture,
        output: { stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated } };
    } catch (error) {
      report = { schemaVersion: 1, generatedAt: new Date().toISOString(), launchAttempted, nativeExecuted: childAdmitted(), complete: false,
        earlyDebuggerQualified: false, supportedRuntimeCorrectionQualified: false,
        process: close, error: { code: /^[A-Z0-9_]{1,80}$/.test(error?.code) ? error.code : 'COMPATIBILITY_DIAGNOSTIC_FAILED' },
        provenance: { before }, fixture, output: { stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated } };
    } finally {
      if (child && !closing) closing = waitClose(child, 1000, 3000);
      if (closing && !close) close = await closing;
      if (stdoutStream && stdoutListener) stdoutStream.removeListener('data', stdoutListener);
      if (stderrStream && stderrListener) stderrStream.removeListener('data', stderrListener);
    }
    report.process = close ? { ...close, pid: childAdmitted() ? child.pid : null } : null;
    // Direct-child/stdio closure does not prove every renderer descendant exited.
    // All profiles are retained, including clean runs, pending separate review.
    report.profile = { path: profile, removed: false, retained: profile !== null,
      retainedForUnconfirmedClose: Boolean(child && !close?.closeConfirmed),
      retentionReason: profile ? 'NATIVE_DESCENDANT_EXIT_NOT_INDEPENDENTLY_CONFIRMED' : null };
    report.ownership = { path: ownershipPath, published: ownershipPublished };
    report.interruptionPath = interruptionPath;
    retainInterruption();
    try {
      await io.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      // Keep the first snapshot immutable. An interrupt during its write must
      // invalidate it; consumers must check terminal status and this marker.
      if (signal?.aborted && !report.interrupted) {
        retainInterruption();
        await io.writeFile(interruptionPath, JSON.stringify({ complete: false, code: 'COMPATIBILITY_INTERRUPTED',
          reportPath, profile, pid: childAdmitted() ? child.pid : null }) + '\n', { flag: 'wx', mode: 0o600 });
      }
    } catch (error) {
      report.complete = false;
      retainInterruption();
      const fallback = { code: 'COMPATIBILITY_REPORT_WRITE_FAILED', reportPath, complete: false,
        interrupted: signal?.aborted === true, unknownPid: child && !close?.closeConfirmed ? child.pid ?? null : null,
        profile: report.profile, ownership: report.ownership, interruptionPath };
      (dependencies.reportFailure ?? (value => process.stderr.write(JSON.stringify(value) + '\n')))(fallback);
      throw error;
    } finally { if (child && !close?.closeConfirmed) detachUnconfirmedPackagedChild(child); }
    return report;
  } finally { signal?.removeEventListener('abort', requestInterruption); }
}

async function main(electron) {
  if (process.versions.electron) {
    const { app } = electron;
    if (!process.argv.includes('--compatibility-child') || !argument('user-data-dir')) {
      throw new Error('Use the Node diagnostic runner with explicit native authorization');
    }
    app.setPath('userData', argument('user-data-dir'));
    const report = await runStartupCompatibility({ electron,
      preloadPath: path.join(root, 'tests/fixtures/wallet-startup/compatibility-preload.cjs') });
    report.runtime = { electron: process.versions.electron, chrome: process.versions.chrome, architecture: process.arch };
    console.log(prefix + JSON.stringify(report));
    if (report.fixtureComplete) app.quit(); else app.exit(1);
  } else {
    const controller = new AbortController();
    const dispose = installCompatibilityInterruptHandlers(controller);
    try {
      const report = await runCompatibilityDiagnostic({ runNative: process.argv.includes('--run-native'),
        reportPath: argument('report'), signal: controller.signal });
      console.log(JSON.stringify({ complete: report.complete && !controller.signal.aborted, reportPath: argument('report'),
        nativeExecuted: report.nativeExecuted, interrupted: controller.signal.aborted, profile: report.profile }));
      if (!report.complete || controller.signal.aborted) process.exitCode = 1;
    } finally { dispose(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === runner) {
  if (process.versions.electron) {
    // Finish the import and synchronous pre-ready setup, then release ESM
    // evaluation. Awaiting fixture completion here prevents Electron's loader
    // from announcing appCodeLoaded, while the fixture awaits app.whenReady().
    const electron = await import('electron');
    main(electron).catch(() => {
      console.error(JSON.stringify({ code: 'COMPATIBILITY_CHILD_BOOTSTRAP_FAILED' }));
      electron.app.exit(1);
    });
  } else {
    await main();
  }
}
