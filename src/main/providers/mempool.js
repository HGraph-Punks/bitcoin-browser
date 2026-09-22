import { DataProvider } from './base.js';
import { normalizeEntity } from './normalize.js';
import { requestBuffer, assertHttpSuccess, parseJsonBody } from '../http.js';
import { AppError } from '../../shared/errors.js';

export class MempoolProvider extends DataProvider {
  api(path) {
    const base = this.config.baseUrl.replace(/\/$/, '');
    return `${base}/api${path.startsWith('/') ? path : `/${path}`}`;
  }

  async request(path, options = {}) {
    const response = await requestBuffer(this.api(path), {
      headers: { accept: options.accept ?? 'application/json', 'user-agent': 'BitcoinBrowser/1.0' },
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      signal: options.signal,
      networkPolicy: this.config.local ? 'local' : 'remote'
    });
    assertHttpSuccess(response, this.name);
    return response;
  }

  async health(options = {}) {
    const response = await this.request('/blocks/tip/height', { timeoutMs: options.timeoutMs ?? 5_000, maxBytes: 64 * 1024, accept: 'text/plain', signal: options.signal });
    const height = Number(response.data.toString('utf8'));
    return {
      ok: Number.isSafeInteger(height),
      height: Number.isSafeInteger(height) ? height : null,
      latencyMs: response.latencyMs,
      checkedAt: new Date().toISOString(),
      capabilities: [...this.capabilities]
    };
  }

  async resolve(target, options = {}) {
    let path;
    let raw;
    let response;
    switch (target.kind) {
      case 'transaction':
        path = `/tx/${target.value}`;
        response = await this.request(path, options);
        raw = parseJsonBody(response, this.name);
        break;
      case 'block': {
        let hash = target.value;
        if (/^\d+$/.test(String(hash))) {
          const hashResponse = await this.request(`/block-height/${hash}`, { ...options, accept: 'text/plain', maxBytes: 128 * 1024 });
          hash = hashResponse.data.toString('utf8').trim();
        }
        path = `/block/${hash}`;
        response = await this.request(path, options);
        raw = parseJsonBody(response, this.name);
        break;
      }
      case 'address':
        path = `/address/${target.value}`;
        response = await this.request(path, options);
        raw = parseJsonBody(response, this.name);
        break;
      case 'output': {
        const [txid, voutText] = target.value.split(':');
        path = `/tx/${txid}`;
        response = await this.request(path, options);
        const transaction = parseJsonBody(response, this.name);
        const output = transaction.vout?.[Number(voutText)];
        if (!output) throw new AppError('NOT_FOUND', 'Transaction output not found', { status: 404 });
        raw = { ...output, outpoint: target.value, spent: null, transactionStatus: transaction.status };
        break;
      }
      default:
        throw new AppError('UNSUPPORTED_TARGET', `${this.name} cannot resolve ${target.kind}`, { status: 422 });
    }
    return normalizeEntity(target, raw, this, { latencyMs: response.latencyMs, endpoint: path });
  }

  async recommendedFees(options = {}) {
    const response = await this.request('/v1/fees/recommended', options);
    return parseJsonBody(response, this.name);
  }
}
