import * as pdfjs from './pdf.mjs';
import { fetchPreviewBytes, pdfRenderSize, previewFailure } from './document-preview.js';
import { prepareBundledWorker } from './bundled-worker.js';
const ASSETS = 'ord://document-viewer/assets/';

export function createPdfPreview(data, { stage, controls, status, signal, onFailure }) {
  let retired = false, documentProxy, loadingTask, renderTask, page = 1, rotation = 0, scale = 1, fit = true, textMode = false, generation = 0, deadline;
  let port, worker, bundled;
  function el(tag, text) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
  function button(text, action) { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node; }
  const previous = button('Previous', () => { if (page > 1) { page--; redraw(); } });
  const next = button('Next', () => { if (page < documentProxy.numPages) { page++; redraw(); } });
  const input = el('input'); input.type = 'number'; input.min = '1'; input.value = '1'; input.setAttribute('aria-label', 'PDF page number');
  input.addEventListener('change', () => { const value = Number(input.value); if (Number.isSafeInteger(value) && value >= 1 && value <= documentProxy.numPages) { page = value; redraw(); } else input.value = String(page); });
  const count = el('span');
  const fitButton = button('Fit width', () => { fit = true; redraw(); });
  const out = button('−', () => zoom(1 / 1.25)); out.setAttribute('aria-label', 'Zoom PDF out');
  const zoomLabel = el('span');
  const inside = button('+', () => zoom(1.25)); inside.setAttribute('aria-label', 'Zoom PDF in');
  const rotate = button('Rotate', () => { rotation = (rotation + 90) % 360; redraw(); });
  const text = button('Read text', () => { textMode = !textMode; redraw(); });
  const nodes = [previous, input, count, next, fitButton, out, zoomLabel, inside, rotate, text];
  nodes.forEach(node => { node.disabled = true; }); controls.replaceChildren(...nodes);
  function zoom(factor) { scale = Math.max(0.25, Math.min(4, scale * factor)); fit = false; redraw(); }
  function arm() { clearTimeout(deadline); deadline = setTimeout(() => onFailure(previewFailure('PDF rendering took too long.')), 30_000); }
  function dispose() {
    if (retired) return; retired = true; generation++; clearTimeout(deadline);
    renderTask?.cancel(); void loadingTask?.destroy().catch(() => {}); worker?.destroy(); port?.terminate(); bundled?.dispose();
  }
  // The worker may request only fixed bundled tables, fonts and image codecs.
  // It has no URL for the PDF itself, scripting service, XFA UI or annotation UI.
  class LocalBinaryDataFactory {
    async fetch({ kind, filename }) {
      const dirs = { cMapUrl: 'cmaps/', standardFontDataUrl: 'standard_fonts/', wasmUrl: 'wasm/' };
      if (!Object.hasOwn(dirs, kind) || typeof filename !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(filename)) throw previewFailure('Unsupported PDF support resource.');
      const result = await fetchPreviewBytes(`${ASSETS}${dirs[kind]}${filename}`, { signal, maxBytes: 8 * 1024 * 1024 }); return result.data;
    }
  }
  async function draw() {
    const token = ++generation;
    try {
    arm(); renderTask?.cancel();
    const previousRender = renderTask;
    if (previousRender) await previousRender.promise.catch(() => {});
    if (retired || token !== generation) return;
    status.textContent = `Preparing page ${page}…`; input.value = String(page);
    const selected = await documentProxy.getPage(page);
    if (retired || token !== generation) return;
    let node;
    if (textMode) {
      const content = await selected.getTextContent(); if (retired || token !== generation) return;
      let length = 0; const parts = [];
      for (const item of content.items) { if (typeof item.str !== 'string') continue; length += item.str.length + 1; if (length > 1_000_000) throw previewFailure('This PDF page has too much text for the reader.'); parts.push(item.str + (item.hasEOL ? '\n' : ' ')); }
      node = el('pre', parts.join('') || 'No extractable text on this page. Switch to Page view to see scanned artwork.'); node.className = 'pdf-text';
    } else {
      const base = selected.getViewport({ scale: 1, rotation: (selected.rotate + rotation) % 360 });
      const requestedScale = fit ? Math.max(1, stage.clientWidth - 64) / base.width : scale;
      const size = pdfRenderSize(base.width, base.height, requestedScale); scale = size.scale;
      node = el('canvas'); node.className = 'pdf-page'; node.width = size.width; node.height = size.height;
      node.setAttribute('role', 'img'); node.setAttribute('aria-label', `PDF page ${page} of ${documentProxy.numPages}. Use Read text for an accessible text view.`);
      // Display actual pixels when zoomed; the stage scrolls instead of silently
      // clamping the canvas back to fit width.
      if (!fit) node.style.maxWidth = 'none';
      renderTask = selected.render({ canvasContext: node.getContext('2d', { alpha: false }), viewport: selected.getViewport({ scale: size.scale, rotation: (selected.rotate + rotation) % 360 }), annotationMode: pdfjs.AnnotationMode.DISABLE });
      await renderTask.promise;
    }
    if (retired || token !== generation) return;
    stage.replaceChildren(node); clearTimeout(deadline);
    nodes.forEach(control => { control.disabled = false; }); previous.disabled = page <= 1; next.disabled = page >= documentProxy.numPages;
    for (const control of [fitButton, out, inside, rotate]) control.disabled = textMode;
    count.textContent = `of ${documentProxy.numPages}`; input.max = String(documentProxy.numPages);
    text.textContent = textMode ? 'Page view' : 'Read text'; text.setAttribute('aria-pressed', String(textMode));
    fitButton.setAttribute('aria-pressed', String(fit)); zoomLabel.textContent = textMode ? '' : `${Math.round(scale * 100)}%`;
    status.textContent = `Page ${page} of ${documentProxy.numPages} · Read-only PDF · Document scripts, links, forms and attachments are not activated`;
    selected.cleanup();
    } catch (error) { if (retired || token !== generation) return; throw error; }
  }
  function redraw() { if (retired || !documentProxy) return; void draw().catch(error => { if (!retired && error?.name !== 'RenderingCancelledException') onFailure(error); }); }
  const ready = (async () => {
    arm();
    bundled = await prepareBundledWorker('pdf.worker.mjs', { signal }); if (retired) { bundled.dispose(); return; }
    port = new Worker(bundled.url, { type: 'classic', name: 'inscription-pdf' });
    port.addEventListener('error', () => { if (!retired) { const error = previewFailure('The isolated PDF worker could not start.'); error.code = 'PREVIEW_WORKER'; onFailure(error); } });
    worker = new pdfjs.PDFWorker({ port });
    loadingTask = pdfjs.getDocument({ data, worker, verbosity: pdfjs.VerbosityLevel.ERRORS,
      disableRange: true, disableStream: true, disableAutoFetch: true, enableXfa: false,
      useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory,
      cMapUrl: `${ASSETS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${ASSETS}standard_fonts/`, wasmUrl: `${ASSETS}wasm/`, iccUrl: `${ASSETS}iccs/`,
      useWasm: true, maxImageSize: 16_777_216, canvasMaxAreaInBytes: 32 * 1024 * 1024, useSystemFonts: false
    });
    loadingTask.onPassword = () => { const error = previewFailure('Password-protected PDFs must be saved and opened in a dedicated PDF reader.'); error.code = 'PREVIEW_PASSWORD'; onFailure(error); };
    documentProxy = await loadingTask.promise;
    if (retired) return;
    if (!Number.isSafeInteger(documentProxy.numPages) || documentProxy.numPages < 1 || documentProxy.numPages > 10000) throw previewFailure('This PDF exceeds the page-count limit.');
    await draw();
  })();
  return { ready, dispose };
}
