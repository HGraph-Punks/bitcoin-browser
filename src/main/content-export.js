import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, serializeError } from '../shared/errors.js';

// Match the maximum configurable resolver resource size. The resolver still
// enforces the user's (usually much smaller) limit before presenting Save.
export const MAX_CONTENT_SAVE_BYTES = 1024 * 1024 * 1024;
const TEMPORARY_ATTEMPTS = 3;

function serializeFileError(error) {
  const normalized = serializeError(error);
  // Native filesystem Errors carry useful codes outside the AppError class.
  // Keep them in primary and secondary failures without changing global IPC
  // error normalization or exposing arbitrary extra Error properties.
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) normalized.code = error.code;
  return normalized;
}

async function checkDestination(fileSystem, file) {
  let entry;
  try { entry = await fileSystem.lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw new AppError('INVALID_CONTENT_DESTINATION', 'Choose a regular file destination for the saved content', { status: 400 });
  }
}

/**
 * Replace the selected directory entry without truncating its existing inode.
 * A successful rename is the final operation and the publication boundary.
 * This does not fsync the parent directory or claim power-loss durability,
 * Windows ACL semantics, or protection against hostile parent-path changes.
 */
export async function writeContentFile(file, data, options = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) {
    throw new AppError('INVALID_CONTENT_DESTINATION', 'Choose an absolute file destination for the saved content', { status: 400 });
  }
  const maxBytes = options.maxBytes ?? MAX_CONTENT_SAVE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_CONTENT_SAVE_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'Invalid content export size limit', { status: 400 });
  }
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw new AppError('INVALID_CONTENT_BYTES', 'Content export requires binary data', { status: 422 });
  }
  if (data.byteLength > maxBytes) {
    throw new AppError('CONTENT_TOO_LARGE', 'Content exceeds the maximum export size', { status: 413, details: { bytes: data.byteLength, maxBytes } });
  }
  // Capture bytes before the first await; metadata must describe precisely this
  // payload even if a caller later reuses or changes its original buffer.
  const payload = Buffer.from(data);
  const result = { filePath: file, bytes: payload.byteLength, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
  const fileSystem = options.fs ?? fs;
  let temporary;
  let handle;
  let ownsTemporary = false;
  let stage = 'destination-check';
  try {
    await checkDestination(fileSystem, file);
    stage = 'open';
    for (let attempt = 0; attempt < TEMPORARY_ATTEMPTS; attempt += 1) {
      const nonce = options.randomId?.() ?? crypto.randomUUID();
      if (typeof nonce !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(nonce)) throw new AppError('VALIDATION_ERROR', 'Invalid content export temporary identifier', { status: 400 });
      // A fixed-length prefix avoids exceeding filesystem name limits when the
      // user selects an otherwise valid, long destination filename.
      temporary = path.join(path.dirname(file), `.satoshi-content-${nonce}.tmp`);
      try {
        handle = await fileSystem.open(temporary, 'wx', 0o600);
        ownsTemporary = true;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === TEMPORARY_ATTEMPTS - 1) throw error;
      }
    }
    stage = 'write';
    await handle.writeFile(payload);
    stage = 'sync';
    await handle.sync();
    stage = 'close';
    await handle.close();
    handle = null;
    stage = 'destination-check';
    await checkDestination(fileSystem, file);
    stage = 'rename';
    await fileSystem.rename(temporary, file);
    return result;
  } catch (error) {
    const cleanupErrors = [];
    try { await handle?.close(); }
    catch (cleanupError) { cleanupErrors.push({ stage: 'close', ...serializeFileError(cleanupError) }); }
    if (ownsTemporary) {
      try { await fileSystem.unlink(temporary); }
      catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') cleanupErrors.push({ stage: 'unlink', ...serializeFileError(cleanupError) });
      }
    }
    const normalized = serializeFileError(error);
    throw new AppError('CONTENT_SAVE_FAILED', `Content was not saved: ${normalized.message}`, {
      status: error?.code === 'ENOSPC' ? 507 : normalized.status,
      cause: error,
      details: {
        contentMutationCommitted: false,
        stage,
        cause: normalized,
        ...(typeof error?.code === 'string' ? { filesystemCode: error.code } : {}),
        ...(cleanupErrors.length ? { cleanupErrors, temporaryPath: temporary } : {})
      }
    });
  }
}
