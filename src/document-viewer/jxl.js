import { jxlDimensions, MAX_JXL_PIXELS } from './jxl-header.js';
import { previewFailure, fetchPreviewBytes } from './document-preview.js';
import { prepareBundledWorker } from './bundled-worker.js';
export function createJxlPreview(data, { stage, status, signal }) {
  const dimensions = jxlDimensions(data);
  let worker, bundled, retired = false, settle;
  const imageUrl = URL.createObjectURL(new Blob([data], { type: 'image/jxl' }));
  const img = document.createElement('img'); img.alt = 'JPEG XL inscription'; img.className = 'jxl-image';
  const ready = new Promise((resolve, reject) => {
    settle = reject;
    img.addEventListener('load', () => {
      if (retired) return; stage.replaceChildren(img); status.textContent = `${img.naturalWidth} × ${img.naturalHeight} · JPEG XL · Native image decoder`; resolve();
    }, { once: true });
    img.addEventListener('error', async () => {
      if (retired) return;
      // Current Electron builds do not all ship native JPEG XL. Keep the
      // fallback decoder in a terminable worker; never enable browser flags.
      try {
        bundled = await prepareBundledWorker('jxl-worker.js', { signal });
        if (retired) { bundled.dispose(); return; }
        const wasm = await fetchPreviewBytes('ord://document-viewer/assets/jxl/codec/dec/jxl_dec.wasm', { signal, maxBytes: 8 * 1024 * 1024 });
        if (retired) return;
        worker = new Worker(bundled.url, { type: 'classic', name: 'inscription-jxl' });
        worker.addEventListener('error', () => reject(previewFailure('The local JPEG XL decoder could not start.')));
        worker.addEventListener('message', event => {
          if (retired) return;
          const value = event.data, width = value?.width, height = value?.height;
          if (value?.error || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_JXL_PIXELS ||
            !((width === dimensions.width && height === dimensions.height) || (width === dimensions.height && height === dimensions.width)) || !(value.pixels instanceof Uint8ClampedArray) || value.pixels.length !== width * height * 4) { reject(previewFailure('This JPEG XL variant could not be decoded. Save the original for a dedicated image viewer.')); return; }
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.className = 'jxl-image'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'JPEG XL inscription, still image preview');
          canvas.getContext('2d').putImageData(new ImageData(value.pixels, width, height), 0, 0);
          stage.replaceChildren(canvas); status.textContent = `${width} × ${height} · JPEG XL · Still-image compatibility preview (animation and HDR may differ)`;
          worker.terminate(); resolve();
        });
        worker.postMessage({ data, wasmBinary: wasm.data }, [data.buffer, wasm.data.buffer]);
      } catch { reject(previewFailure('The local JPEG XL decoder is unavailable.')); }
    }, { once: true });
    img.src = imageUrl;
  });
  function dispose() { if (retired) return; retired = true; worker?.terminate(); img.removeAttribute('src'); URL.revokeObjectURL(imageUrl); bundled?.dispose(); settle(previewFailure('JPEG XL preview closed.')); signal?.removeEventListener('abort', dispose); }
  signal?.addEventListener('abort', dispose, { once: true });
  return { ready, dispose };
}
