import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeOrdPath, parseRange, RecursiveResolver } from '../src/main/resolver.js';
import { DiskCache } from '../src/main/cache.js';
import { AppError } from '../src/shared/errors.js';

function withStableRouting(manager) {
  return {
    captureRouting: () => Object.freeze({ revision: 0, fingerprint: 'fixture' }),
    assertRouting: () => {},
    ...manager
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function resolverSettings(overrides = {}) {
  return {
    network: 'mainnet', preferredProviderId: null, offlineMode: false, maxConcurrentContentRequests: 2,
    cacheMaxBytes: 1024 * 1024, maxResourceBytes: 1024, requestTimeoutMs: 5000,
    maxRecursionDepth: 4, maxRecursionNodes: 10, maxGraphBytes: 4096,
    ...overrides
  };
}

function mutableRoutingManager(manager = {}) {
  let revision = 0;
  return {
    captureRouting: () => Object.freeze({ revision }),
    assertRouting(snapshot) {
      if (snapshot.revision !== revision) {
        throw new AppError('ROUTING_INVALIDATED', 'Fixture routing changed', { status: 409, retryable: true });
      }
    },
    invalidate: () => { revision += 1; },
    ...manager
  };
}

function stateFor(settings) {
  return { get(pathSegments) { return pathSegments[0] === 'settings' ? structuredClone(settings) : null; } };
}

function fetched(body = 'fixture', contentType = 'text/plain') {
  return {
    response: { status: 200, headers: { 'content-type': contentType }, data: Buffer.from(body) },
    provider: { id: 'mock', name: 'Mock' },
    attempts: [{ providerId: 'mock', ok: true }]
  };
}

function cacheObjectName(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const stagingUuid = '12345678-1234-4123-8123-123456789abc';

test('normalizes only safe ord recursive paths', () => {
  const id = `${'1'.repeat(64)}i0`;
  assert.equal(normalizeOrdPath(`/content/${id}`), `/content/${id}`);
  assert.equal(normalizeOrdPath('ord://r/blockheight'), '/r/blockheight');
  assert.equal(normalizeOrdPath('/r/children/foo?x=1'), '/r/children/foo?x=1');
  assert.throws(() => normalizeOrdPath('/r/../secret'), { code: 'UNSAFE_ORD_PATH' });
  assert.throws(() => normalizeOrdPath('https://example.com'), { code: 'UNSAFE_ORD_PATH' });
});

test('parses byte ranges defensively', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=100-101', 100), { invalid: true });
  assert.deepEqual(parseRange('items=0-1', 100), { invalid: true });
});

test('disk cache persists integrity metadata and supports stale reads', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  await cache.put('key', Buffer.from('hello'), { headers: { 'content-type': 'text/plain' }, provenance: { providerId: 'mock' } }, 10_000);
  const hit = await cache.get('key');
  assert.equal(hit.data.toString(), 'hello');
  assert.equal(hit.meta.provenance.providerId, 'mock');
  assert.equal(cache.stats().entries, 1);
});

test('disk cache rejects same-size object corruption', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-integrity-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  const stored = await cache.put('key', Buffer.from('hello'));
  await fs.writeFile(path.join(directory, 'objects', stored.id), 'jello');
  assert.equal(await cache.get('key'), null);
  assert.equal(cache.stats().entries, 0);
});

test('startup removes only regular cache-shaped orphans when the index is missing or malformed', async (t) => {
  for (const [label, indexContents] of [['missing index', null], ['malformed index', '{invalid']]) {
    await t.test(label, async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-orphan-test-'));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const objects = path.join(directory, 'objects');
      await fs.mkdir(objects, { recursive: true });
      const unindexed = cacheObjectName(`${label}:object`);
      const temporary = `${cacheObjectName(`${label}:temporary`)}.123.${stagingUuid}.tmp`;
      const previous = `${cacheObjectName(`${label}:previous`)}.123.${stagingUuid}.previous`;
      const unrelated = 'operator-note.txt';
      const symlinkName = cacheObjectName(`${label}:symlink`);
      const stagingSymlinkName = `${cacheObjectName(`${label}:staging-symlink`)}.123.${stagingUuid}.tmp`;
      await Promise.all([
        fs.writeFile(path.join(objects, unindexed), 'unindexed'),
        fs.writeFile(path.join(objects, temporary), 'temporary'),
        fs.writeFile(path.join(objects, previous), 'previous'),
        fs.writeFile(path.join(objects, unrelated), 'unrelated')
      ]);
      await fs.symlink(unrelated, path.join(objects, symlinkName));
      await fs.symlink(unrelated, path.join(objects, stagingSymlinkName));
      if (indexContents !== null) await fs.writeFile(path.join(directory, 'index.json'), indexContents);

      const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
      await cache.init();
      const names = new Set(await fs.readdir(objects));
      assert.equal(names.has(unindexed), false);
      assert.equal(names.has(temporary), false);
      assert.equal(names.has(previous), false);
      assert.equal(names.has(unrelated), true);
      assert.equal(names.has(symlinkName), true);
      assert.equal(names.has(stagingSymlinkName), true);
      assert.equal((await fs.lstat(path.join(objects, symlinkName))).isSymbolicLink(), true);
      assert.equal((await fs.lstat(path.join(objects, stagingSymlinkName))).isSymbolicLink(), true);
      assert.equal(await fs.readFile(path.join(objects, unrelated), 'utf8'), 'unrelated');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')), {});
    });
  }
});

test('startup repairs interrupted same-key replacement windows conservatively', async (t) => {
  for (const crashWindow of ['old-moved', 'new-installed']) {
    await t.test(crashWindow, async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-replacement-window-'));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
      await cache.init();
      const stored = await cache.put('key', Buffer.from('old payload'));
      const objectPath = path.join(directory, 'objects', stored.id);
      const previousName = `${stored.id}.123.${stagingUuid}.previous`;
      await fs.rename(objectPath, path.join(directory, 'objects', previousName));
      if (crashWindow === 'new-installed') await fs.writeFile(objectPath, 'new payload');

      const restarted = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
      await restarted.init();
      assert.equal(await restarted.get('key'), null);
      assert.equal((await fs.readdir(path.join(directory, 'objects'))).includes(previousName), false);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8')), {});
    });
  }
});

test('startup keeps a verified indexed object and removes its leftover previous staging file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-valid-with-previous-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  await cache.init();
  const stored = await cache.put('key', Buffer.from('current payload'), { version: 'current' });
  const previousName = `${stored.id}.123.${stagingUuid}.previous`;
  await fs.writeFile(path.join(directory, 'objects', previousName), 'old payload');

  const restarted = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  await restarted.init();
  const hit = await restarted.get('key');
  assert.equal(hit.data.toString(), 'current payload');
  assert.equal(hit.meta.version, 'current');
  assert.equal((await fs.readdir(path.join(directory, 'objects'))).includes(previousName), false);
});

test('disk cache serializes concurrent writes to the same key', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-concurrency-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  await Promise.all(Array.from({ length: 25 }, (_, sequence) => cache.put('key', Buffer.from(`value-${sequence}`), { sequence })));
  const hit = await cache.get('key');
  assert.equal(hit.data.toString(), 'value-24');
  assert.equal(hit.meta.sequence, 24);
  await cache.flush();
  const restarted = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  await restarted.init();
  const persisted = await restarted.get('key');
  assert.equal(persisted.data.toString(), 'value-24');
  assert.equal(persisted.meta.sequence, 24);
});

test('cache serializes reads with same-key replacements without deleting the valid replacement', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-read-write-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  await cache.put('key', Buffer.from('initial'), { sequence: -1 });
  const operations = [];
  for (let sequence = 0; sequence < 20; sequence += 1) {
    operations.push(cache.get('key'));
    operations.push(cache.put('key', Buffer.from(`replacement-${sequence}`), { sequence }));
  }
  await Promise.all(operations);
  const current = await cache.get('key');
  assert.equal(current.data.toString(), 'replacement-19');
  assert.equal(current.meta.sequence, 19);
  await cache.flush();
  const restarted = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  await restarted.init();
  const persisted = await restarted.get('key');
  assert.equal(persisted.data.toString(), 'replacement-19');
  assert.equal(persisted.meta.sequence, 19);
});

test('invalidated queued cache writes publish no reusable payload', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-invalidated-queue-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  const entered = deferred();
  const release = deferred();
  let valid = true;
  let calls = 0;
  const validate = async () => {
    calls += 1;
    if (calls === 1) {
      entered.resolve();
      await release.promise;
    }
    if (!valid) throw new AppError('ROUTING_INVALIDATED', 'Fixture routing changed', { status: 409, retryable: true });
  };
  const first = cache.put('first', Buffer.from('obsolete-first'), {}, null, { validate });
  const second = cache.put('second', Buffer.from('obsolete-second'), {}, null, { validate });
  await entered.promise;
  valid = false;
  release.resolve();
  await assert.rejects(first, { code: 'ROUTING_INVALIDATED' });
  await assert.rejects(second, { code: 'ROUTING_INVALIDATED' });
  assert.equal(await cache.get('first'), null);
  assert.equal(await cache.get('second'), null);
  assert.equal(cache.stats().entries, 0);
});

test('invalidation after blob installation rolls back the serialized cache mutation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-invalidated-commit-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  const installed = deferred();
  const release = deferred();
  let valid = true;
  let validations = 0;
  const validate = async () => {
    validations += 1;
    if (validations === 3) {
      installed.resolve();
      await release.promise;
    }
    if (!valid) throw new AppError('ROUTING_INVALIDATED', 'Fixture routing changed', { status: 409, retryable: true });
  };
  const pending = cache.put('key', Buffer.from('obsolete payload'), {}, null, { validate });
  await installed.promise;
  valid = false;
  release.resolve();
  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.equal(await cache.get('key'), null);
  await cache.flush();
  const restarted = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  await restarted.init();
  assert.equal(await restarted.get('key'), null);
});

test('disk cache prunes immediately when its configured limit shrinks', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-cache-prune-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  await cache.put('first', Buffer.alloc(50));
  await cache.put('second', Buffer.alloc(50));
  await cache.configure({ maxBytes: 60, maxEntryBytes: 1024 });
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().bytes, 50);
});

test('recursive resolver serves cached ranges without contacting providers', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-resolver-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  const settings = {
    network: 'mainnet', preferredProviderId: null, offlineMode: false, maxConcurrentContentRequests: 2,
    cacheMaxBytes: 1024 * 1024, maxResourceBytes: 1024, requestTimeoutMs: 5000,
    maxRecursionDepth: 4, maxRecursionNodes: 10, maxGraphBytes: 1024
  };
  let fetches = 0;
  const providerManager = withStableRouting({
    async fetchOrdPath() {
      fetches += 1;
      return { response: { status: 200, headers: { 'content-type': 'text/plain' }, data: Buffer.from('0123456789') }, provider: { id: 'mock', name: 'Mock' }, attempts: [{ providerId: 'mock', ok: true }] };
    }
  });
  const stateStore = { get(pathSegments) { return pathSegments[0] === 'settings' ? structuredClone(settings) : null; } };
  const resolver = new RecursiveResolver(providerManager, cache, stateStore, null);
  const first = await resolver.resolve('/r/test');
  assert.equal(first.data.toString(), '0123456789');
  const range = await resolver.resolve('/r/test', { range: 'bytes=2-5' });
  assert.equal(range.status, 206);
  assert.equal(range.data.toString(), '2345');
  assert.equal(fetches, 1);
});

test('graph inspection validates caller limits and enforces one aggregate byte budget', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-graph-budget-test-'));
  const cache = new DiskCache(directory, { maxBytes: 1024 * 1024, maxEntryBytes: 1024 }, null);
  t.after(async () => { await cache.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  await cache.init();
  const firstId = `${'2'.repeat(64)}i0`;
  const secondId = `${'3'.repeat(64)}i0`;
  const rootId = `${'1'.repeat(64)}i0`;
  const rootBody = Buffer.from(`<a href="/content/${firstId}"></a><a href="/content/${secondId}"></a>`);
  const childBody = Buffer.from('child-resource');
  const settings = {
    network: 'mainnet', preferredProviderId: null, offlineMode: false, maxConcurrentContentRequests: 2,
    cacheMaxBytes: 1024 * 1024, maxResourceBytes: 1024, requestTimeoutMs: 5000,
    maxRecursionDepth: 4, maxRecursionNodes: 10, maxGraphBytes: rootBody.length + childBody.length - 1
  };
  const fetchedLimits = [];
  const providerManager = withStableRouting({
    async fetchOrdPath(resourcePath, options) {
      const data = resourcePath === `/content/${rootId}` ? rootBody : childBody;
      fetchedLimits.push({ path: resourcePath, maxBytes: options.maxBytes });
      return { response: { status: 200, headers: { 'content-type': 'text/html' }, data }, provider: { id: 'mock', name: 'Mock' }, attempts: [] };
    }
  });
  const stateStore = { get(pathSegments) { return pathSegments[0] === 'settings' ? structuredClone(settings) : null; } };
  const resolver = new RecursiveResolver(providerManager, cache, stateStore, null);

  await assert.rejects(resolver.inspectGraph(rootId, { maxDepth: '2' }), { code: 'VALIDATION_ERROR', status: 400 });
  await assert.rejects(resolver.inspectGraph(rootId, { maxNodes: 0 }), { code: 'VALIDATION_ERROR', status: 400 });
  const graph = await resolver.inspectGraph(rootId);

  assert.equal(graph.truncated, true);
  assert.equal(graph.totalBytes, rootBody.length);
  assert.ok(graph.totalBytes <= graph.limits.maxBytes);
  assert.deepEqual(fetchedLimits, [
    { path: `/content/${rootId}`, maxBytes: settings.maxGraphBytes },
    { path: `/content/${firstId}`, maxBytes: childBody.length - 1 },
    { path: `/content/${secondId}`, maxBytes: childBody.length - 1 }
  ]);
  assert.equal(graph.nodes.filter((node) => node.error?.code === 'RESOURCE_TOO_LARGE').length, 2);
});

test('routing changes during cache configuration stop a queued request before lookup or network', async () => {
  const settings = resolverSettings();
  const configured = deferred();
  let cacheGets = 0;
  let fetches = 0;
  const cache = {
    configure: () => configured.promise,
    get: async () => { cacheGets += 1; return null; },
    put: async () => {}
  };
  const manager = mutableRoutingManager({ fetchOrdPath: async () => { fetches += 1; return fetched(); } });
  const resolver = new RecursiveResolver(manager, cache, stateFor(settings), null);
  const pending = resolver.resolve('/r/blockheight');
  settings.network = 'testnet';
  manager.invalidate();
  configured.resolve();
  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED', status: 409, retryable: true });
  assert.equal(cacheGets, 0);
  assert.equal(fetches, 0);
});

test('routing changes during delayed cache hits prevent stale result publication', async () => {
  const settings = resolverSettings();
  const lookup = deferred();
  const cache = {
    configure: async () => {},
    get: () => lookup.promise,
    put: async () => {}
  };
  const manager = mutableRoutingManager({ fetchOrdPath: async () => { throw new Error('network should not run'); } });
  const resolver = new RecursiveResolver(manager, cache, stateFor(settings), null);
  const pending = resolver.resolve('/r/blockheight');
  manager.invalidate();
  lookup.resolve({ data: Buffer.from('old epoch'), meta: { headers: {}, provenance: {} }, stale: false });
  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
});

test('in-flight fetches use the captured network and cannot write or return after routing changes', async () => {
  const settings = resolverSettings();
  const response = deferred();
  const fetchStarted = deferred();
  const observedNetworks = [];
  let cacheWrites = 0;
  const cache = {
    configure: async () => {},
    get: async () => null,
    put: async () => { cacheWrites += 1; }
  };
  const manager = mutableRoutingManager({
    fetchOrdPath: async (_path, options) => {
      observedNetworks.push(options.network);
      fetchStarted.resolve();
      return response.promise;
    }
  });
  const resolver = new RecursiveResolver(manager, cache, stateFor(settings), null);
  const pending = resolver.resolve('/r/blockheight');
  await fetchStarted.promise;
  settings.network = 'testnet';
  manager.invalidate();
  response.resolve(fetched('old network'));
  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.deepEqual(observedNetworks, ['mainnet']);
  assert.equal(cacheWrites, 0);
});

test('canceling a semaphore waiter neither starts its fetch nor leaks capacity', async () => {
  const settings = resolverSettings({ maxConcurrentContentRequests: 1 });
  const firstResponse = deferred();
  const firstStarted = deferred();
  const fetchedPaths = [];
  const cache = { configure: async () => {}, get: async () => null, put: async () => {} };
  const manager = mutableRoutingManager({
    fetchOrdPath: async (resourcePath) => {
      fetchedPaths.push(resourcePath);
      if (resourcePath === '/r/first') {
        firstStarted.resolve();
        return firstResponse.promise;
      }
      return fetched(resourcePath);
    }
  });
  const resolver = new RecursiveResolver(manager, cache, stateFor(settings), null);
  const first = resolver.resolve('/r/first');
  await firstStarted.promise;
  const controller = new AbortController();
  const canceled = resolver.resolve('/r/canceled', { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new AppError('REQUEST_ABORTED', 'Fixture cancellation', { status: 499 }));
  await assert.rejects(canceled, { code: 'REQUEST_ABORTED' });
  firstResponse.resolve(fetched('first'));
  await first;
  const third = await resolver.resolve('/r/third');
  assert.equal(third.data.toString(), '/r/third');
  assert.deepEqual(fetchedPaths, ['/r/first', '/r/third']);
  assert.equal(resolver.semaphore.active, 0);
  assert.equal(resolver.semaphore.waiting.length, 0);
});

test('a routing change prevents a semaphore waiter from starting obsolete network work', async () => {
  const settings = resolverSettings({ maxConcurrentContentRequests: 1 });
  const firstResponse = deferred();
  const firstStarted = deferred();
  const fetchedPaths = [];
  const cache = { configure: async () => {}, get: async () => null, put: async () => {} };
  const manager = mutableRoutingManager({
    fetchOrdPath: async (resourcePath) => {
      fetchedPaths.push(resourcePath);
      firstStarted.resolve();
      return firstResponse.promise;
    }
  });
  const resolver = new RecursiveResolver(manager, cache, stateFor(settings), null);
  const first = resolver.resolve('/r/first');
  await firstStarted.promise;
  const queued = resolver.resolve('/r/queued');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolver.semaphore.waiting.length, 1);
  settings.network = 'testnet';
  manager.invalidate();
  firstResponse.resolve(fetched('obsolete'));
  await assert.rejects(first, { code: 'ROUTING_INVALIDATED' });
  await assert.rejects(queued, { code: 'ROUTING_INVALIDATED' });
  assert.deepEqual(fetchedPaths, ['/r/first']);
  assert.equal(resolver.semaphore.active, 0);
});

test('graph inspection propagates routing invalidation and stops obsolete traversal', async () => {
  const rootId = `${'a'.repeat(64)}i0`;
  const childId = `${'b'.repeat(64)}i0`;
  const childResponse = deferred();
  const childStarted = deferred();
  const fetchedPaths = [];
  const settings = resolverSettings();
  const cache = { configure: async () => {}, get: async () => null, put: async () => {} };
  const manager = mutableRoutingManager({
    fetchOrdPath: async (resourcePath) => {
      fetchedPaths.push(resourcePath);
      if (resourcePath === `/content/${rootId}`) return fetched(`/content/${childId}`, 'text/html');
      childStarted.resolve();
      return childResponse.promise;
    }
  });
  const resolver = new RecursiveResolver(manager, cache, stateFor(settings), null);
  const pending = resolver.inspectGraph(rootId);
  await childStarted.promise;
  manager.invalidate();
  childResponse.resolve(fetched('child', 'text/plain'));
  await assert.rejects(pending, { code: 'ROUTING_INVALIDATED' });
  assert.deepEqual(fetchedPaths, [`/content/${rootId}`, `/content/${childId}`]);
});
