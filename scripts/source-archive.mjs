import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { walkEligible } from './source-archive-verification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const outputDirectory = path.join(root, 'release');
const outputFile = path.join(outputDirectory, `${pkg.name}-${pkg.version}-source.tar.gz`);

function writeString(buffer, offset, length, value) {
  Buffer.from(String(value)).copy(buffer, offset, 0, length);
}
function writeOctal(buffer, offset, length, value) {
  const text = Math.max(0, Number(value)).toString(8).padStart(length - 1, '0').slice(-(length - 1)) + '\0';
  writeString(buffer, offset, length, text);
}
function header(name, size, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Archive path too long for portable ustar: ${name}`);
  const block = Buffer.alloc(512);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, mode & 0o777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = '0'.charCodeAt(0);
  writeString(block, 257, 6, 'ustar\0');
  writeString(block, 263, 2, '00');
  writeString(block, 265, 32, 'root');
  writeString(block, 297, 32, 'root');
  const checksum = [...block].reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0').slice(-6);
  writeString(block, 148, 8, `${checksumText}\0 `);
  return block;
}

const manifestFiles = (await walkEligible(root))
  .filter((file) => path.relative(root, file).split(path.sep).join('/') !== 'SOURCE_MANIFEST.json')
  .sort();
const manifest = {
  schemaVersion: 1,
  project: pkg.name,
  version: pkg.version,
  fileCount: manifestFiles.length,
  files: await Promise.all(manifestFiles.map(async (absolute) => {
    const data = await fs.readFile(absolute);
    return {
      path: path.relative(root, absolute).split(path.sep).join('/'),
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex')
    };
  }))
};
await fs.writeFile(path.join(root, 'SOURCE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const chunks = [];
for (const absolute of await walkEligible(root)) {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const stat = await fs.stat(absolute);
  const data = await fs.readFile(absolute);
  chunks.push(header(`${pkg.name}-${pkg.version}/${relative}`, data.length, stat.mode));
  chunks.push(data);
  const padding = (512 - (data.length % 512)) % 512;
  if (padding) chunks.push(Buffer.alloc(padding));
}
chunks.push(Buffer.alloc(1024));
await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(outputFile, gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }));
console.log(outputFile);
