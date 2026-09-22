import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertMacDistributionEnvironment,
  createPackagingPlan,
  expectedWindowsPublisher,
  inspectPackagingArguments,
  inspectNotarizationEnvironment,
  linuxReleaseMetadata,
  targetsWindowsDistribution,
  targetsMacDistribution
} from '../scripts/release-policy.mjs';

const developerIdentity = {
  status: 0,
  stdout: '1) ABCDEF1234 "Developer ID Application: Example Publisher (TEAM123456)"'
};

test('macOS distribution target detection distinguishes native and cross-platform builds', () => {
  assert.equal(targetsMacDistribution([], 'darwin'), true);
  assert.equal(targetsMacDistribution(['--dir'], 'darwin'), true);
  assert.equal(targetsMacDistribution(['--mac=zip'], 'linux'), true);
  assert.equal(targetsMacDistribution(['--win'], 'darwin'), false);
  assert.equal(targetsMacDistribution(['--linux'], 'darwin'), false);
  for (const argument of ['-m', '-o', '--macos', '--macos=zip', '-m=zip', '-mwl', '-wo']) {
    assert.equal(targetsMacDistribution([argument], 'linux'), true, argument);
  }
  for (const argument of ['-w', '--windows', '-l', '-wl']) {
    assert.equal(targetsMacDistribution([argument], 'darwin'), false, argument);
  }
});

test('Windows distribution aliases enforce signing, including cross-platform invocations', () => {
  for (const args of [[], ['--win'], ['--windows=portable'], ['-w'], ['-wl']]) {
    assert.equal(targetsWindowsDistribution(args, 'win32'), true);
    assert.throws(() => createPackagingPlan(args, {}, { platform: 'win32' }), /require WIN_CSC_LINK/);
  }
  assert.equal(targetsWindowsDistribution(['--linux'], 'win32'), false);
  for (const env of [{ WIN_CSC_LINK: 'test-certificate' }, { CSC_LINK: 'test-certificate' }]) {
    assert.throws(() => createPackagingPlan(['--win'], env, { platform: 'linux' }), /EXPECTED_WINDOWS_PUBLISHER/);
    const plan = createPackagingPlan(['--win', 'nsis', 'portable', 'zip', '--arm64'],
      { ...env, SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: '  Fixture Publisher, Inc.  ' }, { platform: 'linux' });
    assert.ok(plan.args.includes('--config.forceCodeSigning=true'));
    assert.ok(plan.args.includes('--config.win.signtoolOptions.publisherName=Fixture Publisher, Inc.'));
    assert.equal(plan.environment.SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER, 'Fixture Publisher, Inc.');
    assert.ok(plan.args.includes('--publish=never'));
    assert.ok(plan.args.includes('--config.afterPack=scripts/after-pack.cjs'));
  }
  assert.equal(createPackagingPlan(['--unsigned', '--dir'], {}, { platform: 'win32' }).environment.SATOSHI_BROWSER_UNSIGNED_BUILD, '1');
});

test('Windows publisher identity must be an explicit, bounded certificate name, never a guessed brand default', () => {
  for (const value of [undefined, null, 17, [], '', '   ', 'x'.repeat(257), 'Publisher\nOther', 'Publisher\0Other', 'Publisher\u007f']) {
    assert.throws(() => expectedWindowsPublisher({ SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: value }), /exact certificate publisher name/);
  }
  assert.equal(expectedWindowsPublisher({ SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: 'Éditeur & Company, Inc.' }), 'Éditeur & Company, Inc.');
  assert.doesNotThrow(() => createPackagingPlan(['--unsigned', '--dir', '--win'], {}, { platform: 'darwin' }));
  assert.doesNotThrow(() => createPackagingPlan(['--linux'], {}, { platform: 'linux' }));
});

test('Linux packaging contact is explicit and cannot smuggle metadata overrides', () => {
  assert.deepEqual(linuxReleaseMetadata({}), []);
  const env = { SATOSHI_BROWSER_RELEASE_HOMEPAGE: 'https://github.com/example/browser',
    SATOSHI_BROWSER_LINUX_MAINTAINER: 'Test Publisher <publisher@example.test>' };
  const plan = createPackagingPlan(['--linux', 'AppImage', 'deb', 'rpm', 'tar.gz', '--arm64'], env, { platform: 'linux' });
  assert.ok(plan.args.includes('--config.linux.maintainer=Test Publisher <publisher@example.test>'));
  assert.ok(plan.args.includes('--config.extraMetadata.homepage=https://github.com/example/browser'));
  for (const homepage of ['http://github.com/example/browser', 'https://user:secret@example.test', 'https://example.test/#override', 'not-a-url']) {
    assert.throws(() => linuxReleaseMetadata({ ...env, SATOSHI_BROWSER_RELEASE_HOMEPAGE: homepage }), /HTTPS project homepage/);
  }
  for (const maintainer of ['', 'not a contact', 'Contact <a@b.test>\n--config.afterPack=null']) {
    assert.throws(() => linuxReleaseMetadata({ ...env, SATOSHI_BROWSER_LINUX_MAINTAINER: maintainer }), /real publisher contact/);
  }
});

test('release policy accepts each complete notarization credential strategy', () => {
  assert.deepEqual(inspectNotarizationEnvironment({
    APPLE_ID: 'publisher@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret',
    APPLE_TEAM_ID: 'TEAM123456'
  }), { mode: 'apple-id', expectedTeamId: 'TEAM123456' });

  assert.deepEqual(inspectNotarizationEnvironment({
    APPLE_API_KEY: '/secure/AuthKey_TEST.p8',
    APPLE_API_KEY_ID: 'KEY1234567',
    APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    SATOSHI_BROWSER_EXPECTED_TEAM_ID: 'TEAM123456'
  }), { mode: 'api-key', expectedTeamId: 'TEAM123456' });

  assert.deepEqual(inspectNotarizationEnvironment({
    APPLE_KEYCHAIN_PROFILE: 'satoshi-browser-notary',
    SATOSHI_BROWSER_EXPECTED_TEAM_ID: 'TEAM123456'
  }), { mode: 'keychain-profile', expectedTeamId: 'TEAM123456' });
});

test('release policy rejects absent, partial, and ambiguous keychain notarization credentials', () => {
  assert.throws(() => inspectNotarizationEnvironment({}), /require notarization credentials/);
  assert.throws(() => inspectNotarizationEnvironment({ APPLE_ID: 'publisher@example.test' }), /APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/);
  assert.throws(() => inspectNotarizationEnvironment({ APPLE_API_KEY: '/key.p8', APPLE_API_KEY_ID: 'KEY1234567' }), /APPLE_API_ISSUER/);
  assert.throws(() => inspectNotarizationEnvironment({ APPLE_KEYCHAIN: '/tmp/keychain' }), /APPLE_KEYCHAIN_PROFILE/);
  assert.throws(() => inspectNotarizationEnvironment({ APPLE_KEYCHAIN_PROFILE: 'profile' }), /EXPECTED_TEAM_ID/);
});

test('macOS distribution requires a Developer ID identity and a valid expected Team ID', () => {
  const notarization = {
    APPLE_ID: 'publisher@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret',
    APPLE_TEAM_ID: 'TEAM123456'
  };
  assert.throws(() => assertMacDistributionEnvironment(notarization, { status: 0, stdout: '0 valid identities found' }), /Developer ID Application/);
  assert.deepEqual(assertMacDistributionEnvironment(notarization, developerIdentity), { mode: 'apple-id', expectedTeamId: 'TEAM123456' });
  assert.deepEqual(assertMacDistributionEnvironment({ ...notarization, CSC_LINK: '/certificate.p12' }, null), { mode: 'apple-id', expectedTeamId: 'TEAM123456' });
  assert.throws(() => assertMacDistributionEnvironment({ ...notarization, APPLE_TEAM_ID: 'lowercase' }, developerIdentity), /10 uppercase/);
});

test('alternate notarization credentials allow team metadata but reject contradictory publisher IDs', () => {
  assert.deepEqual(inspectNotarizationEnvironment({
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEYCHAIN_PROFILE: 'profile',
    SATOSHI_BROWSER_EXPECTED_TEAM_ID: 'TEAM123456'
  }), { mode: 'keychain-profile', expectedTeamId: 'TEAM123456' });
  assert.throws(() => inspectNotarizationEnvironment({
    APPLE_ID: 'publisher@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'secret',
    APPLE_TEAM_ID: 'TEAM123456', SATOSHI_BROWSER_EXPECTED_TEAM_ID: 'TEAM999999'
  }), /conflicts/);
});

test('packaging arguments cannot replace hooks, bypass signing, repackage, or publish', () => {
  for (const input of [
    ['--config', 'other.json'], ['-c.afterSign=null'], ['--config.mac.notarize=false'],
    ['--config.forceCodeSigning=false'], ['--prepackaged=/tmp/unverified'], ['--pd', '/tmp/unverified'],
    ['--projectDir=/tmp/other'], ['--publish=always'], ['--mac', 'mas'], ['--mac=']
  ]) assert.throws(() => inspectPackagingArguments(input), /Unsupported packaging/, input.join(' '));
  assert.deepEqual(inspectPackagingArguments(['--mac', 'dmg', 'zip', '--arm64']), {
    unsigned: false, unsignedWindowsBeta: false, unsignedMacosBeta: false, args: ['--mac', 'dmg', 'zip', '--arm64']
  });
});

test('unsigned Windows beta is an explicit Windows-only distribution option, never a platform signing fallback', () => {
  for (const args of [[], ['--mac'], ['--linux'], ['--win', '--mac'], ['-wl'], ['-mw'], ['--dir', '--win'],
    ['--win', '--unsigned'], ['--win', '--ia32'], ['--win', '--armv7l'], ['--win', '--universal'], ['--win', 'dmg']]) {
    assert.throws(() => inspectPackagingArguments([...args, '--unsigned-windows-beta']), /Unsigned Windows beta|Unsigned developer/);
  }
  for (const argument of ['--win', '--windows', '-w']) {
    const parsed = inspectPackagingArguments([argument, 'nsis', 'portable', 'zip', '--x64', '--unsigned-windows-beta']);
    assert.equal(parsed.unsigned, false);
    assert.equal(parsed.unsignedWindowsBeta, true);
    assert.ok(!parsed.args.includes('--unsigned-windows-beta'));
  }
  assert.throws(() => createPackagingPlan(['--win'], { SATOSHI_BROWSER_UNSIGNED_WINDOWS_BETA: '1' }, { platform: 'win32' }), /require WIN_CSC_LINK/);
  const signed = createPackagingPlan(['--win'], { WIN_CSC_LINK: 'FIXTURE', SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: 'Fixture',
    SATOSHI_BROWSER_UNSIGNED_WINDOWS_BETA: '1' }, { platform: 'win32' });
  assert.equal(signed.environment.SATOSHI_BROWSER_UNSIGNED_WINDOWS_BETA, '0');
  assert.ok(signed.args.includes('--config.forceCodeSigning=true'));
});

test('unsigned Windows beta rejects stable versions and embedded signing configuration before consuming any identity', () => {
  const args = ['--win', '--unsigned-windows-beta'];
  for (const version of [undefined, '1.0.0', '1.0.0-alpha.1', '01.0.0-rc.1', '1.0.0-rc.1\n']) {
    assert.throws(() => createPackagingPlan(args, {}, { packageMetadata: { version } }), /existing early-beta tag/);
  }
  for (const build of [{ cscLink: 'FIXTURE' }, { extends: './other-config.js' }, { win: { cscLink: 'FIXTURE' } },
    { win: { azureSignOptions: {} } }, ...['certificateFile', 'certificateSubjectName', 'certificateSha1', 'sign', 'publisherName']
      .map((key) => ({ win: { signtoolOptions: { [key]: 'FIXTURE' } } }))]) {
    assert.throws(() => createPackagingPlan(args, {}, { packageMetadata: { version: '1.0.0-rc.2', build } }), /embedded signing configuration/);
  }
});

test('unsigned Windows beta strips signing credentials, labels every download, isolates output, and retains packaging protections', () => {
  const environment = Object.fromEntries(['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
    'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_KEYCHAIN_PROFILE', 'APPLE_API_KEY', 'AZURE_CLIENT_SECRET', 'AZURE_FEDERATED_TOKEN_FILE',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER'].map((key) => [key, 'FIXTURE']));
  const plan = createPackagingPlan(['--win', 'nsis', 'portable', 'zip', '--arm64', '--unsigned-windows-beta'], environment,
    { platform: 'darwin', packageMetadata: { version: '1.0.0-rc.2' } });
  for (const key of Object.keys(environment)) {
    assert.equal(key in plan.environment, false, key);
    assert.equal(environment[key], 'FIXTURE', 'must not mutate the parent environment');
  }
  assert.equal(plan.environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(plan.environment.SATOSHI_BROWSER_UNSIGNED_WINDOWS_BETA, '1');
  assert.equal(plan.environment.SATOSHI_BROWSER_UNSIGNED_BUILD, '0', 'distribution must not masquerade as the developer directory mode');
  for (const arg of ['--config.directories.output=release/unsigned-windows-beta', '--config.forceCodeSigning=false',
    '--config.win.signAndEditExecutable=true', '--config.win.signExecutable=false', '--config.extraMetadata.betaWindowsSigning=unsigned-beta',
    '--config.win.artifactName=bitcoin-browser-${version}-windows-${arch}-unsigned.${ext}',
    '--config.nsis.artifactName=bitcoin-browser-${version}-windows-${arch}-unsigned-setup.${ext}',
    '--config.portable.artifactName=bitcoin-browser-${version}-windows-${arch}-unsigned-portable.${ext}',
    '--config.afterPack=scripts/after-pack.cjs', '--config.afterSign=scripts/after-sign.cjs', '--publish=never']) assert.ok(plan.args.includes(arg), arg);
  assert.ok(!plan.args.some((arg) => arg.includes('mac.identity')));
});

test('unsigned packaging is directory-only, credential-free, and isolated from release artifacts', () => {
  for (const input of [['--unsigned'], ['--unsigned', '--mac'], ['--unsigned', '--dir', '--mac=zip']]) {
    assert.throws(() => inspectPackagingArguments(input), /require --dir/);
  }
  const original = { CSC_LINK: 'certificate', CSC_KEY_PASSWORD: 'secret', CSC_NAME: 'identity',
    WIN_CSC_LINK: 'certificate', WIN_CSC_KEY_PASSWORD: 'secret', APPLE_ID: 'user',
    APPLE_KEYCHAIN_PROFILE: 'profile', SATOSHI_BROWSER_REQUIRE_NOTARIZATION: '1' };
  const plan = createPackagingPlan(['--unsigned', '--dir'], original, { platform: 'darwin' });
  assert.equal(plan.environment.SATOSHI_BROWSER_UNSIGNED_BUILD, '1');
  assert.equal(plan.environment.SATOSHI_BROWSER_REQUIRE_NOTARIZATION, '0');
  assert.equal(plan.environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN_PROFILE']) {
    assert.equal(key in plan.environment, false, key);
    assert.ok(original[key], 'caller environment must not be mutated');
  }
  assert.ok(plan.args.includes('--config.directories.output=release/developer'));
  assert.ok(plan.args.includes('--publish=never'));
});

test('signed packaging clears inherited unsigned markers and forces signing plus verification hooks', () => {
  const env = { CSC_NAME: 'Example Publisher', APPLE_KEYCHAIN_PROFILE: 'profile',
    SATOSHI_BROWSER_EXPECTED_TEAM_ID: 'TEAM123456', SATOSHI_BROWSER_UNSIGNED_BUILD: '1' };
  const plan = createPackagingPlan(['-m', 'zip'], env, { platform: 'linux' });
  assert.equal(plan.environment.SATOSHI_BROWSER_UNSIGNED_BUILD, '0');
  assert.equal(plan.environment.SATOSHI_BROWSER_REQUIRE_NOTARIZATION, '1');
  for (const argument of ['--config.forceCodeSigning=true', '--config.mac.hardenedRuntime=true',
    '--config.mac.notarize=true', '--config.afterPack=scripts/after-pack.cjs',
    '--config.afterSign=scripts/after-sign.cjs', '--publish=never']) assert.ok(plan.args.includes(argument));
  assert.throws(() => createPackagingPlan(['-m'], { CSC_NAME: 'Publisher' }, { platform: 'linux' }), /require notarization/);
});

test('real wrapper exits before builder for missing credentials and disallowed distribution overrides', () => {
  for (const args of [['--mac'], ['--macos'], ['-m'], ['-mwl'], ['--unsigned', '--mac'], ['--config.afterSign=null']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), ...args], {
      encoding: 'utf8', timeout: 5_000,
      // Deliberately do not inherit signing material or read a keychain in this
      // negative test. A dummy selector reaches the missing-notary gate only.
      env: { CSC_NAME: 'RELEASE_POLICY_TEST_ONLY', SATOSHI_BROWSER_UNSIGNED_BUILD: '1' }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /require notarization credentials|Unsigned developer builds require --dir|Unsupported packaging argument/);
    assert.doesNotMatch(result.stdout + result.stderr, /electron-builder\s+version=|packaging\s+platform=/);
  }
});

test('real Windows wrapper rejects a certificate without an expected publisher before invoking builder', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/package.mjs', import.meta.url)), '--win'], {
    encoding: 'utf8', timeout: 5_000, env: { WIN_CSC_LINK: 'RELEASE_POLICY_TEST_ONLY' }
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EXPECTED_WINDOWS_PUBLISHER/);
  assert.doesNotMatch(result.stdout + result.stderr, /electron-builder\s+version=|packaging\s+platform=/);
});
