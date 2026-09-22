import { button, clear, formatBytes, h } from './dom.js';
import { inscriptionMime, inscriptionPresentation, INSCRIPTION_DISPLAY_ID, MAX_INSCRIPTION_TEXT_BYTES, presentInscriptionText } from '../shared/inscription-presentation.js';
import { createModelFrame } from './model-frame.js';
import { createDocumentFrame } from './document-frame.js';
import { DOCUMENT_KINDS } from '../shared/document-preview.js';

function coloredJson(text) {
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"\s*:|"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[\s\S]/g) ?? [];
  if (tokens.length > 3000) return [text];
  return tokens.map(token => {
    const kind = /^"[\s\S]*":$/.test(token) ? 'key' : token.startsWith('"') ? 'string' : /^-?\d/.test(token) ? 'number' : /^(true|false|null)$/.test(token) ? 'literal' : null;
    return kind ? h('span', { className: `json-${kind}` }, token) : token;
  });
}

export function createInscriptionDisplay({ inscriptionId, sourceUrl, contentType, title, loading = false }, ctx) {
  const type = inscriptionMime(contentType);
  const presentation = inscriptionPresentation(type);
  let mode = presentation === 'original' ? 'original' : 'preview';
  let disposed = false;
  let generation = 0;
  let cleanup = () => {};
  let textController = null;
  let image = null;
  let imageScale = 1;
  let imageMode = 'fit';
  let imageReady = false;
  let sourceText = null;
  let textPresentation = null;
  let showFormatted = true;
  let pixelChoice = null;
  let ready = Promise.resolve();
  let modelFrame = null;
  let documentFrame = null;
  let deadline;
  const schedule = ctx.previewTimers?.schedule ?? setTimeout, cancel = ctx.previewTimers?.cancel ?? clearTimeout;
  const canvas = h('div', { className: 'viewer-canvas', dataset: { mode: presentation, background: 'auto' } });
  const content = h('div', { className: 'inscription-stage', tabindex: 0, role: 'region', ariaLabel: 'Inscription content' });
  const status = h('p', { className: 'viewer-content-status', role: 'status', 'aria-live': 'polite' });
  const previewButton = button(presentation === 'model' ? '3D view' : 'Preview', { small: true, onClick: () => switchMode('preview') });
  const originalButton = button('Original', { small: true, onClick: () => switchMode('original') });
  const fitButton = button('Fit', { small: true, onClick: () => sizeImage('fit') });
  const actualButton = button('Actual size', { small: true, onClick: () => sizeImage('actual', 1) });
  const zoomOut = button('−', { small: true, ariaLabel: 'Zoom out', onClick: () => zoom(-1) });
  const zoomIn = button('+', { small: true, ariaLabel: 'Zoom in', onClick: () => zoom(1) });
  const zoomLabel = h('span', { className: 'viewer-zoom-label', 'aria-live': 'polite' }, 'Fit to view');
  const imageControls = h('div', { className: 'viewer-control-group', role: 'group', ariaLabel: 'Image size' }, fitButton, actualButton, zoomOut, zoomLabel, zoomIn);
  const formattedButton = button('Formatted', { small: true, onClick: () => { showFormatted = true; drawText(); } });
  const sourceButton = button('Source', { small: true, onClick: () => { showFormatted = false; drawText(); } });
  const copyButton = button('Copy text', { small: true, onClick: () => { if (sourceText !== null) ctx.copy?.(sourceText); } });
  const textControls = h('div', { className: 'viewer-control-group', role: 'group', ariaLabel: 'Text presentation' }, formattedButton, sourceButton, copyButton);
  const pixelButton = button('Crisp pixels', { small: true, onClick: () => {
    pixelChoice = !(image?.style.imageRendering === 'pixelated'); applyPixels();
  } });
  const background = h('select', { ariaLabel: 'Canvas background', onChange: () => {
    const selected = ['auto', 'dark', 'light', 'checker'].includes(background.value) ? background.value : 'auto';
    canvas.dataset.background = selected;
    modelFrame?.setBackground(selected === 'auto' ? document.documentElement?.dataset.theme : selected);
    documentFrame?.setBackground(selected === 'auto' ? document.documentElement?.dataset.theme : selected);
  } }, [['auto', 'Match browser'], ['dark', 'Dark'], ['light', 'Light'], ['checker', 'Transparency grid']].map(([value, label]) => h('option', { value }, label)));
  background.value = 'auto';
  const appearance = h('details', { className: 'viewer-appearance' }, h('summary', {}, 'Appearance'),
    h('div', { className: 'viewer-appearance-panel' }, h('label', {}, 'Canvas background', background), pixelButton,
      h('p', {}, 'Background changes do not alter the inscription. Original content may draw its own background.')));
  const toolbar = h('div', { className: 'viewer-toolbar' },
    h('div', { className: 'viewer-control-group', role: 'group', ariaLabel: 'Viewing mode' }, previewButton, originalButton), imageControls, textControls,
    h('span', { className: 'viewer-toolbar-spacer' }), appearance);
  canvas.append(content, status);

  function alive(token) { return !disposed && generation === token; }
  function refreshStats() { try { Promise.resolve(ctx.refreshCacheStats?.()).catch(() => {}); } catch {} }
  function updateControls() {
    previewButton.hidden = presentation === 'original';
    previewButton.setAttribute('aria-pressed', String(mode === 'preview'));
    originalButton.setAttribute('aria-pressed', String(mode === 'original'));
    imageControls.hidden = mode !== 'preview' || presentation !== 'image';
    textControls.hidden = mode !== 'preview' || presentation !== 'text';
    pixelButton.hidden = mode !== 'preview' || presentation !== 'image';
    for (const control of [fitButton, actualButton, zoomIn, zoomOut, pixelButton]) control.disabled = !imageReady;
    for (const control of [formattedButton, sourceButton, copyButton]) control.disabled = sourceText === null;
    copyButton.disabled = sourceText === null || sourceText.length === 0;
    formattedButton.hidden = !textPresentation?.isJson;
    sourceButton.hidden = !textPresentation?.isJson;
  }
  function applyPixels() {
    if (!image) return;
    const crisp = pixelChoice ?? (image.naturalWidth <= 128 && image.naturalHeight <= 128 && type !== 'image/svg+xml');
    image.style.imageRendering = crisp ? 'pixelated' : 'auto';
    pixelButton.setAttribute('aria-pressed', String(crisp));
  }
  function sizeImage(nextMode, scale = 1) {
    if (!imageReady || !image) return;
    const fitScale = Math.min((content.clientWidth - 48) / image.naturalWidth, (content.clientHeight - 48) / image.naturalHeight);
    const maximumScale = Math.min(Math.max(8, fitScale * 8), 32768 / Math.max(image.naturalWidth, image.naturalHeight));
    imageScale = Math.max(Math.min(0.1, maximumScale), Math.min(scale, maximumScale));
    imageMode = nextMode === 'actual' && imageScale !== 1 ? 'zoom' : nextMode;
    content.dataset.size = imageMode;
    image.style.width = imageMode === 'fit' ? '100%' : `${Math.max(1, Math.round(image.naturalWidth * imageScale))}px`;
    image.style.height = imageMode === 'fit' ? '100%' : `${Math.max(1, Math.round(image.naturalHeight * imageScale))}px`;
    zoomLabel.textContent = imageMode === 'fit' ? 'Fit to view' : `${Math.round(imageScale * 100)}%`;
    fitButton.setAttribute('aria-pressed', String(imageMode === 'fit'));
    actualButton.setAttribute('aria-pressed', String(imageMode === 'actual'));
    content.scrollTop = 0; content.scrollLeft = 0;
  }
  function zoom(direction) {
    if (!imageReady || !image) return;
    const current = imageMode === 'fit' ? Math.min((content.clientWidth - 48) / image.naturalWidth, (content.clientHeight - 48) / image.naturalHeight) : imageScale;
    sizeImage('zoom', (Number.isFinite(current) && current > 0 ? current : 1) * (direction > 0 ? 1.5 : 1 / 1.5));
  }
  function notice(titleText, message, showOriginal = true) {
    cancel(deadline);
    generation++; textController?.abort(); textController = null;
    cleanup(); cleanup = () => {};
    modelFrame = null; documentFrame = null; image = null;
    sourceText = null; textPresentation = null;
    imageReady = false;
    updateControls();
    content.dataset.presentation = 'notice';
    canvas.setAttribute('aria-busy', 'false');
    clear(content, h('div', { className: 'inscription-display-notice' }, h('span', { className: 'eyebrow' }, 'Inscription viewer'), h('h2', {}, titleText), h('p', {}, message),
      showOriginal ? button(presentation === 'model' ? 'Retry 3D view' : 'Retry preview', { onClick: () => switchMode(mode) }) : null,
      sourceUrl && showOriginal ? button('Open Original', { onClick: () => switchMode('original') }) : null,
      inscriptionId ? button('Save original', { onClick: () => ctx.saveContent?.(inscriptionId) }) : null));
  }
  function drawText() {
    if (disposed || mode !== 'preview' || sourceText === null) return;
    content.dataset.presentation = 'text';
    const text = showFormatted ? textPresentation.formatted : sourceText;
    const pre = h('pre', { className: 'inscription-text', tabindex: 0, ariaLabel: showFormatted && textPresentation.isJson ? 'Formatted JSON inscription' : 'Inscription source text' },
      h('code', {}, showFormatted && textPresentation.isJson ? coloredJson(text) : text));
    clear(content, h('article', { className: 'inscription-text-document' },
      h('header', {}, h('span', { className: 'eyebrow' }, textPresentation.isJson ? 'JSON inscription' : 'Text inscription'),
        h('span', {}, textPresentation.isJson ? 'Inscribed data · not a verified token balance' : type || 'Plain text')),
      sourceText.length ? pre : h('p', { className: 'help' }, 'This inscription contains an empty text document.')));
    formattedButton.setAttribute('aria-pressed', String(showFormatted));
    sourceButton.setAttribute('aria-pressed', String(!showFormatted));
    updateControls();
  }
  function switchMode(next) {
    if (disposed || (next === 'preview' && presentation === 'original')) return;
    generation++;
    cancel(deadline);
    textController?.abort(); textController = null;
    cleanup(); cleanup = () => {};
    modelFrame = null;
    documentFrame = null;
    image = null; imageReady = false;
    mode = next;
    sourceText = null; textPresentation = null;
    canvas.dataset.mode = mode === 'original' ? 'original' : presentation;
    content.dataset.presentation = mode === 'original' ? 'original' : presentation;
    content.dataset.size = 'fit';
    clear(content);
    canvas.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading inscription…';
    updateControls();
    const token = generation;
    // A bounded recovery path also covers native decoding, a stalled original
    // frame, and missing metadata. Successful loading always cancels it.
    deadline = schedule(() => {
      if (!alive(token)) return;
      generation++; textController?.abort(); cleanup(); cleanup = () => {};
      status.textContent = 'Preview timed out';
      notice('This inscription is taking too long', 'Check your data source or offline cache, then retry. You can also save the original.');
    }, 65_000); deadline?.unref?.();
    if (loading) {
      status.textContent = 'Loading inscription details…';
      content.append(h('p', { className: 'inscription-display-loading', role: 'status' }, 'Preparing your inscription…'));
      return;
    }
    if (!sourceUrl) {
      status.textContent = 'Content unavailable';
      notice('Content ID unavailable', 'The selected source did not return a canonical inscription ID.');
      return;
    }
    if (mode === 'original' && presentation === 'model') {
      status.textContent = 'Original 3D model · Saving preserves the original bytes';
      notice('This original is a 3D model file', 'Choose 3D view to rotate and explore it here, or Save original to open the unmodified file in a 3D application.', false);
    } else if (mode === 'original' && DOCUMENT_KINDS.includes(presentation)) {
      status.textContent = 'Save original preserves the unmodified file';
      notice('The original is a downloadable file', 'Use Preview to read or inspect this inscription here. Save original keeps every byte for a compatible application; the preview does not modify the file.', false);
    } else if (mode === 'original') {
      const frame = h('iframe', { src: sourceUrl, title,
        sandbox: 'allow-scripts allow-forms allow-modals allow-pointer-lock', referrerpolicy: 'no-referrer', allow: '',
        onLoad: () => { if (!alive(token)) return; cancel(deadline); canvas.setAttribute('aria-busy', 'false'); status.textContent = 'Original content · Opaque sandbox · No browser or wallet access'; refreshStats(); },
        onError: () => { if (!alive(token)) return; notice('Original content unavailable', 'Check your data source or offline cache, then retry.'); } });
      content.append(frame);
      cleanup = () => { frame.src = 'about:blank'; };
    } else if (presentation === 'model' && INSCRIPTION_DISPLAY_ID.test(inscriptionId ?? '')) {
      modelFrame = createModelFrame({ id: inscriptionId, title,
        onStatus: text => { if (alive(token)) status.textContent = text; },
        onReady: () => {
          if (!alive(token)) return;
          cancel(deadline);
          canvas.setAttribute('aria-busy', 'false');
          status.textContent = 'Interactive 3D · Drag to rotate · Scroll to zoom · Isolated from browser and wallet controls';
          refreshStats();
        },
        onFailure: message => {
          if (!alive(token)) return;
          status.textContent = '3D preview unavailable';
          notice('Could not display this 3D inscription', message);
        }
      }, ctx.modelFrameOptions);
      ready = modelFrame.ready;
      cleanup = modelFrame.dispose;
      content.append(modelFrame.frame);
      modelFrame.setBackground(background.value === 'auto' ? document.documentElement?.dataset.theme : background.value);
    } else if (DOCUMENT_KINDS.includes(presentation) && INSCRIPTION_DISPLAY_ID.test(inscriptionId ?? '')) {
      documentFrame = createDocumentFrame({ id: inscriptionId, kind: presentation, title,
        onStatus: text => { if (alive(token)) status.textContent = text; },
        onReady: label => { if (!alive(token)) return; cancel(deadline); canvas.setAttribute('aria-busy', 'false'); status.textContent = `${label} · Isolated from browser and wallet controls · Save keeps the original file`; refreshStats(); },
        onFailure: message => { if (!alive(token)) return; status.textContent = 'Document preview unavailable'; notice('Could not display this inscription', message); },
        onLink: target => { if (alive(token)) ctx.navigate?.(target); }
      }, ctx.documentFrameOptions);
      ready = documentFrame.ready; cleanup = documentFrame.dispose; content.append(documentFrame.frame);
      documentFrame.setBackground(background.value === 'auto' ? document.documentElement?.dataset.theme : background.value);
    } else if (presentation === 'image') {
      const node = h('img', { className: 'inscription-image', src: sourceUrl, alt: title, decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false',
        onLoad: () => {
          if (!alive(token)) return;
          cancel(deadline);
          if (!node.naturalWidth || !node.naturalHeight) { status.textContent = 'Image preview unavailable'; notice('Image preview unavailable', 'Open Original to view this inscription.'); return; }
          imageReady = true; canvas.setAttribute('aria-busy', 'false');
          status.textContent = `${node.naturalWidth.toLocaleString()} × ${node.naturalHeight.toLocaleString()} pixels${type === 'image/svg+xml' ? ' · SVG preview; choose Original for scripts or linked resources' : ' · Original colors preserved'}`;
          updateControls(); applyPixels(); sizeImage('fit'); refreshStats();
        }, onError: () => { if (!alive(token)) return; status.textContent = 'Image preview unavailable'; notice('This image could not be displayed', 'Retry from the browser toolbar, save it, or open the original. No replacement content was opened automatically.'); } });
      image = node;
      content.append(h('div', { className: 'inscription-image-space' }, node));
      cleanup = () => node.removeAttribute?.('src');
    } else if (presentation === 'text' && INSCRIPTION_DISPLAY_ID.test(inscriptionId ?? '')) {
      content.append(h('p', { className: 'inscription-display-loading', role: 'status' }, 'Preparing a readable text view…'));
      textController = new AbortController();
      const signal = textController.signal;
      const fetchPreview = ctx.fetchContentPreview ?? ((...args) => globalThis.fetch(...args));
      ready = (async () => {
        try {
          const response = await fetchPreview(`ord://text/${inscriptionId}`, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
          if (!alive(token)) return;
          if (!response.ok) throw new Error(response.status === 413 ? 'Text previews are limited to 256 KiB. Save or open Original to read the complete document.' : 'The source did not provide a readable text preview. Retry, save it, or open Original.');
          if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('The text preview response was not supported. Open Original instead.');
          const body = await response.json();
          if (!alive(token)) return;
          if (typeof body.text !== 'string' || body.text.length > MAX_INSCRIPTION_TEXT_BYTES || !Number.isSafeInteger(body.bytes) || body.bytes < 0 || body.bytes > MAX_INSCRIPTION_TEXT_BYTES) throw new Error('This text preview exceeds the display limit. Open Original instead.');
          sourceText = body.text;
          cancel(deadline);
          textPresentation = presentInscriptionText(sourceText);
          canvas.setAttribute('aria-busy', 'false');
          status.textContent = `${formatBytes(body.bytes)} · ${body.cache === 'stale' ? 'Cached, possibly stale · ' : body.cache === 'hit' ? 'Cached · ' : ''}Read-only text · Save keeps the original bytes`;
          drawText(); refreshStats();
        } catch (error) {
          if (!alive(token) || signal.aborted) return;
          status.textContent = 'Text preview unavailable';
          notice('Could not prepare this text', error instanceof TypeError ? 'Check your data source or offline cache, then retry. You can also open Original.' : String(error.message).slice(0, 500));
        }
      })();
    } else if (presentation === 'audio' || presentation === 'video') {
      const media = h(presentation, { className: 'inscription-media', src: sourceUrl, controls: true, preload: 'metadata', playsinline: true,
        ariaLabel: title, onLoadedmetadata: () => { if (!alive(token)) return; cancel(deadline); canvas.setAttribute('aria-busy', 'false'); status.textContent = `${presentation === 'audio' ? 'Audio' : 'Video'} inscription · Playback starts when you press Play`; refreshStats(); },
        onError: () => { if (!alive(token)) return; status.textContent = 'Media preview unavailable'; notice('This media could not be played', 'Your browser may not support this format. Save it or try Original.'); } });
      content.append(h('div', { className: 'inscription-media-space' }, presentation === 'audio' ? h('div', { className: 'inscription-audio-art', 'aria-hidden': 'true' }, '♫') : null, media));
      cleanup = () => { media.pause?.(); media.removeAttribute?.('src'); media.load?.(); };
    } else notice('Preview unavailable', 'Open Original to view this inscription in its own format.');
  }
  switchMode(mode);
  return { canvas, toolbar, get ready() { return ready; }, dispose() {
    if (disposed) return;
    disposed = true; generation++;
    cancel(deadline);
    textController?.abort(); cleanup();
  } };
}
