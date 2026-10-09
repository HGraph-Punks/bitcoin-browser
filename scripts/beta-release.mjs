import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UNSIGNED_WINDOWS_DIRECTORY = 'unsigned-windows-beta';
export const UNSIGNED_MACOS_DIRECTORY = 'unsigned-macos-beta';

export function validateMacosSigning(mode = 'signed') {
  if (!['signed', 'unsigned-beta'].includes(mode)) throw new Error('macOS signing must be signed or unsigned-beta');
  return mode;
}

export function macosArtifactTemplate(mode = 'signed') {
  validateMacosSigning(mode);
  return 'bitcoin-browser-${version}-macos-${arch}' + (mode === 'unsigned-beta' ? '-unsigned' : '') + '.${ext}';
}

export function validateWindowsSigning(mode = 'signed') {
  if (!['signed', 'unsigned-beta'].includes(mode)) throw new Error('Windows signing must be signed or unsigned-beta');
  return mode;
}

export function windowsArtifactTemplates(mode = 'signed') {
  validateWindowsSigning(mode);
  const prefix = 'bitcoin-browser-${version}-windows-${arch}' + (mode === 'unsigned-beta' ? '-unsigned' : '');
  return { win: `${prefix}.\${ext}`, nsis: `${prefix}-setup.\${ext}`, portable: `${prefix}-portable.\${ext}` };
}

export const BETA_TARGETS = Object.freeze([
  { id: 'macos-x64', runner: 'macos-15-intel', platform: 'darwin', builder: 'mac', arch: 'x64' },
  { id: 'macos-arm64', runner: 'macos-15', platform: 'darwin', builder: 'mac', arch: 'arm64' },
  { id: 'windows-x64', runner: 'windows-2022', platform: 'win32', builder: 'win', arch: 'x64' },
  { id: 'windows-arm64', runner: 'windows-11-arm', platform: 'win32', builder: 'win', arch: 'arm64' },
  { id: 'linux-x64', runner: 'ubuntu-22.04', platform: 'linux', builder: 'linux', arch: 'x64' },
  { id: 'linux-arm64', runner: 'ubuntu-22.04-arm', platform: 'linux', builder: 'linux', arch: 'arm64' }
].map(Object.freeze));

export function validateBetaTag(tag, version) {
  if (typeof tag !== 'string' || tag !== tag.trim() || !(tag === 'v0.1.0' || /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:beta|rc)\.(?:0|[1-9]\d*)$/.test(tag))) {
    throw new Error('Choose an existing early-beta tag: v0.1.0, vMAJOR.MINOR.PATCH-beta.N or vMAJOR.MINOR.PATCH-rc.N');
  }
  if (version !== undefined && tag !== `v${version}`) throw new Error(`Version mismatch: expected v${version}, received ${tag}`);
  return tag;
}

export function selectedTargets(selection = 'all') {
  if (!['all', 'macos', 'windows', 'linux'].includes(selection)) throw new Error('Platforms must be all, macos, windows, or linux');
  return BETA_TARGETS.filter((target) => selection === 'all' || target.id.startsWith(`${selection}-`));
}

export function requireNativeTarget(id, platform = process.platform, arch = process.arch) {
  const target = BETA_TARGETS.find((item) => item.id === id);
  if (!target || target.platform !== platform || target.arch !== arch) throw new Error(`Target ${id} must run natively; received ${platform}/${arch}`);
  return target;
}

export function expectedAssets(version, targets = BETA_TARGETS, windowsSigning = 'signed', macosSigning = 'signed') {
  validateBetaTag(`v${version}`, version);
  validateWindowsSigning(windowsSigning);
  validateMacosSigning(macosSigning);
  return targets.flatMap(({ id, platform, arch }) => {
    const suffixes = platform === 'darwin' ? ['.dmg', '.zip']
      : platform === 'win32' ? ['-setup.exe', '-portable.exe', '.zip']
        : ['.AppImage', '.deb', '.rpm', '.tar.gz'];
    return suffixes.map((suffix) => {
      // electron-builder uses package-native architecture labels in ${arch}.
      // Keep this helper dependency-free for the write-scoped draft job; a
      // regression compares it against the pinned builder's real formatter.
      let artifactArch = arch;
      if (platform === 'linux' && arch === 'x64') {
        if (suffix === '.deb') artifactArch = 'amd64';
        else if (suffix === '.rpm' || suffix === '.AppImage') artifactArch = 'x86_64';
      } else if (platform === 'linux' && arch === 'arm64' && suffix === '.rpm') artifactArch = 'aarch64';
      const artifactTarget = `${id.slice(0, -arch.length)}${artifactArch}`;
      const qualifier = (platform === 'win32' && windowsSigning === 'unsigned-beta') || (platform === 'darwin' && macosSigning === 'unsigned-beta') ? '-unsigned' : '';
      return `bitcoin-browser-${version}-${artifactTarget}${qualifier}${suffix}`;
    });
  }).sort();
}

async function requireRegularAsset(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Release asset must be a nonempty regular file: ${path.basename(file)}`);
}

export async function stageAssets(directory, version, targetId, windowsSigning = 'signed', macosSigning = 'signed', distributionDirectory = directory) {
  const target = BETA_TARGETS.find((item) => item.id === targetId);
  if (!target) throw new Error(`Unknown beta target: ${targetId}`);
  const assets = expectedAssets(version, [target], windowsSigning, macosSigning);
  const source = target.platform === 'win32' && windowsSigning === 'unsigned-beta'
    ? path.join(directory, UNSIGNED_WINDOWS_DIRECTORY)
    : target.platform === 'darwin' && macosSigning === 'unsigned-beta' ? path.join(directory, UNSIGNED_MACOS_DIRECTORY) : distributionDirectory;
  for (const name of assets) await requireRegularAsset(path.join(source, name));
  const destination = path.join(directory, 'beta-assets', targetId);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(destination); // Refuse stale staging or an accidental rerun overwrite.
  for (const name of assets) await fs.copyFile(path.join(source, name), path.join(destination, name), constants.COPYFILE_EXCL);
  return assets;
}

export async function validateAssets(directory, version, selection = 'all', windowsSigning = 'signed', macosSigning = 'signed') {
  const expected = expectedAssets(version, selectedTargets(selection), windowsSigning, macosSigning);
  const actual = (await fs.readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !actual.includes(name));
    const unexpected = actual.filter((name) => !expected.includes(name));
    throw new Error(`Release asset set mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
  }
  for (const name of actual) await requireRegularAsset(path.join(directory, name));
  return actual;
}

export function draftReleaseArguments({ repository, tag, version, commit, remoteCommit, directory, notes, assets, windowsSigning = 'signed', macosSigning = 'signed' }) {
  validateBetaTag(tag, version);
  validateWindowsSigning(windowsSigning);
  validateMacosSigning(macosSigning);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  if (!/^[0-9a-f]{40}$/.test(commit) || commit !== remoteCommit) throw new Error('Release tag changed after verification; start a new run for the reviewed tag');
  return ['release', 'create', tag, ...assets.map((name) => path.join(directory, name)),
    '--repo', repository, '--verify-tag', '--target', commit, '--draft', '--prerelease',
    '--title', `Bitcoin Browser ${version} — early beta${windowsSigning === 'unsigned-beta' && assets.some((name) => name.includes('-windows-')) ? ' (Windows unsigned)' : ''}${macosSigning === 'unsigned-beta' && assets.some((name) => name.includes('-macos-')) ? ' (macOS unsigned)' : ''}`, '--notes-file', notes];
}

export function renderBetaReleaseNotes(template, assets, selection = 'all', windowsSigning = 'signed', macosSigning = 'signed') {
  validateWindowsSigning(windowsSigning);
  validateMacosSigning(macosSigning);
  const targets = selectedTargets(selection);
  const statuses = [];
  if (targets.some((target) => target.platform === 'darwin')) statuses.push(macosSigning === 'unsigned-beta'
    ? '- **macOS: UNSIGNED BETA — no Apple Developer ID signature or notarization.** The app has an ad-hoc signature for integrity on Apple silicon. See the macOS installation guide for Gatekeeper instructions.'
    : '- macOS: Developer ID-signed and notarized application; confirm the publisher on the downloaded app.');
  if (targets.some((target) => target.platform === 'win32')) statuses.push(windowsSigning === 'unsigned-beta'
    ? '- **Windows: UNSIGNED BETA — no verified publisher.** Windows may warn or block launch. Download only from this official repository; do not disable antivirus or OS security protections to run it. Signing is planned for a later release.'
    : '- Windows: timestamped Authenticode signatures checked against the configured publisher.');
  if (targets.some((target) => target.platform === 'linux')) statuses.push('- Linux: package/repository signatures are not provided by this beta pipeline.');
  return `## Download signing status\n\n${statuses.join('\n')}\n\n${template}\n\n## Downloads in this draft\n\n${assets.map((name) => `- ${name}`).join('\n')}\n`;
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const command = process.argv[2];
  const tag = process.env.BETA_TAG;
  const selection = process.env.BETA_PLATFORMS || 'all';
  const windowsSigning = validateWindowsSigning(process.env.BETA_WINDOWS_SIGNING || 'signed');
  const macosSigning = validateMacosSigning(process.env.BETA_MACOS_SIGNING || 'signed');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  if (command === 'plan') {
    validateBetaTag(tag, version);
    const commit = process.env.BETA_COMMIT;
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('Missing checked-out release commit');
    const outputs = { tag, version, commit, platforms: selection, windows_signing: windowsSigning, macos_signing: macosSigning, matrix: JSON.stringify({ include: selectedTargets(selection) }) };
    if (!process.env.GITHUB_OUTPUT) throw new Error('plan requires the GitHub Actions output file');
    await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`Planned ${outputs.tag}: ${selectedTargets(selection).map(({ id }) => id).join(', ')}`);
  } else if (command === 'assert-native') {
    console.log(`Native runner confirmed: ${requireNativeTarget(process.argv[3]).id}`);
  } else if (command === 'stage') {
    requireNativeTarget(process.argv[3]);
    console.log((await stageAssets(path.join(root, 'release'), version, process.argv[3], windowsSigning, macosSigning, process.platform==='linux'?path.resolve(root,JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).build.directories.output):undefined)).join('\n'));
  } else if (command === 'draft') {
    validateBetaTag(tag, version);
    const repository = process.env.GITHUB_REPOSITORY;
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid GitHub repository');
    const directory = path.join(root, 'release', 'beta-downloads');
    const assets = await validateAssets(directory, version, selection, windowsSigning, macosSigning);
    const remoteCommit = execFileSync('gh', ['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'], { encoding: 'utf8', timeout: 30_000 }).trim();
    const notes = path.join(root, 'release', 'beta-release-notes.md');
    const args = draftReleaseArguments({ repository, tag, version, commit: process.env.BETA_COMMIT, remoteCommit, directory, notes, assets, windowsSigning, macosSigning });
    const template = await fs.readFile(path.join(root, 'docs', 'EARLY_BETA_RELEASE_NOTES.md'), 'utf8');
    await fs.writeFile(notes, renderBetaReleaseNotes(template, assets, selection, windowsSigning, macosSigning), { flag: 'wx' });
    // Existing releases are not edited, clobbered, or automatically published.
    execFileSync('gh', args, { stdio: 'inherit', timeout: 300_000 });
  } else {
    throw new Error('Usage: node scripts/beta-release.mjs plan | assert-native TARGET | stage TARGET | draft');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
