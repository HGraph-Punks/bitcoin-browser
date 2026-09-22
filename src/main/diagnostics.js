import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { AppError } from '../shared/errors.js';

export const MAX_DIAGNOSTICS_BYTES = 4 * 1024 * 1024;
export const DIAGNOSTICS_LIMITS = Object.freeze({
  depth: 12,
  nodes: 10_000,
  arrayEntries: 100,
  objectEntries: 100,
  logEntries: 50,
  stringCharacters: 4_096,
  inputStringCharacters: 16_384,
  keyCharacters: 128,
  totalCharacters: 256 * 1024
});

const SECRET_KEY = /password|passwd|secret|cookie|authorization|token|seed|mnemonic|private[ _-]?key|api[ _-]?key/i;
const TEXT_SECRET_NAME = '(?:[a-z0-9_-]{0,64}(?:password|passwd|token|secret)|(?:set-)?cookie|authorization|seed(?:[ _-]+phrase)?|mnemonic|private[ _-]?key|api[ _-]?key)';
const TEXT_SECRET_VALUE = new RegExp(`(?<![\\w-])((?:["']?)${TEXT_SECRET_NAME}(?:["']?)\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*(?:"|$)|'(?:\\\\.|[^'\\\\])*(?:'|$)|(?:basic|bearer)\\s+[^\\s,;&]+|[^\\s,;&]+)`, 'gi');
const TEXT_SECRET_FLAG = new RegExp(`((?:--?|/)${TEXT_SECRET_NAME}\\s+)(?:"(?:\\\\.|[^"\\\\])*(?:"|$)|'(?:\\\\.|[^'\\\\])*(?:'|$)|(?:basic|bearer)\\s+[^\\s,;]+|[^\\s,;]+)`, 'gi');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactText(value) {
  return value
    .replace(/((?:https?|wss?):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    // An unquoted seed phrase can contain spaces. Omit the rest of that log line.
    .replace(/((?:seed(?:[ _-]+phrase)?|mnemonic)\s*[:=]\s*)(?!["'])[^\r\n]+/gi, '$1[redacted]')
    // Cookie headers contain multiple semicolon-delimited credentials. Omit
    // the whole value (including quoted JSON log forms), not only its first pair.
    .replace(/((?:["']?)(?:set-)?cookie(?:["']?)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(TEXT_SECRET_VALUE, '$1[redacted]')
    .replace(TEXT_SECRET_FLAG, '$1[redacted]');
}

function diagnosticSanitizer() {
  const counts = {};
  let nodes = 0;
  let characters = 0;
  const ancestors = new WeakSet();
  const note = (reason) => { counts[reason] = (counts[reason] ?? 0) + 1; };
  const boundedArray = (value, limit = DIAGNOSTICS_LIMITS.arrayEntries, tail = false) => {
    if (!Array.isArray(value)) return [];
    if (value.length > limit) note('arrays');
    return tail ? value.slice(-limit) : value.slice(0, limit);
  };
  const text = (value, limit = DIAGNOSTICS_LIMITS.stringCharacters) => {
    if (value.length > DIAGNOSTICS_LIMITS.inputStringCharacters) note('strings');
    const redacted = redactText(value.slice(0, DIAGNOSTICS_LIMITS.inputStringCharacters));
    const available = Math.max(0, Math.min(limit, DIAGNOSTICS_LIMITS.totalCharacters - characters));
    if (redacted.length > available) note(available < limit ? 'characters' : 'strings');
    characters += Math.min(available, redacted.length);
    return redacted.slice(0, available) + (redacted.length > available ? '…[truncated]' : '');
  };
  const args = (value) => {
    let redactNext = false;
    return boundedArray(value).map((argument) => {
      if (redactNext) { redactNext = false; return '[redacted]'; }
      if (typeof argument !== 'string') return '[invalid argument]';
      const flag = argument.slice(0, DIAGNOSTICS_LIMITS.inputStringCharacters);
      if (SECRET_KEY.test(flag)) {
        const separator = flag.indexOf('=');
        if (separator >= 0 && !/\s/.test(flag.slice(0, separator))) return `${flag.slice(0, separator)}=[redacted]`;
        if (/^(?:--?|\/)?[a-z][\w.-]*$/i.test(flag)) redactNext = true;
      }
      return argument;
    });
  };
  const walk = (value, depth = 0) => {
    if (++nodes > DIAGNOSTICS_LIMITS.nodes) { note('nodes'); return '[truncated]'; }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return text(String(value));
    if (typeof value !== 'object') return null;
    if (depth >= DIAGNOSTICS_LIMITS.depth) { note('depth'); return '[truncated]'; }
    if (ancestors.has(value)) { note('cycles'); return '[circular]'; }
    ancestors.add(value);
    const result = Array.isArray(value) ? [] : Object.create(null);
    let entries = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (entries >= (Array.isArray(value) ? DIAGNOSTICS_LIMITS.arrayEntries : DIAGNOSTICS_LIMITS.objectEntries)
        || nodes >= DIAGNOSTICS_LIMITS.nodes || characters >= DIAGNOSTICS_LIMITS.totalCharacters) {
        note(nodes >= DIAGNOSTICS_LIMITS.nodes ? 'nodes' : characters >= DIAGNOSTICS_LIMITS.totalCharacters ? 'characters' : 'collections');
        break;
      }
      entries += 1;
      const safeKey = Array.isArray(value) ? null : text(key, DIAGNOSTICS_LIMITS.keyCharacters);
      // Do not inspect an unbounded key or preserve its value after truncation
      // may have removed the part identifying it as a credential field.
      const safeValue = key.length > DIAGNOSTICS_LIMITS.keyCharacters || SECRET_KEY.test(key)
        ? '[redacted]' : walk(value[key], depth + 1);
      if (Array.isArray(value)) result.push(safeValue);
      else result[safeKey] = safeValue;
    }
    ancestors.delete(value);
    return result;
  };
  return {
    boundedArray, args, walk,
    metadata: () => ({ bestEffort: true, truncated: Object.keys(counts).length > 0, counts, limits: DIAGNOSTICS_LIMITS })
  };
}

export async function buildDiagnostics(options) {
  const sanitizer = diagnosticSanitizer();
  const snapshot = options.stateStore.snapshot();
  const state = isRecord(snapshot) ? snapshot : {};
  const wallet = isRecord(state.wallet) ? state.wallet : {};
  const service = (value) => ({
    ...value,
    executable: typeof value.executable === 'string' ? path.basename(value.executable) : '',
    cwd: value.cwd ? '[redacted path]' : '',
    args: sanitizer.args(value.args),
    logs: sanitizer.boundedArray(value.logs, DIAGNOSTICS_LIMITS.logEntries, true)
  });
  const safeState = {
    ...state,
    wallet: { ...wallet, accounts: sanitizer.boundedArray(wallet.accounts).filter(isRecord).map((account) => ({
      ...account,
      address: typeof account.address === 'string' && account.address.length > 14 ? `${account.address.slice(0, 8)}…${account.address.slice(-6)}` : '[redacted]',
      publicKey: '[redacted]'
    }))
    },
    extensions: sanitizer.boundedArray(state.extensions).filter(isRecord).map((extension) => ({ ...extension, path: typeof extension.path === 'string' ? path.basename(extension.path) : '' })),
    localServices: sanitizer.boundedArray(state.localServices).filter(isRecord).map(service)
  };
  // Read only the already-cached availability state. Export must not initiate a
  // secure-storage probe or prompt the OS for access to credential material.
  const availability = options.secureStore.availabilityStatus?.();
  const diagnostics = sanitizer.walk({
    generatedAt: new Date().toISOString(),
    notes: [
      'Best-effort redaction removes known credential fields, service secret arguments and recognizable secrets in text; review this file before sharing.',
      'Bounded browsing history, blockchain identifiers, provider destinations and unrecognized sensitive text may remain.',
      'Secure-storage availability is cached; null means not checked. Export does not probe the credential store.'
    ],
    application: { name: options.app.getName(), version: options.app.getVersion(), packaged: options.app.isPackaged },
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
    platform: { platform: process.platform, arch: process.arch, release: os.release(), totalMemory: os.totalmem(), freeMemory: os.freemem(), cpus: os.cpus().length },
    secureStorageAvailable: typeof availability === 'boolean' ? availability : null,
    state: safeState,
    providers: options.providerManager.list(),
    cache: { ...options.cache.stats(), directory: '[redacted path]' },
    services: sanitizer.boundedArray(options.localServiceManager.list()).filter(isRecord).map(service)
  });
  diagnostics.redaction = sanitizer.metadata();
  return diagnostics;
}

export async function writeDiagnostics(file, diagnostics, options = {}) {
  const serialized = JSON.stringify(diagnostics, null, 2) + '\n';
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_DIAGNOSTICS_BYTES) {
    throw new AppError('DIAGNOSTICS_TOO_LARGE', 'Diagnostics exceed the maximum export size', {
      status: 413,
      details: { bytes, maxBytes: MAX_DIAGNOSTICS_BYTES }
    });
  }
  const fileSystem = options.fs ?? fs;
  const suffix = options.randomId?.() ?? crypto.randomUUID();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.tmp`);
  let handle;
  let ownsTemporary = false;
  try {
    handle = await fileSystem.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporary, file);
    return file;
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (ownsTemporary) try { await fileSystem.unlink(temporary); } catch {}
    throw error;
  }
}
