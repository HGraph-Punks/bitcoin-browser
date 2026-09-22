import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/main/providers/mock.js';
import { HOSTILE_INSCRIPTION_HTML, HOSTILE_MOCK_PATH } from '../src/main/hostile-fixture.js';
import { parseNavigationInput } from '../src/shared/navigation.js';
import { inscriptionMime, inscriptionPresentation } from '../src/shared/inscription-presentation.js';

const provider = new MockProvider({ id: 'fixture-only', name: 'Fixture only', type: 'mock', network: 'mainnet',
  capabilities: ['inscription', 'sat', 'ord-recursion'] });

test('hostile recursive mock metadata agrees with the exact HTML served to the sandbox', async () => {
  const target = parseNavigationInput(HOSTILE_MOCK_PATH);
  const entity = await provider.resolve(target);
  const response = await provider.fetchPath(HOSTILE_MOCK_PATH);
  assert.equal(entity.canonical, `ord:/${HOSTILE_MOCK_PATH}`);
  assert.equal(entity.data.contentType, inscriptionMime(response.headers['content-type']));
  assert.equal(inscriptionPresentation(entity.data.contentType), 'original');
  assert.equal(response.data.toString(), HOSTILE_INSCRIPTION_HTML);
  assert.equal(entity.source.type, 'mock');
  assert.equal(entity.data.mock, true);
});

test('ordinary mock content and recursive resources declare their HTML without relabelling sat records', async () => {
  for (const input of [`content:${'a'.repeat(64)}i0`, '/r/blockheight']) {
    const target = parseNavigationInput(input);
    const entity = await provider.resolve(target);
    const response = await provider.fetchPath(target.kind === 'content' ? `/content/${target.value}` : target.value);
    assert.equal(entity.data.contentType, inscriptionMime(response.headers['content-type']));
    assert.equal(entity.canonical, target.canonical);
    assert.equal(entity.source.id, 'fixture-only');
  }
  const sat = await provider.resolve(parseNavigationInput('sat:0'));
  assert.equal(sat.summary.sat, '0');
  assert.equal(sat.data.contentType, undefined);
});
