import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const EXCLUDED_NAMES = new Set(['node_modules', 'release', '.git', 'coverage', '.DS_Store', 'dist', 'local-data', 'test-results', 'Thumbs.db']);
export function excludedSourceName(name) {
  return EXCLUDED_NAMES.has(name) || (name !== '.env.example' && /^\.env(?:\.|$)/.test(name))
    || /\.(?:log|pem|p12|pfx|key|crt)$/i.test(name);
}
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 20_000;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });

async function readBoundedRegular(file, maxBytes, code) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail(code, 'Expected a regular file');
    if (stat.size > maxBytes) throw fail(code, 'File exceeds size limit');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const growthProbe = Buffer.alloc(1);
    const { bytesRead: grew } = await handle.read(growthProbe, 0, 1, offset);
    if (grew || offset !== stat.size) throw fail(code, 'File changed while being read');
    return buffer;
  } finally {
    await handle.close();
  }
}

function field(block, start, length) {
  const end = block.indexOf(0, start);
  return block.subarray(start, end < 0 || end >= start + length ? start + length : end).toString('utf8');
}

function octal(block, start, length, label) {
  const raw = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(raw)) throw fail('TAR_HEADER_INVALID', `Invalid ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw fail('TAR_HEADER_INVALID', `Invalid ${label}`);
  return value;
}

function safePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  const parts = name.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

export function parseTar(buffer, { maxBytes = MAX_ARCHIVE_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maxBytes) throw fail('TAR_SIZE_LIMIT', 'Tar exceeds size limit');
  const entries = new Map();
  let offset = 0;
  let ended = false;
  while (offset < buffer.length) {
    if (offset + 512 > buffer.length) throw fail('TAR_TRUNCATED', 'Truncated tar header');
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > buffer.length || !buffer.subarray(offset, offset + 1024).every((byte) => byte === 0)) {
        throw fail('TAR_TRUNCATED', 'Tar lacks two end blocks');
      }
      if (!buffer.subarray(offset + 1024).every((byte) => byte === 0)) throw fail('TAR_TRAILING_DATA', 'Nonzero data follows tar terminator');
      ended = true;
      break;
    }
    const storedChecksum = octal(header, 148, 8, 'checksum');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) throw fail('TAR_CHECKSUM_MISMATCH', 'Tar header checksum mismatch');
    const name = field(header, 0, 100);
    if (!safePath(name)) throw fail('TAR_UNSAFE_PATH', `Unsafe tar path: ${name || '<empty>'}`);
    if (entries.has(name)) throw fail('TAR_DUPLICATE_PATH', `Duplicate tar path: ${name}`);
    if (header[156] !== 0x30) throw fail('TAR_TYPE_UNSUPPORTED', `Unsupported tar entry type: ${name}`);
    if (field(header, 257, 6) !== 'ustar') throw fail('TAR_HEADER_INVALID', `Missing ustar header: ${name}`);
    if (field(header, 263, 2) !== '00'
      || octal(header, 108, 8, 'uid') !== 0
      || octal(header, 116, 8, 'gid') !== 0
      || octal(header, 136, 12, 'mtime') !== 0
      || field(header, 265, 32) !== 'root'
      || field(header, 297, 32) !== 'root'
      || !header.subarray(157, 257).every((byte) => byte === 0)
      || !header.subarray(329, 512).every((byte) => byte === 0)) {
      throw fail('TAR_HEADER_INVALID', `Unexpected generated header fields: ${name}`);
    }
    const size = octal(header, 124, 12, 'size');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > buffer.length || next > buffer.length) throw fail('TAR_TRUNCATED', `Truncated tar entry: ${name}`);
    if (!buffer.subarray(dataEnd, next).every((byte) => byte === 0)) throw fail('TAR_PADDING_INVALID', `Nonzero padding: ${name}`);
    entries.set(name, { name, size, mode: octal(header, 100, 8, 'mode'), data: buffer.subarray(dataStart, dataEnd) });
    if (entries.size > maxEntries) throw fail('TAR_ENTRY_LIMIT', 'Tar entry count exceeds limit');
    offset = next;
  }
  if (!ended) throw fail('TAR_TRUNCATED', 'Tar terminator missing');
  return entries;
}

export function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.project !== 'string' || typeof value.version !== 'string'
    || !/^[A-Za-z0-9._-]+$/.test(value.project) || !/^[A-Za-z0-9._-]+$/.test(value.version) || !Array.isArray(value.files)) {
    throw fail('MANIFEST_INVALID', 'Malformed source manifest');
  }
  if (value.fileCount !== value.files.length || value.files.length > MAX_ENTRIES) throw fail('MANIFEST_INVALID', 'Manifest file count mismatch');
  const files = new Map();
  for (const entry of value.files) {
    if (!entry || typeof entry.path !== 'string' || !safePath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw fail('MANIFEST_INVALID', 'Malformed manifest file entry');
    }
    if (entry.path === 'SOURCE_MANIFEST.json' || files.has(entry.path)) throw fail('MANIFEST_INVALID', `Duplicate or reserved manifest path: ${entry.path}`);
    files.set(entry.path, entry);
  }
  return files;
}

export async function walkEligible(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (excludedSourceName(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        output.push(absolute);
        if (output.length > MAX_ENTRIES) throw fail('WORKSPACE_ENTRY_LIMIT', 'Workspace file count exceeds limit');
      }
    }
  }
  await walk(root);
  return output.sort();
}

export async function verifySourceArchive({ root, archivePath, manifestPath = path.join(root, 'SOURCE_MANIFEST.json') }) {
  const archiveGzip = await readBoundedRegular(archivePath, MAX_COMPRESSED_BYTES, 'ARCHIVE_SIZE_LIMIT');
  let tar;
  try { tar = gunzipSync(archiveGzip, { maxOutputLength: MAX_ARCHIVE_BYTES }); }
  catch (error) { throw fail('GZIP_INVALID', `Invalid or oversized gzip archive: ${error.code ?? 'decode'}`); }
  const entries = parseTar(tar);
  const manifestBytes = await readBoundedRegular(manifestPath, MAX_MANIFEST_BYTES, 'MANIFEST_SIZE_LIMIT');
  let manifest;
  try { manifest = JSON.parse(manifestBytes); }
  catch { throw fail('MANIFEST_INVALID', 'Source manifest is not valid JSON'); }
  const manifestFiles = validateManifest(manifest);
  let pkg;
  try { pkg = JSON.parse(await readBoundedRegular(path.join(root, 'package.json'), MAX_PACKAGE_BYTES, 'PACKAGE_INVALID')); }
  catch (error) { if (error.code) throw error; throw fail('PACKAGE_INVALID', 'Workspace package metadata is invalid'); }
  if (manifest.project !== pkg.name || manifest.version !== pkg.version) {
    throw fail('PROJECT_METADATA_MISMATCH', 'Manifest project/version differs from workspace package metadata');
  }
  const prefix = `${manifest.project}-${manifest.version}/`;
  const archiveFiles = new Map();
  for (const [name, entry] of entries) {
    if (!name.startsWith(prefix) || name.length === prefix.length) throw fail('ARCHIVE_PREFIX_MISMATCH', `Unexpected archive path: ${name}`);
    const relative = name.slice(prefix.length);
    if (!safePath(relative) || archiveFiles.has(relative)) throw fail('TAR_UNSAFE_PATH', `Invalid archive-relative path: ${relative}`);
    archiveFiles.set(relative, entry);
  }
  const archivedManifest = archiveFiles.get('SOURCE_MANIFEST.json');
  if (!archivedManifest || !archivedManifest.data.equals(manifestBytes)) throw fail('ARCHIVE_MANIFEST_MISMATCH', 'Archived manifest differs from current manifest bytes');
  const workspaceFiles = await walkEligible(root);
  const workspaceRelative = new Set(workspaceFiles.map((absolute) => path.relative(root, absolute).split(path.sep).join('/')));
  if (workspaceRelative.size !== archiveFiles.size) throw fail('ARCHIVE_FILE_SET_MISMATCH', 'Archive and workspace file counts differ');
  for (const relative of workspaceRelative) if (!archiveFiles.has(relative)) throw fail('ARCHIVE_FILE_SET_MISMATCH', `Archive missing workspace file: ${relative}`);
  for (const relative of archiveFiles.keys()) if (!workspaceRelative.has(relative)) throw fail('ARCHIVE_FILE_SET_MISMATCH', `Archive has unexpected file: ${relative}`);
  const expectedManifestPaths = new Set([...workspaceRelative].filter((relative) => relative !== 'SOURCE_MANIFEST.json'));
  if (expectedManifestPaths.size !== manifestFiles.size) throw fail('WORKSPACE_MANIFEST_DRIFT', 'Workspace and manifest file counts differ');
  for (const absolute of workspaceFiles) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const stat = await fs.stat(absolute);
    const archived = archiveFiles.get(relative);
    if (!archived || archived.size !== stat.size || archived.mode !== (stat.mode & 0o777)) {
      throw fail('ARCHIVE_WORKSPACE_MISMATCH', `Archived file differs from workspace: ${relative}`);
    }
    if (stat.size > MAX_ARCHIVE_BYTES) throw fail('WORKSPACE_FILE_SIZE_LIMIT', `Workspace file exceeds size limit: ${relative}`);
    const data = await fs.readFile(absolute);
    if (!archived.data.equals(data)) throw fail('ARCHIVE_WORKSPACE_MISMATCH', `Archived file differs from workspace: ${relative}`);
    if (relative === 'SOURCE_MANIFEST.json') continue;
    const claimed = manifestFiles.get(relative);
    if (!claimed || claimed.bytes !== data.length || claimed.sha256 !== sha256(data)) throw fail('WORKSPACE_MANIFEST_DRIFT', `Workspace differs from manifest: ${relative}`);
  }
  return { ok: true, archiveSha256: sha256(archiveGzip), archiveBytes: archiveGzip.length, fileCount: archiveFiles.size, project: manifest.project, version: manifest.version };
}
