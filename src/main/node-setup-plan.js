import path from 'node:path';
import { AppError } from '../shared/errors.js';
import { defaultProviderCapabilitiesFor } from '../shared/constants.js';

const PORTS = { mainnet: 8332, testnet: 18332, signet: 38332, regtest: 18443 };
const NETWORK_DIRS = { mainnet: '', testnet: 'testnet3', signet: 'signet', regtest: 'regtest' };
// This header participates in saved setup digests. Preserve its original bytes
// across the public-facing rename so existing managed nodes remain recognized.
const COMMENT = '# Managed by Satoshi Browser. Dedicated setup configuration.\n';
const GiB = 1024 ** 3;
function fail(message) { throw new AppError('INVALID_NODE_SETUP', message, { status: 400 }); }
function shape(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`Invalid ${label} fields.`);
}
function choice(value, values, label) { if (!values.includes(value)) fail(`Invalid ${label}.`); return value; }
function boolean(value, label) { if (typeof value !== 'boolean') fail(`Invalid ${label}.`); return value; }
function port(value) { if (!Number.isInteger(value) || value < 1024 || value > 65535) fail('Ports must be whole numbers from 1024 to 65535.'); return value; }
function absolute(value, paths, label) {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim() || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value)) fail(`${label} must be an absolute path.`);
  const normalized = paths.normalize(value);
  if (normalized === paths.parse(normalized).root) fail(`${label} must not be a filesystem root.`);
  return normalized;
}
function loopback(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) fail('Use a literal loopback HTTP(S) URL.');
  // Validate the spelling as well as URL normalization (127.1 and numeric IPs are not accepted).
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i.test(value)) fail('Use a literal loopback HTTP(S) root URL without credentials, query or fragment.');
  let url; try { url = new URL(value); } catch { fail('Invalid loopback URL.'); }
  if (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535)) fail('Invalid existing service port.');
  return url.origin;
}

export function defaultNodeSetupDraft({ rootDirectory, network = 'mainnet' } = {}) {
  choice(network, Object.keys(PORTS), 'network');
  return { choice: 'both', network, rootDirectory, autoStart: false,
    core: { mode: 'managed', executable: '', rpcPort: PORTS[network], rpcUrl: `http://127.0.0.1:${PORTS[network]}`, cookieFile: '', storage: 'archive', ...(network === 'regtest' ? { peerConnections: 'disabled' } : {}) },
    ord: { mode: 'managed', executable: '', httpPort: 8080, serverUrl: 'http://127.0.0.1:8080', indexSats: false, indexRunes: false } };
}

export function buildNodeSetupPlan(input, { platform = process.platform } = {}) {
  shape(input, ['choice', 'network', 'rootDirectory', 'autoStart', 'core', 'ord'], 'setup');
  shape(input.core, ['mode', 'executable', 'rpcPort', 'rpcUrl', 'cookieFile', 'storage', 'peerConnections', 'sync', 'dbCacheMiB', 'validationThreads'], 'Bitcoin Core');
  shape(input.ord, ['mode', 'executable', 'httpPort', 'serverUrl', 'indexSats', 'indexRunes'], 'Ord');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const draft = structuredClone(input);
  choice(draft.choice, ['both', 'core', 'ord', 'none'], 'setup choice');
  choice(draft.network, Object.keys(PORTS), 'network'); boolean(draft.autoStart, 'autostart');
  draft.rootDirectory = absolute(draft.rootDirectory, paths, 'Setup directory');
  choice(draft.core.mode, ['managed', 'existing'], 'Core mode'); choice(draft.core.storage, ['archive', 'pruned'], 'Core storage');
  // Never fill this optional field while rebuilding a legacy saved draft: the
  // entire plan (including its draft and warnings) has an ownership hash.
  if (Object.hasOwn(draft.core, 'peerConnections')) choice(draft.core.peerConnections, ['automatic', 'disabled'], 'Core peer connections');
  for (const [key, min, max] of [['dbCacheMiB', 64, 16384], ['validationThreads', 1, 64]]) {
    if (Object.hasOwn(draft.core, key) && (!Number.isInteger(draft.core[key]) || draft.core[key] < min || draft.core[key] > max)) fail(`Invalid Core ${key}; use a whole number from ${min} to ${max}.`);
  }
  choice(draft.ord.mode, ['managed', 'existing'], 'Ord mode'); boolean(draft.ord.indexSats, 'sat index'); boolean(draft.ord.indexRunes, 'rune index');
  const coreSelected = ['both', 'core'].includes(draft.choice);
  const ordSelected = ['both', 'ord'].includes(draft.choice);
  const coreManaged = coreSelected && draft.core.mode === 'managed';
  const ordManaged = ordSelected && draft.ord.mode === 'managed';
  if (Object.hasOwn(draft.core, 'sync')) choice(draft.core.sync, ['standard', 'snapshot'], 'Core synchronization');
  if (draft.core.sync === 'snapshot' && (!coreManaged || draft.core.storage !== 'pruned' || draft.network !== 'mainnet' || ordManaged)) fail('Quick start requires managed, compact mainnet Core without managed Ord.');
  if (coreManaged && draft.core.peerConnections === 'disabled' && draft.network !== 'regtest') fail('Disabled peer connections are available only for managed regtest Core.');
  // Keep a dormant selection when choosing Ord, existing Core, or neither, but
  // do not apply it to or claim control over a service we do not manage.
  const isolatedCore = coreManaged && draft.network === 'regtest' && draft.core.peerConnections === 'disabled';
  if (draft.choice === 'ord' && ordManaged) draft.core.mode = 'existing';
  const coreNeeded = coreSelected || ordManaged;
  const coreDir = coreManaged ? paths.join(draft.rootDirectory, `core-${draft.network}`) : null;
  const ordDir = ordManaged ? paths.join(draft.rootDirectory, `ord-${draft.network}`) : null;
  let coreUrl = null, ordUrl = null, cookieFile = null;
  if (coreNeeded) {
    if (coreManaged) {
      port(draft.core.rpcPort); draft.core.executable = absolute(draft.core.executable, paths, 'Core executable');
      coreUrl = `http://127.0.0.1:${draft.core.rpcPort}`;
      cookieFile = paths.join(coreDir, NETWORK_DIRS[draft.network], '.cookie');
    } else {
      coreUrl = loopback(draft.core.rpcUrl); cookieFile = absolute(draft.core.cookieFile, paths, 'Core cookie file');
    }
    draft.core.rpcUrl = coreUrl; draft.core.cookieFile = cookieFile;
  }
  if (ordSelected) {
    if (ordManaged) { port(draft.ord.httpPort); draft.ord.executable = absolute(draft.ord.executable, paths, 'Ord executable'); ordUrl = `http://127.0.0.1:${draft.ord.httpPort}`; }
    else ordUrl = loopback(draft.ord.serverUrl);
    draft.ord.serverUrl = ordUrl;
  }
  if (coreManaged && ordManaged && draft.core.storage === 'pruned') fail('Managed Ord requires an archival Bitcoin Core node.');
  if (ordManaged && coreUrl && Number(new URL(coreUrl).port) === draft.ord.httpPort) fail('Core RPC and Ord HTTP ports must differ.');
  const services = [], providers = [], directories = [], files = [], warnings = [];
  if (coreManaged || ordManaged) warnings.push('Generated command flags target Bitcoin Core 31 and Ord 0.29. Installed executable versions and native compatibility must be verified before launch.');
  const coreId = `guided-core-${draft.network}`, ordId = `guided-ord-${draft.network}`;
  const provider = (id, type, name, baseUrl) => ({ id, type, name, network: draft.network, baseUrl, enabled: true, local: true, priority: 5, capabilities: defaultProviderCapabilitiesFor(type) });
  if (coreSelected) {
    const p = { ...provider(coreId, 'bitcoin-core', 'Guided Bitcoin Core', coreUrl), cookieFile };
    if (coreManaged && draft.core.storage === 'pruned') p.capabilities = p.capabilities.filter(cap => !['transaction', 'transaction-raw'].includes(cap));
    providers.push(p);
  }
  if (ordSelected) providers.push(provider(ordId, 'ord-server', 'Guided Ord', ordUrl));
  if (coreManaged) {
    const config = paths.join(coreDir, 'satoshi-browser.conf');
    const args = [`-datadir=${coreDir}`, `-conf=${config}`, '-server=1', '-rest=1', '-daemon=0', '-listen=0', '-natpmp=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${draft.core.rpcPort}`, `-txindex=${draft.core.storage === 'archive' ? 1 : 0}`, `-prune=${draft.core.storage === 'archive' ? 0 : 10000}`];
    if (draft.network !== 'mainnet') args.push(`-${draft.network}=1`);
    if (Object.hasOwn(draft.core, 'dbCacheMiB')) args.push(`-dbcache=${draft.core.dbCacheMiB}`);
    if (Object.hasOwn(draft.core, 'validationThreads')) args.push(`-par=${draft.core.validationThreads}`);
    if (isolatedCore) args.push('-networkactive=0', '-connect=0', '-dnsseed=0', '-fixedseeds=0', '-dns=0');
    services.push({ id: coreId, name: 'Guided Bitcoin Core', executable: draft.core.executable, args, cwd: coreDir, enabled: true, autoStart: false });
    directories.push(coreDir); files.push({ path: config, content: COMMENT });
    if (isolatedCore) warnings.push('Regtest Core starts with peer connections and DNS seeding disabled. It cannot synchronize from peers; blocks must be supplied locally. This is application configuration, not an OS firewall; authenticated Core RPC can change network activity.');
    else {
      warnings.push('Bitcoin Core synchronizes over its own peer-to-peer network. Browser offline and content controls are not a node P2P firewall.');
      warnings.push('Initial blockchain synchronization downloads many gigabytes and can take hours or days; storage estimates are not guarantees.');
    }
    if (draft.core.storage === 'pruned') warnings.push('Pruned Core cannot serve arbitrary historical transactions or blocks and cannot back a full Ord index.');
  }
  if (ordManaged) {
    const config = paths.join(ordDir, 'satoshi-browser.yaml');
    const args = ['--config', config, '--chain', draft.network, '--data-dir', ordDir, '--index', paths.join(ordDir, 'index.redb'), '--bitcoin-rpc-url', coreUrl, '--cookie-file', cookieFile];
    if (draft.ord.indexSats) args.push('--index-sats'); if (draft.ord.indexRunes) args.push('--index-runes');
    args.push('server', '--address', '127.0.0.1', '--http-port', String(draft.ord.httpPort));
    services.push({ id: ordId, name: 'Guided Ord', executable: draft.ord.executable, args, cwd: ordDir, enabled: true, autoStart: false });
    directories.push(ordDir); files.push({ path: config, content: `${COMMENT}{}\n` });
    if (!coreManaged) warnings.push('Existing Bitcoin Core must be archival with txindex and REST enabled; readiness must be checked before starting Ord.');
    warnings.push('Ord indexing can take hours or days and require substantial additional disk space; the estimate is not a guarantee.');
  }
  if (draft.network === 'testnet' && coreNeeded) warnings.push('This setup uses legacy testnet3, deprecated by Bitcoin Core 31; it is not testnet4.');
  if (draft.core.sync === 'snapshot') warnings.push('Quick start imports a separately selected mainnet snapshot with explicit consent. Core checks its built-in commitment, then validates older history in the background. This is not an instant sync, a bandwidth reduction or an Ord index.');
  return { draft, summary: { choice: draft.choice, network: draft.network, coreDataDirectory: coreDir, ordDataDirectory: ordDir, coreUrl, ordUrl,
    ...(coreManaged && draft.network === 'regtest' && Object.hasOwn(draft.core, 'peerConnections') ? { corePeerConnections: draft.core.peerConnections } : {}) },
    services, providers, directories, files, warnings,
    core: { selected: coreSelected, managed: coreManaged, serviceId: coreManaged ? coreId : null, providerId: coreSelected ? coreId : null },
    ord: { selected: ordSelected, managed: ordManaged, serviceId: ordManaged ? ordId : null, providerId: ordSelected ? ordId : null },
    requiredBytes: (coreManaged ? (draft.core.storage === 'archive' ? 1024 : 30) * GiB : 0) + (ordManaged ? (draft.ord.indexSats ? 1024 : 512) * GiB : 0) };
}
