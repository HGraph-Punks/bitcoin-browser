import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONTENT_NETWORK_REQUEST_FILTER, createContentNetworkPolicyApplier } from '../src/main/content-network-policy.js';
import { ORD_DOCUMENT_URL, runStockFrameMatrix, stockFrameDocuments } from './diagnose-stock-frame-placement.mjs';
import { parseWalletRegistrationEvidence } from './diagnose-stock-wallet-registration.mjs';
import { requestPolicySourceEvidence, stockRequestPolicyMainSource } from './diagnose-stock-request-policy.mjs';
import { STOCK_MODES, classifyCleanExit, classifyExperimentCompletion, classifyStockRun } from './diagnose-stock-network-shutdown.mjs';

export const POLICY_TRANSITIONS = Object.freeze(['blocked', 'offline']);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reviewed policy transition insertion point changed');
  return source.replace(before, after);
}

export function buildPolicyTransitionSchedule(repeat = 2) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 2) throw new TypeError('Repeat must be 1 or 2');
  const rows = [];
  for (const mode of STOCK_MODES) for (let run = 1; run <= repeat; run += 1) {
    for (const transition of run % 2 ? POLICY_TRANSITIONS : [...POLICY_TRANSITIONS].reverse()) rows.push({ mode, run, transition, placement: 'opaque-child' });
  }
  return rows;
}

export function stockPolicyTransitionMainSource(transition, mode, endpoint) {
  if (!POLICY_TRANSITIONS.includes(transition) || !STOCK_MODES.includes(mode)) throw new TypeError('Unknown policy transition fixture mode');
  let source = stockRequestPolicyMainSource('present', mode, endpoint, 'production');
  source = replaceOnce(source,
    "  const requestPolicySettings = Object.freeze({ offlineMode: false, contentNetworkPolicy: 'https-only' });",
    `  let requestPolicySettings = Object.freeze({ offlineMode: false, contentNetworkPolicy: 'https-only' });
  const transitionTarget = ${JSON.stringify(transition)};
  const ownedTransitionOrigin = ${JSON.stringify(new URL(endpoint).origin)};
  const createContentNetworkPolicyApplier = ${createContentNetworkPolicyApplier.toString()};
  let closeAllConnectionsCalls = 0;
  let transitionControlCalls = 0;
  let firstProbeOutcome = null;
  let transitionAppliedAtSecondProbe = false;
  let transitionApplied = false;
  let transitionFailure = false;
  const applyTransition = createContentNetworkPolicyApplier(async () => { closeAllConnectionsCalls += 1; await persistent.closeAllConnections(); });`);
  source = replaceOnce(source,
    `  if (requestPolicyMode === 'present') persistent.webRequest.onBeforeRequest(${JSON.stringify(CONTENT_NETWORK_REQUEST_FILTER)}, (details, callback) => {
    const allowed = isContentRequestAllowed(details, requestPolicySettings);`,
    `  if (requestPolicyMode === 'present') persistent.webRequest.onBeforeRequest(${JSON.stringify(CONTENT_NETWORK_REQUEST_FILTER)}, (details, callback) => {
    let transitionRequest = null;
    try { transitionRequest = new URL(details?.url); } catch {}
    const transitionOutcome = transitionRequest?.searchParams.get('first');
    const validTransitionRequest = transitionRequest?.origin === ownedTransitionOrigin && transitionRequest.pathname === '/transition'
      && [...transitionRequest.searchParams.keys()].length === 1 && ['response', 'opened', 'rejected', 'bounded-timeout', 'thrown'].includes(transitionOutcome)
      && details?.resourceType === 'xhr' && transitionControlCalls === 0 && requestPolicyTargetCalls === 1;
    if (validTransitionRequest) {
      transitionControlCalls += 1;
      firstProbeOutcome = transitionOutcome;
      const previous = requestPolicySettings;
      requestPolicySettings = Object.freeze(transitionTarget === 'offline'
        ? { offlineMode: true, contentNetworkPolicy: 'https-only' }
        : { offlineMode: false, contentNetworkPolicy: 'blocked' });
      Promise.resolve().then(() => applyTransition(previous, requestPolicySettings)).then(() => {
        transitionApplied = true; callback({ cancel: true });
      }, () => { transitionFailure = true; callback({ cancel: true }); });
      return;
    }
    const allowed = isContentRequestAllowed(details, requestPolicySettings);`);
  source = replaceOnce(source, '      requestPolicyTargetCalls += 1;', `      requestPolicyTargetCalls += 1;
      if (requestPolicyTargetCalls === 2) transitionAppliedAtSecondProbe = transitionApplied;`);
  source = replaceOnce(source,
    `app.once('before-quit', () => process.stdout.write('STOCK_REQUEST_POLICY:' + JSON.stringify({ policyMode: requestPolicyMode,
    handlerInstalled: requestPolicyMode === 'present', targetCalls: requestPolicyTargetCalls, observations: requestPolicyObservations,
    observationOverflow: requestPolicyOverflow, unexpectedExternalCount: requestPolicyUnexpectedExternal }) + '\\n'));`,
    `app.once('before-quit', () => process.stdout.write('STOCK_REQUEST_POLICY:' + JSON.stringify({ transition: transitionTarget,
    handlerInstalled: true, targetCalls: requestPolicyTargetCalls, observations: requestPolicyObservations,
    observationOverflow: requestPolicyOverflow, unexpectedExternalCount: requestPolicyUnexpectedExternal,
    transitionApplied, transitionFailure, transitionControlCalls, firstProbeOutcome, transitionAppliedAtSecondProbe, closeAllConnectionsCalls }) + '\\n'));`);
  return source;
}

function twoProbeScript(mode, endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Policy transition endpoint must be loopback raw TLS');
  const target = `${mode === 'wss' ? endpoint.replace(/^https:/, 'wss:') : endpoint}/probe`;
  const transitionUrl = `${endpoint}/transition`;
  const credentials = mode === 'https-include' ? 'include' : 'same-origin';
  return `(() => {
  const target = ${JSON.stringify(target)};
  const attempt = () => new Promise((resolve) => {
    try {
      if (${JSON.stringify(mode)} === 'wss') {
        const socket = new WebSocket(target); let done = false;
        const timer = setTimeout(() => finish('bounded-timeout'), 900);
        const finish = (outcome) => { if (done) return; done = true; clearTimeout(timer); try { socket.close(); } catch {} resolve(outcome); };
        socket.onopen = () => finish('opened'); socket.onerror = () => finish('rejected');
      } else {
        const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); resolve('bounded-timeout'); }, 900);
        fetch(target, { credentials: ${JSON.stringify(credentials)}, signal: controller.signal }).then(
          () => { clearTimeout(timer); resolve('response'); }, () => { clearTimeout(timer); resolve('rejected'); });
      }
    } catch { resolve('thrown'); }
  });
  attempt().then((first) => fetch(${JSON.stringify(transitionUrl)} + '?first=' + encodeURIComponent(first)).then(() => {}, () => {})).then(attempt)
    .then((second) => console.log('STOCK_PROBE_DONE:' + second));
})();`;
}

export function stockPolicyTransitionDocuments(mode, endpoint) {
  const documents = stockFrameDocuments('opaque-child', mode, endpoint);
  const childPrefix = documents.childHtml.slice(0, documents.childHtml.indexOf('(() => {'));
  if (!childPrefix || !documents.childHtml.endsWith('</script>')) throw new Error('Reviewed child probe insertion point changed');
  return { ...documents, childHtml: `${childPrefix}${twoProbeScript(mode, endpoint)}</script>` };
}

export function parsePolicyTransitionEvidence(line, transition, mode) {
  if (!POLICY_TRANSITIONS.includes(transition) || !STOCK_MODES.includes(mode) || typeof line !== 'string' || line.length > 8192) return null;
  const match = /^STOCK_REQUEST_POLICY:(\{[^\n]+\})$/.exec(line); if (!match) return null;
  let value; try { value = JSON.parse(match[1]); } catch { return null; }
  const scheme = mode === 'wss' ? 'wss:' : 'https:'; const resourceType = mode === 'wss' ? 'webSocket' : 'xhr';
  if (value?.transition !== transition || value.handlerInstalled !== true || value.targetCalls !== 2
    || value.transitionApplied !== true || value.transitionAppliedAtSecondProbe !== true || value.transitionFailure !== false
    || value.transitionControlCalls !== 1 || value.firstProbeOutcome !== 'rejected' || value.closeAllConnectionsCalls !== 1
    || value.observationOverflow !== false || value.unexpectedExternalCount !== 0 || !Array.isArray(value.observations) || value.observations.length !== 2) return null;
  if (value.observations.some((item, index) => item?.scheme !== scheme || item.resourceType !== resourceType || item.allowed !== (index === 0))) return null;
  return value;
}

export function summarizePolicyTransitionReport(report) {
  const expected = buildPolicyTransitionSchedule(report.config.repeat); const runs = report.runs;
  const complete = !report.failure && report.stoppedReason === null && runs.length === expected.length
    && expected.every((item, index) => ['mode', 'run', 'transition', 'placement'].every((key) => item[key] === runs[index]?.[key]))
    && runs.every((run) => run.closed === true);
  return { complete, passing: complete && runs.every((run) => run.outcome === 'rejected' && run.transitionValid && run.walletRegistrationValid && run.frameValid
      && run.probeSourceValid && run.preloadValid && run.documentValid && run.topologyValid && classifyStockRun(run)),
    experimentsCompleted: runs.filter(classifyExperimentCompletion).length, cleanExits: runs.filter(classifyCleanExit).length,
    positiveControlsWithRawTlsActivity: runs.filter((run) => run.networkExpectationMet).length,
    deniedSecondCallbacks: runs.filter((run) => run.transitionEvidence?.observations?.[1]?.allowed === false).length,
    establishedConnectionCutoffQualified: false };
}

const definition = Object.freeze({
  buildSchedule: buildPolicyTransitionSchedule,
  mainSource: (item, endpoint) => stockPolicyTransitionMainSource(item.transition, item.mode, endpoint),
  documents: (item, endpoint) => stockPolicyTransitionDocuments(item.mode, endpoint),
  profileKey: (item) => `${item.transition}-${item.mode}`,
  augment(result, item) {
    result.walletRegistrationEvidence = parseWalletRegistrationEvidence(result.walletRegistrationReady, 'present');
    result.walletRegistrationValid = result.walletRegistrationMarkerCount === 1 && result.walletRegistrationEvidence !== null;
    result.transitionEvidence = parsePolicyTransitionEvidence(result.requestPolicyReady, item.transition, item.mode);
    result.transitionValid = result.requestPolicyMarkerCount === 1 && result.transitionEvidence !== null && result.outcome === 'rejected';
    result.variantValid = result.walletRegistrationValid && result.transitionValid;
  },
  summarize: summarizePolicyTransitionReport,
  config: (repeat) => ({ repeat, modes: STOCK_MODES, transitions: POLICY_TRANSITIONS, placement: 'opaque-child', documentMode: 'app', preloadMode: 'application',
    topology: 'named-dual', walletRegistrationMode: 'present', requestFilter: CONTENT_NETWORK_REQUEST_FILTER, initialSettings: { offlineMode: false, contentNetworkPolicy: 'https-only' },
    policySource: { ...requestPolicySourceEvidence, transitionApplierSha256: digest(createContentNetworkPolicyApplier.toString()) },
    establishedConnectionCutoffScope: 'not-qualified-raw-tls-only' }),
  purpose: 'Owned raw-TLS callback and new-probe policy-transition diagnostic; does not establish certificate-valid connection cutoff.',
  rootPrefix: 'satoshi-stock-policy-transition-',
  preloadScope: 'Unmodified application preload; bridge APIs observed but not invoked.',
  invalidReason: 'POLICY_TRANSITION_EVIDENCE_INVALID'
});

export function runStockPolicyTransitions(options, dependencies) { return runStockFrameMatrix(options, dependencies, definition); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); if (args.length !== 1 || !args[0].startsWith('--output=') || !args[0].slice(9)) throw new Error('Usage: --output=/absolute/new-report.json');
  runStockPolicyTransitions({ output: args[0].slice(9) }).then((report) => { process.stdout.write(`${JSON.stringify(report.summary)}\n`); if (!report.summary.passing) process.exitCode = 1; },
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
