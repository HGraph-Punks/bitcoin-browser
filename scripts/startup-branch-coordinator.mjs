import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { STARTUP_BRANCH_RUNTIME, STARTUP_BRANCH_SITES, analyzeStartupBranchTrace } from './startup-branch-evidence.mjs';

const ids = STARTUP_BRANCH_SITES.map(site => site.id);
const ownerKeys = ['generation', 'rendererPid', 'webContentsId', 'frameProcessId', 'frameRoutingId'];
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameOwner = (a, b) => exact(a, ownerKeys) && ownerKeys.every(key => a[key] === b[key]);
const sameRuntime = value => exact(value, Object.keys(STARTUP_BRANCH_RUNTIME))
  && Object.entries(STARTUP_BRANCH_RUNTIME).every(([key, expected]) => value[key] === expected);
const allIds = value => Array.isArray(value) && value.length === ids.length
  && new Set(value).size === ids.length && value.every(id => ids.includes(id));
const sameProvenance = (a, b) => exact(a, ['kind', 'adapterId', 'sha256'])
  && a.kind === b.kind && a.adapterId === b.adapterId && a.sha256 === b.sha256;
const validProvenance = value => exact(value, ['kind', 'adapterId', 'sha256'])
  && ['synthetic', 'native'].includes(value.kind) && typeof value.adapterId === 'string'
  && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.adapterId)
  && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
class CoordinationError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code) => { if (!condition) throw new CoordinationError(code); };
function parse(text, cap = 8192) {
  check(typeof text === 'string', 'BRANCH_RECEIPT_INVALID');
  check(text.length <= cap && Buffer.byteLength(text, 'utf8') <= cap, 'BRANCH_RECEIPT_LIMIT');
  try { return JSON.parse(text); } catch { throw new CoordinationError('BRANCH_RECEIPT_INVALID'); }
}

/**
 * PREPARATION ONLY: no native driver is included. Import/construction is inert;
 * run() also does nothing unless enabled:true. One coordinator admits one run.
 * It neither launches processes nor imports Electron/LLDB, accesses profiles,
 * attaches a debugger, performs network I/O, or force-terminates anything.
 *
 * Trusted, explicitly injected adapter contract (all receipts are JSON text,
 * returned directly or by a genuine Promise, never an arbitrary thenable):
 * - fixture.readState({signal}) -> {owner, phase:'held'|'committed'}; passive
 *   identity for the already-held, exclusively owned main frame. owner has
 *   positive integer generation/rendererPid/webContentsId/frameProcessId and
 *   nonnegative frameRoutingId. Adapters must independently verify ownership.
 * - collector.arm({binding,runtime,sites,onRecord,signal}) ->
 *   {binding,runtime,sites,provenance}. Each site echoes the exact manifest entry
 *   plus locations:1, enabled:true. Verify loaded UUID/hash/instructions, arm
 *   all sites, KEEP TARGET STOPPED, and emit no records yet. provenance is
 *   {kind:'synthetic'|'native',adapterId,sha256} identifying the reviewed adapter.
 * - collector.begin({binding,signal}) -> {binding,recording:true,resumed:true}.
 *   Start lossless recording and resume only this target. Records may arrive
 *   synchronously here. onRecord accepts ONLY serialized
 *   {sequence,threadOrdinal,site}; false means stop admission, preserve failure.
 * - fixture.enableRuntime({binding,signal}) -> {binding,enabled:true}, only when
 *   requested. It must atomically recheck the binding immediately before send.
 * - fixture.observeCommitted({binding,signal}) -> {binding,released:true,
 *   committed:true,preload:true,loaded:true,heldObservedMs,committedObservedMs}.
 *   Preserve the existing 250ms held and post-commit observations; release only
 *   the owned response and validate the exact document's preload/load markers.
 *   This runs EVEN WITHOUT Runtime; a held interval without events is allowed.
 * - collector.stopAndDrain({binding,signal}) -> {binding,quiescent:true,
 *   complete,overflow,lossless,recordCount}. Stop admission, settle/fence any
 *   late arm/begin work, and drain all callbacks before resolving. It must work
 *   after partial arm failure. No onRecord calls are allowed after resolution.
 * - collector.removeSites({binding,sites,signal}) ->
 *   {binding,removedSites:[all eight IDs],remaining:0}. Idempotent after partial
 *   arming; IDs acknowledge each site's verified absence, not eight removals.
 * - collector.detachAndResume({binding,signal}) -> {binding,runtime,provenance,
 *   finalized:true,detached:true,resumed:true,callbacksRemoved:true,
 *   debuggerExited:true}. Confirm exact-target detach/resume and debugger exit;
 *   provenance must match arm. No callbacks or pending target effects survive.
 * - fixture.quit({binding,signal}) -> {binding,normalQuit:true,
 *   fixtureExited:true,rendererExited:true}. Never force kill. Driver retains
 *   evidence/profiles and separately handles unconfirmed cleanup/authority.
 *
 * Every method must honor signal, settle its outstanding work, reject target
 * replacement, and fence late effects. Timeouts cannot force a noncooperative
 * adapter to stop. Cleanup has a separate shared <=15s deadline, ignores user
 * cancellation, and quits only after confirmed safe collector teardown.
 * No admission if initial ownership is invalid; the external driver then owns
 * its already-created fixture. Diagnostic limits outside branch records (total
 * output/resources/launch count) also remain the absent driver's responsibility.
 *
 * Strings/booleans cannot prove native facts: complete means this coordination
 * contract succeeded. Only a finalized kind:'native' adapter attestation permits
 * an interpretation, explicitly scoped to adapter-attested branch order.
 * Synthetic receipts never yield interpreted native observations. A real driver
 * still needs independent review, frozen identities and live D-07 approval.
 */
export function createStartupBranchCoordinator({ fixture, collector } = {}) {
  let admitted = false;
  return Object.freeze({
    async run({ enabled = false, earlyRuntime = false, signal,
      armingTimeoutMs = 10000, observationTimeoutMs = 5000, cleanupTimeoutMs = 15000 } = {}) {
      const empty = code => ({ complete: false, code, evidenceScope: null, interpretation: null });
      if (enabled !== true) return empty('BRANCH_COORDINATOR_DISABLED');
      if (admitted) return empty('BRANCH_COORDINATOR_ALREADY_USED');
      admitted = true;
      if (signal?.aborted) return empty('BRANCH_INTERRUPTED');
      if (typeof earlyRuntime !== 'boolean'
        || ![[armingTimeoutMs, 10000], [observationTimeoutMs, 5000], [cleanupTimeoutMs, 15000]]
          .every(([n, max]) => Number.isSafeInteger(n) && n >= 1 && n <= max)
        || !['readState', 'observeCommitted', 'quit', ...(earlyRuntime ? ['enableRuntime'] : [])]
          .every(name => typeof fixture?.[name] === 'function')
        || !['arm', 'begin', 'stopAndDrain', 'removeSites', 'detachAndResume']
          .every(name => typeof collector?.[name] === 'function')) return empty('BRANCH_ADAPTER_INVALID');

      let failure = null; let binding = null; let provenance = null; let armAttempted = false;
      let accepting = false; let sealed = false; let overflow = false; let finalized = false;
      let traceValidated = false; let interpretation = null;
      const events = []; const pending = new Set(); let armedSites = [];
      const work = new AbortController();
      const cleanup = { drained: false, sitesRemoved: false, detached: false, resumed: false,
        callbacksRemoved: false, operationsSettled: false, quitConfirmed: false };
      const fail = code => { failure ??= code; if (!work.signal.aborted) work.abort(); };
      const interrupted = () => fail('BRANCH_INTERRUPTED');
      signal?.addEventListener('abort', interrupted, { once: true });
      const bound = receipt => exact(receipt, ['owner', 'nonce']) && receipt.nonce === binding.nonce
        && sameOwner(receipt.owner, binding.owner);
      const trace = complete => JSON.stringify({ schemaVersion: 1, runtime: STARTUP_BRANCH_RUNTIME,
        armedSites, events, complete, overflow, detached: cleanup.detached });
      const onRecord = text => {
        try {
          check(accepting && !sealed && !failure, 'BRANCH_RECORD_PHASE');
          const event = parse(text, 512);
          check(exact(event, ['sequence', 'threadOrdinal', 'site']) && event.sequence === events.length + 1
            && Number.isSafeInteger(event.threadOrdinal) && event.threadOrdinal >= 1 && event.threadOrdinal <= 16
            && ids.includes(event.site), 'BRANCH_EVENT_INVALID');
          if (events.length >= 256) { overflow = true; throw new CoordinationError('BRANCH_EVENT_LIMIT'); }
          events.push(event);
          if (Buffer.byteLength(trace(false), 'utf8') > 65536) {
            events.pop(); overflow = true; throw new CoordinationError('BRANCH_INPUT_LIMIT');
          }
          return true;
        } catch (error) { fail(error instanceof CoordinationError ? error.code : 'BRANCH_RECORD_INVALID'); return false; }
      };
      const call = async (target, method, args, until, operationSignal, code) => {
        check(!operationSignal.aborted, failure ?? code);
        const remaining = until - performance.now();
        check(remaining > 0, code);
        let timer; let aborted;
        const interruptedPromise = new Promise((_, reject) => {
          aborted = () => reject(new CoordinationError(failure ?? code));
          operationSignal.addEventListener('abort', aborted, { once: true });
          timer = setTimeout(() => reject(new CoordinationError(code)), remaining);
        });
        let operation;
        try {
          operation = new Promise((resolve, reject) => {
            const accept = value => {
              if (typeof value !== 'string') reject(new CoordinationError('BRANCH_RECEIPT_INVALID'));
              else resolve(value);
            };
            try {
              check(!operationSignal.aborted, failure ?? code);
              const value = target[method]({ ...args, signal: operationSignal });
              if (types.isPromise(value)) Promise.prototype.then.call(value, accept, reject);
              else accept(value);
            } catch (error) { reject(error); }
          });
          pending.add(operation);
          operation.then(() => pending.delete(operation), () => pending.delete(operation));
          const result = await Promise.race([operation, interruptedPromise]);
          check(!operationSignal.aborted, failure ?? code);
          check(performance.now() <= until, code);
          return parse(result);
        } finally { clearTimeout(timer); operationSignal.removeEventListener('abort', aborted); }
      };
      const readOwned = async (phase, until, timeoutCode = 'BRANCH_OBSERVATION_TIMEOUT') => {
        const state = await call(fixture, 'readState', {}, until, work.signal, timeoutCode);
        check(exact(state, ['owner', 'phase']) && state.phase === phase && sameOwner(state.owner, binding.owner), 'BRANCH_OWNER_CHANGED');
      };
      try {
        const armingUntil = performance.now() + armingTimeoutMs;
        const state = await call(fixture, 'readState', {}, armingUntil, work.signal, 'BRANCH_ARMING_TIMEOUT');
        check(exact(state, ['owner', 'phase']) && state.phase === 'held' && exact(state.owner, ownerKeys)
          && ownerKeys.every(key => Number.isSafeInteger(state.owner[key]) && state.owner[key] >= (key === 'frameRoutingId' ? 0 : 1)), 'BRANCH_OWNER_INVALID');
        binding = Object.freeze({ owner: Object.freeze(state.owner), nonce: randomUUID() });
        armAttempted = true;
        const armed = await call(collector, 'arm', { binding, runtime: STARTUP_BRANCH_RUNTIME,
          sites: STARTUP_BRANCH_SITES, onRecord }, armingUntil, work.signal, 'BRANCH_ARMING_TIMEOUT');
        check(exact(armed, ['binding', 'runtime', 'sites', 'provenance']) && bound(armed.binding)
          && sameRuntime(armed.runtime) && validProvenance(armed.provenance), 'BRANCH_ARMING_INVALID');
        check(Array.isArray(armed.sites) && armed.sites.length === ids.length
          && new Set(armed.sites.map(site => site?.id)).size === ids.length
          && armed.sites.every(site => exact(site, ['id', 'address', 'instructionWord', 'locations', 'enabled'])
            && site.locations === 1 && site.enabled === true && STARTUP_BRANCH_SITES.some(expected =>
              expected.id === site.id && expected.address === site.address && expected.instructionWord === site.instructionWord)), 'BRANCH_SITES_INCOMPLETE');
        provenance = Object.freeze(armed.provenance);
        armedSites = [...ids];
        await readOwned('held', armingUntil, 'BRANCH_ARMING_TIMEOUT');
        const observingUntil = performance.now() + observationTimeoutMs;
        accepting = true;
        const begun = await call(collector, 'begin', { binding }, observingUntil, work.signal, 'BRANCH_OBSERVATION_TIMEOUT');
        check(exact(begun, ['binding', 'recording', 'resumed']) && bound(begun.binding)
          && begun.recording === true && begun.resumed === true, 'BRANCH_BEGIN_INVALID');
        await readOwned('held', observingUntil);
        if (earlyRuntime) {
          const triggered = await call(fixture, 'enableRuntime', { binding }, observingUntil, work.signal, 'BRANCH_OBSERVATION_TIMEOUT');
          check(exact(triggered, ['binding', 'enabled']) && bound(triggered.binding) && triggered.enabled === true, 'BRANCH_RUNTIME_INVALID');
        }
        const committed = await call(fixture, 'observeCommitted', { binding }, observingUntil, work.signal, 'BRANCH_OBSERVATION_TIMEOUT');
        check(exact(committed, ['binding', 'released', 'committed', 'preload', 'loaded', 'heldObservedMs', 'committedObservedMs'])
          && bound(committed.binding) && ['released', 'committed', 'preload', 'loaded'].every(key => committed[key] === true)
          && ['heldObservedMs', 'committedObservedMs'].every(key => typeof committed[key] === 'number'
            && Number.isFinite(committed[key]) && committed[key] >= 250 && committed[key] <= observationTimeoutMs), 'BRANCH_COMMIT_INVALID');
        await readOwned('committed', observingUntil);
      } catch (error) { fail(error instanceof CoordinationError ? error.code : 'BRANCH_ADAPTER_FAILED'); }
      finally {
        const cleanupWork = new AbortController();
        const cleanupUntil = performance.now() + cleanupTimeoutMs;
        const cleanupTimer = setTimeout(() => cleanupWork.abort(), cleanupTimeoutMs);
        const attempt = async (method, args, validate, target = collector) => {
          try {
            const result = await call(target, method, args, cleanupUntil, cleanupWork.signal, 'BRANCH_CLEANUP_TIMEOUT');
            validate(result);
          } catch (error) { fail(error instanceof CoordinationError ? error.code : 'BRANCH_CLEANUP_FAILED'); }
        };
        try {
          if (armAttempted) {
            await attempt('stopAndDrain', { binding }, result => {
              check(exact(result, ['binding', 'quiescent', 'complete', 'overflow', 'lossless', 'recordCount'])
                && bound(result.binding) && result.quiescent === true, 'BRANCH_DRAIN_INVALID');
              cleanup.drained = true;
              overflow ||= result.overflow === true;
              check(result.complete === true && result.overflow === false && result.lossless === true
                && result.recordCount === events.length, 'BRANCH_COLLECTION_INCOMPLETE');
            });
            sealed = true; accepting = false;
            // Fence every previously admitted operation BEFORE final removal
            // and detach. Waiting after detach could allow a late arm to create
            // a fresh attachment after the last supposedly safe teardown.
            if (pending.size) {
              const outstanding = [...pending];
              await attempt('settle', {}, () => {}, { settle: async () => {
                await Promise.allSettled(outstanding); return '{}';
              } });
            }
            await attempt('removeSites', { binding, sites: STARTUP_BRANCH_SITES }, result => {
              check(exact(result, ['binding', 'removedSites', 'remaining']) && bound(result.binding)
                && allIds(result.removedSites) && result.remaining === 0, 'BRANCH_REMOVAL_INVALID');
              cleanup.sitesRemoved = true;
            });
            await attempt('detachAndResume', { binding }, result => {
              check(exact(result, ['binding', 'runtime', 'provenance', 'finalized', 'detached', 'resumed', 'callbacksRemoved', 'debuggerExited'])
                && bound(result.binding) && sameRuntime(result.runtime)
                && ['detached', 'resumed', 'callbacksRemoved', 'debuggerExited'].every(key => result[key] === true), 'BRANCH_DETACH_INVALID');
              cleanup.detached = true; cleanup.resumed = true; cleanup.callbacksRemoved = true;
              check(result.finalized === true && provenance !== null && sameProvenance(result.provenance, provenance), 'BRANCH_PROVENANCE_INVALID');
              finalized = true;
            });
          }
          cleanup.operationsSettled = pending.size === 0;
          if (binding && cleanup.drained && cleanup.sitesRemoved && cleanup.detached
            && cleanup.resumed && cleanup.callbacksRemoved && cleanup.operationsSettled) {
            await attempt('quit', { binding }, result => {
              check(exact(result, ['binding', 'normalQuit', 'fixtureExited', 'rendererExited']) && bound(result.binding)
                && ['normalQuit', 'fixtureExited', 'rendererExited'].every(key => result[key] === true), 'BRANCH_QUIT_INVALID');
              cleanup.quitConfirmed = true;
            }, fixture);
          }
        } finally {
          clearTimeout(cleanupTimer); cleanupWork.abort();
          // quit itself is admitted work and may have outlived its deadline.
          cleanup.operationsSettled = pending.size === 0;
        }
      }
      signal?.removeEventListener('abort', interrupted);
      if (signal?.aborted) fail('BRANCH_INTERRUPTED');
      if (!failure && finalized && Object.values(cleanup).every(value => value === true)) {
        const analyzed = analyzeStartupBranchTrace(trace(true));
        if (!analyzed.complete) fail(analyzed.code);
        else { traceValidated = true; if (provenance.kind === 'native') interpretation = analyzed; }
      }
      if (!traceValidated && !failure) fail('BRANCH_COORDINATION_INCOMPLETE');
      const complete = !failure && traceValidated;
      return { complete, code: failure, interrupted: signal?.aborted === true,
        evidenceScope: complete ? (provenance.kind === 'synthetic' ? 'synthetic-coordination-only' : 'adapter-attested-native-branch-order-only') : null,
        provenance, binding, cleanup, traceValidated, trace: trace(complete), interpretation: complete ? interpretation : null };
    }
  });
}
