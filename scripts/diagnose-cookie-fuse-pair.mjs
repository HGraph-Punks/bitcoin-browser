import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import {
  STOCK_MODES,
  classifyCleanExit,
  classifyExperimentCompletion,
  classifyStockRun,
  hasExpectedRawTlsActivity,
  runChild,
  startRawTlsSink,
  stockMainSource,
  stockProbeHtml
} from './diagnose-stock-network-shutdown.mjs';

const execFile = promisify(execFileCallback);
const PAIR_PREFIX = 'satoshi-cookie-fuse-pair-';
const EXEC_TIMEOUT_MS = 20_000;

export function parseCookieFusePairArgs(argv) {
  const parsed = { pairRoot: null, output: null, modes: [...STOCK_MODES], repeat: 1 };
  const seen = new Set();
  for (const argument of argv) {
    const equals = argument.indexOf('=');
    const key = equals < 0 ? argument : argument.slice(0, equals);
    const value = equals < 0 ? '' : argument.slice(equals + 1);
    if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
    seen.add(key);
    if (key === '--pair-root') parsed.pairRoot = value;
    else if (key === '--output') parsed.output = value;
    else if (key === '--mode') parsed.modes = value.split(',');
    else if (key === '--repeat') parsed.repeat = Number(value);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!parsed.pairRoot || !path.isAbsolute(parsed.pairRoot)) throw new Error('pair-root must be an absolute path');
  if (!parsed.output || !path.isAbsolute(parsed.output)) throw new Error('output must be an absolute path');
  if (!parsed.modes.length || parsed.modes.some((mode) => !STOCK_MODES.includes(mode))
    || new Set(parsed.modes).size !== parsed.modes.length) throw new Error('Modes must be unique reviewed stock modes');
  if (!Number.isSafeInteger(parsed.repeat) || parsed.repeat < 1 || parsed.repeat > 3) throw new Error('Repeat must be an integer from 1 to 3');
  parsed.pairRoot = path.resolve(parsed.pairRoot);
  parsed.output = path.resolve(parsed.output);
  return parsed;
}

export function buildPairSchedule(modes, repeat) {
  const schedule = [];
  for (const mode of modes) {
    for (let run = 1; run <= repeat; run += 1) {
      const arms = run % 2 === 1 ? ['control', 'cookie-encrypted'] : ['cookie-encrypted', 'control'];
      for (const arm of arms) schedule.push({ mode, run, arm });
    }
  }
  return schedule;
}

export function validateFusePair(original, control, encrypted) {
  if (!original || !control || !encrypted || original.version !== control.version || original.version !== encrypted.version) {
    return { valid: false, reason: 'FUSE_VERSION_MISMATCH' };
  }
  const cookie = FuseV1Options.EnableCookieEncryption;
  if (original[cookie] !== FuseState.DISABLE || control[cookie] !== FuseState.DISABLE
    || encrypted[cookie] !== FuseState.ENABLE) return { valid: false, reason: 'COOKIE_FUSE_STATE_MISMATCH' };
  const keys = new Set([...Object.keys(original), ...Object.keys(control), ...Object.keys(encrypted)]);
  for (const key of keys) {
    if (key === 'version' || Number(key) === cookie) continue;
    if (original[key] !== control[key] || original[key] !== encrypted[key]) {
      return { valid: false, reason: 'NON_COOKIE_FUSE_MISMATCH', field: key };
    }
  }
  return { valid: true, reason: null };
}

export function classifyPairReport(report) {
  const runs = report?.runs ?? [];
  const modes = report?.config?.modes ?? [];
  const repeat = report?.config?.repeat ?? 0;
  const expected = modes.length && repeat > 0 ? buildPairSchedule(modes, repeat) : [];
  const identitiesMatch = expected.length > 0 && runs.length === expected.length
    && expected.every((item, index) => item.mode === runs[index]?.mode && item.run === runs[index]?.run && item.arm === runs[index]?.arm);
  const matrixComplete = report?.stoppedReason === null && identitiesMatch && runs.every((item) => item.closed === true);
  return {
    matrixComplete,
    experimentsCompleted: runs.filter(classifyExperimentCompletion).length,
    cleanExits: runs.filter(classifyCleanExit).length,
    expectedRawTlsActivity: runs.filter((item) => item.networkExpectationMet === true).length,
    passing: matrixComplete && runs.every((item) => classifyStockRun(item))
  };
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fuseWireSha256(wire) {
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(wire).sort(([left], [right]) => left.localeCompare(right)))));
}
async function hashFile(filename, io = fs) { return sha256(await io.readFile(filename)); }

export async function requireOwnedPairRoot(pairRoot, io = fs) {
  const allowedParents = new Set(await Promise.all([path.resolve(os.tmpdir()), '/private/tmp'].map(async (item) => {
    try { return await io.realpath(item); } catch { return item; }
  })));
  const parent = path.dirname(pairRoot);
  if (!allowedParents.has(parent) || !path.basename(pairRoot).startsWith(PAIR_PREFIX)) throw new Error('pair-root is outside the reviewed owned temp scope');
  const stat = await io.lstat(pairRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('pair-root must be an owned non-symlink 0700 directory');
  if (await io.realpath(pairRoot) !== pairRoot) throw new Error('pair-root must resolve exactly');
}

export async function inspectBundle(bundle, io = fs, fuseReader = getCurrentFuseWire) {
  const stat = await io.lstat(bundle);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Electron bundle must be a real directory');
  const realBundle = await io.realpath(bundle);
  if (realBundle !== bundle) throw new Error('Electron bundle must resolve exactly');
  const executable = path.join(bundle, 'Contents', 'MacOS', 'Electron');
  const framework = path.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
  for (const target of [executable, framework]) {
    const real = await io.realpath(target);
    if (!real.startsWith(`${bundle}${path.sep}`)) throw new Error('Bundle target escapes its owned bundle');
  }
  const infoPlist = path.join(bundle, 'Contents', 'Info.plist');
  const realInfoPlist = await io.realpath(infoPlist);
  if (!realInfoPlist.startsWith(`${bundle}${path.sep}`)) throw new Error('Info.plist escapes its owned bundle');
  return {
    bundle, executable, framework, infoPlist,
    hashes: {
      executable: await hashFile(executable, io),
      framework: await hashFile(framework, io),
      infoPlist: await hashFile(infoPlist, io)
    },
    fuseWire: await fuseReader(bundle)
  };
}

export async function verifySignature(bundle, execute = execFile) {
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], {
    timeout: EXEC_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8', killSignal: 'SIGKILL'
  });
}

export async function runCookieFusePair(options, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('Cookie fuse pair runner supports macOS only');
  const config = parseCookieFusePairArgs([
    `--pair-root=${options.pairRoot}`, `--output=${options.output}`,
    `--mode=${options.modes.join(',')}`, `--repeat=${options.repeat}`
  ]);
  const io = dependencies.fs ?? fs;
  const outputHandle = await io.open(config.output, 'wx', 0o600);
  let outputClosed = false;
  try {
    await requireOwnedPairRoot(config.pairRoot, io);
    const require = createRequire(import.meta.url);
    const originalExecutable = require('electron');
    const originalBundle = path.resolve(originalExecutable, '..', '..', '..');
    const bundlePaths = {
      control: path.join(config.pairRoot, 'control', 'Electron.app'),
      'cookie-encrypted': path.join(config.pairRoot, 'cookie-encrypted', 'Electron.app')
    };
    const fuseReader = dependencies.getCurrentFuseWire ?? getCurrentFuseWire;
    const inspect = dependencies.inspectBundle ?? inspectBundle;
    const inspected = {
      original: await inspect(originalBundle, io, fuseReader),
      control: await inspect(bundlePaths.control, io, fuseReader),
      'cookie-encrypted': await inspect(bundlePaths['cookie-encrypted'], io, fuseReader)
    };
    for (const item of Object.values(inspected)) item.fuseWireSha256 = fuseWireSha256(item.fuseWire);
    const fuseValidation = validateFusePair(inspected.original.fuseWire, inspected.control.fuseWire, inspected['cookie-encrypted'].fuseWire);
    if (!fuseValidation.valid) throw new Error(`Prepared pair rejected: ${fuseValidation.reason}`);
    if (inspected.original.hashes.infoPlist !== inspected.control.hashes.infoPlist
      || inspected.original.hashes.infoPlist !== inspected['cookie-encrypted'].hashes.infoPlist) throw new Error('Prepared pair Info.plist hashes differ');
    const signatureVerifier = dependencies.verifySignature ?? verifySignature;
    await signatureVerifier(bundlePaths.control);
    await signatureVerifier(bundlePaths['cookie-encrypted']);

    const fixtureDirectory = path.join(config.pairRoot, 'fixture');
    await io.mkdir(fixtureDirectory, { mode: 0o700 });
    const mainBytes = stockMainSource();
    await io.writeFile(path.join(fixtureDirectory, 'package.json'), JSON.stringify({ name: 'stock-network-shutdown', main: 'main.cjs' }), { flag: 'wx', mode: 0o600 });
    await io.writeFile(path.join(fixtureDirectory, 'main.cjs'), mainBytes, { flag: 'wx', mode: 0o600 });
    const sinkLimit = 128;
    const runner = dependencies.runChild ?? runChild;
    const runs = [];
    let stoppedReason = null;
    let lastAttempted = null;
    const profilesRoot = path.join(config.pairRoot, 'profiles');
    await io.mkdir(profilesRoot, { mode: 0o700 });
    for (const arm of ['control', 'cookie-encrypted']) {
      const armRoot = path.join(profilesRoot, arm);
      await io.mkdir(armRoot, { mode: 0o700 });
      for (const mode of config.modes) await io.mkdir(path.join(armRoot, mode), { mode: 0o700 });
    }
    const sink = await (dependencies.startRawTlsSink ?? startRawTlsSink)({ maxConnections: sinkLimit });
    try {
      for (const item of buildPairSchedule(config.modes, config.repeat)) {
        const fixture = stockProbeHtml(item.mode, sink.endpoint);
        await io.writeFile(path.join(fixtureDirectory, 'index.html'), fixture, { mode: 0o600 });
        const profile = path.join(profilesRoot, item.arm, item.mode);
        lastAttempted = { ...item, profile };
        const before = sink.connections.length;
        let result;
        try {
          result = await runner(inspected[item.arm].executable, fixtureDirectory, profile, item.mode, item.run);
        } catch (error) {
          stoppedReason = `RUNNER_FAILED:${error?.code ?? 'UNEXPECTED'}`;
          runs.push({ ...item, profile, closed: false, closureUncertain: true, runnerFailure: error?.code ?? 'UNEXPECTED' });
          break;
        }
        const observations = sink.connections.slice(before).map((entry) => ({ ...entry }));
        Object.assign(result, item, {
          profile,
          rawTlsConnections: observations,
          rawTlsObservationOverflow: sink.observationOverflow,
          networkExpectationMet: hasExpectedRawTlsActivity(result.outcome, observations),
          fixtureSha256: sha256(fixture)
        });
        result.passed = classifyStockRun(result);
        runs.push(result);
        if (!result.closed) { stoppedReason = 'OWNED_PROCESS_CLOSE_UNCONFIRMED'; break; }
      }
    } finally {
      await sink.close();
    }
    const electronPackage = JSON.parse(await io.readFile(require.resolve('electron/package.json'), 'utf8'));
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      purpose: 'Matched disposable stock-Electron cookie-encryption fuse comparison; not product qualification',
      config,
      security: 'Both prepared disposable stock bundles passed bounded deep/strict code-signature verification; signing identity was not inspected. The runner changes no fuses, signatures, trust, certificates, credentials, or production files; sandbox/context isolation/web security and permission denial come from the shared stock fixture.',
      runtime: { electronVersion: electronPackage.version, argv: ['APP_DIR', '--user-data-dir=OWNED_PROFILE', '--no-first-run', '--disable-breakpad'], envKeys: ['PATH'] },
      observationLimit: sinkLimit,
      provenance: { inspected, fuseValidation, signatureVerification: { control: true, 'cookie-encrypted': true }, fixture: { mainSha256: sha256(mainBytes) } },
      retainedPaths: { pairRoot: config.pairRoot, profiles: path.join(config.pairRoot, 'profiles') },
      stoppedReason,
      lastAttempted,
      runs
    };
    report.summary = classifyPairReport(report);
    await outputHandle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await outputHandle.sync();
    await outputHandle.close();
    outputClosed = true;
    return report;
  } finally {
    if (!outputClosed) await outputHandle.close();
  }
}

async function main() {
  const config = parseCookieFusePairArgs(process.argv.slice(2));
  const report = await runCookieFusePair(config);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  if (!report.summary.matrixComplete || !report.summary.passing) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? 'Cookie fuse pair diagnostic failed'}\n`);
    process.exitCode = 1;
  });
}
