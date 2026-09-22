import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Format conversion only: preserve the owner's artwork, transparency and aspect
// ratio. Use the existing pinned packager's converter, not a new dependency.
const require = createRequire(import.meta.url);
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons.js');
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--marketing'].includes(arg))) throw new Error('Only --check and --marketing are supported');
const check = args.includes('--check');
const source = path.join(root, 'bitcoin-browser-logo.png');
const png = await fs.readFile(source);
if (png.length < 33 || png.length > 8 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
  throw new Error('The application logo must be a bounded PNG');
}
const size = png.readUInt32BE(16);
if (size !== png.readUInt32BE(20) || size < 1024 || size > 4096) throw new Error('Use a square application logo between 1024 and 4096 pixels');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcoin-browser-icons-'));
try {
  for (const outputFormat of ['icns', 'ico', 'set']) {
    await runIconsTool({ inputFile: source, outputFormat, outDir: temporary });
  }
  const ui = await fs.readFile(path.join(temporary, '256x256.png'));
  const desktop = await fs.readFile(path.join(temporary, '512x512.png'));
  // This compatibility SVG embeds the supplied PNG, not vectorized artwork.
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${png.toString('base64')}"/></svg>\n`);
  const outputs = new Map([
    ['build/icon.icns', await fs.readFile(path.join(temporary, 'icon.icns'))],
    ['build/icon.ico', await fs.readFile(path.join(temporary, 'icon.ico'))],
    ['build/icon.png', desktop], ['build/icon.svg', svg],
    ['src/renderer/assets/bitcoin-browser-logo.png', ui],
    ['src/wallet/bitcoin-browser-logo.png', ui]
  ]);
  if (args.includes('--marketing')) {
    outputs.set('docs/landing-page-handoff/assets/bitcoin-browser-icon.png', png);
    outputs.set('docs/landing-page-handoff/assets/bitcoin-browser-icon.svg', svg);
  }
  for (const [relative, bytes] of outputs) {
    const destination = path.join(root, relative);
    if (check) {
      if (!(await fs.readFile(destination)).equals(bytes)) throw new Error(`Stale application logo: ${relative}. Run npm run build:icons${args.includes('--marketing') ? ' -- --marketing' : ''}.`);
    } else {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
    }
    console.log(`${check ? 'Verified' : 'Generated'} ${relative}`);
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
