import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { validateProviderMutation } from '../shared/validation.js';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from './node-setup-plan.js';
import { NODE_SETUP_MIN_FREE_BYTES, nodeSetupGuidance, nodeSetupDisplayWarnings } from '../shared/node-setup-guidance.js';
import { BitcoinCoreProvider } from './providers/bitcoin-core.js';
import { OrdServerProvider } from './providers/ord-server.js';
import { requestBuffer, assertHttpSuccess, parseJsonBody } from './http.js';
import { NodeSnapshotManager } from './node-snapshot-manager.js';
import { isQuickStart, parseCoreChainstates } from '../shared/node-snapshot.js';
import { EasyNodeSetup } from './easy-node-setup.js';

const ACTIONS = new Set(['inspect', 'pick', 'install', 'preview', 'apply', 'status', 'start', 'stop', 'snapshot-select', 'snapshot-load', 'capacity', 'easy-preview', 'easy-start', 'easy-status', 'easy-cancel']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const error = (code, message, status = 409, details) => new AppError(code, message, { status, details });
const unavailable = message => ({ phase: 'unavailable', message });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasManagedStorage = plan => Boolean(plan.directories.length || plan.services.length || plan.files.length);
async function probeCoreRest(config, options) {
  const response = await requestBuffer(new URL('/rest/chaininfo.json', config.baseUrl).href, { ...options, networkPolicy: 'local', redirect: 'error' });
  assertHttpSuccess(response, 'Local Bitcoin Core REST');
  return parseJsonBody(response, 'Local Bitcoin Core REST');
}

async function exists(file) {
  try { return await fs.lstat(file); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}
async function canonicalDestination(destination) {
  const missing = []; let current = destination;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw error('SETUP_DIRECTORY_INVALID', 'Choose an accessible storage folder.');
    missing.unshift(path.basename(current)); current = parent;
  }
  return path.join(await fs.realpath(current), ...missing);
}
async function diskAt(directory, requiredBytes) {
  let current = directory;
  while (!(await exists(current))) current = path.dirname(current);
  try { const info = await fs.statfs(current); return { availableBytes: info.bavail * info.bsize, requiredBytes }; }
  catch { return { availableBytes: null, requiredBytes }; }
}

// This manager creates only fresh, dedicated node directories and configuration
// records. It never reads personal bitcoin.conf/ord.yaml files or credential
// values. The normal Core adapter uses the explicitly selected cookie for RPC.
export class NodeSetupManager {
  constructor({ stateStore, providerManager, localServiceManager, software, rootDirectory,
    platform = process.platform, confirm = async () => false, pick = async () => ({ path: null }),
    coreFactory = config => new BitcoinCoreProvider(config), ordFactory = config => new OrdServerProvider(config), restProbe = probeCoreRest,
    setTimer = setInterval, clearTimer = clearInterval, now = Date.now, inspectCapacity }) {
    Object.assign(this, { stateStore, providerManager, localServiceManager, software, rootDirectory, platform,
      confirm, pick, coreFactory, ordFactory, restProbe, setTimer, clearTimer, now });
    this.pending = new Set(); this.stopping = false; this.controller = new AbortController();
    this.previewRecord = null; this.mutation = null; this.reading = null; this.timer = null;
    this.desired = null; this.intentToken = null; this.advancing = null; this.lastStatus = null; this.shutdownPromise = null;
    this.downloads = new Set();
    this.snapshots = new NodeSnapshotManager(this);
    this.easy = new EasyNodeSetup(this, inspectCapacity);
  }
  assertRunning() { if (this.stopping) throw error('APP_SHUTTING_DOWN', 'The application is shutting down.', 503); }
  track(action) {
    this.assertRunning();
    const promise = Promise.resolve().then(() => { this.assertRunning(); return action(); });
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  async run(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !ACTIONS.has(payload.action)) throw error('INVALID_NODE_SETUP_ACTION', 'Unknown node setup action.', 400);
    const allowed = { inspect: [], pick: ['kind'], install: ['kind'], preview: ['draft'], apply: ['token'], status: ['setupId'], start: ['setupId'], stop: ['setupId'], 'snapshot-select': ['setupId'], 'snapshot-load': ['setupId', 'token'], capacity: ['rootDirectory'], 'easy-preview': ['rootDirectory', 'autoStart'], 'easy-start': ['token'], 'easy-status': ['token'], 'easy-cancel': ['token'] };
    if (Object.keys(payload).some(key => key !== 'action' && !allowed[payload.action].includes(key))) throw error('INVALID_NODE_SETUP_ACTION', 'Unexpected node setup fields.', 400);
    return this.track(async () => {
      switch (payload.action) {
        case 'inspect': return this.inspect();
        case 'capacity': return this.easy.recommendation(payload.rootDirectory);
        case 'easy-preview': return this.exclusive(() => this.easy.prepare(payload));
        case 'easy-start': return this.exclusive(() => this.easy.start(payload.token));
        case 'easy-status': return this.easy.status(payload.token);
        case 'easy-cancel': return this.easy.cancel(payload.token);
        case 'pick': {
          if (!['core-executable', 'ord-executable', 'directory', 'cookie'].includes(payload.kind)) throw error('INVALID_NODE_SETUP_ACTION', 'Unknown setup file selection.', 400);
          return this.pick(payload.kind);
        }
        case 'install': {
          if (!['core', 'ord'].includes(payload.kind)) throw error('INVALID_NODE_SETUP_ACTION', 'Unknown node software.', 400);
          const settings = this.stateStore.get(['settings']);
          if (settings.offlineMode || settings.localOnly) throw error('SOFTWARE_DOWNLOAD_BLOCKED', 'Turn off offline and local-only mode to download software, or choose an installed program.', 403);
          const descriptor = this.software.catalog()[payload.kind];
          if (!descriptor) throw error('SOFTWARE_INSTALL_UNSUPPORTED', 'Automatic download is unavailable on this platform. Choose an installed program or use the official installation guide.', 422);
          if (!await this.confirm('install', descriptor)) throw error('USER_REJECTED', 'Software download was cancelled.', 499);
          this.assertRunning();
          const current = this.stateStore.get(['settings']);
          if (current.offlineMode || current.localOnly) throw error('SOFTWARE_DOWNLOAD_BLOCKED', 'Privacy settings changed before the download started.', 403);
          const download = new AbortController(); this.downloads.add(download);
          try { return await this.software.install(payload.kind, { signal: AbortSignal.any([this.controller.signal, download.signal]) }); }
          finally { this.downloads.delete(download); }
        }
        case 'preview': return this.preview(payload.draft);
        case 'apply': return this.exclusive(() => this.apply(payload.token));
        case 'start': return this.exclusive(() => this.start(payload.setupId));
        case 'stop': return this.exclusive(() => this.stop(payload.setupId));
        case 'status': return this.status(payload.setupId);
        case 'snapshot-select': return this.exclusive(() => this.snapshots.select(payload.setupId));
        case 'snapshot-load': return this.exclusive(() => this.snapshots.load(payload.setupId, payload.token));
      }
    });
  }
  exclusive(action) {
    if (this.mutation) throw error('NODE_SETUP_BUSY', 'A node setup action is already in progress.');
    const operation = Promise.resolve().then(action); this.mutation = operation;
    return operation.finally(() => { if (this.mutation === operation) this.mutation = null; });
  }
  saved(id) {
    const record = this.stateStore.get(['nodeSetup']);
    if (!record) return null;
    if (record.schemaVersion !== 1 || typeof record.id !== 'string' || !record.plan?.draft) throw error('NODE_SETUP_INVALID', 'Saved setup could not be validated. Use advanced service controls.');
    if (id !== undefined && id !== record.id) throw error('NODE_SETUP_CHANGED', 'The selected setup is no longer current.');
    const plan = buildNodeSetupPlan(record.plan.draft, { platform: this.platform });
    plan.providers = plan.providers.map(validateProviderMutation);
    if (digest(plan) !== record.planHash) throw error('NODE_SETUP_CHANGED', 'Saved setup definitions changed. Use advanced service controls.');
    return { ...record, plan };
  }
  async inspect() {
    let saved = null, recovery = null;
    try { saved = this.saved(); } catch (cause) { recovery = cause.message; }
    let detected = { core: [], ord: [] }, discoveryWarning = null;
    try { detected = await this.software.discover(); } catch { discoveryWarning = 'Some installed software could not be checked. You can still choose a program manually.'; }
    return { defaults: defaultNodeSetupDraft({ rootDirectory: this.rootDirectory, network: this.stateStore.get(['settings', 'network']) }),
      catalog: this.software.catalog(), detected, saved, recovery, discoveryWarning,
      ...(typeof this.software.destination === 'function' && !saved && !recovery ? { easy: await this.easy.recommendation() } : {}) };
  }
  async validateFresh(plan, { skipExecutableCheck = false } = {}) {
    if (this.stateStore.get(['nodeSetup'])) throw error('NODE_SETUP_EXISTS', 'A guided setup already exists. Resume it, or edit individual services in Advanced controls.');
    const providers = this.stateStore.get(['providers']) ?? [];
    const services = this.stateStore.get(['localServices']) ?? [];
    if (plan.providers.some(p => providers.some(existing => existing.id === p.id)) || plan.services.some(s => services.some(existing => existing.id === s.id))) {
      throw error('NODE_SETUP_COLLISION', 'A service or source with this setup identity already exists. Existing configuration was not changed.');
    }
    for (const directory of plan.directories) if (await exists(directory)) throw error('NODE_SETUP_DIRECTORY_EXISTS', 'A node data folder already exists at the selected location. Choose another storage folder or use an existing service.');
    for (const service of skipExecutableCheck ? [] : plan.services) {
      const stat = await fs.stat(service.executable).catch(() => null);
      if (!stat?.isFile()) throw error('SERVICE_EXECUTABLE_MISSING', `Choose an installed ${service.name} program before continuing.`, 404);
      if (this.platform !== 'win32') await fs.access(service.executable, fs.constants.X_OK).catch(() => { throw error('SERVICE_NOT_EXECUTABLE', 'The selected program does not have executable permission. Use the official installation process.'); });
    }
  }
  async preview(draft) {
    // Existing connections still carry a valid internal root in the legacy
    // plan schema, but they do not need a user-selected node storage folder.
    const input = !nodeSetupGuidance(draft).managed && draft?.rootDirectory === ''
      ? { ...draft, rootDirectory: this.rootDirectory } : draft;
    let plan = buildNodeSetupPlan(input, { platform: this.platform });
    if (draft.choice === 'none') return { token: null, ...plan, disk: { availableBytes: null, requiredBytes: 0 } };
    if (hasManagedStorage(plan)) {
      const canonical = await canonicalDestination(plan.draft.rootDirectory);
      plan = buildNodeSetupPlan({ ...plan.draft, rootDirectory: canonical }, { platform: this.platform });
    }
    plan.providers = plan.providers.map(validateProviderMutation);
    await this.validateFresh(plan);
    const guidance = nodeSetupGuidance(plan.draft);
    const disk = hasManagedStorage(plan) ? await diskAt(plan.draft.rootDirectory, guidance.recommendedBytes)
      : { availableBytes: null, requiredBytes: 0 };
    const warnings = nodeSetupDisplayWarnings(plan.draft, plan.warnings);
    if (plan.services.length && disk.availableBytes !== null && disk.availableBytes < NODE_SETUP_MIN_FREE_BYTES) warnings.push('Available storage is below the 2 GiB minimum. You can save this setup, but managed services cannot start until more space is available.');
    if (disk.requiredBytes !== null && disk.availableBytes !== null && disk.availableBytes < disk.requiredBytes) warnings.push('Available storage is below the conservative recommendation. You can save the setup, but choose a larger drive before a full synchronization.');
    const token = crypto.randomUUID();
    this.previewRecord = { token, plan, expires: this.now() + 15 * 60_000 };
    return { token, ...plan, warnings, disk };
  }
  reserve(plan) {
    const providers = this.providerManager;
    const services = this.localServiceManager;
    for (const p of plan.providers) if (providers.providerMutations.has(p.id) || providers.blockedProviders.has(p.id)) throw error('PROVIDER_BUSY', 'A selected source is being edited or requires recovery.');
    for (const p of plan.providers) providers.assertNoPendingCleanup(p.id);
    for (const s of plan.services) if ([services.editing, services.starting, services.stopping, services.removing, services.processes].some(map => map.has(s.id))) throw error('SERVICE_RUNNING', 'A selected service is already active or being edited.');
    let release; const lease = new Promise(resolve => { release = resolve; });
    for (const p of plan.providers) providers.providerMutations.add(p.id);
    for (const s of plan.services) services.editing.set(s.id, lease);
    return () => {
      for (const p of plan.providers) providers.providerMutations.delete(p.id);
      for (const s of plan.services) if (services.editing.get(s.id) === lease) services.editing.delete(s.id);
      release();
    };
  }
  async apply(token, { consented = false } = {}) {
    const preview = this.previewRecord;
    if (!preview || token !== preview.token || this.now() > preview.expires) throw error('NODE_SETUP_PREVIEW_EXPIRED', 'Review the setup again before saving.');
    if (!consented && !await this.confirm('apply', preview.plan)) throw error('USER_REJECTED', 'Setup was not saved.', 499);
    this.assertRunning();
    if (this.previewRecord !== preview) throw error('NODE_SETUP_CHANGED', 'The setup changed while confirmation was open. Review it again.');
    await this.validateFresh(preview.plan);
    const plan = preview.plan;
    const release = this.reserve(plan);
    const created = []; let committed = false;
    const record = { schemaVersion: 1, id: crypto.randomUUID(), createdAt: new Date(this.now()).toISOString(), autoStart: plan.draft.autoStart, plan, planHash: digest(plan) };
    try {
      this.assertRunning();
      if (hasManagedStorage(plan) && await canonicalDestination(plan.draft.rootDirectory) !== plan.draft.rootDirectory) throw error('NODE_SETUP_DIRECTORY_CHANGED', 'The storage location changed. Review the setup again.');
      if (plan.directories.length) await fs.mkdir(plan.draft.rootDirectory, { recursive: true, mode: 0o700 });
      for (const directory of plan.directories) {
        this.assertRunning(); await fs.mkdir(directory, { mode: 0o700 });
        const stat = await fs.lstat(directory); created.push({ directory, dev: stat.dev, ino: stat.ino, files: [] });
      }
      for (const file of plan.files) {
        this.assertRunning();
        await fs.writeFile(file.path, file.content, { flag: 'wx', mode: 0o600 });
        created.find(item => item.directory === path.dirname(file.path)).files.push(file.path);
      }
      this.assertRunning();
      this.providerManager.invalidateRouting();
      await this.stateStore.mutate(state => {
        this.assertRunning();
        if (state.nodeSetup || plan.providers.some(p => state.providers.some(existing => existing.id === p.id)) || plan.services.some(s => state.localServices.some(existing => existing.id === s.id))) throw error('NODE_SETUP_COLLISION', 'Configuration changed before setup could be saved.');
        state.providers.push(...structuredClone(plan.providers));
        state.localServices.push(...structuredClone(plan.services));
        state.nodeSetup = structuredClone(record);
        // Network is explicitly selected and included in the confirmation. No
        // privacy setting, existing source or service is deleted or disabled.
        state.settings.network = plan.draft.network;
      });
      committed = true; this.previewRecord = null;
      this.providerManager.refresh();
      return { committed: true, setupId: record.id, setup: record, services: this.localServiceManager.list(), providers: this.providerManager.list(), settings: this.stateStore.get(['settings']) };
    } catch (cause) {
      if (committed) throw error('NODE_SETUP_SAVED_REFRESH_FAILED', 'Setup was saved, but its current status could not be refreshed. Resume it; do not save again.', 500, { setupCommitted: true, setupId: record.id });
      // Only remove our exact configuration files and now-empty directories.
      // Never recursively remove node data or a replaced/foreign directory.
      for (const item of created.reverse()) {
        const stat = await exists(item.directory).catch(() => null);
        if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.ino !== item.ino || stat.dev !== item.dev) continue;
        for (const file of item.files) {
          const expected = plan.files.find(entry => entry.path === file);
          try { const current = await fs.lstat(file); if (current.isFile() && current.size === Buffer.byteLength(expected.content) && await fs.readFile(file, 'utf8') === expected.content) await fs.unlink(file); } catch {}
        }
        await fs.rmdir(item.directory).catch(() => {});
      }
      const retained = [];
      for (const item of created) if (await exists(item.directory).catch(() => true)) retained.push(item.directory);
      if (retained.length) throw error('NODE_SETUP_CLEANUP_REQUIRED', 'Setup was not saved. Some newly created folders could not be safely removed; review them or choose another folder before retrying.', 500, { setupCommitted: false, retainedDirectories: retained, primaryCode: cause.code ?? 'SETUP_SAVE_FAILED' });
      throw cause;
    } finally { release(); }
  }
  assertOwned(record) {
    const services = this.stateStore.get(['localServices']) ?? [];
    const providers = this.stateStore.get(['providers']) ?? [];
    for (const expected of record.plan.services) if (!same(services.find(item => item.id === expected.id), expected)) throw error('NODE_SETUP_CHANGED', 'A guided service was edited or removed. Use advanced service controls to manage it.');
    for (const expected of record.plan.providers) if (!same(providers.find(item => item.id === expected.id), expected)) throw error('NODE_SETUP_CHANGED', 'A guided data source was edited or removed. Use Data sources to manage it.');
    if (this.stateStore.get(['settings', 'network']) !== record.plan.draft.network) throw error('NODE_SETUP_NETWORK_CHANGED', 'Switch the browser back to this setup’s network before checking or starting it.');
  }
  async assertFiles(record) {
    if (!hasManagedStorage(record.plan)) return;
    if (await canonicalDestination(record.plan.draft.rootDirectory) !== record.plan.draft.rootDirectory) throw error('NODE_SETUP_DIRECTORY_CHANGED', 'The managed storage location was redirected. Review it in advanced controls.');
    for (const directory of record.plan.directories) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('NODE_SETUP_DIRECTORY_CHANGED', 'A managed data directory was replaced. Use advanced controls after reviewing it.');
    }
    for (const file of record.plan.files) {
      const stat = await fs.lstat(file.path);
      if (!stat.isFile() || stat.size !== Buffer.byteLength(file.content) || await fs.readFile(file.path, 'utf8') !== file.content) throw error('NODE_SETUP_CONFIG_CHANGED', 'The guided configuration file was changed. Use advanced service controls.');
    }
  }
  coreConfig(plan) {
    return plan.providers.find(p => p.type === 'bitcoin-core') ?? { id: 'ord-core-readiness', name: 'Existing Bitcoin Core', type: 'bitcoin-core', network: plan.draft.network, baseUrl: plan.summary.coreUrl, cookieFile: plan.draft.core.cookieFile, local: true, capabilities: [] };
  }
  status(id) {
    const record = this.saved(id);
    if (!record) return Promise.resolve({ setupId: null, core: { phase: 'not-selected' }, ord: { phase: 'not-selected' } });
    if (this.reading) return this.reading;
    const operation = this.readStatus(record);
    this.reading = operation;
    return operation.finally(() => { if (this.reading === operation) this.reading = null; });
  }
  async freshStatus(id) {
    // Passive callers may share a snapshot begun before a lifecycle action.
    // Drain it before taking the action's snapshot, rather than retiring its
    // ownership and allowing a late read to overwrite newer lastStatus.
    await this.reading?.catch(() => {});
    this.assertRunning();
    const record = this.saved(id);
    if (record) this.assertOwned(record);
    return this.status(id);
  }
  async readStatus(record) {
    this.assertOwned(record);
    const plan = record.plan;
    const coreNeeded = plan.core.selected || plan.ord.managed;
    const result = { setupId: record.id, core: { phase: 'not-selected' }, ord: { phase: 'not-selected' } };
    const quickStart = isQuickStart(plan.draft);
    if (quickStart) result.snapshot = this.snapshots.status(record);
    if (this.stateStore.get(['settings', 'offlineMode'])) {
      if (coreNeeded) result.core = unavailable('Go online to check the local Core connection. Running node processes are not stopped by browser offline mode.');
      if (plan.ord.selected) result.ord = unavailable('Go online to check Ord.');
      return result;
    }
    const services = this.localServiceManager.list();
    const serviceStatus = id => services.find(service => service.id === id);
    const options = { signal: this.controller.signal, timeoutMs: 5_000, maxBytes: 64 * 1024 };
    if (coreNeeded) {
      const service = plan.core.managed ? serviceStatus(plan.core.serviceId) : null;
      if (service && !['running', 'starting'].includes(service.status)) result.core = { phase: service.status === 'failed' ? 'error' : 'stopped', message: service.status === 'failed' ? 'Bitcoin Core exited with an error. Open Local node to inspect its logs.' : 'Bitcoin Core is stopped.' };
      else if (quickStart && this.snapshots.operation && this.snapshots.activeSetupId === record.id) result.core = { phase: 'snapshot-loading', message: result.snapshot.message };
      else try {
        const core = this.coreFactory(this.coreConfig(plan));
        const info = (await core.rpc('getblockchaininfo', [], options)).result;
        this.assertRunning(); this.assertOwned(record);
        const expectedChain = { mainnet: 'main', testnet: 'test', signet: 'signet', regtest: 'regtest' }[plan.draft.network];
        if (info.chain !== expectedChain) throw error('NODE_WRONG_NETWORK', 'Bitcoin Core is on a different network.');
        if (!Number.isSafeInteger(info.blocks) || !Number.isSafeInteger(info.headers) || typeof info.initialblockdownload !== 'boolean' || !Number.isFinite(info.verificationprogress)) throw error('NODE_RESPONSE_INVALID', 'Bitcoin Core returned incomplete sync information.');
        if (plan.ord.managed && info.pruned !== false) throw error('NODE_PRUNED', 'Ord needs an archival Core node with pruning disabled.');
        let phase = info.initialblockdownload || info.blocks < info.headers ? 'syncing' : 'ready';
        if (phase === 'ready' && (plan.ord.managed || plan.core.managed && plan.draft.core.storage === 'archive')) {
          const indexes = (await core.rpc('getindexinfo', [], options)).result;
          this.assertRunning(); this.assertOwned(record);
          if (!indexes?.txindex) throw error('NODE_TXINDEX_MISSING', 'Enable the transaction index on the existing Core node before starting Ord.');
          if (indexes.txindex.synced !== true) phase = 'indexing';
        }
        if (phase === 'ready' && plan.ord.managed) {
          try {
            const rest = await this.restProbe(this.coreConfig(plan), options);
            this.assertRunning(); this.assertOwned(record);
            if (rest.chain !== expectedChain) throw error('NODE_REST_REQUIRED', 'Core REST is unavailable or on another network.');
          } catch (cause) {
            if (this.stopping) throw cause;
            throw error('NODE_REST_REQUIRED', 'Enable REST on the existing Core node before starting Ord.');
          }
        }
        result.core = { phase, blocks: info.blocks, headers: info.headers, progress: Math.max(0, Math.min(1, info.verificationprogress)), message: phase === 'ready' ? 'Bitcoin Core is synced and ready.' : phase === 'indexing' ? 'Building the transaction index. Ord will wait.' : 'Verifying the Bitcoin blockchain. You can keep browsing while it syncs.' };
        if (quickStart) {
          if (info.pruned !== true) throw error('NODE_RESPONSE_INVALID', 'Quick-start Core is not running in compact mode.');
          const chains = parseCoreChainstates((await core.rpc('getchainstates', [], options)).result);
          this.assertRunning(); this.assertOwned(record);
          // Different RPC calls may straddle a new block. Never claim tip or
          // history readiness from contradictory samples.
          const current = !info.initialblockdownload && chains.active.blocks >= Math.max(info.headers, chains.headers);
          const validated = chains.historicalValidated && (chains.hasSnapshot || current);
          result.core = { ...result.core, blocks: chains.active.blocks, headers: chains.headers, progress: chains.active.progress,
            phase: current ? (validated ? 'ready' : 'current-validating') : 'syncing', current, historicalValidated: validated,
            backgroundBlocks: chains.background?.blocks ?? null, snapshotBaseHash: chains.active.snapshotHash ?? null,
            message: current ? (validated ? 'Current with the network. Historical validation complete.' : 'Current with the network. Earlier history is still being validated; snapshot assumptions remain in use.')
              : chains.hasSnapshot ? 'Catching up from the snapshot while earlier history is validated in the background.' : 'Normal compact sync is running. You may load a supported snapshot after its headers arrive.' };
          if (chains.hasSnapshot) result.snapshot = { phase: validated ? 'validated' : 'validating', message: validated ? 'Core reports historical snapshot validation complete.' : 'Snapshot active. Core is independently checking earlier history.' };
        }
      } catch (cause) {
        if (this.stopping) throw cause;
        const known = { NODE_WRONG_NETWORK: 'Bitcoin Core is on a different network.', NODE_PRUNED: 'Ord needs an archival Core node with pruning disabled.', NODE_TXINDEX_MISSING: 'Enable txindex on the existing Core node, then wait for it to finish.', NODE_REST_REQUIRED: 'Ord needs Core REST enabled (rest=1). Review the existing Core configuration and restart it yourself.', NODE_RESPONSE_INVALID: 'Core returned incomplete sync information.',
          PROVIDER_AUTH_ERROR: 'Core rejected the connection credentials. Check that the RPC address and cookie file belong to the same running node.',
          PROVIDER_COOKIE_ACCESS_DENIED: 'The browser cannot access Core’s local sign-in file. Review the cookie file location and folder permissions; do not reinstall or delete node data.',
          PROVIDER_COOKIE_READ_FAILED: 'Core’s local sign-in file could not be read. Review its location in Data sources.' };
        const starting = { PROVIDER_COOKIE_UNAVAILABLE: 'Waiting for Core to create its local sign-in file. Keep the node running; no password change is needed.',
          PROVIDER_WARMING_UP: 'Core is loading its blockchain data. Keep it running; status will update automatically.' };
        result.core = { phase: known[cause.code] ? 'error' : starting[cause.code] ? 'starting' : 'unavailable', message: known[cause.code] ?? starting[cause.code] ?? (quickStart ? 'Core sync and historical validation could not be confirmed. Check that supported Core 31.x is running, then refresh status.' : 'Core is not reachable yet. It may still be starting; check its RPC address, cookie location and Local node logs.') };
      }
    }
    if (plan.ord.selected) {
      const service = plan.ord.managed ? serviceStatus(plan.ord.serviceId) : null;
      if (service && !['running', 'starting'].includes(service.status)) result.ord = { phase: service.status === 'failed' ? 'error' : 'stopped', message: service.status === 'failed' ? 'Ord exited with an error. Open Local node to inspect its logs.' : this.desired && result.core.phase !== 'ready' ? 'Ord will start after Core and its transaction index are ready.' : 'Ord is stopped.' };
      else try {
        const ord = this.ordFactory(plan.providers.find(p => p.type === 'ord-server'));
        const health = await ord.health(options);
        this.assertRunning(); this.assertOwned(record);
        if (!health.ok || !Number.isSafeInteger(health.height) || health.height < 0) throw error('NODE_RESPONSE_INVALID', 'Ord returned invalid index status.');
        const ready = coreNeeded ? result.core.phase === 'ready' && health.height >= result.core.blocks : false;
        result.ord = { phase: ready ? 'ready' : coreNeeded ? 'indexing' : 'connected', height: health.height,
          message: ready ? 'Ord is indexed through the checked Core height.' : coreNeeded ? 'Ord is indexing Bitcoin inscriptions. Browsing remains available through your other sources.' : 'Ord is reachable. Without a Core comparison, full synchronization is not confirmed.' };
      } catch (cause) {
        if (this.stopping) throw cause;
        result.ord = unavailable('Ord is not reachable yet. It may still be starting; check its address and Local node logs.');
      }
    }
    this.assertRunning(); this.assertOwned(record);
    this.lastStatus = result;
    return result;
  }
  async start(id, { automatic = false, consented = false } = {}) {
    if (this.snapshots.operation) throw error('NODE_SNAPSHOT_BUSY', 'Core is importing a snapshot. Refresh status or stop managed services.');
    const record = this.saved(id);
    if (!record) throw error('NODE_SETUP_MISSING', 'Save a setup before starting it.');
    this.assertOwned(record);
    if (!automatic && !consented && !await this.confirm('start', record.plan)) throw error('USER_REJECTED', 'Node startup was cancelled.', 499);
    this.assertRunning(); this.assertOwned(record); await this.assertFiles(record);
    if (this.stateStore.get(['settings', 'offlineMode'])) throw error('NODE_SETUP_OFFLINE', 'Go online before starting guided synchronization.', 403);
    const disk = hasManagedStorage(record.plan) ? await diskAt(record.plan.draft.rootDirectory, nodeSetupGuidance(record.plan.draft).recommendedBytes)
      : { availableBytes: null, requiredBytes: 0 };
    this.assertRunning(); this.assertOwned(record);
    if (this.stateStore.get(['settings', 'offlineMode'])) throw error('NODE_SETUP_OFFLINE', 'Privacy settings changed before startup.', 403);
    if (record.plan.services.length && disk.availableBytes !== null && disk.availableBytes < NODE_SETUP_MIN_FREE_BYTES) throw error('NODE_SETUP_DISK_LOW', 'Less than 2 GiB is available. Choose a drive with enough room before starting.');
    // A previous automatic advance must settle before the new intent exists.
    // Its delayed readiness result can neither authorize Ord nor clear a new
    // start request after this boundary.
    this.clearIntent();
    await this.advancing?.catch(() => {});
    this.assertRunning(); this.assertOwned(record);
    if (this.stateStore.get(['settings', 'offlineMode'])) throw error('NODE_SETUP_OFFLINE', 'Privacy settings changed before startup.', 403);
    if (record.plan.core.managed) await this.localServiceManager.start(record.plan.core.serviceId);
    this.assertRunning(); this.assertOwned(record);
    this.desired = record.id; this.intentToken = {};
    const status = await this.advance(record);
    if (this.desired && !this.timer) {
      const intentToken = this.intentToken, setupId = this.desired;
      this.timer = this.setTimer(() => {
        if (this.intentToken !== intentToken || !this.desired || this.stopping || this.mutation) return;
        void this.track(() => {
          // clearInterval cannot retract an already queued callback. Neither
          // its deferred admission nor its catch may adopt a newer intent.
          if (this.intentToken !== intentToken || this.desired !== setupId || this.mutation) return;
          return this.advance(this.saved(setupId));
        }).catch(() => { if (this.intentToken === intentToken) this.clearIntent(); });
      }, 15_000);
      this.timer.unref?.();
    }
    return status;
  }
  advance(record) {
    if (this.advancing) return this.advancing;
    const operation = this.advanceOnce(record); this.advancing = operation;
    return operation.finally(() => { if (this.advancing === operation) this.advancing = null; });
  }
  async advanceOnce(record) {
    if (!record || this.desired !== record.id) return this.lastStatus;
    const status = await this.freshStatus(record.id);
    this.assertRunning(); this.assertOwned(record);
    if (this.desired !== record.id) return status;
    if (record.plan.ord.managed && status.core.phase === 'ready' && status.ord.phase === 'stopped') {
      await this.assertFiles(record);
      this.assertRunning(); this.assertOwned(record);
      if (this.stateStore.get(['settings', 'offlineMode'])) return status;
      if (this.desired !== record.id) return status;
      await this.localServiceManager.start(record.plan.ord.serviceId);
      status.ord = { phase: 'starting', message: 'Starting Ord now that Core is ready.' };
    }
    if (!record.plan.ord.managed || ['ready', 'error'].includes(status.ord.phase) || ['error', 'stopped'].includes(status.core.phase)) this.clearIntent();
    return status;
  }
  clearIntent() { this.desired = null; this.intentToken = null; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
  async stop(id) {
    const record = this.saved(id); if (!record) return this.status();
    this.clearIntent();
    this.snapshots.abortObservation();
    // In-flight readiness work can no longer authorize a later Ord start.
    await this.advancing?.catch(() => {});
    this.assertRunning(); this.assertOwned(record);
    const outcomes = [];
    for (const component of [record.plan.ord, record.plan.core]) if (component.managed) outcomes.push(await this.localServiceManager.stop(component.serviceId).then(() => null, cause => cause));
    if (outcomes.some(Boolean)) throw error('NODE_SETUP_STOP_FAILED', 'A managed node did not stop cleanly. Inspect Local node logs before retrying.', 500);
    return this.freshStatus(id);
  }
  async autoStart() {
    const record = this.saved();
    if (!record?.autoStart) return Promise.resolve();
    return this.track(() => this.exclusive(() => this.start(record.id, { automatic: true })));
  }
  settingsChanged(settings) {
    if (settings.offlineMode || settings.localOnly) for (const controller of this.downloads) controller.abort(error('SOFTWARE_DOWNLOAD_BLOCKED', 'Software download cancelled because privacy settings changed.', 403));
    if (settings.offlineMode) { this.clearIntent(); this.snapshots.abortObservation(); }
  }
  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true; this.clearIntent(); this.controller.abort(error('APP_SHUTTING_DOWN', 'The application is shutting down.', 503));
    this.snapshots.abortObservation();
    const softwareDrain = Promise.resolve().then(() => this.software.shutdown());
    this.shutdownPromise = Promise.allSettled([softwareDrain, ...this.pending]).then(results => {
      // Cancelled admitted UI work is expected on quit; failed cleanup is not.
      if (results[0].status === 'rejected') throw results[0].reason;
    });
    return this.shutdownPromise;
  }
}
