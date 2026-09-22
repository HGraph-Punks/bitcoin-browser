import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../scripts/packaged-smoke.mjs', import.meta.url), 'utf8');
const begin = source.indexOf('function decideProfileRetention(');
const end = source.indexOf('\n\nasync function findExecutable(', begin);
assert.ok(begin >= 0 && end > begin);
const decideProfileRetention = vm.runInNewContext(`(${source.slice(begin, end)})`);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('explicit keep retains a profile independently of sampling', () => {
  assert.deepEqual(plain(decideProfileRetention(true, [])), { retained: true, reason: 'explicit-keep-profile' });
});

test('successful or failed native sample metadata retains its owned profile', () => {
  assert.deepEqual(plain(decideProfileRetention(false, [{ nativeStackSample: { file: '/owned/sample.txt', exitCode: 0 } }])),
    { retained: true, reason: 'native-stack-sample-recorded' });
  assert.deepEqual(plain(decideProfileRetention(false, [{ nativeStackSample: { file: '/owned/failed.txt', exitCode: 1, output: 'failed' } }])),
    { retained: true, reason: 'native-stack-sample-recorded' });
});

test('ordinary runs and sample errors without file metadata remain cleanable', () => {
  for (const stops of [[], null, [{}], [{ nativeStackSample: null }], [{ nativeStackSample: { error: 'not started' } }], [{ nativeStackSample: { file: '' } }]]) {
    assert.deepEqual(plain(decideProfileRetention(false, stops)), { retained: false, reason: 'no-retained-native-sample' });
  }
});

test('an unconfirmed owned child close retains the profile', () => {
  assert.deepEqual(plain(decideProfileRetention(false, [{ closeConfirmed: false }])), { retained: true, reason: 'owned-child-close-unconfirmed' });
});
