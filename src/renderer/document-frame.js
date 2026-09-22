import { h } from './dom.js';
import { DOCUMENT_KINDS, INSCRIPTION_PREVIEW_ID, previewLink } from '../shared/document-preview.js';
const labels = { pdf: 'PDF reader', font: 'Font specimen', markdown: 'Markdown reader', jxl: 'JPEG XL image', binary: 'Data inspector' };
export function createDocumentFrame({ id, kind, title, onStatus, onReady, onFailure, onLink }, { eventTarget = globalThis.window, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!INSCRIPTION_PREVIEW_ID.test(id ?? '') || !DOCUMENT_KINDS.includes(kind)) throw new Error('A canonical inscription ID and document kind are required');
  let retired = false, loaded = false, background = 'dark', timer, settle;
  const ready = new Promise(resolve => { settle = resolve; });
  const frame = h('iframe', { className: 'inscription-document', title: `${title} · ${labels[kind]}`,
    sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', allow: '',
    onLoad: () => { if (!retired) appearance(); }, onError: () => fail('PREVIEW_INVALID') });
  function appearance() { frame.contentWindow?.postMessage({ type: 'satoshi:document-appearance', background }, '*'); }
  function dispose() { if (retired) return; retired = true; cancel(timer); eventTarget?.removeEventListener('message', message); frame.src = 'about:blank'; settle(); }
  function fail(code) {
    if (retired) return; dispose();
    onFailure(code === 'PREVIEW_TIMEOUT' ? 'This preview took too long to load. Check your source or offline cache, then retry.' : 'The selected source could not provide a supported file within the preview limits. It may be incomplete, protected, or use an unsupported variant. Retry or save the original for a dedicated application.');
  }
  function message(event) {
    if (retired || !frame.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const value = event.data;
    if (!value || value.id !== id.toLowerCase() || value.kind !== kind) return;
    if (value.type === 'satoshi:document-link') { const target = previewLink(value.href); if (loaded && target) onLink?.(target); return; }
    if (value.type !== 'satoshi:document-viewer') return;
    if (value.state === 'error') { fail(value.code); return; }
    if (loaded) return;
    if (value.state === 'ready') { loaded = true; cancel(timer); settle(); onReady(labels[kind]); appearance(); }
    else if (value.state === 'loading') onStatus(`Preparing ${labels[kind].toLowerCase()}…`);
  }
  eventTarget?.addEventListener('message', message);
  timer = schedule(() => fail('PREVIEW_TIMEOUT'), 60_000); timer?.unref?.();
  frame.setAttribute('src', `ord://document-viewer/${kind}/${id.toLowerCase()}`);
  return { frame, ready, dispose, setBackground(value) { background = ['light', 'checker'].includes(value) ? value : 'dark'; if (!retired) appearance(); } };
}
