import crypto from 'node:crypto';
import { AppError } from '../shared/errors.js';

const SAFE_PATH_RE = /^\/(?:content|r)\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+$/;
const INSCRIPTION_REFERENCE_RE = /(?:ord:\/\/content\/|\/content\/)([0-9a-f]{64}i\d+)/gi;
const RECURSIVE_REFERENCE_RE = /(?:ord:\/\/content)?(\/r\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+)/gi;

function normalizeOrdPath(value) {
  if (typeof value !== 'string' || value.length > 8_192 || value.includes('\0')) {
    throw new AppError('UNSAFE_ORD_PATH', 'Invalid recursive resource path', { status: 400 });
  }
  let path = value;
  try {
    if (value.startsWith('ord:')) {
      const url = new URL(value);
      if (url.hostname === 'content') {
        path = url.pathname.startsWith('/content/') || url.pathname.startsWith('/r/')
          ? url.pathname
          : `/content${url.pathname}`;
      } else if (url.hostname === 'r') {
        path = url.pathname.startsWith('/r/') ? url.pathname : `/r${url.pathname}`;
      } else {
        path = `/${url.hostname}${url.pathname}`;
      }
      path += url.search;
    }
  } catch {
    throw new AppError('UNSAFE_ORD_PATH', 'Malformed ord URL', { status: 400 });
  }
  const [pathname, query = ''] = path.split('?', 2);
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
  if (decoded.includes('..') || decoded.includes('\\') || !SAFE_PATH_RE.test(pathname)) {
    throw new AppError('UNSAFE_ORD_PATH', 'Only /content/* and /r/* recursive endpoints are allowed', { status: 400 });
  }
  if (query && !/^[A-Za-z0-9._~!$&'()*+,;=:@%\/?-]*$/.test(query)) {
    throw new AppError('UNSAFE_ORD_PATH', 'Recursive query contains unsafe characters', { status: 400 });
  }
  return query ? `${pathname}?${query}` : pathname;
}

function ttlForPath(path) {
  if (path.startsWith('/content/')) return 365 * 24 * 60 * 60 * 1_000;
  if (/^\/r\/(?:tx|inscription|metadata|undelegated-content)\//.test(path)) return 30 * 24 * 60 * 60 * 1_000;
  if (/^\/r\/blockinfo\//.test(path)) return 24 * 60 * 60 * 1_000;
  if (/^\/r\/(?:blockheight|blockhash|blocktime)$/.test(path)) return 10_000;
  return 30_000;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { invalid: true };
  let start;
  let end;
  if (match[1] === '' && match[2] !== '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  setLimit(limit) {
    this.limit = limit;
    this.#drain();
  }

  async acquire(signal) {
    if (signal?.aborted) throw signal.reason ?? new AppError('REQUEST_ABORTED', 'Request was aborted', { status: 499 });
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason ?? new AppError('REQUEST_ABORTED', 'Request was aborted', { status: 499 }));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.#drain();
  }

  #drain() {
    while (this.active < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new AppError('REQUEST_ABORTED', 'Request was aborted', { status: 499 }));
        continue;
      }
      this.active += 1;
      waiter.resolve(() => this.release());
    }
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new AppError('REQUEST_ABORTED', 'Request was aborted', { status: 499 });
}

function pickHeaders(headers) {
  const output = {};
  for (const key of ['content-type', 'content-language', 'content-encoding', 'etag', 'last-modified', 'accept-ranges']) {
    if (headers[key]) output[key] = headers[key];
  }
  output['content-type'] ??= 'application/octet-stream';
  output['x-content-type-options'] = 'nosniff';
  output['referrer-policy'] = 'no-referrer';
  output['cross-origin-resource-policy'] = 'cross-origin';
  output['access-control-allow-origin'] = '*';
  output['permissions-policy'] = 'accelerometer=(), ambient-light-sensor=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), serial=(), usb=()';
  return output;
}

function cacheKey(network, path, accept, preferredProviderId) {
  return `v2|${network}|${preferredProviderId ?? 'auto'}|${accept ?? '*/*'}|${path}`;
}

function boundedIntegerOption(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError('VALIDATION_ERROR', `${name} must be a positive integer`, { status: 400 });
  }
  return Math.min(value, maximum);
}

export class RecursiveResolver {
  constructor(providerManager, cache, stateStore, logger) {
    this.providerManager = providerManager;
    this.cache = cache;
    this.stateStore = stateStore;
    this.logger = logger;
    this.semaphore = new Semaphore(stateStore.get(['settings', 'maxConcurrentContentRequests']) ?? 12);
  }

  async configure(settings = this.stateStore.get(['settings']), routing = null) {
    this.semaphore.setLimit(settings.maxConcurrentContentRequests);
    await this.cache.configure({ maxBytes: settings.cacheMaxBytes, maxEntryBytes: settings.maxResourceBytes });
    if (routing) this.providerManager.assertRouting(routing);
  }

  async resolve(input, options = {}) {
    const path = normalizeOrdPath(input);
    const routing = options.routingSnapshot ?? this.providerManager.captureRouting();
    const settings = this.stateStore.get(['settings']);
    this.providerManager.assertRouting(routing);
    throwIfAborted(options.signal);
    await this.configure(settings, routing);
    throwIfAborted(options.signal);
    const accept = String(options.accept ?? '*/*').slice(0, 512);
    const rangeHeader = options.range ? String(options.range).slice(0, 200) : null;
    const maxBytes = boundedIntegerOption(options.maxBytes, settings.maxResourceBytes, settings.maxResourceBytes, 'maxBytes');
    // Explicit per-request local reads have their own cache partition. They
    // cannot be satisfied by an earlier public-source recursive resource.
    const key = `${options.localOnly === true ? 'local-only|' : ''}${options.providerType === undefined ? '' : `${options.providerType}|`}${cacheKey(settings.network, path, accept, options.preferredProviderId ?? settings.preferredProviderId)}`;
    const release = await this.semaphore.acquire(options.signal);
    try {
      this.providerManager.assertRouting(routing);
      throwIfAborted(options.signal);
      const cached = await this.cache.get(key, { allowStale: settings.offlineMode });
      this.providerManager.assertRouting(routing);
      throwIfAborted(options.signal);
      if (cached) {
        if (cached.data.length > maxBytes) {
          throw new AppError('RESOURCE_TOO_LARGE', `Resource exceeds the ${maxBytes} byte limit`, { status: 413 });
        }
        const headers = { ...cached.meta.headers, 'x-satoshi-cache': cached.stale ? 'stale' : 'hit' };
        const range = parseRange(rangeHeader, cached.data.length);
        if (range?.invalid) {
          this.providerManager.assertRouting(routing);
          return { status: 416, headers: { ...headers, 'content-range': `bytes */${cached.data.length}` }, data: Buffer.alloc(0), provenance: cached.meta.provenance, cache: 'hit' };
        }
        if (range) {
          const data = cached.data.subarray(range.start, range.end + 1);
          this.providerManager.assertRouting(routing);
          return {
            status: 206,
            headers: { ...headers, 'content-length': String(data.length), 'content-range': `bytes ${range.start}-${range.end}/${cached.data.length}`, 'accept-ranges': 'bytes' },
            data,
            provenance: cached.meta.provenance,
            cache: 'hit'
          };
        }
        this.providerManager.assertRouting(routing);
        return { status: 200, headers: { ...headers, 'content-length': String(cached.data.length) }, data: cached.data, provenance: cached.meta.provenance, cache: cached.stale ? 'stale' : 'hit' };
      }
      if (settings.offlineMode) throw new AppError('OFFLINE_CACHE_MISS', 'This recursive resource is not cached', { status: 503 });

      const fetched = await this.providerManager.fetchOrdPath(path, {
        accept,
        range: rangeHeader,
        maxBytes,
        timeoutMs: settings.requestTimeoutMs,
        preferredProviderId: options.preferredProviderId,
        localOnly: options.localOnly === true,
        providerType: options.providerType,
        network: settings.network,
        signal: options.signal
      });
      this.providerManager.assertRouting(routing);
      throwIfAborted(options.signal);
      const headers = pickHeaders(fetched.response.headers);
      headers['x-satoshi-cache'] = 'miss';
      headers['x-satoshi-provider'] = fetched.provider.id;
      const status = fetched.response.status;
      const data = fetched.response.data;
      if (data.length > maxBytes) {
        throw new AppError('RESOURCE_TOO_LARGE', `Resource exceeds the ${maxBytes} byte limit`, { status: 413 });
      }
      const provenance = {
        providerId: fetched.provider.id,
        providerName: fetched.provider.name,
        endpoint: path,
        fetchedAt: new Date().toISOString(),
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        attempts: fetched.attempts
      };
      if (!rangeHeader && status === 200) {
        this.providerManager.assertRouting(routing);
        await this.cache.put(key, data, { headers, provenance }, ttlForPath(path), {
          validate: () => {
            this.providerManager.assertRouting(routing);
            throwIfAborted(options.signal);
          }
        });
        this.providerManager.assertRouting(routing);
        throwIfAborted(options.signal);
      }
      headers['content-length'] = String(data.length);
      this.providerManager.assertRouting(routing);
      return { status, headers, data, provenance, cache: 'miss' };
    } finally {
      release();
    }
  }

  async inspectGraph(inscriptionId, options = {}) {
    const routing = this.providerManager.captureRouting();
    const settings = this.stateStore.get(['settings']);
    this.providerManager.assertRouting(routing);
    throwIfAborted(options.signal);
    const maxDepth = boundedIntegerOption(options.maxDepth, settings.maxRecursionDepth, settings.maxRecursionDepth, 'maxDepth');
    const maxNodes = boundedIntegerOption(options.maxNodes, settings.maxRecursionNodes, settings.maxRecursionNodes, 'maxNodes');
    const maxBytes = settings.maxGraphBytes;
    const root = `/content/${inscriptionId}`;
    const queue = [{ path: root, depth: 0, ancestors: [] }];
    const nodes = new Map();
    const edges = [];
    const cycles = [];
    let truncated = false;
    let totalBytes = 0;

    while (queue.length && nodes.size < maxNodes) {
      this.providerManager.assertRouting(routing);
      throwIfAborted(options.signal);
      const remainingBytes = maxBytes - totalBytes;
      if (remainingBytes <= 0) {
        truncated = true;
        break;
      }
      const current = queue.shift();
      if (nodes.has(current.path)) continue;
      try {
        const resource = await this.resolve(current.path, {
          accept: 'text/html, text/css, application/javascript, text/javascript, application/json, */*;q=0.1',
          maxBytes: remainingBytes,
          signal: options.signal,
          routingSnapshot: routing
        });
        const contentType = resource.headers['content-type'] ?? 'application/octet-stream';
        const node = { path: current.path, depth: current.depth, contentType, bytes: resource.data.length, providerId: resource.provenance?.providerId ?? null, sha256: resource.provenance?.sha256 ?? null, dependencies: [] };
        nodes.set(current.path, node);
        totalBytes += resource.data.length;
        if (!/(?:text|javascript|json|svg|xml)/i.test(contentType)) continue;
        const text = resource.data.toString('utf8');
        const dependencies = new Set();
        for (const match of text.matchAll(INSCRIPTION_REFERENCE_RE)) dependencies.add(`/content/${match[1].toLowerCase()}`);
        for (const match of text.matchAll(RECURSIVE_REFERENCE_RE)) dependencies.add(match[1]);
        node.dependencies = [...dependencies];
        for (const dependency of dependencies) {
          edges.push({ from: current.path, to: dependency });
          if (current.ancestors.includes(dependency) || dependency === current.path) {
            cycles.push([...current.ancestors, current.path, dependency]);
            continue;
          }
          if (current.depth < maxDepth && !nodes.has(dependency)) queue.push({ path: dependency, depth: current.depth + 1, ancestors: [...current.ancestors, current.path] });
          else if (current.depth >= maxDepth) truncated = true;
        }
      } catch (error) {
        if (options.signal?.aborted || error?.code === 'ROUTING_INVALIDATED') throw error;
        nodes.set(current.path, { path: current.path, depth: current.depth, error: { code: error.code ?? 'ERROR', message: error.message }, dependencies: [] });
        if (error.code === 'RESOURCE_TOO_LARGE') truncated = true;
      }
    }
    this.providerManager.assertRouting(routing);
    throwIfAborted(options.signal);
    if (queue.length) truncated = true;
    return { root, nodes: [...nodes.values()], edges, cycles, truncated, totalBytes, limits: { maxDepth, maxNodes, maxBytes } };
  }
}

export { normalizeOrdPath, parseRange };
