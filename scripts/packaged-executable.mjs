import fs from 'node:fs/promises';
import path from 'node:path';
import { UNSIGNED_WINDOWS_DIRECTORY } from './beta-release.mjs';

export function packagedArtifactDirectory(directory, { distribution = false, unsignedWindowsBeta = false, platform = process.platform } = {}) {
  if (unsignedWindowsBeta && (!distribution || platform !== 'win32')) {
    throw new Error('Unsigned Windows beta smoke requires --distribution on native Windows');
  }
  if (unsignedWindowsBeta) return path.join(directory, UNSIGNED_WINDOWS_DIRECTORY);
  return distribution ? directory : path.join(directory, 'developer');
}

// Never silently qualify an x64 artifact on an ARM runner (or vice versa).
export function packagedExecutableCandidates(directory, platform = process.platform, arch = process.arch) {
  if (!['x64', 'arm64', 'ia32', 'armv7l'].includes(arch)) throw new Error(`Unsupported packaged architecture: ${arch}`);
  if (platform === 'darwin') {
    return [arch === 'x64' ? 'mac' : `mac-${arch}`, 'mac-universal']
      .map((folder) => path.join(directory, folder, 'Bitcoin Browser.app', 'Contents', 'MacOS', 'Bitcoin Browser'));
  }
  if (platform === 'win32') return [path.join(directory, arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`, 'Bitcoin Browser.exe')];
  if (platform === 'linux') return [path.join(directory, arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`, 'bitcoin-browser')];
  throw new Error(`Unsupported packaged platform: ${platform}`);
}

export async function findPackagedExecutable(directory, platform = process.platform, arch = process.arch) {
  for (const candidate of packagedExecutableCandidates(directory, platform, arch)) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`No native ${platform}/${arch} packaged executable under ${directory}. Run npm run pack first, use --distribution for release staging (add --unsigned-windows-beta for that Windows mode), or pass --executable=/absolute/path.`);
}
