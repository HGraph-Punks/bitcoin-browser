import { createBoundedOutput } from './startup-diagnostic-support.mjs';

export function createPackagedOutput({ totalBytes = 256 * 1024, launchBytes = 128 * 1024 } = {}) {
  const total = createBoundedOutput(totalBytes);
  const launches = [];
  return {
    start(launch, pid) {
      const capture = createBoundedOutput(launchBytes);
      launches.push({ launch, pid, capture });
      return {
        append(source, chunk) {
          const entry = `[launch:${launch} pid:${pid ?? 'unknown'} ${source}] ${String(chunk)}`;
          capture.append(entry);
          total.append(entry);
        },
        get text() { return capture.text; }
      };
    },
    get text() { return total.text; },
    snapshot() {
      return {
        truncated: total.truncated || launches.some(({ capture }) => capture.truncated),
        totalBytesSeen: total.totalBytesSeen,
        retainedBytes: Buffer.byteLength(total.text),
        launches: launches.map(({ launch, pid, capture }) => ({ launch, pid, truncated: capture.truncated, totalBytesSeen: capture.totalBytesSeen }))
      };
    }
  };
}
