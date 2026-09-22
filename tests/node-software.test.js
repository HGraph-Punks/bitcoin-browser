import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { NodeSoftware, softwareCatalog, NODE_SOFTWARE_DOWNLOAD_LIMITS } from '../src/main/node-software.js';

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
function tar(entries) {
  const blocks = [];
  for (const { name, data = Buffer.alloc(0), type = '0' } of entries) {
    const body = Buffer.from(data); const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function zip(name, data, { descriptor = false, external = 0o100755 << 16 } = {}) {
  const body = Buffer.from(data); const compressed = zlib.deflateRawSync(body); const file = Buffer.from(name);
  let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } crc = (crc ^ 0xffffffff) >>> 0;
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(descriptor ? 8 : 0, 6); header.writeUInt16LE(8, 8);
  if (!descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(body.length, 22); } header.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(descriptor ? 8 : 0, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(file.length, 28); central.writeUInt32LE(external >>> 0, 38);
  const dataDescriptor = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
  if (descriptor) { dataDescriptor.writeUInt32LE(0x08074b50); dataDescriptor.writeUInt32LE(crc, 4); dataDescriptor.writeUInt32LE(compressed.length, 8); dataDescriptor.writeUInt32LE(body.length, 12); }
  const local = Buffer.concat([header, file, compressed, dataDescriptor]); const directory = Buffer.concat([central, file]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, end]);
}
async function fixture(t, { format = 'tar.gz', member = 'fixture/bin/bitcoind', executableName = 'bitcoind', bytes = Buffer.from('synthetic executable') } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-node-software-'));
  const archive = format === 'zip' ? zip(member, bytes) : tar([{ name: 'fixture/', type: '5' }, { name: member, data: bytes }]);
  const descriptor = { kind: 'core', name: 'Fixture', version: '1.0', url: 'https://example.invalid/pinned', sha256: sha(archive), member, format, executableName };
  const requests = [];
  const manager = new NodeSoftware({ directory, platform: 'test', arch: 'test', request: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, data: archive }; } });
  manager.catalog = () => ({ core: descriptor, ord: null });
  t.after(async () => { try { await manager.shutdown(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { directory, archive, bytes, descriptor, requests, manager };
}

test('catalog exposes only pinned supported platform artifacts and explicit nulls elsewhere', () => {
  const mac = softwareCatalog('darwin', 'arm64');
  assert.equal(mac.core.version, '31.1'); assert.match(mac.core.url, /^https:\/\/bitcoincore\.org\//);
  assert.match(mac.core.sha256, /^[0-9a-f]{64}$/); assert.equal(mac.ord.version, '0.29.0');
  assert.deepEqual(softwareCatalog('linux', 'arm64').ord, null);
  assert.deepEqual(softwareCatalog('freebsd', 'x64'), { core: null, ord: null });
});

test('bounded download allowance covers the published pinned Core 31.1 archives on every catalog platform', () => {
  // Official release index, checked 2026-09-20. Gzip size footers were checked
  // with four-byte ranges, without downloading or executing programs.
  const entries = [['darwin', 'arm64', 65771644, 130877440], ['darwin', 'x64', 71646932, 143636480],
    ['linux', 'arm64', 85851107, 178759680], ['linux', 'x64', 90293352, 192204800], ['win32', 'x64', 54894985, null]];
  for (const [platform, arch, archiveBytes, tarBytes] of entries) {
    assert.equal(softwareCatalog(platform, arch).core.version, '31.1');
    assert.ok(archiveBytes < NODE_SOFTWARE_DOWNLOAD_LIMITS.core.maxBytes);
    if (tarBytes !== null) assert.ok(tarBytes < 257 * 1024 * 1024);
  }
  assert.equal(NODE_SOFTWARE_DOWNLOAD_LIMITS.core.maxBytes, 128 * 1024 * 1024);
  assert.equal(NODE_SOFTWARE_DOWNLOAD_LIMITS.ord.maxBytes, 64 * 1024 * 1024);
  assert.equal(NODE_SOFTWARE_DOWNLOAD_LIMITS.core.timeoutMs, 600_000);
  assert.equal(NODE_SOFTWARE_DOWNLOAD_LIMITS.ord.timeoutMs, 120_000);
});

test('installer applies its bounded Core download budget and exposes only the pinned destination', async t => {
  const f = await fixture(t);
  const destination = f.manager.destination('core'); assert.equal(destination, path.join(f.directory, 'core', '1.0', 'bitcoind'));
  assert.equal(f.manager.destination('ord'), null); assert.equal(f.requests.length, 0);
  const result = await f.manager.install('core'); assert.equal(result.executable, destination);
  assert.equal(f.requests[0].options.maxBytes, NODE_SOFTWARE_DOWNLOAD_LIMITS.core.maxBytes);
  assert.equal(f.requests[0].options.timeoutMs, NODE_SOFTWARE_DOWNLOAD_LIMITS.core.timeoutMs);
});

test('tar install verifies pinned archive, writes one private executable atomically, and reuses verified manifest without download', async (t) => {
  const f = await fixture(t); const result = await f.manager.install('core');
  assert.deepEqual(result, { kind: 'core', version: '1.0', executable: path.join(f.directory, 'core', '1.0', 'bitcoind'), sha256: f.descriptor.sha256, integrity: 'pinned-sha256', publisherSignatureVerified: false, downloadProvenance: null });
  assert.deepEqual(await fs.readFile(result.executable), f.bytes);
  assert.equal((await fs.stat(result.executable)).mode & 0o777, 0o755);
  const reused = await f.manager.install('core'); assert.deepEqual(reused, result); assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.manager.discover(), { core: [result.executable], ord: [] });
  await fs.writeFile(result.executable, 'tampered owned binary');
  assert.deepEqual(await f.manager.discover(), { core: [], ord: [] });
});

test('zip install extracts only the selected regular executable', async (t) => {
  const f = await fixture(t, { format: 'zip', member: 'fixture/bitcoind.exe', executableName: 'bitcoind.exe' });
  const result = await f.manager.install('core'); assert.deepEqual(await fs.readFile(result.executable), f.bytes);
});

test('zip central directory authorizes data-descriptor executables', async (t) => {
  const f = await fixture(t, { format: 'zip', member: 'fixture/bitcoind.exe', executableName: 'bitcoind.exe' });
  const archive = zip(f.descriptor.member, f.bytes, { descriptor: true }); f.descriptor.sha256 = sha(archive);
  f.manager.request = async () => ({ ok: true, status: 200, data: archive });
  const result = await f.manager.install('core'); assert.deepEqual(await fs.readFile(result.executable), f.bytes);
});

test('zip rejects selected symlinks and central-directory CRC disagreement', async (t) => {
  const f = await fixture(t, { format: 'zip', member: 'fixture/bitcoind.exe', executableName: 'bitcoind.exe' });
  for (const archive of [
    zip(f.descriptor.member, f.bytes, { external: 0o120777 << 16 }),
    (() => { const value = zip(f.descriptor.member, f.bytes); const central = value.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); value.writeUInt32LE(0, central + 16); return value; })()
  ]) {
    f.descriptor.sha256 = sha(archive); f.manager.request = async () => ({ ok: true, data: archive });
    await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_ARCHIVE_INVALID' });
  }
});

test('macOS installation marks only the newly owned executable as quarantined before commit', async (t) => {
  const f = await fixture(t); const calls = [];
  f.manager.platform = 'darwin';
  f.manager.markDownloaded = async (file, context) => { calls.push({ file, context, bytes: await fs.readFile(file) }); };
  const result = await f.manager.install('core');
  assert.equal(calls.length, 1); assert.equal(calls[0].file, result.executable);
  assert.deepEqual(calls[0].bytes, f.bytes); assert.equal(calls[0].context.platform, 'darwin');
  assert.equal(calls[0].context.kind, 'core');
});

test('failed downloaded-file marking removes only the owned incomplete installation', async (t) => {
  const f = await fixture(t); const failure = new Error('synthetic quarantine failure');
  f.manager.markDownloaded = async () => { throw failure; };
  await assert.rejects(f.manager.install('core'), (error) => error === failure);
  assert.equal(await fs.access(path.join(f.directory, 'core', '1.0')).then(() => true, () => false), false);
});

test('cleanup preserves foreign files introduced during an install and reports manual recovery', async (t) => {
  const f = await fixture(t); const foreign = path.join(f.directory, 'core', '1.0', 'foreign.txt');
  f.manager.markDownloaded = async () => { await fs.writeFile(foreign, 'operator data'); throw new Error('synthetic marker failure'); };
  await assert.rejects(f.manager.install('core'), (error) => error.code === 'SOFTWARE_INSTALL_CLEANUP_FAILED' && error.retryable && error.details.primaryCode === null);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'operator data');
  assert.deepEqual((await fs.readdir(path.dirname(foreign))).sort(), ['foreign.txt']);
});

test('cleanup will not unlink an owned inode whose contents changed while installation was pending', async (t) => {
  const f = await fixture(t); let executable;
  f.manager.markDownloaded = async (file) => { executable = file; await fs.writeFile(file, 'foreign replacement'); throw new Error('synthetic marker failure'); };
  await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_INSTALL_CLEANUP_FAILED' });
  assert.equal(await fs.readFile(executable, 'utf8'), 'foreign replacement');
});

test('cached installation observes cancellation after bounded metadata reads without downloading', async (t) => {
  const f = await fixture(t); await f.manager.install('core'); const controller = new AbortController(); const reason = new Error('cached cancel');
  const realFs = f.manager.fs;
  f.manager.fs = { ...realFs, readFile: async (file, ...args) => { const value = await realFs.readFile(file, ...args); if (file.endsWith('manifest.json')) controller.abort(reason); return value; } };
  await assert.rejects(f.manager.install('core', { signal: controller.signal }), (error) => error === reason);
  assert.equal(f.requests.length, 1);
});

test('invalid kinds, unsupported platforms, integrity mismatch and unsafe archives fail without publication', async (t) => {
  const f = await fixture(t); let calls = 0;
  const unsupported = new NodeSoftware({ directory: f.directory, platform: 'freebsd', arch: 'x64', request: async () => { calls++; } });
  await assert.rejects(unsupported.install('wat'), { code: 'VALIDATION_ERROR' });
  await assert.rejects(unsupported.install('ord'), { code: 'SOFTWARE_INSTALL_UNSUPPORTED' }); assert.equal(calls, 0);
  f.descriptor.sha256 = '0'.repeat(64); await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_INTEGRITY_FAILED' });
  assert.equal(await fs.access(path.join(f.directory, 'core', '1.0')).then(() => true, () => false), false);
  for (const entries of [[{ name: '../bitcoind', data: f.bytes }], [{ name: f.descriptor.member, data: f.bytes, type: '2' }], [{ name: f.descriptor.member, data: f.bytes }, { name: f.descriptor.member, data: f.bytes }]]) {
    const archive = tar(entries); f.descriptor.sha256 = sha(archive); f.manager.request = async () => ({ ok: true, data: archive });
    await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_ARCHIVE_INVALID' });
  }
});

test('same-kind concurrency is rejected and shutdown aborts and drains the admitted request', async (t) => {
  const f = await fixture(t); let release; let enteredResolve; const entered = new Promise((resolve) => { enteredResolve = resolve; });
  f.manager.request = (_url, { signal }) => new Promise((resolve, reject) => {
    enteredResolve();
    release = () => resolve({ ok: true, data: f.archive });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const pending = f.manager.install('core');
  await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_INSTALL_BUSY' });
  await entered;
  const shutdown = f.manager.shutdown();
  await assert.rejects(pending, { code: 'APP_SHUTTING_DOWN' }); await shutdown;
  await assert.rejects(f.manager.install('core'), { code: 'APP_SHUTTING_DOWN' });
  assert.equal(typeof release, 'function');
});

test('caller cancellation propagates without publishing files', async (t) => {
  const f = await fixture(t); const controller = new AbortController(); let enteredResolve; const entered = new Promise((resolve) => { enteredResolve = resolve; });
  f.manager.request = (_url, { signal }) => new Promise((_resolve, reject) => { enteredResolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const pending = f.manager.install('core', { signal: controller.signal }); await entered; const reason = new Error('Synthetic cancel'); controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(await fs.access(path.join(f.directory, 'core', '1.0')).then(() => true, () => false), false);
});

test('already-cancelled install is rejected before download admission', async (t) => {
  const f = await fixture(t); const controller = new AbortController(); const reason = new Error('Already cancelled'); controller.abort(reason);
  await assert.rejects(f.manager.install('core', { signal: controller.signal }), (error) => error === reason);
  assert.equal(f.requests.length, 0);
});

test('unknown destination and symlink collisions are preserved without overwrite or broad cleanup', async (t) => {
  const f = await fixture(t); const kind = path.join(f.directory, 'core'); await fs.mkdir(kind); const final = path.join(kind, '1.0'); await fs.mkdir(final);
  await fs.writeFile(path.join(final, 'operator.txt'), 'preserve');
  await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_INSTALL_COLLISION' });
  assert.equal(await fs.readFile(path.join(final, 'operator.txt'), 'utf8'), 'preserve');
  const other = await fixture(t); const target = path.join(other.directory, 'outside'); await fs.mkdir(target);
  await fs.symlink(target, path.join(other.directory, 'core'));
  await assert.rejects(other.manager.install('core'), { code: 'SOFTWARE_INSTALL_COLLISION' });
  assert.deepEqual(await fs.readdir(target), []);
});

test('cached metadata must be a bounded regular file and is never followed through a symlink', async (t) => {
  const f = await fixture(t); const final = path.join(f.directory, 'core', '1.0'); await fs.mkdir(final, { recursive: true });
  await fs.writeFile(path.join(final, 'manifest.json'), Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_INSTALL_COLLISION' });
  assert.equal(f.requests.length, 0);

  const other = await fixture(t); const otherFinal = path.join(other.directory, 'core', '1.0'); await fs.mkdir(otherFinal, { recursive: true });
  const external = path.join(other.directory, 'external-manifest'); await fs.writeFile(external, '{}');
  await fs.symlink(external, path.join(otherFinal, 'manifest.json'));
  await assert.rejects(other.manager.install('core'), { code: 'SOFTWARE_INSTALL_COLLISION' });
  assert.equal(await fs.readFile(external, 'utf8'), '{}'); assert.equal(other.requests.length, 0);
});

test('version-directory symlinks are never accepted for cached install or discovery', async (t) => {
  const owned = await fixture(t); const installed = await owned.manager.install('core');
  const f = await fixture(t); await fs.mkdir(path.join(f.directory, 'core')); await fs.symlink(path.dirname(installed.executable), path.join(f.directory, 'core', '1.0'));
  await assert.rejects(f.manager.install('core'), { code: 'SOFTWARE_INSTALL_COLLISION' });
  assert.deepEqual(await f.manager.discover(), { core: [], ord: [] }); assert.equal(f.requests.length, 0);
  assert.deepEqual(await fs.readFile(installed.executable), owned.bytes);
});
