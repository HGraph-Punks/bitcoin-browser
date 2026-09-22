import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EASY_NODE_SPACE, inspectNodeCapacity, recommendEasyNode } from '../src/main/node-capacity.js';

const GiB = 1024 ** 3;
const capacity = { rootDirectory: '/fixture/nodes', availableBytes: 100 * GiB, writable: true, memoryBytes: 8 * GiB, logicalCpus: 8, platform: 'linux', arch: 'x64', osSupported: true };
const descriptor = { version: '31.1' };

test('capacity check reads only aggregate OS values and ancestor filesystem metadata', async () => {
  const calls = [];
  const parent = path.join(path.parse(process.cwd()).root, 'selected'), selected = path.join(parent, 'nodes'), actual = path.join(path.parse(process.cwd()).root, 'actual', 'volume');
  const filesystem = {
    stat: async directory => { calls.push(['stat', directory]); if (directory === selected) throw Object.assign(new Error(), { code: 'ENOENT' }); return { isDirectory: () => true }; },
    realpath: async directory => { calls.push(['realpath', directory]); return actual; },
    access: async directory => { calls.push(['access', directory]); },
    statfs: async directory => { calls.push(['statfs', directory]); return { bavail: 123n, bsize: 4096n }; }
  };
  const result = await inspectNodeCapacity(selected, { filesystem, platform: 'darwin', arch: 'arm64',
    system: { totalmem: () => 16 * GiB, availableParallelism: () => 10, release: () => '24.6.0' } });
  assert.equal(result.rootDirectory, path.join(actual, 'nodes')); assert.equal(result.availableBytes, 123 * 4096);
  assert.equal(result.memoryBytes, 16 * GiB); assert.equal(result.logicalCpus, 10); assert.equal(result.osSupported, true);
  assert.deepEqual(calls.map(row => row[0]), ['stat', 'stat', 'realpath', 'access', 'statfs']);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(capacity).sort());
});

test('real capacity inspection of a disposable missing folder creates no files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bitcoin-capacity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await inspectNodeCapacity(path.join(root, 'new-node', 'storage'));
  assert.ok(result.rootDirectory.endsWith(path.join('new-node', 'storage'))); assert.ok(result.availableBytes > 0);
  assert.equal(result.writable, true); assert.ok(result.memoryBytes > 0); assert.ok(result.logicalCpus > 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('inaccessible, read-only, unknown and unsafe paths never become a positive recommendation', async () => {
  for (const code of ['EACCES', 'EROFS', 'EIO']) {
    const result = await inspectNodeCapacity('/fixture/nodes', { filesystem: { stat: async () => { throw Object.assign(new Error(), { code }); } } });
    assert.equal(result.availableBytes, null); assert.equal(result.writable, false);
    assert.equal(recommendEasyNode(result, { descriptor }).eligible, false);
  }
  for (const directory of ['/', 'relative', '/unsafe\npath', null, {}, '']) await assert.rejects(inspectNodeCapacity(directory), { code: 'INVALID_NODE_SETUP' });
});

test('Core 31 documented OS baselines fail closed when unavailable or older', async () => {
  const filesystem = { stat: async () => ({ isDirectory: () => true }), realpath: async value => value, access: async () => {}, statfs: async () => ({ bavail: 100, bsize: GiB }) };
  for (const [platform, release, expected] of [
    ['darwin', '22.6.0', false], ['darwin', '23.0.0', true], ['linux', '3.16.9', false], ['linux', '3.17.0', true], ['linux', '6.8.0-custom', true],
    ['win32', '10.0.17763', false], ['win32', '10.0.18362', true], ['win32', '10.0.26100', true], ['freebsd', '14.0.0', false], ['darwin', 'unknown', false]
  ]) {
    const result = await inspectNodeCapacity('/fixture', { filesystem, platform, system: { totalmem: () => 4 * GiB, availableParallelism: () => 4, release: () => release } });
    assert.equal(result.osSupported, expected, `${platform} ${release}`);
  }
});

test('recommendation preserves compact storage on large disks and tunes only bounded resource targets', () => {
  for (const [memoryGiB, cache] of [[2, 256], [4, 256], [8, 512], [16, 1024], [128, 1024]]) {
    const result = recommendEasyNode({ ...capacity, memoryBytes: memoryGiB * GiB, availableBytes: 2048 * GiB, logicalCpus: 128 }, { descriptor });
    assert.equal(result.eligible, true); assert.equal(result.recommendedBytes, EASY_NODE_SPACE);
    assert.equal(result.archiveFits, true); assert.equal(result.dbCacheMiB, cache); assert.equal(result.validationThreads, 4);
  }
  const small = recommendEasyNode({ ...capacity, memoryBytes: 2 * GiB, logicalCpus: 1 }, { descriptor });
  assert.equal(small.slower, true); assert.equal(small.validationThreads, 1); assert.equal(small.eligible, true);
});

test('unknown or insufficient capacity, unsupported downloads, privacy and existing setup explain blockers', () => {
  for (const patch of [{ memoryBytes: null }, { memoryBytes: GiB }, { logicalCpus: null }, { availableBytes: null }, { availableBytes: EASY_NODE_SPACE - 1 }, { writable: false }, { osSupported: false }]) {
    const result = recommendEasyNode({ ...capacity, ...patch }, { descriptor });
    assert.equal(result.eligible, false); assert.ok(result.reasons.length > 0);
  }
  for (const options of [{}, { descriptor, settings: { offlineMode: true } }, { descriptor, settings: { localOnly: true } }, { descriptor, existing: true }]) assert.equal(recommendEasyNode(capacity, options).eligible, false);
  assert.equal(recommendEasyNode({ ...capacity, availableBytes: EASY_NODE_SPACE }, { descriptor }).eligible, true);
});
