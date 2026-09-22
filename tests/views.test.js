import test from 'node:test';
import assert from 'node:assert/strict';
import { humanValue } from '../src/renderer/views.js';

test('formats sat identifiers as identifiers rather than timestamps', () => {
  assert.equal(humanValue('sat', 0), '0');
  assert.equal(humanValue('sat', '840000'), '840000');
});

test('formats explicit timestamp and camel-case time fields as dates', () => {
  assert.notEqual(humanValue('timestamp', 0), '0');
  assert.notEqual(humanValue('createdAt', 0), '0');
});
