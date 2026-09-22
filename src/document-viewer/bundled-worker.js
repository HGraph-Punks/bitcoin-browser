import { fetchPreviewBytes, previewFailure } from './document-preview.js';
// Native testing found module workers fail in this Electron opaque sandbox,
// while classic workers start. Only prebuilt, exact local worker assets are
// admitted here. Inscription bytes can never become worker source code.
export async function prepareBundledWorker(entry, { signal, fetcher, createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url) } = {}) {
  const assets = { 'pdf.worker.mjs': 'pdf.worker.js', 'jxl-worker.js': 'jxl.worker.js' };
  if (!Object.hasOwn(assets, entry)) throw previewFailure('Unknown bundled worker.');
  const result = await fetchPreviewBytes(`ord://document-viewer/assets/${assets[entry]}`, { signal, fetcher, maxBytes: 8 * 1024 * 1024 });
  signal?.throwIfAborted();
  const url = createObjectURL(new Blob([result.data], { type: 'text/javascript' })); let retired = false;
  return { url, dispose() { if (retired) return; retired = true; revokeObjectURL(url); } };
}
