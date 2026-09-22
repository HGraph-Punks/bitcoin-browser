import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FuseState, FuseV1Options } from '@electron/fuses';
import {
  buildPairSchedule,
  classifyPairReport,
  parseCookieFusePairArgs,
  runCookieFusePair,
  validateFusePair
} from '../scripts/diagnose-cookie-fuse-pair.mjs';

const ROOT = path.resolve('/private/tmp/satoshi-cookie-fuse-pair-test');
const OUTPUT = path.resolve('/private/tmp/cookie-pair-report.json');

test('pair CLI requires exclusive absolute roots, unique flags, reviewed modes and bounded repeats', () => {
  assert.deepEqual(parseCookieFusePairArgs([`--pair-root=${ROOT}`, `--output=${OUTPUT}`]), {
    pairRoot: ROOT, output: OUTPUT, modes: ['https', 'https-include', 'wss'], repeat: 1
  });
  assert.deepEqual(parseCookieFusePairArgs([`--pair-root=${ROOT}`, `--output=${OUTPUT}`, '--mode=wss,https', '--repeat=3']).modes, ['wss', 'https']);
  for (const args of [
    [`--output=${OUTPUT}`], [`--pair-root=${ROOT}`], ['--pair-root=relative', `--output=${OUTPUT}`],
    [`--pair-root=${ROOT}`, '--output=relative'], [`--pair-root=${ROOT}`, `--output=${OUTPUT}`, '--repeat=0'],
    [`--pair-root=${ROOT}`, `--output=${OUTPUT}`, '--repeat=4'], [`--pair-root=${ROOT}`, `--output=${OUTPUT}`, '--mode='],
    [`--pair-root=${ROOT}`, `--output=${OUTPUT}`, '--mode=https,https'],
    [`--pair-root=${ROOT}`, `--pair-root=${ROOT}`, `--output=${OUTPUT}`]
  ]) assert.throws(() => parseCookieFusePairArgs(args));
});

async function pairFixture(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cookie-fuse-pair-'));
  const root = await fs.realpath(created);
  await fs.chmod(root, 0o700);
  const output = `${root}-report.json`;
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(output, { force: true });
  });
  const original = wire(FuseState.DISABLE);
  const control = wire(FuseState.DISABLE);
  const encrypted = wire(FuseState.ENABLE);
  const inspections = [original, control, encrypted];
  const inspectBundle = async (bundle) => ({
    bundle, executable: path.join(bundle, 'Contents', 'MacOS', 'Electron'), framework: 'framework', infoPlist: 'Info.plist',
    hashes: { executable: 'exe', framework: 'framework', infoPlist: 'same-plist' }, fuseWire: inspections.shift()
  });
  const sink = { endpoint: 'https://127.0.0.1:43123', connections: [], observationOverflow: false, async close() {} };
  return { root, output, inspectBundle, sink };
}

test('injected workflow verifies preparation before launch and preserves alternating run identities', { skip: process.platform === 'win32' ? 'macOS-only runner requires POSIX ownership and 0700 modes' : false }, async (t) => {
  const fixture = await pairFixture(t);
  const called = [];
  const report = await runCookieFusePair({ pairRoot: fixture.root, output: fixture.output, modes: ['https'], repeat: 2 }, {
    platform: 'darwin', inspectBundle: fixture.inspectBundle,
    verifySignature: async (bundle) => called.push(['signature', path.basename(path.dirname(bundle))]),
    startRawTlsSink: async (options) => { called.push(['sink', options.maxConnections]); return fixture.sink; },
    runChild: async (_executable, _directory, profile, mode, run) => {
      called.push(['run', profile, mode, run]);
      fixture.sink.connections.push({ clientHello: true, bytes: 64 });
      return cleanRun();
    }
  });
  assert.equal(report.observationLimit, 128);
  assert.deepEqual(report.runs.map(({ arm, run }) => ({ arm, run })), buildPairSchedule(['https'], 2).map(({ arm, run }) => ({ arm, run })));
  assert.equal(report.summary.matrixComplete, true);
  assert.equal(report.summary.passing, true);
  assert.equal(called.filter(([kind]) => kind === 'signature').length, 2);
  assert.deepEqual(called.find(([kind]) => kind === 'sink'), ['sink', 128]);
  assert.equal((await fs.stat(path.join(fixture.root, 'profiles'))).mode & 0o777, 0o700);
});

test('fuse and signature preflight failures never launch a child', { skip: process.platform === 'win32' ? 'macOS-only runner requires POSIX ownership and 0700 modes' : false }, async (t) => {
  const fuseFixture = await pairFixture(t);
  let launched = 0;
  const badInspections = [wire(FuseState.DISABLE), wire(FuseState.DISABLE), wire(FuseState.DISABLE)];
  await assert.rejects(runCookieFusePair({ pairRoot: fuseFixture.root, output: fuseFixture.output, modes: ['https'], repeat: 1 }, {
    platform: 'darwin',
    inspectBundle: async (bundle) => ({ bundle, executable: 'exe', hashes: { infoPlist: 'same' }, fuseWire: badInspections.shift() }),
    verifySignature: async () => {}, startRawTlsSink: async () => assert.fail('sink must not start'), runChild: async () => { launched += 1; }
  }), /COOKIE_FUSE_STATE_MISMATCH/);
  assert.equal(launched, 0);

  const signatureFixture = await pairFixture(t);
  await assert.rejects(runCookieFusePair({ pairRoot: signatureFixture.root, output: signatureFixture.output, modes: ['https'], repeat: 1 }, {
    platform: 'darwin', inspectBundle: signatureFixture.inspectBundle,
    verifySignature: async () => { throw Object.assign(new Error('invalid signature'), { code: 'SIGNATURE_INVALID' }); },
    startRawTlsSink: async () => assert.fail('sink must not start'), runChild: async () => { launched += 1; }
  }), /invalid signature/);
  assert.equal(launched, 0);
});

test('unconfirmed close and runner failure stop the remaining schedule with normalized attempt evidence', { skip: process.platform === 'win32' ? 'macOS-only runner requires POSIX ownership and 0700 modes' : false }, async (t) => {
  const fixture = await pairFixture(t);
  let calls = 0;
  const report = await runCookieFusePair({ pairRoot: fixture.root, output: fixture.output, modes: ['https', 'wss'], repeat: 1 }, {
    platform: 'darwin', inspectBundle: fixture.inspectBundle, verifySignature: async () => {},
    startRawTlsSink: async () => fixture.sink,
    runChild: async () => { calls += 1; return cleanRun({ closed: false, forced: true, signal: 'SIGKILL' }); }
  });
  assert.equal(calls, 1);
  assert.equal(report.stoppedReason, 'OWNED_PROCESS_CLOSE_UNCONFIRMED');
  assert.equal(report.summary.matrixComplete, false);
  assert.deepEqual(report.lastAttempted.arm, 'control');

  const thrownFixture = await pairFixture(t);
  const thrown = await runCookieFusePair({ pairRoot: thrownFixture.root, output: thrownFixture.output, modes: ['https'], repeat: 1 }, {
    platform: 'darwin', inspectBundle: thrownFixture.inspectBundle, verifySignature: async () => {},
    startRawTlsSink: async () => thrownFixture.sink,
    runChild: async () => { throw Object.assign(new Error('fixture'), { code: 'FIXTURE_FAILED' }); }
  });
  assert.equal(thrown.stoppedReason, 'RUNNER_FAILED:FIXTURE_FAILED');
  assert.equal(thrown.runs[0].closureUncertain, true);
  assert.equal(thrown.runs[0].closed, false);
});

test('schedule alternates pair order within every mode while preserving matched run numbers', () => {
  assert.deepEqual(buildPairSchedule(['https', 'wss'], 2), [
    { mode: 'https', run: 1, arm: 'control' },
    { mode: 'https', run: 1, arm: 'cookie-encrypted' },
    { mode: 'https', run: 2, arm: 'cookie-encrypted' },
    { mode: 'https', run: 2, arm: 'control' },
    { mode: 'wss', run: 1, arm: 'control' },
    { mode: 'wss', run: 1, arm: 'cookie-encrypted' },
    { mode: 'wss', run: 2, arm: 'cookie-encrypted' },
    { mode: 'wss', run: 2, arm: 'control' }
  ]);
});

function wire(cookie, runAsNode = FuseState.DISABLE) {
  return { version: '1', [FuseV1Options.RunAsNode]: runAsNode, [FuseV1Options.EnableCookieEncryption]: cookie, [FuseV1Options.WasmTrapHandlers]: FuseState.ENABLE };
}

test('fuse validation permits only the intended disabled-to-enabled cookie difference', () => {
  const original = wire(FuseState.DISABLE);
  const control = wire(FuseState.DISABLE);
  const encrypted = wire(FuseState.ENABLE);
  assert.deepEqual(validateFusePair(original, control, encrypted), { valid: true, reason: null });
  assert.equal(validateFusePair(wire(FuseState.ENABLE), control, encrypted).reason, 'COOKIE_FUSE_STATE_MISMATCH');
  assert.equal(validateFusePair(original, wire(FuseState.DISABLE, FuseState.ENABLE), encrypted).reason, 'NON_COOKIE_FUSE_MISMATCH');
  assert.equal(validateFusePair(original, control, { ...encrypted, version: '2' }).reason, 'FUSE_VERSION_MISMATCH');
});

function cleanRun(overrides = {}) {
  return {
    ready: true, loadCompleted: true, markerCount: 1, operationCompleted: true, outcome: 'rejected',
    closed: true, code: 0, signal: null, forced: false, spawnError: null, killError: null,
    networkExpectationMet: true, diagnostics: { recognizedCount: 0 }, outputTruncated: false,
    rawTlsObservationOverflow: false, ...overrides
  };
}

test('pair summary separates completion, clean exit and passing network evidence', () => {
  const identities = buildPairSchedule(['https'], 1);
  const runs = identities.map((item) => ({ ...cleanRun(), ...item }));
  const base = { config: { modes: ['https'], repeat: 1 }, stoppedReason: null, runs };
  assert.deepEqual(classifyPairReport(base), { matrixComplete: true, experimentsCompleted: 2, cleanExits: 2, expectedRawTlsActivity: 2, passing: true });
  assert.deepEqual(classifyPairReport({ ...base, runs: [runs[0], { ...runs[1], networkExpectationMet: false }] }), { matrixComplete: true, experimentsCompleted: 2, cleanExits: 2, expectedRawTlsActivity: 1, passing: false });
  assert.deepEqual(classifyPairReport({ ...base, stoppedReason: 'OWNED_PROCESS_CLOSE_UNCONFIRMED', runs: [runs[0], { ...runs[1], closed: false }] }), { matrixComplete: false, experimentsCompleted: 1, cleanExits: 1, expectedRawTlsActivity: 2, passing: false });
  assert.equal(classifyPairReport({ ...base, runs: [runs[0]] }).matrixComplete, false);
  const timed = classifyPairReport({ ...base, runs: [runs[0], { ...runs[1], outcome: 'bounded-timeout' }] });
  assert.equal(timed.matrixComplete, true);
  assert.equal(timed.experimentsCompleted, 1);
  assert.equal(timed.passing, false);
  const missing = classifyPairReport({ ...base, runs: [runs[0], { ...runs[1], markerCount: 0, operationCompleted: false }] });
  assert.equal(missing.matrixComplete, true);
  assert.equal(missing.experimentsCompleted, 1);
  assert.equal(missing.passing, false);
  const forced = classifyPairReport({ ...base, runs: [runs[0], { ...runs[1], forced: true, signal: 'SIGKILL', code: null }] });
  assert.equal(forced.matrixComplete, true);
  assert.equal(forced.cleanExits, 1);
  assert.equal(forced.passing, false);
  assert.equal(classifyPairReport({ config: { modes: [], repeat: 0 }, stoppedReason: null, runs: [] }).matrixComplete, false);
});
