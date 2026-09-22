// Pure, browser-compatible admission checks. Models are data, never programs.
export const MAX_MODEL_BYTES = 32 * 1024 * 1024;
export const MAX_MODEL_RESOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_MODEL_TOTAL_BYTES = 64 * 1024 * 1024;
export const MODEL_LOAD_TIMEOUT_MS = 45_000;
const ID = /^[0-9a-f]{64}i\d{1,10}$/i;
const supportedExtensions = new Set([
  'KHR_lights_punctual', 'KHR_materials_anisotropy', 'KHR_materials_clearcoat', 'KHR_materials_dispersion',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_transmission',
  'KHR_materials_iridescence', 'KHR_materials_unlit', 'KHR_materials_volume', 'KHR_mesh_quantization',
  'KHR_texture_transform', 'EXT_materials_bump', 'EXT_texture_webp'
]);
const unavailableExtensions = new Set(['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression',
  'KHR_meshopt_compression', 'EXT_mesh_gpu_instancing', 'EXT_texture_avif']);
export class ModelPreviewError extends Error {
  constructor(code, message) { super(message); this.name = 'ModelPreviewError'; this.code = code; }
}
function invalid(message = 'This model is incomplete or malformed.') { throw new ModelPreviewError('INVALID_MODEL', message); }
function limit(message = 'This model is too complex for the safe 3D preview. Save the original to use a dedicated 3D application.') { throw new ModelPreviewError('MODEL_LIMIT', message); }
function integer(value, maximum, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value; }
function record(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function list(value, maximum) { if (value === undefined) return []; if (!Array.isArray(value)) invalid(); if (value.length > maximum) limit(); return value; }
function reference(array, index) { integer(index, array.length - 1); return array[index]; }

export function modelResourceReference(uri, kind) {
  if (typeof uri !== 'string') invalid();
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    const header = uri.slice(0, comma);
    const allowed = kind === 'image' ? /^data:image\/(png|jpeg|webp);base64$/ : /^data:application\/(octet-stream|gltf-buffer);base64$/;
    if (comma < 0 || comma > 80 || !allowed.test(header)) invalid('The model has an unsupported embedded resource.');
    const encoded = uri.slice(comma + 1);
    if (encoded.length > Math.ceil(MAX_MODEL_RESOURCE_BYTES / 3) * 4) limit();
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (!encoded.length || encoded.length % 4 || /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))) invalid('The model has an invalid embedded resource.');
    return { kind: 'embedded', mime: header.slice(5, -7), encoded, bytes: encoded.length / 4 * 3 - padding };
  }
  const match = /^(?:ord:\/\/content\/|\/content\/)?([0-9a-f]{64}i\d{1,10})$/i.exec(uri);
  if (!match) throw new ModelPreviewError('MODEL_EXTERNAL_RESOURCE', 'This model links to an external or unsupported resource. The 3D preview only loads embedded data and exact on-chain /content/ references.');
  return { kind: 'inscription', url: `ord://model-resource/${match[1].toLowerCase()}` };
}

export function parseModelDocument(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) invalid();
  if (bytes.byteLength > MAX_MODEL_BYTES) limit();
  let jsonBytes = bytes, binary = null;
  if (bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 0x46546c67) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== bytes.byteLength) invalid('This GLB file has an invalid header.');
    let offset = 12, index = 0;
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) invalid();
      const length = data.getUint32(offset, true), type = data.getUint32(offset + 4, true);
      offset += 8;
      if (length % 4 || offset + length > bytes.byteLength) invalid();
      if (index === 0) { if (type !== 0x4e4f534a) invalid(); jsonBytes = bytes.subarray(offset, offset + length); }
      else if (type === 0x004e4942 && binary === null) binary = bytes.subarray(offset, offset + length);
      else invalid('This GLB file contains unsupported or duplicate chunks.');
      offset += length; index++;
    }
  }
  let model;
  try { model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)); } catch { invalid('This is not a readable glTF 2.0 model.'); }
  validateModelDocument(model);
  return { model, binary };
}

export function validateModelDocument(model) {
  record(model);
  if (model.asset?.version !== '2.0' || (model.asset.minVersion && model.asset.minVersion !== '2.0')) invalid('Only glTF 2.0 and GLB 2.0 models are supported.');
  // Bound traversal and reject non-finite transforms before reaching the engine.
  const stack = [[model, 0]];
  let visited = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++visited > 100_000 || depth > 64) limit();
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e12)) invalid();
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (stack.length + keys.length > 100_000) limit();
      for (const key of keys) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid();
        if (key === 'extras') { delete value[key]; continue; } // Metadata is available in the original, not copied to scene objects.
        if (key === 'extensions') {
          for (const extension of Object.keys(record(value[key]))) if (unavailableExtensions.has(extension)) {
            throw new ModelPreviewError('MODEL_EXTENSION', 'This model needs a compression or instancing extension that is not yet supported by the 3D preview.');
          }
        }
        stack.push([value[key], depth + 1]);
      }
    }
  }
  for (const name of list(model.extensionsRequired, 32)) if (!supportedExtensions.has(name)) {
    throw new ModelPreviewError('MODEL_EXTENSION', 'This model requires a 3D extension that is not yet supported.');
  }
  list(model.extensions?.KHR_lights_punctual?.lights, 16);
  const buffers = list(model.buffers, 64), views = list(model.bufferViews, 4096), accessors = list(model.accessors, 4096);
  let bufferBytes = 0, accessorBytes = 0;
  for (const buffer of buffers) { record(buffer); bufferBytes += integer(buffer.byteLength, MAX_MODEL_TOTAL_BYTES, 1); if (buffer.uri !== undefined) modelResourceReference(buffer.uri, 'buffer'); }
  if (bufferBytes > MAX_MODEL_TOTAL_BYTES) limit();
  for (const view of views) {
    record(view); const buffer = reference(buffers, view.buffer);
    if (integer(view.byteOffset ?? 0, buffer.byteLength) + integer(view.byteLength, buffer.byteLength, 1) > buffer.byteLength) invalid();
    if (view.byteStride !== undefined) { integer(view.byteStride, 252, 4); if (view.byteStride % 4) invalid(); }
  }
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  for (const accessor of accessors) {
    record(accessor);
    if (!Object.hasOwn(components, accessor.type) || !Object.hasOwn(sizes, accessor.componentType)) invalid();
    const count = integer(accessor.count, 3_000_000, 1), element = components[accessor.type] * sizes[accessor.componentType];
    accessorBytes += count * Math.max(element, 4); if (accessorBytes > MAX_MODEL_TOTAL_BYTES) limit();
    if (accessor.bufferView !== undefined) {
      const view = reference(views, accessor.bufferView);
      const required = integer(accessor.byteOffset ?? 0, view.byteLength) + (count - 1) * (view.byteStride ?? element) + element;
      if (required > view.byteLength) invalid();
    }
    if (accessor.sparse) {
      const sparse = record(accessor.sparse); integer(sparse.count, count, 1);
      for (const part of [sparse.indices, sparse.values]) { record(part); const view = reference(views, part.bufferView); integer(part.byteOffset ?? 0, view.byteLength); }
    }
  }
  const nodes = list(model.nodes, 2048), meshes = list(model.meshes, 512), scenes = list(model.scenes, 32);
  const parents = new Set(); let draws = 0, vertices = 0;
  for (const mesh of meshes) for (const primitive of list(record(mesh).primitives, 512)) {
    record(primitive); const attributes = record(primitive.attributes);
    for (const value of Object.values(attributes)) reference(accessors, value);
    if (primitive.indices !== undefined) reference(accessors, primitive.indices);
    for (const target of list(primitive.targets, 16)) for (const value of Object.values(record(target))) reference(accessors, value);
  }
  for (const node of nodes) {
    record(node);
    if (node.mesh !== undefined) for (const primitive of reference(meshes, node.mesh).primitives) {
      draws++;
      vertices += reference(accessors, primitive.indices ?? primitive.attributes.POSITION).count * (1 + (primitive.targets?.length ?? 0));
    }
    for (const child of list(node.children, 2048)) { reference(nodes, child); if (parents.has(child)) invalid('The model has a repeated or cyclic scene graph.'); parents.add(child); }
  }
  if (draws > 1024 || vertices > 3_000_000 || nodes.filter(node => node.extensions?.KHR_lights_punctual).length > 16) limit();
  // Check ALL nodes (including unreachable ones), using bounded depth, and reject cycles.
  const done = new Set(), active = new Set();
  function visit(index, depth) {
    if (depth > 64) limit(); if (active.has(index)) invalid('The model has a cyclic scene graph.'); if (done.has(index)) return;
    active.add(index); for (const child of nodes[index].children ?? []) visit(child, depth + 1); active.delete(index); done.add(index);
  }
  nodes.forEach((_node, index) => visit(index, 0));
  for (const scene of scenes) {
    const roots = new Set();
    for (const index of list(record(scene).nodes, 2048)) { reference(nodes, index); if (roots.has(index) || parents.has(index)) invalid(); roots.add(index); }
  }
  if (model.scene !== undefined) reference(scenes, model.scene);
  for (const skin of list(model.skins, 128)) { for (const joint of list(record(skin).joints, 256)) reference(nodes, joint); }
  for (const animation of list(model.animations, 32)) { list(record(animation).channels, 256); list(animation.samplers, 256); }
  list(model.materials, 256); list(model.textures, 128); list(model.samplers, 128);
  for (const image of list(model.images, 64)) {
    record(image);
    if (image.uri !== undefined) modelResourceReference(image.uri, 'image');
    else { reference(views, image.bufferView); if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) invalid('This texture format is not supported.'); }
  }
  return model;
}

// Inspect dimensions before giving compressed bytes to Chromium's image decoder.
export function modelTextureInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > MAX_MODEL_RESOURCE_BYTES) invalid('This model texture is invalid or too large.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, mime;
  if (bytes.length >= 33 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
  } else if (view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { if (length < 8) invalid(); height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); mime = 'image/jpeg'; break; }
      offset += length;
    }
  } else if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250 && view.getUint32(4, true) + 8 === bytes.length) {
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858) {
      if (bytes[20] & 2) invalid('Animated model textures are not supported.');
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16); height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === 0x5650384c && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (chunk === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    }
    mime = 'image/webp';
  }
  if (!width || !height || !mime) invalid('A model texture is not a supported PNG, JPEG or WebP image.');
  if (width > 8192 || height > 8192 || width * height > 16_777_216) limit('A model texture exceeds the safe preview dimensions.');
  return { mime, width, height };
}

export async function fetchModelBytes(url, { fetcher = globalThis.fetch, signal, maxBytes = MAX_MODEL_RESOURCE_BYTES, onProgress, onContentType } = {}) {
  signal?.throwIfAborted();
  const response = await fetcher(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (!response.ok) throw new ModelPreviewError(response.status === 413 ? 'MODEL_LIMIT' : 'MODEL_UNAVAILABLE', 'The model could not be downloaded from your selected source or offline cache.');
  onContentType?.(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase());
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); limit(); }
  if (!response.body?.getReader) invalid();
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > maxBytes) limit(); chunks.push(value); onProgress?.(total);
    }
    signal?.throwIfAborted();
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function validateStlDocument(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) invalid();
  if (bytes.length > MAX_MODEL_BYTES) limit();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const finite = value => { if (!Number.isFinite(value) || Math.abs(value) > 1e9) invalid('The STL contains invalid coordinates.'); };
  if (bytes.length >= 84 && 84 + view.getUint32(80, true) * 50 === bytes.length) {
    const triangles = view.getUint32(80, true); if (!triangles) invalid(); if (triangles > 250_000) limit();
    for (let i = 0; i < triangles; i++) for (let n = 0; n < 12; n++) finite(view.getFloat32(84 + i * 50 + n * 4, true));
    return { format: 'binary', triangles };
  }
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid('The STL is neither valid binary nor readable ASCII.'); }
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const vector = `(${number})\\s+(${number})\\s+(${number})`;
  const facet = new RegExp(`\\s*facet\\s+normal\\s+${vector}\\s+outer\\s+loop\\s+vertex\\s+${vector}\\s+vertex\\s+${vector}\\s+vertex\\s+${vector}\\s+endloop\\s+endfacet`, 'iy');
  const start = /\s*solid[^\r\n]*(?:\r?\n|$)/iy, end = /\s*endsolid[^\r\n]*(?:\r?\n|$)/iy;
  const whitespace = /\s*/y;
  let position = 0, triangles = 0, solids = 0;
  while (position < text.length) {
    whitespace.lastIndex = position; whitespace.exec(text); position = whitespace.lastIndex; if (position === text.length) break;
    if (++solids > 512) limit(); start.lastIndex = position; const header = start.exec(text); if (!header) invalid('The ASCII STL has an invalid solid header.'); position = start.lastIndex;
    for (;;) {
      end.lastIndex = position; if (end.exec(text)) { position = end.lastIndex; break; }
      facet.lastIndex = position; const match = facet.exec(text); if (!match) invalid('The ASCII STL has a damaged triangle.');
      if (++triangles > 250_000) limit(); for (const coordinate of match.slice(1)) finite(Number(coordinate)); position = facet.lastIndex;
    }
  }
  if (!triangles || text.slice(position).trim()) invalid('The STL has no triangles or trailing unsupported data.');
  return { format: 'ascii', triangles };
}

export async function prepareModelResources(document, { fetcher, signal, createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url) } = {}) {
  const { model, binary } = document;
  const urls = new Set(), resources = new Map();
  let total = 0, pixels = 0;
  const dispose = () => { for (const url of urls) revokeObjectURL(url); urls.clear(); };
  const account = bytes => { total += bytes.byteLength; if (total > MAX_MODEL_TOTAL_BYTES) limit(); return bytes; };
  const blobUrl = (bytes, type) => { const url = createObjectURL(new Blob([bytes], { type })); urls.add(url); return url; };
  async function resource(uri, kind) {
    const ref = modelResourceReference(uri, kind);
    if (resources.has(uri)) return resources.get(uri);
    signal?.throwIfAborted();
    const bytes = ref.kind === 'embedded' ? Uint8Array.from(atob(ref.encoded), c => c.charCodeAt(0))
      : await fetchModelBytes(ref.url, { fetcher, signal });
    resources.set(uri, account(bytes)); return bytes;
  }
  try {
    const buffers = [];
    for (const [index, buffer] of (model.buffers ?? []).entries()) {
      const bytes = buffer.uri !== undefined ? await resource(buffer.uri, 'buffer') : index === 0 && binary ? account(binary) : null;
      if (!bytes || bytes.byteLength < buffer.byteLength || bytes.byteLength > buffer.byteLength + 3) invalid('The model buffer length does not match its data.');
      buffers.push(bytes); buffer.uri = blobUrl(bytes, 'application/octet-stream');
    }
    for (const image of model.images ?? []) {
      let bytes;
      if (image.uri !== undefined) bytes = await resource(image.uri, 'image');
      else { const view = model.bufferViews[image.bufferView]; bytes = buffers[view.buffer].subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength); }
      const info = modelTextureInfo(bytes); pixels += info.width * info.height;
      if (pixels > 33_554_432) limit('This model has too many high-resolution textures for the safe preview.');
      image.uri = blobUrl(bytes, info.mime); image.mimeType = info.mime; delete image.bufferView;
    }
    signal?.throwIfAborted();
    return { model, urls, dispose };
  } catch (error) { dispose(); throw error; }
}

export function modelInscriptionId(pathname) { const id = pathname.slice(1); return ID.test(id) ? id.toLowerCase() : null; }
