import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleLogoTargets, createParticleGeometry } from '../src/renderer/home-particles.js';

test('logo masks exclude transparency and orange background, and bound dense assets to the particle budget', () => {
  const pixels = new Uint8ClampedArray(192 * 192 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 255; pixels[i + 1] = 147; pixels[i + 2] = 26; pixels[i + 3] = 255; }
  assert.deepEqual(sampleLogoTargets(pixels, 192, 192), []);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = pixels[i + 1] = pixels[i + 2] = 12; }
  const full = sampleLogoTargets(pixels, 192, 192); assert.equal(full.length, 2300);
  assert.ok(full.every(point => point.length === 2 && point.every(value => Number.isFinite(value) && Math.abs(value) <= .96)));
  assert.equal(sampleLogoTargets(pixels, 192, 192, 100).length, 100);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 0;
  assert.deepEqual(sampleLogoTargets(pixels, 192, 192), []);
  assert.throws(() => sampleLogoTargets(pixels, 1024, 192), /Invalid logo mask/);
});

test('particle geometry stays deterministic, finite and bounded across a complete scene', () => {
  const a = createParticleGeometry([[0, 0], [.3, .4]]), b = createParticleGeometry([[0, 0], [.3, .4]]);
  assert.deepEqual(a, b); assert.equal(a.length, (2 + 420 + 200) * 11);
  assert.ok(a.every(Number.isFinite)); assert.equal(a[0], 0); assert.ok(Math.abs(a[11] - .3) < .000001);
  assert.throws(() => createParticleGeometry([]), /Invalid particle count/);
  assert.throws(() => createParticleGeometry(Array.from({ length: 2301 }, () => [0, 0])), /Invalid particle count/);
});
