import { previewRoute, DOCUMENT_LIMITS, PREVIEW_DEADLINE_MS, fontSignature, binaryPreview, fetchPreviewBytes, previewFailure, previewDiagnosticCode, previewLink } from './document-preview.js';
const route = previewRoute(location.pathname);
const stage = document.getElementById('stage'), controls = document.getElementById('controls'), status = document.getElementById('status');
const abort = new AbortController(), cleanups = [];
let retired = false, deadline, phase = 'fetch';
function el(tag, text) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
function button(text, action) { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node; }
function publish(state, code) { if (route && parent !== window) parent.postMessage({ type: 'satoshi:document-viewer', ...route, state, ...(code ? { code } : {}) }, 'app://app'); }
function release() { clearTimeout(deadline); abort.abort(); for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch {} } }
function fail(error) {
  if (retired) return; retired = true; release(); controls.replaceChildren();
  const note = el('section'); note.className = 'error'; note.append(el('h2', 'Preview unavailable'), el('p', error?.code === 'PREVIEW_INVALID' ? error.message : 'This file is incomplete or not supported by the local preview. Retry or save the original.'));
  stage.replaceChildren(note); status.textContent = 'The original file has not been changed.';
  const code = previewDiagnosticCode(error);
  console.warn(`SATOSHI_DOCUMENT_VIEWER_ERROR:${code}:${phase}`); publish('error', code);
}
function link(href) { const target = previewLink(href); if (target && !retired) parent.postMessage({ type: 'satoshi:document-link', ...route, href: target }, 'app://app'); }
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== 'app://app' || event.data?.type !== 'satoshi:document-appearance') return;
  if (['dark', 'light', 'checker'].includes(event.data.background)) document.documentElement.dataset.background = event.data.background;
});
window.addEventListener('pagehide', () => { if (!retired) { retired = true; release(); } }, { once: true });

async function start() {
  deadline = setTimeout(() => { const error = previewFailure('The preview took too long to load.'); error.code = 'PREVIEW_TIMEOUT'; fail(error); }, PREVIEW_DEADLINE_MS);
  try {
    if (!route) throw previewFailure('Invalid preview address.');
    publish('loading');
    const { data, type } = await fetchPreviewBytes(`ord://document-data/${route.kind}/${route.id}`, { maxBytes: DOCUMENT_LIMITS[route.kind], signal: abort.signal });
    if (retired) return;
    phase = 'prepare';
    if (route.kind === 'pdf') {
      const { createPdfPreview } = await import('./pdf.js'); if (retired) return;
      phase = 'render';
      const pdf = createPdfPreview(data, { stage, controls, status, signal: abort.signal, onFailure: fail }); cleanups.push(pdf.dispose); await pdf.ready;
    } else if (route.kind === 'markdown') {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(data);
      const { renderMarkdown } = await import('./markdown.js'); if (retired) return;
      const article = renderMarkdown(source, { onLink: link }), pre = el('pre', source); pre.className = 'pdf-text';
      const rendered = button('Read', () => { stage.replaceChildren(article); rendered.setAttribute('aria-pressed', 'true'); raw.setAttribute('aria-pressed', 'false'); });
      const raw = button('Source', () => { stage.replaceChildren(pre); rendered.setAttribute('aria-pressed', 'false'); raw.setAttribute('aria-pressed', 'true'); });
      rendered.setAttribute('aria-pressed', 'true'); raw.setAttribute('aria-pressed', 'false'); controls.replaceChildren(rendered, raw); stage.replaceChildren(article);
      status.textContent = 'Markdown · Readable layout · Embedded HTML stays inert · External images do not load automatically';
    } else if (route.kind === 'font') {
      const format = fontSignature(data), font = new FontFace('InscriptionSpecimen', data.buffer);
      await font.load(); if (retired) return; document.fonts.add(font); cleanups.push(() => document.fonts.delete(font));
      const article = el('article'), sample = el('p', 'Satoshi\nA new kind of money.'); sample.className = 'font-sample';
      const input = el('textarea'); input.className = 'font-input'; input.maxLength = 2000; input.placeholder = 'Try your own words…'; input.setAttribute('aria-label', 'Font sample text'); input.addEventListener('input', () => { sample.textContent = input.value.slice(0, 2000) || 'Satoshi\nA new kind of money.'; });
      const size = el('input'); size.type = 'range'; size.min = '16'; size.max = '120'; size.value = '48'; size.setAttribute('aria-label', 'Font preview size');
      const label = el('label', 'Size'), value = el('span', '48 px'); size.addEventListener('input', () => { const next = Math.min(120, Math.max(16, Number(size.value) || 48)); sample.style.fontSize = `${next}px`; value.textContent = `${next} px`; }); label.append(size, value); controls.replaceChildren(label);
      const alphabet = el('p', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789 !? & @ # % + − = ₿'); alphabet.className = 'font-alphabet';
      article.append(input, sample, alphabet, el('p', 'Glyphs absent from this font use the browser’s fallback font.')); stage.replaceChildren(article);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      status.textContent = `${format.toUpperCase()} font · Type to preview · Used only inside this isolated specimen, never installed on your computer`;
    } else if (route.kind === 'jxl') {
      const { createJxlPreview } = await import('./jxl.js'); if (retired) return;
      phase = 'render';
      const jxl = createJxlPreview(data, { stage, status, signal: abort.signal }); cleanups.push(jxl.dispose); await jxl.ready;
    } else {
      const result = binaryPreview(data), article = el('article'), pre = el('pre', result.text || '(empty file)'); pre.className = 'binary';
      article.append(el('h1', 'Inscribed data'), el('p', type), el('p', 'This format contains data rather than a browser document. Inspect its bytes here, or Save original for a compatible application.'), pre);
      stage.replaceChildren(article); status.textContent = `${result.total.toLocaleString()} bytes · Showing ${result.shown.toLocaleString()} bytes · Hexadecimal and readable characters · Nothing is executed`;
    }
    if (retired) return; clearTimeout(deadline); console.info('SATOSHI_DOCUMENT_VIEWER_READY'); publish('ready');
  } catch (error) { if (!retired) fail(error); }
}
void start();
