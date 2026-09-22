import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { installContentProtocol } from '../src/main/content-protocol.js';
import { resolveModelContent, MODEL_VIEWER_CSP } from '../src/main/content-model.js';
import { MAX_MODEL_BYTES, MAX_MODEL_RESOURCE_BYTES } from '../src/shared/model-inscription.js';

const id = `${'a'.repeat(64)}i0`;
const result = (type = 'model/gltf+json') => ({ status: 200, headers: { 'content-type': type, 'set-cookie': 'untrusted', 'content-security-policy': 'unsafe', 'x-provider-secret': 'untrusted' }, data: Buffer.from('{"asset":{"version":"2.0"}}') });
test('3D routes admit only exact IDs, local assets, GET and HEAD before any provider access', async () => {
  const calls = []; const resolver = { resolve: async (...args) => { calls.push(args); return result(); } };
  for (const url of [`ord://model-data/${id}?a=1`, `ord://model-data/${id}#a`, `ord://user@model-data/${id}`, `ord://model-data:80/${id}`,
    `ord://model-data/${id}/extra`, 'ord://model-viewer/assets/package.json', 'ord://model-viewer/assets/../../../package.json',
    'ord://model-viewer/assets/%2e%2e/viewer.js', 'ord://model-viewer/assets/viewer.js?code=x', `ord://content/${id}`]) {
    await assert.rejects(resolveModelContent({ url, method: 'GET' }, resolver));
  }
  await assert.rejects(resolveModelContent({ url: `ord://model-data/${id}`, method: 'POST' }, resolver), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  await resolveModelContent({ url: `ord://model-data/${id}`, method: 'GET', signal: controller.signal }, resolver);
  assert.deepEqual(calls[0], [`ord://content/${id}`, { maxBytes: MAX_MODEL_BYTES, accept: '*/*', signal: controller.signal }]);
  const head = await resolveModelContent(new Request(`ord://model-resource/${id}`, { method: 'HEAD' }), resolver);
  assert.equal(await head.text(), ''); assert.equal(calls[1][1].maxBytes, MAX_MODEL_RESOURCE_BYTES);
});

test('3D model data checks actual MIME, complete status and byte size; resources are inert', async () => {
  for (const fixture of [result('text/html'), result('application/json'), { ...result(), status: 206 }, { ...result(), data: Buffer.alloc(0) }, { ...result(), data: Buffer.alloc(MAX_MODEL_BYTES + 1) }]) {
    await assert.rejects(resolveModelContent(new Request(`ord://model-data/${id}`), { resolve: async () => fixture }));
  }
  const response = await resolveModelContent(new Request(`ord://model-resource/${id}`), { resolve: async () => result('text/html') });
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  for (const key of ['set-cookie', 'x-provider-secret']) assert.equal(response.headers.has(key), false);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('viewer is opaque, offline-local code with no external scripts, workers, frames or wallet authority', async () => {
  const response = await resolveModelContent(new Request(`ord://model-viewer/${id}`), { resolve: () => { throw new Error('No network for viewer shell'); } });
  assert.equal(response.headers.get('content-security-policy'), MODEL_VIEWER_CSP);
  const html = await response.text(); assert.match(html, /ord:\/\/model-viewer\/assets\/viewer.js/);
  assert.doesNotMatch(html, /<script[^>]*>[^<\s]|https?:|preload|wallet/i);
  for (const directive of ["sandbox allow-scripts", "worker-src 'none'", "frame-src 'none'", "frame-ancestors app://app"]) assert.ok(MODEL_VIEWER_CSP.includes(directive));
  assert.doesNotMatch(MODEL_VIEWER_CSP, /unsafe-|https:|wss:|app:[^;]*connect|data:/);
});

test('every transitive viewer module import is served from the exact local allowlist', async () => {
  const pending = ['viewer.js'], visited = new Set();
  while (pending.length) {
    const name = pending.pop(); if (visited.has(name)) continue; visited.add(name);
    const response = await resolveModelContent(new Request(`ord://model-viewer/assets/${name}`));
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const source = await response.text();
    for (const match of source.matchAll(/(?:^|\n)(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^\.\/[A-Za-z0-9.-]+\.js$/); pending.push(match[1].slice(2));
    }
  }
  for (const name of ['three.module.js', 'three.core.js', 'GLTFLoader.js', 'OrbitControls.js', 'RoomEnvironment.js', 'BufferGeometryUtils.js', 'SkeletonUtils.js', 'model-inscription.js']) assert.ok(visited.has(name), name);
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies.three, '0.186.0');
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url)));
  assert.equal(lock.packages['node_modules/three'].version, pkg.dependencies.three);
  const license = await fs.readFile(new URL('../node_modules/three/LICENSE', import.meta.url), 'utf8'); assert.match(license, /Permission is hereby granted/);
});

test('registered protocol projects model errors as inert CORS JSON and leaves original bytes intact', async () => {
  let handler; const fixture = result('text/html');
  installContentProtocol({ protocol: { handle: (_scheme, callback) => { handler = callback; } } }, { resolve: async () => fixture }, { get: () => ({}) });
  const failed = await handler(new Request(`ord://model-data/${id}`));
  assert.equal(failed.status, 415); assert.equal(failed.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await failed.json(), { code: 'MODEL_UNAVAILABLE' });
  const original = await handler(new Request(`ord://content/${id}`)); assert.deepEqual(Buffer.from(await original.arrayBuffer()), fixture.data);
});

test('model projection enforces abort before and after resolver completion', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController(); let calls = 0; const reason = new Error('obsolete viewer');
    if (before) controller.abort(reason);
    await assert.rejects(resolveModelContent(new Request(`ord://model-data/${id}`, { signal: controller.signal }), {
      resolve: async () => { calls++; controller.abort(reason); return result(); }
    }), error => error === reason);
    assert.equal(calls, before ? 0 : 1);
  }
});
