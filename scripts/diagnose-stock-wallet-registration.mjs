import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DOCUMENT_URL } from './diagnose-stock-document-protocol.mjs';
import { ORD_DOCUMENT_URL, runStockFrameMatrix, stockFrameDocuments, stockFrameMainSource } from './diagnose-stock-frame-placement.mjs';
import { STOCK_MODES, classifyCleanExit, classifyExperimentCompletion, classifyStockRun } from './diagnose-stock-network-shutdown.mjs';

export const WALLET_REGISTRATION_MODES = Object.freeze(['absent', 'present']);
export const WALLET_RESERVED_ORIGIN = 'https://wallet.satoshi.invalid';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reviewed wallet registration insertion point changed');
  return source.replace(before, after);
}

export function buildWalletRegistrationSchedule(repeat = 2) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 2) throw new TypeError('Repeat must be 1 or 2');
  const rows = [];
  for (const mode of STOCK_MODES) for (let run = 1; run <= repeat; run += 1) {
    for (const registrationMode of run % 2 ? WALLET_REGISTRATION_MODES : [...WALLET_REGISTRATION_MODES].reverse()) {
      rows.push({ mode, run, registrationMode, placement: 'opaque-child' });
    }
  }
  return rows;
}

export function stockWalletRegistrationMainSource(registrationMode) {
  if (!WALLET_REGISTRATION_MODES.includes(registrationMode)) throw new TypeError('Unknown wallet registration mode');
  let source = stockFrameMainSource();
  source = replaceOnce(source, '  const persistent = sessions[0].value;', `  const persistent = sessions[0].value;
  const walletPersistent = sessions[1].value;
  let walletHandlerInvocations = 0;
  const walletHandlerInstalled = ${registrationMode === 'present'};
  if (walletHandlerInstalled) walletPersistent.protocol.handle('https', async (request) => {
    walletHandlerInvocations += 1;
    const url = new URL(request.url);
    if (url.origin !== ${JSON.stringify(WALLET_RESERVED_ORIGIN)}) {
      return walletPersistent.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    return new Response('Not found', { status: 404 });
  });`);
  source = replaceOnce(source, '  const win = new BrowserWindow({ show: false, webPreferences: {', `  let browserWindowCount = 0;
  browserWindowCount += 1;
  const win = new BrowserWindow({ show: false, webPreferences: {`);
  source = replaceOnce(source, '  win.webContents.setWindowOpenHandler', `  app.once('before-quit', () => process.stdout.write('STOCK_WALLET_REGISTRATION:' + JSON.stringify({ registrationMode: ${JSON.stringify(registrationMode)},
    handlerInstalled: walletHandlerInstalled, walletHandlerInvocations, sessionCount: sessions.length,
    distinctSessions: sessions[0].value !== sessions[1].value, partitions: sessions.map((item) => item.partition), browserWindowCount }) + '\\n'));
  win.webContents.setWindowOpenHandler`);
  return source;
}

export function parseWalletRegistrationEvidence(line, registrationMode) {
  if (!WALLET_REGISTRATION_MODES.includes(registrationMode) || typeof line !== 'string' || line.length > 8192) return null;
  const match = /^STOCK_WALLET_REGISTRATION:(\{[^\n]+\})$/.exec(line);
  if (!match) return null;
  let value; try { value = JSON.parse(match[1]); } catch { return null; }
  const expectedPartitions = ['persist:satoshi-browser-app', 'persist:satoshi-browser-wallet'];
  if (value?.registrationMode !== registrationMode || value.handlerInstalled !== (registrationMode === 'present')
    || value.walletHandlerInvocations !== 0 || value.sessionCount !== 2 || value.distinctSessions !== true
    || JSON.stringify(value.partitions) !== JSON.stringify(expectedPartitions) || value.browserWindowCount !== 1) return null;
  return value;
}

export function summarizeWalletRegistrationReport(report) {
  const expected = buildWalletRegistrationSchedule(report.config.repeat); const runs = report.runs;
  const complete = !report.failure && report.stoppedReason === null && runs.length === expected.length
    && expected.every((item, index) => ['mode', 'run', 'registrationMode', 'placement'].every((key) => item[key] === runs[index]?.[key]))
    && runs.every((run) => run.closed === true);
  return { complete, passing: complete && runs.every((run) => run.walletRegistrationValid && run.frameValid && run.probeSourceValid
      && run.preloadValid && run.documentValid && run.topologyValid && classifyStockRun(run)),
    experimentsCompleted: runs.filter(classifyExperimentCompletion).length, cleanExits: runs.filter(classifyCleanExit).length,
    expectedRawTlsActivity: runs.filter((run) => run.networkExpectationMet).length };
}

const definition = Object.freeze({
  buildSchedule: buildWalletRegistrationSchedule,
  mainSource: (item) => stockWalletRegistrationMainSource(item.registrationMode),
  documents: (item, endpoint) => stockFrameDocuments('opaque-child', item.mode, endpoint),
  profileKey: (item) => `${item.registrationMode}-${item.mode}`,
  augment(result, item) {
    result.walletRegistrationEvidence = parseWalletRegistrationEvidence(result.walletRegistrationReady, item.registrationMode);
    result.walletRegistrationValid = result.walletRegistrationMarkerCount === 1 && result.walletRegistrationEvidence !== null;
    result.variantValid = result.walletRegistrationValid;
  },
  summarize: summarizeWalletRegistrationReport,
  config: (repeat) => ({ repeat, modes: STOCK_MODES, registrationModes: WALLET_REGISTRATION_MODES, placement: 'opaque-child',
    documentMode: 'app', preloadMode: 'application', topology: 'named-dual', walletRequestsExpected: 0 }),
  purpose: 'Matched encrypted-stock unused wallet HTTPS protocol-registration diagnostic. Both arms use the same opaque child probe; no wallet requests, credentials, identity change, or product qualification.',
  rootPrefix: 'satoshi-stock-wallet-registration-',
  preloadScope: 'Unmodified application preload bytes copied once and configured identically in both registration arms; bridge APIs observed but not invoked.',
  invalidReason: 'WALLET_REGISTRATION_EVIDENCE_INVALID'
});

export function runStockWalletRegistration(options, dependencies) {
  return runStockFrameMatrix(options, dependencies, definition);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); if (args.length !== 1 || !args[0].startsWith('--output=')) throw new Error('Usage: --output=/absolute/new-report.json');
  runStockWalletRegistration({ output: args[0].slice(9) }).then((report) => { process.stdout.write(`${JSON.stringify(report.summary)}\n`); if (!report.summary.passing) process.exitCode = 1; },
    (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

export const walletRegistrationUrls = Object.freeze({ app: APP_DOCUMENT_URL, ord: ORD_DOCUMENT_URL });
