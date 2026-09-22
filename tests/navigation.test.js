import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalToDeepLink, parseNavigationInput, targetCapability } from '../src/shared/navigation.js';

const TXID = 'a'.repeat(64);
const INSCRIPTION = `${'b'.repeat(64)}i0`;

test('parses canonical Bitcoin and Ordinals targets', () => {
  assert.deepEqual(parseNavigationInput('sat:0').kind, 'sat');
  assert.equal(parseNavigationInput(INSCRIPTION).canonical, `inscription:${INSCRIPTION}`);
  assert.equal(parseNavigationInput(`#-1`).kind, 'inscription-number');
  assert.equal(parseNavigationInput(`${TXID}:2`).kind, 'output');
  assert.equal(parseNavigationInput(`${TXID}:2:19`).kind, 'satpoint');
  assert.equal(parseNavigationInput('/r/blockheight').kind, 'recursive');
  assert.equal(parseNavigationInput('/r/blockheight').canonical, 'ord://r/blockheight');
  assert.equal(parseNavigationInput(`/content/${INSCRIPTION}`).canonical, `ord://content/${INSCRIPTION}`);
  assert.equal(parseNavigationInput(`ord://content/${INSCRIPTION}`).kind, 'content');
});

test('retains ambiguity rather than guessing', () => {
  const hash = parseNavigationInput(TXID);
  assert.equal(hash.kind, 'transaction');
  assert.equal(hash.ambiguous, true);
  assert.equal(hash.alternatives[0].kind, 'block');
  const integer = parseNavigationInput('840000');
  assert.equal(integer.kind, 'sat');
  assert.equal(integer.alternatives.length, 2);
});

test('parses internal and external routes safely', () => {
  assert.deepEqual(parseNavigationInput('satnav://wallet').kind, 'internal');
  const documentation = parseNavigationInput('satnav://documentation');
  assert.deepEqual(documentation, {
    kind: 'internal', value: 'documentation', canonical: 'satnav://documentation', display: 'Documentation',
    confidence: 'high', ambiguous: false, alternatives: []
  });
  assert.deepEqual(parseNavigationInput('SATNAV://DOCUMENTATION'), documentation);
  assert.deepEqual(parseNavigationInput(documentation.canonical), documentation);
  assert.equal(parseNavigationInput('satnav://about').value, 'about');
  assert.deepEqual(parseNavigationInput('satnav://documentation-unknown'), {
    kind: 'search', value: 'documentation-unknown', canonical: 'search:documentation-unknown/', display: 'documentation-unknown/',
    confidence: 'low', ambiguous: false, alternatives: []
  });
  assert.equal(parseNavigationInput('https://example.com/a').kind, 'external-web');
  assert.equal(parseNavigationInput('bitcoin:bc1qexample').kind, 'payment');
  assert.equal(parseNavigationInput('javascript:alert(1)').kind, 'search');
});

test('Sponsors has a canonical internal route without a provider capability', () => {
  const target = parseNavigationInput('satnav://sponsors');
  assert.deepEqual(target, {
    kind: 'internal', value: 'sponsors', canonical: 'satnav://sponsors', display: 'Sponsors',
    confidence: 'high', ambiguous: false, alternatives: []
  });
  assert.deepEqual(parseNavigationInput('SATNAV://SPONSORS'), target);
  assert.deepEqual(parseNavigationInput(target.canonical), target);
  assert.equal(targetCapability(target), null);
});

test('validates explicit targets', () => {
  assert.throws(() => parseNavigationInput('tx:not-a-txid'), { code: 'INVALID_TARGET' });
  assert.throws(() => parseNavigationInput('output:abc:0'), { code: 'INVALID_TARGET' });
  assert.throws(() => parseNavigationInput('content:not-an-inscription'), { code: 'INVALID_TARGET' });
});

test('maps capabilities and deep links', () => {
  assert.equal(targetCapability(parseNavigationInput(INSCRIPTION)), 'inscription');
  assert.equal(targetCapability(parseNavigationInput('/r/blockheight')), 'ord-recursion');
  assert.equal(targetCapability(parseNavigationInput(`${TXID}:2:19`)), 'satpoint');
  assert.equal(canonicalToDeepLink(`inscription:${INSCRIPTION}`), `satnav://inscription/${INSCRIPTION}`);
});
