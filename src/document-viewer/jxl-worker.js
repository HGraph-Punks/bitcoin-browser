import decode, { init } from './jxl/decode.js';
import { jxlDimensions, MAX_JXL_PIXELS } from './jxl-header.js';
let used = false;
self.addEventListener('message', async event => {
  if (used) return; used = true;
  try {
    const { data, wasmBinary } = event.data ?? {};
    const dimensions = jxlDimensions(data);
    if (!(wasmBinary instanceof Uint8Array) || !wasmBinary.length || wasmBinary.length > 8 * 1024 * 1024) throw new Error('Decoder unavailable');
    await init({ wasmBinary, print() {}, printErr() {} });
    const decoded = await decode(data.buffer);
    const { width, height } = decoded;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_JXL_PIXELS ||
      !((width === dimensions.width && height === dimensions.height) || (width === dimensions.height && height === dimensions.width)) || decoded.data?.byteLength !== width * height * 4) throw new Error('Invalid decoded bounds');
    const pixels = new Uint8ClampedArray(decoded.data); self.postMessage({ width, height, pixels }, [pixels.buffer]);
  } catch { self.postMessage({ error: true }); }
});
