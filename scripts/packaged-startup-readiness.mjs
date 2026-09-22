import fs from 'node:fs/promises';

export const MAX_STARTUP_LOG_BYTES = 128 * 1024;

export function hasShellDocumentLoaded(text, pid, startedAt) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_STARTUP_LOG_BYTES
    || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedAt)) return false;
  return text.split('\n').some((line) => {
    if (!line || line.length > 4096) return false;
    let record;
    try { record = JSON.parse(line); } catch { return false; }
    return record?.event === 'app.shell_document_loaded' && record.pid === pid
      && record.location === 'app://app/renderer/index.html'
      && Number.isSafeInteger(record.webContentsId) && record.webContentsId > 0
      && typeof record.time === 'string' && Date.parse(record.time) >= startedAt;
  });
}

export async function readShellDocumentLoaded(logFile, pid, startedAt) {
  let handle;
  try { handle = await fs.open(logFile, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Startup log must be a regular file');
    const start = Math.max(0, stat.size - MAX_STARTUP_LOG_BYTES);
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_STARTUP_LOG_BYTES));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    // A bounded tail may begin halfway through a prior record. Discard it;
    // startup evidence must be a complete logger record for this exact child.
    const tail = bytes.subarray(0, bytesRead).toString('utf8');
    const complete = start > 0 ? tail.slice(tail.indexOf('\n') + 1) : tail;
    return hasShellDocumentLoaded(complete, pid, startedAt);
  } finally { await handle.close(); }
}
