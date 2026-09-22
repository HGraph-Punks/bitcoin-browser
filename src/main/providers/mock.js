import { DataProvider } from './base.js';
import { normalizeEntity } from './normalize.js';
import { HOSTILE_INSCRIPTION_HTML, HOSTILE_MOCK_PATH } from '../hostile-fixture.js';
import { DISCOVERY_MAX_PAGE, discoveryCanonical, discoveryQuery } from '../../shared/discovery.js';

export class MockProvider extends DataProvider {
  async health() {
    return { ok: true, height: 840_000, latencyMs: 1, checkedAt: new Date().toISOString(), capabilities: [...this.capabilities] };
  }

  async resolve(target) {
    const query = target.kind === 'inscriptions' ? discoveryQuery(target.value) : null;
    const start = query ? query.page * 100 + query.offset : 0;
    const count = query ? Math.min(24, 100 - query.offset) : 0;
    const raw = target.kind === 'inscriptions'
      ? { items: Array.from({ length: count }, (_, index) => ({ id: `${(start + index).toString(16).padStart(64, '0')}i0`, number: String(start + index), contentType: 'text/html', contentLength: null, height: query.block ?? 840_000, metadataUnavailable: false })),
        next: query.offset + 24 < 100 ? discoveryCanonical({ ...query, offset: query.offset + 24 })
          : query.page < DISCOVERY_MAX_PAGE ? discoveryCanonical({ page: query.page + 1, block: query.block }) : null,
        previous: query.offset >= 24 ? discoveryCanonical({ ...query, offset: query.offset - 24 }) : query.page ? discoveryCanonical({ page: query.page - 1, offset: 96, block: query.block }) : null,
        page: query.page, offset: query.offset, block: query.block, listingFormat: 'json', partial: false }
      : target.kind === 'inscription'
      ? { id: target.value, number: 1, content_type: 'text/html', content_length: 128, height: 767_430, sat: '0', output: `${'0'.repeat(64)}:0`, address: 'bc1ptest', charms: [] }
      // fetchPath serves HTML for both mock content and recursive resources.
      // Keep the metadata consistent so the viewer can exercise the ordinary
      // sandboxed Original path instead of the unknown-binary file viewer.
      : ['content', 'recursive'].includes(target.kind)
        ? { id: target.value, mock: true, contentType: 'text/html' }
      : target.kind === 'block'
        ? { hash: '0'.repeat(64), height: Number(target.value) || 840_000, timestamp: 1_713_571_767, transaction_count: 3_050 }
        : { id: target.value, mock: true };
    return normalizeEntity(target, raw, this, { latencyMs: 1, endpoint: 'mock' });
  }

  async fetchPath(path) {
    const html = path === HOSTILE_MOCK_PATH
      ? HOSTILE_INSCRIPTION_HTML
      : `<!doctype html><meta charset="utf-8"><style>body{background:#111;color:#eee;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0}</style><main><h1>Mock inscription</h1><p>${path}</p></main>`;
    return {
      ok: true,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      data: Buffer.from(html),
      latencyMs: 1,
      url: `mock:${path}`
    };
  }
}
