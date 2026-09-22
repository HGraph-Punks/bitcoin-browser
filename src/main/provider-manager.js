import crypto from 'node:crypto';
import { OrdServerProvider } from './providers/ord-server.js';
import { MempoolProvider } from './providers/mempool.js';
import { BitcoinCoreProvider } from './providers/bitcoin-core.js';
import { MockProvider } from './providers/mock.js';
import { AppError, serializeError } from '../shared/errors.js';
import { targetCapability } from '../shared/navigation.js';
import { validateProviderConfig, validateProviderMutation, validateProviderRecovery, validateProviderCleanup, MAX_PROVIDER_CLEANUPS } from '../shared/validation.js';
import { PROVIDER_CAPABILITIES, providerTypeSupportsCapability } from '../shared/constants.js';
import { ProviderCredentialCoordinator } from './provider-credential-coordinator.js';

function entityCacheKey(network, target) {
  return `v1|entity|${network}|${target.canonical}`;
}

function entityTtl(kind) {
  if (['inscription', 'transaction', 'output'].includes(kind)) return 30 * 24 * 60 * 60 * 1_000;
  if (kind === 'block') return 24 * 60 * 60 * 1_000;
  return 5 * 60 * 1_000;
}

function isProviderHealthFailure(error) {
  if (['PROVIDER_NETWORK_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_AUTH_ERROR', 'PROVIDER_COOKIE_ACCESS_DENIED', 'INVALID_PROVIDER_RESPONSE'].includes(error?.code)) return true;
  return Number(error?.status) >= 500 || Number(error?.status) === 429;
}

function legacyDisableConfiguration(candidate, previous, instance) {
  if (!previous || previous.enabled !== true || candidate.enabled !== false) return false;
  const persisted = validateProviderConfig(previous);
  const requestedEnabled = { ...candidate, enabled: true };
  if (JSON.stringify(requestedEnabled) === JSON.stringify({ ...persisted, enabled: true })) {
    return { ...persisted, enabled: false };
  }
  if (persisted.type !== 'ord-server' || !persisted.capabilities.includes('output') || persisted.capabilities.includes('satpoint')) return false;
  const migrated = { ...persisted, capabilities: [...persisted.capabilities, 'satpoint'] };
  if (!instance || JSON.stringify(validateProviderConfig(instance.config)) !== JSON.stringify(migrated)) return false;
  return JSON.stringify(requestedEnabled) === JSON.stringify({ ...migrated, enabled: true })
    ? { ...persisted, enabled: false }
    : false;
}

function successfulHealth(previous, fields) {
  return { ...(previous ?? {}), ...fields, ok: true, error: null };
}

const RECOVERABLE_CREDENTIAL_ERRORS = new Set([
  'PROVIDER_CREDENTIAL_RECOVERY_REQUIRED', 'PROVIDER_CREDENTIAL_STATE_INVALID',
  'PROVIDER_CREDENTIAL_BINDING_MISMATCH', 'PROVIDER_LEGACY_CREDENTIAL_RECOVERY_REQUIRED',
  'SECURE_STORAGE_ROLLBACK_FAILED'
]);

function staleRecovery() {
  return new AppError('PROVIDER_RECOVERY_STALE', 'This source or its recovery state changed. Close recovery and review the current source again.', { status: 409 });
}

function staleCleanup() {
  return new AppError('PROVIDER_CLEANUP_STALE', 'This source or its cleanup state changed. Review it again before cleanup.', { status: 409 });
}

function cleanupRequired() {
  return new AppError('PROVIDER_CLEANUP_REQUIRED', 'Review and finish the pending removed-source cleanup before reusing its identifier.', { status: 409 });
}

function committedProviderError(error, providerId, operation) {
  const normalized = serializeError(error);
  return new AppError(normalized.code, normalized.message, {
    status: normalized.status,
    retryable: normalized.retryable,
    cause: error,
    details: {
      ...(normalized.details && typeof normalized.details === 'object' && !Array.isArray(normalized.details) ? normalized.details : {}),
      providerMutationCommitted: true,
      providerId,
      ...(operation === 'remove' ? { id: providerId, providerRemoved: true } : {})
    }
  });
}

function selectedNetwork(settings, options = {}) {
  if (options.network !== undefined && options.network !== settings.network) {
    throw new AppError('NETWORK_MISMATCH', `Provider routing is restricted to the selected ${settings.network} network`, { status: 400 });
  }
  return settings.network;
}

function routingFingerprint(stateStore) {
  const settings = stateStore.get(['settings']);
  return JSON.stringify({
    settings: {
      network: settings.network,
      localOnly: settings.localOnly,
      offlineMode: settings.offlineMode,
      preferredProviderId: settings.preferredProviderId,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxResourceBytes: settings.maxResourceBytes
    },
    providers: stateStore.get(['providers']) ?? []
  });
}

export class ProviderManager {
  constructor(stateStore, secureStore, logger, cache = null) {
    this.stateStore = stateStore;
    this.secureStore = secureStore;
    this.credentials = new ProviderCredentialCoordinator(secureStore, stateStore);
    this.logger = logger;
    this.cache = cache;
    this.instances = new Map();
    this.healthState = new Map();
    this.routingGeneration = 0;
    this.activeOperations = new Set();
    this.pendingWork = new Set();
    this.blockedProviders = new Set();
    this.blockedProviderErrors = new Map();
    this.providerMutations = new Set();
    this.recoveryIntents = new Map();
    this.cleanupIntents = new Map();
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.refresh();
  }

  invalidateRouting() {
    this.routingGeneration += 1;
    const reason = new AppError('ROUTING_INVALIDATED', 'Provider routing changed while the request was active', { status: 409, retryable: true });
    for (const controller of this.activeOperations) controller.abort(reason);
  }

  captureRouting() {
    this.assertRunning();
    if (this.refreshPending) this.refresh();
    return Object.freeze({ revision: this.routingGeneration, fingerprint: routingFingerprint(this.stateStore) });
  }

  assertRouting(snapshot) {
    this.assertRunning();
    if (!snapshot || snapshot.revision !== this.routingGeneration || snapshot.fingerprint !== routingFingerprint(this.stateStore)) {
      throw new AppError('ROUTING_INVALIDATED', 'Provider routing changed while the request was active', { status: 409, retryable: true });
    }
  }

  beginOperation(callerSignal) {
    const routing = this.captureRouting();
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    this.activeOperations.add(controller);
    return {
      controller,
      routing,
      signal,
      finishWork: this.trackWork()
    };
  }

  assertOperationCurrent(operation) {
    if (operation.signal.aborted) {
      throw operation.signal.reason ?? new AppError('ROUTING_INVALIDATED', 'Provider routing changed while the request was active', { status: 409, retryable: true });
    }
    this.assertRouting(operation.routing);
  }

  finishOperation(operation) {
    this.activeOperations.delete(operation.controller);
    operation.finishWork();
  }

  trackWork() {
    let complete;
    const completion = new Promise((resolve) => { complete = resolve; });
    this.pendingWork.add(completion);
    return () => {
      this.pendingWork.delete(completion);
      complete();
    };
  }

  assertRunning() {
    if (this.shuttingDown) throw new AppError('APP_SHUTTING_DOWN', 'The application is shutting down', { status: 503 });
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    // Publish the stable drain before abort listeners can re-enter shutdown.
    // These promises track completion, not request success: callers still own
    // operation errors, including the expected routing invalidation on quit.
    this.shutdownPromise = Promise.all([...this.pendingWork]).then(() => {});
    this.invalidateRouting();
    return this.shutdownPromise;
  }

  refresh() {
    this.refreshPending = true;
    this.invalidateRouting();
    const previousInstances = new Map(this.instances);
    const instances = new Map();
    for (const config of this.stateStore.get(['providers']) ?? []) {
      try {
        const dependencies = { secureStore: this.credentials.scopedStore(config), logger: this.logger };
        const instance = config.type === 'ord-server'
          ? new OrdServerProvider(config, dependencies)
          : config.type === 'mempool'
            ? new MempoolProvider(config, dependencies)
            : config.type === 'bitcoin-core'
              ? new BitcoinCoreProvider(config, dependencies)
              : new MockProvider(config, dependencies);
        instances.set(config.id, instance);
      } catch (error) {
        this.logger?.warn('provider.instantiate_failed', { providerId: config.id, message: error.message });
      }
    }
    for (const [id, health] of this.healthState) {
      const previous = previousInstances.get(id);
      const current = instances.get(id);
      if (!previous || !current || JSON.stringify(previous.config) !== JSON.stringify(current.config)) {
        this.healthState.delete(id);
      } else {
        this.healthState.set(id, health);
      }
    }
    this.instances = instances;
    this.refreshPending = false;
  }

  list() {
    if (this.refreshPending) this.refresh();
    return [...this.instances.values()].map((provider) => {
      const blockedError = this.blockedProviderErrors.get(provider.id);
      const descriptor = provider.descriptor(this.healthState.get(provider.id) ?? null);
      const credentialError = this.credentials.error(provider.config);
      if (!this.blockedProviders.has(provider.id) && !credentialError) {
        this.recoveryIntents.delete(provider.id);
        return descriptor;
      }
      const error = blockedError ?? serializeError(credentialError ?? new AppError('PROVIDER_BUSY', 'Provider configuration is being updated', { status: 409, retryable: true }));
      const credentialRecovery = this.recoveryFor(provider.id, error);
      return { ...descriptor, routingBlocked: true, routingError: error, health: { ok: false, error }, ...(credentialRecovery ? { credentialRecovery } : {}) };
    });
  }

  recoveryFingerprint(provider, error) {
    return JSON.stringify({ provider, code: error.code, revision: this.credentials.recoveryRevision(provider.id),
      lineage: Boolean(this.stateStore.legacyCredentialRecoveryRequired) });
  }

  recoveryFor(id, error) {
    if (this.shuttingDown || this.providerMutations.has(id) || !RECOVERABLE_CREDENTIAL_ERRORS.has(error?.code)) return null;
    const configured = (this.stateStore.get(['providers']) ?? []).find((item) => item.id === id);
    if (!configured) return null;
    const provider = validateProviderConfig(configured);
    const fingerprint = this.recoveryFingerprint(provider, error);
    let intent = this.recoveryIntents.get(id);
    if (!intent || intent.fingerprint !== fingerprint) {
      intent = { token: crypto.randomUUID(), fingerprint, mode: this.credentials.recoveryMode(provider) };
      this.recoveryIntents.set(id, intent);
    }
    return { token: intent.token, mode: intent.mode };
  }

  cleanupRecords() {
    return this.stateStore.getProviderCleanups?.() ?? [];
  }

  assertNoPendingCleanup(id) {
    if (this.cleanupRecords().some(item => item.id === id)) throw cleanupRequired();
  }

  assertCleanupStorageReadable() {
    if (!['primary', 'missing'].includes(this.secureStore.loadStatus)) {
      throw new AppError('SECURE_STORAGE_STATE_UNAVAILABLE', 'Retained sign-in storage could not be read safely. Cleanup is unavailable; no deletion was authorized.', { status: 503 });
    }
  }

  cleanupFingerprint(id, generation) {
    this.assertCleanupStorageReadable();
    return JSON.stringify({ id, generation, revision: this.credentials.recoveryRevision(id),
      retained: this.credentials.hasSecrets(id) || this.credentials.hasStoredState(id),
      lineage: Boolean(this.stateStore.legacyCredentialRecoveryRequired), loadStatus: this.secureStore.loadStatus });
  }

  cleanupReview(id, generation) {
    const conflict = (this.stateStore.get(['providers']) ?? []).some(provider => provider.id === id);
    if (conflict || this.shuttingDown || this.providerMutations.has(id)) {
      this.cleanupIntents.delete(id);
      return { id, generation, token: null, conflict, message: conflict
        ? 'This identifier is configured again. Cleanup will not delete a configured source. Review the source first.'
        : 'A source change is still in progress. Refresh source state when it finishes.' };
    }
    const fingerprint = this.cleanupFingerprint(id, generation);
    let intent = this.cleanupIntents.get(id);
    if (!intent || intent.fingerprint !== fingerprint) {
      intent = { token: crypto.randomUUID(), fingerprint, generation };
      this.cleanupIntents.delete(id);
      if (this.cleanupIntents.size >= MAX_PROVIDER_CLEANUPS) this.cleanupIntents.delete(this.cleanupIntents.keys().next().value);
      this.cleanupIntents.set(id, intent);
    }
    return { id, generation, token: intent.token, conflict: false, message: generation
      ? 'This removed source has unfinished sign-in storage cleanup. Review the exact ID before deleting retained storage.'
      : 'Retained sign-in storage exists for this exact ID. This does not establish a previous removal.' };
  }

  cleanupList() {
    this.assertCleanupStorageReadable();
    return this.cleanupRecords().map(record => this.cleanupReview(record.id, record.generation));
  }

  reviewCleanup(input) {
    this.assertRunning();
    const { id } = validateProviderCleanup(typeof input === 'string' ? { id: input } : input, { review: true });
    this.assertCleanupStorageReadable();
    if ((this.stateStore.get(['providers']) ?? []).some(provider => provider.id === id)) throw staleCleanup();
    const record = this.cleanupRecords().find(item => item.id === id);
    if (!record && !this.credentials.hasSecrets(id) && !this.credentials.hasStoredState(id)) {
      throw new AppError('PROVIDER_CLEANUP_NOT_REQUIRED', 'No retained sign-in storage or pending cleanup was found for this exact ID.', { status: 409 });
    }
    return this.cleanupReview(id, record?.generation ?? null);
  }

  async cleanup(input) {
    this.assertRunning();
    const { id, token } = validateProviderCleanup(input);
    if (this.providerMutations.has(id)) throw new AppError('PROVIDER_BUSY', 'Provider configuration is already being updated', { status: 409, retryable: true, details: { id } });
    this.assertCleanupStorageReadable();
    const generation = this.cleanupRecords().find(item => item.id === id)?.generation ?? null;
    const intent = this.cleanupIntents.get(id);
    if ((this.stateStore.get(['providers']) ?? []).some(provider => provider.id === id)
      || !intent || token !== intent.token || intent.fingerprint !== this.cleanupFingerprint(id, generation)) throw staleCleanup();
    const finishWork = this.trackWork();
    this.cleanupIntents.delete(id);
    this.recoveryIntents.delete(id);
    this.providerMutations.add(id);
    this.blockedProviders.add(id);
    this.invalidateRouting();
    const record = { id, generation: generation ?? crypto.randomUUID() };
    let committed = false;
    let succeeded = false;
    try {
      // Reserve absence durably before entering the secure-store queue. Never
      // await secure work inside a StateStore mutator: lock order is secure → state.
      await this.stateStore.beginProviderCleanup(record, generation);
      committed = true;
      await this.credentials.remove(id, () => this.stateStore.beginProviderCleanup(record, record.generation));
      await this.stateStore.completeProviderCleanup(id, record.generation);
      succeeded = true;
      this.refresh();
    } catch (error) {
      if (!committed) throw error;
      throw new AppError('PROVIDER_CREDENTIAL_CLEANUP_FAILED', 'Cleanup state was saved, but retained sign-in storage cleanup could not be confirmed. Review its current state before another attempt.', {
        status: 500, retryable: true, cause: error,
        details: { id, providerMutationCommitted: true, providerId: id, cleanupCompleted: false }
      });
    } finally {
      this.providerMutations.delete(id);
      if (succeeded) {
        this.blockedProviders.delete(id);
        this.blockedProviderErrors.delete(id);
      }
      finishWork();
    }
  }

  candidates(capability, options = {}) {
    this.assertRunning();
    if (this.refreshPending) this.refresh();
    const settings = this.stateStore.get(['settings']);
    const network = selectedNetwork(settings, options);
    const preferred = options.preferredProviderId ?? settings.preferredProviderId;
    const localOnly = settings.localOnly || options.localOnly === true;
    const candidates = [...this.instances.values()].filter((provider) => {
      if (this.blockedProviders.has(provider.id) || this.credentials.error(provider.config)) return false;
      if (!provider.config.enabled || provider.network !== network) return false;
      if (options.providerType !== undefined && provider.type !== options.providerType) return false;
      if (localOnly && !provider.config.local) return false;
      if (!capability) return true;
      if (capability === 'transaction') {
        return (providerTypeSupportsCapability(provider.type, 'transaction') && provider.supports('transaction'))
          || (providerTypeSupportsCapability(provider.type, 'transaction-raw') && provider.supports('transaction-raw'));
      }
      return providerTypeSupportsCapability(provider.type, capability) && provider.supports(capability);
    });
    candidates.sort((a, b) => {
      if (a.id === preferred) return -1;
      if (b.id === preferred) return 1;
      const aHealth = this.healthState.get(a.id);
      const bHealth = this.healthState.get(b.id);
      if (aHealth?.ok && !bHealth?.ok) return -1;
      if (!aHealth?.ok && bHealth?.ok) return 1;
      return a.config.priority - b.config.priority;
    });
    return candidates;
  }

  async resolve(target, options = {}) {
    this.assertRunning();
    const settings = this.stateStore.get(['settings']);
    const network = selectedNetwork(settings, options);
    const cacheKey = entityCacheKey(network, target);
    const operation = this.beginOperation(options.signal);
    try {
      this.assertOperationCurrent(operation);
      if (settings.offlineMode && this.cache) {
        const cached = await this.cache.get(cacheKey, { allowStale: true });
        this.assertOperationCurrent(operation);
        if (cached) {
          let entity;
          try {
            entity = JSON.parse(cached.data.toString('utf8'));
          } catch {
            await this.cache.delete(cacheKey);
            this.assertOperationCurrent(operation);
          }
          if (entity !== undefined) {
            this.assertOperationCurrent(operation);
            return { entity, attempts: [], cache: cached.stale ? 'stale' : 'hit',
              cacheSource: { local: cached.meta?.providerLocal === true, type: cached.meta?.providerType ?? null } };
          }
        }
      }
      this.assertOperationCurrent(operation);
      if (settings.offlineMode) throw new AppError('OFFLINE_CACHE_MISS', 'Entity data is unavailable while offline', { status: 503 });
      const capability = targetCapability(target);
      if (!capability) throw new AppError('UNSUPPORTED_TARGET', `No provider capability maps to ${target.kind}`, { status: 422 });
      const candidates = this.candidates(capability, options);
      if (candidates.length === 0) {
        throw new AppError('NO_PROVIDER', `No enabled ${settings.localOnly ? 'local ' : ''}provider supports ${capability} on ${settings.network}`, { status: 503 });
      }
      const attempts = [];
      for (const provider of candidates) {
        this.assertOperationCurrent(operation);
        const started = performance.now();
        try {
          const entity = await provider.resolve(target, {
            timeoutMs: options.timeoutMs ?? settings.requestTimeoutMs,
            maxBytes: options.maxBytes ?? settings.maxResourceBytes,
            signal: operation.signal
          });
          this.assertOperationCurrent(operation);
          const latencyMs = Math.round(performance.now() - started);
          if (this.cache) {
            await this.cache.put(cacheKey, Buffer.from(JSON.stringify(entity)), {
              kind: 'entity',
              canonical: target.canonical,
              providerId: provider.id,
              providerLocal: provider.config?.local === true,
              providerType: provider.type
            }, entityTtl(target.kind), { validate: () => this.assertOperationCurrent(operation) });
            this.assertOperationCurrent(operation);
          }
          this.assertOperationCurrent(operation);
          this.healthState.set(provider.id, successfulHealth(this.healthState.get(provider.id), { latencyMs, lastSuccessAt: new Date().toISOString() }));
          attempts.push({ providerId: provider.id, ok: true, latencyMs });
          return { entity, attempts };
        } catch (error) {
          this.assertOperationCurrent(operation);
          const serialized = serializeError(error);
          attempts.push({ providerId: provider.id, ok: false, error: serialized });
          if (isProviderHealthFailure(error)) {
            this.healthState.set(provider.id, { ...(this.healthState.get(provider.id) ?? {}), ok: false, error: serialized, lastFailureAt: new Date().toISOString() });
          }
          await this.logger?.warn('provider.resolve_failed', { providerId: provider.id, target: target.canonical, error: serialized });
          this.assertOperationCurrent(operation);
          if (error.code === 'INVALID_TARGET' || error.code === 'RESOURCE_TOO_LARGE') throw error;
        }
      }
      this.assertOperationCurrent(operation);
      throw new AppError('ALL_PROVIDERS_FAILED', 'Every eligible provider failed to resolve the target', { status: 503, retryable: true, details: { attempts } });
    } finally {
      this.finishOperation(operation);
    }
  }

  async fetchOrdPath(path, options = {}) {
    this.assertRunning();
    const settings = this.stateStore.get(['settings']);
    selectedNetwork(settings, options);
    if (settings.offlineMode) throw new AppError('OFFLINE_CACHE_MISS', 'This recursive resource is not cached', { status: 503 });
    const candidates = this.candidates('ord-recursion', options);
    if (candidates.length === 0) throw new AppError('NO_ORD_PROVIDER', 'No enabled ord recursion provider is available', { status: 503 });
    const operation = this.beginOperation(options.signal);
    const attempts = [];
    try {
      for (const provider of candidates) {
        this.assertOperationCurrent(operation);
        const started = performance.now();
        try {
          const response = await provider.fetchPath(path, {
            accept: options.accept,
            range: options.range,
            timeoutMs: options.timeoutMs ?? settings.requestTimeoutMs,
            maxBytes: options.maxBytes ?? settings.maxResourceBytes,
            signal: operation.signal
          });
          this.assertOperationCurrent(operation);
          const latencyMs = Math.round(performance.now() - started);
          this.healthState.set(provider.id, successfulHealth(this.healthState.get(provider.id), { latencyMs, lastSuccessAt: new Date().toISOString() }));
          return { response, provider, attempts: [...attempts, { providerId: provider.id, ok: true, latencyMs }] };
        } catch (error) {
          this.assertOperationCurrent(operation);
          const serialized = serializeError(error);
          attempts.push({ providerId: provider.id, ok: false, error: serialized });
          if (isProviderHealthFailure(error)) {
            this.healthState.set(provider.id, { ...(this.healthState.get(provider.id) ?? {}), ok: false, error: serialized, lastFailureAt: new Date().toISOString() });
          }
          if (error.code === 'RESOURCE_TOO_LARGE') throw error;
        }
      }
      throw new AppError('ALL_PROVIDERS_FAILED', 'Every ord provider failed to serve the recursive resource', { status: 503, retryable: true, details: { attempts } });
    } finally {
      this.finishOperation(operation);
    }
  }

  async healthAll(options = {}) {
    this.assertRunning();
    const settings = this.stateStore.get(['settings']);
    if (settings.offlineMode) return [];
    const providers = this.candidates(null);
    const operation = this.beginOperation(options.signal);
    try {
      const results = await Promise.allSettled(providers.map(async (provider) => {
        const started = performance.now();
        try {
          const health = await provider.health({ timeoutMs: options.timeoutMs ?? 5_000, signal: operation.signal });
          this.assertOperationCurrent(operation);
          const result = { ...health, providerId: provider.id, ok: Boolean(health.ok), latencyMs: health.latencyMs ?? Math.round(performance.now() - started) };
          this.healthState.set(provider.id, result);
          return result;
        } catch (error) {
          this.assertOperationCurrent(operation);
          const result = { providerId: provider.id, ok: false, latencyMs: Math.round(performance.now() - started), error: serializeError(error), checkedAt: new Date().toISOString() };
          this.healthState.set(provider.id, result);
          return result;
        }
      }));
      // A rejected sibling must not release the aggregate's ownership while
      // another provider is still completing its aborted transport or work.
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      return results.map((result) => result.value);
    } finally {
      this.finishOperation(operation);
    }
  }

  async upsert(input) {
    this.assertRunning();
    const submitted = input.provider ?? input;
    let provider;
    try {
      provider = validateProviderMutation(submitted);
    } catch (error) {
      const candidate = validateProviderConfig(submitted);
      const previous = (this.stateStore.get(['providers']) ?? []).find((item) => item.id === candidate.id);
      const credentials = input.credentials;
      const hasCredentialMutation = credentials !== undefined
        && (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials) || Object.keys(credentials).length > 0);
      const rawCapabilitiesAreKnown = Array.isArray(submitted?.capabilities)
        && submitted.capabilities.every((capability) => typeof capability === 'string' && PROVIDER_CAPABILITIES.includes(capability));
      const safeDisable = rawCapabilitiesAreKnown
        ? legacyDisableConfiguration(candidate, previous, this.instances.get(candidate.id))
        : false;
      if (error?.code !== 'VALIDATION_ERROR' || error?.details?.field !== 'provider.capabilities'
        || hasCredentialMutation || !safeDisable) throw error;
      provider = safeDisable;
    }
    if (this.providerMutations.has(provider.id)) {
      throw new AppError('PROVIDER_BUSY', 'Provider configuration is already being updated', { status: 409, retryable: true, details: { id: provider.id } });
    }
    this.assertNoPendingCleanup(provider.id);
    const credentials = input.credentials ?? {};
    const previousProvider = (this.stateStore.get(['providers']) ?? []).find((item) => item.id === provider.id) ?? null;
    const finishWork = this.trackWork();
    const priorBlocked = this.blockedProviders.has(provider.id);
    const priorBlockedError = this.blockedProviderErrors.get(provider.id);
    this.recoveryIntents.delete(provider.id);
    this.providerMutations.add(provider.id);
    this.blockedProviders.add(provider.id);
    this.invalidateRouting();
    let keepBlocked = false;
    let stateCommitted = false;
    let succeeded = false;
    const persist = async () => {
      const result = await this.stateStore.upsertProvider(provider);
      stateCommitted = true;
      this.refreshPending = true;
      return result;
    };
    try {
      await this.credentials.upsert(provider, credentials, persist, previousProvider);
      this.refresh();
      this.blockedProviderErrors.delete(provider.id);
      succeeded = true;
      return this.instances.get(provider.id).descriptor(this.healthState.get(provider.id) ?? null);
    } catch (error) {
      keepBlocked = error?.code === 'SECURE_STORAGE_ROLLBACK_FAILED';
      if (keepBlocked) this.blockedProviderErrors.set(provider.id, serializeError(error));
      else if (priorBlockedError) this.blockedProviderErrors.set(provider.id, priorBlockedError);
      throw stateCommitted ? committedProviderError(error, provider.id, 'upsert') : error;
    } finally {
      this.providerMutations.delete(provider.id);
      if (succeeded || (!keepBlocked && !priorBlocked)) {
        this.blockedProviders.delete(provider.id);
        this.blockedProviderErrors.delete(provider.id);
      }
      finishWork();
    }
  }

  async recover(input) {
    this.assertRunning();
    const request = validateProviderRecovery(input);
    const { id } = request;
    if (this.providerMutations.has(id)) throw new AppError('PROVIDER_BUSY', 'Provider configuration is already being updated', { status: 409, retryable: true, details: { id } });
    const configured = (this.stateStore.get(['providers']) ?? []).find((item) => item.id === id);
    if (!configured) throw staleRecovery();
    const provider = validateProviderConfig(configured);
    const error = this.blockedProviderErrors.get(id) ?? this.credentials.error(provider);
    if (!RECOVERABLE_CREDENTIAL_ERRORS.has(error?.code)) {
      throw new AppError('PROVIDER_RECOVERY_NOT_REQUIRED', 'This source no longer needs credential recovery. Refresh source state.', { status: 409 });
    }
    if (request.mode !== 'clear-stored' && request.mode !== this.credentials.recoveryMode(provider)) throw new AppError('VALIDATION_ERROR', 'Recovery mode does not match this source authentication', { status: 400 });
    const intent = this.recoveryIntents.get(id);
    if (!intent || request.token !== intent.token || intent.fingerprint !== this.recoveryFingerprint(provider, error)) throw staleRecovery();
    const expectedConfiguration = JSON.stringify(provider);
    const priorBlocked = this.blockedProviders.has(id);
    const priorBlockedError = this.blockedProviderErrors.get(id);
    const finishWork = this.trackWork();
    this.recoveryIntents.delete(id);
    this.providerMutations.add(id);
    this.blockedProviders.add(id);
    this.invalidateRouting();
    let committed = false;
    let succeeded = false;
    let keepBlocked = false;
    try {
      await this.credentials.recover(provider, request, async () => {
        await this.stateStore.mutate((draft) => {
          const current = draft.providers.find((item) => item.id === id);
          if (!current || JSON.stringify(validateProviderConfig(current)) !== expectedConfiguration) throw staleRecovery();
          // Retain the authoritative persisted source; a runtime descriptor can
          // contain legacy capability migration or health/recovery decoration.
        });
        committed = true;
        this.refreshPending = true;
      });
      succeeded = true;
      this.blockedProviderErrors.delete(id);
      this.healthState.delete(id);
      this.refresh();
    } catch (failure) {
      keepBlocked = failure?.code === 'SECURE_STORAGE_ROLLBACK_FAILED';
      if (keepBlocked) this.blockedProviderErrors.set(id, serializeError(failure));
      else if (!succeeded && priorBlockedError) this.blockedProviderErrors.set(id, priorBlockedError);
      throw committed ? committedProviderError(failure, id, 'recover') : failure;
    } finally {
      this.providerMutations.delete(id);
      if (succeeded || (!keepBlocked && !priorBlocked)) {
        this.blockedProviders.delete(id);
        this.blockedProviderErrors.delete(id);
      }
      finishWork();
    }
  }

  async remove(id) {
    this.assertRunning();
    ({ id } = validateProviderCleanup({ id }, { review: true }));
    if (this.providerMutations.has(id)) {
      throw new AppError('PROVIDER_BUSY', 'Provider configuration is already being updated', { status: 409, retryable: true, details: { id } });
    }
    this.assertCleanupStorageReadable();
    const configured = (this.stateStore.get(['providers']) ?? []).find(provider => provider.id === id);
    const pending = this.cleanupRecords().find(record => record.id === id);
    const retained = this.credentials.hasSecrets(id) || this.credentials.hasStoredState(id);
    // Absence is never authority to remove a configuration that might be queued
    // for insertion. Only the dedicated reviewed cleanup action may retry.
    if (!configured) {
      if (pending || retained) throw cleanupRequired();
      return;
    }
    const record = pending || retained ? { id, generation: crypto.randomUUID() } : null;
    const finishWork = this.trackWork();
    const priorBlocked = this.blockedProviders.has(id);
    const priorBlockedError = this.blockedProviderErrors.get(id);
    this.recoveryIntents.delete(id);
    this.cleanupIntents.delete(id);
    this.providerMutations.add(id);
    this.blockedProviders.add(id);
    this.invalidateRouting();
    let stateCommitted = false;
    let succeeded = false;
    try {
      try {
        await this.credentials.remove(id, async () => {
          await this.stateStore.removeProvider(id, record, configured);
          stateCommitted = true;
          this.refreshPending = true;
        });
        if (record) await this.stateStore.completeProviderCleanup(id, record.generation);
      } catch (error) {
        if (!stateCommitted) throw error;
        throw new AppError('PROVIDER_CREDENTIAL_CLEANUP_FAILED', 'Provider was removed, but its stored credentials could not be deleted', {
          status: 500,
          retryable: true,
          details: { id, providerRemoved: true },
          cause: error
        });
      }
      this.refresh();
      succeeded = true;
    } catch (error) {
      if (error?.code === 'PROVIDER_CREDENTIAL_CLEANUP_FAILED' && error.details?.providerRemoved === true) throw error;
      throw stateCommitted ? committedProviderError(error, id, 'remove') : error;
    } finally {
      this.providerMutations.delete(id);
      if (succeeded || (!priorBlocked && stateCommitted === false)) {
        this.blockedProviders.delete(id);
        this.blockedProviderErrors.delete(id);
      }
      else if (priorBlocked && !stateCommitted) {
        this.blockedProviders.add(id);
        if (priorBlockedError) this.blockedProviderErrors.set(id, priorBlockedError);
      }
      finishWork();
    }
  }
}
