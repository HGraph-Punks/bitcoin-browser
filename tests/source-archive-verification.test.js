import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseTar, validateManifest, verifySourceArchive } from '../scripts/source-archive-verification.mjs';

function header(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  const octal = (offset, length, value) => block.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0);
  block.fill(0x20, 148, 156); block[156] = type.charCodeAt(0); block.write('ustar\0', 257, 6); block.write('00', 263, 2);
  block.write('root', 265, 32); block.write('root', 297, 32);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}
function tar(items, end = true) {
  const chunks = [];
  for (const [name, data, type] of items) {
    chunks.push(header(name, data.length, type), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  if (end) chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
function updateChecksum(buffer) {
  buffer.fill(0x20, 148, 156);
  const sum = buffer.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  buffer.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return buffer;
}

test('parseTar reads a bounded regular ustar entry', () => {
  const entries = parseTar(tar([['project/file.txt', Buffer.from('hello')]]));
  assert.equal(entries.get('project/file.txt').data.toString(), 'hello');
});

test('parseTar rejects unsafe, duplicate, corrupt, truncated, and unsupported entries', () => {
  assert.throws(() => parseTar(tar([['../escape', Buffer.alloc(0)]])), { code: 'TAR_UNSAFE_PATH' });
  assert.throws(() => parseTar(tar([['p/a', Buffer.alloc(0)], ['p/a', Buffer.alloc(0)]])), { code: 'TAR_DUPLICATE_PATH' });
  const corrupt = tar([['p/a', Buffer.from('x')]]); corrupt[0] ^= 1;
  assert.throws(() => parseTar(corrupt), { code: 'TAR_CHECKSUM_MISMATCH' });
  assert.throws(() => parseTar(tar([['p/a', Buffer.from('x')]], false)), { code: 'TAR_TRUNCATED' });
  assert.throws(() => parseTar(tar([['p/a', Buffer.alloc(0), '2']])), { code: 'TAR_TYPE_UNSUPPORTED' });
  const linkName = tar([['p/a', Buffer.alloc(0)]]); linkName.write('target', 157); updateChecksum(linkName);
  assert.throws(() => parseTar(linkName), { code: 'TAR_HEADER_INVALID' });
  const prefix = tar([['p/a', Buffer.alloc(0)]]); prefix.write('hidden', 345); updateChecksum(prefix);
  assert.throws(() => parseTar(prefix), { code: 'TAR_HEADER_INVALID' });
});

test('parseTar enforces declared limits and valid padding', () => {
  const padded = tar([['p/a', Buffer.from('x')]]); padded[513] = 1;
  assert.throws(() => parseTar(padded), { code: 'TAR_PADDING_INVALID' });
  assert.throws(() => parseTar(tar([['p/a', Buffer.alloc(0)]]), { maxEntries: 0 }), { code: 'TAR_ENTRY_LIMIT' });
  assert.throws(() => parseTar(Buffer.alloc(1024), { maxBytes: 10 }), { code: 'TAR_SIZE_LIMIT' });
});

test('validateManifest rejects malformed fields, duplicate paths, and count mismatch', () => {
  const hash = crypto.createHash('sha256').update('x').digest('hex');
  const base = { schemaVersion: 1, project: 'p', version: '1', fileCount: 1, files: [{ path: 'a', bytes: 1, sha256: hash }] };
  assert.equal(validateManifest(base).get('a').bytes, 1);
  assert.throws(() => validateManifest({ ...base, fileCount: 2 }), { code: 'MANIFEST_INVALID' });
  assert.throws(() => validateManifest({ ...base, files: [...base.files, base.files[0]], fileCount: 2 }), { code: 'MANIFEST_INVALID' });
  assert.throws(() => validateManifest({ ...base, files: [{ ...base.files[0], path: '../a' }] }), { code: 'MANIFEST_INVALID' });
  assert.throws(() => validateManifest({ ...base, files: [{ ...base.files[0], sha256: 'no' }] }), { code: 'MANIFEST_INVALID' });
  assert.throws(() => validateManifest({ ...base, project: undefined }), { code: 'MANIFEST_INVALID' });
  assert.throws(() => validateManifest({ ...base, files: [{ ...base.files[0], path: undefined }] }), { code: 'MANIFEST_INVALID' });
});

test('verifySourceArchive compares archive, manifest, and eligible workspace bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-verify-'));
  const file = Buffer.from('source');
  const packageBytes = Buffer.from('{"name":"p","version":"1"}\n');
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    project: 'p',
    version: '1',
    fileCount: 2,
    files: [
      { path: 'file.txt', bytes: file.length, sha256: crypto.createHash('sha256').update(file).digest('hex') },
      { path: 'package.json', bytes: packageBytes.length, sha256: crypto.createHash('sha256').update(packageBytes).digest('hex') }
    ]
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'file.txt'), file);
  await fs.writeFile(path.join(root, 'package.json'), packageBytes);
  await fs.writeFile(path.join(root, 'SOURCE_MANIFEST.json'), manifest);
  await fs.mkdir(path.join(root, 'release'));
  const archivePath = path.join(root, 'release', 'source.tar.gz');
  await fs.writeFile(archivePath, gzipSync(tar([
    ['p-1/SOURCE_MANIFEST.json', manifest],
    ['p-1/file.txt', file],
    ['p-1/package.json', packageBytes]
  ])));
  const report = await verifySourceArchive({ root, archivePath });
  assert.equal(report.ok, true);
  assert.match(report.archiveSha256, /^[a-f0-9]{64}$/);
  await fs.writeFile(path.join(root, 'file.txt'), 'drift');
  await assert.rejects(verifySourceArchive({ root, archivePath }), { code: 'ARCHIVE_WORKSPACE_MISMATCH' });
});

test('verifySourceArchive rejects manifest identity differing from package metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-identity-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"actual","version":"1"}\n');
  const manifest = Buffer.from('{"schemaVersion":1,"project":"claimed","version":"1","fileCount":0,"files":[]}\n');
  await fs.writeFile(path.join(root, 'SOURCE_MANIFEST.json'), manifest);
  await fs.mkdir(path.join(root, 'release'));
  const archivePath = path.join(root, 'release', 'source.tar.gz');
  await fs.writeFile(archivePath, gzipSync(tar([['claimed-1/SOURCE_MANIFEST.json', manifest]])));
  await assert.rejects(verifySourceArchive({ root, archivePath }), { code: 'PROJECT_METADATA_MISMATCH' });
});
