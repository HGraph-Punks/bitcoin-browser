import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONTENT_NETWORK_REQUEST_FILTER, effectiveContentNetworkPolicy, isContentRequestAllowed } from '../src/main/content-network-policy.js';
import { runStockFrameMatrix, stockFrameDocuments } from './diagnose-stock-frame-placement.mjs';
import { parseWalletRegistrationEvidence, stockWalletRegistrationMainSource } from './diagnose-stock-wallet-registration.mjs';
import { STOCK_MODES, classifyCleanExit, classifyExperimentCompletion, classifyStockRun } from './diagnose-stock-network-shutdown.mjs';

export const REQUEST_POLICY_MODES = Object.freeze(['absent', 'present']);
export const REQUEST_FILTER_MODES = Object.freeze(['legacy', 'production']);
export const LEGACY_REQUEST_FILTER = Object.freeze({ urls: Object.freeze(['*://*/*']) });
const INTERNAL_SCHEMES_SOURCE = "const INTERNAL_SCHEMES = new Set(['app:', 'ord:', 'data:', 'blob:', 'devtools:']);";
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const requestPolicySourceEvidence = Object.freeze({
  internalSchemesSha256: digest(INTERNAL_SCHEMES_SOURCE),
  effectivePolicySha256: digest(effectiveContentNetworkPolicy.toString()),
  requestDecisionSha256: digest(isContentRequestAllowed.toString())
});
export const requestFilterEvidence = Object.freeze({
  legacy: Object.freeze({ urls: LEGACY_REQUEST_FILTER.urls, sha256: digest(JSON.stringify(LEGACY_REQUEST_FILTER)) }),
  production: Object.freeze({ urls: CONTENT_NETWORK_REQUEST_FILTER.urls, sha256: digest(JSON.stringify(CONTENT_NETWORK_REQUEST_FILTER)) })
});

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reviewed request policy insertion point changed');
  return source.replace(before, after);
}

export function buildRequestPolicySchedule(repeat = 2) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 2) throw new TypeError('Repeat must be 1 or 2');
  const rows = [];
  for (const mode of STOCK_MODES) for (let run = 1; run <= repeat; run += 1) {
    for (const policyMode of run % 2 ? REQUEST_POLICY_MODES : [...REQUEST_POLICY_MODES].reverse()) rows.push({ mode, run, policyMode, placement: 'opaque-child' });
  }
  return rows;
}

export function stockRequestPolicyMainSource(policyMode, mode, endpoint, requestFilter = 'legacy') {
  if (!REQUEST_POLICY_MODES.includes(policyMode) || !STOCK_MODES.includes(mode)) throw new TypeError('Unknown request policy fixture mode');
  if (!REQUEST_FILTER_MODES.includes(requestFilter)) throw new TypeError('Unknown request filter mode');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Request policy endpoint must be loopback raw TLS');
  const baseProbeUrl = endpoint.replace(/\/$/, '');
  const probeUrl = `${mode === 'wss' ? baseProbeUrl.replace(/^https:/, 'wss:') : baseProbeUrl}/probe`;
  const filterSource = requestFilter === 'legacy' ? "{ urls: ['*://*/*'] }" : JSON.stringify(CONTENT_NETWORK_REQUEST_FILTER);
  let source = stockWalletRegistrationMainSource('present');
  source = replaceOnce(source, '  let browserWindowCount = 0;', `  ${INTERNAL_SCHEMES_SOURCE}
  const effectiveContentNetworkPolicy = ${effectiveContentNetworkPolicy.toString()};
  const isContentRequestAllowed = ${isContentRequestAllowed.toString()};
  const requestPolicyMode = ${JSON.stringify(policyMode)};
  const requestPolicySettings = Object.freeze({ offlineMode: false, contentNetworkPolicy: 'https-only' });
  const ownedProbeUrl = ${JSON.stringify(probeUrl)};
  let requestPolicyTargetCalls = 0;
  let requestPolicyUnexpectedExternal = 0;
  let requestPolicyOverflow = false;
  const requestPolicyObservations = [];
  if (requestPolicyMode === 'present') persistent.webRequest.onBeforeRequest(${filterSource}, (details, callback) => {
    const allowed = isContentRequestAllowed(details, requestPolicySettings);
    let scheme = null;
    try { scheme = new URL(details?.url).protocol; } catch {}
    if (details?.url === ownedProbeUrl) {
      requestPolicyTargetCalls += 1;
      if (requestPolicyObservations.length < 8) requestPolicyObservations.push({ scheme, resourceType: String(details?.resourceType ?? '').slice(0, 40), allowed });
      else requestPolicyOverflow = true;
    } else if (['http:', 'https:', 'ws:', 'wss:'].includes(scheme)) requestPolicyUnexpectedExternal += 1;
    callback({ cancel: !allowed });
  });
  let browserWindowCount = 0;`);
  source = replaceOnce(source, "  app.once('before-quit', () => process.stdout.write('STOCK_WALLET_REGISTRATION:'", `  app.once('before-quit', () => process.stdout.write('STOCK_REQUEST_POLICY:' + JSON.stringify({ policyMode: requestPolicyMode,
    handlerInstalled: requestPolicyMode === 'present', targetCalls: requestPolicyTargetCalls, observations: requestPolicyObservations,
    observationOverflow: requestPolicyOverflow, unexpectedExternalCount: requestPolicyUnexpectedExternal }) + '\\n'));
  app.once('before-quit', () => process.stdout.write('STOCK_WALLET_REGISTRATION:'`);
  return source;
}

export function parseRequestPolicyEvidence(line, policyMode, mode) {
  if (!REQUEST_POLICY_MODES.includes(policyMode) || !STOCK_MODES.includes(mode) || typeof line !== 'string' || line.length > 8192) return null;
  const match = /^STOCK_REQUEST_POLICY:(\{[^\n]+\})$/.exec(line);
  if (!match) return null;
  let value; try { value = JSON.parse(match[1]); } catch { return null; }
  const present = policyMode === 'present'; const expectedScheme = mode === 'wss' ? 'wss:' : 'https:';
  if (value?.policyMode !== policyMode || value.handlerInstalled !== present || value.targetCalls !== (present ? 1 : 0)
    || value.observationOverflow !== false || value.unexpectedExternalCount !== 0 || !Array.isArray(value.observations)
    || value.observations.length !== (present ? 1 : 0)) return null;
  if (present) {
    const observation = value.observations[0];
    const expectedResourceType = mode === 'wss' ? 'webSocket' : 'xhr';
    if (observation?.scheme !== expectedScheme || observation.allowed !== true || observation.resourceType !== expectedResourceType) return null;
  }
  return value;
}

export function summarizeRequestPolicyReport(report) {
  const expected = buildRequestPolicySchedule(report.config.repeat); const runs = report.runs;
  const complete = !report.failure && report.stoppedReason === null && runs.length === expected.length
    && expected.every((item, index) => ['mode', 'run', 'policyMode', 'placement'].every((key) => item[key] === runs[index]?.[key]))
    && runs.every((run) => run.closed === true);
  return { complete, passing: complete && runs.every((run) => run.requestPolicyValid && run.walletRegistrationValid && run.frameValid
      && run.probeSourceValid && run.preloadValid && run.documentValid && run.topologyValid && classifyStockRun(run)),
    experimentsCompleted: runs.filter(classifyExperimentCompletion).length, cleanExits: runs.filter(classifyCleanExit).length,
    expectedRawTlsActivity: runs.filter((run) => run.networkExpectationMet).length,
    policyCallbacksObserved: runs.filter((run) => run.requestPolicyEvidence?.targetCalls === 1).length };
}

export function parseRequestPolicyArgs(args) {
  const outputArgs = args.filter((arg) => arg.startsWith('--output=')); const filterArgs = args.filter((arg) => arg.startsWith('--request-filter='));
  if (outputArgs.length !== 1 || filterArgs.length > 1 || outputArgs.length + filterArgs.length !== args.length || outputArgs[0].slice(9).length === 0) throw new Error('Usage: --output=/absolute/new-report.json [--request-filter=legacy|production]');
  const requestFilter = filterArgs.length ? filterArgs[0].slice('--request-filter='.length) : 'legacy';
  if (!REQUEST_FILTER_MODES.includes(requestFilter)) throw new Error('Usage: --output=/absolute/new-report.json [--request-filter=legacy|production]');
  return { output: outputArgs[0].slice(9), requestFilter };
}

function definitionFor(requestFilter) { return Object.freeze({
  buildSchedule: buildRequestPolicySchedule,
  mainSource: (item, endpoint) => stockRequestPolicyMainSource(item.policyMode, item.mode, endpoint, requestFilter),
  documents: (item, endpoint) => stockFrameDocuments('opaque-child', item.mode, endpoint),
  profileKey: (item) => `${item.policyMode}-${item.mode}`,
  augment(result, item) {
    result.walletRegistrationEvidence = parseWalletRegistrationEvidence(result.walletRegistrationReady, 'present');
    result.walletRegistrationValid = result.walletRegistrationMarkerCount === 1 && result.walletRegistrationEvidence !== null;
    result.requestPolicyEvidence = parseRequestPolicyEvidence(result.requestPolicyReady, item.policyMode, item.mode);
    result.requestPolicyValid = result.requestPolicyMarkerCount === 1 && result.requestPolicyEvidence !== null;
    result.variantValid = result.walletRegistrationValid && result.requestPolicyValid;
  },
  summarize: summarizeRequestPolicyReport,
  config: (repeat) => ({ repeat, modes: STOCK_MODES, policyModes: REQUEST_POLICY_MODES, placement: 'opaque-child', documentMode: 'app',
    preloadMode: 'application', topology: 'named-dual', walletRegistrationMode: 'present', requestFilterMode: requestFilter, requestFilter: requestFilterEvidence[requestFilter],
    fixedSettings: { offlineMode: false, contentNetworkPolicy: 'https-only' }, policySource: requestPolicySourceEvidence }),
  purpose: 'Matched encrypted-stock app-session request-policy registration diagnostic. Callback coverage is measured, including WSS; no identity, encryption, credential, trust, or product qualification claim.',
  rootPrefix: 'satoshi-stock-request-policy-',
  preloadScope: 'Unmodified application preload bytes copied once and configured identically in both request-policy arms; bridge APIs observed but not invoked.',
  invalidReason: 'REQUEST_POLICY_EVIDENCE_INVALID'
}); }

export function runStockRequestPolicy(options, dependencies) {
  const requestFilter = options?.requestFilter ?? 'legacy';
  if (!REQUEST_FILTER_MODES.includes(requestFilter)) throw new TypeError('Unknown request filter mode');
  return runStockFrameMatrix(options, dependencies, definitionFor(requestFilter));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStockRequestPolicy(parseRequestPolicyArgs(process.argv.slice(2))).then((report) => { process.stdout.write(`${JSON.stringify(report.summary)}\n`); if (!report.summary.passing) process.exitCode = 1; },
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
