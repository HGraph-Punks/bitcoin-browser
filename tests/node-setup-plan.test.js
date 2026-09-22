import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';

function draft(network = 'mainnet') {
  const value = defaultNodeSetupDraft({ rootDirectory: '/owned/node setup', network });
  value.core.executable = '/owned/bin/bitcoind'; value.ord.executable = '/owned/bin/ord';
  return value;
}
const invalid = value => assert.throws(() => buildNodeSetupPlan(value), { code: 'INVALID_NODE_SETUP', status: 400 });

test('defaults are detached, archival both-node plans with no automatic service start', () => {
  const a = defaultNodeSetupDraft({ rootDirectory: '/owned/root' });
  assert.equal(a.choice, 'both'); assert.equal(a.network, 'mainnet'); assert.equal(a.core.storage, 'archive');
  assert.equal(a.core.executable, ''); assert.equal(a.autoStart, false); invalid(a);
  const d = draft(); d.autoStart = true; const before = structuredClone(d); const p = buildNodeSetupPlan(d);
  assert.deepEqual(d, before); assert.equal(p.draft.autoStart, true);
  assert.deepEqual(p.services.map(s => s.autoStart), [false, false]);
  assert.deepEqual(p.directories, ['/owned/node setup/core-mainnet', '/owned/node setup/ord-mainnet']);
  assert.equal(p.files.length, 2); assert.ok(p.files.every(f => f.content.startsWith('# Managed by Satoshi Browser')));
  p.draft.core.storage = 'pruned'; assert.equal(d.core.storage, 'archive');
  assert.match(p.warnings.join(' '), /not a node P2P firewall/); assert.ok(p.requiredBytes > 1024 ** 4);
});

test('all four routes create only requested managed services and providers', () => {
  for (const [selected, count] of [['both', 2], ['core', 1], ['none', 0]]) {
    const d = draft(); d.choice = selected; const p = buildNodeSetupPlan(d);
    assert.equal(p.services.length, count); assert.equal(p.providers.length, count);
    if (selected === 'none') { assert.equal(p.requiredBytes, 0); assert.deepEqual(p.files, []); }
  }
  const d = draft(); d.choice = 'ord'; d.core.cookieFile = '/owned/existing/.cookie';
  const p = buildNodeSetupPlan(d);
  assert.equal(p.draft.core.mode, 'existing'); assert.equal(p.core.selected, false); assert.equal(p.core.managed, false);
  assert.deepEqual(p.services.map(s => s.id), ['guided-ord-mainnet']); assert.equal(p.providers.length, 1);
  assert.match(p.warnings.join(' '), /archival with txindex and REST/);
});

test('existing-only and mixed plans never install or launch existing tools', () => {
  const d = draft(); d.core.mode = 'existing'; d.core.cookieFile = '/owned/existing/.cookie'; d.ord.mode = 'existing';
  d.core.executable = ''; d.ord.executable = ''; d.core.rpcUrl = 'https://localhost:8443/'; d.ord.serverUrl = 'http://[::1]:8080/';
  const p = buildNodeSetupPlan(d); assert.deepEqual(p.services, []); assert.deepEqual(p.files, []);
  assert.equal(p.providers[0].cookieFile, '/owned/existing/.cookie'); assert.equal(p.summary.coreUrl, 'https://localhost:8443');
  assert.equal(p.summary.ordUrl, 'http://[::1]:8080');
  d.choice = 'ord'; d.core.cookieFile = ''; assert.equal(buildNodeSetupPlan(d).summary.coreUrl, null);
  const mixed = draft(); mixed.ord.mode = 'existing'; assert.deepEqual(buildNodeSetupPlan(mixed).services.map(s => s.id), ['guided-core-mainnet']);
});

test('network flags, RPC ports and actual network cookie subdirectories agree', () => {
  for (const [network, port, dir] of [['mainnet',8332,''],['testnet',18332,'testnet3/'],['signet',38332,'signet/'],['regtest',18443,'regtest/']]) {
    const p = buildNodeSetupPlan(draft(network)); const core = p.services[0], ord = p.services[1];
    assert.ok(core.args.includes(`-rpcport=${port}`)); assert.ok(core.args.includes('-rest=1'));
    assert.equal(p.providers[0].cookieFile, `/owned/node setup/core-${network}/${dir}.cookie`);
    assert.equal(ord.args[ord.args.indexOf('--chain')+1], network);
    assert.equal(ord.args[ord.args.indexOf('--cookie-file')+1], p.providers[0].cookieFile);
    if (network !== 'mainnet') assert.ok(core.args.includes(`-${network}=1`));
    assert.ok(!core.args.includes('-upnp=0'));
  }
});

test('pruned Core is explicit and cannot back managed Ord', () => {
  const d = draft(); d.core.storage = 'pruned'; invalid(d); d.choice = 'core';
  const p = buildNodeSetupPlan(d); assert.ok(p.services[0].args.includes('-prune=10000')); assert.ok(p.services[0].args.includes('-txindex=0'));
  assert.ok(!p.providers[0].capabilities.includes('transaction')); assert.ok(!p.providers[0].capabilities.includes('transaction-raw'));
  assert.ok(p.providers[0].capabilities.includes('block'));
});

test('selected ports reject coercion, privileged values and local bind collisions', () => {
  for (const value of ['8332', 1023, 65536, 8080.5, NaN]) { const d = draft(); d.core.rpcPort = value; invalid(d); }
  const d = draft(); d.ord.httpPort = d.core.rpcPort; invalid(d);
  for (const value of [1024, 65535]) { const d = draft(); d.core.rpcPort = value; assert.equal(buildNodeSetupPlan(d).draft.core.rpcPort, value); }
});

test('existing endpoints accept only literal root loopback without credentials or arbitrary URL normalization', () => {
  for (const url of ['http://example.com:8332', 'http://127.1:8332', 'http://2130706433:8332', 'http://127.0.0.1:8332/a', 'http://localhost:8332/?x=1', 'http://u:p@localhost:8332', 'http://localhost:8332/#x', 'ftp://localhost:8332', 'http://localhost:8332/../', 'http://localhost:8332\\']) {
    const d = draft(); d.core.mode = 'existing'; d.core.cookieFile = '/owned/cookie'; d.core.rpcUrl = url; invalid(d);
  }
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) { const d = draft(); d.ord.mode = 'existing'; d.ord.serverUrl = `http://${host}:8080`; assert.ok(buildNodeSetupPlan(d).summary.ordUrl); }
  for (const url of ['http://localhost', 'http://localhost:80', 'https://127.0.0.1', 'https://[::1]:443']) {
    const d = draft(); d.ord.mode = 'existing'; d.ord.serverUrl = url;
    assert.equal(buildNodeSetupPlan(d).summary.ordUrl, new URL(url).origin);
    d.core.mode = 'existing'; d.core.cookieFile = '/owned/cookie'; d.core.rpcUrl = url;
    assert.equal(buildNodeSetupPlan(d).summary.coreUrl, new URL(url).origin);
  }
});

test('POSIX and Windows paths remain individual argv values, never shell command strings', () => {
  const d = draft(); d.core.executable = '/owned/bin with spaces/bitcoind';
  const p = buildNodeSetupPlan(d); assert.equal(p.services[0].executable, d.core.executable);
  assert.ok(p.services[0].args.includes('-datadir=/owned/node setup/core-mainnet'));
  const win = draft('signet'); win.rootDirectory = 'C:\\Owned Nodes'; win.core.executable = 'C:\\Tools\\bitcoind.exe'; win.ord.executable = 'C:\\Tools\\ord.exe';
  const w = buildNodeSetupPlan(win, { platform: 'win32' }); assert.equal(w.providers[0].cookieFile, 'C:\\Owned Nodes\\core-signet\\signet\\.cookie');
  for (const value of ['/', 'relative/path', ' ', '/owned/\0bad', '/owned/\narg']) { const d = draft(); d.rootDirectory = value; invalid(d); }
  win.rootDirectory = 'C:\\'; assert.throws(() => buildNodeSetupPlan(win, { platform: 'win32' }), { code: 'INVALID_NODE_SETUP' });
});

test('unknown fields, arbitrary args and malformed booleans are rejected without losing optional index intent', () => {
  const d = draft(); d.ord.indexSats = true; d.ord.indexRunes = true;
  const p = buildNodeSetupPlan(d); assert.ok(p.services[1].args.includes('--index-sats')); assert.ok(p.services[1].args.includes('--index-runes'));
  for (const mutate of [d => { d.args = ['--wallet']; }, d => { d.core.args = ['-rpcallowip=0.0.0.0/0']; }, d => { d.ord.indexSats = 'true'; }, d => { d.autoStart = 1; }, d => { d.network = 'arbitrary'; }, d => { d.core.cookieFile = ''; d.core.mode = 'existing'; }]) { const value = draft(); mutate(value); invalid(value); }
});

test('optional resource targets are validated and do not alter legacy plan defaults', () => {
  const d = draft(); const legacy = buildNodeSetupPlan(d);
  assert.equal(Object.hasOwn(legacy.draft.core, 'dbCacheMiB'), false);
  assert.equal(Object.hasOwn(legacy.draft.core, 'validationThreads'), false);
  assert.equal(legacy.services[0].args.some(arg => /^-(?:dbcache|par)=/.test(arg)), false);
  d.core.dbCacheMiB = 512; d.core.validationThreads = 2;
  const tuned = buildNodeSetupPlan(d);
  assert.deepEqual(tuned.services[0].args, [...legacy.services[0].args, '-dbcache=512', '-par=2']);
  assert.deepEqual(tuned.files, legacy.files); assert.deepEqual(tuned.warnings, legacy.warnings);
  delete d.core.dbCacheMiB; delete d.core.validationThreads; assert.deepEqual(buildNodeSetupPlan(d), legacy);
  for (const [key, values] of [['dbCacheMiB', [0, 63, 16385, '512', NaN, Infinity, 128.5, null]], ['validationThreads', [0, -1, 65, '2', NaN, Infinity, 2.5, null]]]) {
    for (const value of values) { const d = draft(); d.core[key] = value; invalid(d); }
  }
});
