// Read already-computed health from main. This adds no provider network traffic
// and never starts services, changes routing, or accesses credentials.
export function createProviderStatusMonitor({ enabled, refresh, schedule = setTimeout, cancel = clearTimeout, intervalMs = 5_000 }) {
  let started = false;
  let timer = null;
  let pending = false;
  const scheduleNext = () => {
    if (started && timer === null) timer = schedule(tick, intervalMs);
  };
  async function tick() {
    timer = null;
    if (!started || pending) return;
    pending = true;
    try { if (enabled()) await refresh(); }
    catch { /* Keep the last checked status; a manual check reports IPC errors. */ }
    finally { pending = false; scheduleNext(); }
  }
  return {
    start() { if (started) return; started = true; scheduleNext(); },
    stop() { started = false; if (timer !== null) cancel(timer); timer = null; }
  };
}
