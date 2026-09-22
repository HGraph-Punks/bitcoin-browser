import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySourceArchive } from './source-archive-verification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8'));
const archivePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', `${pkg.name}-${pkg.version}-source.tar.gz`);

try {
  console.log(JSON.stringify(await verifySourceArchive({ root, archivePath })));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? 'VERIFY_FAILED', message: error.message }));
  process.exitCode = 1;
}
