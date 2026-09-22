import { AppError } from './errors.js';
import { validateAiConfig } from './local-ai.js';
import { NETWORKS, PROVIDER_CAPABILITIES, providerCapabilitiesFor } from './constants.js';

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertRecord(value, name = 'value') {
  if (!isRecord(value)) throw new AppError('VALIDATION_ERROR', `${name} must be an object`, { status: 400 });
  return value;
}

export function assertString(value, name, options = {}) {
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', `${name} must be a string`, { status: 400 });
  const result = options.trim === false ? value : value.trim();
  if (options.min !== undefined && result.length < options.min) {
    throw new AppError('VALIDATION_ERROR', `${name} is too short`, { status: 400 });
  }
  if (options.max !== undefined && result.length > options.max) {
    throw new AppError('VALIDATION_ERROR', `${name} is too long`, { status: 400 });
  }
  if (options.pattern && !options.pattern.test(result)) {
    throw new AppError('VALIDATION_ERROR', `${name} has an invalid format`, { status: 400 });
  }
  return result;
}

export function assertBoolean(value, name) {
  if (typeof value !== 'boolean') throw new AppError('VALIDATION_ERROR', `${name} must be a boolean`, { status: 400 });
  return value;
}

export function assertInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('VALIDATION_ERROR', `${name} must be an integer from ${min} to ${max}`, { status: 400 });
  }
  return value;
}

export function assertOneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new AppError('VALIDATION_ERROR', `${name} must be one of: ${allowed.join(', ')}`, { status: 400 });
  }
  return value;
}

export function validateHttpBaseUrl(value, options = {}) {
  const raw = assertString(value, 'baseUrl', { min: 8, max: 2_048 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'baseUrl must be a valid URL', { status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError('VALIDATION_ERROR', 'baseUrl must use http or https', { status: 400 });
  }
  if (url.username || url.password) {
    throw new AppError('VALIDATION_ERROR', 'Credentials must not be embedded in baseUrl', { status: 400 });
  }
  if (!options.allowPath && url.pathname !== '/') {
    url.pathname = '/';
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
  } catch {
    return false;
  }
}

export function validateProviderConfig(value) {
  const input = assertRecord(value, 'provider');
  const type = assertOneOf(input.type, ['ord-server', 'mempool', 'bitcoin-core', 'mock'], 'provider.type');
  const config = {
    id: assertString(input.id, 'provider.id', { min: 3, max: 80, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ }),
    type,
    name: assertString(input.name, 'provider.name', { min: 1, max: 80 }),
    network: assertOneOf(input.network, NETWORKS, 'provider.network'),
    baseUrl: type === 'mock' ? '' : validateHttpBaseUrl(input.baseUrl),
    enabled: Boolean(input.enabled),
    priority: assertInteger(Number(input.priority), 'provider.priority', 0, 1_000),
    local: type === 'mock' ? true : Boolean(input.local || isLoopbackUrl(input.baseUrl)),
    capabilities: Array.isArray(input.capabilities)
      ? [...new Set(input.capabilities.filter((item) => PROVIDER_CAPABILITIES.includes(item)))]
      : [],
    cookieFile: typeof input.cookieFile === 'string' ? input.cookieFile.slice(0, 4_096) : ''
  };
  return config;
}

// Loading remains tolerant of legacy disabled or unusable entries so users can
// see and repair them. New mutations must not enable a provider that can never
// participate in routing after capability normalization.
export function validateProviderMutation(value) {
  const input = assertRecord(value, 'provider');
  if (!Array.isArray(input.capabilities)) {
    throw new AppError('VALIDATION_ERROR', 'Provider capabilities must be an array', {
      status: 400,
      details: { field: 'provider.capabilities' }
    });
  }
  const config = validateProviderConfig(value);
  const requested = input.capabilities;
  const unknown = [...new Set(requested
    .filter((capability) => typeof capability !== 'string' || !PROVIDER_CAPABILITIES.includes(capability))
    .map((capability) => typeof capability === 'string' ? capability.slice(0, 80) : `<${typeof capability}>`))];
  if (unknown.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Provider capabilities contain unknown values', {
      status: 400,
      details: { field: 'provider.capabilities', unknown: unknown.slice(0, 20) }
    });
  }
  const supported = providerCapabilitiesFor(config.type);
  const incompatible = config.capabilities.filter((capability) => !supported.includes(capability));
  if (incompatible.length > 0) {
    throw new AppError('VALIDATION_ERROR', `${config.type} does not support: ${incompatible.join(', ')}`, {
      status: 400,
      details: { field: 'provider.capabilities', type: config.type, incompatible }
    });
  }
  if (config.enabled && config.capabilities.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Enabled providers must have at least one supported capability', {
      status: 400,
      details: { field: 'provider.capabilities' }
    });
  }
  return config;
}

export function validateProviderRecovery(value) {
  const input = assertRecord(value, 'recovery');
  if (Object.keys(input).some((key) => !['id', 'token', 'mode', 'credentials'].includes(key))) {
    throw new AppError('VALIDATION_ERROR', 'Recovery accepts only the reviewed source and authentication fields', { status: 400 });
  }
  const id = assertString(input.id, 'id', { min: 3, max: 80, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ });
  const token = assertString(input.token, 'token', { trim: false, min: 36, max: 36, pattern: /^[a-f0-9-]{36}$/ });
  const mode = assertOneOf(input.mode, ['replace-basic', 'clear-stored'], 'recovery.mode');
  if (mode === 'clear-stored') {
    if (Object.hasOwn(input, 'credentials')) throw new AppError('VALIDATION_ERROR', 'Clear-stored recovery must not include replacement credentials', { status: 400 });
    return { id, token, mode };
  }
  const credentials = assertRecord(input.credentials, 'credentials');
  if (Object.keys(credentials).some((key) => !['username', 'password'].includes(key))) {
    throw new AppError('VALIDATION_ERROR', 'Recovery requires only a new username and password', { status: 400 });
  }
  const username = assertString(credentials.username, 'username', { trim: false, min: 1, max: 256 });
  const password = assertString(credentials.password, 'password', { trim: false, min: 1, max: 4096 });
  if (/[:\u0000-\u001f\u007f]/.test(username) || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new AppError('VALIDATION_ERROR', 'Sign-in fields cannot contain control characters or a colon in the username', { status: 400 });
  }
  return { id, token, mode, credentials: { username, password } };
}

export const MAX_PROVIDER_CLEANUPS = 256;

export function validateProviderCleanup(value, { review = false } = {}) {
  const input = assertRecord(value, 'cleanup');
  const allowed = review ? ['id'] : ['id', 'token'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new AppError('VALIDATION_ERROR', 'Cleanup accepts only the reviewed source identifier and token', { status: 400 });
  const id = assertString(input.id, 'id', { min: 3, max: 80, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ });
  if (review) return { id };
  const token = assertString(input.token, 'token', { trim: false, min: 36, max: 36, pattern: /^[a-f0-9-]{36}$/ });
  return { id, token };
}

export function validateProviderCleanupRecords(value) {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value) || value.length > MAX_PROVIDER_CLEANUPS) throw new Error('Invalid cleanup list');
    const records = value.map(item => {
      const input = assertRecord(item, 'cleanup record');
      if (Object.keys(input).some(key => !['id', 'generation'].includes(key))) throw new Error('Invalid cleanup fields');
      return {
        id: assertString(input.id, 'id', { trim: false, min: 3, max: 80, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ }),
        generation: assertString(input.generation, 'generation', { trim: false, min: 36, max: 36, pattern: /^[a-f0-9-]{36}$/ })
      };
    });
    if (new Set(records.map(item => item.id)).size !== records.length) throw new Error('Duplicate cleanup identifier');
    return records;
  } catch {
    throw new AppError('PROVIDER_CLEANUP_STATE_INVALID', 'The saved source-cleanup list cannot be read safely. No cleanup was authorized.', { status: 409 });
  }
}

export function validateSettingsPatch(value) {
  const input = assertRecord(value, 'settings');
  const output = {};
  if ('localAi' in input) output.localAi = validateAiConfig(input.localAi);
  if ('network' in input) output.network = assertOneOf(input.network, NETWORKS, 'network');
  if ('theme' in input) output.theme = assertOneOf(input.theme, ['system', 'dark', 'light'], 'theme');
  if ('privacyMode' in input) {
    output.privacyMode = assertOneOf(input.privacyMode, ['strict', 'balanced', 'compatible'], 'privacyMode');
    if (output.privacyMode === 'strict') {
      output.localOnly = true;
      output.contentNetworkPolicy = 'blocked';
    } else if (output.privacyMode === 'balanced') {
      output.localOnly = false;
      output.contentNetworkPolicy = 'blocked';
    } else {
      output.localOnly = false;
      output.contentNetworkPolicy = 'https-only';
    }
  }
  if ('contentNetworkPolicy' in input) output.contentNetworkPolicy = assertOneOf(input.contentNetworkPolicy, ['blocked', 'https-only'], 'contentNetworkPolicy');
  for (const key of ['localOnly', 'offlineMode', 'developerMode', 'restoreSession', 'telemetryEnabled']) {
    if (key in input) output[key] = assertBoolean(input[key], key);
  }
  if ('cacheMaxBytes' in input) output.cacheMaxBytes = assertInteger(input.cacheMaxBytes, 'cacheMaxBytes', 64 * 1024 * 1024, 100 * 1024 * 1024 * 1024);
  if ('maxResourceBytes' in input) output.maxResourceBytes = assertInteger(input.maxResourceBytes, 'maxResourceBytes', 1024, 1024 * 1024 * 1024);
  if ('maxGraphBytes' in input) output.maxGraphBytes = assertInteger(input.maxGraphBytes, 'maxGraphBytes', 1024, 64 * 1024 * 1024);
  if ('maxRecursionDepth' in input) output.maxRecursionDepth = assertInteger(input.maxRecursionDepth, 'maxRecursionDepth', 1, 128);
  if ('maxRecursionNodes' in input) output.maxRecursionNodes = assertInteger(input.maxRecursionNodes, 'maxRecursionNodes', 1, 10_000);
  if ('maxConcurrentContentRequests' in input) output.maxConcurrentContentRequests = assertInteger(input.maxConcurrentContentRequests, 'maxConcurrentContentRequests', 1, 64);
  if ('requestTimeoutMs' in input) output.requestTimeoutMs = assertInteger(input.requestTimeoutMs, 'requestTimeoutMs', 1_000, 120_000);
  if ('preferredProviderId' in input) {
    output.preferredProviderId = input.preferredProviderId === null ? null : assertString(input.preferredProviderId, 'preferredProviderId', { min: 3, max: 80 });
  }
  return output;
}

export function sanitizeJson(value, limits = {}) {
  const maxDepth = limits.maxDepth ?? 16;
  const maxKeys = limits.maxKeys ?? 10_000;
  let keys = 0;
  const visit = (current, depth) => {
    if (depth > maxDepth) return '[depth limit]';
    if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) return current;
    if (typeof current === 'bigint') return current.toString();
    if (Array.isArray(current)) return current.slice(0, maxKeys).map((item) => visit(item, depth + 1));
    if (isRecord(current)) {
      const result = {};
      for (const [key, item] of Object.entries(current)) {
        keys += 1;
        if (keys > maxKeys) {
          result.__truncated = true;
          break;
        }
        if (/password|secret|cookie|authorization|token/i.test(key)) result[key] = '[redacted]';
        else result[key] = visit(item, depth + 1);
      }
      return result;
    }
    return String(current);
  };
  return visit(value, 0);
}
