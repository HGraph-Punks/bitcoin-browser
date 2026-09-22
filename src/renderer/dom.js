export function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'htmlFor') node.htmlFor = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'value') node.value = value;
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (key === 'selected') node.selected = Boolean(value);
    else if (key === 'dataset' && value && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key === 'style' && value && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'ariaLabel') node.setAttribute('aria-label', value);
    else if (key === 'role') node.setAttribute('role', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function fragment(...children) {
  const value = document.createDocumentFragment();
  append(value, children);
  return value;
}

export function clear(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export function shorten(value, start = 12, end = 8) {
  const text = String(value ?? '');
  return text.length > start + end + 1 ? `${text.slice(0, start)}…${text.slice(-end)}` : text;
}

export function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = -1;
  do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  try { return BigInt(value).toLocaleString(); } catch {}
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : String(value);
}

export function timeAgo(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units = [
    ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60], ['second', 1]
  ];
  for (const [unit, divisor] of units) {
    if (Math.abs(seconds) >= divisor || unit === 'second') return formatter.format(Math.round(seconds / divisor), unit);
  }
  return 'now';
}

export function absoluteTime(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

export function targetIcon(kind) {
  return ({
    home: '⌂', internal: '◫', inscriptions: '◈', inscription: '◈', 'inscription-number': '◈', content: '▣', sat: '·', 'sat-name': '·', 'sat-degree': '·',
    transaction: '⇄', block: '▦', output: '◇', satpoint: '⌖', address: '◎', rune: 'ᚱ', runes: 'ᚱ', collection: '▤', recursive: '↳', search: '⌕',
    'external-web': '↗', payment: '₿'
  })[kind] ?? '•';
}

export function button(label, options = {}) {
  return h('button', {
    className: `button${options.primary ? ' primary' : ''}${options.danger ? ' danger' : ''}${options.small ? ' small' : ''}${options.className ? ` ${options.className}` : ''}`,
    type: 'button', disabled: options.disabled, onClick: options.onClick, title: options.title, ariaLabel: options.ariaLabel
  }, options.icon ? h('span', { 'aria-hidden': 'true' }, options.icon) : null, label);
}

export function bookmarkButton(canonical, bookmarked, options = {}) {
  const compact = Boolean(options.compact);
  const control = button('', {
    small: compact,
    onClick: options.onClick,
    className: options.className,
    ariaLabel: 'Toggle bookmark'
  });
  control.dataset.bookmarkControl = '';
  control.dataset.bookmarkCanonical = String(canonical ?? '');
  control.setAttribute('aria-pressed', String(Boolean(bookmarked)));
  const icon = h('span', { dataset: { bookmarkIcon: '' }, 'aria-hidden': 'true' }, bookmarked ? '★' : '☆');
  const label = compact ? null : h('span', { dataset: { bookmarkLabel: '' } }, bookmarked ? 'Bookmarked' : 'Bookmark');
  control.replaceChildren(icon, ...(label ? [label] : []));
  return control;
}

export function updateBookmarkControls(root, bookmarks) {
  if (!root?.querySelectorAll) return 0;
  const canonicals = new Set((Array.isArray(bookmarks) ? bookmarks : [])
    .map((entry) => typeof entry === 'string' ? entry : entry?.canonical)
    .filter((canonical) => typeof canonical === 'string'));
  let updated = 0;
  for (const control of root.querySelectorAll('[data-bookmark-control]')) {
    const bookmarked = canonicals.has(control.dataset.bookmarkCanonical);
    control.setAttribute('aria-pressed', String(bookmarked));
    const icon = control.querySelector('[data-bookmark-icon]');
    const label = control.querySelector('[data-bookmark-label]');
    if (icon) icon.textContent = bookmarked ? '★' : '☆';
    if (label) label.textContent = bookmarked ? 'Bookmarked' : 'Bookmark';
    control.setAttribute('aria-label', 'Toggle bookmark');
    updated += 1;
  }
  return updated;
}

export function badge(label, kind = '') {
  return h('span', { className: `badge${kind ? ` ${kind}` : ''}` }, label);
}

export function emptyState(icon, title, message, action = null) {
  return h('div', { className: 'empty-state' }, h('div', {},
    h('div', { className: 'empty-icon', 'aria-hidden': 'true' }, icon),
    h('h2', {}, title), h('p', {}, message), action
  ));
}

export async function copyText(value) {
  const text = String(value ?? '');
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const previouslyFocused = document.activeElement;
    const selection = previouslyFocused && typeof previouslyFocused.selectionStart === 'number'
      ? [previouslyFocused.selectionStart, previouslyFocused.selectionEnd, previouslyFocused.selectionDirection]
      : null;
    const textarea = h('textarea', { value: text, style: { position: 'fixed', opacity: '0', pointerEvents: 'none' } });
    document.body.append(textarea);
    try {
      textarea.select();
      return document.execCommand('copy') === true;
    } catch {
      return false;
    } finally {
      const shouldRestoreFocus = document.activeElement === textarea;
      textarea.remove();
      if (shouldRestoreFocus && previouslyFocused?.isConnected && typeof previouslyFocused.focus === 'function') {
        try {
          previouslyFocused.focus({ preventScroll: true });
          if (selection && typeof previouslyFocused.setSelectionRange === 'function') previouslyFocused.setSelectionRange(...selection);
        } catch {}
      }
    }
  }
}

export function safeJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function pageHeader(eyebrow, title, description, actions = []) {
  return h('header', { className: 'page-header' },
    h('div', { className: 'page-header-copy' }, h('span', { className: 'eyebrow' }, eyebrow), h('h1', {}, title), description ? h('p', {}, description) : null),
    actions.length ? h('div', { className: 'page-actions' }, actions) : null
  );
}

export function listRow({ icon, title, subtitle, meta, onClick, actions = [] }) {
  return h(onClick ? 'button' : 'div', { className: `list-row${onClick ? ' interactive' : ''}`, type: onClick ? 'button' : null, onClick },
    h('span', { className: 'row-icon', 'aria-hidden': 'true' }, icon),
    h('span', { className: 'row-copy' }, h('strong', {}, title), subtitle ? h('span', {}, subtitle) : null),
    meta ? h('span', { className: 'row-meta' }, meta) : null,
    ...actions
  );
}
