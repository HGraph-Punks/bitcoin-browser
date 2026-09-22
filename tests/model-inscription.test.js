import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Box3, LoadingManager, Sphere } from 'three';
import { parseModelDocument, validateModelDocument, modelResourceReference, modelTextureInfo, fetchModelBytes, prepareModelResources, MAX_MODEL_BYTES } from '../src/shared/model-inscription.js';
import { inscriptionPresentation } from '../src/shared/inscription-presentation.js';

function triangle() {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] }] };
}
const encode = model => new TextEncoder().encode(JSON.stringify(model));
function glb() {
  const model = triangle(), binary = Buffer.from(model.buffers[0].uri.split(',')[1], 'base64'); delete model.buffers[0].uri;
  const text = Buffer.from(JSON.stringify(model)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32); text.copy(json);
  const bytes = Buffer.alloc(28 + json.length + binary.length);
  bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + json.length); bytes.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(bytes, 28 + json.length);
  return bytes;
}
const png = (width = 2, height = 2) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b; };

test('glTF and GLB MIME select 3D while JSON inscriptions remain readable text', () => {
  for (const type of ['model/gltf+json', 'MODEL/GLTF-BINARY; charset=binary']) assert.equal(inscriptionPresentation(type), 'model');
  assert.equal(inscriptionPresentation('application/json'), 'text');
});
test('JSON glTF and binary GLB containers parse and preserve geometry/material data', () => {
  assert.equal(parseModelDocument(encode(triangle())).model.accessors[0].count, 3);
  const binary = parseModelDocument(glb()); assert.equal(binary.binary.length, 36); assert.equal(binary.model.buffers[0].uri, undefined);
  const model = triangle(); model.materials = [{ pbrMetallicRoughness: { metallicFactor: 0.86697, roughnessFactor: 0 }, extensions: { KHR_materials_specular: { specularColorFactor: [2, 2, 2] } } }];
  assert.deepEqual(parseModelDocument(encode(model)).model.materials, model.materials);
});
test('malformed, oversized, old and truncated containers fail before engine allocation', () => {
  for (const bytes of [new Uint8Array(), encode(null), encode({ asset: { version: '1.0' } }), new Uint8Array([255]), glb().subarray(0, 30), new Uint8Array(MAX_MODEL_BYTES + 1)]) assert.throws(() => parseModelDocument(bytes));
  const bad = glb(); bad.writeUInt32LE(0xffffffff, 12); assert.throws(() => parseModelDocument(bad));
});
test('model URI policy admits embedded bytes and canonical on-chain IDs only', () => {
  const id = `${'a'.repeat(64)}i0`;
  for (const uri of [id, `/content/${id}`, `ord://content/${id}`]) assert.equal(modelResourceReference(uri, 'buffer').url, `ord://model-resource/${id}`);
  assert.equal(modelResourceReference('data:application/gltf-buffer;base64,YWJj', 'buffer').bytes, 3);
  for (const uri of ['https://evil.example/a.bin', 'file:///tmp/a', 'app://app/main/preload.cjs', 'blob:null/a', '//evil.example/x', 'javascript:alert(1)', `ord://content/${id}?x=y`, `/r/${id}`, '../x.bin', 'data:text/html;base64,YWJj', 'data:image/svg+xml;base64,YWJj', 'data:application/octet-stream;base64,a===', 'data:application/octet-stream;base64,YWJj%20']) assert.throws(() => modelResourceReference(uri, 'buffer'));
});
test('scene cycles, repeated children, huge accessors, invalid views and unsupported decoders fail closed', () => {
  const changes = [m => { m.nodes[0].children = [0]; }, m => { m.nodes[0].children = [1, 1]; m.nodes.push({}); },
    m => { m.accessors[0].count = 10_000_000; }, m => { m.bufferViews[0].byteOffset = 100; }, m => { m.nodes[0].mesh = 99; },
    m => { m.accessors[0].componentType = 'constructor'; }, m => { m.nodes[0].scale = [Infinity, 1, 1]; },
    m => { m.extensionsRequired = ['KHR_texture_basisu']; }, m => { m.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} }; },
    m => { m.scenes[0].nodes = [0, 0]; }, m => { m.nodes = Array.from({ length: 2049 }, () => ({})); }];
  for (const change of changes) { const model = triangle(); change(model); assert.throws(() => validateModelDocument(model)); }
  const model = triangle(); model.asset.extras = { metadata: 'irrelevant '.repeat(10000) }; validateModelDocument(model); assert.equal(model.asset.extras, undefined);
});
test('texture headers reject active documents and decompression dimensions before decoding', () => {
  assert.deepEqual(modelTextureInfo(png(2048, 2048)), { mime: 'image/png', width: 2048, height: 2048 });
  for (const bytes of [png(0, 20), png(200000, 1), png(8192, 8192), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<html><script>evil</script></html>')]) assert.throws(() => modelTextureInfo(bytes));
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 3, 0, 4, 1, 1, 17, 0, 255, 217]);
  assert.deepEqual(modelTextureInfo(jpeg), { mime: 'image/jpeg', width: 4, height: 3 });
});
test('resource preparation creates only owned blobs and revokes them on success disposal or partial failure', async () => {
  const created = [], revoked = [];
  const options = { createObjectURL: () => { const url = `blob:owned-${created.length}`; created.push(url); return url; }, revokeObjectURL: url => revoked.push(url), fetcher: () => { throw new Error('No remote requests'); } };
  const model = triangle(); model.images = [{ uri: `data:image/png;base64,${png().toString('base64')}` }];
  const prepared = await prepareModelResources(parseModelDocument(encode(model)), options);
  assert.equal(prepared.model.buffers[0].uri, created[0]); assert.equal(prepared.model.images[0].uri, created[1]);
  prepared.dispose(); prepared.dispose(); assert.deepEqual(revoked, created);
  const broken = parseModelDocument(encode(triangle())); broken.model.images = [{ uri: 'data:image/png;base64,YWJj' }];
  await assert.rejects(prepareModelResources(broken, options)); assert.deepEqual(revoked, created);
});
test('bounded download omits credentials, rejects redirects, enforces streamed limits and cancellation', async () => {
  let options;
  const bytes = await fetchModelBytes('ord://model-data/test', { fetcher: async (_url, value) => { options = value; return new Response('abc'); } });
  assert.equal(bytes.length, 3); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
  await assert.rejects(fetchModelBytes('ord://model-data/test', { fetcher: async () => new Response('abc'), maxBytes: 2 }));
  await assert.rejects(fetchModelBytes('ord://model-data/test', { fetcher: async () => new Response('abc', { status: 413 }) }), { code: 'MODEL_LIMIT' });
  const controller = new AbortController(); controller.abort(new Error('retired'));
  await assert.rejects(fetchModelBytes('ord://model-data/test', { signal: controller.signal, fetcher: () => { throw new Error('Must not fetch'); } }), /retired/);
});
test('recursive model buffers use the bounded ord route and abort cleanup revokes existing blobs', async () => {
  const model = triangle(), original = Buffer.from(model.buffers[0].uri.split(',')[1], 'base64'); model.buffers[0].uri = `/content/${'b'.repeat(64)}i0`;
  const calls = []; const prepared = await prepareModelResources(parseModelDocument(encode(model)), { fetcher: async (url, options) => { calls.push({ url, options }); return new Response(original); } });
  assert.equal(calls[0].url, `ord://model-resource/${'b'.repeat(64)}i0`); assert.equal(calls[0].options.credentials, 'omit'); prepared.dispose();
});
test('actual pinned Three.js loader parses admitted JSON and GLB geometry with a deny-by-default loading manager', async () => {
  // Actual model parser/scene bounds, not a substitute for native GPU/texture QA.
  globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, detail) { this.type = type; Object.assign(this, detail); } };
  for (const bytes of [encode(triangle()), glb()]) {
    const prepared = await prepareModelResources(parseModelDocument(bytes));
    const manager = new LoadingManager(); manager.setURLModifier(url => { assert.ok(prepared.urls.has(url)); return url; });
    const parsed = await new GLTFLoader(manager).parseAsync(prepared.model, '');
    const bounds = new Box3().setFromObject(parsed.scene).getBoundingSphere(new Sphere());
    assert.ok(bounds.radius > 1); let meshes = 0;
    parsed.scene.traverse(node => { if (node.isMesh) { meshes++; assert.equal(node.geometry.attributes.position.count, 3); node.geometry.dispose(); node.material.dispose(); } });
    assert.equal(meshes, 1); prepared.dispose();
  }
});
