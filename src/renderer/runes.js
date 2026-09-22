import { absoluteTime, bookmarkButton, button, clear, formatNumber, h, safeJson, updateBookmarkControls } from './dom.js';
import { runeLookup, runeIdentity, runesQuery, runesCanonical, formatRuneAmount, runeCollectorStats, runeMintState, RUNES_PAGE_LIMIT } from '../shared/runes.js';
import { renderPopularAssets, updatePopularAssets } from './popular-assets.js';

let nextFormId = 0;
const MINT_LABELS = Object.freeze({ fixed: 'Fixed supply', open: 'Mint open at retrieval', closed: 'Mint not open at retrieval', unknown: 'Mint status unavailable' });

function collectorInsights(rune) {
  const stats = runeCollectorStats(rune);
  if (!stats) return null;
  return h('section', { className: 'rune-insights', ariaLabel: 'Rune supply insights' },
    h('h3', {}, 'Supply at a glance'),
    h('div', { className: 'rune-insight-grid' },
      h('div', {}, h('h4', {}, rune.terms ? 'Mint progress' : 'Supply model'),
        h('strong', {}, rune.terms ? stats.mintProgress?.text ?? 'No mint capacity' : 'Fixed at creation'),
        stats.mintProgress ? h('progress', { max: 10000, value: stats.mintProgress.basisPoints, ariaLabel: 'Mint cap used', 'aria-valuetext': `${stats.mintProgress.text} of the mint cap used` }) : null,
        h('p', {}, rune.terms ? `${formatNumber(rune.mints)} of ${formatNumber(rune.terms.cap ?? '0')} mints completed. ${formatNumber(stats.remainingMints)} mint slots remain under the cap.` : 'No public mint was defined for this Rune.'),
        rune.terms ? h('p', {}, 'Remaining capacity does not mean the mint is open. Block limits and the source’s mint status still apply.') : null),
      h('div', {}, h('h4', {}, 'Initial allocation share'),
        h('strong', {}, stats.premineShare?.text ?? 'Unavailable'),
        h('p', {}, 'Premine as a share of the maximum possible supply—not the creator’s current holdings.'),
        !stats.premineShare ? h('p', {}, 'A zero or unrepresentable maximum has no percentage.') : null),
      h('div', {}, h('h4', {}, 'Burned share'),
        h('strong', {}, stats.burnedShare?.text ?? 'No supply created'),
        h('p', {}, 'Permanently burned units as a share of all units created so far.'))),
    h('p', { className: 'help' }, 'Calculated from this source snapshot. Percentages are truncated to two decimals; exact quantities are shown below. These are supply facts, not rarity ranks or investment ratings.'));
}

function runeCard(item, ctx) {
  const stats = runeCollectorStats(item);
  return h('button', { className: 'rune-card', type: 'button', ariaLabel: `Open Rune ${item.name}`, onClick: () => ctx.navigate(`rune:${item.name}`) },
    h('span', { className: 'rune-card-symbol', 'aria-hidden': 'true' }, item.symbol ?? 'ᚱ'),
    h('span', { className: 'rune-card-copy' }, h('strong', {}, item.name),
      h('span', {}, item.id ? `${item.id} · ${MINT_LABELS[runeMintState(item)]}` : 'View supply & mint details'),
      item.runeVersion === 1 ? h('span', { className: 'rune-card-stats' }, `Available supply: ${formatRuneAmount(item.outstanding, item.divisibility)}`) : null,
      stats?.mintProgress ? h('span', { className: 'rune-card-stats' }, `${stats.mintProgress.text} of mint cap used · ${formatNumber(stats.remainingMints)} slots remaining`) : null),
    h('span', { 'aria-hidden': 'true' }, '→'));
}

export function runeSearchPlan(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid input');
    let input = value.trim().replace(/^rune:/i, '');
    if (/^(?:https?:|satnav:)/i.test(input)) {
      const url = new URL(input);
      if (url.username || url.password || url.hash) throw new Error('Invalid link');
      const path = url.protocol === 'satnav:' && url.hostname === 'rune' ? url.pathname.slice(1) : /^\/rune\/([^/]+)\/?$/.exec(url.pathname)?.[1];
      if (!path) throw new Error('Invalid link');
      input = decodeURIComponent(path);
    }
    return { target: `rune:${runeLookup(input)}` };
  } catch { return { error: 'Enter the full Rune name, an ID such as 840000:1, or a link to a Rune. Spaces and dots work in place of •.' }; }
}

function safeItems(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).slice(0, RUNES_PAGE_LIMIT).filter(item => {
    try {
      const key = runeIdentity(item?.name);
      if (key.includes(':') || seen.has(key) || runeLookup(item.name) !== item.name) return false;
      seen.add(key); return true;
    } catch { return false; }
  });
}
function pageLink(value, expected) {
  try { return value === runesCanonical(expected) ? value : null; } catch { return null; }
}
function sourceNote(result, ctx) {
  const entity = result.entity;
  return h('p', { className: 'rune-source' },
    entity ? `${result.cache || ctx.model?.settings?.offlineMode ? 'Cached snapshot · ' : 'Snapshot · '}${entity.source?.name ?? 'Configured source'} · ${entity.network ?? ctx.model?.settings?.network ?? 'Unknown network'} · Retrieved ${absoluteTime(entity.fetchedAt)}` : 'Uses your configured Ord sources. No account or wallet connection needed.');
}
function unavailable(result, ctx) {
  return h('section', { className: 'rune-panel rune-notice', role: 'alert' },
    h('h2', {}, ctx.model?.settings?.offlineMode ? 'This Rune page is unavailable offline' : 'This Rune page could not be loaded'),
    h('p', {}, ctx.model?.settings?.offlineMode
      ? 'Previously cached pages remain available. Go online to discover more Runes.'
      : 'Check the name or ID, retry, or choose an Ord source with Rune indexing enabled for your network. Your other browser tools still work.'),
    button('Try again', { primary: true, onClick: () => ctx.retry() }),
    button('Data sources', { onClick: () => ctx.navigate('satnav://providers') }),
    h('details', {}, h('summary', {}, 'Technical details'), h('p', {}, `${result.error?.code ?? 'RUNE_DATA_UNAVAILABLE'}: ${String(result.error?.message ?? 'Refresh to load the updated Rune view.').slice(0, 1000)}`)));
}
function metric(label, value, help) {
  return h('div', { className: 'rune-metric' }, h('dt', {}, label), h('dd', {}, value), h('p', {}, help));
}
function detail(result, ctx) {
  const rune = result.entity?.data;
  if (rune?.runeVersion !== 1 || !safeItems([rune]).length) return unavailable(result, ctx);
  const quantity = value => formatRuneAmount(value, rune.divisibility);
  const mintStatus = MINT_LABELS[runeMintState(rune)];
  const stats = runeCollectorStats(rune);
  const canonical = result.target.canonical;
  const related = h('div', { className: 'rune-actions' });
  if (!/^0{64}$/.test(rune.etching ?? '') && /^[0-9a-f]{64}$/.test(rune.etching ?? '')) related.append(button('Creation transaction', { onClick: () => ctx.navigate(`tx:${rune.etching}`) }));
  if (!rune.predefined && /^\d{1,20}$/.test(rune.block ?? '')) related.append(button(`Block ${formatNumber(rune.block)}`, { onClick: () => ctx.navigate(`block:${rune.block}`) }));
  if (/^[0-9a-f]{64}i\d{1,10}$/.test(rune.parent ?? '')) related.append(button('Linked inscription', { onClick: () => ctx.navigate(`inscription:${rune.parent}`) }));
  return h('article', { className: 'rune-detail' },
    h('header', { className: 'rune-detail-heading' },
      h('span', { className: 'rune-emblem', 'aria-hidden': 'true' }, rune.symbol ?? 'ᚱ'),
      h('div', {}, h('h2', {}, rune.name), h('p', {}, `Rune #${formatNumber(rune.number)} · ${rune.id}`)),
      bookmarkButton(canonical, ctx.isBookmarked?.(canonical), { onClick: () => ctx.toggleBookmark() })),
    sourceNote(result, ctx),
    h('dl', { className: 'rune-metrics' },
      metric('Available supply', quantity(rune.outstanding), 'Created tokens minus tokens permanently burned. This is not a wallet balance.'),
      metric('Total created', quantity(rune.supply), 'Includes the initial allocation and all completed mints.'),
      metric('Mint status', mintStatus, 'Minting creates new units under this Rune’s rules. This browser is read-only.')),
    collectorInsights(rune),
    h('div', { className: 'rune-detail-columns' },
      h('section', { className: 'rune-panel' }, h('h3', {}, 'About this Rune'),
        h('dl', { className: 'rune-facts' },
          h('dt', {}, 'Symbol'), h('dd', {}, rune.symbol ?? (rune.symbolCodePoint ? `Non-printing (${rune.symbolCodePoint})` : 'Not set')),
          h('dt', {}, 'Created'), h('dd', {}, rune.predefined ? 'Predefined by the Runes protocol' : rune.timestamp ? absoluteTime(rune.timestamp * 1000) : 'Not supplied'),
          h('dt', {}, 'Initial allocation'), h('dd', {}, quantity(rune.premine)),
          h('dt', {}, 'Burned permanently'), h('dd', {}, quantity(rune.burned)),
          h('dt', {}, 'Decimal places'), h('dd', {}, String(rune.divisibility))),
        h('p', { className: 'help' }, 'Decimal places determine how small one unit can be divided. The initial allocation is also called the premine.'), related),
      h('section', { className: 'rune-panel' }, h('h3', {}, 'Supply & minting'),
        rune.terms ? h('dl', { className: 'rune-facts' },
          h('dt', {}, 'Per mint'), h('dd', {}, quantity(rune.terms.amount ?? '0')),
          h('dt', {}, 'Completed mints'), h('dd', {}, formatNumber(rune.mints)),
          h('dt', {}, 'Mint limit'), h('dd', {}, formatNumber(rune.terms.cap ?? '0')),
          stats ? [h('dt', {}, 'Units created by minting'), h('dd', {}, quantity(stats.minted)),
            h('dt', {}, 'Unissued units under the cap'), h('dd', {}, stats.unissued === null ? 'Exceeds the protocol amount range' : quantity(stats.unissued))] : null,
          h('dt', {}, 'Maximum supply'), h('dd', {}, quantity(rune.maximum)),
          h('dt', {}, 'Start block'), h('dd', {}, rune.mintStart == null ? 'No start restriction' : formatNumber(rune.mintStart)),
          h('dt', {}, 'End block (exclusive)'), h('dd', {}, rune.mintEnd == null ? 'No end restriction' : formatNumber(rune.mintEnd)))
          : h('p', {}, 'No public mint was defined. All units were allocated when this Rune was created.'),
        rune.terms ? h('p', { className: 'help' }, 'The mint limit counts mints, not tokens. Minting may be closed because it has not started, has ended, or has reached its limit. Refresh for a newer source snapshot.') : null)),
    h('details', { className: 'rune-technical' }, h('summary', {}, 'Technical details'),
      h('p', {}, `Rune ID ${rune.id}. Turbo flag: ${rune.turbo ? 'enabled' : 'disabled'}. ${rune.format === 'html' ? 'Parsed from the source’s HTML; mint bounds are effective block heights, not original offsets.' : 'Structured Ord JSON data; integer amounts are preserved exactly.'}`),
      button('Copy Rune ID', { small: true, onClick: () => ctx.copy(rune.id) }),
      button('Copy name', { small: true, onClick: () => ctx.copy(rune.name) }),
      h('pre', {}, safeJson(rune))));
}

export function renderRunes(result, ctx) {
  let current = result;
  const browsing = result.target.kind === 'runes';
  const page = browsing ? runesQuery(result.target.value).page : null;
  const prefix = `rune-search-${++nextFormId}`;
  const error = h('p', { className: 'lookup-error', id: `${prefix}-error`, role: 'alert' });
  const input = h('input', { id: prefix, className: 'field', type: 'search', maxlength: 2048, autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Rune name, ID, or link', 'aria-describedby': `${prefix}-help ${prefix}-error`,
    onInput: () => { error.textContent = ''; input.setAttribute('aria-invalid', 'false'); } });
  const form = h('form', { className: 'rune-search', role: 'search', ariaLabel: 'Find a Rune', onSubmit: event => {
    event.preventDefault();
    const plan = runeSearchPlan(input.value);
    error.textContent = plan.error ?? ''; input.setAttribute('aria-invalid', String(Boolean(plan.error)));
    if (plan.error) input.focus(); else ctx.navigate(plan.target);
  } }, h('label', { htmlFor: prefix }, 'Find a Rune'),
  h('div', { className: 'rune-search-controls' }, input, h('button', { type: 'submit', className: 'button primary' }, 'Find Rune')),
  h('p', { className: 'help', id: `${prefix}-help` }, 'Look up a full name or ID across your source’s Rune index. You can type spaces instead of •.'), error);
  const results = h('section', { className: 'rune-results' });
  const filterInput = h('input', { id: `${prefix}-filter`, className: 'field', type: 'search', maxlength: 100, placeholder: 'Filter names on this page', autocomplete: 'off', 'aria-describedby': `${prefix}-filter-help`, onInput: () => updateResults() });
  const mintFilter = h('select', { id: `${prefix}-mint-filter`, value: 'all', 'aria-describedby': `${prefix}-filter-help`, onChange: () => updateResults() },
    [['all', 'All mint states'], ['open', 'Mint open'], ['closed', 'Mint not open'], ['fixed', 'Fixed supply'], ['unknown', 'Status unavailable']]
      .map(([value, label]) => h('option', { value }, label)));
  const filter = browsing ? h('div', { className: 'rune-page-filter' }, h('label', { htmlFor: `${prefix}-filter` }, 'Filter this page'), filterInput,
    h('div', { className: 'rune-mint-filter' }, h('label', { htmlFor: `${prefix}-mint-filter` }, 'Mint status'), mintFilter),
    h('p', { className: 'help', id: `${prefix}-filter-help` }, 'Local filters for this page, not the entire index. Mint status is from retrieval, not live. Sources that return names only have unavailable status. Use Find a Rune for an exact name.')) : null;
  function updateResults() {
    const busy = !current.entity && !current.error;
    results.setAttribute('aria-busy', String(busy));
    filterInput.disabled = busy || Boolean(current.error);
    mintFilter.disabled = busy || Boolean(current.error);
    if (current.error) { results.replaceChildren(unavailable(current, ctx)); return; }
    if (busy) { results.replaceChildren(h('p', { className: 'rune-panel', role: 'status' }, 'Loading Runes from your source…')); return; }
    if (!browsing) { results.replaceChildren(detail(current, ctx)); return; }
    const data = current.entity.data ?? {};
    const all = safeItems(data.items);
    const needle = filterInput.value.trim().toUpperCase().replace(/[•. ]/g, '');
    const items = all.filter(item => item.name.replaceAll('•', '').includes(needle) && (mintFilter.value === 'all' || runeMintState(item) === mintFilter.value));
    const previous = pageLink(data.previous, page - 1);
    const next = pageLink(data.next, page + 1);
    clear(results, h('div', { className: 'rune-results-heading' }, h('h2', {}, page === 0 ? 'Recently created' : 'Earlier Runes'), sourceNote(current, ctx)),
      h('p', { className: 'help', role: 'status', 'aria-live': 'polite' }, `${items.length} of ${all.length} Runes on this page. Listed by creation order, not popularity or value.`),
      h('div', { className: 'rune-grid' }, items.map(item => runeCard(item, ctx))),
      !items.length ? h('div', { className: 'rune-panel' }, h('h3', {}, all.length ? 'No matching names or mint states on this page' : 'No Runes on this page'),
        h('p', {}, all.length ? 'Clear the filter, browse another page, or use the full-name lookup above.' : 'Try another page or check whether your Ord source has indexed Runes.'),
        button(all.length ? 'Clear filter' : 'Browse latest', { onClick: () => { if (all.length) { filterInput.value = ''; mintFilter.value = 'all'; updateResults(); filterInput.focus(); } else ctx.navigate(runesCanonical()); } })) : null,
      h('nav', { className: 'rune-pagination', ariaLabel: 'Rune pages' },
        button('← Newer', { disabled: !previous, onClick: () => previous && ctx.navigate(previous) }),
        h('span', {}, `Source page ${formatNumber(page + 1)}`),
        button('Older →', { disabled: !next, onClick: () => next && ctx.navigate(next) })));
  }
  const root = h('div', { className: 'runes-explorer', dataset: { runeCanonical: result.target.canonical, runeOwner: String(ctx.model?.activeTabId ?? '') } },
    h('header', { className: 'runes-header' }, h('div', {}, h('span', { className: 'eyebrow' }, 'Explore Bitcoin'), h('h1', {}, 'Runes'),
      h('p', {}, 'Explore tokens on Bitcoin. Find a name, understand its supply, and see how it was created.')),
      button('Bookmarks', { icon: '☆', onClick: () => ctx.navigate('satnav://bookmarks') })),
    form,
    h('div', { className: 'rune-actions' }, button(browsing ? 'Browse latest' : '← All Runes', { small: true, onClick: () => ctx.navigate(runesCanonical()) }),
      button('Try UNCOMMON•GOODS', { small: true, onClick: () => ctx.navigate('rune:UNCOMMON•GOODS') })),
    browsing ? renderPopularAssets('runes', ctx) : null,
    filter, results,
    h('details', { className: 'rune-about' }, h('summary', {}, 'About Runes & this data'),
      h('p', {}, 'Runes are fungible tokens recorded on Bitcoin. Unlike a unique inscription, units of the same Rune are interchangeable. Names and symbols are not endorsements.'),
      h('p', {}, 'This read-only view uses your existing Ord sources and respects your selected network, local-only routing, and offline mode. A local Ord server needs Rune indexing (--index-runes). No extra account is required.'),
      h('p', {}, 'These sources do not provide market prices, trading volume, holder rankings, or a complete transfer feed. They are not displayed as zero. Address-level Rune balances are not included in this view; no wallet or trading permissions are added.'),
      button('Data sources', { small: true, onClick: () => ctx.navigate('satnav://providers') }),
      button('Set up a local node', { small: true, onClick: () => ctx.navigate('satnav://node-setup') })));
  const publication = value => [value.entity, value.error, value.cache, ctx.model?.settings?.network, ctx.model?.settings?.offlineMode];
  let previousPublication = publication(result);
  root.updateRuneResult = next => {
    current = next;
    updatePopularAssets(root);
    const nextPublication = publication(next);
    if (nextPublication.every((value, index) => value === previousPublication[index])) {
      updateBookmarkControls(root, ctx.model?.bookmarks);
      return;
    }
    previousPublication = nextPublication;
    updateResults();
  };
  updateResults();
  return root;
}

export function updateRunes(root, result, ctx) {
  if (!root || root.dataset.runeCanonical !== result.target.canonical || root.dataset.runeOwner !== String(ctx.model?.activeTabId ?? '') || !root.updateRuneResult) return false;
  root.updateRuneResult(result);
  return true;
}
