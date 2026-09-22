import { parseNavigationInput } from '../shared/navigation.js';
import { button, h, listRow, targetIcon } from './dom.js';

export const LOOKUP_MODES = Object.freeze([
  { value: 'auto', label: 'Recognize an identifier', help: 'Paste a Bitcoin identifier or choose what you want to find. Numbers and hashes may have more than one meaning.', example: '#12345' },
  { value: 'inscription', label: 'Inscription', help: 'Enter an inscription number, such as #12345, or its full inscription ID. An Ordinals data source is required.', example: '#12345' },
  { value: 'rune', label: 'Rune', help: 'Enter a full Rune name, such as UNCOMMON•GOODS, or its block:transaction ID. An Ord source with Rune indexing is required.', example: 'UNCOMMON•GOODS' },
  { value: 'block', label: 'Block', help: 'Enter a block height, such as 840000, or a full block hash.', example: '840000' },
  { value: 'transaction', label: 'Transaction', help: 'Paste the full 64-character transaction ID from your wallet or explorer.', example: null },
  { value: 'address', label: 'Bitcoin address', help: 'Paste the Bitcoin address you want to look up. Never enter a private key or seed phrase.', example: null },
  { value: 'sat', label: 'Sat', help: 'Enter a sat number or name. A sat is the smallest unit of bitcoin; an Ordinals data source is required.', example: '0' },
  { value: 'saved', label: 'History and bookmarks', help: 'Search saved titles and identifiers on this device. This does not search all inscriptions or send your query to a search service.', example: null }
].map(Object.freeze));

const kinds = { inscription: ['inscription', 'inscription-number'], rune: ['rune'], block: ['block'], transaction: ['transaction'], address: ['address'], sat: ['sat', 'sat-name', 'sat-degree'] };
const prefixes = { inscription: 'inscription', rune: 'rune', block: 'block', transaction: 'tx', address: 'address', sat: 'sat' };
const lookupKinds = new Set(['inscription', 'inscription-number', 'block', 'transaction', 'address', 'sat', 'sat-name', 'sat-degree', 'output', 'satpoint', 'rune', 'content', 'recursive', 'collection', 'search']);

export function planLookup(input, mode = 'auto') {
  if (!LOOKUP_MODES.some((item) => item.value === mode)) return { error: 'Choose a lookup type.' };
  if (typeof input !== 'string' || input.length > 2048) return { error: 'Use an identifier or search phrase no longer than 2,048 characters.' };
  const query = input.trim();
  if (!query) return { error: 'Enter an identifier or a phrase to search your saved items.' };
  if (mode === 'saved') return { target: `search:${query}`, choices: [] };
  try {
    let parsed = parseNavigationInput(query);
    if (mode !== 'auto') {
      if (!kinds[mode].includes(parsed.kind)) parsed = parseNavigationInput(`${prefixes[mode]}:${query}`);
      if (!kinds[mode].includes(parsed.kind)) return { error: 'This identifier does not match the selected lookup type.' };
      return { target: parsed.canonical, choices: [] };
    }
    if (!lookupKinds.has(parsed.kind)) return { error: 'Use a Bitcoin identifier here. For web links, payment links, or app pages, use the address bar.' };
    if (parsed.ambiguous) return { choices: [parsed, ...parsed.alternatives].map((item) => ({
      canonical: item.canonical,
      kind: item.kind,
      label: item.kind === 'search' ? 'Search history and bookmarks' : `Open ${item.display}`
    })) };
    return { target: parsed.canonical, choices: [] };
  } catch {
    const selected = LOOKUP_MODES.find((item) => item.value === mode);
    return { error: mode === 'auto' ? 'This identifier is not valid. Choose a lookup type for help.' : selected.help };
  }
}

export function searchSavedItems(model, input) {
  const terms = String(input ?? '').slice(0, 2048).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = new Map();
  // StateStore bounds each library. Keep this view bounded even with a malformed collaborator.
  for (const [name, entries] of [['Bookmark', model?.bookmarks], ['History', model?.history]]) {
    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, 10000)) {
      if (!entry || typeof entry.canonical !== 'string' || !entry.canonical.trim() || entry.canonical.length > 2048 || entry.kind === 'search') continue;
      let parsed;
      try { parsed = parseNavigationInput(entry.canonical); } catch { continue; }
      if (parsed.canonical !== entry.canonical || ['search', 'external-web', 'payment'].includes(parsed.kind)) continue;
      const title = typeof entry.title === 'string' ? entry.title.slice(0, 2048) : entry.canonical;
      if (!terms.every((term) => `${title} ${entry.canonical}`.toLowerCase().includes(term))) continue;
      const existing = matches.get(entry.canonical);
      if (existing) {
        if (!existing.origins.includes(name)) existing.origins.push(name);
      } else matches.set(entry.canonical, { canonical: entry.canonical, title, kind: parsed.kind, origins: [name] });
    }
  }
  return { items: [...matches.values()].slice(0, 30), total: matches.size };
}

let nextLookupId = 0;

export function renderLookup(ctx, { query = '', mode = 'auto', simple = false } = {}) {
  const id = `bitcoin-lookup-${++nextLookupId}`;
  const help = h('p', { id: `${id}-help`, className: 'help', 'aria-live': 'polite' });
  const error = h('p', { id: `${id}-error`, className: 'lookup-error', role: 'alert' });
  const choices = h('div', { className: 'lookup-choices', role: 'group', ariaLabel: 'Choose what to open', 'aria-live': 'polite' });
  const input = h('input', {
    id, className: 'field', value: query, maxlength: 2048, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-describedby': `${simple ? `${id}-hint ` : ''}${id}-help ${id}-error`,
    onInput: () => { error.textContent = ''; choices.replaceChildren(); input.setAttribute('aria-invalid', 'false'); }
  });
  const select = h('select', { id: `${id}-type`, onChange: () => updateHelp() },
    LOOKUP_MODES.map((item) => h('option', { value: item.value, selected: item.value === mode }, item.label)));
  select.value = mode;
  const optionsLabel = h('span', {}, 'Search options & examples');
  const modeLabel = h('span', { className: 'lookup-mode-label' });
  const example = button('Try an example', { small: true, onClick: () => {
    const selected = LOOKUP_MODES.find((item) => item.value === select.value);
    if (selected?.example === null || !selected) return;
    input.value = selected.example;
    error.textContent = '';
    choices.replaceChildren();
    input.setAttribute('aria-invalid', 'false');
    input.focus();
    input.select();
  } });
  function updateHelp() {
    const selected = LOOKUP_MODES.find((item) => item.value === select.value) ?? LOOKUP_MODES[0];
    help.textContent = selected.help;
    modeLabel.textContent = selected.value === 'auto' ? 'Auto-detect' : selected.label;
    input.setAttribute('placeholder', simple && selected.value === 'auto' ? 'Paste an identifier or search saved items'
      : selected.example ?? (selected.value === 'saved' ? 'A saved title or identifier' : `Paste a ${selected.label.toLowerCase()}`));
    example.disabled = selected.example === null;
    error.textContent = '';
    choices.replaceChildren();
    input.setAttribute('aria-invalid', 'false');
  }
  const submit = (event) => {
    event.preventDefault();
    const plan = planLookup(input.value, select.value);
    error.textContent = plan.error ?? '';
    input.setAttribute('aria-invalid', String(Boolean(plan.error)));
    choices.replaceChildren();
    if (plan.error) { input.focus(); return; }
    if (plan.choices?.length) {
      choices.append(h('p', {}, 'What would you like to open?'), ...plan.choices.map((item) =>
        listRow({ icon: targetIcon(item.kind), title: item.label, subtitle: item.canonical, onClick: () => ctx.navigate(item.canonical) })));
      choices.querySelector('button')?.focus();
    } else ctx.navigate(plan.target);
  };
  const typeField = h('div', { className: 'form-field' }, h('label', { htmlFor: `${id}-type` }, 'What are you looking for?'), select);
  const queryField = h('div', { className: 'form-field lookup-query' }, h('label', { htmlFor: id }, simple ? 'Search Bitcoin' : 'Identifier or saved-item search'), input);
  const submitButton = h('button', { type: 'submit', className: 'button primary' }, simple ? 'Search' : 'Look up');
  const form = h('form', { className: `bitcoin-lookup${simple ? ' lookup-simple' : ''}`, role: 'search', ariaLabel: 'Look up Bitcoin or search saved items', onSubmit: submit },
    h('div', { className: 'lookup-controls' },
      simple ? null : typeField, queryField, submitButton),
    simple ? h('p', { id: `${id}-hint`, className: 'lookup-hint' }, 'Exact lookups use your configured data sources; saved-item search stays on this device.') : null,
    error, choices,
    simple ? h('details', { className: 'lookup-options' },
      h('summary', {}, optionsLabel, modeLabel),
      h('div', { className: 'lookup-options-body' }, typeField, help, example)) : [help, example]);
  updateHelp();
  return form;
}
