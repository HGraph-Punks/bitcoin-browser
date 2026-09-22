import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackagedOutput } from '../scripts/packaged-smoke-output.mjs';

test('packaged output retains launch attribution and exposes lossless capture counts', () => {
  const output = createPackagedOutput();
  const first = output.start(1, 100);
  first.append('stderr', 'bootstrap failure\n');
  output.start(2, 200).append('stdout', 'ready\n');
  assert.match(first.text, /^\[launch:1 pid:100 stderr\] bootstrap failure/);
  assert.match(output.text, /\[launch:2 pid:200 stdout\] ready/);
  assert.equal(output.snapshot().truncated, false);
  assert.equal(output.snapshot().totalBytesSeen, Buffer.byteLength(output.text));
});

test('per-launch truncation remains explicit even when aggregate capture fits', () => {
  const output = createPackagedOutput({ totalBytes: 512, launchBytes: 32 });
  output.start(1, 100).append('stderr', 'x'.repeat(64));
  assert.equal(output.snapshot().truncated, true);
  assert.equal(output.snapshot().launches[0].truncated, true);
  assert.equal(output.snapshot().totalBytesSeen, Buffer.byteLength(output.text));
});

test('aggregate overflow never erases earlier diagnostic evidence or pretends completeness', () => {
  const output = createPackagedOutput({ totalBytes: 64, launchBytes: 512 });
  output.start(1, 100).append('stderr', 'startupData is null\n');
  output.start(2, 200).append('stdout', 'x'.repeat(256));
  const snapshot = output.snapshot();
  assert.match(output.text, /startupData is null/);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.retainedBytes, 64);
  assert.ok(snapshot.totalBytesSeen > snapshot.retainedBytes);
  assert.ok(snapshot.launches.every((launch) => !launch.truncated));
});
