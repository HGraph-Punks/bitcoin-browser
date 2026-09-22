import fs from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import { INSCRIPTION_DISPLAY_ID, INSCRIPTION_MODEL_TYPES, inscriptionMime } from '../shared/inscription-presentation.js';
import { decodedContentBytes } from './content-decoding.js';
import { MAX_MODEL_BYTES, MAX_MODEL_RESOURCE_BYTES } from '../shared/model-inscription.js';

// An exact, read-only asset map, not a filesystem proxy. Three.js is a pinned
// production dependency included in the ASAR; nothing is loaded from a CDN.
const assets = new Map([
  ['viewer.js', new URL('../model-viewer/viewer.js', import.meta.url)],
  ['viewer.css', new URL('../model-viewer/viewer.css', import.meta.url)],
  ['model-inscription.js', new URL('../shared/model-inscription.js', import.meta.url)],
  ['three.module.js', new URL('../../node_modules/three/build/three.module.js', import.meta.url)],
  ['three.core.js', new URL('../../node_modules/three/build/three.core.js', import.meta.url)],
  ...['loaders/GLTFLoader', 'loaders/STLLoader', 'controls/OrbitControls', 'environments/RoomEnvironment', 'utils/BufferGeometryUtils', 'utils/SkeletonUtils'].map(name =>
    [`${name.split('/').at(-1)}.js`, new URL(`../../node_modules/three/examples/jsm/${name}.js`, import.meta.url)])
]);

export const MODEL_VIEWER_CSP = [
  "default-src 'none'", "script-src ord://model-viewer/assets/", "style-src ord://model-viewer/assets/",
  'connect-src ord://model-data/ ord://model-resource/ blob:', 'img-src blob:',
  "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  'frame-ancestors app://app', "sandbox allow-scripts"
].join('; ');

const safeHeaders = {
  'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), xr-spatial-tracking=()',
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'"
};

export async function resolveModelContent(request, resolver) {
  const url = new URL(request.url);
  if (url.protocol !== 'ord:' || !['model-viewer', 'model-data', 'model-resource'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash) {
    throw new AppError('UNSAFE_ORD_PATH', 'Invalid 3D viewer address', { status: 400 });
  }
  if (!['GET', 'HEAD'].includes(request.method)) throw new AppError('METHOD_NOT_ALLOWED', '3D content requires GET or HEAD', { status: 405 });
  request.signal?.throwIfAborted();
  let body, type, csp = safeHeaders['content-security-policy'];
  if (url.hostname === 'model-viewer' && url.pathname.startsWith('/assets/')) {
    const name = url.pathname.slice('/assets/'.length);
    const file = assets.get(name);
    if (!file) throw new AppError('NOT_FOUND', 'Unknown viewer asset', { status: 404 });
    let source = await fs.readFile(file, 'utf8');
    // Only import specifiers in these exact bundled files are rewritten. No
    // inscription-controlled text is ever served as executable viewer code.
    if (name.endsWith('.js')) source = source.replaceAll("from 'three'", "from './three.module.js'")
      .replaceAll("from '../utils/BufferGeometryUtils.js'", "from './BufferGeometryUtils.js'")
      .replaceAll("from '../utils/SkeletonUtils.js'", "from './SkeletonUtils.js'");
    body = Buffer.from(source);
    type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
  } else {
    const id = url.pathname.slice(1);
    if (!INSCRIPTION_DISPLAY_ID.test(id)) throw new AppError('UNSAFE_ORD_PATH', 'Invalid inscription ID', { status: 400 });
    if (url.hostname === 'model-viewer') {
      body = await fs.readFile(new URL('../model-viewer/index.html', import.meta.url));
      type = 'text/html; charset=utf-8';
      csp = MODEL_VIEWER_CSP;
    } else {
      const maxBytes = url.hostname === 'model-data' ? MAX_MODEL_BYTES : MAX_MODEL_RESOURCE_BYTES;
      const result = await resolver.resolve(`ord://content/${id.toLowerCase()}`, { maxBytes, accept: '*/*', signal: request.signal });
      request.signal?.throwIfAborted();
      if (result.status !== 200) throw new AppError('MODEL_UNAVAILABLE', 'The source did not return a complete model resource', { status: 415 });
      if (!(result.data instanceof Uint8Array) || !result.data.byteLength || result.data.byteLength > maxBytes) {
        throw new AppError('RESOURCE_TOO_LARGE', 'The model resource exceeds the preview limit', { status: 413 });
      }
      type = inscriptionMime(new Headers(result.headers).get('content-type'));
      if (url.hostname === 'model-data' && !INSCRIPTION_MODEL_TYPES.includes(type)) {
        throw new AppError('MODEL_UNAVAILABLE', 'This resource is not a supported 3D model', { status: 415 });
      }
      // Subresources are never returned as active content, even with false MIME.
      type = url.hostname === 'model-resource' ? 'application/octet-stream' : type;
      body = await decodedContentBytes(result, maxBytes, request.signal);
    }
  }
  request.signal?.throwIfAborted();
  return new Response(request.method === 'HEAD' ? null : body, { headers: {
    ...safeHeaders, 'content-type': type, 'content-length': String(body.byteLength), 'content-security-policy': csp
  } });
}
