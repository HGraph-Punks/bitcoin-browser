import { Lexer } from './marked.mjs';
import { previewLink, markdownImage, previewFailure } from './document-preview.js';

// Render the token tree with DOM construction, never an HTML parser. Raw HTML,
// scripts, style, embeds, event handlers and arbitrary image URLs stay inert.
export function renderMarkdown(source, { document: doc = globalThis.document, onLink = () => {} } = {}) {
  const article = doc.createElement('article'); let count = 0;
  const element = (tag, text) => { if (++count > 15_000) throw previewFailure('This Markdown document is too complex to preview.'); const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  function render(tokens, container, depth = 0) {
    if (depth > 40) throw previewFailure('This Markdown document is nested too deeply.');
    for (const token of tokens ?? []) {
      if (++count > 15_000) throw previewFailure('This Markdown document is too complex to preview.');
      let node;
      switch (token.type) {
        case 'space': continue;
        case 'heading': node = element(`h${Math.max(1, Math.min(6, token.depth))}`); break;
        case 'paragraph': node = element('p'); break;
        case 'blockquote': node = element('blockquote'); break;
        case 'strong': node = element('strong'); break;
        case 'em': node = element('em'); break;
        case 'del': node = element('del'); break;
        case 'br': container.append(element('br')); continue;
        case 'hr': container.append(element('hr')); continue;
        case 'codespan': container.append(element('code', token.text)); continue;
        case 'code': node = element('pre'); node.append(element('code', token.text)); container.append(node); continue;
        case 'html': container.append(element('span', token.raw)); continue;
        case 'link': {
          const href = previewLink(token.href);
          node = element(href ? 'button' : 'span');
          if (href) { node.type = 'button'; node.className = 'link'; node.title = href; node.addEventListener('click', () => onLink(href)); }
          break;
        }
        case 'image': {
          const src = markdownImage(token.href);
          if (src) { node = element('img'); node.alt = String(token.text ?? '').slice(0, 500); node.referrerPolicy = 'no-referrer'; node.loading = 'lazy'; node.src = src; }
          else { node = element('span', `[Image: ${String(token.text || 'external image').slice(0, 500)} — external image loading is disabled]`); node.className = 'image-placeholder'; }
          container.append(node); continue;
        }
        case 'list': {
          node = element(token.ordered ? 'ol' : 'ul'); if (token.ordered && Number.isSafeInteger(token.start) && token.start > 0 && token.start < 1e6) node.start = token.start;
          for (const item of token.items ?? []) { const li = element('li'); if (item.task) li.append(element('span', item.checked ? '☑ ' : '☐ ')); render(item.tokens, li, depth + 1); node.append(li); }
          container.append(node); continue;
        }
        case 'table': {
          node = element('div'); node.className = 'table-scroll'; const table = element('table'), head = element('thead'), body = element('tbody'), header = element('tr');
          for (const cell of token.header ?? []) { const th = element('th'); th.scope = 'col'; render(cell.tokens, th, depth + 1); header.append(th); } head.append(header);
          for (const row of token.rows ?? []) { const tr = element('tr'); for (const cell of row) { const td = element('td'); render(cell.tokens, td, depth + 1); tr.append(td); } body.append(tr); }
          table.append(head, body); node.append(table); container.append(node); continue;
        }
        default: node = element('span'); break;
      }
      if (token.tokens) render(token.tokens, node, depth + 1); else node.textContent = token.text ?? token.raw ?? '';
      container.append(node);
    }
  }
  render(Lexer.lex(source, { gfm: true, breaks: false }), article);
  return article;
}
