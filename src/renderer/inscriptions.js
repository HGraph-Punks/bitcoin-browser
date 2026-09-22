import { button, h, formatBytes, formatNumber, shorten } from './dom.js';
import { planLookup } from './search.js';
import { INSCRIPTION_ID_RE } from '../shared/navigation.js';
import { discoveryCanonical, discoveryQuery, DISCOVERY_PAGE_SIZE, inscriptionMediaType } from '../shared/discovery.js';
import { renderPopularAssets, updatePopularAssets } from './popular-assets.js';
import { COLLECTOR_FILTERS, inscriptionCollectorProfile, matchesCollectorFilter } from '../shared/ordinal-traits.js';

const FILTERS = Object.freeze([
  ['all', 'All'], ['images', 'Images'], ['text', 'Text'], ['interactive', 'Interactive'],
  ['audio', 'Audio'], ['video', 'Video'], ['models', '3D'], ['documents', 'Documents'], ['fonts', 'Fonts'], ['other', 'Other']
]);
const RASTER_TYPES = new Set(['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
let nextFormId = 0;

export function inscriptionSearchPlan(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim()) return { error: 'Enter an inscription number or ID to find it.' };
  let input = value.trim();
  try {
    const url = new URL(input);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      const numberOrId = url.hostname === 'ord.io' || url.hostname === 'www.ord.io'
        ? /^\/([0-9a-f]{64}i\d+|\d+)\/?$/i.exec(url.pathname)?.[1]
        : /^\/inscription\/([0-9a-f]{64}i\d+|#?-?\d+)\/?$/i.exec(url.pathname)?.[1];
      if (numberOrId) input = numberOrId;
    }
  } catch { /* Plain identifiers need no URL syntax. */ }
  const plan = planLookup(input, 'inscription');
  return plan.error ? { error: 'Use a number such as #12345, a full inscription ID, or a link to one. Name and collection-keyword search is not provided by this source.' } : plan;
}

function safeItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, DISCOVERY_PAGE_SIZE).filter(item => {
    if (!item || typeof item.id !== 'string' || item.id.length > 80 || !INSCRIPTION_ID_RE.test(item.id) || seen.has(item.id.toLowerCase())) return false;
    seen.add(item.id.toLowerCase());
    return true;
  });
}

function pageLink(value, block) {
  if (typeof value !== 'string' || !value.startsWith('satnav://inscriptions')) return null;
  try {
    const url = new URL(value);
    if (url.hostname !== 'inscriptions' || url.pathname || url.hash || url.username || url.password || url.port) return null;
    const parsed = discoveryQuery(url.search.slice(1));
    return parsed.block === block && discoveryCanonical(parsed) === value ? value : null;
  } catch { return null; }
}

function inscriptionCard(item, ctx, profile) {
  const id = item.id.toLowerCase();
  const canonical = `inscription:${id}`;
  const number = typeof item.number === 'string' && /^-?\d{1,16}$/.test(item.number) ? item.number : null;
  const title = number === null ? shorten(id, 10, 5) : `#${formatNumber(number)}`;
  const type = String(item.contentType ?? '').toLowerCase().split(';')[0].trim();
  const media = inscriptionMediaType(type);
  const label = FILTERS.find(([key]) => key === media)?.[1] ?? 'Other';
  const preview = h('div', { className: `inscription-preview media-${media}` },
    h('span', { className: 'inscription-placeholder', 'aria-hidden': 'true' }, ({ images: '◈', text: 'Aa', interactive: '</>', audio: '♫', video: '▶', models: '⬡', documents: '▤', fonts: 'Ag', other: '◇' })[media]),
    h('span', { className: 'inscription-preview-hint' }, media === 'interactive' ? 'Open to interact' : ['text', 'documents'].includes(media) ? 'Open to read' : media === 'models' ? 'Open to explore in 3D' : media === 'fonts' ? 'Open to try this font' : 'Open inscription'));
  if (RASTER_TYPES.has(type) && Number.isSafeInteger(item.contentLength) && item.contentLength > 0 && item.contentLength <= 2 * 1024 * 1024) {
    const image = h('img', { src: `ord://thumbnail/${id}`, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onError: () => image.remove() });
    preview.append(image);
  }
  const saved = ctx.model?.bookmarks?.some(entry => entry.canonical === canonical || (number !== null && entry.canonical === `inscription:${number}`));
  return h('button', { type: 'button', className: 'inscription-tile', ariaLabel: `Open inscription ${title}, ${label}${profile.rarity ? `, ${profile.rarity.label} sat` : ''}`, onClick: () => ctx.navigate(canonical) },
    preview,
    h('span', { className: 'inscription-tile-copy' },
      h('strong', {}, title),
      h('span', {}, item.metadataUnavailable ? 'Details unavailable' : `${label}${Number.isSafeInteger(item.contentLength) ? ` · ${formatBytes(item.contentLength)}` : ''}`),
      profile.rarity || profile.traits.length ? h('span', { className: 'inscription-tile-traits' },
        profile.rarity ? h('span', { className: `collector-badge${profile.rarity.key !== 'common' ? ' collector-special' : ''}` }, `${profile.rarity.label} sat`) : null,
        profile.traits.slice(0, 2).map(trait => h('span', { className: 'collector-badge' }, trait.label))) : null),
    saved ? h('span', { className: 'inscription-saved', 'aria-label': 'Bookmarked' }, '★ Saved') : null);
}

export function renderInscriptions(result, ctx) {
  const query = discoveryQuery(result.target.value ?? '');
  const data = result.entity?.data ?? {};
  const items = safeItems(data.items);
  const network = result.entity?.network ?? ctx.model?.settings?.network;
  const profiles = new Map(items.map(item => [item.id, inscriptionCollectorProfile(item, network)]));
  const knownRarity = [...profiles.values()].filter(profile => profile.rarity).length;
  const nonCommon = [...profiles.values()].filter(profile => profile.rarity && profile.rarity.key !== 'common').length;
  const busy = !result.entity && !result.error;
  const prefix = `inscription-search-${++nextFormId}`;
  const formError = h('p', { id: `${prefix}-error`, className: 'lookup-error', role: 'alert' });
  const input = h('input', { id: prefix, className: 'field', type: 'search', maxlength: 2048,
    placeholder: 'Inscription number, ID, or link', autocomplete: 'off', spellcheck: 'false',
    'aria-describedby': `${prefix}-help ${prefix}-error`,
    onInput: () => { formError.textContent = ''; input.setAttribute('aria-invalid', 'false'); } });
  const form = h('form', { className: 'inscription-search', role: 'search', ariaLabel: 'Find an inscription', onSubmit: event => {
    event.preventDefault();
    const plan = inscriptionSearchPlan(input.value);
    formError.textContent = plan.error ?? '';
    input.setAttribute('aria-invalid', String(Boolean(plan.error)));
    if (plan.error) input.focus(); else ctx.navigate(plan.target);
  } },
  h('label', { htmlFor: prefix }, 'Find an inscription'),
  h('div', { className: 'inscription-search-controls' }, input, h('button', { type: 'submit', className: 'button primary' }, 'Find')),
  h('p', { id: `${prefix}-help`, className: 'help' }, 'Search by number or ID across your source’s inscription index. No special syntax needed.'), formError);

  const blockError = h('p', { id: `${prefix}-block-error`, role: 'alert', className: 'lookup-error' });
  const blockInput = h('input', { id: `${prefix}-block`, className: 'field', inputmode: 'numeric', value: query.block === null ? '' : String(query.block), maxlength: 8, placeholder: 'For example, 840000', 'aria-describedby': `${prefix}-block-error` });
  const blockForm = h('form', { className: 'inscription-block-form', onSubmit: event => {
    event.preventDefault();
    try {
      const raw = blockInput.value.trim();
      if (!/^\d{1,8}$/.test(raw)) throw new Error('Invalid block');
      const target = discoveryCanonical({ block: Number(raw) });
      blockError.textContent = ''; blockInput.setAttribute('aria-invalid', 'false'); ctx.navigate(target);
    } catch { blockError.textContent = 'Enter a whole block height between 0 and 10,000,000.'; blockInput.setAttribute('aria-invalid', 'true'); blockInput.focus(); }
  } }, h('label', { htmlFor: `${prefix}-block` }, 'Bitcoin block height'),
  h('div', { className: 'inscription-search-controls' }, blockInput, h('button', { type: 'submit', className: 'button' }, 'Browse block')), blockError);

  const status = h('p', { className: 'inscription-result-count', role: 'status', 'aria-live': 'polite' });
  const grid = h('div', { className: 'inscription-grid', 'aria-label': 'Inscription results' });
  const filters = h('div', { className: 'inscription-filters', role: 'group', ariaLabel: 'Filter this page by content type' });
  let activeMedia = 'all';
  const traitSelect = h('select', { id: `${prefix}-trait`, className: 'inscription-trait-filter', value: 'all',
    disabled: busy || Boolean(result.error), 'aria-describedby': `${prefix}-trait-help`, onChange: () => setFilter(activeMedia) },
    COLLECTOR_FILTERS.map(([value, label]) => h('option', { value }, label)));
  const counts = new Map(FILTERS.map(([key]) => [key, key === 'all' ? items.length : items.filter(item => inscriptionMediaType(item.contentType) === key).length]));
  const setFilter = selected => {
    activeMedia = selected;
    const traitItems = items.filter(item => matchesCollectorFilter(profiles.get(item.id), traitSelect.value));
    const shown = selected === 'all' ? traitItems : traitItems.filter(item => inscriptionMediaType(item.contentType) === selected);
    for (const control of filters.querySelectorAll('button')) {
      control.setAttribute('aria-pressed', String(control.dataset.filter === selected));
      const [key, label] = FILTERS.find(([key]) => key === control.dataset.filter);
      control.textContent = `${label} ${key === 'all' ? traitItems.length : traitItems.filter(item => inscriptionMediaType(item.contentType) === key).length}`;
    }
    const traitLabel = COLLECTOR_FILTERS.find(([key]) => key === traitSelect.value)?.[1];
    status.textContent = result.error ? 'Results unavailable' : busy ? 'Loading inscriptions…' : `${shown.length} of ${items.length} inscriptions on this page${selected === 'all' ? '' : ` · ${FILTERS.find(([key]) => key === selected)[1]}`}${traitSelect.value === 'all' ? '' : ` · ${traitLabel}`}`;
    grid.replaceChildren(...shown.map(item => inscriptionCard(item, ctx, profiles.get(item.id))));
    if (!busy && !result.error && !shown.length) grid.append(h('div', { className: 'inscription-empty' },
      h('h2', {}, items.length ? 'No matches on this page' : 'No inscriptions on this page'),
      h('p', {}, items.length ? 'Clear the filters to see this page, or continue to older inscriptions. These filters do not search the entire index.' : 'Try another block or return to the latest inscriptions.'),
      button(items.length ? traitSelect.value === 'all' ? 'Show all types' : 'Clear filters' : 'Browse latest', { onClick: () => {
        if (items.length) { traitSelect.value = 'all'; setFilter('all'); } else ctx.navigate(discoveryCanonical());
      } })));
  };
  for (const [key, label] of FILTERS) filters.append(h('button', { type: 'button', className: 'chip', dataset: { filter: key }, disabled: busy || Boolean(result.error), 'aria-pressed': key === 'all' ? 'true' : 'false', onClick: () => setFilter(key) }, `${label} ${counts.get(key)}`));
  setFilter('all');

  const previous = pageLink(data.previous, query.block);
  const next = pageLink(data.next, query.block);
  const offlineMiss = ctx.model?.settings?.offlineMode && result.error?.code === 'OFFLINE_CACHE_MISS';
  const error = result.error ? h('section', { className: 'inscription-notice', role: 'alert' },
    h('h2', {}, offlineMiss ? 'This page is not saved offline' : 'This inscription page could not be loaded'),
    h('p', {}, offlineMiss ? 'Previously cached pages remain available. Go online to discover more inscriptions.' : ctx.model?.settings?.offlineMode ? 'The saved page could not be read. Retry, or check storage access. Your other browser tools still work.' : 'Your other browser tools still work. Retry, or check that an inscription source is enabled for your network.'),
    button('Try again', { primary: true, onClick: () => ctx.retry() }),
    button('Data sources', { onClick: () => ctx.navigate('satnav://providers') }),
    h('details', {}, h('summary', {}, 'Technical details'), h('p', {}, `${result.error.code ?? 'ERROR'}: ${String(result.error.message ?? '').slice(0,1000)}`))) : null;
  const root = h('div', { className: 'inscription-explorer', dataset: { galleryCanonical: result.target.canonical, galleryOwner: ctx.model?.activeTabId ?? '' } },
    h('header', { className: 'inscription-explorer-header' }, h('div', {},
      h('span', { className: 'eyebrow' }, 'Explore Bitcoin'),
      h('h1', {}, 'Inscriptions'), h('p', {}, 'Discover digital artifacts on Bitcoin. Open anything that catches your eye.')),
      button('Bookmarks', { icon: '☆', onClick: () => ctx.navigate('satnav://bookmarks') })),
    form,
    h('div', { className: 'inscription-explore-tools' },
      button('Browse latest', { small: true, onClick: () => ctx.navigate(discoveryCanonical(), { record: false }) }),
      button('First inscription', { small: true, onClick: () => ctx.navigate('inscription:0') }),
      h('details', { className: 'inscription-block-disclosure' }, h('summary', {}, 'Find by block'), blockForm)),
    renderPopularAssets('inscriptions', ctx),
    h('section', { className: 'inscription-results', 'aria-busy': String(busy) },
      h('div', { className: 'inscription-results-heading' }, h('h2', {}, query.block === null ? 'All inscriptions' : `Block ${formatNumber(query.block)}`),
        h('span', { className: 'help' }, result.entity?.source?.name ? `${result.cache ? 'Cached · ' : ''}${String(result.entity.source.name).slice(0,80)}` : 'Your configured inscription sources')),
      h('p', { className: 'help' }, 'Content-type filters apply to this page.'), filters, status, error,
      h('div', { className: 'inscription-collector-tools' }, h('label', { htmlFor: `${prefix}-trait` }, 'Collector trait'), traitSelect),
      h('p', { className: 'help', id: `${prefix}-trait-help` }, 'Collector filters apply only to the loaded page and combine with content type. Missing traits are not proof of their absence.'),
      !busy && !result.error && items.length ? h('p', { className: 'inscription-rarity-summary' }, `This page: ${nonCommon} inscriptions on known non-common sats · Sat rarity available for ${knownRarity} of ${items.length} inscriptions. These are page counts, not collection rarity ranks.`) : null,
      busy ? h('div', { className: 'inscription-grid inscription-skeletons', 'aria-hidden': 'true' }, Array.from({ length: 8 }, () => h('div', { className: 'inscription-skeleton' }))) : grid,
      data.partial ? h('p', { className: 'help' }, 'Some details are temporarily unavailable. You can still open those inscriptions, or refresh this page.') : null,
      h('nav', { className: 'inscription-pagination', ariaLabel: 'Inscription pages' },
        button('← Newer', { disabled: busy || !previous, onClick: () => previous && ctx.navigate(previous) }),
        h('span', {}, `Page ${formatNumber(query.page * 5 + Math.floor(query.offset / DISCOVERY_PAGE_SIZE) + 1)}`),
        button('Older →', { disabled: busy || !next, onClick: () => next && ctx.navigate(next) }))),
    h('details', { className: 'inscription-about-results' }, h('summary', {}, 'About these results'),
      h('p', {}, 'Browse all inscriptions indexed by your configured source, not just saved history. Number and ID searches open the exact inscription. Global name, collection-keyword, and content-text search require an additional indexer and are not available here.'),
      h('p', {}, 'Images up to 2 MB can preview automatically. Interactive content, text, audio, and video open only when selected. Previews use the browser’s existing source routing, privacy settings, and offline cache. A live index can change between pages.'),
      h('p', {}, 'Sat rarity and mathematical traits are calculated locally on mainnet when a sat number is supplied. Other charms are reported by the source. Open an inscription’s Details for explanations, provenance and any disagreements. Sat rarity is not an artwork ranking or price estimate.'),
      button('Data sources', { small: true, onClick: () => ctx.navigate('satnav://providers') }),
      button('Advanced Bitcoin lookup', { small: true, onClick: () => ctx.navigate('satnav://home') })));
  root.galleryPublication = galleryPublication(result, ctx);
  root.querySelector('.inscription-results').restoreCollectorFilter = (value, media = activeMedia) => {
    traitSelect.value = COLLECTOR_FILTERS.some(([key]) => key === value) ? value : 'all';
    setFilter(FILTERS.some(([key]) => key === media) ? media : 'all');
  };
  return root;
}

function galleryPublication(result, ctx) {
  return [result.entity, result.error, result.cache, ctx.model?.bookmarks, ctx.model?.settings?.network, ctx.model?.settings?.offlineMode];
}

// Keep user-owned drafts, disclosure state and input focus across same-tab
// loading/success/error publications. Other tabs/routes never inherit drafts.
export function updateInscriptions(root, result, ctx) {
  if (!root || root.dataset.galleryCanonical !== result.target.canonical
      || root.dataset.galleryOwner !== (ctx.model?.activeTabId ?? '')) return false;
  updatePopularAssets(root);
  const publication = galleryPublication(result, ctx);
  if (root.galleryPublication?.every((value, index) => value === publication[index])) return true;
  const previous = root.querySelector('.inscription-results');
  if (!previous) return false;
  const selected = Array.from(previous.querySelectorAll('button')).find(node => node.getAttribute('aria-pressed') === 'true')?.dataset.filter;
  const oldTrait = previous.querySelector('.inscription-trait-filter');
  const focused = document.activeElement;
  const replacement = renderInscriptions(result, ctx).querySelector('.inscription-results');
  previous.replaceWith(replacement);
  replacement.restoreCollectorFilter(oldTrait?.value, selected);
  const filter = Array.from(replacement.querySelectorAll('button')).find(node => node.dataset.filter === selected);
  if (focused === oldTrait) replacement.querySelector('.inscription-trait-filter').focus();
  else if (focused?.dataset?.filter === selected && filter && !filter.disabled) filter.focus();
  root.galleryPublication = publication;
  return true;
}
