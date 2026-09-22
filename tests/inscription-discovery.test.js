import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryCanonical, discoveryQuery, discoveryTarget, inscriptionMediaType } from '../src/shared/discovery.js';
import { canonicalToDeepLink, parseNavigationInput, targetCapability } from '../src/shared/navigation.js';

test('gallery targets normalize queries, round-trip deep links and reuse inscription authority', () => {
  assert.deepEqual(discoveryQuery(), { page: 0, offset: 0, block: null });
  const target = parseNavigationInput('SATNAV://INSCRIPTIONS/?block=0840000&offset=24&page=2');
  assert.equal(target.canonical, 'satnav://inscriptions?page=2&offset=24&block=840000');
  assert.equal(target.kind, 'inscriptions');
  assert.equal(target.ambiguous, false);
  assert.equal(targetCapability(target), 'inscription');
  assert.equal(canonicalToDeepLink(target), target.canonical);
  assert.deepEqual(parseNavigationInput(canonicalToDeepLink(target)), target);
  assert.equal(discoveryTarget('page=0&offset=0').canonical, 'satnav://inscriptions');
  assert.equal(discoveryCanonical({ block: 0 }), 'satnav://inscriptions?block=0');
});

test('gallery rejects unknown, duplicate, oversized and non-integral query fields', () => {
  for (const query of ['page=1&page=2', 'search=art', 'page=-1', 'page=1.5', 'page=10000001', 'offset=1', 'offset=100', 'block=10000001', 'block=', 'page=1e2', 'page=+1', 'x'.repeat(257), null, {}]) {
    assert.throws(() => discoveryQuery(query), { code: 'INVALID_TARGET' }, String(query));
  }
  for (const query of [{ page: NaN }, { offset: false }, { page: -1 }, { block: Infinity }, { offset: 99 }]) {
    assert.throws(() => discoveryCanonical(query), { code: 'INVALID_TARGET' });
  }
  for (const url of ['satnav://inscriptions/other', 'satnav://inscriptions#x', 'satnav://inscriptions?page=0&page=1']) {
    assert.throws(() => parseNavigationInput(url), { code: 'INVALID_TARGET' });
  }
  assert.equal(discoveryQuery('offset=96').offset, 96);
  assert.equal(discoveryQuery('block=10000000&page=10000000').block, 10000000);
});

test('media categories are deterministic and do not conflate interactive HTML with readable text', () => {
  for (const [type, category] of [['image/SVG+xml', 'images'], ['image/png; charset=binary', 'images'], ['text/html', 'interactive'], ['application/xhtml+xml', 'interactive'], ['text/plain', 'text'], ['application/json', 'text'], ['audio/mpeg', 'audio'], ['video/mp4', 'video'], [null, 'other']]) {
    assert.equal(inscriptionMediaType(type), category);
  }
});
