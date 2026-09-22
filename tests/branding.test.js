import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAppProtocol } from '../src/main/app-protocol.js';
import { installWalletProtocol } from '../src/main/wallet-protocol.js';
import { APP_NAME, APP_PARTITION, WALLET_PARTITION, WALLET_ORIGIN, APP_SCHEME, CONTENT_SCHEME, DEEP_LINK_SCHEME } from '../src/shared/constants.js';
import { BETA_TARGETS, expectedAssets, draftReleaseArguments } from '../scripts/beta-release.mjs';
import { packagedExecutableCandidates } from '../scripts/packaged-executable.mjs';

const read = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const bytes = name => fs.readFileSync(new URL(`../${name}`, import.meta.url));
const pngSize = png => {
  assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

test('desktop and UI icon containers carry matching sizes of the supplied raster artwork', () => {
  const source = bytes('bitcoin-browser-logo.png');
  const [width, height] = pngSize(source);
  assert.equal(width, height); assert.ok(width >= 1024 && width <= 4096);
  const svg = read('build/icon.svg');
  assert.doesNotMatch(svg, /<text|<script|<foreignObject|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  assert.ok(Buffer.from(svg.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)[1], 'base64').equals(source));
  const ui = bytes('src/renderer/assets/bitcoin-browser-logo.png');
  assert.deepEqual(pngSize(ui), [256, 256]);
  assert.ok(ui.length < 200 * 1024);
  assert.ok(ui.equals(bytes('src/wallet/bitcoin-browser-logo.png')));
  assert.deepEqual(pngSize(bytes('build/icon.png')), [512, 512]);

  const ico = bytes('build/icon.ico');
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  const sizes = [];
  for (let index = 0; index < 7; index++) {
    const entry = 6 + index * 16, size = ico[entry] || 256;
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset >= 118 && offset + length <= ico.length);
    const frame = ico.subarray(offset, offset + length);
    assert.deepEqual(pngSize(frame), [size, size]);
    if (size === 256) assert.ok(frame.equals(ui));
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);

  const icns = bytes('build/icon.icns'), frames = new Map();
  assert.equal(icns.toString('ascii', 0, 4), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
  let offset = 8;
  while (offset < icns.length) {
    const size = icns.readUInt32BE(offset + 4);
    assert.ok(size >= 8 && offset + size <= icns.length);
    frames.set(icns.toString('ascii', offset, offset + 4), icns.subarray(offset + 8, offset + size));
    offset += size;
  }
  assert.deepEqual(pngSize(frames.get('ic10')), [1024, 1024]);
  assert.ok(frames.get('ic08').equals(ui));
  assert.ok(frames.get('ic09').equals(bytes('build/icon.png')));
  assert.equal(pkg.build.mac.icon, 'build/icon.icns');
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.linux.icon, 'build/icon.png');
});

test('shell, assistant and Wallet Bridge branding use only bundled product images', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /class="brand-mark app-logo"[^>]*src="\.\/assets\/bitcoin-browser-logo\.png"[^>]*alt=""/);
  assert.match(html, /rel="icon"[^>]*href="\.\/assets\/bitcoin-browser-logo\.png"/);
  assert.match(html, /href="\.\/branding\.css"/);
  assert.doesNotMatch(html, /class="brand-mark">₿/);
  const wallet = read('src/wallet/index.html');
  assert.match(wallet, /class="mark"[^>]*src="\.\/bitcoin-browser-logo\.png"[^>]*alt="Bitcoin Browser"/);
  assert.match(wallet, /rel="icon"[^>]*href="\.\/bitcoin-browser-logo\.png"/);
  assert.match(read('src/renderer/ai.js'), /applicationLogo\('ai-welcome-mark', 64\)/);
  assert.match(read('src/renderer/ai.js'), /applicationLogo\('ai-assistant-logo', 20\)/);
  assert.match(read('src/main/index.js'), /const iconPath = path\.join\(appRoot, 'src', 'renderer', 'assets', 'bitcoin-browser-logo\.png'\)/);
  assert.match(read('src/main/index.js'), /!app\.isPackaged && process\.platform === 'darwin'/);
});

test('both isolated app protocols serve the actual PNG without adding cross-origin asset authority', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let appHandler, walletHandler, forwarded = 0;
  installAppProtocol({ protocol: { handle: (_scheme, handler) => { appHandler = handler; } } }, root, null);
  installWalletProtocol({ protocol: { handle: (_scheme, handler) => { walletHandler = handler; } }, fetch: () => { forwarded++; throw new Error('Unexpected remote request'); } }, root, null);
  for (const [handler, url] of [[appHandler, 'app://app/renderer/assets/bitcoin-browser-logo.png'],
    [walletHandler, `${WALLET_ORIGIN}/bitcoin-browser-logo.png`]]) {
    const response = await handler(new Request(url));
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes('src/renderer/assets/bitcoin-browser-logo.png')));
  }
  assert.equal((await walletHandler(new Request(`${WALLET_ORIGIN}/renderer/assets/bitcoin-browser-logo.png`))).status, 404);
  assert.equal(forwarded, 0);
});

test('public branding agrees across shell, native title, Wallet Bridge and in-app About', () => {
  assert.equal(APP_NAME, 'Bitcoin Browser');
  assert.equal(pkg.build.productName, APP_NAME);
  assert.equal(pkg.build.protocols[0].name, `${APP_NAME} links`);
  const html = read('src/renderer/index.html');
  assert.match(html, /<title>Bitcoin Browser<\/title>/);
  assert.match(html, /aria-label="Bitcoin Browser home"/);
  assert.match(html, /class="brand-name">Bitcoin Browser<\/span>/);
  assert.match(read('src/main/window.js'), /title: APP_NAME/);
  assert.match(read('src/main/ipc.js'), /application: \{ name: APP_NAME,/);
  assert.match(read('src/main/wallet-manager.js'), /Wallet Bridge — Bitcoin Browser/);
  assert.match(read('src/wallet/wallet.js'), /Connect to Bitcoin Browser/);
  assert.match(read('src/renderer/about.js'), /pageHeader\('About', 'Bitcoin Browser'/);
});

test('rename preserves profile identity, app ID, wallet isolation and existing deep links', () => {
  // Electron's internal application name participates in default userData and
  // OS-integrated storage identity. Branding must not silently migrate it.
  assert.equal(pkg.name, 'satoshi-browser');
  assert.equal(JSON.parse(read('package-lock.json')).name, pkg.name);
  assert.equal(pkg.build.appId, 'org.satoshibrowser.desktop');
  assert.equal(Object.hasOwn(pkg, 'productName'), false);
  assert.equal(pkg.build.extraMetadata?.name, undefined);
  assert.equal(pkg.build.extraMetadata?.productName, undefined);
  assert.doesNotMatch(read('src/main/index.js'), /app\.setName\s*\(/);
  assert.equal(APP_PARTITION, 'persist:satoshi-browser-app');
  assert.equal(WALLET_PARTITION, 'persist:satoshi-browser-wallet');
  assert.equal(WALLET_ORIGIN, 'https://wallet.satoshi.invalid');
  assert.deepEqual([APP_SCHEME, CONTENT_SCHEME, DEEP_LINK_SCHEME], ['app', 'ord', 'satnav']);
  assert.deepEqual(pkg.build.protocols[0].schemes, ['satnav']);
  assert.match(read('src/main/node-setup-plan.js'), /'satoshi-browser\.conf'/);
  assert.match(read('src/main/node-setup-plan.js'), /'satoshi-browser\.yaml'/);
  assert.match(read('src/main/logger.js'), /'satoshi-browser\.jsonl'/);
});

test('all 18 release downloads and six native executable paths use the new brand', () => {
  assert.equal(pkg.build.linux.executableName, 'bitcoin-browser');
  const assets = expectedAssets(pkg.version);
  assert.equal(assets.length, 18); assert.ok(assets.every(name => name.startsWith('bitcoin-browser-')));
  const unsignedAssets = expectedAssets(pkg.version, BETA_TARGETS, 'unsigned-beta');
  assert.equal(unsignedAssets.length, 18);
  assert.ok(unsignedAssets.every(name => name.startsWith('bitcoin-browser-')));
  assert.ok(unsignedAssets.filter(name => name.includes('-windows-')).every(name => name.includes('-unsigned')));
  for (const target of BETA_TARGETS) {
    for (const candidate of packagedExecutableCandidates('/fixture', target.platform, target.arch)) {
      assert.equal(path.basename(candidate), target.platform === 'darwin' ? APP_NAME : target.platform === 'win32' ? `${APP_NAME}.exe` : 'bitcoin-browser');
    }
  }
  const args = draftReleaseArguments({ repository: 'fixture/browser', tag: `v${pkg.version}`, version: pkg.version,
    commit: 'a'.repeat(40), remoteCommit: 'a'.repeat(40), directory: '/fixture', notes: '/fixture/notes.md', assets });
  assert.equal(args[args.indexOf('--title') + 1], `Bitcoin Browser ${pkg.version} — early beta`);
  const verifier = read('scripts/verify-windows-signatures.ps1');
  assert.match(verifier, /Bitcoin Browser\.exe/);
  assert.match(verifier, /bitcoin-browser-\$version-windows-\$Architecture\$qualifier-setup\.exe/);
  assert.match(verifier, /bitcoin-browser-\$version-windows-\$Architecture\$qualifier-portable\.exe/);
  assert.match(verifier, /\$qualifier = '-unsigned'/);
  assert.match(verifier, /\$qualifier = ''/);
});
