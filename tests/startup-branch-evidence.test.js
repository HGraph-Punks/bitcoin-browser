import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTUP_BRANCH_RUNTIME, STARTUP_BRANCH_SITES, analyzeStartupBranchTrace as analyzeSerialized } from '../scripts/startup-branch-evidence.mjs';

const analyzeStartupBranchTrace = report => analyzeSerialized(JSON.stringify(report));

const missingService = ['service-check', 'null-fallback', 'result-merge'];
const payloadPrefix = ['service-check', 'service-fallthrough', 'payload-check'];
const missingPayload = [...payloadPrefix, 'payload-null', 'result-check', 'null-fallback', 'result-merge'];
const nonempty = [...payloadPrefix, 'payload-fallthrough', 'result-check', 'result-merge'];
const abnormalEmpty = [...payloadPrefix, 'payload-fallthrough', 'result-check', 'null-fallback', 'result-merge'];
const trace = sites => ({ schemaVersion: 1, runtime: { ...STARTUP_BRANCH_RUNTIME },
  armedSites: STARTUP_BRANCH_SITES.map(site => site.id), complete: true, overflow: false, detached: true,
  events: sites.map((site, index) => ({ sequence: index + 1, threadOrdinal: 1, site })) });

test('shared merge is not mistaken for a nonempty result after the service fallback', () => {
  const result = analyzeStartupBranchTrace(trace(missingService));
  assert.equal(result.complete, true);
  assert.equal(result.scope, 'branch-order-only');
  assert.deepEqual(result.observations, [{ threadOrdinal: 1, invocation: 1, startSequence: 1,
    endSequence: 3, outcome: 'service-guard-fallback' }]);
});

test('null payload and non-null payload returning empty have distinct outcomes', () => {
  const result = analyzeStartupBranchTrace(trace([...missingPayload, ...abnormalEmpty, ...nonempty]));
  assert.equal(result.complete, true);
  assert.deepEqual(result.observations.map(row => row.outcome),
    ['null-payload-fallback', 'non-null-payload-empty-result', 'nonempty-result']);
  assert.deepEqual(result.observations.map(row => row.invocation), [1, 2, 3]);
  assert.equal(Object.hasOwn(result, 'rootCauseEstablished'), false);
});

test('branch streams on separate threads are correlated independently', () => {
  const report = trace([]);
  report.events = [];
  for (let index = 0; index < Math.max(missingService.length, nonempty.length); index++) {
    for (const [threadOrdinal, sites] of [[1, missingService], [2, nonempty]]) {
      if (sites[index]) report.events.push({ sequence: report.events.length + 1, threadOrdinal, site: sites[index] });
    }
  }
  const result = analyzeStartupBranchTrace(report);
  assert.equal(result.complete, true);
  assert.deepEqual(result.observations.map(row => [row.threadOrdinal, row.outcome]),
    [[1, 'service-guard-fallback'], [2, 'nonempty-result']]);
});

test('ambiguous shared fallback and merge alone produce no conclusion', () => {
  assert.deepEqual(analyzeStartupBranchTrace(trace(['null-fallback', 'result-merge'])),
    { complete: false, code: 'BRANCH_ORPHAN_EVENT', observations: [] });
});

test('incomplete tail invalidates earlier complete observations', () => {
  const result = analyzeStartupBranchTrace(trace([...nonempty, 'service-check']));
  assert.equal(result.code, 'BRANCH_INVOCATION_INCOMPLETE');
  assert.deepEqual(result.observations, []);
});

test('same-thread nested invocation is inconclusive without stack ownership', () => {
  const result = analyzeStartupBranchTrace(trace([...payloadPrefix, ...missingService]));
  assert.equal(result.code, 'BRANCH_REENTRANT_OR_LOST_EVENT');
  assert.deepEqual(result.observations, []);
});

test('lost, duplicated, reordered and contradictory branches fail closed', () => {
  for (const sites of [nonempty.filter(site => site !== 'payload-check'),
    [...payloadPrefix, 'payload-fallthrough', 'payload-fallthrough', 'result-check', 'result-merge'],
    [...payloadPrefix, 'payload-null', 'result-check', 'result-merge'],
    ['service-check', 'result-check', 'null-fallback', 'result-merge']]) {
    const result = analyzeStartupBranchTrace(trace(sites));
    assert.equal(result.complete, false);
    assert.deepEqual(result.observations, []);
  }
  const gap = trace(nonempty); gap.events[2].sequence++;
  assert.equal(analyzeStartupBranchTrace(gap).code, 'BRANCH_EVENT_INVALID');
});

test('runtime mismatch and unarmed or duplicate sites invalidate interpretation', () => {
  for (const key of ['architecture', 'uuid', 'sha256']) {
    const report = trace(nonempty); report.runtime[key] = 'different';
    assert.equal(analyzeStartupBranchTrace(report).code, 'BRANCH_IDENTITY_INVALID');
  }
  for (const mutate of [sites => sites.pop(), sites => { sites[1] = sites[0]; }, sites => sites.push('unknown')]) {
    const report = trace(nonempty); mutate(report.armedSites);
    assert.equal(analyzeStartupBranchTrace(report).code, 'BRANCH_SITES_INCOMPLETE');
  }
});

test('collection overflow, lost detach and nonterminal reports never yield observations', () => {
  for (const [key, value] of [['complete', false], ['overflow', true], ['detached', false]]) {
    const report = trace(nonempty); report[key] = value;
    assert.deepEqual(analyzeStartupBranchTrace(report),
      { complete: false, code: 'BRANCH_COLLECTION_INCOMPLETE', observations: [] });
  }
});

test('non-allowlisted payload fields are rejected without reflecting their contents', () => {
  const token = 'fixture-only-private-value';
  for (const mutate of [report => { report.payload = token; },
    report => { report.runtime.path = token; }, report => { report.events[0].arguments = token; },
    report => { report.events[0].site = token; }]) {
    const report = trace(nonempty); mutate(report);
    const result = analyzeStartupBranchTrace(report);
    assert.equal(result.complete, false);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.deepEqual(result.observations, []);
  }
});

test('event and thread bounds are enforced without accepting a truncated prefix', () => {
  assert.equal(analyzeStartupBranchTrace(trace([])).code, 'BRANCH_EVENT_LIMIT');
  assert.equal(analyzeStartupBranchTrace(trace(Array(258).fill('service-check'))).code, 'BRANCH_EVENT_LIMIT');
  for (const thread of [0, 17, 1.5, '1', NaN]) {
    const report = trace(nonempty); report.events[0].threadOrdinal = thread;
    assert.equal(analyzeStartupBranchTrace(report).code, 'BRANCH_EVENT_INVALID');
  }
});

test('runtime and every instruction site are immutable and use linked, not live, addresses', () => {
  assert.equal(Object.isFrozen(STARTUP_BRANCH_RUNTIME), true);
  assert.equal(Object.isFrozen(STARTUP_BRANCH_SITES), true);
  assert.equal(new Set(STARTUP_BRANCH_SITES.map(site => site.address)).size, 8);
  for (const site of STARTUP_BRANCH_SITES) {
    assert.equal(Object.isFrozen(site), true);
    assert.match(site.address, /^0x[0-9a-f]+$/);
    assert.match(site.instructionWord, /^[0-9a-f]{8}$/);
    assert.equal(Number.parseInt(site.address, 16) % 4, 0);
  }
});

test('serialized boundary rejects caller accessors without invoking or reflecting them', () => {
  let getterCalls = 0;
  const report = trace(nonempty);
  Object.defineProperty(report.events[0], 'sequence', { enumerable: true, get() {
    getterCalls++; return getterCalls === 1 ? 1 : 'fixture-only-private-value';
  } });
  assert.deepEqual(analyzeSerialized(report), { complete: false, code: 'BRANCH_INPUT_INVALID', observations: [] });
  assert.equal(getterCalls, 0);
  for (const input of [undefined, null, 42, Buffer.from('{}'), '{malformed']) {
    assert.equal(analyzeSerialized(input).code, 'BRANCH_INPUT_INVALID');
  }
});

test('serialized size limit counts UTF-8 bytes and accepts its exact boundary', () => {
  const valid = JSON.stringify(trace(nonempty));
  const padded = valid + ' '.repeat(65536 - Buffer.byteLength(valid));
  assert.equal(analyzeSerialized(padded).complete, true);
  assert.equal(analyzeSerialized(padded + ' ').code, 'BRANCH_INPUT_LIMIT');
  assert.equal(analyzeSerialized('😀'.repeat(20000)).code, 'BRANCH_INPUT_LIMIT');
});
