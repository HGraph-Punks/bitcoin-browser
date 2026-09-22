import { h } from './dom.js';
import { INSCRIPTION_DISPLAY_ID } from '../shared/inscription-presentation.js';

const errors = Object.freeze({
  MODEL_TIMEOUT: 'The 3D view took too long to load. Check your data source or offline cache, then retry.',
  MODEL_UNAVAILABLE: 'Your selected source or offline cache could not provide the complete model. Check the source, then retry.',
  MODEL_LIMIT: 'This model exceeds the 3D preview’s size or complexity limit. Save the original to open it in a dedicated 3D application.',
  MODEL_EXTENSION: 'This model needs a compression or 3D extension that is not yet supported. You can still save the original.',
  MODEL_EXTERNAL_RESOURCE: 'This model needs an external or unsupported resource. The 3D preview only loads embedded data and exact on-chain content references.',
  MODEL_GRAPHICS: 'The graphics renderer is unavailable or was interrupted. Retry the view, or save the original to open it in a 3D application.',
  INVALID_MODEL: 'The model or one of its textures is incomplete or unsupported. Retry from another data source or save the original.'
});

export function createModelFrame({ id, title, onStatus, onReady, onFailure }, { eventTarget = globalThis.window, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (!INSCRIPTION_DISPLAY_ID.test(id ?? '')) throw new Error('A canonical inscription ID is required for 3D preview');
  let retired = false, loaded = false, background = 'dark', timer, settle;
  const ready = new Promise(resolve => { settle = resolve; });
  const frame = h('iframe', { className: 'inscription-model', title: `${title} · Interactive 3D view`,
    sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', allow: '',
    onLoad: () => { if (!retired) sendAppearance(); }, onError: () => fail('MODEL_UNAVAILABLE') });
  function sendAppearance() { frame.contentWindow?.postMessage({ type: 'satoshi:model-appearance', background }, '*'); }
  function dispose() {
    if (retired) return; retired = true; cancel(timer);
    eventTarget?.removeEventListener('message', message);
    frame.src = 'about:blank'; settle();
  }
  function fail(code) { if (retired) return; dispose(); onFailure(errors[code] ?? errors.INVALID_MODEL); }
  function message(event) {
    if (retired || !frame.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const value = event.data;
    if (value?.type !== 'satoshi:model-viewer' || value.id !== id.toLowerCase()) return;
    if (value.state === 'error') { fail(Object.hasOwn(errors, value.code) ? value.code : 'INVALID_MODEL'); return; }
    if (loaded) return;
    if (value.state === 'ready') { loaded = true; cancel(timer); settle(); onReady(); sendAppearance(); }
    else if (['loading', 'preparing', 'rendering'].includes(value.state)) {
      onStatus(value.state === 'loading' ? 'Loading 3D inscription…' : value.state === 'preparing' ? 'Preparing 3D model and textures…' : 'Lighting the 3D view…');
    }
  }
  eventTarget?.addEventListener('message', message);
  // Also covers module/CSP/graphics startup failures before the frame can report.
  timer = schedule(() => fail('MODEL_TIMEOUT'), 60_000); timer?.unref?.();
  frame.setAttribute('src', `ord://model-viewer/${id.toLowerCase()}`);
  return { frame, ready, dispose, setBackground(value) { background = ['light', 'checker'].includes(value) ? value : 'dark'; if (!retired) sendAppearance(); } };
}
