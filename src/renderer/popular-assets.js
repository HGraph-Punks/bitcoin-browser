import { button, formatNumber, h } from './dom.js';
import { popularAssets, popularAsset, POPULAR_REVIEWED_AT, POPULAR_VISIBLE_COUNT } from '../shared/popular-assets.js';
import { popularLogo } from './assets/popular-logos.js';

let sequence = 0;

export function renderPopularAssets(kind, ctx) {
  const owner = String(ctx.model?.activeTabId ?? '');
  const prefix = `popular-${kind}-${++sequence}`;
  let stateKey;
  let expanded = false;
  let previews = false;
  const grid = h('div', { className: 'popular-grid', id: `${prefix}-grid` });
  const status = h('p', { className: 'popular-status', role: 'status', 'aria-live': 'polite' });
  const more = button('Show all 6', { small: true, onClick: () => {
    if (!isCurrent()) return;
    root.updatePopularAssets();
    expanded = !expanded; publishCards();
  } });
  more.setAttribute('aria-controls', `${prefix}-grid`);
  more.setAttribute('aria-expanded', 'false');
  const previewControl = kind === 'inscriptions' ? button('Show safe artwork', { small: true, onClick: () => {
    if (!isCurrent()) return;
    root.updatePopularAssets();
    previews = !previews;
    previewControl.textContent = previews ? 'Hide artwork' : 'Show safe artwork';
    previewControl.setAttribute('aria-pressed', String(previews));
    publishCards();
  } }) : null;
  previewControl?.setAttribute('aria-pressed', 'false');
  previewControl?.setAttribute('aria-describedby', `${prefix}-privacy`);
  const note = h('p', { className: 'popular-context', id: `${prefix}-privacy` });
  const content = h('div', { className: 'popular-content' },
    h('div', { className: 'popular-toolbar' }, note, previewControl), grid,
    h('div', { className: 'popular-footer' }, status, more));
  const unavailable = h('p', { className: 'popular-network-note' }, 'These curated picks are Bitcoin mainnet assets. Search and browse your selected network below; change networks in Settings to explore these picks.');
  const root = h('section', { className: 'popular-discovery', 'aria-labelledby': `${prefix}-title`, dataset: { popularKind: kind } },
    h('header', { className: 'popular-heading' },
      h('div', {}, h('span', { className: 'eyebrow' }, 'Start here'), h('h2', { id: `${prefix}-title` }, 'Popular to explore')),
      h('span', { className: 'popular-curated-label' }, 'Curated · Not live-ranked')),
    content, unavailable,
    h('details', { className: 'popular-method' }, h('summary', {}, 'How these picks work'),
      h('p', {}, `Handpicked, well-known projects and notable artifacts; order is editorial, not a measurement of popularity or value. Catalog reviewed ${POPULAR_REVIEWED_AT}. Names and references are not endorsements or authenticity certificates.`),
      h('p', {}, kind === 'inscriptions'
        ? 'Each project card opens one identified example, not a complete collection. Collection sizes and membership are referenced indexer snapshots. Open an inscription for your source’s available ownership, content, sat and creation details.'
        : 'Card facts describe creation and mint rules, not live balances or available supply. Open a Rune for your configured source’s supply, burned amounts, mint status and creation details.'),
      h('p', {}, 'Prices, floor listings, trading volume, holder rankings and live popularity need a separate market-data source and are not supplied here. No wallet connection, trading, signing or extra data-provider account is added.'),
      h('p', {}, 'Project logos and collection icons are bundled with the app and display offline, without contacting image servers. They identify the project, not necessarily the example shown in its card. Marks and artwork belong to their creators; their display does not imply endorsement.'),
      h('p', {}, 'Reference links open in your system browser after confirmation. That browser uses its own network and privacy settings.')));

  function isCurrent() { return String(ctx.model?.activeTabId ?? '') === owner && ctx.model?.settings?.network === 'mainnet'; }
  function allowedEntry(key) {
    if (!isCurrent()) return null;
    return popularAsset(kind, key, ctx.model?.settings?.network);
  }
  async function activate(key, action, failure) {
    const selected = allowedEntry(key);
    if (!selected) return;
    try { await action(selected); }
    catch (error) {
      if (allowedEntry(key)) status.textContent = error?.code === 'USER_REJECTED' ? 'Action canceled.' : failure;
    }
  }
  function card(entry) {
    const logo = popularLogo(entry.key);
    const fallback = h('span', { className: 'popular-image-fallback', title: 'Project image unavailable' });
    fallback.hidden = Boolean(logo);
    const visual = h('div', { className: `popular-emblem popular-tone-${entry.tone}${logo?.backdrop === 'light' ? ' popular-logo-light' : ''}`, 'aria-hidden': 'true', title: logo?.label }, fallback);
    if (logo) {
      const mark = h('img', { className: `popular-logo${logo.pixelated ? ' popular-logo-pixelated' : ''}`, src: logo.src, alt: '', width: logo.width, height: logo.height, decoding: 'async', referrerpolicy: 'no-referrer',
        onError: () => { mark.remove(); fallback.hidden = false; } });
      visual.append(mark);
    }
    const previewNote = h('span', { className: 'popular-preview-note' }, entry.preview ? 'Artwork on request' : kind === 'inscriptions' ? 'Open for content' : '');
    if (kind === 'inscriptions' && previews && entry.preview) {
      previewNote.textContent = 'Safe image preview';
      const image = h('img', { className: 'popular-content-preview', src: `ord://thumbnail/${entry.inscriptionId}`, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
        onError: () => { image.remove(); previewNote.textContent = 'Preview unavailable · open for details'; } });
      visual.append(image);
    }
    const reference = typeof ctx.openExternal === 'function' ? button('View reference ↗', { small: true,
      onClick: () => activate(entry.key, selected => ctx.openExternal(selected.reference), 'Reference could not be opened. Try again.') }) : null;
    const copy = typeof ctx.copy === 'function' ? button(kind === 'runes' ? 'Copy Rune ID' : 'Copy inscription ID', { small: true,
      onClick: () => activate(entry.key, selected => ctx.copy(selected.runeId ?? selected.inscriptionId), 'The ID could not be copied. Try again.') }) : null;
    return h('article', { className: `popular-card${kind === 'inscriptions' && previews ? ' popular-with-artwork' : ''}`, dataset: { popularKey: entry.key } },
      h('div', { className: 'popular-card-heading' }, visual,
        h('div', {}, h('span', { className: 'popular-category' }, entry.category), h('h3', {}, entry.name))),
      h('p', { className: 'popular-identity' }, kind === 'inscriptions' ? `${entry.key === 'inscription-zero' ? 'Inscription' : 'Example'} #${formatNumber(entry.number)}` : entry.identity),
      h('p', { className: 'popular-description' }, entry.description),
      h('dl', { className: 'popular-facts' }, entry.facts.map(fact => h('div', {}, h('dt', {}, fact.label), h('dd', {}, fact.value)))),
      kind === 'inscriptions' ? previewNote : null,
      button(kind === 'runes' ? 'Explore Rune →' : entry.key === 'inscription-zero' ? 'Open inscription →' : 'Open example →', {
        className: 'popular-open', ariaLabel: kind === 'runes' ? `Explore Rune ${entry.identity}` : `Open ${entry.name} inscription ${entry.number}`,
        onClick: () => activate(entry.key, selected => ctx.navigate(selected.target), 'This asset could not be opened. Try again or check your data sources.')
      }),
      h('details', { className: 'popular-card-details' }, h('summary', {}, 'Asset details'),
        h('p', {}, entry.detail), h('p', { className: 'popular-exact-id' }, entry.runeId ?? entry.inscriptionId),
        logo ? h('p', { className: 'popular-branding-note' }, `${logo.label}, bundled for offline display.${kind === 'inscriptions' && entry.key !== 'inscription-zero' ? ' Project artwork is separate from this card’s exact inscription example.' : ''}${logo.note ? ` ${logo.note}` : ''}`) : null,
        copy, reference));
  }
  function publishCards() {
    const entries = popularAssets(kind, ctx.model?.settings?.network);
    const visible = expanded ? entries : entries.slice(0, POPULAR_VISIBLE_COUNT);
    grid.replaceChildren(...visible.map(card));
    more.textContent = expanded ? 'Show fewer' : `Show all ${entries.length}`;
    more.setAttribute('aria-expanded', String(expanded));
    more.disabled = entries.length <= POPULAR_VISIBLE_COUNT;
    status.textContent = entries.length ? `${visible.length} of ${entries.length} curated picks` : '';
  }
  root.updatePopularAssets = () => {
    const settings = ctx.model?.settings ?? {};
    // Retain expanded cards, open details and artwork state on background
    // result/health updates. A routing/privacy transition resets previews.
    const nextKey = JSON.stringify([settings.network, Boolean(settings.offlineMode), Boolean(settings.localOnly), settings.privacyMode]);
    if (stateKey === nextKey) return;
    stateKey = nextKey;
    previews = false;
    if (previewControl) { previewControl.textContent = 'Show safe artwork'; previewControl.setAttribute('aria-pressed', 'false'); }
    const mainnet = settings.network === 'mainnet';
    content.hidden = !mainnet;
    unavailable.hidden = mainnet;
    note.textContent = kind === 'inscriptions'
      ? settings.offlineMode ? 'Catalog available offline. Optional artwork uses cached images only; uncached examples may be unavailable.'
        : settings.localOnly ? 'Optional artwork uses only your configured local sources. No marketplace images or live ranking feed.'
          : 'Optional artwork uses your configured sources: raster images up to 2 MB. No interactive previews or marketplace image servers.'
      : settings.offlineMode ? 'Catalog available offline. Open a Rune to use its cached details, when available.'
        : settings.localOnly ? 'Open a Rune for details from your local sources. No extra market-data requests.'
          : 'Open a Rune for on-chain details from your configured sources. No extra market-data requests.';
    publishCards();
  };
  root.updatePopularAssets();
  return root;
}

export function updatePopularAssets(root) { root?.querySelector('.popular-discovery')?.updatePopularAssets?.(); }
