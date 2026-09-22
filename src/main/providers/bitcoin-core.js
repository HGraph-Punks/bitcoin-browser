import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { DataProvider } from './base.js';
import { normalizeEntity } from './normalize.js';
import { requestBuffer, assertHttpSuccess, parseJsonBody } from '../http.js';
import { AppError } from '../../shared/errors.js';

export class BitcoinCoreProvider extends DataProvider {
  async authorizationHeader() {
    let credential = null;
    if (this.config.cookieFile) {
      try { credential = (await fs.readFile(this.config.cookieFile, 'utf8')).trim(); } catch (error) {
        // Core removes its cookie on shutdown and creates a new one on startup.
        // A missing file is not an HTTP authentication rejection. Keep native
        // error text (which may contain paths) out of the public error message.
        if (error.code === 'ENOENT') throw new AppError('PROVIDER_COOKIE_UNAVAILABLE',
          'Bitcoin Core’s local sign-in file is not available yet. Start the node, or wait for startup to finish.', { status: 503, retryable: true });
        if (['EACCES', 'EPERM'].includes(error.code)) throw new AppError('PROVIDER_COOKIE_ACCESS_DENIED',
          'Bitcoin Browser cannot access Bitcoin Core’s local sign-in file. Review the cookie file location and folder permissions.', { status: 403 });
        throw new AppError('PROVIDER_COOKIE_READ_FAILED',
          'Bitcoin Core’s local sign-in file could not be read. Review the cookie file location in Data sources.', { status: 503 });
      }
      if (!credential) throw new AppError('PROVIDER_COOKIE_UNAVAILABLE',
        'Bitcoin Core’s local sign-in file is not ready yet. Wait for startup to finish.', { status: 503, retryable: true });
    } else {
      const username = this.secureStore?.get(`provider:${this.id}:username`);
      const password = this.secureStore?.get(`provider:${this.id}:password`);
      if (typeof username === 'string' && typeof password === 'string') credential = `${username}:${password}`;
    }
    return credential ? `Basic ${Buffer.from(credential).toString('base64')}` : null;
  }

  async rpc(method, params = [], options = {}) {
    const authorization = await this.authorizationHeader();
    const response = await requestBuffer(this.config.baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'BitcoinBrowser/1.0',
        ...(authorization ? { authorization } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
      signal: options.signal,
      networkPolicy: this.config.local ? 'local' : 'remote'
    });
    // Core can return JSON-RPC errors (including warmup -28) with HTTP 500.
    // Recognize those without turning real HTTP 401/403 rejections into startup
    // warnings, or mistaking a non-JSON HTTP failure for an RPC result.
    let body;
    if (response.status === 500) {
      try { body = parseJsonBody(response, this.name); } catch { /* Preserve HTTP failure below. */ }
    }
    if (!body?.error || typeof body.error.code !== 'number') assertHttpSuccess(response, this.name);
    body ??= parseJsonBody(response, this.name);
    if (body.error) {
      const code = body.error.code === -5 ? 'NOT_FOUND' : body.error.code === -28 ? 'PROVIDER_WARMING_UP' : 'PROVIDER_RPC_ERROR';
      throw new AppError(code, `Bitcoin Core RPC ${method} failed: ${body.error.message}`, {
        status: code === 'NOT_FOUND' ? 404 : 502,
        retryable: code === 'PROVIDER_WARMING_UP',
        details: { rpcCode: body.error.code, method }
      });
    }
    return { result: body.result, latencyMs: response.latencyMs };
  }

  async health(options = {}) {
    const response = await this.rpc('getblockchaininfo', [], { timeoutMs: options.timeoutMs ?? 5_000, maxBytes: 2 * 1024 * 1024, signal: options.signal });
    return {
      ok: true,
      height: response.result.blocks,
      headers: response.result.headers,
      verificationProgress: response.result.verificationprogress,
      initialBlockDownload: response.result.initialblockdownload,
      pruned: response.result.pruned,
      chain: response.result.chain,
      latencyMs: response.latencyMs,
      checkedAt: new Date().toISOString(),
      capabilities: [...this.capabilities]
    };
  }

  async resolve(target, options = {}) {
    let raw;
    let timing;
    let endpoint;
    switch (target.kind) {
      case 'block': {
        let hash = target.value;
        if (/^\d+$/.test(String(hash))) {
          const hashResult = await this.rpc('getblockhash', [Number(hash)], options);
          hash = hashResult.result;
        }
        endpoint = 'getblock';
        timing = await this.rpc('getblock', [hash, 2], options);
        raw = timing.result;
        break;
      }
      case 'transaction':
        endpoint = 'getrawtransaction';
        timing = await this.rpc('getrawtransaction', [target.value, true], options);
        raw = timing.result;
        break;
      case 'output': {
        const [txid, vout] = target.value.split(':');
        endpoint = 'gettxout';
        timing = await this.rpc('gettxout', [txid, Number(vout), true], options);
        if (timing.result === null) {
          const transaction = await this.rpc('getrawtransaction', [txid, true], options);
          const output = transaction.result.vout?.[Number(vout)];
          if (!output) throw new AppError('NOT_FOUND', 'Output not found', { status: 404 });
          raw = { ...output, spent: true };
        } else {
          raw = { ...timing.result, spent: false };
        }
        break;
      }
      default:
        throw new AppError('UNSUPPORTED_TARGET', `${this.name} cannot resolve ${target.kind}`, { status: 422 });
    }
    return normalizeEntity(target, raw, this, { latencyMs: timing.latencyMs, endpoint });
  }
}
