import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';
import { validateProviderMutation } from '../src/shared/validation.js';
import { softwareCatalog } from '../src/main/node-software.js';

export const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
export const REGTEST_RUN_LIMIT_MS = 30 * 60_000;
export const REGTEST_GROWTH_LIMIT_BYTES = 2 * 1024 ** 3;
export const REGTEST_STOP_RESERVE_MS = 30_000;
export const REGTEST_RPC_METHODS = Object.freeze([
  'getblockchaininfo', 'getblockhash', 'getblockheader', 'getnetworkinfo',
  'getindexinfo', 'getblock', 'getrawtransaction', 'submitblock'
]);
export const REGTEST_ISOLATION_FLAGS = Object.freeze([
  '-networkactive=0', '-connect=0', '-dnsseed=0', '-fixedseeds=0', '-dns=0'
]);

export function regtestError(code) {
  // Never copy native messages, RPC bodies, credentials or arbitrary paths
  // into the harness diagnostic. Codes are enough to locate a failed gate.
  return Object.assign(new Error(code), { code });
}

export function requireRegtest(condition, code) {
  if (!condition) throw regtestError(code);
}

function shape(value, keys) {
  requireRegtest(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'REGTEST_MANIFEST_INVALID');
  const actual = Reflect.ownKeys(value);
  requireRegtest(actual.length === keys.length && actual.every(key => keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), 'REGTEST_MANIFEST_INVALID');
}

export function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function regtestDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function executable(value) {
  shape(value, ['path', 'sha256']);
  requireRegtest(typeof value.path === 'string' && value.path.length <= 2048
    && value.path.startsWith('/') && path.posix.normalize(value.path) === value.path
    && value.path !== '/' && !/[\x00-\x1f\x7f]/.test(value.path)
    && isSha256(value.sha256), 'REGTEST_BINARY_INVALID');
  return { path: value.path, sha256: value.sha256 };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Pure planning only: no filesystem, process, transport, clock or credentials. */
export function buildNativeRegtestPlan(input, sourceSha256) {
  shape(input, ['schemaVersion', 'root', 'core', 'ord', 'ports', 'maxRunMs', 'maxGrowthBytes']);
  shape(input.ports, ['coreOnlyRpc', 'pairRpc', 'pairOrd', 'ordOnlyHttp']);
  requireRegtest(input.schemaVersion === 1 && isSha256(sourceSha256), 'REGTEST_MANIFEST_INVALID');
  // A single new direct child of the actual macOS temporary root. Broader
  // volumes/platforms require a separately reviewed harness contract.
  requireRegtest(typeof input.root === 'string'
    && /^\/private\/tmp\/satoshi-browser-regtest-[a-z0-9][a-z0-9-]{5,63}$/.test(input.root), 'REGTEST_ROOT_INVALID');
  const core = executable(input.core), ord = executable(input.ord);
  requireRegtest(core.path !== ord.path && !core.path.startsWith(`${input.root}/`)
    && !ord.path.startsWith(`${input.root}/`), 'REGTEST_BINARY_INVALID');
  const ports = Object.fromEntries(['coreOnlyRpc', 'pairRpc', 'pairOrd', 'ordOnlyHttp'].map(key => [key, input.ports[key]]));
  requireRegtest(Object.values(ports).every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
    && new Set(Object.values(ports)).size === 4, 'REGTEST_PORT_INVALID');
  requireRegtest(Number.isSafeInteger(input.maxRunMs) && input.maxRunMs >= 60_000
    && input.maxRunMs <= REGTEST_RUN_LIMIT_MS, 'REGTEST_DEADLINE_INVALID');
  requireRegtest(Number.isSafeInteger(input.maxGrowthBytes) && input.maxGrowthBytes >= 1024 ** 2
    && input.maxGrowthBytes <= REGTEST_GROWTH_LIMIT_BYTES, 'REGTEST_STORAGE_INVALID');
  const spec = { schemaVersion: 1, root: input.root, core, ord, ports,
    maxRunMs: input.maxRunMs, maxGrowthBytes: input.maxGrowthBytes };
  const draft = (id, choice) => {
    const value = defaultNodeSetupDraft({ rootDirectory: path.posix.join(spec.root, id, 'nodes'), network: 'regtest' });
    value.choice = choice;
    value.core.executable = core.path;
    value.core.rpcPort = id === 'core-only' ? ports.coreOnlyRpc : ports.pairRpc;
    value.ord.executable = ord.path;
    value.ord.httpPort = id === 'ord-only' ? ports.ordOnlyHttp : ports.pairOrd;
    value.core.peerConnections = 'disabled';
    return value;
  };
  const coreOnly = draft('core-only', 'core');
  const both = draft('both', 'both');
  const pairCookie = path.posix.join(both.rootDirectory, 'core-regtest', 'regtest', '.cookie');
  const ordOnly = draft('ord-only', 'ord');
  const existing = draft('existing-only', 'both');
  for (const value of [ordOnly, existing]) {
    value.core.mode = 'existing';
    delete value.core.peerConnections;
    value.core.rpcUrl = `http://127.0.0.1:${ports.pairRpc}`;
    value.core.cookieFile = pairCookie;
  }
  existing.ord.mode = 'existing';
  existing.ord.serverUrl = `http://127.0.0.1:${ports.pairOrd}`;
  const none = draft('none', 'none'); delete none.core.peerConnections;
  const scenarios = [coreOnly, both, ordOnly, existing, none].map(value => ({
    id: path.posix.basename(path.posix.dirname(value.rootDirectory)),
    profile: path.posix.join(path.posix.dirname(value.rootDirectory), 'profile'),
    plan: buildNodeSetupPlan(value, { platform: 'darwin' })
  }));
  for (const scenario of scenarios) {
    const plan = scenario.plan;
    plan.providers = plan.providers.map(validateProviderMutation);
    requireRegtest(plan.draft.network === 'regtest' && plan.draft.autoStart === false
      && plan.services.every(service => !service.autoStart), 'REGTEST_PLAN_UNSAFE');
    if (plan.core.managed) {
      const service = plan.services.find(item => item.id === plan.core.serviceId);
      requireRegtest(REGTEST_ISOLATION_FLAGS.every(flag => service.args.includes(flag))
        && service.args.includes('-regtest=1'), 'REGTEST_ISOLATION_NOT_IMPLEMENTED');
    }
    for (const url of [plan.summary.coreUrl, plan.summary.ordUrl].filter(Boolean)) {
      requireRegtest(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url), 'REGTEST_PLAN_UNSAFE');
    }
  }
  const plan = {
    schemaVersion: 1, harness: 'native-node-regtest-v1', sourceSha256,
    platform: 'darwin', architecture: 'arm64', expectedCoreVersion: '31.1', expectedOrdVersion: '0.29.0',
    requiredInstallations: Object.entries(softwareCatalog('darwin', 'arm64')).map(([kind, descriptor]) => ({
      kind, version: descriptor.version, archiveUrl: descriptor.url, archiveSha256: descriptor.sha256,
      executableName: descriptor.executableName,
      manifestPath: path.posix.join(path.posix.dirname(spec[kind].path), 'manifest.json')
    })),
    spec, scenarios, rpcMethods: [...REGTEST_RPC_METHODS],
    storagePolicy: 'Monitored apparent file-byte growth; no hard filesystem quota. Checks can overshoot.',
    networkPolicy: 'Application-configured inactive Core P2P and literal loopback services; not an OS firewall.',
    deadlinePolicy: 'Stop admission 30 seconds before the run limit; abort and drain owned managers. OS stalls need external supervision.',
    retentionPolicy: 'Retain the entire owned run directory on success or failure; no automatic data deletion.',
    qualification: 'Native manager/provider integration only; no Electron UI, installer trust, populated inscriptions, full sync, or platform-matrix acceptance.',
    credentialPolicy: 'Only freshly generated fixture cookies through normal Core/Ord code; no Keychain, wallet or credential output.'
  };
  return freeze({ ...plan, planSha256: regtestDigest(plan) });
}

export function assertRegtestSnapshot(info, network, expectedHash, expectedHeight) {
  requireRegtest(info?.chain === 'regtest' && info.pruned === false
    && Number.isSafeInteger(info.blocks) && info.blocks >= 0
    && Number.isSafeInteger(info.headers) && info.headers === info.blocks
    && isSha256(info.bestblockhash) && typeof info.initialblockdownload === 'boolean', 'REGTEST_CHAIN_INVALID');
  requireRegtest(network?.networkactive === false && network.connections === 0, 'REGTEST_PEER_POLICY_CHANGED');
  requireRegtest(network.version === 310100, 'REGTEST_CORE_VERSION_MISMATCH');
  if (expectedHash !== undefined) requireRegtest(info.bestblockhash === expectedHash
    && info.blocks === expectedHeight, 'REGTEST_TIP_CHANGED');
  return { chain: info.chain, blocks: info.blocks, headers: info.headers,
    bestblockhash: info.bestblockhash, initialblockdownload: info.initialblockdownload,
    networkactive: false, connections: 0, coreVersion: network.version };
}
