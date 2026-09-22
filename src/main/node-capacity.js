import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../shared/errors.js';

const GiB = 1024 ** 3;
export const EASY_NODE_SPACE = 30 * GiB;

// Read aggregate capacity, not identifiers, file contents, credentials, or a
// hardware inventory. Missing directories are checked on their actual volume.
export async function inspectNodeCapacity(directory, { filesystem = fs, system = os, platform = process.platform, arch = process.arch } = {}) {
  if (typeof directory !== 'string' || directory.length > 2048 || /[\x00-\x1f\x7f]/.test(directory) || !path.isAbsolute(directory)
      || path.resolve(directory) === path.parse(path.resolve(directory)).root) {
    throw new AppError('INVALID_NODE_SETUP', 'Choose an absolute, non-root storage folder.', { status: 400 });
  }
  let current = path.normalize(directory), rootDirectory = current;
  const missing = [];
  let availableBytes = null, writable = false;
  try {
    while (true) {
      try {
        if (!(await filesystem.stat(current)).isDirectory()) break;
        rootDirectory = path.join(await filesystem.realpath(current), ...missing);
        await filesystem.access(current, fs.constants.W_OK);
        writable = true;
        const disk = await filesystem.statfs(current);
        const bytes = Number(disk.bavail) * Number(disk.bsize);
        if (Number.isSafeInteger(bytes) && bytes >= 0) availableBytes = bytes;
        break;
      } catch (cause) {
        if (cause.code !== 'ENOENT') break;
        const parent = path.dirname(current);
        if (parent === current) break;
        missing.unshift(path.basename(current)); current = parent;
      }
    }
  } catch { /* Unknown capacity is not a positive recommendation. */ }
  let memoryBytes = null, logicalCpus = null, release = '';
  try { const value = system.totalmem(); if (Number.isSafeInteger(value) && value > 0) memoryBytes = value; } catch {}
  try { const value = system.availableParallelism(); if (Number.isSafeInteger(value) && value > 0) logicalCpus = value; } catch {}
  try { release = system.release(); } catch {}
  // Core 31's documented OS baseline. This is a compatibility screen, not a
  // claim that runtime libraries, antivirus, or executable launch were tested.
  const version = /^([0-9]+)\.([0-9]+)(?:\.([0-9]+))?/.exec(release);
  const [major, minor, patch] = version ? version.slice(1).map(value => Number(value ?? 0)) : [];
  const osSupported = Boolean(version && (platform === 'darwin' ? major >= 23
    : platform === 'win32' ? major > 10 || (major === 10 && patch >= 18362)
      : platform === 'linux' ? major > 3 || (major === 3 && minor >= 17) : false));
  return { rootDirectory, availableBytes, writable, memoryBytes, logicalCpus, platform, arch, osSupported };
}

export function recommendEasyNode(capacity, { descriptor, settings = {}, existing = false } = {}) {
  const reasons = [];
  if (existing) reasons.push('A saved setup already exists. Resume it instead of creating another node.');
  if (!descriptor || !capacity.osSupported) reasons.push('Automatic setup needs a supported Core download and operating system. Use Customize setup for an installed program or existing node.');
  if (settings.offlineMode || settings.localOnly) reasons.push('Software download requires online mode with local-only mode off. You can still connect to an existing node in Customize setup.');
  if (!capacity.writable) reasons.push('This storage folder is not accessible for writing. Choose another folder.');
  if (capacity.availableBytes === null) reasons.push('Free storage could not be checked. Choose an accessible drive, or review storage in Customize setup.');
  else if (capacity.availableBytes < EASY_NODE_SPACE) reasons.push('Choose a drive with at least 30 GiB free for this recommended setup. This is a starting allowance, not a total storage cap.');
  if (capacity.memoryBytes === null || capacity.logicalCpus === null) reasons.push('Memory or processor capacity could not be checked. Use Customize setup to review your configuration.');
  else if (capacity.memoryBytes < 2 * GiB) reasons.push('This easy setup recommends at least 2 GiB of memory. Use another computer or review resource settings in Customize setup.');
  return {
    ...capacity, eligible: reasons.length === 0, reasons, recommendedBytes: EASY_NODE_SPACE,
    archiveFits: capacity.availableBytes !== null && capacity.availableBytes >= 1024 * GiB,
    slower: capacity.memoryBytes !== null && capacity.memoryBytes < 4 * GiB || capacity.logicalCpus === 1,
    // Conservative targets, never hard total RAM/CPU limits. No validation is disabled.
    dbCacheMiB: capacity.memoryBytes >= 16 * GiB ? 1024 : capacity.memoryBytes >= 8 * GiB ? 512 : 256,
    validationThreads: Math.max(1, Math.min(4, Math.floor((capacity.logicalCpus ?? 1) / 2))),
    version: descriptor?.version ?? null
  };
}
