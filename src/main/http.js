import { AppError } from '../shared/errors.js';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function composeSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  const onAbort = () => controller.abort(signal.reason ?? new Error('Request aborted'));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

function snapshotAllowedOrigins(values) {
  if (values === undefined) return null;
  const invalid = () => new AppError('VALIDATION_ERROR', 'allowedOrigins must contain 1 to 16 canonical HTTP(S) origins', { status: 400 });
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) throw invalid();
  const result = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 512) throw invalid();
    let parsed;
    try { parsed = new URL(value); } catch { throw invalid(); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) throw invalid();
    result.add(value);
  }
  // The Set stays private: freezing a caller-owned Set would not stop mutation.
  return result;
}

function assertAllowedOrigin(parsed, allowed) {
  if (allowed && !allowed.has(parsed.origin)) {
    throw new AppError('UNSAFE_PROVIDER_ORIGIN', 'Request destination violates its permitted-origin policy', { status: 403 });
  }
}

function resolveWhileActive(parsed, options, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    // OS DNS itself is not cancellable here. Consume its late result without
    // admitting a connection or holding application shutdown on that result.
    resolveSafeAddresses(parsed, options).then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export async function readResponseBody(response, maxBytes) {
  const declared = Number(headerValue(response.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError('RESOURCE_TOO_LARGE', `Resource exceeds the ${maxBytes} byte limit`, { status: 413 });
  }
  const chunks = [];
  let total = 0;
  const stream = response.body ?? response;
  if (!stream) return Buffer.alloc(0);
  for await (const value of stream) {
    total += value.byteLength;
    if (total > maxBytes) {
      stream.destroy?.();
      throw new AppError('RESOURCE_TOO_LARGE', `Resource exceeds the ${maxBytes} byte limit`, { status: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function ipv4Class(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return 'invalid';
  const [a, b, c] = octets;
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if (a === 0 || (a === 192 && b === 0 && c === 0)) return 'reserved';
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

function ipv6Words(address) {
  let source = address.toLowerCase().split('%', 1)[0];
  if (source.includes('.')) {
    const lastColon = source.lastIndexOf(':');
    const ipv4 = source.slice(lastColon + 1);
    if (ipv4Class(ipv4) === 'invalid') return null;
    const octets = ipv4.split('.').map(Number);
    source = `${source.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

export function addressClass(address) {
  const family = net.isIP(address);
  if (family === 4) return ipv4Class(address);
  if (family !== 6) return 'invalid';
  const words = ipv6Words(address);
  if (!words) return 'invalid';
  if (words.every((word) => word === 0)) return 'reserved';
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return 'loopback';
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return ipv4Class(`${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`);
  }
  if ((words[0] & 0xfe00) === 0xfc00) return 'private';
  if ((words[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((words[0] & 0xff00) === 0xff00) return 'multicast';
  if (words[0] === 0x2001 && words[1] === 0x0db8) return 'reserved';
  return 'public';
}

export async function resolveSafeAddresses(url, options = {}) {
  const parsed = url instanceof URL ? url : new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  let addresses;
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await (options.lookup ?? dns.lookup)(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new AppError('PROVIDER_NETWORK_ERROR', `Provider hostname could not be resolved: ${error.message}`, { status: 503, retryable: true });
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new AppError('PROVIDER_NETWORK_ERROR', 'Provider hostname resolved to no addresses', { status: 503, retryable: true });
  }
  const policy = options.networkPolicy ?? 'remote';
  for (const entry of addresses) {
    const classification = addressClass(entry.address);
    const allowed = policy === 'local'
      ? ['loopback', 'private'].includes(classification)
      : classification === 'public';
    if (!allowed) {
      throw new AppError('UNSAFE_PROVIDER_DESTINATION', `${policy === 'local' ? 'Local' : 'Remote'} provider resolved to a prohibited ${classification} address`, {
        status: 400,
        details: { hostname, address: entry.address, classification, policy }
      });
    }
  }
  return addresses;
}

function nodeResponse(parsed, requestOptions, address, signal) {
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, {
      method: requestOptions.method,
      headers: requestOptions.headers,
      signal,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      }
    }, resolve);
    request.once('error', reject);
    if (requestOptions.body !== undefined && requestOptions.body !== null) request.write(requestOptions.body);
    request.end();
  });
}

export async function requestBuffer(url, options = {}) {
  let parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('UNSAFE_URL', 'Only HTTP and HTTPS provider URLs are allowed', { status: 400 });
  }
  if (parsed.username || parsed.password) {
    throw new AppError('UNSAFE_URL', 'Provider credentials must not be embedded in a URL', { status: 400 });
  }
  const allowedOrigins = snapshotAllowedOrigins(options.allowedOrigins);
  assertAllowedOrigin(parsed, allowedOrigins);
  const onResponse = options.onResponse;
  if (onResponse !== undefined && typeof onResponse !== 'function') {
    throw new AppError('VALIDATION_ERROR', 'onResponse must be a function', { status: 400 });
  }
  const callerSignal = options.signal;
  callerSignal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const requestedRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(requestedRedirects) || requestedRedirects < 0 || requestedRedirects > 10) {
    throw new AppError('VALIDATION_ERROR', 'maxRedirects must be an integer from 0 to 10', { status: 400 });
  }
  const maxRedirects = requestedRedirects;
  const composed = composeSignal(callerSignal, timeoutMs);
  const started = performance.now();
  let method = options.method ?? 'GET';
  let body = options.body;
  let headers = { ...(options.headers ?? {}) };
  let activeResponse;
  try {
    for (let redirects = 0; ; redirects += 1) {
      composed.signal.throwIfAborted();
      assertAllowedOrigin(parsed, allowedOrigins);
      const addresses = await resolveWhileActive(parsed, options, composed.signal);
      composed.signal.throwIfAborted();
      let response;
      let lastError;
      for (const address of addresses) {
        try {
          composed.signal.throwIfAborted();
          response = await nodeResponse(parsed, { method, headers, body }, address, composed.signal);
          activeResponse = response;
          break;
        } catch (error) {
          lastError = error;
          if (composed.signal.aborted) throw error;
        }
      }
      if (!response) throw lastError ?? new Error('Provider connection failed');
      composed.signal.throwIfAborted();
      const status = response.statusCode ?? 0;
      // Do not expose a live URL, query token, response headers or body through
      // the observer. The software installer retains only these public fields.
      onResponse?.(Object.freeze({ origin: parsed.origin, status }));
      composed.signal.throwIfAborted();
      const location = headerValue(response.headers, 'location');
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        if (allowedOrigins) response.destroy();
        else response.resume();
        if (options.redirect === 'error' || redirects >= maxRedirects) {
          throw new AppError('PROVIDER_REDIRECT_ERROR', 'Provider exceeded or violated the redirect policy', { status: 502, retryable: false });
        }
        const next = new URL(location, parsed);
        if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) {
          throw new AppError('UNSAFE_URL', 'Provider redirect target is unsafe', { status: 400 });
        }
        assertAllowedOrigin(next, allowedOrigins);
        if (next.origin !== parsed.origin) {
          const filtered = {};
          for (const [key, value] of Object.entries(headers)) {
            if (!['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase())) filtered[key] = value;
          }
          headers = filtered;
        }
        if (status === 303) { method = 'GET'; body = undefined; }
        parsed = next;
        continue;
      }
      const data = await readResponseBody(response, options.maxBytes ?? 64 * 1024 * 1024);
      composed.signal.throwIfAborted();
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: response.statusMessage ?? '',
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')])),
        data,
        latencyMs: Math.round(performance.now() - started),
        url: parsed.toString()
      };
    }
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (error instanceof AppError) throw error;
    const timedOut = composed.signal.aborted;
    throw new AppError(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR', timedOut ? 'Provider request timed out' : `Provider request failed: ${error.message}`, {
      status: 503,
      retryable: true,
      cause: error
    });
  } finally {
    if (allowedOrigins) activeResponse?.destroy();
    composed.cleanup();
  }
}

export function parseJsonBody(response, context = 'provider') {
  try {
    return JSON.parse(response.data.toString('utf8'));
  } catch (error) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', `${context} returned invalid JSON`, { status: 502, retryable: true, cause: error });
  }
}

export function assertHttpSuccess(response, context = 'Provider') {
  if (response.ok) return response;
  const detail = response.data.toString('utf8').slice(0, 500).replace(/\s+/g, ' ');
  const code = response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH_ERROR' : response.status === 404 ? 'NOT_FOUND' : 'PROVIDER_HTTP_ERROR';
  throw new AppError(code, `${context} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`, {
    status: response.status,
    retryable: response.status >= 500 || response.status === 429,
    details: { providerStatus: response.status }
  });
}
