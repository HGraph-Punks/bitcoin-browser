const INTERNAL_SCHEMES = new Set(['app:', 'ord:', 'data:', 'blob:', 'devtools:']);
export const CONTENT_NETWORK_REQUEST_FILTER = Object.freeze({
  urls: Object.freeze(['*://*/*', 'ws://*/*', 'wss://*/*'])
});

export function effectiveContentNetworkPolicy(settings = {}) {
  if (settings?.offlineMode) return 'blocked';
  return settings?.contentNetworkPolicy === 'https-only' ? 'https-only' : 'blocked';
}

export function createContentNetworkPolicyApplier(closeConnections) {
  let cutoffPending = false;
  return async (previousSettings, nextSettings) => {
    const previousPolicy = effectiveContentNetworkPolicy(previousSettings);
    const nextPolicy = effectiveContentNetworkPolicy(nextSettings);
    if (nextPolicy !== 'blocked') {
      cutoffPending = false;
      return;
    }
    if (previousPolicy === 'https-only') cutoffPending = true;
    if (!cutoffPending) return;
    await closeConnections();
    cutoffPending = false;
  };
}

export function isContentRequestAllowed(details, settings = {}) {
  let scheme;
  try { scheme = new URL(details?.url).protocol; } catch { return false; }
  if (INTERNAL_SCHEMES.has(scheme)) return true;
  if (!['https:', 'wss:'].includes(scheme)) return false;
  return effectiveContentNetworkPolicy(settings) === 'https-only' && details?.resourceType !== 'mainFrame';
}
