import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../shared/errors.js';
import { CORE_SNAPSHOT_BASES } from '../shared/node-snapshot.js';

const fail = message => new AppError('NODE_SNAPSHOT_FILE_INVALID', message, { status: 400 });
export async function inspectSnapshotFile(filename) {
  if (typeof filename !== 'string' || filename.length > 2048 || !path.isAbsolute(filename) || /[\x00-\x1f\x7f]/.test(filename)) throw fail('Choose a local snapshot file using the file picker.');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 51 || stat.size > 64 * 1024 ** 3) throw fail('Choose an uncompressed Core UTXO snapshot, not a folder, link or archive (maximum 64 GiB).');
  const canonical = await fs.realpath(filename);
  const file = await fs.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const current = await file.stat();
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw fail('The snapshot changed while it was selected. Choose it again.');
    const buffer = Buffer.alloc(51);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== 51 || !buffer.subarray(0, 5).equals(Buffer.from([0x75, 0x74, 0x78, 0x6f, 0xff]))) throw fail('This is not a Core UTXO snapshot. It must be downloaded and decompressed first.');
    if (buffer.readUInt16LE(5) !== 2) throw fail('This snapshot format is not supported by the reviewed Core 31 workflow.');
    if (buffer.subarray(7, 11).toString('hex') !== 'f9beb4d9') throw fail('Quick start currently supports mainnet snapshots only.');
    const baseHash = Buffer.from(buffer.subarray(11, 43)).reverse().toString('hex');
    const base = CORE_SNAPSHOT_BASES.find(row => row.hash === baseHash);
    if (!base) throw fail('This snapshot base is not in the reviewed Core 31 catalog. Use a supported snapshot; do not alter Core commitments.');
    const coins = buffer.readBigUInt64LE(43);
    if (coins === 0n || coins > 1_000_000_000n) throw fail('The snapshot has an invalid or unsupported coin count.');
    return { path: canonical, name: path.basename(canonical), bytes: current.size, baseHeight: base.height, baseHash, coins: coins.toString(),
      identity: { dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs } };
  } finally { await file.close(); }
}
