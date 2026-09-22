import { h, button, shorten } from './dom.js';
import { AI_LIMITS, aiResultTarget } from '../shared/local-ai.js';
import { parseNavigationInput } from '../shared/navigation.js';

// Deliberately small, inert Markdown vocabulary. No HTML parser, innerHTML,
// arbitrary links, images, remote resources or executable code blocks. An
// exact reference to an existing browser card may get a user-operated button;
// model prose alone can never create a navigation destination.
function inline(text, references) {
  const nodes = [];
  let start = 0;
  for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<!!)\[([^\]\n]+)\]\(([^()\s]+)\)|\*([^*\n]+)\*/g)) {
    const reference = references.get(match[1] ?? match[4]);
    nodes.push(text.slice(start, match.index), reference ? reference()
      : match[3] !== undefined ? match[0] : h(match[1] !== undefined ? 'code' : match[2] !== undefined ? 'strong' : 'em', {}, match[1] ?? match[2] ?? match[5]));
    start = match.index + match[0].length;
  }
  nodes.push(text.slice(start));
  return nodes;
}
function tableCells(line) {
  if (!line?.includes('|')) return null;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  return cells.length >= 2 && cells.length <= 8 ? cells : null;
}
export function aiMessage(text, options = {}) {
  const root = h('div', { className: 'ai-answer-text' });
  const references = new Map();
  if (typeof options.openResult === 'function') for (const card of (options.cards ?? []).slice(0, AI_LIMITS.cards)) {
    if (!aiResultTarget(card.target) || card.network !== options.network) continue;
    try { if (parseNavigationInput(card.target).canonical !== card.target) continue; } catch { continue; }
    references.set(card.target, () => button(`Open ${shorten(card.title, 28, 8)}`, { small: true, className: 'ai-inline-result',
      title: `Open ${card.target} in a new tab`, onClick: () => options.openResult(card.target, card.network) }));
  }
  const lines = String(text ?? '').slice(0, AI_LIMITS.answer).replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [], list = null, code = null;
  const flush = () => { if (paragraph.length) root.append(h('p', {}, inline(paragraph.join('\n'), references))); paragraph = []; list = null; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush();
      if (code === null) code = [];
      else { root.append(h('pre', {}, h('code', {}, code.join('\n')))); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const header = tableCells(line), divider = tableCells(lines[index + 1]);
    if (header && divider?.length === header.length && divider.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flush(); index++;
      const body = h('tbody');
      // Bounded input plus bounded table width; long tables remain in the one
      // conversation scrollport, not a nested vertical scrolling region.
      while (index + 1 < lines.length) {
        const row = tableCells(lines[index + 1]);
        if (!row || row.length !== header.length) break;
        body.append(h('tr', {}, row.map(cell => h('td', {}, inline(cell, references))))); index++;
      }
      root.append(h('div', { className: 'ai-table-wrap', tabindex: '0', role: 'region', ariaLabel: 'AI comparison table; scroll horizontally if needed' },
        h('table', { className: 'ai-table' }, h('thead', {}, h('tr', {}, header.map(cell => h('th', { scope: 'col' }, inline(cell, references))))), body)));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); root.append(h('hr')); continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { flush(); root.append(h('h3', {}, inline(heading[1], references))); continue; }
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const tag = item[1] ? 'UL' : 'OL';
      if (!list || list.tagName !== tag) { flush(); list = h(tag.toLowerCase()); root.append(list); }
      list.append(h('li', {}, inline(item[2], references))); continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  if (code !== null) root.append(h('pre', {}, h('code', {}, code.join('\n'))));
  flush();
  return root;
}
