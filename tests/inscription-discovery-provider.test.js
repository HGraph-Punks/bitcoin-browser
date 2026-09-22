import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { OrdServerProvider } from '../src/main/providers/ord-server.js';
import { MockProvider } from '../src/main/providers/mock.js';
import { parseOrdListing } from '../src/main/providers/ord-discovery.js';
import { discoveryTarget } from '../src/shared/discovery.js';

const id = (n) => n.toString(16).padStart(64, '0') + 'i0';
const publicListing = await fs.readFile(new URL('./fixtures/ord-public-inscriptions.html', import.meta.url), 'utf8');
const response = (data, { status = 200, type = 'application/json', latencyMs = 1 } = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { 'content-type': type }, data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)), latencyMs
});
const config = (type = 'ord-server') => ({ id: 'fixture', name: 'Fixture', type, network: 'mainnet', baseUrl: 'http://127.0.0.1:1', enabled: true, priority: 1, local: true, capabilities: ['inscription'] });

class FixtureOrd extends OrdServerProvider {
  constructor(routes) { super(config()); this.routes = routes; this.calls = []; this.active = 0; this.maximum = 0; }
  async fetchPath(path, options) {
    this.calls.push({ path, options }); this.active++; this.maximum = Math.max(this.maximum, this.active);
    try {
      const value = this.routes.get(path);
      if (typeof value === 'function') return await value(options, this);
      if (value instanceof Error) throw value;
      if (!value) throw Object.assign(new Error(`Missing fixture route ${path}`), { code: 'NOT_FOUND' });
      return value;
    } finally { this.active--; }
  }
}

function metadataRoutes(count = 100, overrides = new Map()) {
  const routes = new Map();
  for (let n = 0; n < count; n++) routes.set(`/r/inscription/${id(n)}`, overrides.get(n) ?? response({
    id: id(n), number: n, content_type: n % 2 ? 'text/plain' : 'image/png', content_length: 100 + n, height: 840000
  }));
  return routes;
}

test('JSON discovery returns bounded typed cards, subpages and canonical pagination', async () => {
  const routes = metadataRoutes();
  routes.set('/inscriptions/0', response({ ids: Array.from({ length: 100 }, (_, n) => id(n)), more: true }));
  const provider = new FixtureOrd(routes);
  const first = await provider.resolve(discoveryTarget(''));
  assert.equal(first.type, 'inscriptions'); assert.equal(first.data.items.length, 24);
  assert.deepEqual(first.data.items[0], { id: id(0), number: '0', contentType: 'image/png', contentLength: 100, height: 840000, sat: null, charms: null, timestamp: null, metadataUnavailable: false });
  assert.equal(first.data.next, 'satnav://inscriptions?offset=24'); assert.equal(first.data.previous, null);
  const fourth = await provider.resolve(discoveryTarget('offset=72'));
  assert.equal(fourth.data.items[0].id, id(72));
  assert.equal(fourth.data.next, 'satnav://inscriptions?offset=96');
  assert.equal(fourth.data.previous, 'satnav://inscriptions?offset=48');
  const remainder = await provider.resolve(discoveryTarget('offset=96'));
  assert.equal(remainder.data.items.length, 4);
  assert.equal(remainder.data.next, 'satnav://inscriptions?page=1');
  assert.ok(provider.maximum <= 4);
});

test('existing bounded metadata reads include sat, charms and date without more requests', async () => {
  const records = [
    { sat: 0, charms: ['mythic', 'palindrome', 'coin', 'mythic', '<script>', '__proto__'], timestamp: 1700000000 },
    { sat: '45000000000', charms: ['nineball'], timestamp: 0 },
    { sat: '2099999997690000', charms: 'rare', timestamp: -1 },
    { sat: {}, charms: Array(100).fill('rare'), timestamp: 0.5 }
  ];
  const routes = metadataRoutes(4, new Map(records.map((record, n) => [n, response({ id: id(n), number: n, ...record })])));
  routes.set('/inscriptions/0', response({ ids: records.map((_, n) => id(n)), more: false }));
  const provider = new FixtureOrd(routes), result = await provider.resolve(discoveryTarget(''));
  assert.equal(provider.calls.length, 5); assert.ok(provider.maximum <= 4);
  assert.deepEqual(result.data.items.map(item => item.sat), ['0', '45000000000', null, null]);
  assert.deepEqual(result.data.items.map(item => item.charms), [['mythic', 'palindrome', 'coin'], ['nineball'], null, ['rare']]);
  assert.deepEqual(result.data.items.map(item => item.timestamp), [1700000000, 0, null, null]);
  assert.ok(provider.calls.every(call => call.path.startsWith('/r/inscription/') || call.path === '/inscriptions/0'));
});

test('block discovery uses the documented route and retains block in page links', async () => {
  const routes = metadataRoutes(24);
  routes.set('/inscriptions/block/840000/2', response({ ids: Array.from({ length: 24 }, (_, n) => id(n)), more: true }));
  const result = await new FixtureOrd(routes).resolve(discoveryTarget('page=2&block=840000'));
  assert.equal(result.data.block, 840000);
  assert.equal(result.data.next, 'satnav://inscriptions?page=3&block=840000');
  assert.equal(result.data.previous, 'satnav://inscriptions?page=1&offset=96&block=840000');
});

test('real block HTML treats adjacent blocks separately from same-block pages and accepts empty blocks', async () => {
  const blockHtml = (block, body = `<a href=/inscription/${id(0)}><iframe src=/preview/${id(0)}></iframe></a>`, extra = '') => `<!doctype html><main>
    <h1>Inscriptions in <a href=/block/${block}>Block ${block}</a></h1><div class=thumbnails>${body}</div>
    <div class=center><a class=prev href=/inscriptions/block/${block - 1}>${block - 1}</a>&bull; prev next &bull;<a class=next href=/inscriptions/block/${block + 1}>${block + 1}</a>${extra}</div></main>`;
  const routes = new Map([
    ['/inscriptions/block/767430/0', ({ accept }) => accept === 'application/json' ? response('JSON API disabled', { status: 406, type: 'text/plain' }) : response(blockHtml(767430), { type: 'text/html' })],
    [`/r/inscription/${id(0)}`, response({ id: id(0), number: 0, height: 767430 })]
  ]);
  const result = await new FixtureOrd(routes).resolve(discoveryTarget('block=767430'));
  assert.equal(result.data.items.length, 1); assert.equal(result.data.next, null);
  assert.deepEqual(parseOrdListing(response(blockHtml(767430, ''), { type: 'text/html' }), { page: 0, offset: 0, block: 767430 }), {
    ids: [], hasNextPage: false, listingFormat: 'html'
  });
  const paged = blockHtml(767430, '', '<a class=next href=/inscriptions/block/767430/1>page</a>');
  assert.equal(parseOrdListing(response(paged, { type: 'text/html' }), { page: 0, offset: 0, block: 767430 }).hasNextPage, true);
  assert.throws(() => parseOrdListing(response(blockHtml(767431, ''), { type: 'text/html' }), { page: 0, offset: 0, block: 767430 }), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('terminal maximum page never emits an out-of-range next page', async () => {
  const routes = new Map([['/inscriptions/10000000', response({ ids: [], more: true, page_index: 10000000 })]]);
  const result = await new FixtureOrd(routes).resolve(discoveryTarget('page=10000000'));
  assert.equal(result.data.next, null);
  const html = `<main><h1>All Inscriptions</h1><div class=thumbnails></div><a class=next href=/inscriptions/10000001>next</a></main>`;
  assert.throws(() => parseOrdListing(response(html, { type: 'text/html' }), { page: 10000000, offset: 0, block: null }), { code: 'INVALID_PROVIDER_RESPONSE' });
  const noLink = `<main><h1>All Inscriptions</h1><div class=thumbnails></div></main>`;
  assert.equal(parseOrdListing(response(noLink, { type: 'text/html' }), { page: 10000000, offset: 0, block: null }).hasNextPage, false);
});

test('strict public HTML fallback extracts only thumbnails and matching next routes', async () => {
  const publicIds = [...publicListing.matchAll(/href=\/inscription\/([0-9a-f]{64}i\d+)/gi)].map((match) => match[1]);
  const routes = new Map();
  for (const [number, inscriptionId] of publicIds.slice(0, 24).entries()) routes.set(`/r/inscription/${inscriptionId}`, response({ id: inscriptionId, number, content_type: 'image/png', height: 840000 }));
  routes.set('/inscriptions/0', ({ accept }) => accept === 'application/json'
    ? response('JSON API disabled', { status: 406, type: 'text/plain' })
    : response(publicListing, { type: 'text/html' }));
  const result = await new FixtureOrd(routes).resolve(discoveryTarget(''));
  assert.equal(result.data.listingFormat, 'html'); assert.equal(result.data.items.length, 24);
  assert.equal(result.data.next, 'satnav://inscriptions?offset=24');
  for (const item of result.data.items) assert.equal(item.metadataUnavailable, false);
});

test('malformed, duplicate, oversized, foreign and mismatched HTML listings are rejected', () => {
  const query = { page: 0, offset: 0, block: null };
  for (const listing of [
    response({ ids: [id(0), id(0)] }), response({ ids: ['not-an-id'] }), response({ ids: Array.from({ length: 101 }, (_, n) => id(n)) }),
    response([id(0)]), response({ ids: [id(0)], more: 'yes' }), response({ ids: [id(0)], page_index: 9 }),
    response({ ids: [`${'a'.repeat(64)}i${'1'.repeat(20)}`] }),
    response('<main><h1>All Inscriptions</h1><div class="thumbnails"><a href="https://evil.test/inscription/' + id(0) + '">x</a></div></main>', { type: 'text/html' }),
    response(`<main><h1>All Inscriptions</h1><div class="thumbnails"><a href="/inscription/${id(0)}">x</a></div><a class="next" href="/inscriptions/9">next</a></main>`, { type: 'text/html' }),
    response(Buffer.alloc(512 * 1024 + 1), { type: 'text/html' })
  ]) assert.throws(() => parseOrdListing(listing, query), (error) => ['INVALID_PROVIDER_RESPONSE', 'RESOURCE_TOO_LARGE'].includes(error.code));
});

test('metadata failures retain cards, mark partial, and enforce four-worker concurrency', async () => {
  const routes = metadataRoutes(24, new Map([[3, Object.assign(new Error('missing'), { code: 'NOT_FOUND' })], [4, response({ id: id(999) })]]));
  routes.set('/inscriptions/0', response({ ids: Array.from({ length: 24 }, (_, n) => id(n)), more: false }));
  for (let n = 0; n < 24; n++) if (!routes.get(`/r/inscription/${id(n)}`)?.data) routes.set(`/r/inscription/${id(n)}`, routes.get(`/r/inscription/${id(n)}`));
  const provider = new FixtureOrd(routes);
  const result = await provider.resolve(discoveryTarget(''));
  assert.equal(result.data.partial, true);
  assert.equal(result.data.items[3].metadataUnavailable, true);
  assert.equal(result.data.items[4].metadataUnavailable, true);
  assert.equal(result.data.items.length, 24); assert.ok(provider.maximum <= 4);
});

test('abort settles all metadata workers and propagates cancellation without a gallery', async () => {
  const controller = new AbortController();
  let settled = 0;
  const routes = new Map([['/inscriptions/0', response({ ids: Array.from({ length: 24 }, (_, n) => id(n)), more: false })]]);
  for (let n = 0; n < 24; n++) routes.set(`/r/inscription/${id(n)}`, ({ signal }) => new Promise((resolve, reject) => {
    const finish = () => { settled++; reject(signal.reason); };
    if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
  }));
  const provider = new FixtureOrd(routes);
  const pending = provider.resolve(discoveryTarget(''), { signal: controller.signal, timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  const reason = Object.assign(new Error('Synthetic cancellation'), { code: 'ROUTING_INVALIDATED', status: 409, retryable: true });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(provider.active, 0); assert.equal(settled, 4);
});

test('whole-operation deadline aborts and settles outstanding metadata reads', async () => {
  let settled = 0;
  const routes = new Map([['/inscriptions/0', response({ ids: Array.from({ length: 24 }, (_, n) => id(n)), more: false })]]);
  for (let n = 0; n < 24; n++) routes.set(`/r/inscription/${id(n)}`, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { settled++; reject(signal.reason); }, { once: true });
  }));
  const provider = new FixtureOrd(routes);
  await assert.rejects(provider.resolve(discoveryTarget(''), { timeoutMs: 10 }), { code: 'PROVIDER_TIMEOUT', status: 504, retryable: true });
  assert.equal(provider.active, 0); assert.equal(settled, 4);
});

test('late abort is enforced for empty listings and metadata collaborators that ignore the signal', async () => {
  for (const stage of ['listing', 'metadata']) {
    const controller = new AbortController();
    const reason = Object.assign(new Error(`Synthetic ${stage} invalidation`), { code: 'ROUTING_INVALIDATED', status: 409, retryable: true });
    const routes = new Map();
    if (stage === 'listing') routes.set('/inscriptions/0', () => { controller.abort(reason); return response({ ids: [], more: false }); });
    else {
      routes.set('/inscriptions/0', response({ ids: [id(0)], more: false }));
      routes.set(`/r/inscription/${id(0)}`, () => { controller.abort(reason); return response({ id: id(0), number: 0 }); });
    }
    await assert.rejects(new FixtureOrd(routes).resolve(discoveryTarget(''), { signal: controller.signal }), (error) => error === reason);
  }
});

test('inscription-number HTML fallback resolves canonical ID then cross-checks recursive metadata', async () => {
  const inscriptionId = id(7);
  const routes = new Map([
    ['/inscription/123', ({ accept }) => accept === 'application/json'
      ? response('JSON API disabled', { status: 406, type: 'text/plain' })
      : response(`<main><h1>Inscription 123</h1><a href=/inscription/${id(8)}>previous</a><dl><dt>id</dt><dd class="monospace">${inscriptionId}</dd></dl><a href=/inscription/${id(6)}>next</a></main>`, { type: 'text/html' })],
    [`/r/inscription/${inscriptionId}`, response({ id: inscriptionId, number: 123, content_type: 'image/png', height: 800000 })]
  ]);
  const result = await new FixtureOrd(routes).resolve({ kind: 'inscription-number', value: '123', canonical: 'inscription:123', display: 'Inscription #123' });
  assert.equal(result.summary.id, inscriptionId); assert.equal(result.summary.number, '123');
  routes.set(`/r/inscription/${inscriptionId}`, response({ id: inscriptionId, number: 124 }));
  await assert.rejects(new FixtureOrd(routes).resolve({ kind: 'inscription-number', value: '123', canonical: 'inscription:123' }), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('mock provider supplies deterministic nonempty galleries with canonical pagination', async () => {
  const provider = new MockProvider(config('mock'));
  const first = await provider.resolve(discoveryTarget(''));
  const block = await provider.resolve(discoveryTarget('page=1&offset=24&block=840001'));
  assert.equal(first.data.items.length, 24); assert.equal(first.data.partial, false);
  assert.equal(first.data.next, 'satnav://inscriptions?offset=24');
  assert.equal(block.data.items[0].height, 840001);
  assert.equal(block.data.previous, 'satnav://inscriptions?page=1&block=840001');
  assert.notEqual(first.data.items[0].id, block.data.items[0].id);
});

test('mock pagination is contiguous and reversible across each 100-item upstream boundary', async () => {
  const provider = new MockProvider(config('mock'));
  const canonicals = ['', 'offset=24&block=840001', 'offset=48&block=840001', 'offset=72&block=840001', 'offset=96&block=840001', 'page=1&block=840001'];
  const pages = [];
  for (const value of canonicals) pages.push((await provider.resolve(discoveryTarget(value))).data);
  // The initial no-block control is separate; traverse the complete block page.
  const blockStart = (await provider.resolve(discoveryTarget('block=840001'))).data;
  const blockPages = [blockStart, ...pages.slice(1, 5)];
  const numbers = blockPages.flatMap((page) => page.items.map((item) => Number(item.number)));
  assert.deepEqual(numbers, Array.from({ length: 100 }, (_, index) => index));
  assert.deepEqual(blockPages.map((page) => page.items.length), [24, 24, 24, 24, 4]);
  assert.deepEqual(blockPages.map((page) => page.next), [
    'satnav://inscriptions?offset=24&block=840001', 'satnav://inscriptions?offset=48&block=840001',
    'satnav://inscriptions?offset=72&block=840001', 'satnav://inscriptions?offset=96&block=840001',
    'satnav://inscriptions?page=1&block=840001'
  ]);
  assert.equal(pages[5].previous, 'satnav://inscriptions?offset=96&block=840001');
  assert.ok(blockPages.flatMap((page) => page.items).every((item) => item.contentType === 'text/html' && item.contentLength === null));
  const terminal = (await provider.resolve(discoveryTarget(`page=${10000000}&offset=96&block=840001`))).data;
  assert.equal(terminal.items.length, 4); assert.equal(terminal.next, null);
});
