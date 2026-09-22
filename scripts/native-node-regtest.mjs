import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../src/main/state-store.js';
import { SecureStore } from '../src/main/secure-store.js';
import { ProviderManager } from '../src/main/provider-manager.js';
import { LocalServiceManager } from '../src/main/local-service-manager.js';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';
import { NodeSoftware } from '../src/main/node-software.js';
import { BitcoinCoreProvider } from '../src/main/providers/bitcoin-core.js';
import { buildRegtestBlock, REGTEST_BITS } from './regtest-block-fixture.mjs';
import {
  buildNativeRegtestPlan, assertRegtestSnapshot, REGTEST_GENESIS, REGTEST_STOP_RESERVE_MS,
  REGTEST_RPC_METHODS, regtestDigest, isSha256, requireRegtest, regtestError
} from './native-node-regtest-plan.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_READ_BYTES = 128 * 1024 ** 2;
const MAX_REPORT_EVENTS = 2000;
const codeFor = cause => /^[A-Z][A-Z0-9_]{0,79}$/.test(cause?.code ?? '') ? cause.code : 'REGTEST_OPERATION_FAILED';

async function regularFile(file, limit = MAX_READ_BYTES) {
  requireRegtest(await fs.realpath(file) === file, 'REGTEST_PATH_REDIRECTED');
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    requireRegtest(before.isFile() && before.size <= limit, 'REGTEST_FILE_INVALID');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireRegtest(bytes.length <= limit && before.size === after.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'REGTEST_FILE_CHANGED');
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), stat: after };
  } finally { await handle.close(); }
}

/** Hash source/build inputs, never profiles, environment files or release logs. */
export async function nativeRegtestSourceIdentity() {
  const files = [];
  async function walk(directory) {
    const entries = await fs.readdir(path.join(repository, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(directory, entry.name);
      requireRegtest(!entry.isSymbolicLink(), 'REGTEST_SOURCE_SYMLINK');
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && /\.(?:mjs|cjs|js|html|css|json)$/.test(entry.name)) files.push(relative);
    }
  }
  await walk('src'); await walk('scripts');
  files.push('package.json', 'package-lock.json');
  const identities = [];
  for (const relative of files.sort()) {
    const result = await regularFile(path.join(repository, relative));
    identities.push({ path: relative, sha256: result.sha256 });
  }
  return { sha256: regtestDigest(identities), files: identities };
}

export async function validateNativeRegtestInputs(plan) {
  requireRegtest(process.platform === plan.platform && process.arch === plan.architecture, 'REGTEST_HOST_UNQUALIFIED');
  const rebuilt = buildNativeRegtestPlan(plan.spec, plan.sourceSha256);
  requireRegtest(JSON.stringify(rebuilt) === JSON.stringify(plan), 'REGTEST_PLAN_CHANGED');
  const source = await nativeRegtestSourceIdentity();
  requireRegtest(source.sha256 === plan.sourceSha256, 'REGTEST_SOURCE_CHANGED');
  const binaries = [];
  for (const kind of ['core', 'ord']) {
    const descriptor = plan.spec[kind];
    const value = await regularFile(descriptor.path);
    requireRegtest(value.sha256 === descriptor.sha256 && (value.stat.mode & 0o111) !== 0, 'REGTEST_BINARY_CHANGED');
    const installation = plan.requiredInstallations.find(item => item.kind === kind);
    const evidence = await regularFile(installation.manifestPath, 16 * 1024);
    const manifest = JSON.parse(evidence.bytes.toString('utf8'));
    assertRegtestInstallation(manifest, installation, value.sha256);
    requireRegtest(path.basename(descriptor.path) === installation.executableName, 'REGTEST_INSTALLATION_MISMATCH');
    binaries.push({ kind, path: descriptor.path, sha256: value.sha256, bytes: value.stat.size,
      installationManifestPath: installation.manifestPath, installationManifestSha256: evidence.sha256,
      catalogVersion: installation.version, archiveSha256: installation.archiveSha256,
      versionEvidence: 'Matching managed-installation manifest and approved executable digest; not publisher-signature authentication.' });
  }
  return { binaries, sourceFiles: source.files };
}

export function assertRegtestInstallation(manifest, expected, executableSha256) {
  requireRegtest(manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && Object.keys(manifest).sort().join(',') === 'executableSha256,kind,sha256,version'
    && manifest.kind === expected.kind && manifest.version === expected.version
    && manifest.sha256 === expected.archiveSha256 && manifest.executableSha256 === executableSha256,
  'REGTEST_INSTALLATION_MISMATCH');
}

async function reservePorts(ports) {
  const servers = [];
  try {
    for (const port of ports) {
      const server = net.createServer(); servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
      });
    }
  } catch {
    throw regtestError('REGTEST_PORT_OCCUPIED');
  } finally {
    await Promise.all(servers.map(server => server.listening
      ? new Promise(resolve => server.close(resolve)) : Promise.resolve()));
  }
}

export async function measureRegtestDirectory(root, identity, maxEntries = 20_000) {
  const first = await fs.lstat(root);
  requireRegtest(first.isDirectory() && !first.isSymbolicLink()
    && first.ino === identity.ino && first.dev === identity.dev
    && await fs.realpath(root) === root, 'REGTEST_ROOT_CHANGED');
  let entries = 0, bytes = 0;
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      requireRegtest(++entries <= maxEntries, 'REGTEST_STORAGE_ENTRY_LIMIT');
      const file = path.join(directory, entry.name);
      let stat;
      try { stat = await fs.lstat(file); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
      requireRegtest(!stat.isSymbolicLink(), 'REGTEST_STORAGE_SYMLINK');
      if (stat.isDirectory()) await walk(file);
      else {
        requireRegtest(stat.isFile() && stat.nlink === 1, 'REGTEST_STORAGE_SPECIAL_FILE');
        bytes += stat.size;
        requireRegtest(Number.isSafeInteger(bytes), 'REGTEST_STORAGE_INVALID');
      }
    }
  }
  await walk(root);
  return { bytes, entries };
}

function publicService(item) {
  return { id: item.id, status: item.status, pid: item.pid, exitCode: item.exitCode,
    signal: item.signal, forcedTerminationRequested: item.forcedTerminationRequested };
}

export async function resolveRegtestBlock(providers, providerId, block, options) {
  const target = { kind: 'block', value: '1', canonical: 'block:1' };
  const { entity, attempts } = await providers.resolve(target, { ...options, preferredProviderId: providerId });
  requireRegtest(entity?.network === 'regtest' && entity.source?.id === providerId
    && entity.summary?.hash === block.blockHash && entity.summary.height === 1
    && attempts?.length === 1 && attempts[0].providerId === providerId && attempts[0].ok === true,
  'REGTEST_LOOKUP_MISMATCH');
  return { provider: providerId, blockHash: entity.summary.hash };
}

export function assertRegtestProviderSet(manager, expected) {
  requireRegtest(manager.instances.size === expected.length, 'REGTEST_PROVIDER_SET_MISMATCH');
  for (const configuration of expected) {
    const provider = manager.instances.get(configuration.id);
    requireRegtest(provider && regtestDigest(provider.config) === regtestDigest(configuration), 'REGTEST_PROVIDER_SET_MISMATCH');
  }
}

export function retainRegtestAbort(report, signal) {
  if (signal.aborted) {
    report.result = 'FAIL';
    report.errors.push({ phase: 'abort', code: codeFor(signal.reason) });
  }
}

export function closeRegtestAdmissions(contexts) {
  const operations = [];
  for (const context of contexts) for (const manager of [context.setup, context.providers, context.services]) {
    // Invoke now, not in a promise continuation: shutdown closes each
    // manager's own admission synchronously before draining admitted work.
    try { operations.push(Promise.resolve(manager.shutdown())); }
    catch (cause) { operations.push(Promise.reject(cause)); }
  }
  return Promise.allSettled(operations);
}

export async function confirmRegtestPlan(action, value, expected, guard, validate, signal) {
  await guard(); signal.throwIfAborted();
  requireRegtest(['apply', 'start'].includes(action)
    && regtestDigest(value) === regtestDigest(expected), 'REGTEST_CONFIRMATION_MISMATCH');
  await validate(); signal.throwIfAborted();
  return true;
}

export function retainRegtestInterruption(report, signal) {
  if (signal?.aborted && !report.errors.some(item => item.code === 'REGTEST_INTERRUPTED')) {
    report.result = 'FAIL'; report.errors.push({ phase: 'external-interruption', code: 'REGTEST_INTERRUPTED' });
  }
}

/** Publish only after the caller has drained work and checked root/input identity.
 * A result file alone is not acceptance: the returned result and any invalidation
 * marker must also be checked. Keep an acknowledged snapshot immutable. */
export async function publishRegtestEvidence(root, report, signal) {
  try {
    retainRegtestInterruption(report, signal);
    await fs.writeFile(path.join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // An interrupt arriving during evidence I/O invalidates its earlier
    // snapshot without overwriting an acknowledged evidence file.
    if (signal?.aborted && !report.errors.some(item => item.code === 'REGTEST_INTERRUPTED')) {
      retainRegtestInterruption(report, signal);
      await fs.writeFile(path.join(root, 'result-invalidated.json'),
        `${JSON.stringify({ result: 'FAIL', code: 'REGTEST_INTERRUPTED', planSha256: report.planSha256 })}\n`, { flag: 'wx', mode: 0o600 });
    }
  } catch (cause) {
    report.result = 'FAIL'; report.errors.push({ phase: 'evidence', code: codeFor(cause) });
  }
  return report;
}

export async function verifyRegtestFinalIdentity(report, plan, validate = validateNativeRegtestInputs, signal) {
  try {
    const current = await validate(plan);
    requireRegtest(JSON.stringify(current.binaries) === JSON.stringify(report.binaries)
      && JSON.stringify(current.sourceFiles) === JSON.stringify(report.sourceFiles), 'REGTEST_FINAL_IDENTITY_CHANGED');
    report.finalIdentityVerified = true;
  } catch (cause) {
    report.result = 'FAIL'; report.finalIdentityVerified = false;
    report.errors.push({ phase: 'final-identity', code: codeFor(cause) });
  }
  retainRegtestInterruption(report, signal);
}

/** Runs through an explicit runtime contract; tests may supply labeled fixtures.
 * Native qualification is asserted only by executeNativeRegtest's real runtime. */
export async function runRegtestScenarios(plan, runtime, checkpoint) {
  const results = [];
  async function scenario(id, action) {
    const value = await runtime.open(id);
    await action(value);
    await checkpoint();
    results.push({ id, result: 'PASS' });
  }
  await scenario('none', async value => { await value.none(); });
  await scenario('core-only', async value => {
    await value.save(); await value.reopen(); await value.start();
    await value.seed(); await value.ready(); await value.lookup();
    await value.stop(); await value.reopen(); await value.start();
    await value.ready(); await value.lookup(); await value.stop();
  });
  const both = await runtime.open('both');
  await both.save(); await both.reopen(); await both.start();
  await both.seed(); await both.ready(); await both.lookup();
  await scenario('ord-only', async value => {
    await value.save(); await value.reopen(); await value.start();
    await value.ready(); await value.lookup(); await value.stop();
    await both.assertStillRunning();
    await value.reopen(); await value.start(); await value.ready(); await value.stop();
    await both.assertStillRunning();
  });
  await scenario('existing-only', async value => {
    await value.save(); await value.reopen(); await value.start();
    await value.ready(); await value.lookup(); await value.stop();
    await both.assertStillRunning();
  });
  await both.stop(); await both.reopen(); await both.start();
  await both.ready(); await both.lookup(); await both.stop();
  await checkpoint(); results.push({ id: 'both', result: 'PASS' });
  return results;
}

function createNativeRuntime(plan, controller, guard, emit, contexts) {
  const byId = new Map();
  const publicBlocks = new Map();
  const options = () => ({ signal: controller.signal, timeoutMs: 5000, maxBytes: 64 * 1024 });
  const guardOperation = async () => { controller.signal.throwIfAborted(); await guard(); controller.signal.throwIfAborted(); };

  async function open(id) {
    const scenario = plan.scenarios.find(item => item.id === id);
    requireRegtest(scenario && !byId.has(id), 'REGTEST_SCENARIO_INVALID');
    let context;
    async function initialize(reopening = false) {
      await guardOperation();
      const state = new StateStore(scenario.profile, null); await state.init();
      if (!reopening) await state.mutate(value => {
        value.providers = []; value.localServices = [];
        value.settings.network = 'regtest'; value.settings.localOnly = true;
        value.settings.offlineMode = false; value.settings.preferredProviderId = null;
        value.settings.telemetryEnabled = false;
      });
      // No native safeStorage implementation. Only a fresh, empty, owned
      // fixture store is initialized; auth uses Core's dedicated cookie.
      const secure = new SecureStore(scenario.profile, null, null); await secure.init();
      controller.signal.throwIfAborted();
      const providers = new ProviderManager(state, secure, null);
      const software = new NodeSoftware({ directory: path.join(plan.spec.root, 'unused-software') });
      let last = '';
      const services = new LocalServiceManager(state, null, list => {
        const snapshot = list.map(publicService), encoded = JSON.stringify(snapshot);
        if (encoded !== last) { last = encoded; emit('services', { scenario: id, services: snapshot }); }
      });
      const setup = new NodeSetupManager({ stateStore: state, providerManager: providers,
        localServiceManager: services, software, rootDirectory: scenario.plan.draft.rootDirectory,
        confirm: (action, value) => confirmRegtestPlan(action, value, scenario.plan,
          guardOperation, () => validateNativeRegtestInputs(plan), controller.signal) });
      context = { id, state, secure, providers, services, setup, savedId: reopening ? state.get(['nodeSetup'])?.id : null };
      contexts.push(context);
      if (reopening) requireRegtest(context.savedId
        && regtestDigest(setup.saved().plan) === regtestDigest(scenario.plan), 'REGTEST_REOPEN_CHANGED');
    }
    await initialize();
    const expectedBlock = () => publicBlocks.get(id === 'core-only' ? 'core-only' : 'both');
    const core = () => new BitcoinCoreProvider(context.setup.coreConfig(scenario.plan));
    async function rpc(method, params = []) {
      requireRegtest(REGTEST_RPC_METHODS.includes(method), 'REGTEST_RPC_FORBIDDEN');
      await guardOperation();
      return (await core().rpc(method, params, options())).result;
    }
    async function snapshot(expected = expectedBlock()) {
      const info = await rpc('getblockchaininfo');
      const network = await rpc('getnetworkinfo');
      return assertRegtestSnapshot(info, network, expected?.blockHash, expected?.height);
    }
    async function poll(action, complete) {
      const end = Date.now() + 120_000;
      while (true) {
        await guardOperation();
        const result = await action();
        if (complete(result)) return result;
        requireRegtest(Date.now() < end, 'REGTEST_READINESS_TIMEOUT');
        await delay(250, undefined, { signal: controller.signal });
      }
    }
    async function closeManagers() {
      const results = await Promise.allSettled([context.setup.shutdown(), context.providers.shutdown(), context.services.shutdown()]);
      requireRegtest(results.every(item => item.status === 'fulfilled'), 'REGTEST_MANAGER_DRAIN_FAILED');
      await context.state.flush(); await context.secure.flush();
    }
    const value = {
      async none() {
        const preview = await context.setup.run({ action: 'preview', draft: scenario.plan.draft });
        requireRegtest(preview.token === null && preview.services.length === 0
          && preview.providers.length === 0 && context.state.get(['nodeSetup']) === undefined, 'REGTEST_NONE_CHANGED_STATE');
      },
      async save() {
        await guardOperation();
        const preview = await context.setup.run({ action: 'preview', draft: scenario.plan.draft });
        const result = await context.setup.run({ action: 'apply', token: preview.token });
        requireRegtest(result.committed === true && regtestDigest(result.setup.plan) === regtestDigest(scenario.plan), 'REGTEST_SAVE_CHANGED');
        context.savedId = result.setupId;
        emit('saved', { scenario: id, planHash: result.setup.planHash });
      },
      async reopen() {
        requireRegtest(context.services.processes.size === 0, 'REGTEST_REOPEN_WHILE_RUNNING');
        const savedId = context.savedId;
        await closeManagers(); await initialize(true);
        requireRegtest(context.savedId === savedId, 'REGTEST_REOPEN_CHANGED');
        emit('reopened', { scenario: id });
      },
      async start() {
        await guardOperation();
        await context.setup.run({ action: 'start', setupId: context.savedId });
        if (scenario.plan.core.managed && !expectedBlock()) {
          requireRegtest(!context.services.processes.has(scenario.plan.ord.serviceId), 'REGTEST_ORD_STARTED_BEFORE_CORE');
        }
        emit('started', { scenario: id });
      },
      async seed() {
        requireRegtest(scenario.plan.core.managed && !expectedBlock(), 'REGTEST_SEED_FORBIDDEN');
        await poll(async () => {
          try { return await snapshot({ blockHash: REGTEST_GENESIS, height: 0 }); }
          catch (cause) {
            if (['PROVIDER_AUTH_ERROR', 'PROVIDER_NETWORK_ERROR', 'PROVIDER_WARMING_UP'].includes(cause.code)) return null;
            throw cause;
          }
        }, Boolean);
        requireRegtest(await rpc('getblockhash', [0]) === REGTEST_GENESIS, 'REGTEST_GENESIS_CHANGED');
        const header = await rpc('getblockheader', [REGTEST_GENESIS, true]);
        requireRegtest(header.hash === REGTEST_GENESIS && header.height === 0
          && header.bits === REGTEST_BITS && Number.isSafeInteger(header.mediantime), 'REGTEST_HEADER_INVALID');
        const timestamp = Math.floor(Date.now() / 1000);
        requireRegtest(timestamp > header.mediantime, 'REGTEST_CLOCK_INVALID');
        const block = buildRegtestBlock({ previousBlockHash: REGTEST_GENESIS, height: 1, timestamp, bits: REGTEST_BITS });
        await snapshot({ blockHash: REGTEST_GENESIS, height: 0 });
        // The sole mutating RPC is constructed here, never accepted from a
        // manifest, caller-provided transaction, external block or wallet.
        requireRegtest(await rpc('submitblock', [block.blockHex]) === null, 'REGTEST_BLOCK_REJECTED');
        publicBlocks.set(id, block);
        await snapshot();
        emit('block-accepted', { scenario: id, blockHash: block.blockHash, coinbaseTxId: block.coinbaseTxId,
          height: 1, coinbaseValueSats: 0, coinbaseOutputScriptHex: '6a', nonceAttempts: block.nonceAttempts });
      },
      async ready() {
        await snapshot();
        const status = await poll(async () => {
          await snapshot();
          const current = await context.setup.run({ action: 'status', setupId: context.savedId });
          requireRegtest(![current.core.phase, current.ord.phase].includes('error'), 'REGTEST_NODE_READINESS_ERROR');
          // This invokes the same dependency coordinator as its production
          // timer; no provider/REST readiness responses are replaced.
          if (context.setup.desired) await context.setup.track(() => context.setup.advance(context.setup.saved()));
          return current;
        }, current => (!scenario.plan.core.selected && !scenario.plan.ord.managed || current.core.phase === 'ready')
          && (!scenario.plan.ord.selected || current.ord.phase === 'ready'));
        emit('ready', { scenario: id, core: status.core.phase, ord: status.ord.phase,
          coreHeight: status.core.blocks ?? null, ordHeight: status.ord.height ?? null });
      },
      async lookup() {
        const block = expectedBlock(); requireRegtest(block, 'REGTEST_BLOCK_MISSING');
        await snapshot();
        assertRegtestProviderSet(context.providers, scenario.plan.providers);
        for (const provider of context.providers.instances.values()) {
          requireRegtest(provider.network === 'regtest' && provider.config.local, 'REGTEST_PROVIDER_CHANGED');
          const result = await resolveRegtestBlock(context.providers, provider.id, block, options());
          emit('block-resolved', { scenario: id, ...result });
        }
        if (scenario.plan.core.selected) {
          const transaction = await rpc('getrawtransaction', [block.coinbaseTxId, true]);
          requireRegtest(transaction.txid === block.coinbaseTxId && transaction.blockhash === block.blockHash,
            'REGTEST_TXINDEX_LOOKUP_MISMATCH');
        }
      },
      async assertStillRunning() {
        for (const service of scenario.plan.services) requireRegtest(context.services.processes.has(service.id), 'REGTEST_EXTERNAL_SERVICE_STOPPED');
        await snapshot();
        const current = await context.setup.run({ action: 'status', setupId: context.savedId });
        requireRegtest(current.core.phase === 'ready' && current.ord.phase === 'ready', 'REGTEST_EXTERNAL_SERVICE_UNAVAILABLE');
      },
      async stop() {
        await context.setup.run({ action: 'stop', setupId: context.savedId });
        const services = context.services.list();
        requireRegtest(context.services.processes.size === 0
          && services.every(item => item.status === 'stopped' && !item.forcedTerminationRequested
            && item.exitCode === 0 && item.signal === null), 'REGTEST_UNCLEAN_STOP');
        emit('stopped', { scenario: id, services: services.map(publicService) });
      }
    };
    byId.set(id, value); return value;
  }
  return { open };
}

/** Native effects require both a rebuilt exact plan and its explicit CLI hash.
 * The hash is a scope confirmation, not a substitute for tool/user approval. */
export async function executeNativeRegtest(plan, approvedPlanSha256, { signal } = {}) {
  requireRegtest(isSha256(approvedPlanSha256) && plan.planSha256 === approvedPlanSha256, 'REGTEST_EXECUTION_NOT_APPROVED');
  signal?.throwIfAborted();
  const { binaries, sourceFiles } = await validateNativeRegtestInputs(plan);
  requireRegtest(await fs.realpath(path.dirname(plan.spec.root)) === '/private/tmp', 'REGTEST_ROOT_REDIRECTED');
  await reservePorts(Object.values(plan.spec.ports));
  signal?.throwIfAborted();
  // mkdir without recursive/exist-ok is the run's exclusive fresh-root claim.
  await fs.mkdir(plan.spec.root, { mode: 0o700 });
  const rootIdentity = await fs.lstat(plan.spec.root);
  const started = Date.now(), controller = new AbortController(), contexts = [];
  const report = { schemaVersion: 1, startedAt: new Date(started).toISOString(), planSha256: plan.planSha256,
    sourceSha256: plan.sourceSha256, sourceFiles, nativeExecution: true, result: 'FAIL', binaries, cases: [], events: [],
    droppedEvents: 0, maxObservedBytes: 0, errors: [], retainedRoot: plan.spec.root,
    qualification: plan.qualification, networkPolicy: plan.networkPolicy, storagePolicy: plan.storagePolicy };
  function emit(event, fields) {
    if (report.events.length >= MAX_REPORT_EVENTS) { report.droppedEvents++; return; }
    report.events.push({ time: new Date().toISOString(), event, ...fields });
  }
  const abort = () => controller.abort(regtestError('REGTEST_INTERRUPTED'));
  let cancellationDrain = null;
  const closeAdmissions = () => { cancellationDrain ??= closeRegtestAdmissions(contexts); };
  controller.signal.addEventListener('abort', closeAdmissions, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(() => controller.abort(regtestError('REGTEST_DEADLINE')), plan.spec.maxRunMs - REGTEST_STOP_RESERVE_MS);
  const guard = async () => {
    controller.signal.throwIfAborted();
    const measurement = await measureRegtestDirectory(plan.spec.root, rootIdentity);
    report.maxObservedBytes = Math.max(report.maxObservedBytes, measurement.bytes);
    requireRegtest(measurement.bytes <= plan.spec.maxGrowthBytes, 'REGTEST_STORAGE_LIMIT');
    const free = await fs.statfs(plan.spec.root);
    requireRegtest(free.bavail * free.bsize >= 2 * 1024 ** 3, 'REGTEST_DISK_LOW');
    controller.signal.throwIfAborted();
  };
  let monitoring = null;
  const monitor = setInterval(() => {
    if (!monitoring) {
      monitoring = guard().catch(cause => controller.abort(cause)).finally(() => { monitoring = null; });
    }
  }, 1000);
  try {
    await guard();
    await fs.writeFile(path.join(plan.spec.root, 'approved-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const runtime = createNativeRuntime(plan, controller, guard, emit, contexts);
    report.cases = await runRegtestScenarios(plan, runtime, guard);
    report.result = 'PASS';
  } catch (cause) {
    report.errors.push({ phase: 'run', code: codeFor(cause) });
  } finally {
    clearTimeout(deadline); clearInterval(monitor); await monitoring;
    retainRegtestAbort(report, controller.signal);
    controller.abort(regtestError('REGTEST_DRAINING'));
    await cancellationDrain;
    // All admitted contexts are drained even if a sibling fails. No recursive
    // cleanup or PID guessing; LocalServiceManager retains exact child handles.
    const drains = await Promise.allSettled(contexts.map(async context => {
      const results = await Promise.allSettled([context.setup.shutdown(), context.providers.shutdown(), context.services.shutdown()]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      await context.state.flush(); await context.secure.flush();
    }));
    for (const result of drains) if (result.status === 'rejected') report.errors.push({ phase: 'drain', code: codeFor(result.reason) });
    report.remainingOwnedServices = contexts.flatMap(context => context.services.list()
      .filter(item => item.pid !== null).map(item => ({ scenario: context.id, ...publicService(item) })));
    const unclean = contexts.flatMap(context => context.services.list()).some(item => item.status === 'failed'
      || item.forcedTerminationRequested || item.signal !== null || item.exitCode !== null && item.exitCode !== 0);
    report.elapsedMs = Date.now() - started;
    report.finishedAt = new Date().toISOString();
    if (unclean || report.remainingOwnedServices.length || report.errors.length
      || report.elapsedMs > plan.spec.maxRunMs || report.droppedEvents) report.result = 'FAIL';
    await verifyRegtestFinalIdentity(report, plan, validateNativeRegtestInputs, signal);
    try {
      const measured = await measureRegtestDirectory(plan.spec.root, rootIdentity);
      report.maxObservedBytes = Math.max(report.maxObservedBytes, measured.bytes);
      if (measured.bytes > plan.spec.maxGrowthBytes) report.result = 'FAIL';
      report.elapsedMs = Date.now() - started;
      report.finishedAt = new Date().toISOString();
      if (report.elapsedMs > plan.spec.maxRunMs) report.result = 'FAIL';
      await publishRegtestEvidence(plan.spec.root, report, signal);
      // Keep external interruption authoritative until this caller closes its
      // listener, including the publication helper's promise continuation.
      retainRegtestInterruption(report, signal);
    } catch (cause) {
      report.result = 'FAIL'; report.errors.push({ phase: 'evidence', code: codeFor(cause) });
    }
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', closeAdmissions);
  }
  return report;
}

export function parseRegtestArguments(args) {
  if (args.length === 0 || args.length === 1 && args[0] === '--help') return { help: true };
  const result = { help: false, execute: false, manifest: null, approved: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    requireRegtest(!seen.has(argument), 'REGTEST_ARGUMENT_INVALID'); seen.add(argument);
    if (argument === '--execute') result.execute = true;
    else if (argument === '--manifest' || argument === '--approved-plan-sha256') {
      const value = args[++i]; requireRegtest(value && !value.startsWith('--'), 'REGTEST_ARGUMENT_INVALID');
      if (argument === '--manifest') result.manifest = value; else result.approved = value;
    } else throw regtestError('REGTEST_ARGUMENT_INVALID');
  }
  requireRegtest(typeof result.manifest === 'string' && path.isAbsolute(result.manifest)
    && (result.execute ? isSha256(result.approved) : result.approved === null), 'REGTEST_ARGUMENT_INVALID');
  return result;
}

async function main() {
  try {
    const args = parseRegtestArguments(process.argv.slice(2));
    if (args.help) {
      process.stdout.write('Native Core/Ord regtest integration (plan-only by default).\n'
        + 'Plan: node scripts/native-node-regtest.mjs --manifest /absolute/path/to/run.json\n'
        + 'Execute only after exact approval: add --execute --approved-plan-sha256 <plan hash>\n'
        + 'See docs/NATIVE_NODE_REGTEST_PLAN.md for manifest, limits, retention and qualification boundaries.\n');
      return;
    }
    const manifest = JSON.parse((await regularFile(args.manifest, 64 * 1024)).bytes.toString('utf8'));
    const identity = await nativeRegtestSourceIdentity();
    const plan = buildNativeRegtestPlan(manifest, identity.sha256);
    if (!args.execute) { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return; }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      const report = await executeNativeRegtest(plan, args.approved, { signal: controller.signal });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.result !== 'PASS') process.exitCode = 1;
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  } catch (cause) {
    process.stderr.write(`${JSON.stringify({ result: 'FAIL', code: codeFor(cause) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
