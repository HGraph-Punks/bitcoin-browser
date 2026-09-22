// Presentation only. Mirror the general routing exclusions without performing
// a health check, reading credentials or claiming support for a specific asset.
export function providerHealthPresentation(provider = {}) {
  const health = provider.health;
  const error = health?.error;
  if (provider.routingBlocked) return { label: 'SIGN-IN RECOVERY NEEDED', tone: 'bad', message: '' };
  if (!provider.enabled) return { label: 'DISABLED', tone: '', message: '' };
  if (!health) return { label: 'UNCHECKED', tone: '', message: '' };
  if (health.ok) {
    if (provider.type === 'bitcoin-core' && health.initialBlockDownload) {
      const progress = Number.isFinite(health.verificationProgress)
        ? ` · ${(Math.max(0, Math.min(1, health.verificationProgress)) * 100).toFixed(1)}%` : '';
      return { label: `SYNCING${progress}`, tone: 'good', message: 'Connected to Bitcoin Core. Initial sync is still running, so some local lookups are not available yet.' };
    }
    return { label: `${health.latencyMs ?? '—'} ms`, tone: 'good', message: '' };
  }
  if (provider.type === 'bitcoin-core') {
    if (error?.code === 'PROVIDER_COOKIE_UNAVAILABLE') return { label: 'STOPPED OR STARTING', tone: 'warn',
      message: 'Core has not made its local sign-in file available. Start your node in Local node, or wait for startup. Status updates automatically; no password change is needed.' };
    if (error?.code === 'PROVIDER_WARMING_UP') return { label: 'STARTING', tone: 'warn',
      message: 'Core is loading its blockchain data. Keep it running; the browser will reconnect automatically.' };
    if (error?.code === 'PROVIDER_COOKIE_ACCESS_DENIED') return { label: 'FILE ACCESS NEEDED', tone: 'bad',
      message: 'The browser cannot access Core’s sign-in file. Review the cookie file location and folder permissions; do not reinstall or delete node data.' };
    if (error?.code === 'PROVIDER_COOKIE_READ_FAILED') return { label: 'CHECK SIGN-IN FILE', tone: 'bad',
      message: 'Core’s sign-in file could not be read. Review the cookie file location in this source’s settings.' };
    if (error?.code === 'PROVIDER_AUTH_ERROR') return { label: 'SIGN-IN REJECTED', tone: 'bad',
      message: 'Core rejected the connection credentials. Check that the RPC address and sign-in file belong to the same running node.' };
  }
  return { label: error?.code ?? 'UNHEALTHY', tone: 'bad', message: '' };
}

export function sourceStatus(model = {}) {
  const settings = model.settings ?? {};
  const configured = (Array.isArray(model.providers) ? model.providers : []).filter(provider => provider?.enabled && provider.network === settings.network);
  const allowed = configured.filter(provider => !settings.localOnly || provider.local === true);
  const eligible = allowed.filter(provider => !provider.routingBlocked);
  const healthy = eligible.filter(provider => provider.health?.ok === true).length;
  const failed = eligible.length > 0 && eligible.every(provider => provider.health?.ok === false);
  const waiting = failed && eligible.every(provider => provider.type === 'bitcoin-core' && provider.local === true
    && ['PROVIDER_COOKIE_UNAVAILABLE', 'PROVIDER_WARMING_UP'].includes(provider.health?.error?.code));
  const demo = eligible.length > 0 && eligible.every(provider => provider.type === 'mock');
  let tone = 'unknown', label = 'Sources not checked', title = 'Source check pending', notice = '';
  if (settings.offlineMode) {
    tone = 'warn'; label = 'Offline · cached pages only'; title = 'Offline';
    notice = 'You’re offline. Only previously cached content is available.';
  } else if (!configured.length) {
    tone = 'warn'; label = 'No enabled data sources'; title = 'Choose a data source';
    notice = 'No data sources are enabled for this network. Review sources to look up new items.';
  } else if (!allowed.length) {
    tone = 'warn'; label = 'No enabled local sources'; title = 'Local source needed';
    notice = 'Local-only browsing is on, but no local sources are enabled for this network. Remote data sources will not be used.';
  } else if (!eligible.length) {
    tone = 'warn'; label = 'Source setup needs attention'; title = 'Review source setup';
    notice = 'The enabled sources are updating or need setup recovery before browsing can resume. Review Data sources; this page will not change credentials.';
  } else if (demo) {
    tone = 'warn'; label = 'Demo sources only'; title = 'Demo data';
    notice = 'Only demo sources are available. These show test data, not live Bitcoin records.';
  } else if (waiting) {
    tone = 'warn'; label = 'Waiting for local node'; title = 'Local node not ready';
    notice = 'Start your node in Local node, or wait for Core to finish starting. Source status updates automatically.';
  } else if (failed) {
    tone = 'fail'; label = 'Source checks failed'; title = 'Check data sources';
    notice = 'Data sources need attention. None passed their last health check. You can retry a lookup or review sources.';
  } else if (healthy) {
    tone = 'ok'; label = `${healthy} source${healthy === 1 ? '' : 's'} passed last check`; title = 'Sources checked';
  }
  if (settings.localOnly && !notice) notice = 'Local-only browsing is on. Remote data sources will not be used.';
  return { eligible: eligible.length, healthy, failed, demo, tone, label, title, notice };
}

export function lookupRecovery(error = {}, settings = {}) {
  if (error.code === 'OFFLINE_CACHE_MISS') return {
    title: 'This page isn’t saved offline', message: 'Only previously cached pages can open in offline mode. You can change offline mode in Settings, or browse something already saved.', action: 'Review offline mode', route: 'satnav://settings'
  };
  if (settings.offlineMode) return {
    title: 'The saved page could not be read', message: 'This is a cache-read problem, not proof the page was never saved. Retry, or review storage and offline settings. No replacement data has been shown.', action: 'Review settings', route: 'satnav://settings'
  };
  if (error.code === 'NO_PROVIDER') return {
    title: 'A compatible data source is needed', message: 'Check that a source supports this type of lookup on your selected network. Local-only mode also excludes remote sources.', action: 'Review data sources', route: 'satnav://providers'
  };
  if (['NOT_FOUND', 'INSCRIPTION_NOT_FOUND'].includes(error.code)) return {
    title: 'No result from this data source', message: 'Check the identifier and Bitcoin network, then retry or choose another source. This does not prove the item does not exist.', action: 'Review data sources', route: 'satnav://providers'
  };
  if (['PROVIDER_TIMEOUT', 'ETIMEDOUT', 'NETWORK_TIMEOUT'].includes(error.code)) return {
    title: 'The data source is taking too long', message: 'Your browsing controls still work. Try again, or review your data sources if this keeps happening.', action: 'Review data sources', route: 'satnav://providers'
  };
  if (error.code === 'RESOURCE_TOO_LARGE') return {
    title: 'This item exceeds a browser limit', message: 'The request stopped at a configured size limit. Review the technical details before changing resource limits in Settings.', action: 'Review limits', route: 'satnav://settings'
  };
  return { title: 'This page couldn’t be loaded', message: 'Retry the lookup, or check your data source and Bitcoin network. Your other tabs and browsing tools are still available.', action: 'Review data sources', route: 'satnav://providers' };
}
