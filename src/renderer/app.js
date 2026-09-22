import { Store } from './state.js';
import { renderInscriptions, updateInscriptions } from './inscriptions.js';
import { renderRunes, updateRunes } from './runes.js';
import { renderNodeSetup } from './node-setup.js';
import { renderAi, forgetAiTab, findAiSessionTab } from './ai.js';
import { MAX_TABS, PROVIDER_CAPABILITIES, defaultProviderCapabilitiesFor, providerCapabilitiesFor } from '../shared/constants.js';
import { providerRecoveryCredentialError, providerRecoveryExplanation, providerRecoveryReview, providerRecoveryReviewMatches } from '../shared/provider-recovery.js';
import { badge, button, clear, copyText, h, safeJson, targetIcon, updateBookmarkControls } from './dom.js';
import { sourceStatus } from './source-status.js';
import { createProviderStatusMonitor } from './provider-status-monitor.js';
import {
  renderAbout,
  renderSponsors,
  renderBookmarks,
  renderCollection,
  renderDeveloper,
  renderDocumentation,
  renderEntity,
  renderError,
  renderLoading,
  renderHistory,
  renderHome,
  renderHomeLibrarySection,
  renderInscription,
  renderProviders,
  renderPsbtPreview,
  renderSearch,
  renderServices,
  updateServicesView,
  updateProviderHealthViews,
  updateCacheViews,
  renderSettings,
  renderWallet
} from './views.js';

const api = window.satBrowser;
const elements = Object.fromEntries([
  'app', 'tabs', 'new-tab', 'back', 'forward', 'reload', 'omnibox', 'omnibox-icon', 'omnibox-source', 'bookmark-current',
  'omnibox-suggestions', 'source-label', 'source-button', 'developer-button', 'developer-drawer', 'close-developer', 'drawer-body',
  'page', 'page-loading', 'main-stage', 'network-dot', 'network-status', 'network-name', 'privacy-status', 'cache-status',
  'wallet-pill', 'title-status', 'bookmark-count', 'modal-backdrop', 'modal', 'palette-backdrop', 'palette-input', 'palette-results', 'toasts'
].map((id) => [id, document.getElementById(id)]));

const INTERNAL_ROUTES = new Set(['home', 'bookmarks', 'history', 'wallet', 'providers', 'services', 'node-setup', 'settings', 'about', 'sponsors', 'documentation', 'ai']);
const MODEL = new Store({
  bootstrap: null,
  settings: {}, providers: [], cache: {}, wallet: null, services: [], history: [], bookmarks: [], tabs: [], activeTabId: null,
  results: {}, loading: {}, requestSequence: {}, graphs: {}, developerOpen: false, drawerTab: 'raw', suggestionIndex: -1,
  paletteIndex: 0
});
let suggestionToken = 0;
let navigationIntentSequence = 0;
let providerRefreshSequence = 0;
let authorityMutationTail = Promise.resolve();
let authorityMutationSequence = 0;
let routingMaintenanceVersion = 0;
let completedRoutingMaintenanceVersion = 0;
const navigationIntents = new Map();
const pendingEntityRequests = new Map();
let systemThemeListenerInstalled = false;
let modalGeneration = 0;
let overlayReturnFocus = null;
let overlayFocusGeneration = 0;
let rendererEventsInstalled = false;
let bootstrapRunning = false;
let navigationReady = false;
let pendingShellDeepLink = null;
const pendingServiceActions = new Map();
let pendingServiceRefresh = false;
let pendingExtensionAction = null;
let extensionOutcomeRecovery = null;
const pendingProviderMutations = new Map();
const providerCleanupRecovery = new Map();
let providerOutcomeRecovery = null;
let providerSnapshotPending = false;
const pendingContentSaves = new Set();
let diagnosticsExportPending = false;
let providerStatusMonitor = null;

function state() { return MODEL.get(); }
function queueAuthorityMutation(task) {
  providerRefreshSequence += 1;
  const sequence = ++authorityMutationSequence;
  const operation = authorityMutationTail.then(() => task(sequence), () => task(sequence));
  authorityMutationTail = operation.catch(() => {});
  operation.then(() => runPendingRoutingMaintenance(sequence), () => runPendingRoutingMaintenance(sequence)).catch(() => {});
  return operation;
}
async function runEasyNodeSetup(payload) {
  // Do not hold the authority queue across a download/native dialog. Offline
  // and local-only changes must still reach main and cancel pending downloads.
  let value, failure;
  try { value = await api.nodeSetup.run('easy-start', payload); }
  catch (error) {
    if (!error?.details?.setupCommitted) throw error;
    failure = error; value = { committed: true, setupId: error.details.setupId };
  }
  if (value?.committed) {
    await queueAuthorityMutation(async () => {
      try {
        // Never publish settings captured before a long-running setup settled.
        const [snapshot, services] = await Promise.all([api.providers.snapshot(), api.services.list()]);
        if (!validProviderSnapshot(snapshot) || snapshot.providers === null || snapshot.settings === null || !Array.isArray(services)) throw new Error('Current node/source state is unavailable.');
        publishProviderSnapshot(snapshot); publishServices(services); routingMaintenanceVersion += 1;
      } catch (error) {
        markProviderOutcomeUnknown(error.message);
        throw Object.assign(new Error('Setup was saved, but browser state could not be refreshed. Resume the setup and refresh Data sources; do not install again.'),
          { code: 'NODE_SETUP_SAVED_REFRESH_FAILED', details: { setupCommitted: true, setupId: value.setupId } });
      }
    });
  }
  if (failure) throw failure;
  return value;
}
function activeTab() { const model = state(); return model.tabs.find((tab) => tab.id === model.activeTabId) ?? model.tabs[0] ?? null; }
function currentResult() { const tab = activeTab(); return tab ? state().results[tab.id] ?? null : null; }
function id() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function cancelTabResolution(tabId) {
  const request = pendingEntityRequests.get(tabId);
  if (!request) return;
  // Retire only this tab's handle before dispatch. The acknowledgement records
  // cancellation intent, not transport settlement; navigation must not await it.
  pendingEntityRequests.delete(tabId);
  const reportFailure = () => toast('Request cancellation unconfirmed',
    'The previous request may still be running. Its result will not replace the current page.', 'error');
  try { Promise.resolve(api.navigation.cancelResolve(request.requestId)).catch(reportFailure); }
  catch { reportFailure(); }
}

function patch(value, options = {}) {
  MODEL.patch(value);
  renderChrome();
  if (options.page) renderPage();
  if (options.developer !== false) renderDrawer();
}

function normalizeError(error) {
  return {
    code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || String(error || 'Unknown error'),
    status: error?.status || 500,
    retryable: Boolean(error?.retryable),
    details: error?.details ?? null
  };
}

function toast(title, message = '', kind = '') {
  const node = h('div', { className: `toast${kind ? ` ${kind}` : ''}`, role: 'status' }, h('strong', {}, title), message ? h('span', {}, message) : null);
  elements.toasts.append(node);
  const timer = setTimeout(() => node.remove(), kind === 'error' ? 8000 : 4300);
  node.addEventListener('click', () => { clearTimeout(timer); node.remove(); });
}

function applyTheme() {
  const theme = state().settings.theme ?? 'system';
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
  if (!systemThemeListenerInstalled) {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state().settings.theme === 'system') applyTheme(); });
    systemThemeListenerInstalled = true;
  }
}

function safeTab(tab) {
  const history = Array.isArray(tab.history) && tab.history.length ? tab.history.slice(-200) : [tab.target || 'satnav://home'];
  return {
    id: String(tab.id || id()), title: String(tab.title || 'Start'), target: String(tab.target || 'satnav://home'), history,
    historyIndex: Math.max(0, Math.min(Number.isSafeInteger(tab.historyIndex) ? tab.historyIndex : history.length - 1, history.length - 1)),
    pinned: Boolean(tab.pinned), lastAccessedAt: Number(tab.lastAccessedAt) || Date.now()
  };
}

function scheduleTabSave() {
  // Dispatch immediately: a renderer-only debounce can disappear when its
  // window closes before the main process ever receives the session update.
  const model = state();
  return api.tabs.save(model.tabs, model.activeTabId)
    .catch((error) => toast('Could not save tab session', error.message, 'error'));
}

function newTab(target = 'satnav://home', options = {}) {
  if (!navigationReady) return null;
  if (state().tabs.length >= MAX_TABS) {
    toast('Tab limit reached', `Bitcoin Browser supports up to ${MAX_TABS} open tabs.`, 'error');
    return null;
  }
  const tab = safeTab({ id: id(), title: 'Start', target, history: [target], historyIndex: 0, lastAccessedAt: Date.now() });
  patch((model) => ({ ...model, tabs: [...model.tabs, tab], activeTabId: tab.id }), { page: true });
  scheduleTabSave();
  navigate(target, { fromHistory: true, historyIndex: 0, record: false, focusOmnibox: options.focusOmnibox ?? true });
  return tab;
}

function closeTab(tabId = state().activeTabId) {
  const model = state();
  const index = model.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  cancelTabResolution(tabId);
  forgetAiTab(tabId);
  navigationIntents.delete(tabId);
  const requestSequence = { ...model.requestSequence };
  delete requestSequence[tabId];
  if (model.tabs.length === 1) {
    const replacement = safeTab({ id: id(), title: 'Start', target: 'satnav://home', history: ['satnav://home'], historyIndex: 0 });
    patch({ tabs: [replacement], activeTabId: replacement.id, results: { [replacement.id]: { target: { kind: 'home', canonical: 'satnav://home', display: 'Home', value: null }, entity: null, attempts: [] } }, loading: {}, graphs: {}, requestSequence }, { page: true });
  } else {
    const tabs = model.tabs.filter((tab) => tab.id !== tabId);
    const nextActive = model.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)].id : model.activeTabId;
    const results = { ...model.results }; delete results[tabId];
    const loading = { ...model.loading }; delete loading[tabId];
    const graphs = { ...model.graphs }; delete graphs[tabId];
    patch({ tabs, activeTabId: nextActive, results, loading, graphs, requestSequence }, { page: true });
  }
  scheduleTabSave();
  const selected = activeTab();
  if (selected && !state().results[selected.id]) {
    navigate(selected.target, { fromHistory: true, historyIndex: selected.historyIndex, record: false });
  }
}

function switchTab(tabId) {
  const tab = state().tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  tab.lastAccessedAt = Date.now();
  patch({ activeTabId: tabId }, { page: true });
  scheduleTabSave();
  if (!state().results[tabId]) {
    navigate(tab.target, { fromHistory: true, historyIndex: tab.historyIndex, record: false });
  }
}

function openAiWorkspace() {
  if (!navigationReady) return;
  const model = state();
  const owner = findAiSessionTab(model.tabs, model.activeTabId)
    ?? model.tabs.find(tab => tab.target === 'satnav://ai')?.id;
  const tab = model.tabs.find(candidate => candidate.id === owner);
  if (tab?.target === 'satnav://ai') {
    // switchTab restores a resolved workspace without navigation/network work,
    // and owns lazy navigation if this is an unresolved restored tab.
    if (tab.id !== model.activeTabId) { switchTab(tab.id); return; }
    if (model.results[tab.id]?.target?.value === 'ai' && !model.results[tab.id]?.error) return;
  } else if (tab && tab.id !== model.activeTabId) {
    // Its owner may have browsed elsewhere in-place. Return that tab to its
    // retained conversation without resolving the unrelated old page first.
    patch({ activeTabId: tab.id }, { page: false });
  }
  return navigate('satnav://ai');
}

function titleFor(target, entity) {
  if (target.kind === 'rune' && entity?.summary?.rune) return String(entity.summary.rune).slice(0, 100);
  if (target.kind === 'home') return 'Start';
  if (target.kind === 'internal') return target.display;
  if (target.kind === 'inscription-number' && entity?.summary?.number != null) return `Inscription #${entity.summary.number}`;
  if (target.kind === 'inscription' && entity?.summary?.number !== null && entity?.summary?.number !== undefined) return `Inscription #${entity.summary.number}`;
  return String(target.display || target.canonical || 'Untitled').slice(0, 160);
}

function updateTabNavigation(tabId, target, options = {}) {
  const model = state();
  const tabs = model.tabs.map((tab) => {
    if (tab.id !== tabId) return tab;
    let history = [...tab.history];
    let historyIndex = tab.historyIndex;
    if (options.fromHistory) historyIndex = Math.max(0, Math.min(options.historyIndex ?? historyIndex, history.length - 1));
    else {
      history = history.slice(0, historyIndex + 1);
      if (history[history.length - 1] !== target.canonical) history.push(target.canonical);
      history = history.slice(-200);
      historyIndex = history.length - 1;
    }
    return { ...tab, title: titleFor(target), target: target.canonical, history, historyIndex, lastAccessedAt: Date.now() };
  });
  patch({ tabs }, { page: false });
  scheduleTabSave();
}

async function navigate(input, options = {}) {
  if (!navigationReady) return;
  const text = String(input ?? '').trim() || 'satnav://home';
  const requestedTabId = activeTab()?.id ?? null;
  const intent = ++navigationIntentSequence;
  if (requestedTabId) navigationIntents.set(requestedTabId, intent);
  let target;
  try {
    target = await api.navigation.parse(text);
  } catch (error) {
    if (requestedTabId && navigationIntents.get(requestedTabId) !== intent) return;
    toast('Invalid navigation target', error.message, 'error');
    return;
  }
  if (requestedTabId && navigationIntents.get(requestedTabId) !== intent) return;
  if (target.kind === 'external-web' || target.kind === 'payment') {
    try { await api.app.openExternal(target.value); } catch (error) { if (error.code !== 'USER_REJECTED') toast('External navigation failed', error.message, 'error'); }
    return;
  }
  const tab = requestedTabId
    ? state().tabs.find((candidate) => candidate.id === requestedTabId)
    : (activeTab() ?? newTab('satnav://home', { focusOmnibox: false }));
  if (!tab) return;
  const tabId = tab.id;
  // Invalid/pending parses and external confirmation leave the current request
  // alive. Only an actually committed in-app navigation supersedes its work.
  cancelTabResolution(tabId);
  updateTabNavigation(tabId, target, options);
  const sequence = (state().requestSequence[tabId] ?? 0) + 1;
  const isActive = state().activeTabId === tabId;
  patch((model) => {
    const graphs = { ...model.graphs };
    delete graphs[tabId];
    return {
      ...model,
      requestSequence: { ...model.requestSequence, [tabId]: sequence },
      results: { ...model.results, [tabId]: { target, entity: null, attempts: [] } },
      loading: { ...model.loading, [tabId]: !['home', 'internal', 'search', 'collection'].includes(target.kind) },
      graphs
    };
  }, { page: isActive });
  if (isActive) {
    closeSuggestions();
    // A committed navigation replaces the editing draft, including when it
    // came from an external deep link while the address field had focus.
    elements.omnibox.value = target.kind === 'home' ? '' : target.canonical;
    elements.omnibox.blur();
  }
  if (isActive && options.focusOmnibox) setTimeout(() => {
    if (state().activeTabId === tabId) {
      elements.omnibox.focus();
      elements.omnibox.select();
    }
  }, 0);

  if (!['home', 'internal', 'search', 'collection'].includes(target.kind)) {
    const request = { requestId: id() };
    pendingEntityRequests.set(tabId, request);
    try {
      const result = await api.navigation.resolve(target.canonical, undefined, request.requestId);
      if (state().requestSequence[tabId] !== sequence) return;
      const tabs = state().tabs.map((candidate) => candidate.id === tabId ? { ...candidate, title: titleFor(result.target, result.entity) } : candidate);
      patch((model) => ({ ...model, tabs, results: { ...model.results, [tabId]: result }, loading: { ...model.loading, [tabId]: false } }), { page: state().activeTabId === tabId });
      refreshCacheStats().catch(() => {});
      scheduleTabSave();
      if (options.record !== false) recordHistory(result).catch(() => {});
    } catch (error) {
      if (state().requestSequence[tabId] !== sequence) return;
      const normalized = normalizeError(error);
      const attempts = normalized.details?.attempts ?? [];
      patch((model) => ({ ...model, results: { ...model.results, [tabId]: { target, entity: null, attempts, error: normalized } }, loading: { ...model.loading, [tabId]: false } }), { page: state().activeTabId === tabId });
    } finally {
      if (pendingEntityRequests.get(tabId) === request) pendingEntityRequests.delete(tabId);
    }
  } else if (target.kind !== 'home' && options.record !== false) {
    recordHistory({ target, entity: null }).catch(() => {});
  }
}

async function recordHistory(result) {
  const target = result.target;
  if (!target || target.kind === 'home' || target.kind === 'internal') return;
  const entry = await api.history.record({
    canonical: target.canonical,
    title: titleFor(target, result.entity),
    kind: target.kind,
    providerId: result.entity?.source?.id ?? null
  });
  patch((model) => {
    const latest = model.history[0];
    const elapsed = Date.parse(entry.visitedAt) - Date.parse(latest?.visitedAt);
    const rapidRepeat = latest?.canonical === entry.canonical && elapsed >= 0 && elapsed < 5_000;
    return { ...model, history: (rapidRepeat ? [entry, ...model.history.slice(1)] : [entry, ...model.history]).slice(0, 2000) };
  }, { page: false });
  refreshLibraryPage('history');
}

function goHistory(delta) {
  const tab = activeTab();
  if (!tab) return;
  const index = tab.historyIndex + delta;
  if (index < 0 || index >= tab.history.length) return;
  navigate(tab.history[index], { fromHistory: true, historyIndex: index, record: false });
}

function reload() {
  const tab = activeTab();
  if (tab) navigate(tab.target, { fromHistory: true, historyIndex: tab.historyIndex, record: false });
}

function renderTabs() {
  const model = state();
  const publication = JSON.stringify(model.tabs.map(tab => [tab.id, tab.title, tab.id === model.activeTabId, model.results[tab.id]?.target?.kind]));
  if (elements.tabs.tabPublication === publication) return;
  const focused = document.activeElement;
  const focusedTab = elements.tabs.contains?.(focused) ? focused?.closest?.('.tab') : null;
  const focusedId = focusedTab?.dataset.tabId;
  const focusedClose = focused?.classList?.contains?.('tab-close');
  const activeChanged = elements.tabs.activeTabOwner !== model.activeTabId;
  clear(elements.tabs, model.tabs.map((tab) => h('div', {
    className: `tab${tab.id === model.activeTabId ? ' active' : ''}`,
    dataset: { tabId: tab.id },
    role: 'tab', ariaLabel: tab.title, title: tab.title, 'aria-selected': String(tab.id === model.activeTabId), tabindex: tab.id === model.activeTabId ? 0 : -1,
    onClick: () => switchTab(tab.id),
    onKeydown: (event) => {
      if (event.target !== event.currentTarget) return; // Do not swallow the close button's Enter/Space.
      const index = model.tabs.findIndex((candidate) => candidate.id === tab.id);
      let nextIndex = null;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + model.tabs.length) % model.tabs.length;
      else if (event.key === 'ArrowRight') nextIndex = (index + 1) % model.tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = model.tabs.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') nextIndex = index;
      if (nextIndex === null) return;
      event.preventDefault();
      const next = model.tabs[nextIndex];
      switchTab(next.id);
      setTimeout(() => [...elements.tabs.children].find((node) => node.dataset.tabId === next.id)?.focus(), 0);
    },
    onAuxclick: (event) => { if (event.button === 1) closeTab(tab.id); }
  }, h('span', { className: 'tab-icon', 'aria-hidden': 'true' }, targetIcon(model.results[tab.id]?.target?.kind ?? 'home')),
  h('span', { className: 'tab-title' }, tab.title),
  h('button', { className: 'tab-close', type: 'button', tabindex: tab.id === model.activeTabId ? 0 : -1, ariaLabel: `Close ${tab.title}`, onClick: (event) => { event.stopPropagation(); closeTab(tab.id); } }, '×'))));
  elements.tabs.tabPublication = publication;
  elements.tabs.activeTabOwner = model.activeTabId;
  const selected = [...elements.tabs.children].find(node => node.dataset.tabId === model.activeTabId);
  if (activeChanged) selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (focusedId) {
    const replacement = [...elements.tabs.children].find(node => node.dataset.tabId === focusedId) ?? selected;
    (focusedClose && replacement?.dataset.tabId === focusedId ? replacement.querySelector('.tab-close') : replacement)?.focus();
  }
}

function routeName() {
  const result = currentResult();
  if (['rune', 'runes'].includes(result?.target?.kind)) return 'runes';
  if (['inscriptions', 'inscription', 'inscription-number', 'content', 'recursive'].includes(result?.target?.kind)) return 'inscriptions';
  if (result?.target?.kind === 'home') return 'home';
  if (result?.target?.kind === 'internal') return result.target.value === 'node-setup' ? 'services' : result.target.value;
  return null;
}

function libraryPageNeedsRefresh(library) {
  const result = currentResult();
  if (!result) return true; // The unresolved shell displays Home.
  if (result.error) return false;
  const target = result.target;
  return target?.kind === 'home' || target?.kind === 'collection'
    || (target?.kind === 'internal' && target.value === library);
}

function refreshLibraryPage(library) {
  if (!libraryPageNeedsRefresh(library)) return;
  const result = currentResult();
  if (!result || result.target?.kind === 'home') {
    const section = elements.page.querySelector(`[data-home-library="${library}"]`);
    if (section) {
      // Passive library replies must not replace Home's typed search or focus.
      section.replaceWith(renderHomeLibrarySection(library, state(), context));
      return;
    }
  }
  const scrollTop = elements['main-stage'].scrollTop;
  renderPage();
  elements['main-stage'].scrollTop = scrollTop;
}

function renderChrome() {
  const model = state();
  if (!model.bootstrap) return;
  renderTabs();
  const tab = activeTab();
  const result = currentResult();
  if (document.activeElement !== elements.omnibox) elements.omnibox.value = tab?.target === 'satnav://home' ? '' : (tab?.target ?? '');
  elements['omnibox-icon'].textContent = targetIcon(result?.target?.kind ?? 'search');
  const canBack = Boolean(tab && tab.historyIndex > 0);
  const canForward = Boolean(tab && tab.historyIndex < tab.history.length - 1);
  const atTabLimit = model.tabs.length >= MAX_TABS;
  elements['new-tab'].disabled = atTabLimit;
  elements['new-tab'].title = atTabLimit ? `Tab limit reached (${MAX_TABS})` : 'New tab (Ctrl/Cmd+T)';
  elements.back.disabled = !canBack;
  elements.forward.disabled = !canForward;
  const source = result?.entity?.source?.name ?? (model.settings.preferredProviderId ? model.settings.preferredProviderId : 'AUTO');
  elements['omnibox-source'].textContent = String(source).slice(0, 18).toUpperCase();
  elements['source-label'].textContent = source === 'AUTO' ? 'Sources' : String(source).slice(0, 18);
  const connection = sourceStatus(model);
  const networkClass = connection.tone;
  elements['network-dot'].className = `status-dot ${networkClass}`;
  elements['network-status'].textContent = connection.label;
  elements['network-name'].textContent = model.settings.network.toUpperCase();
  elements['privacy-status'].textContent = `${model.settings.privacyMode[0].toUpperCase()}${model.settings.privacyMode.slice(1)} privacy`;
  elements['cache-status'].textContent = `Cache ${formatCache(model.cache)}`;
  const sourceLed = elements['source-button'].querySelector('.source-led');
  sourceLed.className = `source-led${connection.tone === 'ok' ? ' online' : ''}`;
  elements['source-button'].setAttribute('aria-label', `Data sources · ${connection.label}`);
  elements['source-button'].title = `Data sources · ${connection.label}`;
  const walletState = model.wallet?.state ?? { connected: false };
  elements['wallet-pill'].className = `wallet-pill${walletState.connected ? ' connected' : ''}`;
  elements['wallet-pill'].lastElementChild.textContent = walletState.connected ? walletState.walletName || 'Wallet connected' : 'Connect wallet';
  elements['wallet-pill'].setAttribute('aria-label', walletState.connected ? 'Open connected wallet' : 'Connect wallet · optional for browsing');
  elements['wallet-pill'].title = walletState.connected ? 'Open connected wallet' : 'Connect wallet · optional for browsing';
  elements['bookmark-count'].textContent = model.bookmarks.length ? String(model.bookmarks.length) : '';
  const canonical = result?.target?.canonical;
  const bookmarked = canonical && model.bookmarks.some((entry) => entry.canonical === canonical);
  elements['bookmark-current'].className = `omnibox-action${bookmarked ? ' bookmarked' : ''}`;
  elements['bookmark-current'].textContent = bookmarked ? '★' : '☆';
  elements['bookmark-current'].setAttribute('aria-pressed', String(Boolean(bookmarked)));
  elements['bookmark-current'].setAttribute('aria-label', bookmarked ? 'Remove current bookmark' : 'Bookmark current target');
  elements['bookmark-current'].disabled = !canonical || result?.target?.kind === 'home';
  updateBookmarkControls(elements.page, model.bookmarks);
  elements['page-loading'].classList.toggle('hidden', !model.loading[model.activeTabId]);
  const titleDot = elements['title-status'].querySelector('.status-dot');
  titleDot.className = `status-dot ${networkClass}`;
  elements['title-status'].lastElementChild.textContent = connection.title;
  elements.app.setAttribute('aria-busy', 'false'); // Bootstrap is complete; a lookup does not block the shell.
  const currentRoute = routeName();
  document.querySelectorAll('[data-route]').forEach((node) => {
    const active = node.dataset.route === currentRoute;
    node.classList.toggle('active', active);
    node.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelector('.workspace').classList.toggle('developer-open', model.developerOpen);
  elements['developer-drawer'].setAttribute('aria-hidden', String(!model.developerOpen));
  elements['developer-button'].setAttribute('aria-pressed', String(model.developerOpen));
}

function formatCache(cache) {
  const bytes = Number(cache?.bytes ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function publishCache(cache) {
  // Cache replies have no tab or inspector consumers. Keep their existing nodes
  // and any in-progress input while updating the visible cache statistics.
  MODEL.patch({ cache });
  elements['cache-status'].textContent = `Cache ${formatCache(cache)}`;
  updateCacheViews(elements.page, cache);
}

async function refreshCacheStats() {
  const cache = await api.cache.stats();
  publishCache(cache);
  return cache;
}

const MAX_CLIPBOARD_TEXT_LENGTH = 1024 * 1024;

async function copyToClipboard(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    toast('Copy failed', 'The value was empty, invalid, or too large to copy.', 'error');
    return false;
  }
  let copied = false;
  try { copied = await copyText(value); } catch {}
  toast(copied ? 'Copied' : 'Copy failed', copied ? value.slice(0, 120) : 'Clipboard access was unavailable.', copied ? 'success' : 'error');
  return copied;
}

const context = {
  ai: api.ai,
  openAiWorkspace,
  async saveAiPreferences(localAi) {
    return queueAuthorityMutation(async () => {
      const settings = await api.settings.update({ localAi });
      patch({ settings }, { page: false });
    });
  },
  openAiResult: target => newTab(target, { focusOmnibox: false }),
  async nodeSetup(action, payload = {}) {
    if (action === 'easy-start') return runEasyNodeSetup(payload);
    if (action !== 'apply') return api.nodeSetup.run(action, payload);
    return queueAuthorityMutation(async () => {
      const value = await api.nodeSetup.run(action, payload);
      if (value?.committed) {
        providerRefreshSequence += 1; routingMaintenanceVersion += 1;
        patch({ settings: value.settings, providers: value.providers, services: value.services }, { page: false });
      }
      return value;
    });
  },
  openExternal: url => api.app.openExternal(url),
  get model() { return state(); },
  get activeTab() { return activeTab(); },
  get currentResult() { return currentResult(); },
  navigate,
  refreshCacheStats,
  prefill(value) { elements.omnibox.value = value; elements.omnibox.focus(); elements.omnibox.select(); },
  copy: copyToClipboard,
  isBookmarked(canonical) { return state().bookmarks.some((entry) => entry.canonical === canonical); },
  toggleBookmark,
  clearHistory,
  clearCache,
  refreshProviders,
  openProviderModal,
  openProviderRecoveryModal,
  toggleProvider,
  setPreferred,
  providerMutationPending: (id) => pendingProviderMutations.has(id),
  providerMutationRecovery: () => providerOutcomeRecovery,
  providerCleanupFailures: () => [...providerCleanupRecovery.values()],
  providerSnapshotPending: () => providerSnapshotPending,
  recoverProviderSnapshot,
  retryProviderCleanup,
  openProviderCleanupLookup,
  updateSettings,
  exportDiagnostics,
  revealPath,
  openDeveloper,
  loadGraph,
  retry: reload,
  saveContent,
  openWalletBridge,
  discoverWallets,
  connectWallet,
  disconnectWallet,
  installExtension,
  removeExtension,
  refreshExtensions,
  extensionActionPending: () => pendingExtensionAction,
  extensionActionRecovery: () => extensionOutcomeRecovery,
  inspectPsbt,
  signPsbt,
  signMessage,
  openServiceModal,
  refreshServices,
  serviceActionPending: (serviceId) => pendingServiceActions.get(serviceId),
  serviceRefreshPending: () => pendingServiceRefresh,
  startService,
  stopService
};

function renderPage() {
  const model = state();
  if (!model.bootstrap) return;
  const result = currentResult() ?? { target: { kind: 'home', value: null, canonical: 'satnav://home', display: 'Home' }, entity: null, attempts: [] };
  const setupView = elements.page.querySelector('.node-setup');
  const aiView = elements.page.querySelector('.ai-workspace');
  if (aiView?.retainAi?.(result, model)) return;
  aiView?.dispose?.();
  if (setupView && result.target.kind === 'internal' && result.target.value === 'node-setup' && setupView.dataset.owner === String(model.activeTabId) && !result.error) return;
  setupView?.dispose?.();
  const inscriptionView = elements.page.querySelector('.inscription-page');
  if (inscriptionView?.retainInscription?.(result, model)) return;
  inscriptionView?.dispose?.();
  const aiLayout = result.target.kind === 'internal' && result.target.value === 'ai' && !result.error;
  elements['main-stage'].classList.toggle('ai-layout', aiLayout);
  elements.page.classList.toggle('compact', ['inscription', 'inscription-number', 'content', 'recursive'].includes(result.target.kind) && !result.error);
  if (result.target.kind === 'inscriptions' && updateInscriptions(elements.page.querySelector('.inscription-explorer'), result, context)) return;
  if (['rune', 'runes'].includes(result.target.kind) && updateRunes(elements.page.querySelector('.runes-explorer'), result, context)) return;
  if (elements.page.querySelector('.home-page')?.retainHome?.(result, model)) return;
  if (elements.page.querySelector('.about-page')?.retainAbout?.(result, model)) return;
  if (elements.page.querySelector('.sponsors-page')?.retainSponsors?.(result, model)) return;
  let view;
  if (result.target.kind === 'inscriptions') view = renderInscriptions(result, context);
  else if (['rune', 'runes'].includes(result.target.kind)) view = renderRunes(result, context);
  else if (result.error) view = renderError(result.error, result.target, context);
  else if (result.target.kind === 'home') view = renderHome(model, context);
  else if (result.target.kind === 'internal') {
    view = ({
      bookmarks: () => renderBookmarks(model, context), history: () => renderHistory(model, context), wallet: () => renderWallet(model, context),
      providers: () => renderProviders(model, context), services: () => renderServices(model, context), settings: () => renderSettings(model, context),
      'node-setup': () => renderNodeSetup(context),
      ai: () => renderAi(context),
      about: () => renderAbout(model, context), documentation: () => renderDocumentation(model, context),
      sponsors: () => renderSponsors(model, context)
    })[result.target.value]?.() ?? renderHome(model, context);
  } else if (result.target.kind === 'search') view = renderSearch(result, context);
  else if (result.target.kind === 'collection') view = renderCollection(result, context);
  else if (['inscription', 'inscription-number', 'content', 'recursive'].includes(result.target.kind)) view = renderInscription(result, context);
  else if (!result.entity && model.loading?.[model.activeTabId]) view = renderLoading(result, context);
  else view = renderEntity(result, context);
  clear(elements.page, view);
  elements['main-stage'].scrollTop = 0;
}

function renderDrawer() {
  const model = state();
  document.querySelectorAll('[data-drawer-tab]').forEach((node) => {
    const selected = node.dataset.drawerTab === model.drawerTab;
    node.classList.toggle('active', selected);
    node.setAttribute('aria-selected', String(selected));
    node.tabIndex = selected ? 0 : -1;
  });
  elements['drawer-body'].setAttribute('aria-labelledby', `drawer-tab-${model.drawerTab}`);
  clear(elements['drawer-body'], renderDeveloper(model, context));
}

async function toggleBookmark() {
  const result = currentResult();
  if (!result?.target || result.target.kind === 'home') return;
  try {
    const response = await api.bookmarks.toggle({ canonical: result.target.canonical, title: titleFor(result.target, result.entity), kind: result.target.kind });
    patch({ bookmarks: response.bookmarks }, { page: false });
    refreshLibraryPage('bookmarks');
    toast(response.bookmarked ? 'Bookmark added' : 'Bookmark removed', result.target.display, 'success');
  } catch (error) { toast('Bookmark failed', error.message, 'error'); }
}

async function clearHistory() {
  try {
    const history = await api.history.clear();
    MODEL.patch({ history });
    refreshLibraryPage('history');
    toast('History cleared', '', 'success');
  }
  catch (error) { toast('Could not clear history', error.message, 'error'); }
}

async function clearCache() {
  try { const cache = await api.cache.clear(); publishCache(cache); toast('Content cache cleared', '', 'success'); }
  catch (error) {
    const outcome = error?.details;
    if (outcome?.cacheClearCommitted === true) {
      const cache = outcome.cache;
      const hasSnapshot = cache && typeof cache === 'object' && !Array.isArray(cache)
        && Number.isSafeInteger(cache.entries) && cache.entries >= 0
        && Number.isSafeInteger(cache.bytes) && cache.bytes >= 0;
      if (hasSnapshot) publishCache(cache);
      const recovery = outcome.cacheReady === false
        ? 'Resolve the storage problem, then choose Clear content cache to retry initialization.'
        : 'Cache status could not be fully refreshed. Retry after resolving the reported problem.';
      toast('Cache removed; recovery incomplete', `${error.message}. ${recovery}${hasSnapshot ? '' : ' Displayed statistics have not been refreshed.'}`, 'error');
    } else {
      const uncertainty = outcome?.cacheClearCommitted === null
        ? ' Some cached files may already have been removed. Retry after resolving the storage problem.' : '';
      toast('Could not clear cache', `${error.message}${uncertainty}`, 'error');
    }
  }
}

async function refreshProviders() {
  const sequence = ++providerRefreshSequence;
  try {
    toast('Checking sources', 'Capability health checks are running.');
    await api.providers.health();
    const providers = await api.providers.list();
    if (providerRefreshSequence !== sequence) return;
    patch({ providers }, { page: routeName() === 'providers' || routeName() === 'home' });
    const healthy = providers.filter((provider) => provider.enabled && provider.network === state().settings.network && provider.health?.ok).length;
    toast('Source check complete', `${healthy} healthy source${healthy === 1 ? '' : 's'} on ${state().settings.network}.`, healthy ? 'success' : 'error');
  } catch (error) {
    if (providerRefreshSequence === sequence) toast('Source check failed', error.message, 'error');
  }
}

async function refreshProviderStatus() {
  // Main already checks eligible sources every minute. Publish those results
  // into the visible shell; previously only the explicit Health check did so.
  const sequence = providerRefreshSequence;
  const latest = await api.providers.list();
  if (sequence !== providerRefreshSequence) return;
  const byId = new Map(latest.map(provider => [provider.id, provider]));
  let changed = false;
  const providers = state().providers.map(provider => {
    const fresh = byId.get(provider.id);
    // Background health must not publish changed configuration or interfere
    // with sign-in recovery. All authority changes use their existing queue.
    if (!fresh || Boolean(fresh.routingBlocked) !== Boolean(provider.routingBlocked)
      || JSON.stringify({ ...fresh, health: undefined }) !== JSON.stringify({ ...provider, health: undefined })
      || JSON.stringify(fresh.health) === JSON.stringify(provider.health)) return provider;
    changed = true;
    return { ...provider, health: fresh.health };
  });
  if (!changed) return;
  patch({ providers }, { page: false, developer: false });
  updateProviderHealthViews(elements.page, providers);
  // Home retains its search field, disclosure state, focus, and scroll.
  if (routeName() === 'home') renderPage();
}

async function setPreferred(providerId) {
  return runProviderMutation('preferred', providerId, () => api.providers.preferred(providerId), {
    success: providerId ? 'Preferred source updated' : 'Automatic source routing restored', failure: 'Could not update routing'
  });
}

async function toggleProvider(provider) {
  return runProviderMutation('upsert', provider.id, () => {
    const current = state().providers.find((candidate) => candidate.id === provider.id);
    if (!current) throw new Error('The source is no longer available.');
    return api.providers.upsert({ ...current, enabled: !current.enabled });
  }, { success: 'Source updated', failure: 'Could not update source' });
}

function modalHeader(eyebrow, title) {
  return h('header', { className: 'modal-header' }, h('div', {}, h('span', { className: 'eyebrow' }, eyebrow), h('h2', { id: 'modal-title' }, title)), h('button', { className: 'icon-button modal-close', type: 'button', ariaLabel: 'Close dialog', onClick: closeModal }, '×'));
}

function overlayOpen(name) {
  return !elements[`${name}-backdrop`].classList.contains('hidden');
}

function canFocus(node) {
  return Boolean(node?.isConnected && typeof node.focus === 'function'
    && (node.tabIndex >= 0 || node.hasAttribute('tabindex') || node.isContentEditable)
    && !node.matches(':disabled')
    && !node.closest('[hidden], .hidden, [inert], [aria-hidden="true"]')
    && node.getClientRects().length);
}

function rememberOverlayFocus() {
  if (overlayOpen('modal') || overlayOpen('palette')) return;
  const target = document.activeElement;
  if (canFocus(target) && !elements['modal-backdrop'].contains(target) && !elements['palette-backdrop'].contains(target)) {
    overlayReturnFocus = target;
  }
}

function focusOverlay(name) {
  const generation = ++overlayFocusGeneration;
  setTimeout(() => {
    if (generation !== overlayFocusGeneration || !overlayOpen(name)) return;
    const container = name === 'modal' ? elements.modal : elements['palette-backdrop'].querySelector('.command-palette');
    // Respect focus placed inside the current overlay before this callback ran.
    if (canFocus(document.activeElement) && container.contains(document.activeElement)) return;
    const target = name === 'palette' ? elements['palette-input'] : (focusableElements(container)[0] ?? container);
    if (canFocus(target)) target.focus();
  }, 0);
}

function restoreOverlayFocus() {
  const generation = ++overlayFocusGeneration;
  const activeAtClose = document.activeElement;
  setTimeout(() => {
    if (generation !== overlayFocusGeneration || overlayOpen('modal') || overlayOpen('palette') || elements.app.inert) return;
    const target = overlayReturnFocus;
    overlayReturnFocus = null;
    const current = document.activeElement;
    // A command or user may already have moved focus to the next shell action.
    if (current !== activeAtClose && canFocus(current)
      && !elements['modal-backdrop'].contains(current) && !elements['palette-backdrop'].contains(current)) return;
    const destination = [target, elements.omnibox, elements['main-stage']].find(canFocus);
    destination?.focus();
  }, 0);
}

function focusableElements(container) {
  return [...container.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((node) => node.tabIndex >= 0 && canFocus(node));
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return;
  const focusable = focusableElements(container);
  if (!focusable.length) { event.preventDefault(); container.focus(); return; }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!focusable.includes(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function showModal(...children) {
  rememberOverlayFocus();
  const generation = ++modalGeneration;
  closePalette();
  clear(elements.modal, children);
  elements['modal-backdrop'].classList.remove('hidden');
  elements['modal-backdrop'].setAttribute('aria-hidden', 'false');
  elements.app.inert = true;
  focusOverlay('modal');
  return generation;
}

function closeModal() {
  if (elements['modal-backdrop'].classList.contains('hidden')) return;
  elements['modal-backdrop'].classList.add('hidden');
  elements['modal-backdrop'].setAttribute('aria-hidden', 'true');
  clear(elements.modal);
  if (elements['palette-backdrop'].classList.contains('hidden')) elements.app.inert = false;
  modalGeneration += 1;
  restoreOverlayFocus();
}

let formFieldSequence = 0;

function nextFormFieldId(reservedId = '') {
  let id;
  do { id = `form-field-${++formFieldSequence}`; }
  while (id === reservedId || document.getElementById(id));
  return id;
}

function formField(label, input, options = {}) {
  const isControl = ['INPUT', 'SELECT', 'TEXTAREA'].includes(input.tagName) && input.type !== 'hidden';
  if (isControl && !input.id) input.id = nextFormFieldId();
  const caption = isControl
    ? h('label', { className: 'form-field-label', htmlFor: input.id }, label)
    : h('span', { className: 'form-field-label', id: nextFormFieldId(input.id) }, label);
  const field = h('div', {
    className: `form-field${options.full ? ' full' : ''}`,
    role: isControl ? null : 'group',
    'aria-labelledby': isControl ? null : caption.id
  }, caption, input);
  if (options.help) {
    const help = h('span', { className: 'help', id: nextFormFieldId(input.id) }, options.help);
    const target = isControl ? input : field;
    const descriptions = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    target.setAttribute('aria-describedby', [...new Set([...descriptions, help.id])].join(' '));
    field.append(help);
  }
  return field;
}

function inputField(value = '', attributes = {}) { return h('input', { className: 'field', value, ...attributes }); }
function checkbox(label, checked) { return h('label', { className: 'check-label' }, h('input', { type: 'checkbox', checked }), h('span', {}, label)); }

const ALL_PROVIDER_CAPABILITIES = PROVIDER_CAPABILITIES;

function capabilitiesFor(type) {
  return defaultProviderCapabilitiesFor(type);
}

function providerCapabilityValidationMessage(capabilities, enabled) {
  return enabled && capabilities.length === 0
    ? 'Choose at least one supported capability, or disable this source while configuring it.'
    : null;
}

function incompatibleProviderCapabilities(provider) {
  return provider.capabilities.filter((capability) => !providerCapabilitiesFor(provider.type).includes(capability));
}

function refreshProviderMutationView() {
  if (routeName() === 'providers') renderPage();
}

let providerCleanupPublicationSequence = 0;

function validProviderCleanup(entry, allowHistorical = false) {
  const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(entry.id)
    && (uuid(entry.generation) || (allowHistorical && entry.generation === null))
    && typeof entry.conflict === 'boolean' && (entry.token === null || uuid(entry.token))
    && (!entry.conflict || entry.token === null)
    && typeof entry.message === 'string' && entry.message.length <= 4096);
}

function validProviderCleanupState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const errors = snapshot.stateReadErrors;
  if (errors !== undefined && (!errors || typeof errors !== 'object' || Array.isArray(errors))) return false;
  const error = snapshot.stateReadErrors?.cleanups;
  if (snapshot.cleanups === null) return Boolean(error && typeof error.code === 'string' && typeof error.message === 'string');
  return !error && Array.isArray(snapshot.cleanups)
    && new Set(snapshot.cleanups.map((entry) => entry?.id)).size === snapshot.cleanups.length
    && snapshot.cleanups.every((entry) => validProviderCleanup(entry));
}

function publishProviderCleanups(snapshot) {
  providerCleanupPublicationSequence += 1;
  if (snapshot.cleanups === null) return;
  providerCleanupRecovery.clear();
  for (const entry of snapshot.cleanups) providerCleanupRecovery.set(entry.id, { ...entry });
}

function publishProviderCleanupBootstrap(snapshot) {
  const valid = validProviderCleanupState(snapshot);
  if (valid) publishProviderCleanups(snapshot);
  providerOutcomeRecovery = !valid || snapshot.cleanups === null
    ? { message: 'Removed-source cleanup state is unavailable. Refresh source state before another change.' } : null;
}

function validProviderSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const providers = snapshot.providers;
  const settings = snapshot.settings;
  const providerValid = providers === null || (Array.isArray(providers)
    && new Set(providers.map((item) => item?.id)).size === providers.length
    && providers.every((item) => item && typeof item.id === 'string' && item.id.length > 0
      && typeof item.name === 'string' && typeof item.type === 'string' && typeof item.network === 'string'
      && typeof item.enabled === 'boolean' && Array.isArray(item.capabilities)
      && item.capabilities.every((value) => typeof value === 'string')));
  const settingsValid = settings === null || (settings && typeof settings === 'object' && !Array.isArray(settings)
    && typeof settings.network === 'string'
    && (settings.preferredProviderId === null || typeof settings.preferredProviderId === 'string'));
  const errors = snapshot.stateReadErrors;
  if (errors !== undefined && (!errors || typeof errors !== 'object' || Array.isArray(errors)
    || Object.keys(errors).some((key) => !['providers', 'settings', 'cleanups'].includes(key))
    || Object.values(errors).some((error) => !error || typeof error.code !== 'string' || typeof error.message !== 'string'))) return false;
  return Boolean(providerValid && settingsValid && validProviderCleanupState(snapshot)
    && (providers !== null || errors?.providers) && (settings !== null || errors?.settings)
    && !(providers !== null && errors?.providers) && !(settings !== null && errors?.settings));
}

function publishProviderSnapshot(snapshot) {
  const update = {};
  if (snapshot.providers !== null) update.providers = snapshot.providers;
  if (snapshot.settings !== null) update.settings = snapshot.settings;
  publishProviderCleanups(snapshot);
  providerRefreshSequence += 1;
  providerOutcomeRecovery = snapshot.providers === null || snapshot.settings === null || snapshot.cleanups === null
    ? { message: snapshot.cleanups === null
      ? 'Removed-source cleanup state is unavailable. Refresh source state before another change.'
      : 'Source state is incomplete. Refresh source state before another change.' } : null;
  patch(update, { page: routeName() === 'providers' });
}

function markProviderOutcomeUnknown(message) {
  providerRefreshSequence += 1;
  providerOutcomeRecovery = { message: `Source outcome is unconfirmed. Refresh source state before another change. ${message ?? ''}` };
  refreshProviderMutationView();
}

async function recoverProviderSnapshot() {
  if (providerSnapshotPending) return;
  providerSnapshotPending = true;
  refreshProviderMutationView();
  return queueAuthorityMutation(async () => {
    try {
      const snapshot = await api.providers.snapshot();
      if (!validProviderSnapshot(snapshot)) throw new Error('Invalid source-state response.');
      publishProviderSnapshot(snapshot);
      toast(providerOutcomeRecovery ? 'Source state refresh incomplete' : 'Source state refreshed',
        providerOutcomeRecovery?.message ?? 'No source mutation was replayed.', providerOutcomeRecovery ? 'error' : 'success');
    } catch (error) { markProviderOutcomeUnknown(error.message); toast('Source state refresh failed', error.message, 'error'); }
    finally { providerSnapshotPending = false; refreshProviderMutationView(); }
  });
}

function retryProviderCleanup(providerId) {
  const entry = providerCleanupRecovery.get(providerId);
  if (entry) openProviderCleanupModal(entry);
}

function openProviderCleanupModal(entry, historical = false) {
  if (providerOutcomeRecovery || providerSnapshotPending || pendingProviderMutations.has(entry?.id)) return;
  if (!validProviderCleanup(entry, historical) || !entry.token || entry.conflict
    || state().providers.some((provider) => provider.id === entry.id)) {
    toast('Cleanup needs review', 'This identifier is configured or has no current deletion review. Refresh source state and review it again.', 'error'); return;
  }
  const review = { ...entry };
  const publication = providerCleanupPublicationSequence;
  const acknowledgement = checkbox(`I approve permanently deleting only this app’s retained sign-in storage for source ID ${review.id}.`, false);
  const acknowledgeInput = acknowledgement.querySelector('input');
  const status = h('p', { className: 'help', role: 'status', 'aria-live': 'polite' });
  let modalOwner;
  let submitted = false;
  const close = () => { if (modalGeneration === modalOwner) closeModal(); };
  const cancelButton = button('Cancel', { onClick: close });
  const submitButton = button('Delete retained sign-in storage', { danger: true, disabled: true, onClick: async () => {
    if (submitted || modalGeneration !== modalOwner || !acknowledgeInput.checked) return;
    submitted = true;
    submitButton.disabled = true;
    acknowledgeInput.disabled = true;
    clear(cancelButton, 'Close');
    clear(status, 'Deleting the reviewed app-owned storage. This review can be used only once.');
    let nextReview = 'Close this dialog, refresh source state, and open a fresh deletion review before another attempt.';
    await runProviderMutation('cleanup', review.id, () => api.providers.cleanup({ id: review.id, token: review.token }), {
      success: 'Source credential cleanup completed', failure: 'Source credential cleanup failed',
      admit: () => {
        const current = providerCleanupRecovery.get(review.id);
        const unchanged = historical ? publication === providerCleanupPublicationSequence
          : current?.generation === review.generation && current?.token === review.token && !current?.conflict;
        if (modalGeneration === modalOwner && unchanged && !state().providers.some((provider) => provider.id === review.id)) return true;
        nextReview = 'This deletion review expired or was closed. Refresh source state and open a fresh review. No cleanup was sent.';
        toast('Cleanup review expired', nextReview, 'error'); return false;
      },
      committed: close
    });
    if (modalGeneration === modalOwner) clear(status, providerOutcomeRecovery
      ? 'Refresh source state to check the result. This cleanup will not be sent again.' : nextReview);
  } });
  acknowledgeInput.addEventListener('change', () => { submitButton.disabled = submitted || !acknowledgeInput.checked; });
  modalOwner = showModal(modalHeader('Review credential cleanup', review.id),
    h('p', { className: 'warning-box' }, historical
      ? 'No configured source currently uses this exact ID. The app found retained sign-in storage or cleanup information; this does not establish when or whether a source was removed.'
      : 'This source was removed, but its retained sign-in storage still needs cleanup.'),
    h('dl', {}, h('dt', {}, 'Exact source ID'), h('dd', {}, review.id)),
    h('p', {}, 'Permanently delete only this app’s retained credential entry and sign-in recovery information for this ID. No endpoint or account identity can be confirmed from this ID-only review.'),
    h('p', { className: 'help' }, 'Bitcoin Core cookie files, source configurations, other applications, and cached content are preserved.'),
    acknowledgement, status, h('div', { className: 'form-actions' }, cancelButton, submitButton));
}

function openProviderCleanupLookup() {
  if (providerOutcomeRecovery || providerSnapshotPending) return;
  const identifier = inputField('', { maxlength: 80, autocomplete: 'off', spellcheck: false });
  const status = h('p', { className: 'help', role: 'status', 'aria-live': 'polite' });
  let modalOwner;
  let pending = false;
  const submitButton = button('Review exact source ID', { primary: true, onClick: async () => {
    if (pending || modalGeneration !== modalOwner) return;
    const providerId = identifier.value;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(providerId)) {
      clear(status, 'Enter the exact source ID: 3–80 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.'); return;
    }
    if (providerOutcomeRecovery || providerSnapshotPending || pendingProviderMutations.has(providerId)
      || state().providers.some((provider) => provider.id === providerId)) {
      clear(status, 'This ID is configured or source state needs a refresh. Review configured sources before continuing.'); return;
    }
    pending = true;
    submitButton.disabled = true;
    identifier.disabled = true;
    const publication = providerCleanupPublicationSequence;
    const mutation = authorityMutationSequence;
    clear(status, 'Reviewing only the exact ID you entered. No deletion has been requested.');
    try {
      const review = await api.providers.reviewCleanup(providerId);
      if (modalGeneration !== modalOwner) return;
      if (publication !== providerCleanupPublicationSequence || mutation !== authorityMutationSequence
        || providerOutcomeRecovery || providerSnapshotPending || state().providers.some((provider) => provider.id === providerId)) {
        clear(status, 'Source state changed during the lookup. Submit this exact ID again for a fresh review.'); return;
      }
      if (!validProviderCleanup(review, true) || review.id !== providerId || !review.token || review.conflict) {
        clear(status, 'No current deletion review is available for this exact ID. Refresh source state before trying again.'); return;
      }
      openProviderCleanupModal(review, true);
    } catch (error) {
      if (modalGeneration === modalOwner) clear(status, error.message || 'This exact source ID could not be reviewed.');
    } finally {
      pending = false;
      if (modalGeneration === modalOwner) { submitButton.disabled = false; identifier.disabled = false; }
    }
  } });
  modalOwner = showModal(modalHeader('Review an older removed source', 'Look up an exact source ID'),
    h('p', {}, 'For older saved data, enter a source ID you already know. This read-only lookup checks only this app’s retained sign-in storage for that ID and does not prove a previous removal.'),
    formField('Exact source ID', identifier), status,
    h('div', { className: 'form-actions' }, button('Cancel', { onClick: () => { if (modalGeneration === modalOwner) closeModal(); } }), submitButton));
}

function runProviderMutation(operation, providerId, invoke, options = {}) {
  if (providerOutcomeRecovery || providerSnapshotPending) {
    toast('Refresh source state first', 'Use Refresh source state in Data sources; the mutation was not sent.', 'error');
    return Promise.resolve();
  }
  if (operation === 'upsert' && providerCleanupRecovery.has(providerId)) {
    toast('Credential cleanup required', 'Retry credential cleanup for this identifier before reusing it.', 'error'); return Promise.resolve();
  }
  // Preference intents remain ordered individually, including different IDs.
  if (operation !== 'preferred' && pendingProviderMutations.has(providerId)) {
    toast('Source change already pending', 'This edit was not sent. Wait for the existing change, then review the current source state.', 'error');
    return Promise.resolve();
  }
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  if (operation !== 'preferred') pendingProviderMutations.set(providerId, pending);
  options.pending?.(true);
  refreshProviderMutationView();
  const task = queueAuthorityMutation(async () => {
    try {
      if (providerOutcomeRecovery) { toast('Refresh source state first', 'The queued mutation was not sent.', 'error'); return; }
      if (operation === 'upsert' && providerCleanupRecovery.has(providerId)) {
        toast('Credential cleanup required', 'The queued edit was not sent because this identifier still needs cleanup.', 'error'); return;
      }
      if (options.admit && !options.admit()) return;
      let response;
      let failure = null;
      try { response = await invoke(); }
      catch (error) { failure = error; response = error?.details; }
      const valid = response && typeof response.providerMutationCommitted === 'boolean'
        && response.operation === operation && response.providerId === providerId && validProviderSnapshot(response)
        && (failure || response.providerMutationCommitted === true);
      if (!valid) {
        markProviderOutcomeUnknown(failure?.message ?? 'The mutation response did not match the requested operation.');
        toast('Source outcome unconfirmed', providerOutcomeRecovery.message, 'error');
        return;
      }
      publishProviderSnapshot(response);
      const committed = response.providerMutationCommitted;
      if (committed) {
        options.committed?.();
        reloadResolvableTarget();
      }
      const title = failure
        ? (committed ? `${operation === 'cleanup' ? 'Cleanup state saved' : options.success ?? 'Source change saved'}; recovery needed` : options.failure ?? 'Source change rejected')
        : (providerOutcomeRecovery ? `${options.success ?? 'Source change saved'}; refresh needed` : options.success ?? 'Source change saved');
      toast(title, [failure?.message, providerOutcomeRecovery?.message].filter(Boolean).join(' ') || providerId || '', failure || providerOutcomeRecovery ? 'error' : 'success');
    } finally {
      if (operation !== 'preferred') pendingProviderMutations.delete(providerId);
      options.pending?.(false);
      refreshProviderMutationView();
    }
  });
  task.then(finish, (error) => { markProviderOutcomeUnknown(error.message); toast('Source outcome unconfirmed', error.message, 'error'); finish(); });
  return pending;
}

function openProviderModal(provider = null) {
  if (providerOutcomeRecovery || providerSnapshotPending || pendingProviderMutations.has(provider?.id)) {
    toast('Source changes unavailable', 'Wait for the pending change or refresh source state in Data sources.', 'error'); return;
  }
  let modalOwner;
  let saving = false;
  const editing = Boolean(provider);
  const recoveryExplanation = provider?.routingBlocked ? providerRecoveryExplanation(provider) : null;
  const idInput = inputField(provider?.id ?? '', { placeholder: 'my-ord-mainnet', disabled: editing });
  const nameInput = inputField(provider?.name ?? '', { placeholder: 'My ord server' });
  const typeSelect = h('select', {}, ['ord-server', 'mempool', 'bitcoin-core', 'mock'].map((type) => h('option', { value: type, selected: provider?.type === type }, type)));
  const networkSelect = h('select', {}, ['mainnet', 'testnet', 'signet', 'regtest'].map((network) => h('option', { value: network, selected: (provider?.network ?? state().settings.network) === network }, network)));
  const baseInput = inputField(provider?.baseUrl ?? '', { placeholder: 'http://127.0.0.1:80' });
  const priorityInput = inputField(provider?.priority ?? 50, { type: 'number', min: 0, max: 1000 });
  const cookieInput = inputField(provider?.cookieFile ?? '', { placeholder: '/absolute/path/to/.cookie' });
  const usernameInput = inputField('', { placeholder: 'Stored in OS-protected storage', autocomplete: 'off' });
  const passwordInput = inputField('', { type: 'password', placeholder: recoveryExplanation ? 'Use Recover source to restore access' : editing && provider?.credentialsStored ? 'Leave blank to keep stored value' : 'Optional', autocomplete: 'new-password' });
  const enabled = checkbox('Enabled', provider?.enabled ?? true);
  const capabilityContainer = h('div', { className: 'capability-options' });
  const incompatibleLegacyCapabilities = editing ? incompatibleProviderCapabilities(provider) : [];
  const legacyCapabilityWarning = incompatibleLegacyCapabilities.length
    ? h('p', { className: 'help provider-capability-warning', role: 'status' },
      `This saved source declares capabilities unsupported by ${provider.type}: ${incompatibleLegacyCapabilities.join(', ')}. Saving repairs the declaration.`)
    : null;
  const renderCapabilities = () => {
    const values = editing && typeSelect.value === provider.type ? provider.capabilities : capabilitiesFor(typeSelect.value);
    clear(capabilityContainer, providerCapabilitiesFor(typeSelect.value).map((capability) => {
      const control = checkbox(capability, values.includes(capability)); control.dataset.capability = capability; return control;
    }));
    baseInput.disabled = typeSelect.value === 'mock';
    cookieInput.disabled = typeSelect.value !== 'bitcoin-core';
  };
  typeSelect.addEventListener('change', renderCapabilities); renderCapabilities();
  const save = async () => {
    if (saving || modalGeneration !== modalOwner) return;
    try {
      const capabilities = [...capabilityContainer.querySelectorAll('[data-capability]')].filter((node) => node.querySelector('input').checked).map((node) => node.dataset.capability);
      const capabilityError = providerCapabilityValidationMessage(capabilities, enabled.querySelector('input').checked);
      if (capabilityError) { toast('Could not save source', capabilityError, 'error'); return; }
      const config = {
        id: idInput.value.trim(), name: nameInput.value, type: typeSelect.value, network: networkSelect.value,
        baseUrl: typeSelect.value === 'mock' ? '' : baseInput.value, priority: Number(priorityInput.value), enabled: enabled.querySelector('input').checked,
        capabilities, cookieFile: cookieInput.value
      };
      const credentials = { username: usernameInput.value, password: passwordInput.value };
      return runProviderMutation('upsert', config.id, () => api.providers.upsert(config, credentials), {
        success: 'Source saved', failure: 'Could not save source',
        pending: (value) => { saving = value; saveButton.disabled = value; removeButton && (removeButton.disabled = value); },
        committed: () => { if (modalGeneration === modalOwner) closeModal(); }
      });
    } catch (error) { toast('Could not save source', error.message, 'error'); }
  };
  const saveButton = button('Save source', { primary: true, onClick: save });
  const removeButton = editing ? button('Remove', { danger: true, onClick: () => { if (!saving) confirmProviderRemoval(provider); } }) : null;
  modalOwner = showModal(modalHeader('Data source', editing ? `Edit ${provider.name}` : 'Add a data source'),
    ...(recoveryExplanation ? [h('div', { className: 'warning-box', role: 'status' },
      h('p', {}, recoveryExplanation),
      h('p', {}, 'Use Recover source to review and repair saved sign-in details. Saving this form with blank credentials does not complete recovery.'),
      providerRecoveryReview(provider) ? button('Recover source', { onClick: () => { if (!saving && modalGeneration === modalOwner) openProviderRecoveryModal(provider); } }) : null)] : []),
    h('div', { className: 'form-grid' },
      formField('Identifier', idInput, { help: 'Stable letters, numbers, dots, underscores, or hyphens.' }), formField('Name', nameInput),
      formField('Adapter type', typeSelect), formField('Bitcoin network', networkSelect),
      formField('Base URL', baseInput, { full: true, help: 'Loopback URLs are automatically classified as local.' }),
      formField('Priority', priorityInput, { help: 'Lower numbers are attempted first.' }), formField('Bitcoin Core cookie file', cookieInput),
      formField('RPC username', usernameInput), formField('RPC password', passwordInput),
      formField('Capabilities', h('div', {}, legacyCapabilityWarning, capabilityContainer), { full: true }), formField('Status', enabled, { full: true })
    ),
    h('div', { className: 'form-actions' }, removeButton, button('Cancel', { onClick: closeModal }), saveButton)
  );
}

function openProviderRecoveryModal(provider, requestedMode) {
  if (providerOutcomeRecovery || providerSnapshotPending || pendingProviderMutations.has(provider?.id)) {
    toast('Source recovery unavailable', 'Wait for the pending change or refresh source state in Data sources.', 'error'); return;
  }
  const current = state().providers.find((candidate) => candidate.id === provider?.id);
  const review = providerRecoveryReview(current, requestedMode);
  if (!review) { toast('Source recovery unavailable', 'This source no longer offers recovery. Refresh source state and review its current status.', 'error'); return; }
  const replaceBasic = review.mode === 'replace-basic';
  const authentication = replaceBasic ? 'RPC username and password'
    : review.type === 'bitcoin-core' ? (review.cookieFile ? 'Bitcoin Core cookie file' : 'No stored RPC username or password')
      : review.type === 'mock' ? 'Built-in source (no RPC authentication)' : 'Public API (no RPC authentication)';
  const actionExplanation = replaceBasic
    ? 'Enter a fresh RPC username and password for this destination. Recovery replaces this app’s saved RPC sign-in details and repairs its recovery information.'
    : `Clear only this app’s saved RPC username and password, and repair its recovery information. ${review.type === 'bitcoin-core' ? (review.cookieFile ? 'Bitcoin Core keeps using the configured cookie file; the file and its path are preserved.' : 'The browser will send no stored RPC sign-in details. Choose this only if the reviewed endpoint does not require them; this does not change server authentication requirements.') : 'This adapter does not use stored RPC Basic authentication.'}`;
  const usernameInput = replaceBasic ? inputField('', { autocomplete: 'off', maxlength: 256 }) : null;
  const passwordInput = replaceBasic ? inputField('', { type: 'password', autocomplete: 'new-password', maxlength: 4096 }) : null;
  const acknowledgement = checkbox(replaceBasic
    ? 'I reviewed this source and approve replacing its saved RPC sign-in details.'
    : 'I reviewed this source and approve clearing only this app’s stored RPC sign-in details.', false);
  const acknowledgeInput = acknowledgement.querySelector('input');
  const status = h('p', { className: 'help', role: 'status', 'aria-live': 'polite' });
  let modalOwner;
  let submitted = false;
  const clearCredentials = () => { if (usernameInput) usernameInput.value = ''; if (passwordInput) passwordInput.value = ''; };
  const cancel = () => { clearCredentials(); if (modalGeneration === modalOwner) closeModal(); };
  const cancelButton = button('Cancel', { onClick: cancel });
  const submit = async () => {
    if (submitted || modalGeneration !== modalOwner || !acknowledgeInput.checked) return;
    const credentials = replaceBasic ? { username: usernameInput.value, password: passwordInput.value } : null;
    clearCredentials();
    const credentialError = credentials ? providerRecoveryCredentialError(credentials.username, credentials.password) : null;
    if (credentialError) {
      credentials.username = ''; credentials.password = '';
      clear(status, credentialError); return;
    }
    submitted = true;
    submitButton.disabled = true;
    acknowledgeInput.disabled = true;
    if (usernameInput) usernameInput.disabled = true;
    if (passwordInput) passwordInput.disabled = true;
    clear(cancelButton, 'Close');
    clear(status, 'Recovering this source. The submitted review can be used only once.');
    let nextReview = 'Close this dialog and reopen Recover source to review the latest source state before another attempt.';
    const request = { id: review.id, token: review.token, mode: review.mode, ...(credentials ? { credentials } : {}) };
    try {
      await runProviderMutation('recover', review.id, async () => {
        try { return await api.providers.recover(request); }
        catch (error) {
          if (error.code === 'PROVIDER_RECOVERY_STALE') nextReview = 'This source review expired. Close this dialog and reopen Recover source to review the latest state.';
          throw error;
        }
      }, {
        success: 'Source recovered', failure: 'Could not recover source',
        admit: () => {
          if (providerRecoveryReviewMatches(state().providers.find((candidate) => candidate.id === review.id), review)) return true;
          nextReview = 'This source changed after you reviewed it. Close this dialog and reopen Recover source to review the latest state. No recovery was sent.';
          toast('Source review expired', nextReview, 'error'); return false;
        },
        committed: () => { if (modalGeneration === modalOwner) closeModal(); }
      });
    } finally {
      if (credentials) { credentials.username = ''; credentials.password = ''; delete request.credentials; }
      if (modalGeneration === modalOwner) clear(status, providerOutcomeRecovery
        ? 'Refresh source state in Data sources, then reopen Recover source to review the result. This recovery will not be sent again.' : nextReview);
    }
  };
  const submitButton = button(replaceBasic ? 'Replace sign-in details' : 'Clear stored sign-in details', { primary: true, disabled: true, onClick: submit });
  const alternateMode = review.type === 'bitcoin-core' && !review.cookieFile
    ? button(replaceBasic ? 'Use no stored sign-in details' : 'Use RPC sign-in instead', { onClick: () => {
      if (submitted || modalGeneration !== modalOwner) return;
      clearCredentials();
      openProviderRecoveryModal(current, replaceBasic ? 'clear-stored' : 'replace-basic');
    } }) : null;
  acknowledgeInput.addEventListener('change', () => { submitButton.disabled = submitted || !acknowledgeInput.checked; });
  modalOwner = showModal(modalHeader('Recover source', review.name),
    h('p', { className: 'warning-box' }, providerRecoveryExplanation(current)),
    h('dl', {},
      h('dt', {}, 'Source name'), h('dd', {}, review.name),
      h('dt', {}, 'Endpoint'), h('dd', {}, review.baseUrl || 'Built-in deterministic fixture provider'),
      h('dt', {}, 'Bitcoin network'), h('dd', {}, review.network),
      h('dt', {}, 'Authentication'), h('dd', {}, authentication),
      review.cookieFile ? [h('dt', {}, 'Cookie file'), h('dd', {}, review.cookieFile)] : null),
    h('p', {}, actionExplanation),
    h('p', { className: 'help' }, 'The source configuration, enabled setting, and routing preference are preserved. Recovery does not check whether the source is online.'),
    replaceBasic ? h('div', { className: 'form-grid' },
      formField('Fresh RPC username', usernameInput, { help: 'Spaces are preserved. Use the username for the endpoint reviewed above.' }),
      formField('Fresh RPC password', passwordInput, { help: 'Both fields are required; previous values are not reused.' })) : null,
    acknowledgement, status,
    h('div', { className: 'form-actions' }, alternateMode, cancelButton, submitButton));
}

function confirmProviderRemoval(provider) {
  if (providerOutcomeRecovery || providerSnapshotPending || pendingProviderMutations.has(provider.id)) return;
  let modalOwner;
  const removeButton = button('Remove permanently', { danger: true, onClick: () => modalGeneration !== modalOwner ? undefined : runProviderMutation('remove', provider.id, () => api.providers.remove(provider.id), {
    success: 'Source removed', failure: 'Could not remove source',
    pending: (value) => { removeButton.disabled = value; },
    committed: () => { if (modalGeneration === modalOwner) closeModal(); }
  }) });
  modalOwner = showModal(modalHeader('Remove source', provider.name),
    h('p', {}, 'This removes the local provider configuration and any stored credentials. Cached on-chain resources remain until the cache is cleared.'),
    h('div', { className: 'form-actions' }, button('Cancel', { onClick: closeModal }), removeButton)
  );
}

async function updateSettings(partial) {
  const requested = { ...partial };
  const routingChanged = ['network', 'localOnly', 'offlineMode', 'privacyMode'].some((key) => key in requested);
  return queueAuthorityMutation(async () => {
    try {
    const settings = await api.settings.update(requested);
    const update = { settings };
    if ('developerMode' in requested) update.developerOpen = settings.developerMode;
    providerRefreshSequence += 1;
    if (routingChanged) routingMaintenanceVersion += 1;
    patch(update, { page: true }); applyTheme();
    if ('network' in requested) toast('Network changed', String(settings.network).toUpperCase(), 'success');
    } catch (error) {
      if (['SETTINGS_CACHE_MAINTENANCE_FAILED', 'SETTINGS_NETWORK_CUTOFF_FAILED'].includes(error.code)
      && error.details?.settingsCommitted === true && error.details.settings) {
      const settings = error.details.settings;
      const update = { settings };
      if ('developerMode' in requested) update.developerOpen = settings.developerMode;
      providerRefreshSequence += 1;
      if (routingChanged) routingMaintenanceVersion += 1;
      patch(update, { page: true }); applyTheme();
      const title = error.code === 'SETTINGS_NETWORK_CUTOFF_FAILED'
        ? 'Settings saved; network cutoff failed'
        : 'Settings saved; cache maintenance failed';
      toast(title, error.message, 'error');
      } else {
        toast('Could not update settings', error.message, 'error'); renderPage();
      }
    }
  });
}

async function runPendingRoutingMaintenance(settledAuthoritySequence) {
  if (settledAuthoritySequence !== authorityMutationSequence) return;
  const version = routingMaintenanceVersion;
  if (version <= completedRoutingMaintenanceVersion) return;
  const authoritySequence = authorityMutationSequence;
  if (!state().settings.offlineMode) await refreshProviders();
  if (version <= completedRoutingMaintenanceVersion || authorityMutationSequence !== authoritySequence) return;
  reloadResolvableTarget();
  completedRoutingMaintenanceVersion = version;
}

function reloadResolvableTarget() {
  const result = currentResult();
  if (result && !['home', 'internal', 'search', 'collection'].includes(result.target?.kind)) reload();
}

async function exportDiagnostics() {
  if (diagnosticsExportPending) {
    toast('Diagnostics export already pending', 'Another export was not sent. Finish or cancel the existing export first.'); return;
  }
  diagnosticsExportPending = true;
  try { const filePath = await api.diagnostics.export(); toast('Diagnostics exported', filePath, 'success'); }
  catch (error) { if (error.code !== 'USER_REJECTED') toast('Diagnostics export failed', error.message, 'error'); }
  finally { diagnosticsExportPending = false; }
}

async function revealPath(kind) {
  try { await api.app.revealPath(kind); } catch (error) { toast('Could not reveal path', error.message, 'error'); }
}

function openDeveloper(tab = 'raw') {
  patch({ developerOpen: true, drawerTab: tab }, { page: false });
  if (tab === 'graph' && !state().graphs[activeTab()?.id]) loadGraph();
}

function toggleDeveloper() {
  if (state().settings.developerMode) updateSettings({ developerMode: false });
  else patch({ developerOpen: !state().developerOpen }, { page: false });
}

async function loadGraph() {
  const result = currentResult();
  const tab = activeTab();
  if (!tab || !result) return;
  const inscriptionId = result.entity?.summary?.id || (['inscription', 'content'].includes(result.target.kind) ? result.target.value : null);
  if (!inscriptionId || !/^[0-9a-f]{64}i\d+$/i.test(inscriptionId)) {
    toast('Graph unavailable', 'The active target does not expose a canonical inscription ID.', 'error'); return;
  }
  const canonical = result.target.canonical;
  const navigationSequence = state().requestSequence[tab.id];
  const request = { loading: true, data: null, error: null, canonical };
  const isCurrent = () => {
    const model = state();
    return model.graphs[tab.id] === request
      && model.tabs.some((candidate) => candidate.id === tab.id && candidate.target === canonical)
      && model.results[tab.id]?.target?.canonical === canonical
      && model.requestSequence[tab.id] === navigationSequence;
  };
  patch((model) => ({ ...model, graphs: { ...model.graphs, [tab.id]: request }, developerOpen: true, drawerTab: 'graph' }), { page: false });
  try {
    const data = await api.resolver.graph(inscriptionId);
    if (!isCurrent()) return;
    patch((model) => ({ ...model, graphs: { ...model.graphs, [tab.id]: { loading: false, data, error: null, canonical } } }), { page: false });
  } catch (error) {
    if (!isCurrent()) return;
    patch((model) => ({ ...model, graphs: { ...model.graphs, [tab.id]: { loading: false, data: null, error: normalizeError(error), canonical } } }), { page: false });
  }
}

async function saveContent(inscriptionId) {
  if (pendingContentSaves.has(inscriptionId)) {
    toast('Content save already pending', 'Another save for this inscription was not sent. Finish or cancel the existing save first.'); return;
  }
  pendingContentSaves.add(inscriptionId);
  try { const saved = await api.content.save(inscriptionId); toast('Inscription content saved', `${saved.bytes.toLocaleString()} bytes · ${saved.filePath}`, 'success'); }
  catch (error) { if (error.code !== 'USER_REJECTED') toast('Could not save content', error.message, 'error'); }
  finally { pendingContentSaves.delete(inscriptionId); }
}

async function openWalletBridge() {
  try { const wallet = await api.wallet.open(); patch({ wallet }, { page: routeName() === 'wallet' }); }
  catch (error) { toast('Wallet Bridge failed', error.message, 'error'); }
}

async function discoverWallets() {
  try { const wallet = await api.wallet.discover(); patch({ wallet }, { page: true }); toast('Wallet discovery complete', `${wallet.discovered.length} provider${wallet.discovered.length === 1 ? '' : 's'} found.`, wallet.discovered.length ? 'success' : ''); }
  catch (error) { toast('Wallet discovery failed', error.message, 'error'); }
}

async function connectWallet(walletId) {
  try {
    const walletState = await api.wallet.connect(walletId);
    patch((model) => ({ ...model, wallet: { ...model.wallet, state: walletState } }), { page: true });
    toast('Wallet connected', walletState.walletName || walletId, 'success');
  } catch (error) { if (error.code !== 'USER_REJECTED') toast('Wallet connection failed', error.message, 'error'); }
}

async function disconnectWallet() {
  try {
    const walletState = await api.wallet.disconnect();
    patch((model) => ({ ...model, wallet: { ...model.wallet, state: walletState } }), { page: true }); toast('Wallet disconnected', '', 'success');
  } catch (error) { toast('Could not disconnect wallet', error.message, 'error'); }
}

async function installExtension() {
  if (pendingExtensionAction) return;
  pendingExtensionAction = 'install';
  refreshWalletView();
  try {
    const result = await api.extensions.install();
    await publishExtensionMutation(result, 'install');
    toast('Wallet extension installed', 'Loaded only inside the isolated Wallet Bridge.', 'success');
  } catch (error) {
    const published = publishExtensionFailure(error, 'install');
    const unconfirmed = error.outcomeUnconfirmed || (Object.hasOwn(error.details ?? {}, 'extensionMutationCommitted') && !published);
    if (unconfirmed) markExtensionOutcomeUnconfirmed(error);
    if (error.code !== 'USER_REJECTED') toast(unconfirmed ? 'Extension outcome unconfirmed' : published && error.details.extensionMutationCommitted ? 'Extension installed, but wallet refresh failed' : 'Extension installation failed', unconfirmed ? `Refresh extensions and wallets before trying another change. ${error.message}` : error.message, 'error');
  } finally { pendingExtensionAction = null; refreshWalletView(); }
}

async function removeExtension(extensionId) {
  if (pendingExtensionAction) return;
  const id = String(extensionId);
  pendingExtensionAction = `remove:${id}`;
  refreshWalletView();
  try {
    const result = await api.extensions.remove(id);
    await publishExtensionMutation(result, 'remove');
    toast('Wallet extension removed', 'Wallet connection state was reset.', 'success');
  } catch (error) {
    const published = publishExtensionFailure(error, 'remove');
    const unconfirmed = error.outcomeUnconfirmed || (Object.hasOwn(error.details ?? {}, 'extensionMutationCommitted') && !published);
    if (unconfirmed) markExtensionOutcomeUnconfirmed(error);
    toast(unconfirmed ? 'Extension outcome unconfirmed' : published && error.details.extensionMutationCommitted ? 'Extension removed, but wallet refresh failed' : 'Could not remove extension', unconfirmed ? `Refresh extensions and wallets before trying another change. ${error.message}` : error.message, 'error');
  } finally { pendingExtensionAction = null; refreshWalletView(); }
}

function refreshWalletView() {
  if (routeName() === 'wallet') renderPage();
}

function publishExtensionSnapshot(wallet, extensions, recovery = undefined) {
  const current = state().wallet ?? {};
  const snapshot = wallet ?? current;
  MODEL.patch({ wallet: {
    ...snapshot,
    extensions: extensions ?? snapshot.extensions ?? current.extensions ?? [],
    extensionRecovery: recovery === undefined ? (snapshot.extensionRecovery ?? null) : recovery
  } });
  extensionOutcomeRecovery = null;
  refreshWalletView();
}

function markExtensionOutcomeUnconfirmed(error) {
  extensionOutcomeRecovery = {
    code: 'EXTENSION_OUTCOME_UNCONFIRMED',
    message: `The extension result could not be verified. Refresh extensions and wallets before trying another change. ${error.message}`
  };
  refreshWalletView();
}

function isExtensionMutationResult(result, operation) {
  return result?.extensionMutationCommitted === true
    && result.operation === operation
    && Array.isArray(result.extensions)
    && result.wallet && typeof result.wallet === 'object'
    && result.wallet.state && typeof result.wallet.state === 'object'
    && Array.isArray(result.wallet.discovered)
    && result.wallet.extensionsChanging === false
    && result.wallet.extensionRecovery === null
    && result.walletRefreshPending === false;
}

async function publishExtensionMutation(result, operation) {
  if (isExtensionMutationResult(result, operation)) {
    publishExtensionSnapshot(result.wallet, result.extensions);
    return;
  }
  if (result && typeof result === 'object' && Object.hasOwn(result, 'extensionMutationCommitted')) {
    const error = new Error('The extension response was incomplete or did not match the requested operation');
    error.code = 'INVALID_EXTENSION_RESPONSE';
    error.outcomeUnconfirmed = true;
    throw error;
  }
  // Compatibility with a pre-v2 main process: reconcile without resubmitting.
  const extensions = Array.isArray(result) ? result : await api.extensions.list();
  const wallet = await api.wallet.discover();
  publishExtensionSnapshot(wallet, extensions);
}

function publishExtensionFailure(error, operation) {
  const details = error?.details;
  if (!details || details.operation !== operation || typeof details.extensionMutationCommitted !== 'boolean'
    || typeof details.walletRefreshPending !== 'boolean' || !Array.isArray(details.extensions)
    || !details.wallet || typeof details.wallet !== 'object' || !details.wallet.state
    || typeof details.wallet.state !== 'object' || !Array.isArray(details.wallet.discovered)
    || details.wallet.extensionsChanging !== false
    || Boolean(details.wallet.extensionRecovery) !== details.walletRefreshPending) return false;
  const recovery = details.walletRefreshPending ? (details.wallet.extensionRecovery ?? {
    code: error.code ?? 'EXTENSION_WALLET_REFRESH_FAILED', message: error.message
  }) : (details.wallet.extensionRecovery ?? null);
  publishExtensionSnapshot(details.wallet, details.extensions, recovery);
  return true;
}

async function refreshExtensions() {
  if (pendingExtensionAction) return;
  pendingExtensionAction = 'refresh';
  refreshWalletView();
  let extensions = null;
  try {
    extensions = await api.extensions.list();
    const wallet = await api.wallet.discover();
    publishExtensionSnapshot(wallet, extensions);
    toast('Wallet extensions refreshed', '', 'success');
  } catch (error) {
    if (extensions) {
      const current = state().wallet ?? {};
      publishExtensionSnapshot(current, extensions, current.extensionRecovery ?? {
        operation: 'refresh', message: error.message, recovery: 'extensions:list'
      });
    }
    toast('Could not refresh wallet extensions', error.message, 'error');
  } finally { pendingExtensionAction = null; refreshWalletView(); }
}

async function inspectPsbt(psbt, container) {
  try { const preview = await api.psbt.inspect(psbt); renderPsbtPreview(preview, container); }
  catch (error) { clear(container, h('div', { className: 'warning-box' }, `${error.code}: ${error.message}`)); }
}

async function signPsbt(psbt) {
  try {
    const response = await api.wallet.signPsbt({ psbt, options: {} });
    showModal(modalHeader('Wallet result', 'PSBT signing completed'), h('pre', { className: 'raw-json' }, safeJson(response.result)), h('div', { className: 'form-actions' }, button('Close', { onClick: closeModal }), button('Copy result', { primary: true, onClick: () => context.copy(safeJson(response.result)) })));
  } catch (error) { if (error.code !== 'USER_REJECTED') toast('PSBT signing failed', error.message, 'error'); }
}

async function signMessage(message, address) {
  try {
    const response = await api.wallet.signMessage({ message, address });
    showModal(modalHeader('Wallet result', 'Message signature'), h('pre', { className: 'raw-json' }, safeJson(response)), h('div', { className: 'form-actions' }, button('Close', { onClick: closeModal }), button('Copy signature', { primary: true, onClick: () => context.copy(typeof response === 'string' ? response : safeJson(response)) })));
  } catch (error) { if (error.code !== 'USER_REJECTED') toast('Message signing failed', error.message, 'error'); }
}

function refreshServicesView() {
  if (routeName() !== 'services') return;
  if (!updateServicesView(elements.page, state(), context)) renderPage();
}

function publishServices(services) {
  // Service state has no chrome/drawer consumers. General patch() would also
  // replace tabs and disturb unrelated content or keyboard focus on every log.
  MODEL.patch({ services });
  refreshServicesView();
}

async function refreshServices() {
  if (pendingServiceRefresh) return;
  pendingServiceRefresh = true;
  try {
    refreshServicesView();
    publishServices(await api.services.list());
    toast('Local services refreshed', '', 'success');
  } catch (error) { toast('Could not refresh local services', error.message, 'error'); }
  finally { pendingServiceRefresh = false; refreshServicesView(); }
}

function openServiceModal(service = null) {
  let modalOwner;
  let pending = false;
  let savedConfig = null;
  const editing = Boolean(service);
  const idInput = inputField(service?.id ?? '', { placeholder: 'managed-ord', disabled: editing });
  const nameInput = inputField(service?.name ?? '', { placeholder: 'ord server' });
  const executableInput = inputField(service?.executable ?? '', { placeholder: '/absolute/path/to/ord' });
  const cwdInput = inputField(service?.cwd ?? '', { placeholder: 'Optional working directory' });
  const argsInput = h('textarea', { className: 'field', value: (service?.args ?? []).join('\n'), placeholder: 'One argument per line\nserver', style: { minHeight: '120px' } });
  const enabled = checkbox('Enabled', service?.enabled ?? true);
  const autoStart = checkbox('Start automatically with Bitcoin Browser', service?.autoStart ?? false);
  const controls = [idInput, nameInput, executableInput, cwdInput, argsInput, enabled.querySelector('input'), autoStart.querySelector('input')];
  const status = h('p', { className: 'help', role: 'status' });
  const updateControls = () => {
    for (const control of controls) control.disabled = pending || Boolean(savedConfig) || (control === idInput && editing);
    saveButton.disabled = pending;
    clear(saveButton, savedConfig ? 'Retry refresh' : 'Save service');
    if (removeButton) removeButton.disabled = pending || Boolean(savedConfig);
  };
  const save = async () => {
    if (pending || modalGeneration !== modalOwner) return;
    pending = true;
    updateControls();
    try {
      if (!savedConfig) {
        const config = {
          id: idInput.value, name: nameInput.value, executable: executableInput.value, cwd: cwdInput.value,
          args: argsInput.value.split(/\r?\n/).filter((value) => value !== ''), enabled: enabled.querySelector('input').checked, autoStart: autoStart.querySelector('input').checked
        };
        clear(status, 'Saving local service…');
        await api.services.upsert(config);
        // The write has committed. Recovery below must not submit it again.
        savedConfig = config;
      }
      clear(status, 'Local service saved. Refreshing the service list…');
      const services = await api.services.list();
      publishServices(services);
      if (modalGeneration === modalOwner) closeModal();
      toast('Local service saved', savedConfig.name, 'success');
    } catch (error) {
      clear(status, savedConfig
        ? `Your changes were saved. Retry refresh to update the service list. ${error.message}`
        : error.message);
      toast(savedConfig ? 'Local service saved, but refresh failed' : 'Could not save local service', error.message, 'error');
    } finally { pending = false; updateControls(); }
  };
  const saveButton = button('Save service', { primary: true, onClick: save });
  const removeButton = editing ? button('Remove', { danger: true, onClick: () => {
    if (!pending && !savedConfig && modalGeneration === modalOwner) confirmServiceRemoval(service);
  } }) : null;
  modalOwner = showModal(modalHeader('Local process', editing ? `Edit ${service.name}` : 'Add a local service'),
    h('div', { className: 'form-grid' },
      formField('Identifier', idInput), formField('Name', nameInput), formField('Absolute executable path', executableInput, { full: true }), formField('Working directory', cwdInput, { full: true }),
      formField('Arguments — one per line', argsInput, { full: true, help: 'Arguments are passed directly to the executable. No command shell is used.' }),
      formField('Status', enabled, { full: true }), formField('Launch behavior', autoStart, { full: true })
    ),
    status,
    h('div', { className: 'form-actions' }, removeButton, button('Cancel', { onClick: closeModal }), saveButton)
  );
}

function confirmServiceRemoval(service) {
  let modalOwner;
  let pending = false;
  let removed = false;
  const removeButton = button('Remove permanently', { danger: true, onClick: async () => {
    if (pending || removed || modalGeneration !== modalOwner) return;
    const { id, name } = service;
    pending = true;
    removeButton.disabled = true;
    try {
      const services = await api.services.remove(id);
      removed = true;
      publishServices(services);
      if (modalGeneration === modalOwner) closeModal();
      toast('Local service removed', name, 'success');
    } catch (error) {
      toast(removed ? 'Local service removed, but display update failed' : 'Could not remove service', error.message, 'error');
    } finally { pending = false; removeButton.disabled = removed; }
  } });
  modalOwner = showModal(modalHeader('Remove local service', service.name), h('p', {}, 'The managed process will be stopped before its configuration and local logs are removed.'),
    h('div', { className: 'form-actions' }, button('Cancel', { onClick: closeModal }), removeButton));
}

async function runServiceAction(serviceId, action) {
  if (pendingServiceActions.has(serviceId)) return;
  pendingServiceActions.set(serviceId, action);
  let committed = false;
  const label = action === 'start' ? 'Start' : 'Stop';
  try {
    refreshServicesView();
    await api.services[action](serviceId);
    committed = true;
    const services = await api.services.list();
    publishServices(services);
    const service = services.find((entry) => entry.id === serviceId);
    const expected = action === 'start' ? 'running' : 'stopped';
    if (service?.status === expected && (action === 'start' || !service.pid)) {
      toast(action === 'start' ? 'Local service started' : 'Local service stopped', serviceId, 'success');
    } else {
      toast(`${label} request completed`, service
        ? `${serviceId}: ${service.error || `Current status: ${service.status}`}`
        : `${serviceId}: service is no longer configured.`, service?.status === 'failed' ? 'error' : '');
    }
  } catch (error) {
    toast(committed ? `${label} request completed, but refresh failed` : `Could not ${action} service`,
      committed ? `Use Refresh services on Local node to retry. ${error.message}` : error.message, 'error');
  } finally { pendingServiceActions.delete(serviceId); refreshServicesView(); }
}

async function startService(serviceId) { return runServiceAction(serviceId, 'start'); }

async function stopService(serviceId) { return runServiceAction(serviceId, 'stop'); }

async function updateSuggestions() {
  closeSuggestions(); // An older candidate must not be accepted while a new parse is pending.
  if (!navigationReady) return;
  const value = elements.omnibox.value.trim();
  const token = suggestionToken;
  const owner = state().activeTabId;
  if (!value || value.length > 4_096) return;
  const candidates = [];
  try {
    const parsed = await api.navigation.parse(value);
    if (token !== suggestionToken) return;
    candidates.push({ ...parsed, title: parsed.kind === 'search' ? `Search saved items for “${value}”` : parsed.display,
      subtitle: parsed.kind === 'search' ? 'On this device · history and bookmarks' : parsed.canonical });
    for (const alternative of parsed.alternatives ?? []) candidates.push({ ...alternative, title: alternative.display, subtitle: alternative.canonical });
  } catch (error) {
    candidates.push({ kind: 'search', canonical: `search:${value}`, title: `Search saved items for “${value}”`, subtitle: 'On this device · history and bookmarks' });
  }
  if (token !== suggestionToken || owner !== state().activeTabId || document.activeElement !== elements.omnibox || elements.omnibox.value.trim() !== value) return;
  const lower = value.toLowerCase();
  for (const entry of [...state().bookmarks, ...state().history]) {
    if (candidates.length >= 9) break;
    if (`${entry.title} ${entry.canonical}`.toLowerCase().includes(lower) && !candidates.some((candidate) => candidate.canonical === entry.canonical)) {
      candidates.push({ kind: entry.kind, canonical: entry.canonical, title: entry.title, subtitle: entry.canonical });
    }
  }
  MODEL.patch({ suggestionIndex: 0 });
  clear(elements['omnibox-suggestions'], candidates.slice(0, 9).map((candidate, index) => h('button', {
    className: `suggestion${index === 0 ? ' selected' : ''}`, id: `omnibox-option-${token}-${index}`, type: 'button', role: 'option', tabindex: -1,
    'aria-selected': String(index === 0), dataset: { canonical: candidate.canonical, index },
    onMousedown: (event) => event.preventDefault(), onClick: () => { closeSuggestions(); navigate(candidate.canonical); }
  }, h('span', { className: 'suggestion-icon', 'aria-hidden': 'true' }, targetIcon(candidate.kind)), h('span', { className: 'suggestion-copy' }, h('strong', {}, candidate.title), h('span', {}, candidate.subtitle)))));
  elements['omnibox-suggestions'].classList.remove('hidden');
  elements.omnibox.setAttribute('aria-expanded', 'true');
  elements.omnibox.setAttribute('aria-activedescendant', `omnibox-option-${token}-0`);
  return token;
}

function moveSuggestion(delta) {
  const items = [...elements['omnibox-suggestions'].querySelectorAll('.suggestion')];
  if (!items.length) return;
  let index = state().suggestionIndex + delta;
  if (index < 0) index = items.length - 1;
  if (index >= items.length) index = 0;
  MODEL.patch({ suggestionIndex: index });
  items.forEach((item, candidateIndex) => {
    item.classList.toggle('selected', candidateIndex === index);
    item.setAttribute('aria-selected', String(candidateIndex === index));
  });
  elements.omnibox.setAttribute('aria-activedescendant', items[index].getAttribute('id'));
  items[index].scrollIntoView({ block: 'nearest' });
}

function chooseSuggestion() {
  const items = [...elements['omnibox-suggestions'].querySelectorAll('.suggestion')];
  const item = items[state().suggestionIndex];
  const target = item?.dataset.canonical ?? elements.omnibox.value;
  closeSuggestions();
  navigate(target);
}

function closeSuggestions() {
  suggestionToken += 1;
  elements['omnibox-suggestions'].classList.add('hidden');
  clear(elements['omnibox-suggestions']);
  elements.omnibox.setAttribute('aria-expanded', 'false');
  elements.omnibox.removeAttribute('aria-activedescendant');
  MODEL.patch({ suggestionIndex: -1 });
}

const COMMANDS = [
  { id: 'home', label: 'Go to Start', icon: '⌂', shortcut: '⌘⇧H', run: () => navigate('satnav://home') },
  { id: 'new-tab', label: 'New tab', icon: '+', shortcut: '⌘T', run: () => newTab() },
  { id: 'wallet', label: 'Open Wallet', icon: '◫', shortcut: '⌘⇧W', run: () => navigate('satnav://wallet') },
  { id: 'providers', label: 'Open Data sources', icon: '≋', run: () => navigate('satnav://providers') },
  { id: 'services', label: 'Open Local node', icon: '⛁', run: () => navigate('satnav://services') },
  { id: 'settings', label: 'Open Settings', icon: '⚙', run: () => navigate('satnav://settings') },
  { id: 'documentation', label: 'Open Documentation', icon: '?', run: () => navigate('satnav://documentation') },
  { id: 'developer', label: 'Toggle protocol inspector', icon: '{ }', shortcut: '⌘⇧I', run: toggleDeveloper },
  { id: 'health', label: 'Check provider health', icon: '↻', run: refreshProviders },
  { id: 'offline', label: 'Toggle offline mode', icon: '○', run: () => updateSettings({ offlineMode: !state().settings.offlineMode }) },
  { id: 'local', label: 'Toggle local-only routing', icon: '⌂', run: () => updateSettings({ localOnly: !state().settings.localOnly }) },
  { id: 'inscriptions', label: 'Explore inscriptions', icon: '◈', run: () => navigate('satnav://inscriptions') },
  { id: 'runes', label: 'Explore Runes', icon: 'ᚱ', run: () => navigate('satnav://runes') },
  { id: 'ai', label: 'Ask Bitcoin with your local AI', icon: '✧', run: openAiWorkspace },
  { id: 'node-setup', label: 'Set up a local Bitcoin node', icon: '⛁', run: () => navigate('satnav://node-setup') },
  { id: 'about', label: 'About Bitcoin Browser · Turtle Moon', icon: 'i', run: () => navigate('satnav://about') },
  { id: 'sponsors', label: 'Sponsors · HOL.org · Sponsorship inquiries', icon: '♡', run: () => navigate('satnav://sponsors') }
];

function openPalette() {
  rememberOverlayFocus();
  closeModal();
  elements['palette-backdrop'].classList.remove('hidden');
  elements['palette-backdrop'].setAttribute('aria-hidden', 'false');
  elements.app.inert = true;
  elements['palette-input'].value = '';
  elements['palette-input'].setAttribute('aria-expanded', 'true');
  renderPalette();
  focusOverlay('palette');
}

function closePalette() {
  if (elements['palette-backdrop'].classList.contains('hidden')) return;
  elements['palette-backdrop'].classList.add('hidden');
  elements['palette-backdrop'].setAttribute('aria-hidden', 'true');
  elements['palette-input'].setAttribute('aria-expanded', 'false');
  elements['palette-input'].removeAttribute('aria-activedescendant');
  if (elements['modal-backdrop'].classList.contains('hidden')) elements.app.inert = false;
  restoreOverlayFocus();
}

function paletteCandidates() {
  const query = elements['palette-input'].value.trim().toLowerCase();
  const commands = COMMANDS.filter((command) => !query || `${command.label} ${command.id}`.toLowerCase().includes(query));
  if (query) commands.unshift({ id: 'navigate', label: `Browse “${elements['palette-input'].value.trim()}”`, icon: '⌕', run: () => navigate(elements['palette-input'].value.trim()) });
  return commands;
}

function renderPalette() {
  const candidates = paletteCandidates();
  const index = Math.max(0, Math.min(state().paletteIndex, candidates.length - 1));
  MODEL.patch({ paletteIndex: index });
  const options = candidates.map((command, candidateIndex) => h('button', {
    className: `palette-result${candidateIndex === index ? ' selected' : ''}`, type: 'button', role: 'option',
    id: `palette-option-${command.id}`, tabindex: '-1', 'aria-selected': String(candidateIndex === index),
    onMousedown: (event) => event.preventDefault(),
    onClick: () => { closePalette(); command.run(); }
  }, h('span', { className: 'suggestion-icon', 'aria-hidden': 'true' }, command.icon), h('strong', {}, command.label), command.shortcut ? h('kbd', {}, command.shortcut) : null));
  clear(elements['palette-results'], options);
  const selected = options[index];
  if (selected && overlayOpen('palette')) {
    elements['palette-input'].setAttribute('aria-activedescendant', selected.id);
    selected.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  } else elements['palette-input'].removeAttribute('aria-activedescendant');
}

function movePalette(delta) {
  const candidates = paletteCandidates();
  if (!candidates.length) return;
  let index = state().paletteIndex + delta;
  if (index < 0) index = candidates.length - 1;
  if (index >= candidates.length) index = 0;
  MODEL.patch({ paletteIndex: index }); renderPalette();
}

function runPaletteSelection() {
  const candidates = paletteCandidates();
  const command = candidates[state().paletteIndex] ?? candidates[0];
  if (command) { closePalette(); command.run(); }
}

function executeCommand(command) {
  if (!navigationReady) return;
  const value = typeof command === 'string' ? command : command?.type;
  if (typeof value !== 'string') return;
  if (value === 'services-updated' && command.services) { publishServices(command.services); return; }
  // Native menu delivery must obey the same modal boundary as shell shortcuts.
  // Authoritative service events above remain live while an editor is open.
  if (!elements['modal-backdrop'].classList.contains('hidden') || !elements['palette-backdrop'].classList.contains('hidden')) return;
  const commands = {
    'new-tab': () => newTab(), 'close-tab': () => closeTab(), 'focus-omnibox': () => { elements.omnibox.focus(); elements.omnibox.select(); },
    reload, back: () => goHistory(-1), forward: () => goHistory(1), home: () => navigate('satnav://home'), wallet: () => navigate('satnav://wallet'),
    providers: () => navigate('satnav://providers'), services: () => navigate('satnav://services'), settings: () => navigate('satnav://settings'),
    about: () => navigate('satnav://about'), documentation: () => navigate('satnav://documentation'), developer: toggleDeveloper,
    sponsors: () => navigate('satnav://sponsors'),
    'skip-content': () => elements['main-stage'].focus(),
    'command-palette': openPalette
  };
  if (Object.hasOwn(commands, value)) commands[value]();
}

function handleShellDeepLink(url) {
  if (typeof url !== 'string' || url.length > 4_096 || !/^satnav:\/\/[^\s\u0000-\u001f\u007f]*$/i.test(url)) return;
  if (!navigationReady) {
    // Before saved state is installed, only the latest external navigation
    // intent is relevant. Never create a temporary tab that bootstrap replaces.
    pendingShellDeepLink = url;
    return;
  }
  return navigate(url);
}

function installEvents() {
  if (rendererEventsInstalled) return;
  document.addEventListener('click', (event) => {
    if (!navigationReady) return;
    const commandNode = event.target.closest('[data-command]');
    if (commandNode) executeCommand(commandNode.dataset.command);
    const routeNode = event.target.closest('[data-route]');
    if (routeNode) {
      if (routeNode.dataset.route === 'ai') openAiWorkspace();
      else navigate(`satnav://${routeNode.dataset.route}`);
    }
  });
  elements['new-tab'].addEventListener('click', () => { if (navigationReady) newTab(); });
  elements.back.addEventListener('click', () => { if (navigationReady) goHistory(-1); });
  elements.forward.addEventListener('click', () => { if (navigationReady) goHistory(1); });
  elements.reload.addEventListener('click', () => { if (navigationReady) reload(); });
  elements['bookmark-current'].addEventListener('click', () => { if (navigationReady) toggleBookmark(); });
  elements.omnibox.addEventListener('input', updateSuggestions);
  elements.omnibox.addEventListener('focus', () => { if (elements.omnibox.value) updateSuggestions(); });
  elements.omnibox.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== elements.omnibox) closeSuggestions(); }, 100));
  elements.omnibox.addEventListener('keydown', (event) => {
    if (!navigationReady || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); if (elements.omnibox.getAttribute('aria-expanded') === 'true') moveSuggestion(1); else updateSuggestions(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (elements.omnibox.getAttribute('aria-expanded') === 'true') moveSuggestion(-1); else updateSuggestions().then(token => { if (token === suggestionToken) moveSuggestion(-1); }); }
    else if (event.key === 'Enter') { event.preventDefault(); chooseSuggestion(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSuggestions(); }
    else if (event.key === 'Tab') closeSuggestions();
  });
  elements['close-developer'].addEventListener('click', () => {
    if (state().settings.developerMode) updateSettings({ developerMode: false });
    else patch({ developerOpen: false }, { page: false });
  });
  document.querySelectorAll('[data-drawer-tab]').forEach((node) => {
    node.addEventListener('click', () => openDeveloper(node.dataset.drawerTab));
    node.addEventListener('keydown', (event) => {
      const tabs = [...document.querySelectorAll('[data-drawer-tab]')];
      const index = tabs.indexOf(node);
      let nextIndex = null;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      openDeveloper(tabs[nextIndex].dataset.drawerTab);
      tabs[nextIndex].focus();
    });
  });
  elements['modal-backdrop'].addEventListener('mousedown', (event) => { if (event.target === elements['modal-backdrop']) closeModal(); });
  elements['modal-backdrop'].addEventListener('keydown', (event) => trapFocus(event, elements.modal));
  elements['palette-backdrop'].addEventListener('mousedown', (event) => { if (event.target === elements['palette-backdrop']) closePalette(); });
  elements['palette-backdrop'].addEventListener('keydown', (event) => trapFocus(event, elements['palette-backdrop'].querySelector('.command-palette')));
  elements['palette-input'].addEventListener('input', () => { MODEL.patch({ paletteIndex: 0 }); renderPalette(); });
  elements['palette-input'].addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); movePalette(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); movePalette(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); runPaletteSelection(); }
    else if (event.key === 'Escape') closePalette();
  });
  document.addEventListener('keydown', (event) => {
    if (!navigationReady) return;
    const modifier = (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey);
    if (event.key === 'Escape') { closeModal(); closePalette(); closeSuggestions(); }
    if (!elements['modal-backdrop'].classList.contains('hidden') || !elements['palette-backdrop'].classList.contains('hidden')) return;
    if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l') { event.preventDefault(); elements.omnibox.focus(); elements.omnibox.select(); }
    if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 't') { event.preventDefault(); newTab(); }
    if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'w') { event.preventDefault(); closeTab(); }
    if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') { event.preventDefault(); openPalette(); }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowLeft') { event.preventDefault(); goHistory(-1); }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowRight') { event.preventDefault(); goHistory(1); }
  });
  api.app.onCommand(executeCommand);
  api.app.onDeepLink(handleShellDeepLink);
  api.wallet.onState((wallet) => patch({ wallet }, { page: routeName() === 'wallet' }));
  rendererEventsInstalled = true;
}

function startProviderStatusMonitor() {
  if (providerStatusMonitor) return;
  providerStatusMonitor = createProviderStatusMonitor({
    enabled: () => navigationReady && !document.hidden && !state().settings.offlineMode
      && !providerOutcomeRecovery && !providerSnapshotPending && pendingProviderMutations.size === 0,
    refresh: refreshProviderStatus
  });
  providerStatusMonitor.start();
  window.addEventListener('pagehide', () => providerStatusMonitor.stop(), { once: true });
}

async function bootstrap() {
  if (bootstrapRunning) return;
  bootstrapRunning = true;
  navigationReady = false;
  try {
    elements.app.inert = true;
    installEvents();
    const bootstrapData = await api.app.bootstrap();
    // Keep the macOS safety inset until the trusted main process identifies the
    // platform. Never infer window-control placement from a user-agent string.
    elements.app.dataset.platform = ['darwin', 'win32', 'linux'].includes(bootstrapData.application?.platform)
      ? bootstrapData.application.platform : 'unknown';
    const savedTabs = bootstrapData.state.settings.restoreSession ? bootstrapData.state.tabs.map(safeTab) : [safeTab({ title: 'Start', target: 'satnav://home', history: ['satnav://home'], historyIndex: 0 })];
    const activeTabId = savedTabs.some((tab) => tab.id === bootstrapData.state.activeTabId) ? bootstrapData.state.activeTabId : savedTabs[0].id;
    const results = Object.fromEntries(savedTabs.map((tab) => [tab.id, null]));
    MODEL.set({
      ...state(), bootstrap: bootstrapData, settings: bootstrapData.state.settings, providers: bootstrapData.providers,
      cache: bootstrapData.cache, wallet: bootstrapData.wallet, services: bootstrapData.services,
      history: bootstrapData.state.history, bookmarks: bootstrapData.state.bookmarks, tabs: savedTabs, activeTabId, results,
      developerOpen: bootstrapData.state.settings.developerMode
    });
    publishProviderCleanupBootstrap(bootstrapData.providerCleanup);
    applyTheme(); renderChrome(); renderPage(); renderDrawer();
    elements.app.setAttribute('aria-busy', 'false');
    const deepLink = pendingShellDeepLink;
    pendingShellDeepLink = null;
    navigationReady = true;
    elements.app.inert = false;
    // No await between enabling delivery and admitting initial navigation:
    // a later deep link then supersedes it through normal navigation intents.
    if (deepLink) await navigate(deepLink);
    else await navigate(activeTab().target, { fromHistory: true, historyIndex: activeTab().historyIndex, record: false });
    if (bootstrapData.stateRecovery?.source === 'backup') {
      toast('State recovered from backup', 'The primary state file was unavailable. Recent changes may be missing; review your sources, tabs, and settings.', 'error');
    } else if (bootstrapData.stateRecovery?.source === 'defaults' && bootstrapData.stateRecovery.reason === 'invalid') {
      toast('Saved state could not be recovered', 'Default settings were loaded. Review your sources and preferences before browsing.', 'error');
    }
    if (!state().settings.offlineMode) refreshProviders().catch(() => {});
    startProviderStatusMonitor();
  } catch (error) {
    navigationReady = false;
    // Keep the rendered retry action usable, while command/input guards still
    // prevent mutations of an uninitialized session.
    elements.app.inert = false;
    elements.app.setAttribute('aria-busy', 'false');
    clear(elements.page, renderError(normalizeError(error), null, { ...context, retry: bootstrap }));
    toast('Bitcoin Browser could not start', error.message, 'error');
  } finally {
    bootstrapRunning = false;
  }
}

bootstrap();
