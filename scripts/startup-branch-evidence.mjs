// Offline interpretation contract for a separately approved native diagnostic.
// This module never launches, attaches to, reads, or changes a target process.
export const STARTUP_BRANCH_RUNTIME = Object.freeze({
  architecture: 'arm64',
  uuid: '4C4C44A4-5555-3144-A179-5C2625687460',
  sha256: '965d9ff595733e27add2ae5ce279307aa632d6a707313fc61171c3035bd1aecf'
});

// Unslid linked addresses in the identified framework. Ownership is established
// by the matching dSYM, not the stripped binary's nearest exported symbol name.
export const STARTUP_BRANCH_SITES = Object.freeze([
  ['service-check', '0x19ee160', '540015c0'],
  ['service-fallthrough', '0x19ee164', '9102a101'],
  ['payload-check', '0x1e90cb4', 'b4007b68'],
  ['payload-fallthrough', '0x1e90cb8', 'aa0103fc'],
  ['payload-null', '0x1e91c20', 'd2800014'],
  ['result-check', '0x19ee174', 'b4001520'],
  ['null-fallback', '0x19ee418', '910fa276'],
  ['result-merge', '0x19ee178', 'f9401bf8']
].map(([id, address, instructionWord]) => Object.freeze({ id, address, instructionWord })));

const ids = STARTUP_BRANCH_SITES.map(site => site.id);
const allowedSites = new Set(ids);
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = code => ({ complete: false, code, observations: [] });

/**
 * Interpret bounded serialized JSON for one externally verified owned renderer.
 * Accepting text, not arbitrary caller objects, prevents accessors from changing
 * validated fields or introducing private values during output construction.
 * The parsed report describes a lossless branch stream for the owned renderer.
 * Runtime identity, actual breakpoint arming, thread-ordinal mapping,
 * instruction bytes and clean detach must be established by a future collector.
 * Strings/booleans supplied to this function cannot establish those facts.
 *
 * This deliberately does not infer Blink's initial-document flag, frame/world
 * identity, a conversion failure, successful preload execution or root cause.
 */
export function analyzeStartupBranchTrace(serialized) {
  if (typeof serialized !== 'string') return fail('BRANCH_INPUT_INVALID');
  if (serialized.length > 65536 || Buffer.byteLength(serialized, 'utf8') > 65536) return fail('BRANCH_INPUT_LIMIT');
  let report;
  try { report = JSON.parse(serialized); } catch { return fail('BRANCH_INPUT_INVALID'); }
  if (!exactKeys(report, ['schemaVersion', 'runtime', 'armedSites', 'events', 'complete', 'overflow', 'detached'])
    || report.schemaVersion !== 1
    || !exactKeys(report.runtime, ['architecture', 'uuid', 'sha256'])
    || Object.entries(STARTUP_BRANCH_RUNTIME).some(([key, value]) => report.runtime[key] !== value)) return fail('BRANCH_IDENTITY_INVALID');
  if (report.complete !== true || report.overflow !== false || report.detached !== true) return fail('BRANCH_COLLECTION_INCOMPLETE');
  if (!Array.isArray(report.armedSites) || report.armedSites.length !== ids.length
    || new Set(report.armedSites).size !== ids.length || report.armedSites.some(id => !allowedSites.has(id))) return fail('BRANCH_SITES_INCOMPLETE');
  if (!Array.isArray(report.events) || report.events.length < 1 || report.events.length > 256) return fail('BRANCH_EVENT_LIMIT');

  const active = new Map();
  const invocationCounts = new Map();
  const observations = [];
  for (const [index, event] of report.events.entries()) {
    if (!exactKeys(event, ['sequence', 'threadOrdinal', 'site']) || event.sequence !== index + 1
      || !Number.isSafeInteger(event.threadOrdinal) || event.threadOrdinal < 1 || event.threadOrdinal > 16
      || !allowedSites.has(event.site)) return fail('BRANCH_EVENT_INVALID');
    const thread = event.threadOrdinal;
    let state = active.get(thread);
    if (event.site === 'service-check') {
      // A nested call on the same thread is intentionally inconclusive; without
      // stack/instance data, flattening it could attribute another call's result.
      if (state) return fail('BRANCH_REENTRANT_OR_LOST_EVENT');
      state = { stage: 'service', startSequence: event.sequence, payload: null, outcome: null };
      active.set(thread, state);
      continue;
    }
    if (!state) return fail('BRANCH_ORPHAN_EVENT');
    if (state.stage === 'service' && event.site === 'service-fallthrough') state.stage = 'payload-check';
    else if (state.stage === 'service' && event.site === 'null-fallback') {
      state.outcome = 'service-guard-fallback'; state.stage = 'merge';
    } else if (state.stage === 'payload-check' && event.site === 'payload-check') state.stage = 'payload';
    else if (state.stage === 'payload' && ['payload-fallthrough', 'payload-null'].includes(event.site)) {
      state.payload = event.site === 'payload-null' ? 'null' : 'non-null'; state.stage = 'result-check';
    } else if (state.stage === 'result-check' && event.site === 'result-check') state.stage = 'result';
    else if (state.stage === 'result' && event.site === 'null-fallback') {
      state.outcome = state.payload === 'null' ? 'null-payload-fallback' : 'non-null-payload-empty-result';
      state.stage = 'merge';
    } else if (state.stage === 'result' && event.site === 'result-merge' && state.payload === 'non-null') {
      state.outcome = 'nonempty-result'; state.stage = 'done';
    } else if (state.stage === 'merge' && event.site === 'result-merge') state.stage = 'done';
    else return fail('BRANCH_ORDER_INVALID');

    if (state.stage === 'done') {
      const invocation = (invocationCounts.get(thread) ?? 0) + 1;
      invocationCounts.set(thread, invocation);
      observations.push({ threadOrdinal: thread, invocation, startSequence: state.startSequence,
        endSequence: event.sequence, outcome: state.outcome });
      active.delete(thread);
    }
  }
  if (active.size || !observations.length) return fail('BRANCH_INVOCATION_INCOMPLETE');
  return { complete: true, code: null, scope: 'branch-order-only', observations };
}
