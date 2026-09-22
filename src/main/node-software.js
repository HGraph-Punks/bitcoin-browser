import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { requestBuffer } from './http.js';
import { AppError } from '../shared/errors.js';

const gunzip = promisify(zlib.gunzip);
const inflateRaw = promisify(zlib.inflateRaw);
const execFileAsync = promisify(execFile);
// Core 31.1's reviewed Intel Mac / Linux archives exceed 64 MiB. Keep
// download limits explicit and retain Ord's existing smaller allowance.
export const NODE_SOFTWARE_DOWNLOAD_LIMITS = Object.freeze({
  core: Object.freeze({ maxBytes: 128 * 1024 * 1024, timeoutMs: 10 * 60_000 }),
  ord: Object.freeze({ maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000 })
});
const MAX_EXECUTABLE = 256 * 1024 * 1024;
const DOWNLOAD_ORIGINS = Object.freeze([
  'https://bitcoincore.org', 'https://github.com',
  'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'
]);
const MAX_REDIRECTS = 5;
const POLICY_ERRORS = new Set(['UNSAFE_URL', 'UNSAFE_PROVIDER_ORIGIN', 'UNSAFE_PROVIDER_DESTINATION', 'PROVIDER_REDIRECT_ERROR', 'ERR_INVALID_URL']);
const DOWNLOAD_ERRORS = new Set([...POLICY_ERRORS, 'PROVIDER_NETWORK_ERROR', 'PROVIDER_TIMEOUT', 'RESOURCE_TOO_LARGE', 'VALIDATION_ERROR', 'SOFTWARE_DOWNLOAD_TRACE']);

const core = (file, sha256, member, format = 'tar.gz') => Object.freeze({
  kind: 'core', name: 'Bitcoin Core', version: '31.1', url: `https://bitcoincore.org/bin/bitcoin-core-31.1/${file}`,
  sha256, member, format, executableName: member.endsWith('.exe') ? 'bitcoind.exe' : 'bitcoind'
});
const ord = (file, sha256, format = 'tar.gz') => Object.freeze({
  kind: 'ord', name: 'Ord', version: '0.29.0', url: `https://github.com/ordinals/ord/releases/download/0.29.0/${file}`,
  sha256, member: format === 'zip' ? 'ord.exe' : 'ord', format, executableName: format === 'zip' ? 'ord.exe' : 'ord'
});

const CATALOG = Object.freeze({
  'darwin:arm64': Object.freeze({
    core: core('bitcoin-31.1-arm64-apple-darwin.tar.gz', '16a097c09fbd7eb78b240ce1dae123663ea2e5e377cfd6a951e71e227e23cf2f', 'bitcoin-31.1/bin/bitcoind'),
    ord: ord('ord-0.29.0-aarch64-apple-darwin.tar.gz', '9360e97054a1d96624190634882c187126b02647a889b344cb601627ed1bd80c')
  }),
  'darwin:x64': Object.freeze({
    core: core('bitcoin-31.1-x86_64-apple-darwin.tar.gz', 'bc506958d0f387c1ea770bdc7c7192a505fa645ff62cabcc7761fa7eb89e867e', 'bitcoin-31.1/bin/bitcoind'),
    ord: ord('ord-0.29.0-x86_64-apple-darwin.tar.gz', 'a0085f296057563a31258402437c1182fc13bb9559826d1f5490feb4be6dbb75')
  }),
  'linux:x64': Object.freeze({
    core: core('bitcoin-31.1-x86_64-linux-gnu.tar.gz', 'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e', 'bitcoin-31.1/bin/bitcoind'),
    ord: ord('ord-0.29.0-x86_64-unknown-linux-gnu.tar.gz', 'f65c758d71549954470aa7fe23b197478688fb4f910e84c2956cf9144078a94e')
  }),
  'linux:arm64': Object.freeze({
    core: core('bitcoin-31.1-aarch64-linux-gnu.tar.gz', 'dcf1873f2208ba4f962f3398d47e154c39c0084be8f4553e05c940d0ace3d004', 'bitcoin-31.1/bin/bitcoind'), ord: null
  }),
  'win32:x64': Object.freeze({
    core: core('bitcoin-31.1-win64.zip', 'c99ef173471c58e6766d9eebd12e6c35349082eeed3939bc99eed58ef57db587', 'bitcoin-31.1/bin/bitcoind.exe', 'zip'),
    ord: ord('ord-0.29.0-x86_64-pc-windows-msvc.zip', '93de82db792ccc37ae385c49646c0f649d38049f4e959499c6e7c5d1a81bf2ad', 'zip')
  })
});

export function softwareCatalog(platform, arch) {
  return CATALOG[`${platform}:${arch}`] ?? Object.freeze({ core: null, ord: null });
}

function fail(code, message, options = {}) { return new AppError(code, message, { status: options.status ?? 400, retryable: options.retryable, cause: options.cause, details: options.details }); }
function sha(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
async function defaultMarkDownloaded(file, { platform }) {
  if (platform !== 'darwin') return;
  const stamp = Math.floor(Date.now() / 1000).toString(16);
  await execFileAsync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${stamp};Bitcoin Browser;`, file], {
    timeout: 10_000, shell: false, windowsHide: true, maxBuffer: 64 * 1024
  });
}
function safeName(name) { const clean = typeof name === 'string' ? name.replace(/\/$/, '') : ''; return clean.length > 0 && clean.length <= 512 && !clean.startsWith('/') && !clean.includes('\\') && !clean.split('/').some((part) => !part || part === '.' || part === '..'); }
function selected(name, descriptor) { return name === descriptor.member || descriptor.kind === 'ord' && name.split('/').at(-1) === descriptor.executableName; }

function tarOctal(bytes) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : NaN;
}

async function extractTarGz(archive, descriptor) {
  let tar;
  try { tar = await gunzip(archive, { maxOutputLength: MAX_EXECUTABLE + 1024 * 1024 }); }
  catch (error) { throw fail('SOFTWARE_ARCHIVE_INVALID', 'Downloaded gzip archive is invalid or too large', { cause: error }); }
  let found = null;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header.subarray(124, 136));
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const expectedChecksum = tarOctal(header.subarray(148, 156));
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (!safeName(full) || !Number.isSafeInteger(size) || size < 0 || expectedChecksum !== actualChecksum || offset + 512 + size > tar.length) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Downloaded tar archive is malformed');
    if (selected(full, descriptor)) {
      if (type !== '0') throw fail('SOFTWARE_ARCHIVE_INVALID', 'Selected executable is not a regular archive file');
      if (found) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Archive contains duplicate executable entries');
      if (size > MAX_EXECUTABLE) throw fail('SOFTWARE_ARCHIVE_TOO_LARGE', 'Executable exceeds the installation size limit', { status: 413 });
      found = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!found?.length) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Archive does not contain a nonempty expected executable');
  return found;
}

async function extractZip(archive, descriptor) {
  let eocd = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 65_557); at--) if (archive.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  if (eocd < 0 || eocd + 22 > archive.length) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip central directory is missing');
  const count = archive.readUInt16LE(eocd + 10); const centralSize = archive.readUInt32LE(eocd + 12); const centralOffset = archive.readUInt32LE(eocd + 16); let offset = centralOffset;
  if (count > 10_000 || offset + centralSize !== eocd) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip central directory is malformed');
  let found = null;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || archive.readUInt32LE(offset) !== 0x02014b50) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip central entry is malformed');
    const flags = archive.readUInt16LE(offset + 8); const method = archive.readUInt16LE(offset + 10); const crc = archive.readUInt32LE(offset + 16);
    const compressed = archive.readUInt32LE(offset + 20); const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28); const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32);
    const external = archive.readUInt32LE(offset + 38); const localOffset = archive.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > eocd) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip central entry is truncated');
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!safeName(name) || (flags & 1)) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip archive contains an unsafe or encrypted entry');
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip local entry is malformed');
    const localNameLength = archive.readUInt16LE(localOffset + 26); const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength; const end = dataOffset + compressed;
    if (localName !== name || archive.readUInt16LE(localOffset + 8) !== method || end > archive.length) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip local entry disagrees with its central directory');
    if (selected(name, descriptor)) {
      const unixType = (external >>> 16) & 0o170000;
      if (name.endsWith('/') || unixType && unixType !== 0o100000) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Selected executable is not a regular archive file');
      if (found) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Archive contains duplicate executable entries');
      if (size > MAX_EXECUTABLE) throw fail('SOFTWARE_ARCHIVE_TOO_LARGE', 'Executable exceeds the installation size limit', { status: 413 });
      const body = archive.subarray(dataOffset, end);
      try { found = method === 0 ? Buffer.from(body) : method === 8 ? await inflateRaw(body, { maxOutputLength: MAX_EXECUTABLE }) : null; }
      catch (error) { throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip executable could not be decompressed', { cause: error }); }
      if (!found || !found.length || found.length !== size || crc32(found) !== crc) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip executable integrity does not match its central directory');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Zip central directory entry count is inconsistent');
  if (!found) throw fail('SOFTWARE_ARCHIVE_INVALID', 'Archive does not contain the expected executable');
  return found;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

async function regularFile(io, file) {
  try { return (await io.lstat(file)).isFile(); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
async function boundedRegularRead(io, file, maximum) {
  const stat = await io.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw fail('SOFTWARE_INSTALL_COLLISION', 'Installed software metadata is unsafe', { status: 409 });
  const data = await io.readFile(file);
  if (data.length > maximum) throw fail('SOFTWARE_INSTALL_COLLISION', 'Installed software metadata is too large', { status: 409 });
  return data;
}

export class NodeSoftware {
  constructor({ directory, platform = process.platform, arch = process.arch, request = requestBuffer, fs = fsPromises, markDownloaded = defaultMarkDownloaded }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('VALIDATION_ERROR', 'Software directory must be absolute');
    if (typeof markDownloaded !== 'function') throw fail('VALIDATION_ERROR', 'Downloaded-file marker must be a function');
    this.directory = directory; this.platform = platform; this.arch = arch; this.request = request; this.fs = fs; this.markDownloaded = markDownloaded;
    this.pending = new Map(); this.controllers = new Set(); this.stopping = false; this.shutdownPromise = null;
  }
  catalog() { return softwareCatalog(this.platform, this.arch); }
  async install(kind, { signal } = {}) {
    if (!['core', 'ord'].includes(kind)) throw fail('VALIDATION_ERROR', 'Unknown node software kind');
    if (this.stopping) throw fail('APP_SHUTTING_DOWN', 'Application is shutting down', { status: 503 });
    if (this.pending.has(kind)) throw fail('SOFTWARE_INSTALL_BUSY', `${kind} installation is already pending`, { status: 409, retryable: true });
    const descriptor = this.catalog()[kind];
    if (!descriptor) throw fail('SOFTWARE_INSTALL_UNSUPPORTED', `${kind} automatic installation is unavailable on this platform`, { status: 422 });
    if (signal?.aborted) throw signal.reason;
    const controller = new AbortController(); this.controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const operation = this.#install(descriptor, combined);
    this.pending.set(kind, operation);
    try { return await operation; } finally { this.pending.delete(kind); this.controllers.delete(controller); }
  }
  async #install(descriptor, signal) {
    const limits = NODE_SOFTWARE_DOWNLOAD_LIMITS[descriptor.kind];
    const finalDirectory = path.join(this.directory, descriptor.kind, descriptor.version);
    const executable = path.join(finalDirectory, descriptor.executableName);
    const manifestFile = path.join(finalDirectory, 'manifest.json');
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rootStat = await this.fs.lstat(this.directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail('SOFTWARE_INSTALL_COLLISION', 'Software directory is not a private directory', { status: 409 });
    const kindDirectory = path.dirname(finalDirectory);
    await this.fs.mkdir(kindDirectory, { mode: 0o700 }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
    const kindStat = await this.fs.lstat(kindDirectory);
    if (!kindStat.isDirectory() || kindStat.isSymbolicLink()) throw fail('SOFTWARE_INSTALL_COLLISION', 'Software kind directory is unsafe', { status: 409 });
    if (signal.aborted) throw signal.reason;
    const versionStat = await this.fs.lstat(finalDirectory).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
    if (versionStat && (!versionStat.isDirectory() || versionStat.isSymbolicLink())) throw fail('SOFTWARE_INSTALL_COLLISION', 'Software version directory is unsafe and requires manual review', { status: 409 });
    if (await regularFile(this.fs, manifestFile)) {
      const manifest = JSON.parse((await boundedRegularRead(this.fs, manifestFile, 16 * 1024)).toString('utf8'));
      const bytes = await boundedRegularRead(this.fs, executable, MAX_EXECUTABLE).catch(() => null);
      if (signal.aborted) throw signal.reason;
      if (manifest.kind === descriptor.kind && manifest.version === descriptor.version && manifest.sha256 === descriptor.sha256
          && typeof manifest.executableSha256 === 'string' && bytes && sha(bytes) === manifest.executableSha256) {
        return { kind: descriptor.kind, version: descriptor.version, executable, sha256: descriptor.sha256, integrity: 'pinned-sha256', publisherSignatureVerified: false, downloadProvenance: null };
      }
      throw fail('SOFTWARE_INSTALL_COLLISION', 'Existing installation is not owned by this catalog entry', { status: 409 });
    }
    if (versionStat) throw fail('SOFTWARE_INSTALL_COLLISION', 'Installation destination already exists and requires manual review', { status: 409 });
    signal.throwIfAborted();
    const responses = [];
    const provenance = () => responses.length ? Object.freeze({ schemaVersion: 1, policy: 'https-software-origins-v1',
      responses: Object.freeze(responses.map(item => Object.freeze({ ...item }))) }) : null;
    const onResponse = ({ origin, status } = {}) => {
      if (!DOWNLOAD_ORIGINS.includes(origin) || !Number.isInteger(status) || status < 100 || status > 599 || responses.length > MAX_REDIRECTS) {
        throw fail('SOFTWARE_DOWNLOAD_TRACE', 'Software response observation is invalid');
      }
      responses.push({ origin, status });
    };
    let response;
    try {
      response = await this.request(descriptor.url, { signal, timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes,
        redirect: 'follow', maxRedirects: MAX_REDIRECTS, networkPolicy: 'remote', allowedOrigins: DOWNLOAD_ORIGINS, onResponse });
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      const policy = POLICY_ERRORS.has(cause?.code);
      // Signed CDN URLs and arbitrary DNS/transport messages must not cross the
      // installer/renderer boundary, even nested inside an error cause.
      throw fail(policy ? 'SOFTWARE_DOWNLOAD_POLICY' : 'SOFTWARE_DOWNLOAD_FAILED',
        policy ? 'Software download was blocked by its HTTPS, destination or redirect policy.' : 'Software download failed. Check the connection and try again.', {
          status: policy ? 403 : 502, retryable: !policy && cause?.retryable === true,
          details: { reasonCode: DOWNLOAD_ERRORS.has(cause?.code) ? cause.code : 'DOWNLOAD_TRANSPORT_ERROR', downloadProvenance: provenance() }
        });
    }
    signal.throwIfAborted();
    const downloadProvenance = provenance();
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      throw fail('SOFTWARE_DOWNLOAD_FAILED', `Software download returned HTTP ${status ?? 'unknown'}`, {
        status: 502, retryable: true, details: { reasonCode: 'HTTP_STATUS', httpStatus: status, downloadProvenance }
      });
    }
    const archive = Buffer.from(response.data ?? []);
    if (archive.length > limits.maxBytes) throw fail('SOFTWARE_ARCHIVE_TOO_LARGE', 'Software archive exceeds the download limit', { status: 413, details: { downloadProvenance } });
    if (sha(archive) !== descriptor.sha256) throw fail('SOFTWARE_INTEGRITY_FAILED', 'Downloaded software did not match its pinned SHA-256 digest', { status: 502, details: { downloadProvenance } });
    if (signal.aborted) throw signal.reason;
    const bytes = descriptor.format === 'zip' ? await extractZip(archive, descriptor) : await extractTarGz(archive, descriptor);
    if (signal.aborted) throw signal.reason;
    const ownership = crypto.randomUUID();
    const marker = path.join(finalDirectory, '.install-owner');
    let directoryIdentity = null; const created = new Map(); let committed = false;
    try {
      await this.fs.mkdir(finalDirectory, { mode: 0o700 });
      const stat = await this.fs.lstat(finalDirectory); directoryIdentity = { dev: stat.dev, ino: stat.ino };
      await this.fs.writeFile(marker, ownership, { flag: 'wx', mode: 0o600 }); created.set(marker, { stat: await this.fs.lstat(marker), content: Buffer.from(ownership) });
      if (signal.aborted) throw signal.reason;
      await this.fs.writeFile(executable, bytes, { flag: 'wx', mode: 0o700 }); created.set(executable, { stat: await this.fs.lstat(executable), content: bytes }); await this.fs.chmod(executable, 0o755);
      await this.markDownloaded(executable, { platform: this.platform, kind: descriptor.kind, version: descriptor.version, signal });
      if (signal.aborted) throw signal.reason;
      const manifestBytes = Buffer.from(JSON.stringify({ kind: descriptor.kind, version: descriptor.version, sha256: descriptor.sha256, executableSha256: sha(bytes) }) + '\n');
      await this.fs.writeFile(manifestFile, manifestBytes, { flag: 'wx', mode: 0o600 }); created.set(manifestFile, { stat: await this.fs.lstat(manifestFile), content: manifestBytes });
      if (signal.aborted) throw signal.reason;
      await this.fs.rm(marker); created.delete(marker); committed = true;
    } catch (error) {
      const primary = error?.code === 'EEXIST' ? fail('SOFTWARE_INSTALL_COLLISION', 'Installation destination already exists and requires manual review', { status: 409, cause: error }) : error;
      const cleanupErrors = [];
      if (directoryIdentity) {
        const directoryNow = await this.fs.lstat(finalDirectory).catch((cleanupError) => { cleanupErrors.push(cleanupError); return null; });
        const markerValue = await boundedRegularRead(this.fs, marker, 128).then((data) => data.toString('utf8'), (cleanupError) => { cleanupErrors.push(cleanupError); return null; });
        if (directoryNow?.isDirectory() && !directoryNow.isSymbolicLink() && directoryNow.dev === directoryIdentity.dev && directoryNow.ino === directoryIdentity.ino && markerValue === ownership) {
          for (const file of [manifestFile, executable, marker]) if (created.has(file)) {
            const expected = created.get(file); const actual = await this.fs.lstat(file).catch((cleanupError) => { cleanupErrors.push(cleanupError); return null; });
            const actualContent = actual?.isFile() && !actual.isSymbolicLink() && actual.size === expected.content.length
              ? await boundedRegularRead(this.fs, file, expected.content.length).catch((cleanupError) => { cleanupErrors.push(cleanupError); return null; }) : null;
            if (actual?.isFile() && !actual.isSymbolicLink() && actual.dev === expected.stat.dev && actual.ino === expected.stat.ino && actualContent?.equals(expected.content)) await this.fs.rm(file).catch((cleanupError) => cleanupErrors.push(cleanupError));
            else if (actual) cleanupErrors.push(fail('SOFTWARE_INSTALL_CLEANUP_UNSAFE', 'An installation file changed during cleanup'));
          }
          await this.fs.rmdir(finalDirectory).catch((cleanupError) => cleanupErrors.push(cleanupError));
        } else cleanupErrors.push(fail('SOFTWARE_INSTALL_CLEANUP_UNSAFE', 'Installation ownership changed during cleanup'));
      }
      if (cleanupErrors.length) throw fail('SOFTWARE_INSTALL_CLEANUP_FAILED', 'Incomplete installation requires manual review', { status: 500, retryable: true, cause: primary, details: { primaryCode: primary?.code ?? null, cleanupErrors: cleanupErrors.map((item) => ({ code: item?.code ?? null, message: String(item?.message ?? item).slice(0, 256) })) } });
      throw primary;
    }
    if (!committed) throw fail('SOFTWARE_INSTALL_CLEANUP_FAILED', 'Installation did not commit', { retryable: true });
    return { kind: descriptor.kind, version: descriptor.version, executable, sha256: descriptor.sha256, integrity: 'pinned-sha256', publisherSignatureVerified: false, downloadProvenance };
  }
  destination(kind) {
    const descriptor = this.catalog()[kind];
    return descriptor ? path.join(this.directory, kind, descriptor.version, descriptor.executableName) : null;
  }
  async discover() {
    const result = { core: [], ord: [] };
    const own = this.catalog();
    for (const kind of ['core', 'ord']) if (own[kind]) {
      const executable = path.join(this.directory, kind, own[kind].version, own[kind].executableName);
      const manifestFile = path.join(this.directory, kind, own[kind].version, 'manifest.json');
      try {
        const rootStat = await this.fs.lstat(this.directory); const kindStat = await this.fs.lstat(path.join(this.directory, kind)); const versionStat = await this.fs.lstat(path.join(this.directory, kind, own[kind].version));
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !kindStat.isDirectory() || kindStat.isSymbolicLink() || !versionStat.isDirectory() || versionStat.isSymbolicLink()) continue;
        const manifest = JSON.parse((await boundedRegularRead(this.fs, manifestFile, 16 * 1024)).toString('utf8'));
        const bytes = await boundedRegularRead(this.fs, executable, MAX_EXECUTABLE);
        if (manifest.kind === kind && manifest.version === own[kind].version && manifest.sha256 === own[kind].sha256
            && typeof manifest.executableSha256 === 'string' && sha(bytes) === manifest.executableSha256) result[kind].push(executable);
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error?.code) && !(error instanceof SyntaxError) && error?.code !== 'SOFTWARE_INSTALL_COLLISION') throw error; }
    }
    const known = this.platform === 'win32'
      ? { core: ['C:\\Program Files\\Bitcoin\\daemon\\bitcoind.exe'], ord: [] }
      : { core: ['/usr/local/bin/bitcoind', '/usr/bin/bitcoind', ...(this.platform === 'darwin' ? ['/opt/homebrew/bin/bitcoind'] : [])], ord: ['/usr/local/bin/ord', '/usr/bin/ord', ...(this.platform === 'darwin' ? ['/opt/homebrew/bin/ord'] : [])] };
    for (const kind of ['core', 'ord']) for (const executable of known[kind]) {
      try { if ((await this.fs.stat(executable)).isFile()) result[kind].push(executable); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error; }
    }
    return result;
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    for (const controller of this.controllers) controller.abort(fail('APP_SHUTTING_DOWN', 'Application is shutting down', { status: 503 }));
    this.shutdownPromise = Promise.allSettled([...this.pending.values()]).then(results => {
      const failures = results.filter(result => result.status === 'rejected' && result.reason?.code === 'SOFTWARE_INSTALL_CLEANUP_FAILED').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Node software installation cleanup did not drain cleanly');
    });
    return this.shutdownPromise;
  }
}
