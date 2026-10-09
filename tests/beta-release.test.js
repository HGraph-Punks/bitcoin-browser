import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BETA_TARGETS, validateBetaTag, selectedTargets, requireNativeTarget, expectedAssets,
  stageAssets, validateAssets, draftReleaseArguments, validateWindowsSigning, renderBetaReleaseNotes, UNSIGNED_WINDOWS_DIRECTORY } from '../scripts/beta-release.mjs';
import { packagedExecutableCandidates, findPackagedExecutable, packagedArtifactDirectory } from '../scripts/packaged-executable.mjs';

const version = '1.0.0-rc.1';
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-beta-release-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('release tags must be exact early-beta versions, never branches or shell input', () => {
  for (const tag of ['v1.0.0-rc.1', 'v2.3.4-beta.0']) assert.equal(validateBetaTag(tag, tag.slice(1)), tag);
  for (const tag of ['', 'master', 'v1.0.0', 'v01.0.0-rc.1', 'v1.0.0-rc.01', 'v1.0.0-rc.1\n', 'v1.0.0-rc.1; echo bad', '../v1.0.0-rc.1']) {
    assert.throws(() => validateBetaTag(tag), /existing early-beta tag/);
  }
  assert.throws(() => validateBetaTag('v1.0.0-rc.2', version), /Version mismatch/);
});

test('six native release targets cover both architectures and reject emulated qualification', () => {
  assert.equal(BETA_TARGETS.length, 6);
  assert.equal(new Set(BETA_TARGETS.map(({ runner }) => runner)).size, 6);
  for (const target of BETA_TARGETS) {
    assert.equal(requireNativeTarget(target.id, target.platform, target.arch), target);
    assert.throws(() => requireNativeTarget(target.id, target.platform, target.arch === 'x64' ? 'arm64' : 'x64'), /must run natively/);
    assert.equal(selectedTargets(target.id.split('-')[0]).length, 2);
  }
  assert.throws(() => selectedTargets('all; bad'), /Platforms must be/);
  assert.throws(() => requireNativeTarget('../unknown'), /must run natively/);
});

test('download filenames cannot collide across architectures, operating systems, or Windows targets', () => {
  const names = expectedAssets(version);
  assert.equal(names.length, 18);
  assert.equal(new Set(names).size, 18);
  assert.ok(names.includes('bitcoin-browser-1.0.0-rc.1-windows-arm64-setup.exe'));
  assert.ok(names.includes('bitcoin-browser-1.0.0-rc.1-windows-arm64-portable.exe'));
  for (const suffix of ['aarch64.rpm', 'amd64.deb', 'x86_64.AppImage', 'x86_64.rpm', 'x64.tar.gz', 'arm64.deb']) {
    assert.ok(names.includes(`bitcoin-browser-1.0.0-rc.1-linux-${suffix}`), suffix);
  }
  assert.ok(names.every((name) => !/checksum|sha256|blockmap|\.yml$/.test(name)));
  assert.throws(() => expectedAssets('../1.0.0-rc.1'), /existing early-beta tag/);
});

test('asset staging excludes logs, profiles, updater metadata, and unrelated stale files', async (t) => {
  const directory = await temporary(t);
  const target = BETA_TARGETS[0];
  const expected = expectedAssets(version, [target]);
  for (const name of [...expected, 'packaged-smoke-report.json', 'latest.yml', 'old-release.zip']) await fs.writeFile(path.join(directory, name), 'fixture');
  await fs.mkdir(path.join(directory, 'profile'));
  assert.deepEqual(await stageAssets(directory, version, target.id), expected);
  assert.deepEqual((await fs.readdir(path.join(directory, 'beta-assets', target.id))).sort(), expected);
  await assert.rejects(stageAssets(directory, version, target.id), /EEXIST/);
});

test('incomplete, empty, directory, or symlink assets fail before staging', async (t) => {
  const directory = await temporary(t);
  const target = BETA_TARGETS[0];
  const names = expectedAssets(version, [target]);
  await assert.rejects(stageAssets(directory, version, target.id), /ENOENT/);
  await fs.writeFile(path.join(directory, names[0]), '');
  await assert.rejects(stageAssets(directory, version, target.id), /nonempty regular file/);
  await fs.writeFile(path.join(directory, names[0]), 'fixture');
  await fs.mkdir(path.join(directory, names[1]));
  await assert.rejects(stageAssets(directory, version, target.id), /nonempty regular file/);
  // Directory symlinks (junctions on Windows) don't require developer privileges.
  const other = await temporary(t);
  await fs.symlink(directory, path.join(other, names[0]), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageAssets(other, version, target.id), /nonempty regular file/);
});

test('final release validation requires the exact selected platform set', async (t) => {
  const directory = await temporary(t);
  const names = expectedAssets(version, selectedTargets('linux'));
  for (const name of names) await fs.writeFile(path.join(directory, name), 'fixture');
  assert.deepEqual(await validateAssets(directory, version, 'linux'), names);
  await assert.rejects(validateAssets(directory, version, 'all'), /missing:.*macos/);
  await fs.writeFile(path.join(directory, 'diagnostic.json'), 'private fixture');
  await assert.rejects(validateAssets(directory, version, 'linux'), /unexpected: diagnostic.json/);
});

test('draft command cannot publish, replace assets, or use a tag moved after testing', () => {
  const options = { repository: 'test-owner/browser', tag: `v${version}`, version,
    commit: 'a'.repeat(40), remoteCommit: 'a'.repeat(40), directory: '/tmp/validated', notes: '/tmp/notes.md', assets: expectedAssets(version) };
  const args = draftReleaseArguments(options);
  for (const flag of ['--draft', '--prerelease', '--verify-tag']) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(0, 3), ['release', 'create', `v${version}`]);
  assert.ok(!args.includes('--clobber'));
  assert.throws(() => draftReleaseArguments({ ...options, remoteCommit: 'b'.repeat(40) }), /tag changed/);
  assert.throws(() => draftReleaseArguments({ ...options, commit: undefined }), /tag changed/);
  assert.throws(() => draftReleaseArguments({ ...options, repository: '--repo bad' }), /Invalid GitHub/);
});

test('packaged executable lookup uses the exact native output directory on every target', async (t) => {
  const directory = await temporary(t);
  for (const target of BETA_TARGETS) {
    const candidates = packagedExecutableCandidates(directory, target.platform, target.arch);
    assert.ok(candidates[0].includes(target.arch === 'arm64' ? '-arm64' : target.platform === 'darwin' ? `${path.sep}mac${path.sep}` : '-unpacked'));
    await fs.mkdir(path.dirname(candidates[0]), { recursive: true });
    await fs.writeFile(candidates[0], 'fixture');
    assert.equal(await findPackagedExecutable(directory, target.platform, target.arch), candidates[0]);
  }
  const empty = await temporary(t);
  await assert.rejects(findPackagedExecutable(empty, 'linux', 'arm64'), /No native linux\/arm64/);
  assert.throws(() => packagedExecutableCandidates(empty, 'freebsd', 'x64'), /Unsupported packaged platform/);
});

test('Windows signing mode defaults to signed and rejects implicit or unknown exception values', () => {
  assert.equal(validateWindowsSigning(), 'signed');
  assert.equal(validateWindowsSigning('signed'), 'signed');
  assert.equal(validateWindowsSigning('unsigned-beta'), 'unsigned-beta');
  for (const value of ['', 'unsigned', 'auto', 'unsigned-beta\n', null, true, 1]) assert.throws(() => validateWindowsSigning(value), /Windows signing must be/);
  const signed = expectedAssets(version);
  const unsigned = expectedAssets(version, BETA_TARGETS, 'unsigned-beta');
  assert.equal(unsigned.length, 18);
  assert.equal(new Set(unsigned).size, 18);
  assert.equal(unsigned.filter((name) => name.includes('-unsigned')).length, 6);
  assert.deepEqual(unsigned.filter((name) => !name.includes('-windows-')), signed.filter((name) => !name.includes('-windows-')));
  assert.throws(() => expectedAssets('1.0.0', BETA_TARGETS, 'unsigned-beta'), /existing early-beta tag/);
});

test('smoke selects isolated unsigned Windows staging only with explicit native distribution options', async (t) => {
  const directory = await temporary(t);
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(packagedArtifactDirectory(directory, { platform }), path.join(directory, 'developer'));
    assert.equal(packagedArtifactDirectory(directory, { platform, distribution: true }), directory);
    assert.throws(() => packagedArtifactDirectory(directory, { platform, unsignedWindowsBeta: true }), /requires --distribution on native Windows/);
    if (platform !== 'win32') assert.throws(() => packagedArtifactDirectory(directory, { platform, distribution: true, unsignedWindowsBeta: true }), /native Windows/);
  }
  const isolated = packagedArtifactDirectory(directory, { platform: 'win32', distribution: true, unsignedWindowsBeta: true });
  assert.equal(isolated, path.join(directory, UNSIGNED_WINDOWS_DIRECTORY));
  // Even when both old root and developer executables exist, missing unsigned
  // output must fail instead of silently testing a different build.
  for (const parent of [directory, path.join(directory, 'developer')]) {
    const candidate = packagedExecutableCandidates(parent, 'win32', 'x64')[0];
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, 'wrong fixture');
  }
  await assert.rejects(findPackagedExecutable(isolated, 'win32', 'x64'), /No native win32\/x64/);
  const candidate = packagedExecutableCandidates(isolated, 'win32', 'x64')[0];
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, 'explicit unsigned fixture');
  assert.equal(await findPackagedExecutable(isolated, 'win32', 'x64'), candidate);
});

test('unsigned Windows staging reads only its isolated output and cannot reuse signed or misleading root artifacts', async (t) => {
  const directory = await temporary(t);
  const target = BETA_TARGETS.find((item) => item.id === 'windows-x64');
  const names = expectedAssets(version, [target], 'unsigned-beta');
  for (const name of [...names, ...expectedAssets(version, [target])]) await fs.writeFile(path.join(directory, name), 'wrong output fixture');
  await assert.rejects(stageAssets(directory, version, target.id, 'unsigned-beta'), /ENOENT/);
  const isolated = path.join(directory, UNSIGNED_WINDOWS_DIRECTORY);
  await fs.mkdir(isolated);
  for (const name of names) await fs.writeFile(path.join(isolated, name), 'explicit unsigned fixture');
  assert.deepEqual(await stageAssets(directory, version, target.id, 'unsigned-beta'), names);
  const staged = path.join(directory, 'beta-assets', target.id);
  assert.deepEqual((await fs.readdir(staged)).sort(), names);
  for (const name of names) assert.equal(await fs.readFile(path.join(staged, name), 'utf8'), 'explicit unsigned fixture');
  await assert.rejects(stageAssets(directory, version, target.id), /EEXIST/, 'must not overwrite an unsigned staging directory with signed assets');
});

test('draft inventory validation rejects mixing signed and unsigned Windows assets', async (t) => {
  const directory = await temporary(t);
  const names = expectedAssets(version, selectedTargets('windows'), 'unsigned-beta');
  for (const name of names) await fs.writeFile(path.join(directory, name), 'fixture');
  assert.deepEqual(await validateAssets(directory, version, 'windows', 'unsigned-beta'), names);
  await assert.rejects(validateAssets(directory, version, 'windows'), /Release asset set mismatch/);
  await fs.writeFile(path.join(directory, expectedAssets(version, selectedTargets('windows'))[0]), 'mixed mode fixture');
  await assert.rejects(validateAssets(directory, version, 'windows', 'unsigned-beta'), /unexpected:/);
});

test('unsigned Windows release notes and draft title prominently disclose the missing publisher without weakening other platforms', () => {
  const assets = expectedAssets(version, BETA_TARGETS, 'unsigned-beta');
  const notes = renderBetaReleaseNotes('Fixture overview', assets, 'all', 'unsigned-beta');
  assert.ok(notes.indexOf('UNSIGNED BETA') < notes.indexOf('Fixture overview'));
  assert.match(notes, /no verified publisher/);
  assert.match(notes, /do not disable antivirus or OS security protections/);
  assert.match(notes, /macOS: Developer ID-signed and notarized/);
  assert.match(notes, /Linux: package\/repository signatures are not provided/);
  assert.doesNotMatch(notes, /- Windows: timestamped Authenticode/);
  assert.ok(assets.every((name) => notes.includes(name)));
  const options = { repository: 'test-owner/browser', tag: `v${version}`, version,
    commit: 'a'.repeat(40), remoteCommit: 'a'.repeat(40), directory: '/tmp/validated', notes: '/tmp/notes.md', assets, windowsSigning: 'unsigned-beta' };
  const args = draftReleaseArguments(options);
  assert.ok(args.includes('--draft') && args.includes('--prerelease'));
  assert.match(args[args.indexOf('--title') + 1], /Windows unsigned/);
  const macAssets = expectedAssets(version, selectedTargets('macos'));
  const macNotes = renderBetaReleaseNotes('Fixture overview', macAssets, 'macos', 'unsigned-beta');
  assert.doesNotMatch(macNotes, /UNSIGNED BETA|Windows|Linux/);
  const macArgs = draftReleaseArguments({ ...options, assets: macAssets });
  assert.doesNotMatch(macArgs[macArgs.indexOf('--title') + 1], /Windows unsigned/);
  assert.match(renderBetaReleaseNotes('Fixture', expectedAssets(version), 'all'), /Windows: timestamped Authenticode/);
});

test('the real plan command binds a validated Windows signing choice to subsequent jobs before any build', async (t) => {
  const directory = await temporary(t);
  const current = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const script = fileURLToPath(new URL('../scripts/beta-release.mjs', import.meta.url));
  for (const mode of ['signed', 'unsigned-beta', 'unsigned', 'unsigned-beta\n']) {
    const output = path.join(directory, `output-${mode === 'signed' ? 'signed' : mode === 'unsigned-beta' ? 'unsigned-beta' : mode === 'unsigned' ? 'invalid' : 'newline'}`);
    const result = spawnSync(process.execPath, [script, 'plan'], { encoding: 'utf8', timeout: 5_000,
      env: { BETA_TAG: `v${current}`, BETA_COMMIT: 'a'.repeat(40), BETA_PLATFORMS: 'windows', BETA_WINDOWS_SIGNING: mode, GITHUB_OUTPUT: output } });
    if (['signed', 'unsigned-beta'].includes(mode)) {
      assert.equal(result.status, 0, result.stderr);
      const data = await fs.readFile(output, 'utf8');
      assert.ok(data.includes(`windows_signing=${mode}\n`));
      const matrix = JSON.parse(data.split('\n').find((line) => line.startsWith('matrix=')).slice(7));
      assert.deepEqual(matrix.include.map((item) => item.id), ['windows-x64', 'windows-arm64']);
    } else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Windows signing must be/);
      await assert.rejects(fs.access(output), /ENOENT/);
    }
  }
});


test('versioned Linux packages stage into the shared artifact path without reusing stale root packages', async (t) => {
  const directory = await temporary(t);
  const output = path.join(directory, version);
  await fs.mkdir(output);
  const target = BETA_TARGETS.find(item => item.id === 'linux-x64');
  const expected = expectedAssets(version, [target]);
  for (const name of expected) {
    await fs.writeFile(path.join(directory, name), 'stale-root');
    await fs.writeFile(path.join(output, name), 'current-version');
  }
  assert.deepEqual(await stageAssets(directory, version, target.id, 'unsigned-beta', 'unsigned-beta', output), expected);
  for (const name of expected) assert.equal(await fs.readFile(path.join(directory, 'beta-assets', target.id, name), 'utf8'), 'current-version');
});
