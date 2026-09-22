import { DataProvider } from './base.js';
import { normalizeEntity } from './normalize.js';
import { requestBuffer, assertHttpSuccess, parseJsonBody } from '../http.js';
import { AppError } from '../../shared/errors.js';
import { discoverOrdInscriptions, inscriptionIdFromHtml } from './ord-discovery.js';
import { resolveOrdRunes } from './ord-runes.js';

function joinBase(baseUrl, requestPath) {
  const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  return new URL(path, `${baseUrl}/`).toString();
}

function decodeFlexible(response) {
  const type = (response.headers['content-type'] ?? '').toLowerCase();
  const text = response.data.toString('utf8');
  if (type.includes('json') || /^[\s]*[\[{\"]/.test(text)) {
    try { return JSON.parse(text); } catch {}
  }
  return text;
}

export class OrdServerProvider extends DataProvider {
  constructor(config, dependencies = {}) {
    const migrated = structuredClone(config);
    if (migrated.capabilities?.includes('output') && !migrated.capabilities.includes('satpoint')) {
      migrated.capabilities.push('satpoint');
    }
    super(migrated, dependencies);
  }

  async fetchPath(requestPath, options = {}) {
    if (!requestPath.startsWith('/content/') && !requestPath.startsWith('/r/') && !options.allowExplorerPath) {
      throw new AppError('UNSAFE_ORD_PATH', 'Only ord content and recursive endpoints are allowed', { status: 400 });
    }
    const headers = {
      accept: options.accept ?? '*/*',
      'user-agent': 'BitcoinBrowser/1.0',
      ...(options.range ? { range: options.range } : {})
    };
    const response = await requestBuffer(joinBase(this.config.baseUrl, requestPath), {
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      redirect: 'follow',
      networkPolicy: this.config.local ? 'local' : 'remote'
    });
    if (!options.allowStatuses?.includes(response.status)) assertHttpSuccess(response, this.name);
    return response;
  }

  async health(options = {}) {
    const response = await this.fetchPath('/r/blockheight', {
      accept: 'text/plain, application/json',
      timeoutMs: options.timeoutMs ?? 5_000,
      maxBytes: 64 * 1024,
      signal: options.signal
    });
    const height = Number(response.data.toString('utf8').replace(/[^0-9-]/g, ''));
    return {
      ok: Number.isSafeInteger(height) && height >= 0,
      latencyMs: response.latencyMs,
      height: Number.isSafeInteger(height) ? height : null,
      checkedAt: new Date().toISOString(),
      capabilities: [...this.capabilities]
    };
  }

  async resolve(target, options = {}) {
    const signal = options.signal;
    signal?.throwIfAborted();
    // A transport may settle with another error after cancellation. Preserve
    // the exact request reason without admitting a fallback or metadata read.
    const preserveCancellation = error => { signal?.throwIfAborted(); throw error; };
    if (target.kind === 'rune' || target.kind === 'runes') {
      const started = performance.now();
      const { data, endpoint } = await resolveOrdRunes(this, target, options).catch(preserveCancellation);
      signal?.throwIfAborted();
      return normalizeEntity(target, data, this, { latencyMs: Math.round(performance.now() - started), endpoint });
    }
    if (target.kind === 'inscriptions') {
      const started = performance.now();
      const raw = await discoverOrdInscriptions(this, target, options).catch(preserveCancellation);
      signal?.throwIfAborted();
      return normalizeEntity(target, raw, this, { latencyMs: Math.round(performance.now() - started), endpoint: '/inscriptions' });
    }
    let path;
    let accept = 'application/json';
    switch (target.kind) {
      case 'inscription': path = `/r/inscription/${target.value}`; break;
      case 'inscription-number': path = `/inscription/${target.value}`; break;
      case 'sat':
      case 'sat-name':
      case 'sat-degree': path = `/r/sat/${encodeURIComponent(target.value)}`; break;
      case 'block': path = `/r/blockinfo/${encodeURIComponent(target.value)}`; break;
      case 'transaction': path = `/r/tx/${target.value}`; break;
      case 'output': path = `/r/utxo/${target.value}`; break;
      case 'satpoint': path = `/satpoint/${target.value}`; break;
      case 'address': path = `/address/${target.value}`; break;
      case 'rune': path = `/rune/${encodeURIComponent(target.value)}`; break;
      case 'content':
        path = `/content/${target.value}`;
        accept = '*/*';
        break;
      case 'recursive':
        path = target.value;
        accept = '*/*';
        break;
      default:
        throw new AppError('UNSUPPORTED_TARGET', `${this.name} cannot resolve ${target.kind}`, { status: 422 });
    }
    const response = await this.fetchPath(path, {
      accept,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      signal: options.signal,
      allowExplorerPath: !path.startsWith('/r/') && !path.startsWith('/content/'),
      allowStatuses: target.kind === 'inscription-number' ? [406] : undefined
    }).catch(preserveCancellation);
    signal?.throwIfAborted();
    let raw = target.kind === 'content'
      ? { contentType: response.headers['content-type'] ?? 'application/octet-stream', contentLength: response.data.length }
      : decodeFlexible(response);
    if (target.kind === 'inscription-number' && (response.status === 406 || typeof raw === 'string')) {
      const html = response.status === 406 ? await this.fetchPath(path, {
        accept: 'text/html', timeoutMs: options.timeoutMs, maxBytes: Math.min(options.maxBytes ?? 512 * 1024, 512 * 1024),
        signal: options.signal, allowExplorerPath: true
      }).catch(preserveCancellation) : response;
      signal?.throwIfAborted();
      const id = inscriptionIdFromHtml(html, target.value);
      const metadata = await this.fetchPath(`/r/inscription/${id}`, {
        accept: 'application/json', timeoutMs: options.timeoutMs, maxBytes: Math.min(options.maxBytes ?? 64 * 1024, 64 * 1024), signal: options.signal
      }).catch(preserveCancellation);
      signal?.throwIfAborted();
      raw = parseJsonBody(metadata, this.name);
      if (String(raw.number) !== String(target.value) || String(raw.id).toLowerCase() !== id) {
        throw new AppError('INVALID_PROVIDER_RESPONSE', `${this.name} returned mismatched inscription metadata`, { status: 502, retryable: true });
      }
    }
    if (typeof raw === 'string' && raw.trimStart().startsWith('<!')) {
      throw new AppError('PROVIDER_FORMAT_UNSUPPORTED', `${this.name} returned HTML instead of structured data for this target`, {
        status: 502,
        retryable: true,
        details: { path }
      });
    }
    return normalizeEntity(target, raw, this, { latencyMs: response.latencyMs, endpoint: path });
  }
}
