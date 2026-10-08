import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['node_modules', 'release', '.git', 'coverage']);

async function walk(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function relative(file) { return path.relative(root, file).split(path.sep).join('/'); }
function fail(message) { console.error(`FAIL  ${message}`); process.exitCode = 1; }
function pass(message) { console.log(`PASS  ${message}`); }

const required = [
  'package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'docs/BETA_TEST_PLAN.md',
  'src/main/index.js', 'src/main/preload.cjs', 'src/main/content-protocol.js', 'src/main/wallet-manager.js',
  'src/main/wallet-protocol.js',
  'src/renderer/index.html', 'src/renderer/app.js', 'src/renderer/views.js', 'src/renderer/inscription-display.js',
  'src/wallet/index.html', 'src/wallet/preload.cjs', 'src/wallet/wallet.js',
  'scripts/after-pack.cjs', 'scripts/after-sign.cjs', 'scripts/package.mjs', 'scripts/release-policy.mjs', 'scripts/packaged-smoke.mjs',
  'tests/navigation.test.js', 'tests/release-policy.test.js', '.github/workflows/ci.yml', '.github/workflows/release.yml'
];
for (const item of required) {
  try { await fs.access(path.join(root, item)); pass(`required file ${item}`); }
  catch { fail(`missing required file ${item}`); }
}

let pkg;
try {
  pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  pass('package.json parses');
} catch (error) { fail(`package.json invalid: ${error.message}`); }

if (pkg) {
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`${name} is not exactly pinned: ${version}`);
  }
  if (pkg.main !== 'src/main/index.js') fail('package main must point to the hardened Electron entrypoint');
  else pass('Electron main entrypoint configured');
  if (pkg.build?.asar !== true) fail('ASAR packaging is not enabled');
  else pass('ASAR packaging enabled');
}

const files = await walk(root);
const scripts = files.filter((file) => /\.(?:js|mjs|cjs)$/.test(file));
let syntaxFailures = 0;
for (const file of scripts) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (error) { syntaxFailures += 1; fail(`syntax ${relative(file)}: ${error.stderr?.toString().trim() || error.message}`); }
}
if (!syntaxFailures) pass(`${scripts.length} JavaScript files passed syntax checking`);

const sourceFiles = files.filter((file) => relative(file).startsWith('src/'));
const forbidden = [
  [/nodeIntegration\s*:\s*true/i, 'nodeIntegration enabled'],
  [/contextIsolation\s*:\s*false/i, 'context isolation disabled'],
  [/webSecurity\s*:\s*false/i, 'web security disabled'],
  [/allowRunningInsecureContent\s*:\s*true/i, 'insecure mixed content enabled'],
  [/enableRemoteModule\s*:\s*true/i, 'remote module enabled'],
  [/OutOfBlinkCors/i, 'Chromium CORS protections disabled'],
  [/sandbox\s*:\s*false/i, 'renderer sandbox disabled'],
  [/sandbox\s*(?::|=)\s*(?:\{\s*)?['"][^'"]{0,200}allow-same-origin/i, 'inscription frame would share an origin']
];
for (const file of sourceFiles) {
  if (!/\.(?:js|cjs|mjs|html)$/.test(file)) continue;
  const text = await fs.readFile(file, 'utf8');
  for (const [pattern, description] of forbidden) if (pattern.test(text)) fail(`${description} in ${relative(file)}`);
}
if (!process.exitCode) pass('forbidden Electron and iframe security regressions absent');

const mainWindow = await fs.readFile(path.join(root, 'src/main/window.js'), 'utf8');
for (const [pattern, label] of [
  [/nodeIntegration\s*:\s*false/, 'nodeIntegration disabled'],
  [/contextIsolation\s*:\s*true/, 'context isolation enabled'],
  [/sandbox\s*:\s*true/, 'renderer sandbox enabled'],
  [/setWindowOpenHandler\(\(\)\s*=>\s*\(\{ action: 'deny' \}\)\)/, 'popup denial installed']
]) pattern.test(mainWindow) ? pass(label) : fail(`missing security invariant: ${label}`);

const contentView = await fs.readFile(path.join(root, 'src/renderer/inscription-display.js'), 'utf8');
if (!/sandbox:\s*'allow-scripts allow-forms allow-modals allow-pointer-lock'/.test(contentView)) fail('inscription iframe sandbox policy is missing or changed');
else pass('inscription iframe uses explicit opaque sandbox policy');

const indexSource = await fs.readFile(path.join(root, 'src/main/index.js'), 'utf8');
if (!/setPermissionRequestHandler[\s\S]*callback\(false\)/.test(indexSource)) fail('application session does not deny permissions');
else pass('application session denies web permissions');
if (!/APP_PARTITION[\s\S]*WALLET_PARTITION/.test(indexSource)) fail('application and wallet storage partitions are not both configured');
else pass('wallet and browser partitions are separate');
if (!/appSession\.on\(['"]will-download['"][\s\S]*event\.preventDefault\(\)/.test(indexSource)) fail('untrusted content downloads are not denied');
else pass('untrusted content downloads are denied');

const packageSource = await fs.readFile(path.join(root, 'scripts/package.mjs'), 'utf8');
const releasePolicy = await fs.readFile(path.join(root, 'scripts/release-policy.mjs'), 'utf8');
const afterSignSource = await fs.readFile(path.join(root, 'scripts/after-sign.cjs'), 'utf8');
if (!/createPackagingPlan/.test(packageSource) || !/SATOSHI_BROWSER_REQUIRE_NOTARIZATION/.test(releasePolicy) || !/forceCodeSigning=true/.test(releasePolicy)) fail('macOS distribution does not fail closed on missing notarization policy');
else pass('macOS distribution requires notarization policy');
if (!afterSignSource.includes("['stapler', 'staple'") || !afterSignSource.includes("['stapler', 'validate'") || !/spctl/.test(afterSignSource)) fail('post-sign macOS notarization, stapling, and Gatekeeper verification are incomplete');
else pass('post-sign notarization ticket and Gatekeeper checks installed');

const preload = await fs.readFile(path.join(root, 'src/main/preload.cjs'), 'utf8');
if (!/contextBridge\.exposeInMainWorld/.test(preload) || /require\(['"](?:fs|child_process|net|http)/.test(preload)) fail('preload bridge is missing or exposes direct Node capabilities');
else pass('preload exposes only IPC facade');

const suspiciousNames = files.filter((file) => /(?:^|\/)(?:\.env|id_rsa|wallet\.dat|\.cookie|seed\.txt)$/i.test(relative(file)));
if (suspiciousNames.length) fail(`sensitive files present: ${suspiciousNames.map(relative).join(', ')}`);
else pass('no known secret-bearing files included');

const htmlFiles = files.filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const text = await fs.readFile(file, 'utf8');
  if (/<webview\b/i.test(text)) fail(`webview tag found in ${relative(file)}`);
}
if (!process.exitCode) pass('no Electron webview tags included');

if (process.exitCode) {
  console.error('\nVerification failed.');
  process.exit(process.exitCode);
}
console.log(`\nVerification complete: ${files.length} files inspected.`);
