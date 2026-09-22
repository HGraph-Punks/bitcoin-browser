import crypto from 'node:crypto';
import { AppError } from '../shared/errors.js';

const stateKey = (id) => `provider-credential-state:${id}`;
const secretKeys = (id) => [`provider:${id}:username`, `provider:${id}:password`];

function binding(provider) {
  return crypto.createHash('sha256').update(JSON.stringify({
    type: provider.type,
    network: provider.network,
    baseUrl: provider.baseUrl ?? '',
    cookieFile: provider.cookieFile ?? '',
    authentication: provider.cookieFile ? 'cookie' : 'basic'
  })).digest('hex');
}

function recoveryError(code, message, id) {
  return new AppError(code, message, { status: 409, retryable: false, details: { id, credentialRecoveryRequired: true } });
}

export class ProviderCredentialCoordinator {
  constructor(secureStore, stateStore) { this.store = secureStore; this.stateStore = stateStore; }

  async #set(key, value) {
    if (typeof this.store.set === 'function') return this.store.set(key, value);
    return this.store.transaction({ [key]: value }, async () => {});
  }

  async #delete(key) {
    if (typeof this.store.delete === 'function') return this.store.delete(key);
    return this.store.transaction({ [key]: null }, async () => {});
  }

  #state(id) {
    const key = stateKey(id);
    const encoded = this.store.has?.(key);
    const value = this.store.get?.(key);
    if (encoded && !value) return { invalid: true };
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed?.version === 1 && ['active', 'pending', 'tombstone'].includes(parsed.status) && typeof parsed.binding === 'string' ? parsed : { invalid: true };
    } catch { return { invalid: true }; }
  }

  hasSecrets(id) { return secretKeys(id).some((key) => this.store.has?.(key) ?? Boolean(this.store.get?.(key))); }

  hasStoredState(id) { return this.store.has?.(stateKey(id)) ?? Boolean(this.store.get?.(stateKey(id))); }

  recoveryRevision(id) { return this.store.revisionFor?.([...secretKeys(id), stateKey(id)]) ?? null; }

  recoveryMode(provider) { return provider.type === 'bitcoin-core' && !provider.cookieFile ? 'replace-basic' : 'clear-stored'; }

  error(provider) {
    let cleanups;
    try { cleanups = this.stateStore?.getProviderCleanups?.() ?? []; }
    catch (error) { return error; }
    if (cleanups.some(item => item.id === provider.id)) {
      return recoveryError('PROVIDER_CLEANUP_CONFLICT', 'A pending removal record conflicts with this configured source. Review the source; cleanup will not delete a configured source.', provider.id);
    }
    const state = this.#state(provider.id);
    if (!state) {
      if (this.hasSecrets(provider.id) && (this.stateStore?.legacyCredentialRecoveryRequired || this.stateStore?.recoveryStatus?.source !== 'primary')) {
        return recoveryError('PROVIDER_LEGACY_CREDENTIAL_RECOVERY_REQUIRED', 'Unbound legacy credentials cannot be used after state recovery', provider.id);
      }
      return null; // Normal-primary legacy migration awaits the separately approved product policy.
    }
    if (state.invalid) return recoveryError('PROVIDER_CREDENTIAL_STATE_INVALID', 'Provider credential recovery metadata is unavailable', provider.id);
    if (state.status !== 'active') return recoveryError('PROVIDER_CREDENTIAL_RECOVERY_REQUIRED', 'Provider credentials require explicit recovery before use', provider.id);
    if (state.binding !== binding(provider)) return recoveryError('PROVIDER_CREDENTIAL_BINDING_MISMATCH', 'Stored credentials are bound to a different provider destination', provider.id);
    return null;
  }

  scopedStore(provider) {
    return {
      has: (key) => Boolean(this.store.has?.(key)),
      get: (key) => this.error(provider) ? null : this.store.get?.(key)
    };
  }

  async upsert(provider, credentials, persist, previousProvider = null) {
    const currentError = this.error(provider);
    if (['PROVIDER_CREDENTIAL_RECOVERY_REQUIRED', 'PROVIDER_CREDENTIAL_STATE_INVALID', 'PROVIDER_CLEANUP_CONFLICT', 'PROVIDER_CLEANUP_STATE_INVALID'].includes(currentError?.code)) throw currentError;
    const [usernameKey, passwordKey] = secretKeys(provider.id);
    const username = credentials.username !== undefined && credentials.username !== '' ? String(credentials.username) : null;
    const password = credentials.password !== undefined && credentials.password !== '' ? String(credentials.password) : null;
    const existingState = this.#state(provider.id);
    const hasStoredSecrets = this.hasSecrets(provider.id);
    const changedBinding = existingState?.status === 'active' && existingState.binding !== binding(provider);
    const legacyBindingChanged = !existingState && this.hasSecrets(provider.id) && previousProvider && binding(previousProvider) !== binding(provider);
    const switchToCookie = provider.type === 'bitcoin-core' && Boolean(provider.cookieFile) && this.hasSecrets(provider.id);
    if (changedBinding && hasStoredSecrets && !switchToCookie && (!username || !password)) throw recoveryError('PROVIDER_CREDENTIAL_REENTRY_REQUIRED', 'Changing this provider destination requires re-entering both credentials', provider.id);
    if (legacyBindingChanged && !switchToCookie && (!username || !password)) throw recoveryError('PROVIDER_CREDENTIAL_REENTRY_REQUIRED', 'Changing this legacy provider destination requires re-entering both credentials', provider.id);
    const hasMutation = username !== null || password !== null || switchToCookie;
    if (!hasMutation && !hasStoredSecrets && !existingState) return persist();
    // A recovered source with no stored pair still has binding metadata. Keep
    // the pending/active transaction below when editing it, without inventing
    // Basic credentials for public, cookie, or explicitly unauthenticated use.
    if (!hasMutation && changedBinding && hasStoredSecrets) throw recoveryError('PROVIDER_CREDENTIAL_REENTRY_REQUIRED', 'Changing this provider destination requires re-entering credentials', provider.id);
    const legacyWithoutReplacement = !switchToCookie && !existingState && this.hasSecrets(provider.id) && (!username || !password);
    if (legacyWithoutReplacement) {
      const updates = { ...(username !== null ? { [usernameKey]: username } : {}), ...(password !== null ? { [passwordKey]: password } : {}) };
      return Object.keys(updates).length ? this.store.transaction(updates, persist) : persist();
    }
    const pending = JSON.stringify({ version: 1, status: 'pending', binding: binding(provider) });
    const updates = {
      ...(changedBinding ? { [usernameKey]: null, [passwordKey]: null } : {}),
      ...(!switchToCookie && username !== null ? { [usernameKey]: username } : {}),
      ...(!switchToCookie && password !== null ? { [passwordKey]: password } : {}),
      ...(switchToCookie ? { [usernameKey]: null, [passwordKey]: null } : {}),
      [stateKey(provider.id)]: pending
    };
    const result = await this.store.transaction(updates, persist);
    await this.#set(stateKey(provider.id), JSON.stringify({ version: 1, status: 'active', binding: binding(provider) }));
    return result;
  }

  async recover(provider, request, persist) {
    const [usernameKey, passwordKey] = secretKeys(provider.id);
    // Never reuse either old field, even for pending/invalid/tombstone state.
    const replacement = request.mode === 'replace-basic' ? request.credentials : null;
    const pending = JSON.stringify({ version: 1, status: 'pending', binding: binding(provider) });
    const result = await this.store.transaction({
      [usernameKey]: replacement?.username ?? null,
      [passwordKey]: replacement?.password ?? null,
      [stateKey(provider.id)]: pending
    }, persist);
    await this.#set(stateKey(provider.id), JSON.stringify({ version: 1, status: 'active', binding: binding(provider) }));
    return result;
  }

  async remove(id, persist) {
    const previous = this.#state(id);
    if (!previous && !this.hasSecrets(id)) return persist();
    const tombstone = JSON.stringify({ version: 1, status: 'tombstone', binding: previous?.binding ?? 'unknown' });
    await this.store.transaction({ [stateKey(id)]: tombstone }, persist);
    await this.store.deletePrefix(`provider:${id}:`);
    await this.#delete(stateKey(id));
  }
}
