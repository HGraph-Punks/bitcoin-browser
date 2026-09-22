import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createPackagingPlan, inspectPackagingArguments } from '../scripts/release-policy.mjs';
import { BETA_TARGETS, expectedAssets, validateBetaTag, renderBetaReleaseNotes } from '../scripts/beta-release.mjs';
import { packagedArtifactDirectory } from '../scripts/packaged-executable.mjs';

test('the explicitly approved v0.1.0 beta is accepted without authorizing arbitrary stable releases', () => {
  assert.equal(validateBetaTag('v0.1.0', '0.1.0'), 'v0.1.0');
  for (const tag of ['v0.1.1', 'v1.0.0', 'v0.1.0\n', 'v00.1.0']) assert.throws(() => validateBetaTag(tag));
});

test('unsigned Mac beta is explicit, isolated, credential-free and preserves packaging hooks', () => {
  const environment = { CSC_LINK: 'FIXTURE', APPLE_KEYCHAIN_PROFILE: 'FIXTURE', WIN_CSC_LINK: 'FIXTURE', SATOSHI_BROWSER_EXPECTED_TEAM_ID: 'FIXTURE' };
  const plan = createPackagingPlan(['--mac', 'dmg', 'zip', '--arm64', '--unsigned-macos-beta'], environment,
    { platform: 'darwin', packageMetadata: { version: '0.1.0' } });
  for (const key of Object.keys(environment)) assert.equal(plan.environment[key], undefined);
  assert.equal(plan.environment.SATOSHI_BROWSER_UNSIGNED_MACOS_BETA, '1');
  assert.equal(plan.environment.SATOSHI_BROWSER_UNSIGNED_BUILD, '0');
  assert.equal(plan.environment.SATOSHI_BROWSER_REQUIRE_NOTARIZATION, '0');
  for (const argument of ['--publish=never', '--config.mac.identity=null', '--config.mac.notarize=false',
    '--config.directories.output=release/unsigned-macos-beta', '--config.afterPack=scripts/after-pack.cjs', '--config.afterSign=scripts/after-sign.cjs']) {
    assert.ok(plan.args.includes(argument), argument);
  }
  assert.throws(() => createPackagingPlan(['--mac'], { SATOSHI_BROWSER_UNSIGNED_MACOS_BETA: '1' }, { platform: 'darwin' }), /Developer ID/);
});

test('unsigned Mac distribution rejects mixed modes, non-beta versions and embedded signing configuration', () => {
  for (const args of [[], ['--win'], ['--linux'], ['--mac', '--win'], ['--mac', '--dir'], ['--mac', '--unsigned'],
    ['--mac', '--unsigned-windows-beta'], ['--mac', '--universal'], ['--mac', 'nsis']]) {
    assert.throws(() => inspectPackagingArguments([...args, '--unsigned-macos-beta']));
  }
  for (const build of [{ cscLink: 'FIXTURE' }, { mac: { identity: 'FIXTURE' } }, { mac: { notarize: true } }]) {
    assert.throws(() => createPackagingPlan(['--mac', '--unsigned-macos-beta'], {}, { packageMetadata: { version: '0.1.0', build } }), /embedded signing/);
  }
  assert.throws(() => createPackagingPlan(['--mac', '--unsigned-macos-beta'], {}, { packageMetadata: { version: '1.0.0' } }), /early-beta tag/);
});

test('all eighteen beta downloads are unique and every unsigned Mac and Windows format is labeled', () => {
  const names = expectedAssets('0.1.0', BETA_TARGETS, 'unsigned-beta', 'unsigned-beta');
  assert.equal(names.length, 18); assert.equal(new Set(names).size, 18);
  assert.equal(names.filter(name => name.includes('-unsigned')).length, 10);
  assert.ok(names.includes('bitcoin-browser-0.1.0-macos-arm64-unsigned.dmg'));
  assert.ok(names.includes('bitcoin-browser-0.1.0-macos-x64-unsigned.zip'));
  assert.equal(packagedArtifactDirectory('/release', { platform: 'darwin', distribution: true, unsignedMacosBeta: true }), path.join('/release', 'unsigned-macos-beta'));
  assert.throws(() => packagedArtifactDirectory('/release', { platform: 'darwin', unsignedMacosBeta: true }), /requires --distribution/);
  assert.throws(() => packagedArtifactDirectory('/release', { platform: 'win32', distribution: true, unsignedMacosBeta: true }), /native macOS/);
});

test('release notes identify unsigned macOS independently of Windows signing', () => {
  const assets = expectedAssets('0.1.0', BETA_TARGETS, 'unsigned-beta', 'unsigned-beta');
  const notes = renderBetaReleaseNotes('Beta overview', assets, 'all', 'unsigned-beta', 'unsigned-beta');
  assert.match(notes, /macOS: UNSIGNED BETA/);
  assert.match(notes, /Windows: UNSIGNED BETA/);
  assert.doesNotMatch(notes, /Developer ID-signed and notarized application/);
});
