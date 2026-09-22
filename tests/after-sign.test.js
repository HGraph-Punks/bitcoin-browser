import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../scripts/after-sign.cjs', import.meta.url), 'utf8');
const metadata = 'CodeDirectory v=20500 size=500 flags=0x10000(runtime) hashes=12+7\nAuthority=Developer ID Application: Example (TEAM123456)\nTimestamp=Sep 4, 2026 at 12:00:00\nTeamIdentifier=TEAM123456\n';
const context = { electronPlatformName: 'darwin', appOutDir: '/tmp/release with spaces', packager: { appInfo: { productFilename: 'Bitcoin Browser' } } };

function harness({ environment = {}, failAt = -1, signature = metadata, spawnError = false } = {}) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    console: { log() {} },
    process: { env: { SATOSHI_BROWSER_REQUIRE_NOTARIZATION: '1', SATOSHI_BROWSER_EXPECTED_TEAM_ID: 'TEAM123456', ...environment } },
    require(specifier) {
      if (specifier === 'node:path') return path;
      assert.equal(specifier, 'node:child_process');
      return { spawnSync(executable, args, options) {
        calls.push({ executable, args: Array.from(args), options });
        if (calls.length - 1 === failAt) return spawnError
          ? { status: null, error: new Error('ETIMEDOUT') }
          : { status: 1, stdout: '', stderr: 'verification rejected' };
        return { status: 0, stdout: '', stderr: args[0] === '-dvvv' ? signature : '' };
      } };
    }
  }, { filename: 'after-sign.cjs' });
  return { run: module.exports, calls };
}

test('after-sign verifies publisher, runtime, timestamp, ticket, and Gatekeeper in order', async () => {
  const { run, calls } = harness();
  await run(context);
  assert.deepEqual(calls.map(({ executable }) => executable), [
    '/usr/bin/codesign', '/usr/bin/codesign', '/usr/bin/xcrun', '/usr/bin/xcrun', '/usr/sbin/spctl'
  ]);
  assert.deepEqual(calls[0].args.slice(0, -1), ['--verify', '--deep', '--strict', '--verbose=2']);
  assert.deepEqual(calls[2].args.slice(0, -1), ['stapler', 'staple']);
  assert.deepEqual(calls[3].args.slice(0, -1), ['stapler', 'validate']);
  for (const call of calls) {
    assert.equal(call.args.at(-1), path.join(context.appOutDir, 'Bitcoin Browser.app'));
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 60_000);
  }
});

test('after-sign stops immediately at every command failure including timeout', async () => {
  for (const spawnError of [false, true]) {
    for (let failAt = 0; failAt < 5; failAt += 1) {
      const { run, calls } = harness({ failAt, spawnError });
      await assert.rejects(run(context), /verification rejected|ETIMEDOUT/);
      assert.equal(calls.length, failAt + 1);
    }
  }
});

test('after-sign refuses missing policy, wrong team, development identity, runtime, and timestamp', async () => {
  const noPolicy = harness({ environment: { SATOSHI_BROWSER_REQUIRE_NOTARIZATION: '0' } });
  await assert.rejects(noPolicy.run(context), /must run through/);
  assert.equal(noPolicy.calls.length, 0);
  for (const [signature, expected] of [
    [metadata.replace('TeamIdentifier=TEAM123456', 'TeamIdentifier=TEAM999999'), /mismatch/],
    [metadata.replace('TeamIdentifier=TEAM123456', 'TeamIdentifier=not set'), /mismatch/],
    [metadata.replace('Developer ID Application:', 'Apple Development:'), /Developer ID Application/],
    [metadata.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), /hardened runtime/],
    [metadata.replace('Timestamp=', 'Signed Time='), /secure signing timestamp/]
  ]) {
    const { run, calls } = harness({ signature });
    await assert.rejects(run(context), expected);
    assert.equal(calls.length, 2, 'must not staple or assess an ineligible signature');
  }
});

test('after-sign performs no Apple operations for explicit developer or non-macOS output', async () => {
  const developer = harness({ environment: { SATOSHI_BROWSER_UNSIGNED_BUILD: '1' } });
  await developer.run(context);
  assert.equal(developer.calls.length, 0);
  const linux = harness();
  await linux.run({ ...context, electronPlatformName: 'linux' });
  assert.equal(linux.calls.length, 0);
});
