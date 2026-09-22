import {
  absoluteTime,
  badge,
  bookmarkButton,
  button,
  emptyState,
  formatBytes,
  formatNumber,
  h,
  listRow,
  pageHeader,
  safeJson,
  shorten,
  targetIcon,
  timeAgo
} from './dom.js';
import { renderLookup, searchSavedItems } from './search.js';
import { providerRecoveryExplanation, providerRecoveryReview } from '../shared/provider-recovery.js';
import { createInscriptionDisplay } from './inscription-display.js';
import { INSCRIPTION_DISPLAY_ID } from '../shared/inscription-presentation.js';
import { renderInscriptionHighlights, renderInscriptionCollectorDetails } from './collector-insights.js';
import { sourceStatus, lookupRecovery, providerHealthPresentation } from './source-status.js';
export { renderAbout } from './about.js';
export { renderSponsors } from './sponsors.js';

let nextViewerInfoId = 0;

function section(title, description, content, actions = []) {
  return h('section', { className: 'section' },
    h('div', { className: 'section-heading' },
      h('div', {}, h('h2', {}, title), description ? h('p', {}, description) : null),
      actions.length ? h('div', { className: 'page-actions' }, actions) : null
    ),
    content
  );
}

function card(label, value, subtext, options = {}) {
  return h(options.onClick ? 'button' : 'article', {
    className: `card${options.onClick ? ' interactive' : ''}`,
    type: options.onClick ? 'button' : null,
    onClick: options.onClick
  },
  h('div', { className: 'card-label' }, label, options.trailing ?? null),
  h('div', { className: 'metric' }, value),
  h('div', { className: 'metric-sub' }, subtext));
}

function cacheDisplayValue(kind, cache) {
  if (kind === 'bytes') return formatBytes(cache?.bytes ?? 0);
  if (kind === 'entries') return `${formatNumber(cache?.entries ?? 0)} cached resources`;
  if (kind === 'used') return `${formatBytes(cache?.bytes ?? 0)} currently used.`;
  return null;
}

function cacheMetric(kind, cache) {
  return h('span', { dataset: { cacheValue: kind } }, cacheDisplayValue(kind, cache));
}

export function updateCacheViews(root, cache) {
  if (!root?.querySelectorAll) return 0;
  let updated = 0;
  for (const node of root.querySelectorAll('[data-cache-value]')) {
    const value = cacheDisplayValue(node.dataset.cacheValue, cache);
    if (value === null) continue;
    // Retain the metric/control nodes; unchanged replies need no DOM mutation.
    if (node.textContent !== value) node.textContent = value;
    updated += 1;
  }
  return updated;
}

export function humanValue(key, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (/bytes|size|length/i.test(key) && Number.isFinite(Number(value))) return formatBytes(Number(value));
  if (/^(?:timestamp|time)$/i.test(key) || /At$/.test(key)) {
    const numeric = Number(value);
    const normalized = Number.isFinite(numeric) && numeric < 10_000_000_000 ? numeric * 1_000 : value;
    const text = absoluteTime(normalized);
    if (text !== '—') return text;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'object') return safeJson(value);
  if (/height|count|number|fee|weight|value|funded|spent/i.test(key) && /^-?\d+$/.test(String(value))) return formatNumber(value);
  return String(value);
}

function summaryGrid(summary = {}) {
  const entries = Object.entries(summary).filter(([, value]) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0));
  if (!entries.length) return h('p', { className: 'help' }, 'This source did not return a normalized summary for the target. Raw provider data remains available in the protocol inspector.');
  return h('div', { className: 'summary-grid' }, entries.map(([key, value]) => h('div', { className: 'summary-item' },
    h('span', {}, key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())),
    h('strong', { className: typeof value === 'string' && value.length > 28 ? 'mono' : '' }, humanValue(key, value))
  )));
}

function keyValueList(entries) {
  return h('dl', { className: 'provenance' }, entries.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([key, value]) => h('div', { className: 'key-value' },
    h('dt', {}, key), h('dd', { className: String(value).length > 35 ? 'mono' : '' }, humanValue(key, value))
  )));
}

function routeList(items, ctx, empty) {
  if (!items.length) return empty;
  return h('div', { className: 'list' }, items.map((item) => listRow({
    icon: targetIcon(item.kind),
    title: item.title || item.canonical,
    subtitle: item.canonical,
    meta: item.visitedAt ? timeAgo(item.visitedAt) : item.createdAt ? timeAgo(item.createdAt) : null,
    onClick: () => ctx.navigate(item.canonical)
  })));
}

export function renderHomeLibrarySection(library, model, ctx) {
  const history = library === 'history';
  const items = (history ? model.history : model.bookmarks).slice(0, 6);
  const node = history
    ? section('Recent', null, routeList(items, ctx, h('p', { className: 'home-library-empty' }, 'No browsing history yet. Places you open will appear here.')),
      [button('All history', { small: true, onClick: () => ctx.navigate('satnav://history') })])
    : section('Bookmarks', null, routeList(items, ctx, h('p', { className: 'home-library-empty' }, 'No bookmarks yet. Use the star in the address bar to save a favorite.')),
      [button('All bookmarks', { small: true, onClick: () => ctx.navigate('satnav://bookmarks') })]);
  node.className = 'section home-library-section';
  node.dataset.homeLibrary = history ? 'history' : 'bookmarks';
  return node;
}

function homeBrowserStatus(model, ctx) {
  let current = model;
  const brief = h('span', { className: 'home-disclosure-hint' });
  const count = h('span');
  const health = h('span');
  const sourceMode = badge('');
  const network = h('span');
  const privacy = h('span');
  const connection = badge('');
  const noticeCopy = h('p');
  const noticeAction = button('Review data sources', { small: true,
    onClick: () => ctx.navigate(current.settings.offlineMode ? 'satnav://settings' : 'satnav://providers') });
  const notice = h('div', { className: 'home-source-notice', role: 'status' }, noticeCopy, noticeAction);
  const details = h('details', { className: 'home-disclosure home-system' },
    h('summary', {}, h('span', {}, 'Browser status'), brief),
    h('div', { className: 'card-grid home-system-grid' },
      card('Data sources', count, health, { onClick: () => ctx.navigate('satnav://providers'), trailing: sourceMode }),
      card('Content cache', cacheMetric('bytes', model.cache), cacheMetric('entries', model.cache), { onClick: () => ctx.navigate('satnav://settings') }),
      card('Network', network, privacy, { onClick: () => ctx.navigate('satnav://settings'), trailing: connection })));
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  function update(next) {
    current = next;
    const settings = next.settings;
    const status = sourceStatus(next);
    const { healthy, failed } = status;
    const networkName = String(settings.network).toUpperCase();
    setText(count, `${healthy}/${status.eligible}`);
    setText(health, healthy ? 'passed their last health check' : failed ? 'last health checks failed' : 'no successful health check yet');
    setText(sourceMode, settings.localOnly ? 'LOCAL ONLY' : 'AUTO');
    sourceMode.className = `badge${settings.localOnly ? ' good' : ''}`;
    setText(network, networkName);
    setText(privacy, settings.offlineMode ? 'offline cache-only mode' : settings.privacyMode + ' privacy');
    setText(connection, settings.offlineMode ? 'OFFLINE' : 'LOOKUPS ENABLED');
    connection.className = `badge${settings.offlineMode ? ' warn' : ''}`;
    setText(brief, `${networkName} · ${settings.offlineMode ? 'Offline' : settings.localOnly ? 'Local only' : 'Sources & storage'}`);
    const message = status.notice;
    const networkNotice = settings.network !== 'mainnet' ? `You’re browsing ${networkName}, not Bitcoin mainnet. ` : '';
    setText(noticeCopy, networkNotice + message);
    setText(noticeAction, settings.offlineMode ? 'Review offline mode' : 'Review data sources');
    notice.className = `home-source-notice${networkNotice || message ? '' : ' hidden'}`;
  }
  update(model);
  return { notice, details, update };
}

export function renderHome(model, ctx) {
  const status = homeBrowserStatus(model, ctx);
  const owner = model.activeTabId;
  const navigation = model.requestSequence?.[owner];
  const root = h('div', { className: 'home-page' },
    h('section', { className: 'home-hero', ariaLabel: 'Search Bitcoin' },
      h('h1', {}, 'Find your way around Bitcoin.'),
      h('p', { className: 'home-intro' }, 'Discover inscriptions and Runes, or look up something you know.'),
      h('p', { className: 'home-reassurance' }, 'No wallet required. Running your own node is optional.'),
      renderLookup(ctx, { simple: true })
    ),
    status.notice,
    h('section', { className: 'home-explore', ariaLabel: 'Explore Bitcoin' },
      h('div', { className: 'home-destination' },
        button('Explore inscriptions', { className: 'home-destination-button', icon: '◈', onClick: () => ctx.navigate('satnav://inscriptions') }),
        h('p', {}, 'Browse art, images and on-chain artifacts.')),
      h('div', { className: 'home-destination' },
        button('Explore Runes', { className: 'home-destination-button', icon: 'ᚱ', onClick: () => ctx.navigate('satnav://runes') }),
        h('p', {}, 'Find tokens and understand their details.')),
      h('div', { className: 'home-destination' },
        button('Ask Bitcoin', { className: 'home-destination-button', icon: '✧', onClick: () => ctx.openAiWorkspace ? ctx.openAiWorkspace() : ctx.navigate('satnav://ai') }),
        h('p', {}, 'Explore with your local AI. Connect LM Studio or Ollama to get started.'))),
    h('div', { className: 'home-library-grid' },
      renderHomeLibrarySection('history', model, ctx),
      renderHomeLibrarySection('bookmarks', model, ctx)),
    h('details', { className: 'home-disclosure home-tools' },
      h('summary', {}, h('span', {}, 'Tools & setup'), h('span', { className: 'home-disclosure-hint' }, 'Wallet, local node & shortcuts')),
      h('div', { className: 'home-tools-body' },
        h('div', { className: 'home-setup-link' },
          button('Set up a local node', { icon: '⛁', onClick: () => ctx.navigate('satnav://node-setup') }),
          h('p', {}, 'Optional: a guided setup for Bitcoin Core, Ord, both, or neither. You can browse without installing a node.')),
        h('div', { className: 'quick-targets', role: 'group', ariaLabel: 'Bitcoin shortcuts' }, [
        ['Genesis sat', 'sat:0'], ['Block height', '/r/blockheight'], ['Latest block hash', '/r/blockhash'], ['Wallet', 'satnav://wallet'], ['Local sources', 'satnav://providers']
        ].map(([label, target]) => h('button', { className: 'chip', type: 'button', onClick: () => ctx.navigate(target) }, label))),
        button('Browsing help', { small: true, onClick: () => ctx.navigate('satnav://documentation') }))),
    status.details
  );
  root.retainHome = (result, next) => {
    if (result.error || result.target?.kind !== 'home' || next.activeTabId !== owner || next.requestSequence?.[owner] !== navigation) return false;
    // Health/cache replies must not reset a typed query, native disclosure state,
    // focus or page scroll. Explicit navigation still creates a fresh view.
    status.update(next);
    updateCacheViews(root, next.cache);
    return true;
  };
  return root;
}

export function renderSearch(result, ctx) {
  const query = String(result.target.value ?? '');
  const matches = searchSavedItems(ctx.model, query);
  return h('div', {},
    pageHeader('Search saved items', query ? `Results for “${query}”` : 'History and bookmarks', 'Matches come from this device. No query is sent to a search service; this is not a search of every inscription on Bitcoin.'),
    renderLookup(ctx, { query, mode: 'saved' }),
    section('From your history and bookmarks', `${matches.total} matching item${matches.total === 1 ? '' : 's'}${matches.total > matches.items.length ? `; showing the first ${matches.items.length}` : ''}.`,
      matches.items.length ? h('div', { className: 'list' }, matches.items.map((item) => listRow({
        icon: targetIcon(item.kind), title: item.title, subtitle: item.canonical, meta: item.origins.join(' · '), onClick: () => ctx.navigate(item.canonical)
      }))) : emptyState('⌕', 'No saved matches', 'Try a shorter phrase, or choose a lookup type above if you have an inscription number or Bitcoin identifier.'),
      [button('Refresh results', { small: true, onClick: () => ctx.navigate(`search:${query}`, { record: false }) })]),
    section('Looking for new inscriptions?', 'Explore the inscription gallery to browse your source’s index, or open a known inscription by number or ID. Global keyword search is not available.',
      h('div', { className: 'page-actions' }, button('Explore inscriptions', { primary: true, onClick: () => ctx.navigate('satnav://inscriptions') }), button('Data sources', { onClick: () => ctx.navigate('satnav://providers') }), button('Lookup help', { onClick: () => ctx.navigate('satnav://documentation') })))
  );
}

export function renderCollection(result, ctx) {
  const query = String(result.target.value ?? '').toLowerCase();
  const matches = [...ctx.model.bookmarks, ...ctx.model.history].filter((entry, index, all) => {
    const first = all.findIndex((candidate) => candidate.canonical === entry.canonical);
    return first === index && `${entry.title} ${entry.canonical}`.toLowerCase().includes(query);
  });
  return h('div', {},
    pageHeader('Collection', result.target.value, 'Collection metadata is provider-specific. This local view surfaces matching bookmarks and history without coupling the browser to one marketplace.'),
    routeList(matches, ctx, emptyState('▤', 'No local matches', 'Add provider adapters for collection-specific indexing while preserving the normalized browser model.'))
  );
}

export function renderEntity(result, ctx) {
  const { target, entity, attempts = [] } = result;
  if (!entity) return renderSearch(result, ctx);
  const title = target.display || entity.canonical;
  const source = entity.source ?? {};
  const related = entity.links ?? [];
  return h('div', {},
    pageHeader(target.kind.replace(/-/g, ' '), title, entity.canonical, [
      button('Copy identifier', { icon: '⧉', onClick: () => ctx.copy(entity.canonical) }),
      bookmarkButton(entity.canonical, ctx.isBookmarked(entity.canonical), { onClick: () => ctx.toggleBookmark() }),
      button('Inspect', { icon: '{ }', onClick: () => ctx.openDeveloper('raw') })
    ]),
    h('div', { className: 'entity-layout' },
      h('div', { className: 'entity-main' },
        h('article', { className: 'card' }, h('div', { className: 'card-label' }, 'Key details', badge(entity.network?.toUpperCase() ?? 'BITCOIN')), summaryGrid(entity.summary)),
        related.length ? h('article', { className: 'card' }, h('h2', {}, 'Related locations'), h('div', { className: 'link-list section' }, related.map((link) => h('button', {
          className: 'entity-link', type: 'button', onClick: () => ctx.navigate(`${link.kind}:${link.value}`)
        }, h('span', {}, targetIcon(link.kind)), h('strong', {}, link.title ?? link.value), h('span', {}, '→'))))) : null,
        h('details', { className: 'card entity-technical' },
          h('summary', {}, 'Raw data & developer tools'),
          h('p', {}, 'View the complete record and original source response in the inspector.'),
          h('div', { className: 'form-actions' }, button('Open raw data', { onClick: () => ctx.openDeveloper('raw') }))
        )
      ),
      h('aside', { className: 'entity-side' },
        h('article', { className: 'card' }, h('div', { className: 'card-label' }, 'Data source', badge('SNAPSHOT')), h('p', { className: 'help' }, 'Source-provided data, not an independent verification badge.'), keyValueList([
          ['Source', source.name], ['Provider ID', source.id], ['Provider type', source.type], ['Endpoint', source.endpoint], ['Latency', source.latencyMs == null ? null : `${source.latencyMs} ms`], ['Fetched', entity.fetchedAt]
        ])),
        h('article', { className: 'card' }, h('div', { className: 'card-label' }, 'Resolution', badge(attempts.length ? attempts.some((attempt) => !attempt.ok) ? 'FALLBACK USED' : 'DIRECT' : 'NO SOURCE REQUEST', attempts.some((attempt) => !attempt.ok) ? 'warn' : '')),
          h('p', {}, attempts.length ? `${attempts.length} source attempt${attempts.length === 1 ? '' : 's'} recorded for this navigation.` : 'No source request recorded for this navigation. The record may have been served locally or from cache.'),
          h('div', { className: 'form-actions' }, button('View attempts', { small: true, onClick: () => ctx.openDeveloper('requests') })))
      )
    )
  );
}

export function renderInscription(result, ctx) {
  const entity = result.entity ?? {};
  const summary = entity.summary ?? {};
  const target = result.target;
  const candidate = summary.id || (target.kind === 'inscription' || target.kind === 'content' ? target.value : null);
  const inscriptionId = INSCRIPTION_DISPLAY_ID.test(candidate ?? '') ? String(candidate).toLowerCase() : null;
  const sourceUrl = target.kind === 'recursive' && /^ord:\/\/(?:r|content)\//.test(target.canonical)
    ? target.canonical : inscriptionId ? `ord://content/${inscriptionId}` : null;
  const contentType = summary.contentType ?? entity.data?.contentType ?? '';
  const title = summary.number != null ? `Inscription #${formatNumber(summary.number)}` : inscriptionId ? 'Inscription' : target.display;
  const display = createInscriptionDisplay({ inscriptionId, sourceUrl, contentType, title, loading: !result.entity }, ctx);
  const owner = String(ctx.model?.activeTabId ?? '');
  const infoId = `inscription-details-${++nextViewerInfoId}`;
  const info = h('aside', { className: 'viewer-info', id: infoId, ariaLabel: 'Inscription details', hidden: true },
    h('h2', {}, 'About this inscription'),
    h('div', { className: 'security-strip' }, 'Isolated preview. Original content has no access to the browser shell or your wallet.'),
    renderInscriptionCollectorDetails(entity, ctx),
    h('details', { className: 'viewer-source-details' }, h('summary', {}, 'Source & technical details'),
      summaryGrid(summary),
      keyValueList([['Provider', entity.source?.name], ['Endpoint', entity.source?.endpoint], ['Network', entity.network], ['Fetched', entity.fetchedAt]]),
      h('p', { className: 'help' }, 'Opaque sandbox: original inscription scripts receive no browser-shell or wallet authority. External networking is blocked by default; compatibility mode is an explicit setting.')),
    inscriptionId ? button('Copy inscription ID', { small: true, onClick: () => ctx.copy(inscriptionId) }) : null);
  let expanded = false;
  const detailsButton = button('Details', { small: true, icon: 'ⓘ', onClick: () => {
    expanded = !expanded; info.hidden = !expanded;
    root.dataset.details = String(expanded);
    detailsButton.setAttribute('aria-expanded', String(expanded));
  } });
  detailsButton.setAttribute('aria-controls', infoId);
  detailsButton.setAttribute('aria-expanded', 'false');
  const root = h('div', { className: 'inscription-page viewer-enhanced', dataset: { details: 'false' } },
    h('header', { className: 'viewer-header' },
      h('span', { className: 'row-icon', 'aria-hidden': 'true' }, '◈'),
      h('div', { className: 'viewer-title' }, h('strong', {}, title),
        h('span', { title: inscriptionId ?? target.canonical }, `${contentType || 'On-chain content'}${inscriptionId ? ` · ${shorten(inscriptionId, 10, 5)}` : ''}`)),
      h('div', { className: 'viewer-actions' },
        inscriptionId ? button('Save', { small: true, onClick: () => ctx.saveContent(inscriptionId) }) : null,
        bookmarkButton(target.canonical, ctx.isBookmarked(target.canonical), { compact: true, onClick: () => ctx.toggleBookmark() }),
        detailsButton,
        h('details', { className: 'viewer-more' }, h('summary', {}, 'More'),
          h('div', { className: 'viewer-more-panel' },
            inscriptionId ? button('Record', { small: true, onClick: () => ctx.navigate(`inscription:${inscriptionId}`) }) : null,
            inscriptionId ? button('Graph', { small: true, onClick: () => ctx.openDeveloper('graph') }) : null,
            button('Inspect', { small: true, onClick: () => ctx.openDeveloper('raw') }))))),
    renderInscriptionHighlights(entity, ctx),
    display.toolbar,
    h('div', { className: 'viewer-workspace' }, display.canvas, info));
  const policyKey = model => JSON.stringify(['network', 'localOnly', 'offlineMode', 'preferredProviderId', 'contentNetworkPolicy', 'maxResourceBytes'].map(key => model?.settings?.[key]));
  const policy = policyKey(ctx.model);
  root.retainInscription = (nextResult, model) => nextResult.target.canonical === target.canonical
    && nextResult.target.kind === target.kind && nextResult.entity === result.entity && !nextResult.error
    && owner === String(model?.activeTabId ?? '') && policyKey(model) === policy;
  root.dispose = () => display.dispose();
  root.contentReady = () => display.ready;
  return root;
}

export function renderHistory(model, ctx) {
  return h('div', {},
    pageHeader('Library', 'History', 'Local navigation history is stored on this device and never sent as telemetry.', model.history.length ? [button('Clear history', { danger: true, onClick: ctx.clearHistory })] : []),
    routeList(model.history, ctx, emptyState('◴', 'History is empty', 'Browse any Bitcoin target to begin building a local trail.'))
  );
}

export function renderBookmarks(model, ctx) {
  return h('div', {},
    pageHeader('Library', 'Bookmarks', 'Saved Bitcoin-native locations, independent of any single explorer or data source.'),
    routeList(model.bookmarks, ctx, emptyState('☆', 'No bookmarks', 'Navigate to a sat, inscription, transaction, block, output, address, or recursive resource and select the star.'))
  );
}

function toggleControl(value, label, onClick) {
  return h('button', { className: `toggle${value ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(Boolean(value)), ariaLabel: label, onClick });
}

export function updateProviderHealthViews(root, providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  for (const card of root.querySelectorAll('[data-provider-card]')) {
    const provider = byId.get(card.dataset.providerCard);
    if (!provider) continue;
    const presentation = providerHealthPresentation(provider);
    const status = card.querySelector('[data-provider-indicator]');
    const health = card.querySelector('[data-provider-health]');
    const help = card.querySelector('[data-provider-health-help]');
    status.className = `provider-status${presentation.tone === 'good' ? ' ok' : presentation.tone === 'bad' ? ' fail' : ''}`;
    if (health.textContent !== presentation.label) health.textContent = presentation.label;
    health.className = `badge${presentation.tone ? ` ${presentation.tone}` : ''}`;
    health.title = provider.health?.error?.code ?? '';
    if (help.textContent !== presentation.message) help.textContent = presentation.message;
    help.className = `help${presentation.message ? '' : ' hidden'}`;
  }
}

export function renderProviders(model, ctx) {
  const networkProviders = model.providers.filter((provider) => provider.network === model.settings.network);
  const recovery = ctx.providerMutationRecovery?.();
  const refreshing = ctx.providerSnapshotPending?.() ?? false;
  const blocked = Boolean(recovery || refreshing);
  const cleanups = ctx.providerCleanupFailures?.() ?? [];
  return h('div', {},
    pageHeader('Infrastructure', 'Data sources', 'Capability-aware routing keeps the interface independent from any provider. The preferred source is tried first; healthy compatible fallbacks remain available.', [
      button('Health check', { icon: '↻', onClick: ctx.refreshProviders }),
      button('Add source', { primary: true, icon: '+', disabled: blocked, onClick: () => ctx.openProviderModal() })
    ]),
    recovery || refreshing ? h('div', { className: 'warning-box', role: 'status' },
      h('p', {}, recovery?.message ?? 'Refreshing source state.'),
      button('Refresh source state', { disabled: refreshing, onClick: ctx.recoverProviderSnapshot })) : null,
    ...cleanups.map((entry) => {
      const conflict = entry.conflict || model.providers.some((provider) => provider.id === entry.id);
      return h('div', { className: 'warning-box', role: 'status' },
        h('p', {}, conflict
          ? `Cleanup for source ID ${entry.id} conflicts with a configured source. Review that source’s configuration; deletion is unavailable.`
          : `Source ${entry.id} was removed, but retained sign-in storage needs cleanup. ${entry.message}`),
        !conflict && entry.token ? button('Review credential cleanup', { ariaLabel: `Review credential cleanup for ${entry.id}`, disabled: blocked || Boolean(ctx.providerMutationPending?.(entry.id)), onClick: () => ctx.retryProviderCleanup(entry.id) }) : null);
    }),
    h('details', {}, h('summary', {}, 'Review an older removed source'),
      h('p', { className: 'help' }, 'If you know an exact source ID from older saved data, review whether this app retains sign-in storage for it.'),
      button('Look up a source ID', { disabled: blocked, onClick: ctx.openProviderCleanupLookup })),
    h('div', { className: 'card-grid' },
      card('Routing policy', model.settings.localOnly ? 'Local only' : 'Automatic', model.settings.preferredProviderId ? `preferred: ${model.settings.preferredProviderId}` : 'best compatible source'),
      card('Network', model.settings.network.toUpperCase(), `${networkProviders.length} configured source${networkProviders.length === 1 ? '' : 's'}`),
      card('Mode', model.settings.offlineMode ? 'Offline' : 'Online', model.settings.offlineMode ? 'cache reads only' : 'network resolution enabled')
    ),
    section('Configured sources', 'Status updates automatically. Health is advisory; each navigation still records concrete resolution attempts.',
      networkProviders.length ? h('div', { className: 'provider-grid' }, networkProviders.map((provider) => {
        const presentation = providerHealthPresentation(provider);
        const preferred = model.settings.preferredProviderId === provider.id;
        const pending = Boolean(ctx.providerMutationPending?.(provider.id));
        const credentialExplanation = provider.routingBlocked ? providerRecoveryExplanation(provider) : null;
        const credentialRecovery = credentialExplanation ? providerRecoveryReview(provider) : null;
        const healthBadge = badge(presentation.label, presentation.tone);
        healthBadge.dataset.providerHealth = '';
        healthBadge.title = provider.health?.error?.code ?? '';
        return h('article', { className: 'provider-card', dataset: { providerCard: provider.id } },
          h('div', { dataset: { providerIndicator: '' }, className: `provider-status${presentation.tone === 'good' ? ' ok' : presentation.tone === 'bad' ? ' fail' : ''}` }, provider.local ? '⌂' : '≋'),
          h('div', { className: 'provider-copy' },
            h('strong', {}, provider.name, preferred ? ' ' : null, preferred ? badge('PREFERRED', 'good') : null),
            h('span', {}, provider.baseUrl || 'Built-in deterministic fixture provider'),
            h('div', { className: 'badges', style: { marginTop: '8px' } },
              badge(provider.type), badge(provider.local ? 'LOCAL' : 'REMOTE'),
              healthBadge,
              ...provider.capabilities.slice(0, 4).map((capability) => badge(capability)),
              provider.capabilities.length > 4 ? badge(`+${provider.capabilities.length - 4}`) : null
            ),
            credentialExplanation ? h('p', { className: 'help', role: 'status' }, credentialExplanation) : null,
            h('p', { className: `help${presentation.message ? '' : ' hidden'}`, dataset: { providerHealthHelp: '' }, role: 'status' }, presentation.message)
          ),
          h('div', { className: 'provider-actions' },
            h('span', { className: 'priority', title: 'Lower priority number is tried sooner' }, `P${provider.priority}`),
            credentialRecovery ? button('Recover source', { small: true, primary: true, disabled: blocked || pending, onClick: () => ctx.openProviderRecoveryModal(provider) }) : null,
            button(preferred ? 'Auto' : 'Prefer', { small: true, disabled: blocked || pending, onClick: () => ctx.setPreferred(preferred ? null : provider.id) }),
            button('Edit', { small: true, disabled: blocked || pending, onClick: () => ctx.openProviderModal(provider) }),
            h('button', { className: `toggle${provider.enabled ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(Boolean(provider.enabled)), ariaLabel: `Toggle ${provider.name}`, disabled: blocked || pending, onClick: () => ctx.toggleProvider(provider) })
          )
        );
      })) : emptyState('≋', 'No sources on this network', 'Add an ord server, Bitcoin Core RPC, mempool-compatible API, or another adapter.')
    ),
    section('Sovereignty controls', 'These controls never delete provider functionality; they narrow which sources may be contacted.',
      h('div', { className: 'settings-group' },
        settingRow('Local-only routing', 'Exclude all non-loopback providers while preserving their configuration.', toggleControl(model.settings.localOnly, 'Local-only routing', () => ctx.updateSettings({ localOnly: !model.settings.localOnly }))),
        settingRow('Offline mode', 'Cache-only provider and inscription requests. Wallet extensions use a separate network session.', toggleControl(model.settings.offlineMode, 'Offline mode', () => ctx.updateSettings({ offlineMode: !model.settings.offlineMode })))
      ))
  );
}

function settingRow(title, description, control) {
  return h('div', { className: 'setting-row' }, h('div', { className: 'setting-copy' }, h('strong', {}, title), h('span', {}, description)), control);
}

function selectControl(value, options, onChange, label) {
  return h('select', { value, ariaLabel: label, onChange: (event) => onChange(event.currentTarget.value) }, options.map(([optionValue, optionLabel]) => h('option', { value: optionValue, selected: optionValue === value }, optionLabel)));
}

function numberField(value, min, max, step, onChange, label) {
  return h('input', { className: 'field', type: 'number', value, min, max, step, ariaLabel: label, style: { width: '150px' }, onChange: (event) => onChange(Number(event.currentTarget.value)) });
}

function navigateSettingsSection(event) {
  const control = event.currentTarget;
  const layout = control.closest('.settings-layout');
  if (!layout?.isConnected) return;
  const targetId = control.getAttribute('aria-controls');
  const target = [...layout.querySelectorAll('.settings-group')].find((node) => node.id === targetId);
  const heading = target?.querySelector('h2');
  if (!heading) return;
  // Move keyboard navigation to the destination without an implicit scroll, then
  // honor the current OS preference even if it changed since this view rendered.
  heading.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'start'
  });
}

export function renderSettings(model, ctx) {
  const settings = model.settings;
  return h('div', {},
    pageHeader('Application', 'Settings', 'Simple defaults with every advanced control retained through progressive disclosure.', [button('Export diagnostics', { onClick: ctx.exportDiagnostics })]),
    h('div', { className: 'settings-layout' },
      h('nav', { className: 'settings-nav', ariaLabel: 'Settings sections' }, ['General', 'Privacy', 'Recursion', 'Storage', 'Developer'].map((name) => h('button', { type: 'button', 'aria-controls': `settings-${name.toLowerCase()}`, onClick: navigateSettingsSection }, name))),
      h('div', {},
        settingsGroup('settings-general', 'General', 'Network, appearance, and session behavior.', [
          settingRow('Bitcoin network', 'Controls provider eligibility and address formatting.', selectControl(settings.network, [['mainnet', 'Mainnet'], ['testnet', 'Testnet'], ['signet', 'Signet'], ['regtest', 'Regtest']], (network) => ctx.updateSettings({ network }), 'Bitcoin network')),
          settingRow('Theme', 'Use the operating-system theme or force an appearance.', selectControl(settings.theme, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], (theme) => ctx.updateSettings({ theme }), 'Theme')),
          settingRow('Restore tabs', 'Reopen the previous browser session on launch.', toggleControl(settings.restoreSession, 'Restore tabs', () => ctx.updateSettings({ restoreSession: !settings.restoreSession })))
        ]),
        settingsGroup('settings-privacy', 'Privacy and trust boundaries', 'Network access and content permissions are explicit.', [
          settingRow('Privacy profile', 'Strict favors local-only behavior; compatible retains safety boundaries while allowing more content.', selectControl(settings.privacyMode, [['strict', 'Strict'], ['balanced', 'Balanced'], ['compatible', 'Compatible']], (privacyMode) => ctx.updateSettings({ privacyMode }), 'Privacy profile')),
          settingRow('Inscription network policy', 'External HTTPS/WSS is opt-in and is blocked while browser offline mode is enabled.', selectControl(settings.contentNetworkPolicy, [['blocked', 'Blocked'], ['https-only', 'HTTPS only']], (contentNetworkPolicy) => ctx.updateSettings({ contentNetworkPolicy }), 'Content network policy')),
          settingRow('Local-only provider routing', 'Never contact a provider that is not loopback-local.', toggleControl(settings.localOnly, 'Local only', () => ctx.updateSettings({ localOnly: !settings.localOnly }))),
          settingRow('Offline cache-only mode', 'Cache-only provider and inscription requests; explicit misses. This does not disconnect wallet extensions.', toggleControl(settings.offlineMode, 'Offline mode', () => ctx.updateSettings({ offlineMode: !settings.offlineMode }))),
          settingRow('Telemetry', 'No analytics or telemetry transport is included in this beta build.', badge('NOT INCLUDED'))
        ]),
        settingsGroup('settings-recursion', 'Recursion guardrails', 'Bounds prevent malicious dependency graphs from exhausting the desktop.', [
          settingRow('Maximum graph depth', 'Developer graph inspection depth.', numberField(settings.maxRecursionDepth, 1, 128, 1, (maxRecursionDepth) => ctx.updateSettings({ maxRecursionDepth }), 'Maximum recursion depth')),
          settingRow('Maximum graph nodes', 'Upper bound on recursively inspected resources.', numberField(settings.maxRecursionNodes, 1, 10000, 1, (maxRecursionNodes) => ctx.updateSettings({ maxRecursionNodes }), 'Maximum recursion nodes')),
          settingRow('Concurrent content requests', 'Global resolver semaphore for inscription resources.', numberField(settings.maxConcurrentContentRequests, 1, 64, 1, (maxConcurrentContentRequests) => ctx.updateSettings({ maxConcurrentContentRequests }), 'Concurrent requests')),
          settingRow('Request timeout', 'Timeout for provider requests in milliseconds.', numberField(settings.requestTimeoutMs, 1000, 120000, 1000, (requestTimeoutMs) => ctx.updateSettings({ requestTimeoutMs }), 'Request timeout'))
        ]),
        settingsGroup('settings-storage', 'Storage', 'Cache limits are enforced on disk and safe to clear.', [
          settingRow('Cache capacity', cacheMetric('used', model.cache), selectControl(String(settings.cacheMaxBytes), [[String(256 * 1024 ** 2), '256 MB'], [String(1024 ** 3), '1 GB'], [String(5 * 1024 ** 3), '5 GB'], [String(20 * 1024 ** 3), '20 GB']], (value) => ctx.updateSettings({ cacheMaxBytes: Number(value) }), 'Cache capacity')),
          settingRow('Maximum single resource', 'Protects memory and disk from unexpectedly large responses.', selectControl(String(settings.maxResourceBytes), [[String(16 * 1024 ** 2), '16 MB'], [String(64 * 1024 ** 2), '64 MB'], [String(256 * 1024 ** 2), '256 MB'], [String(1024 ** 3), '1 GB']], (value) => ctx.updateSettings({ maxResourceBytes: Number(value) }), 'Maximum resource size')),
          settingRow('Clear cache', 'Removes downloaded recursive resources; bookmarks and history are unaffected.', button('Clear content cache', { danger: true, onClick: ctx.clearCache }))
        ]),
        settingsGroup('settings-developer', 'Developer', 'Protocol visibility remains available without cluttering default workflows.', [
          settingRow('Developer mode', 'Keeps the protocol inspector visible as a first-class tool.', toggleControl(settings.developerMode, 'Developer mode', () => ctx.updateSettings({ developerMode: !settings.developerMode }))),
          settingRow('Reveal data directory', 'Open the operating-system folder containing local state.', button('Reveal data', { onClick: () => ctx.revealPath('data') })),
          settingRow('Reveal logs', 'Open the local structured log directory.', button('Reveal logs', { onClick: () => ctx.revealPath('logs') }))
        ])
      )
    )
  );
}

function settingsGroup(id, title, description, rows) {
  return h('section', { className: 'settings-group', id, 'aria-labelledby': `${id}-heading` }, h('header', {}, h('h2', { id: `${id}-heading`, tabindex: -1 }, title), h('p', {}, description)), rows);
}

export function renderWallet(model, ctx) {
  const snapshot = model.wallet ?? { state: { connected: false, accounts: [] }, discovered: [], extensions: [] };
  const wallet = snapshot.state ?? { connected: false, accounts: [] };
  const signingEnabled = snapshot.signingEnabled === true;
  const extensionPending = ctx.extensionActionPending?.() ?? (snapshot.extensionsChanging ? 'manager' : null);
  const extensionRecovery = snapshot.extensionRecovery ?? ctx.extensionActionRecovery?.();
  return h('div', {},
    pageHeader('Security boundary', 'Wallet', 'Browsing arbitrary inscriptions never grants wallet authority. Wallet providers run in a separate persistent session and all signing requests cross a native confirmation boundary.', [
      button('Open bridge', { onClick: ctx.openWalletBridge }),
      button('Discover wallets', { primary: true, onClick: ctx.discoverWallets })
    ]),
    h('div', { className: 'warning-box section' }, 'Wallet extensions use their own network session. Browser offline and local-provider-only modes do not make a wallet extension offline.'),
    h('div', { className: 'wallet-hero' },
      h('article', { className: 'card' },
        h('div', { className: 'card-label' }, 'Connection', wallet.connected ? badge('CONNECTED', 'good') : badge('DISCONNECTED')),
        wallet.connected ? h('div', {},
          h('h2', {}, wallet.walletName || wallet.walletId),
          h('p', {}, `${wallet.accounts.length} approved account${wallet.accounts.length === 1 ? '' : 's'}`),
          h('div', { className: 'list section' }, wallet.accounts.map((account) => h('div', { className: 'account' },
            h('span', { className: 'row-icon' }, '◎'),
            h('div', { className: 'account-copy' }, h('strong', {}, account.address), h('span', {}, [account.purpose, account.addressType, account.network].filter(Boolean).join(' · '))),
            button('Copy', { small: true, onClick: () => ctx.copy(account.address) })
          ))),
          h('div', { className: 'form-actions' }, button('Disconnect', { danger: true, onClick: ctx.disconnectWallet }))
        ) : h('div', {}, h('h2', {}, 'No wallet connected'), h('p', {}, 'Install or discover a compatible injected Bitcoin wallet inside the isolated Wallet Bridge. Private keys are not imported into Bitcoin Browser.'),
          snapshot.discovered?.length ? h('div', { className: 'list section' }, snapshot.discovered.map((candidate) => listRow({
            icon: '◫', title: candidate.name, subtitle: `${candidate.kind} · ${candidate.id}`, onClick: () => ctx.connectWallet(candidate.id)
          }))) : emptyState('◫', 'No injected wallets discovered', 'Install an unpacked wallet extension or open discovery after a compatible provider is available.', button('Install unpacked extension', { onClick: ctx.installExtension }))
        )
      ),
      h('aside', { className: 'security-card' },
        h('span', { className: 'eyebrow' }, 'Enforced isolation'), h('h2', {}, 'Browse without signing risk'),
        h('div', { className: 'security-list' },
          h('div', {}, h('b', {}, '✓'), 'Separate Electron session and storage partition'),
          h('div', {}, h('b', {}, '✓'), 'No wallet APIs exposed to inscription frames'),
          h('div', {}, h('b', {}, '✓'), 'Native confirmation before PSBT or message signing'),
          h('div', {}, h('b', {}, '✓'), 'No seed phrase or private-key import path')
        )
      )
    ),
    section('Signing tools', signingEnabled ? 'Inspection is available without a connected wallet. Signing requires explicit connection.' : 'Signing is disabled in this beta build until the wallet compatibility matrix is validated.',
      h('div', { className: 'signing-grid' },
        signingCardPsbt(wallet, ctx, signingEnabled),
        signingCardMessage(wallet, ctx, signingEnabled)
      )),
    extensionRecovery ? h('div', { className: 'warning-box section', role: 'status' },
      h('b', {}, 'Extension state needs reconciliation. '), extensionRecovery.message,
      h('div', { className: 'form-actions' }, button(extensionPending === 'refresh' ? 'Refreshing…' : 'Retry extension refresh', {
        small: true, disabled: Boolean(extensionPending), onClick: ctx.refreshExtensions
      }))) : null,
    snapshot.extensionsChanging ? h('div', { className: 'warning-box section', role: 'status' }, 'Wallet extension state is updating. Extension controls are temporarily unavailable.') : null,
    section('Installed wallet extensions', 'Extensions load only in the Wallet Bridge partition.',
      snapshot.extensions?.length ? h('div', { className: 'list' }, snapshot.extensions.map((extension) => {
        const removing = extensionPending === `remove:${extension.id}`;
        const stateLabel = extension.persisted === false ? 'Loaded · not saved' : extension.loaded ? 'Loaded' : 'Unavailable';
        return h('div', {}, listRow({
          icon: extension.loaded ? '✓' : '!', title: extension.name, subtitle: `${extension.version} · ${extension.path}`, meta: stateLabel,
          actions: [button(removing ? 'Removing…' : 'Remove', { small: true, danger: true, disabled: Boolean(extensionPending), onClick: (event) => { event.stopPropagation(); ctx.removeExtension(extension.id); } })]
        }), extension.error ? h('div', { className: 'warning-box', role: 'status' }, `${extension.error.code}: ${extension.error.message}`, extension.recovery ? h('p', {}, extension.recovery) : null) : null);
      })) : emptyState('◇', 'No wallet extensions installed', 'Use an unpacked extension directory. Review the extension and its permissions before loading it.'),
      [button('Refresh extensions', { small: true, disabled: Boolean(extensionPending), onClick: ctx.refreshExtensions }),
        button(extensionPending === 'install' ? 'Installing…' : 'Install extension', { small: true, disabled: Boolean(extensionPending), onClick: ctx.installExtension })])
  );
}

function signingCardPsbt(wallet, ctx, signingEnabled) {
  const textarea = h('textarea', { placeholder: 'Paste a base64 or hexadecimal PSBT…', ariaLabel: 'PSBT' });
  const preview = h('div', { className: 'psbt-preview' });
  return h('article', { className: 'card sign-card' },
    h('div', { className: 'card-label' }, 'PSBT', badge('OFFLINE PARSER')),
    h('h2', {}, 'Inspect before signing'),
    h('p', {}, 'Decode transaction counts, outputs, scripts, known values, and fee availability locally.'),
    textarea,
    preview,
    h('div', { className: 'form-actions' },
      button('Inspect', { onClick: async () => ctx.inspectPsbt(textarea.value, preview) }),
      button(signingEnabled ? 'Sign in wallet' : 'Signing unavailable', { primary: true, disabled: !signingEnabled || !wallet.connected, onClick: () => ctx.signPsbt(textarea.value) })
    )
  );
}

function signingCardMessage(wallet, ctx, signingEnabled) {
  const address = h('input', { className: 'field', placeholder: 'Signing address (optional)', value: wallet.accounts?.[0]?.address ?? '', ariaLabel: 'Signing address' });
  const message = h('textarea', { placeholder: 'Message to sign…', ariaLabel: 'Message' });
  return h('article', { className: 'card sign-card' },
    h('div', { className: 'card-label' }, 'Message', badge('NATIVE REVIEW')),
    h('h2', {}, 'Sign an explicit message'),
    h('p', {}, 'The full message and selected address are reviewed before the request reaches the wallet.'),
    address, message,
    h('div', { className: 'form-actions' }, button(signingEnabled ? 'Sign in wallet' : 'Signing unavailable', { primary: true, disabled: !signingEnabled || !wallet.connected, onClick: () => ctx.signMessage(message.value, address.value) }))
  );
}

function serviceAction(service, pending) {
  if (pending === 'start') return { label: 'Starting…', action: 'start', disabled: true };
  if (pending === 'stop') return { label: 'Stopping…', action: 'stop', disabled: true };
  if (service.status === 'starting') return { label: 'Starting…', action: 'start', disabled: true };
  if (service.status === 'stopping') return { label: 'Stopping…', action: 'stop', disabled: true };
  if (service.status === 'running' || service.pid) return { label: 'Stop', action: 'stop', disabled: false };
  return { label: 'Start', action: 'start', disabled: !service.enabled || !service.executable };
}

function updateServiceCard(card, service, ctx) {
  const record = card.__serviceViewRecord;
  record.service = service;
  record.ctx = ctx;
  const status = card.querySelector('[data-service-status]');
  status.className = `provider-status${service.status === 'running' ? ' ok' : service.status === 'failed' ? ' fail' : ''}`;
  status.textContent = service.status === 'running' ? '●' : service.status === 'failed' ? '!' : '○';
  card.querySelector('[data-service-name]').textContent = service.name;
  card.querySelector('[data-service-summary]').textContent = service.error || service.executable || 'Not configured';
  const badges = card.querySelector('[data-service-badges]');
  badges.replaceChildren(...[
    badge(String(service.status).toUpperCase(), service.status === 'running' ? 'good' : service.status === 'failed' ? 'bad' : ''),
    service.pid ? badge(`PID ${service.pid}`) : null,
    service.autoStart ? badge('AUTOSTART') : null
  ].filter(Boolean));
  const pending = ctx.serviceActionPending?.(service.id);
  const action = serviceAction(service, pending);
  const lifecycle = card.querySelector('[data-service-lifecycle]');
  lifecycle.className = `button small${action.action === 'start' ? ' primary' : ' danger'}`;
  lifecycle.disabled = action.disabled;
  lifecycle.textContent = action.label;
  lifecycle.dataset.serviceAction = action.action;
  let log = card.querySelector('[data-service-log]');
  const entries = (service.logs ?? []).slice(-60);
  if (entries.length) {
    if (!log) {
      log = h('div', { className: 'service-log', dataset: { serviceLog: '' } });
      card.append(log);
    }
    const unchanged = log.__serviceLogEntries?.length === entries.length
      && entries.every((entry, index) => ['time', 'stream', 'text'].every((key) => entry[key] === log.__serviceLogEntries[index][key]));
    if (!unchanged) {
      const { scrollTop, scrollLeft } = log;
      log.replaceChildren(...entries.map((entry) => h('div', { className: entry.stream }, `[${entry.time}] ${entry.text}`)));
      log.scrollTop = scrollTop;
      log.scrollLeft = scrollLeft;
      log.__serviceLogEntries = entries.map(({ time, stream, text }) => ({ time, stream, text }));
    }
  } else if (log) log.remove();
}

function renderServiceCard(service, ctx) {
  const record = { service, ctx };
  const card = h('article', { className: 'service-card', dataset: { serviceCard: '', serviceId: service.id } },
    h('div', { className: 'service-header' },
      h('div', { dataset: { serviceStatus: '' } }),
      h('div', { className: 'provider-copy' }, h('strong', { dataset: { serviceName: '' } }), h('span', { dataset: { serviceSummary: '' } }), h('div', { className: 'badges', dataset: { serviceBadges: '' }, style: { marginTop: '7px' } })),
      h('div', { className: 'provider-actions' },
        button('Edit', { small: true, onClick: () => record.ctx.openServiceModal(record.service) }),
        button('', { small: true, onClick: () => {
          const action = serviceAction(record.service, record.ctx.serviceActionPending?.(record.service.id));
          if (action.disabled) return;
          return action.action === 'stop' ? record.ctx.stopService(record.service.id) : record.ctx.startService(record.service.id);
        }, className: 'service-lifecycle' })
      )
    )
  );
  card.__serviceViewRecord = record;
  card.querySelector('.service-lifecycle').dataset.serviceLifecycle = '';
  updateServiceCard(card, service, ctx);
  return card;
}

export function updateServicesView(container, model, ctx) {
  const view = container?.matches?.('[data-services-view]') ? container : container?.querySelector?.('[data-services-view]');
  if (!view) return false;
  const grid = view.querySelector('[data-services-grid]');
  if (!grid) return false;
  view.__servicesViewContext.ctx = ctx;
  const refresh = view.querySelector('[data-services-refresh]');
  if (refresh) refresh.disabled = Boolean(ctx.serviceRefreshPending?.());
  const existing = new Map([...grid.querySelectorAll('[data-service-card]')].map((card) => [card.dataset.serviceId, card]));
  const desired = model.services.map((service) => {
    const retained = existing.get(service.id);
    const card = retained ?? renderServiceCard(service, ctx);
    existing.delete(service.id);
    if (retained) updateServiceCard(card, service, ctx);
    return card;
  });
  for (const card of existing.values()) card.remove();
  desired.forEach((card, index) => {
    if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] ?? null);
  });
  return true;
}

export function renderServices(model, ctx) {
  const context = { ctx };
  const refresh = button('Refresh services', { onClick: () => context.ctx.refreshServices?.() });
  refresh.dataset.servicesRefresh = '';
  refresh.disabled = Boolean(ctx.serviceRefreshPending?.());
  const view = h('div', { dataset: { servicesView: '' } },
    pageHeader('Sovereignty', 'Local node', 'Verify Bitcoin on your own computer. Start with a capacity-aware recommendation, or keep full control with the existing walkthrough and service editor.', [button('Guided setup', { primary: true, onClick: () => context.ctx.navigate('satnav://node-setup') }), refresh, button('Add service', { icon: '+', onClick: () => context.ctx.openServiceModal() })]),
    h('p', { className: 'node-setup-help' }, 'New here? Guided setup checks your computer and offers one-button compact Bitcoin Core setup. Core + Ord, archive storage, existing connections and all advanced options are still available.'),
    h('div', { className: 'warning-box' }, 'Treat command-line arguments as privileged configuration. Processes launch without a shell, with an absolute executable path, and with Node-specific environment variables removed.'),
    h('div', { className: 'provider-grid section', dataset: { servicesGrid: '' } }, model.services.map((service) => renderServiceCard(service, ctx)))
  );
  view.__servicesViewContext = context;
  return view;
}

export function renderDocumentation(model, ctx) {
  const settings = model.settings ?? {};
  return h('div', {},
    pageHeader('Help', 'Documentation', 'A local guide to browsing Bitcoin data safely with the sources and controls built into Bitcoin Browser.', [
      button('Home', { onClick: () => ctx.navigate('satnav://home') }),
      button('About', { onClick: () => ctx.navigate('satnav://about') })
    ]),
    section('Start with sources', 'No Bitcoin node is required for a first launch. Review the configured sources before relying on their results.',
      h('div', { className: 'security-list' },
        h('div', {}, h('b', {}, '1'), ' Open Data sources, review each endpoint, network and capability, then run a health check.'),
        h('div', {}, h('b', {}, '2'), ' Prefer a source only after its identity and returned provenance match what you expect.'),
        h('div', {}, h('b', {}, '3'), ' Choose Guided setup to download a supported pinned version, choose an installed program, or connect a running local service. Nothing is downloaded, saved, or started without your confirmation. Ord needs archival Bitcoin Core with its transaction index and REST enabled.')
      ), [
        button('Data sources', { primary: true, onClick: () => ctx.navigate('satnav://providers') }),
        button('Local node', { onClick: () => ctx.navigate('satnav://services') }),
        button('Guided setup', { onClick: () => ctx.navigate('satnav://node-setup') })
      ]),
    section('Browse explicit targets', 'Use a prefix whenever the same text could describe more than one Bitcoin object. The browser shows alternatives instead of silently guessing.',
      h('div', { className: 'list' },
        listRow({ icon: '·', title: 'Genesis sat', subtitle: 'sat:0', onClick: () => ctx.navigate('sat:0') }),
        listRow({ icon: '▦', title: 'Block height', subtitle: 'block:840000', onClick: () => ctx.navigate('block:840000') }),
        listRow({ icon: '↳', title: 'Recursive endpoint', subtitle: '/r/blockheight', onClick: () => ctx.prefill('/r/blockheight') })
      ), [button('Open Home', { onClick: () => ctx.navigate('satnav://home') })]),
    section('Find an inscription or a saved item', 'Home offers a guided lookup: choose Inscription, Block, Transaction, Bitcoin address, or Sat, then enter the identifier. Try an example fills the field without sending a request.',
      h('p', {}, 'Choose History and bookmarks to search saved titles and identifiers on this device. Every word must match; results show up to 30 unique targets, with bookmarks first. Use Refresh results after your library changes. Search phrases may be saved in local history, but are not sent to a search service. Open Inscriptions in the sidebar to browse your source’s full inscription index, page by page, or find inscriptions in a block. Content-type filters apply to the current page. Global keyword search is not available; number and ID lookup use an Ordinals data source.')),
    section('Know the network boundaries', 'These controls have different scopes and are not a machine-wide firewall.',
      h('div', { className: 'security-list' },
        h('div', {}, h('b', {}, settings.localOnly ? 'LOCAL ONLY' : 'LOCAL ONLY OFF'), ' Local-only limits provider routing to eligible loopback sources.'),
        h('div', {}, h('b', {}, settings.offlineMode ? 'OFFLINE' : 'ONLINE'), ' Offline mode makes provider and inscription requests cache-only and blocks external inscription networking; uncached resources fail explicitly.'),
        h('div', {}, h('b', {}, 'WALLET SESSION'), ' Wallet Bridge uses a separate network session. Local-only and offline browser controls do not disconnect wallet extensions.')
      ), [button('Network settings', { primary: true, onClick: () => ctx.navigate('satnav://settings') })]),
    section('Wallet safety', 'Bitcoin Browser discovers compatible wallets and returns public account descriptors through an isolated Wallet Bridge.',
      h('div', { className: 'warning-box' }, 'Packaged beta builds cannot sign PSBTs or messages. Never import or paste a private key or seed phrase into Bitcoin Browser; key custody and wallet connection approvals remain with your wallet, and signing requests are not sent in this beta.'),
      [button('Wallet', { onClick: () => ctx.navigate('satnav://wallet') })]),
    section('Diagnostics and recovery', 'Use local evidence to troubleshoot without treating a diagnostic export as automatically safe to share.',
      h('div', { className: 'security-list' },
        h('div', {}, h('b', {}, 'Review first'), ' Exported diagnostics are redacted and bounded, but redaction is best-effort. Inspect the saved file before sharing it.'),
        h('div', {}, h('b', {}, 'Recover visibly'), ' If the primary state file is corrupt, the browser can restore its backup and shows a recovery notice. Confirm settings, sources, tabs and bookmarks afterward.'),
        h('div', {}, h('b', {}, 'Recover a source'), ' In Data sources, choose Recover source when sign-in recovery is needed. Review the endpoint and network, then explicitly replace both RPC fields or clear this app’s stored pair. Cookie files and source configuration are preserved. Use no stored sign-in details only for an endpoint that does not require them. Refresh source state never resubmits recovery; reopen the review before another attempt.'),
        h('div', {}, h('b', {}, 'Finish removed-source cleanup'), ' Data sources retains unfinished cleanup warnings after restart. Review credential cleanup requires the exact source ID and a separate deletion acknowledgment; a configured replacement cannot be deleted by cleanup. Refresh source state never repeats deletion. For older data, Review an older removed source checks only an ID you already know; it does not scan stores or confirm an account or destination. Cookie files, node data and other sources are preserved.'),
        h('div', {}, h('b', {}, 'Keep evidence'), ' Record the app version, platform, exact steps and visible error. Use the private security-advisory channel configured by your distributor for a suspected vulnerability; this build does not invent a support contact.')
      ), [
        button('Settings', { onClick: () => ctx.navigate('satnav://settings') }),
        button('About this build', { onClick: () => ctx.navigate('satnav://about') })
      ])
  );
}

export function renderError(error, target, ctx) {
  const recovery = lookupRecovery(error, ctx.model?.settings);
  return h('div', { className: 'lookup-recovery' },
    pageHeader('Lookup unavailable', recovery.title, target?.display || target?.canonical || 'Unknown target', [button('Retry', { primary: true, onClick: ctx.retry }), button(recovery.action, { onClick: () => ctx.navigate(recovery.route) })]),
    h('article', { className: 'card' },
      h('p', {}, recovery.message),
      h('div', { className: 'page-actions' }, button('Back to Start', { onClick: () => ctx.navigate('satnav://home') })),
      h('details', { className: 'recovery-technical' }, h('summary', {}, 'Technical details'),
        h('p', {}, `${error.code || 'LOOKUP_FAILED'}: ${error.message || 'The request failed.'}`),
        error.details ? h('pre', { className: 'raw-json section' }, safeJson(error.details)) : null)
    )
  );
}

export function renderLoading(result, ctx) {
  return h('div', { className: 'lookup-loading' },
    pageHeader('Looking up Bitcoin', 'Getting this record…', result.target.display || result.target.canonical),
    h('p', { role: 'status' }, 'Waiting for your configured data source. You can use another tab or start a different lookup.'),
    h('div', { className: 'loading-grid', 'aria-hidden': 'true' }, h('div'), h('div'), h('div')),
    button('Search something else', { onClick: () => ctx.navigate('satnav://home') }));
}

export function renderDeveloper(model, ctx) {
  const result = ctx.currentResult;
  if (!result) return emptyState('{ }', 'Nothing to inspect', 'Navigate to a Bitcoin target first.');
  if (model.drawerTab === 'raw') return h('pre', { className: 'raw-json' }, safeJson(result));
  if (model.drawerTab === 'requests') {
    const attempts = result.attempts ?? result.error?.details?.attempts ?? [];
    return attempts.length ? h('div', {}, attempts.map((attempt) => h('div', { className: `attempt${attempt.ok ? ' ok' : ''}` },
      h('span', { className: 'attempt-dot' }), h('div', {}, h('strong', {}, attempt.providerId), h('span', {}, attempt.ok ? 'Resolved successfully' : attempt.error?.message ?? 'Failed')), h('span', {}, attempt.latencyMs ? `${attempt.latencyMs} ms` : attempt.error?.code ?? '')
    ))) : emptyState('≋', 'No provider attempts', 'This route was resolved locally or has not been loaded.');
  }
  const graph = model.graphs?.[ctx.activeTab?.id];
  if (graph?.loading) return emptyState('↳', 'Inspecting recursion', 'Fetching bounded dependency nodes from the active inscription…');
  if (graph?.error) return renderError(graph.error, result.target, ctx);
  if (!graph?.data) return emptyState('↳', 'No recursion graph loaded', 'Select Graph on an inscription to inspect content and /r/ references.', button('Build graph', { onClick: ctx.loadGraph }));
  return h('div', {},
    h('div', { className: 'badges', style: { marginBottom: '10px' } }, badge(`${graph.data.nodes.length} NODES`), badge(`${graph.data.edges.length} EDGES`), graph.data.cycles.length ? badge(`${graph.data.cycles.length} CYCLES`, 'warn') : badge('NO CYCLES', 'good'), graph.data.truncated ? badge('TRUNCATED', 'warn') : null),
    graph.data.nodes.map((node) => h('div', { className: 'graph-node' }, h('strong', {}, node.path), h('span', {}, node.error ? `${node.error.code}: ${node.error.message}` : `depth ${node.depth} · ${formatBytes(node.bytes)} · ${node.contentType} · ${node.dependencies.length} dependencies`)))
  );
}

export function renderPsbtPreview(preview, container) {
  container.replaceChildren(
    h('div', { className: 'badges' }, badge(`${preview.inputCount} INPUTS`), badge(`${preview.outputCount} OUTPUTS`), preview.feeKnown ? badge(`${formatNumber(preview.fee)} SAT FEE`, 'good') : badge('FEE UNKNOWN', 'warn')),
    ...preview.outputs.slice(0, 10).map((output) => h('div', { className: 'output-row' }, h('strong', {}, `${formatNumber(output.value)} sats`), h('span', {}, output.address ?? `${output.scriptType}: ${shorten(output.scriptHex, 18, 12)}`))),
    ...preview.warnings.map((warning) => h('div', { className: 'warning-box' }, warning))
  );
}
