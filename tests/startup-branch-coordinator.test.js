// SYNTHETIC COORDINATION TESTS ONLY. No Electron, LLDB, native process, profile,
// native adapter or native branch observation is created by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createStartupBranchCoordinator } from '../scripts/startup-branch-coordinator.mjs';
import { STARTUP_BRANCH_RUNTIME, STARTUP_BRANCH_SITES } from '../scripts/startup-branch-evidence.mjs';

const ids = STARTUP_BRANCH_SITES.map(site => site.id);
const nonempty = ['service-check', 'service-fallthrough', 'payload-check', 'payload-fallthrough', 'result-check', 'result-merge'];
const missingService = ['service-check', 'null-fallback', 'result-merge'];
const copy = value => JSON.parse(JSON.stringify(value));
const pendingUntilAbort = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(new Error('synthetic cancellation'));
  else signal.addEventListener('abort', () => reject(new Error('synthetic cancellation')), { once: true });
});

function synthetic() {
  const h = { calls: [], phase: 'held', count: 0, readCount: 0, binding: null, onRecord: null,
    owner: { generation: 1, rendererPid: 4242, webContentsId: 7, frameProcessId: 8, frameRoutingId: 0 },
    provenance: { kind: 'synthetic', adapterId: 'controlled-node-test', sha256: 'a'.repeat(64) } };
  h.emit = sites => sites.map(site => h.onRecord(JSON.stringify({ sequence: ++h.count, threadOrdinal: 1, site })));
  h.fixture = {
    readState() { h.calls.push('readState'); h.readCount++; return JSON.stringify({ owner: h.owner, phase: h.phase }); },
    enableRuntime({ binding }) { h.calls.push('enableRuntime'); assert.deepEqual(binding, h.binding);
      h.emit(missingService); return JSON.stringify({ binding, enabled: true }); },
    observeCommitted({ binding }) { h.calls.push('release'); assert.deepEqual(binding, h.binding);
      h.phase = 'committed'; h.calls.push('preload', 'load'); h.emit(nonempty);
      return JSON.stringify({ binding, released: true, committed: true, preload: true, loaded: true,
        heldObservedMs: 250, committedObservedMs: 250 }); },
    quit({ binding }) { h.calls.push('quit'); return JSON.stringify({ binding,
      normalQuit: true, fixtureExited: true, rendererExited: true }); }
  };
  h.collector = {
    arm({ binding, runtime, sites, onRecord }) {
      h.calls.push('arm'); h.binding = binding; h.onRecord = onRecord;
      assert.deepEqual(runtime, STARTUP_BRANCH_RUNTIME); assert.deepEqual(sites, STARTUP_BRANCH_SITES);
      return JSON.stringify({ binding, runtime, sites: sites.map(site => ({ ...site, locations: 1, enabled: true })), provenance: h.provenance });
    },
    begin({ binding }) { h.calls.push('begin'); return JSON.stringify({ binding, recording: true, resumed: true }); },
    stopAndDrain({ binding }) { h.calls.push('drain'); return JSON.stringify({ binding,
      quiescent: true, complete: true, overflow: false, lossless: true, recordCount: h.count }); },
    removeSites({ binding }) { h.calls.push('remove'); return JSON.stringify({ binding, removedSites: ids, remaining: 0 }); },
    detachAndResume({ binding }) { h.calls.push('detach'); return JSON.stringify({ binding,
      runtime: STARTUP_BRANCH_RUNTIME, provenance: h.provenance, finalized: true,
      detached: true, resumed: true, callbacksRemoved: true, debuggerExited: true }); }
  };
  h.coordinator = createStartupBranchCoordinator(h);
  h.run = options => h.coordinator.run({ enabled: true, ...options });
  h.alter = (target, method, mutate) => {
    const original = h[target][method];
    h[target][method] = async args => {
      const receipt = JSON.parse(await original(args)); mutate(receipt); return JSON.stringify(receipt);
    };
  };
  return h;
}

function failed(result, code) {
  assert.equal(result.complete, false);
  if (code) assert.equal(result.code, code);
  assert.equal(result.interpretation, null);
  assert.equal(result.evidenceScope, null);
  if (result.trace) assert.equal(JSON.parse(result.trace).complete, false);
}

test('synthetic: import, construction and default run are inert; admission is single-use', async () => {
  const h = synthetic();
  assert.deepEqual(h.calls, []);
  failed(await h.coordinator.run(), 'BRANCH_COORDINATOR_DISABLED');
  assert.deepEqual(h.calls, []);
  const first = h.run();
  failed(await h.run(), 'BRANCH_COORDINATOR_ALREADY_USED');
  assert.equal((await first).complete, true);
  assert.equal(h.calls.filter(name => name === 'arm').length, 1);
});

test('synthetic: early Runtime waits for all-site arm, ownership rechecks and resume', async () => {
  const h = synthetic();
  const result = await h.run({ earlyRuntime: true });
  assert.equal(result.complete, true);
  assert.equal(result.traceValidated, true);
  assert.equal(result.evidenceScope, 'synthetic-coordination-only');
  assert.equal(result.interpretation, null, 'synthetic receipts are never native branch findings');
  assert.deepEqual(h.calls, ['readState', 'arm', 'readState', 'begin', 'readState', 'enableRuntime',
    'release', 'preload', 'load', 'readState', 'drain', 'remove', 'detach', 'quit']);
  assert.deepEqual(Object.values(result.cleanup), Array(7).fill(true));
  assert.equal(JSON.parse(result.trace).events.length, missingService.length + nonempty.length);
});

test('synthetic no-Runtime control: empty held interval still collects committed preload/load', async () => {
  const h = synthetic();
  const original = h.fixture.observeCommitted;
  h.fixture.observeCommitted = args => { assert.equal(h.count, 0); return original(args); };
  const result = await h.run();
  assert.equal(result.complete, true);
  assert.equal(h.calls.includes('enableRuntime'), false);
  assert.ok(h.calls.indexOf('load') < h.calls.indexOf('drain'));
  assert.deepEqual(JSON.parse(result.trace).events.map(event => event.site), nonempty);
});

test('synthetic: fresh per-run nonces and frozen bindings prevent stale-intent reuse', async () => {
  const a = synthetic(); const b = synthetic();
  await a.run(); await b.run();
  assert.notEqual(a.binding.nonce, b.binding.nonce);
  assert.equal(Object.isFrozen(a.binding), true);
  assert.equal(Object.isFrozen(a.binding.owner), true);
});

test('synthetic: pre-abort and invalid configuration never call any adapter', async () => {
  const controller = new AbortController(); controller.abort();
  const h = synthetic(); failed(await h.run({ signal: controller.signal }), 'BRANCH_INTERRUPTED');
  assert.deepEqual(h.calls, []);
  for (const options of [{ earlyRuntime: 1 }, { armingTimeoutMs: 10001 }, { observationTimeoutMs: NaN },
    { cleanupTimeoutMs: 15001 }, { cleanupTimeoutMs: 0 }]) {
    const invalid = synthetic(); failed(await invalid.run(options), 'BRANCH_ADAPTER_INVALID');
    assert.deepEqual(invalid.calls, []);
  }
  failed(await createStartupBranchCoordinator().run({ enabled: true }), 'BRANCH_ADAPTER_INVALID');
});

test('synthetic: unavailable, malformed or non-held initial ownership prevents arming', async () => {
  for (const mutate of [state => { state.owner.rendererPid = 0; }, state => { state.owner.generation = -1; },
    state => { state.owner.rendererPid = null; }, state => { state.owner.frameRoutingId = -1; },
    state => { state.owner.extra = 'not permitted'; }, state => { state.phase = 'committed'; }]) {
    const h = synthetic(); h.alter('fixture', 'readState', mutate);
    failed(await h.run({ earlyRuntime: true }), 'BRANCH_OWNER_INVALID');
    assert.deepEqual(h.calls, ['readState']);
  }
});

test('synthetic: wrong nonce, PID, generation, module or instruction rejects arming before Runtime', async () => {
  for (const mutate of [receipt => { receipt.binding.nonce = 'stale'; },
    receipt => { receipt.binding.owner.rendererPid++; }, receipt => { receipt.binding.owner.generation++; },
    receipt => { receipt.runtime.uuid = 'wrong'; }, receipt => { receipt.runtime.sha256 = 'b'.repeat(64); },
    receipt => { receipt.sites[0].instructionWord = '00000000'; }, receipt => { receipt.sites[0].address = '0x0'; }]) {
    const h = synthetic(); h.alter('collector', 'arm', mutate);
    failed(await h.run({ earlyRuntime: true }));
    assert.equal(h.calls.includes('begin'), false); assert.equal(h.calls.includes('enableRuntime'), false);
    assert.ok(h.calls.includes('drain')); assert.ok(h.calls.includes('remove')); assert.ok(h.calls.includes('detach'));
  }
});

test('synthetic: every site must be enabled exactly once; missing/duplicate/multi-location sites fail', async () => {
  for (const mutate of [receipt => receipt.sites.pop(), receipt => { receipt.sites[1] = receipt.sites[0]; },
    receipt => { receipt.sites[2].enabled = false; }, receipt => { receipt.sites[3].locations = 2; },
    receipt => { receipt.sites.push({ ...receipt.sites[0], id: 'unknown' }); }]) {
    const h = synthetic(); h.alter('collector', 'arm', mutate);
    const result = await h.run({ earlyRuntime: true }); failed(result, 'BRANCH_SITES_INCOMPLETE');
    assert.deepEqual(JSON.parse(result.trace).armedSites, []);
    assert.equal(h.calls.includes('enableRuntime'), false);
  }
});

test('synthetic: renderer/generation/frame replacement at every ownership checkpoint fails closed', async () => {
  for (const checkpoint of [2, 3, 4]) for (const field of ['rendererPid', 'generation', 'webContentsId', 'frameProcessId', 'frameRoutingId']) {
    const h = synthetic(); const original = h.fixture.readState;
    h.fixture.readState = args => {
      const state = JSON.parse(original(args)); if (h.readCount === checkpoint) state.owner[field]++;
      return JSON.stringify(state);
    };
    failed(await h.run({ earlyRuntime: true }), 'BRANCH_OWNER_CHANGED');
    if (checkpoint < 4) assert.equal(h.calls.includes('enableRuntime'), false);
  }
});

test('synthetic: failed resume acknowledgment prevents Runtime and response release', async () => {
  for (const mutate of [receipt => { receipt.recording = false; }, receipt => { receipt.resumed = false; },
    receipt => { receipt.binding.nonce = 'replayed'; }]) {
    const h = synthetic(); h.alter('collector', 'begin', mutate);
    failed(await h.run({ earlyRuntime: true }), 'BRANCH_BEGIN_INVALID');
    assert.equal(h.calls.includes('enableRuntime'), false); assert.equal(h.calls.includes('release'), false);
  }
});

test('synthetic: synchronous arm callback cannot precede full arming acknowledgment', async () => {
  const h = synthetic(); const original = h.collector.arm;
  h.collector.arm = args => { const receipt = original(args); assert.equal(h.emit(['service-check'])[0], false); return receipt; };
  failed(await h.run({ earlyRuntime: true }), 'BRANCH_RECORD_PHASE');
  assert.equal(h.calls.includes('enableRuntime'), false);
});

test('synthetic: collection continues during begin and drain but rejects callbacks after drain', async () => {
  const h = synthetic(); const begin = h.collector.begin; const drain = h.collector.stopAndDrain;
  h.collector.begin = args => { h.emit(missingService); return begin(args); };
  h.collector.stopAndDrain = args => { h.emit(missingService); return drain(args); };
  assert.equal((await h.run()).complete, true);
  const late = synthetic(); const remove = late.collector.removeSites;
  late.collector.removeSites = args => { assert.equal(late.emit(missingService)[0], false); return remove(args); };
  failed(await late.run(), 'BRANCH_RECORD_PHASE');
});

test('synthetic: malformed/gapped/private/oversized records fail without reflecting forbidden values', async () => {
  const privateValue = 'synthetic-forbidden-value';
  for (const text of [undefined, '{', JSON.stringify({ sequence: 2, threadOrdinal: 1, site: 'service-check' }),
    JSON.stringify({ sequence: 1, threadOrdinal: 17, site: 'service-check' }),
    JSON.stringify({ sequence: 1, threadOrdinal: 1, site: privateValue }),
    JSON.stringify({ sequence: 1, threadOrdinal: 1, site: 'service-check', args: privateValue }),
    ' '.repeat(513), 'é'.repeat(300)]) {
    const h = synthetic(); h.fixture.observeCommitted = () => { h.onRecord(text); throw new Error(privateValue); };
    const result = await h.run(); failed(result);
    assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.equal(JSON.parse(result.trace).events.length, 0);
  }
});

test('synthetic: event cap enforced during ingestion; no successful truncated prefix survives', async () => {
  const h = synthetic(); h.fixture.observeCommitted = () => {
    for (let i = 0; i < 86; i++) h.emit(missingService);
    throw new Error('synthetic stop');
  };
  const result = await h.run(); failed(result, 'BRANCH_EVENT_LIMIT');
  const trace = JSON.parse(result.trace);
  assert.equal(trace.events.length, 256); assert.equal(trace.overflow, true);
  assert.ok(Buffer.byteLength(result.trace) <= 65536);
});

test('synthetic: incomplete/reentrant branch suffix invalidates a complete earlier prefix', async () => {
  for (const suffix of [['service-check'], ['service-check', 'service-check']]) {
    const h = synthetic(); const original = h.fixture.observeCommitted;
    h.fixture.observeCommitted = args => { const receipt = original(args); h.emit(suffix); return receipt; };
    const result = await h.run(); failed(result);
    assert.equal(result.traceValidated, false); assert.equal(result.cleanup.quitConfirmed, true);
  }
});

test('synthetic: committed document receipt requires all markers, ownership and finite bounded durations', async () => {
  for (const mutate of [receipt => { receipt.loaded = false; }, receipt => { receipt.preload = false; },
    receipt => { receipt.committed = false; }, receipt => { receipt.released = false; },
    receipt => { receipt.binding.owner.frameRoutingId++; }, receipt => { delete receipt.heldObservedMs; },
    receipt => { receipt.heldObservedMs = null; }, receipt => { receipt.committedObservedMs = '250'; },
    receipt => { receipt.heldObservedMs = 249; }, receipt => { receipt.committedObservedMs = 5001; }]) {
    const h = synthetic(); h.alter('fixture', 'observeCommitted', mutate);
    failed(await h.run(), 'BRANCH_COMMIT_INVALID');
  }
});

test('synthetic: absent or changed finalized adapter provenance prevents interpretation', async () => {
  for (const mutate of [receipt => { receipt.finalized = false; }, receipt => { receipt.provenance.kind = 'native'; },
    receipt => { receipt.provenance.sha256 = 'b'.repeat(64); }, receipt => { receipt.provenance.adapterId = 'other'; },
    receipt => { delete receipt.provenance; }, receipt => { receipt.runtime.architecture = 'x64'; }]) {
    const h = synthetic(); h.alter('collector', 'detachAndResume', mutate);
    failed(await h.run());
  }
});

test('synthetic: drain loss/count/overflow invalidates all findings while safe teardown can finish', async () => {
  for (const mutate of [receipt => { receipt.lossless = false; }, receipt => { receipt.complete = false; },
    receipt => { receipt.recordCount--; }, receipt => { receipt.overflow = true; }]) {
    const h = synthetic(); h.alter('collector', 'stopAndDrain', mutate);
    const result = await h.run(); failed(result, 'BRANCH_COLLECTION_INCOMPLETE');
    assert.equal(result.cleanup.quitConfirmed, true);
  }
});

test('synthetic: unconfirmed drain, removal, detach/resume or listener/debugger cleanup prevents quit', async () => {
  for (const [method, mutate] of [['stopAndDrain', receipt => { receipt.quiescent = false; }],
    ['removeSites', receipt => { receipt.remaining = 1; }], ['removeSites', receipt => receipt.removedSites.pop()],
    ...['detached', 'resumed', 'callbacksRemoved', 'debuggerExited'].map(key => ['detachAndResume', receipt => { receipt[key] = false; }])]) {
    const h = synthetic(); h.alter('collector', method, mutate);
    const result = await h.run(); failed(result);
    assert.equal(h.calls.includes('quit'), false);
    assert.ok(h.calls.includes('detach'), 'detach is attempted even after earlier cleanup receipt failure');
  }
});

test('synthetic: cleanup exceptions do not skip later bounded removal/detach attempts', async () => {
  const h = synthetic(); h.collector.stopAndDrain = () => { h.calls.push('drain'); throw new Error('synthetic collector error'); };
  failed(await h.run(), 'BRANCH_CLEANUP_FAILED');
  assert.deepEqual(h.calls.slice(-3), ['drain', 'remove', 'detach']);
});

test('synthetic: cancellation at arm, begin, Runtime, observation, drain and quit invalidates results', async () => {
  for (const [target, method] of [['collector', 'arm'], ['collector', 'begin'], ['fixture', 'enableRuntime'],
    ['fixture', 'observeCommitted'], ['collector', 'stopAndDrain'], ['fixture', 'quit']]) {
    const h = synthetic(); const controller = new AbortController(); const original = h[target][method];
    h[target][method] = args => { const receipt = original(args); controller.abort(); return receipt; };
    const result = await h.run({ earlyRuntime: true, signal: controller.signal }); failed(result, 'BRANCH_INTERRUPTED');
    assert.equal(result.interrupted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.ok(h.calls.includes('detach'));
  }
});

test('synthetic: arming deadline aborts pending work and cleanup settles it without a late Runtime', async () => {
  const h = synthetic(); const original = h.collector.arm;
  h.collector.arm = args => { original(args); return pendingUntilAbort(args.signal); };
  const result = await h.run({ earlyRuntime: true, armingTimeoutMs: 10 }); failed(result, 'BRANCH_ARMING_TIMEOUT');
  assert.equal(h.calls.includes('enableRuntime'), false);
  assert.equal(result.cleanup.operationsSettled, true);
});

test('synthetic: pre-resume ownership recheck timeout is attributed to the arming budget', async () => {
  const h = synthetic(); const original = h.fixture.readState;
  h.fixture.readState = args => {
    const receipt = original(args);
    return h.readCount === 2 ? pendingUntilAbort(args.signal) : receipt;
  };
  const result = await h.run({ earlyRuntime: true, armingTimeoutMs: 10 });
  failed(result, 'BRANCH_ARMING_TIMEOUT');
  assert.equal(h.calls.includes('begin'), false);
  assert.equal(h.calls.includes('enableRuntime'), false);
});

test('synthetic: observation deadline preserves a prefix but never interprets it', async () => {
  const h = synthetic(); const original = h.fixture.observeCommitted;
  h.fixture.observeCommitted = args => { original(args); return pendingUntilAbort(args.signal); };
  const result = await h.run({ observationTimeoutMs: 10 }); failed(result, 'BRANCH_OBSERVATION_TIMEOUT');
  assert.equal(JSON.parse(result.trace).events.length, nonempty.length);
  assert.ok(h.calls.includes('detach'));
});

test('synthetic: noncooperative pending arm cannot earn settled cleanup or normal quit', async () => {
  const h = synthetic(); const original = h.collector.arm;
  h.collector.arm = args => { original(args); return new Promise(() => {}); };
  const result = await h.run({ armingTimeoutMs: 10, cleanupTimeoutMs: 20 }); failed(result, 'BRANCH_ARMING_TIMEOUT');
  assert.equal(result.cleanup.operationsSettled, false);
  assert.equal(h.calls.includes('quit'), false);
});

test('synthetic: late arm settlement is fenced before final removal/detach, never after', async () => {
  const h = synthetic(); let finishArm; let attached = false;
  const arm = h.collector.arm; const drain = h.collector.stopAndDrain;
  const detach = h.collector.detachAndResume; const quit = h.fixture.quit;
  h.collector.arm = args => {
    const receipt = arm(args);
    return new Promise(resolve => { finishArm = () => { attached = true; h.calls.push('late-arm-settled'); resolve(receipt); }; });
  };
  h.collector.stopAndDrain = args => { setTimeout(finishArm, 5); return drain(args); };
  h.collector.detachAndResume = args => { attached = false; return detach(args); };
  h.fixture.quit = args => { assert.equal(attached, false, 'a late arm may not recreate attachment after cleanup'); return quit(args); };
  const result = await h.run({ armingTimeoutMs: 10, cleanupTimeoutMs: 100 });
  failed(result, 'BRANCH_ARMING_TIMEOUT');
  assert.equal(result.cleanup.quitConfirmed, true);
  assert.ok(h.calls.indexOf('late-arm-settled') < h.calls.indexOf('remove'));
  assert.ok(h.calls.indexOf('late-arm-settled') < h.calls.indexOf('detach'));
});

test('synthetic: shared cleanup deadline bounds a stuck drain without forceful fallback', async () => {
  const h = synthetic(); h.collector.stopAndDrain = ({ signal }) => { h.calls.push('drain'); return pendingUntilAbort(signal); };
  const result = await h.run({ cleanupTimeoutMs: 10 }); failed(result, 'BRANCH_CLEANUP_TIMEOUT');
  assert.equal(result.cleanup.quitConfirmed, false);
  assert.equal(h.calls.includes('quit'), false);
});

test('synthetic: callback during quit invalidates the previously complete trace', async () => {
  const h = synthetic(); const original = h.fixture.quit;
  h.fixture.quit = args => { h.emit(['service-check']); return original(args); };
  failed(await h.run(), 'BRANCH_RECORD_PHASE');
});

test('synthetic: normal quit must confirm both owned fixture and renderer exit', async () => {
  for (const key of ['normalQuit', 'fixtureExited', 'rendererExited']) {
    const h = synthetic(); h.alter('fixture', 'quit', receipt => { receipt[key] = false; });
    failed(await h.run(), 'BRANCH_QUIT_INVALID');
  }
});

test('synthetic: timed-out quit remains reported as an unsettled admitted operation', async () => {
  const h = synthetic(); h.fixture.quit = () => { h.calls.push('quit'); return new Promise(() => {}); };
  const result = await h.run({ cleanupTimeoutMs: 10 }); failed(result, 'BRANCH_CLEANUP_TIMEOUT');
  assert.equal(result.cleanup.quitConfirmed, false);
  assert.equal(result.cleanup.operationsSettled, false);
});

test('synthetic: a synchronous quit overrun cannot beat its deadline by delaying timer delivery', async () => {
  const h = synthetic(); const original = h.fixture.quit;
  h.fixture.quit = args => {
    const until = performance.now() + 25;
    while (performance.now() < until) { /* bounded synthetic event-loop stall */ }
    return original(args);
  };
  const result = await h.run({ cleanupTimeoutMs: 20 });
  failed(result, 'BRANCH_CLEANUP_TIMEOUT');
  assert.equal(result.cleanup.quitConfirmed, false);
});

test('synthetic: object receipts never invoke then/toJSON getters', async () => {
  const h = synthetic(); let getters = 0;
  const receipt = Object.defineProperties({}, {
    then: { get() { getters++; throw new Error('forbidden then getter'); } },
    toJSON: { get() { getters++; throw new Error('forbidden serialization getter'); } }
  });
  h.fixture.readState = () => receipt;
  failed(await h.run(), 'BRANCH_RECEIPT_INVALID');
  assert.equal(getters, 0);
});

test('synthetic: malformed and oversized receipts are rejected, not reflected or thrown to caller', async () => {
  for (const receipt of [undefined, null, '{}', '{', ' '.repeat(8193), JSON.stringify({ extra: 'synthetic-forbidden-value' })]) {
    const h = synthetic(); h.fixture.readState = () => receipt;
    const result = await h.run(); failed(result);
    assert.equal(JSON.stringify(result).includes('synthetic-forbidden-value'), false);
  }
});
