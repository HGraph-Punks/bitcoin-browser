import * as THREE from './three.module.js';
import { GLTFLoader } from './GLTFLoader.js';
import { STLLoader } from './STLLoader.js';
import { OrbitControls } from './OrbitControls.js';
import { RoomEnvironment } from './RoomEnvironment.js';
import { fetchModelBytes, parseModelDocument, prepareModelResources, validateStlDocument, modelInscriptionId, MAX_MODEL_BYTES, MODEL_LOAD_TIMEOUT_MS } from './model-inscription.js';

// Runs ONLY in ord://model-viewer's opaque, script-only sandbox. There is no
// preload, wallet bridge, external network, dynamic decoder or user script.
const id = modelInscriptionId(location.pathname);
const stage = document.getElementById('stage'), status = document.getElementById('status');
const title = document.getElementById('status-title'), detail = document.getElementById('status-detail');
const controlsBar = document.getElementById('controls'), rotate = document.getElementById('rotate');
const play = document.getElementById('play'), animation = document.getElementById('animation');
const abort = new AbortController();
let renderer, controls, scene, camera, model, mixer, action, environment, resources, resizeObserver;
let retired = false, ready = false, rotating = false, playing = false, frame = 0, lastTime = 0, radius = 1;
let timeout;
function publish(state, code) { if (id && parent !== window) parent.postMessage({ type: 'satoshi:model-viewer', id, state, ...(code ? { code } : {}) }, 'app://app'); }
function phase(text, state) { title.textContent = text; publish(state); }
function disposeScene(root) {
  const disposed = new Set();
  root?.traverse(object => {
    if (object.geometry && !disposed.has(object.geometry)) { disposed.add(object.geometry); object.geometry.dispose(); }
    object.skeleton?.dispose();
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
      if (disposed.has(material)) continue; disposed.add(material);
      for (const value of Object.values(material)) if (value?.isTexture && !disposed.has(value)) {
        disposed.add(value); value.source?.data?.close?.(); value.dispose();
      }
      material.dispose();
    }
  });
}
function release() {
  clearTimeout(timeout); abort.abort(); cancelAnimationFrame(frame); frame = 0;
  resizeObserver?.disconnect(); controls?.dispose(); mixer?.stopAllAction(); if (model) mixer?.uncacheRoot(model);
  disposeScene(scene); environment?.dispose(); resources?.dispose(); renderer?.dispose(); renderer?.forceContextLoss();
}
function fail(code = 'INVALID_MODEL') {
  if (retired) return;
  retired = true; ready = false; release();
  status.hidden = false; controlsBar.hidden = true; document.getElementById('hint').hidden = true;
  status.querySelector('.spinner').hidden = true;
  title.textContent = 'This 3D preview could not be displayed';
  detail.textContent = 'Retry the preview, check your data source, or save the original to open in a 3D application.';
  console.warn(`SATOSHI_MODEL_VIEWER_ERROR:${['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'MODEL_LIMIT', 'MODEL_EXTENSION', 'MODEL_EXTERNAL_RESOURCE', 'MODEL_GRAPHICS'].includes(code) ? code : 'INVALID_MODEL'}`);
  publish('error', code);
}
function render(now = performance.now()) {
  frame = 0;
  if (!ready || retired || document.hidden) return;
  try {
    const elapsed = Math.min(Math.max((now - lastTime) / 1000, 0), 0.05); lastTime = now;
    controls.autoRotate = rotating; controls.update(elapsed);
    if (playing) mixer?.update(elapsed);
    renderer.render(scene, camera);
    if (rotating || playing) requestRender();
  } catch { fail('MODEL_GRAPHICS'); }
}
function requestRender() { if (ready && !retired && !frame && !document.hidden) frame = requestAnimationFrame(render); }
function fit() {
  const angle = Math.min(THREE.MathUtils.degToRad(camera.fov) / 2, Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect));
  const distance = radius / Math.sin(angle) * 1.22;
  camera.position.set(0, radius * 0.12, distance);
  camera.near = radius / 1000; camera.far = radius * 200;
  camera.updateProjectionMatrix(); controls.target.set(0, 0, 0);
  controls.minDistance = radius * 1.05; controls.maxDistance = radius * 40;
  controls.update(); controls.saveState(); requestRender();
}
function zoom(factor) {
  if (!ready) return;
  const offset = camera.position.clone().sub(controls.target);
  offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance));
  camera.position.copy(controls.target).add(offset); controls.update(); requestRender();
}
document.getElementById('reset').addEventListener('click', fit);
document.getElementById('zoom-in').addEventListener('click', () => zoom(1 / 1.3));
document.getElementById('zoom-out').addEventListener('click', () => zoom(1.3));
rotate.addEventListener('click', () => { rotating = !rotating; rotate.setAttribute('aria-pressed', String(rotating)); requestRender(); });
play.addEventListener('click', () => { playing = !playing; action.paused = !playing; play.textContent = playing ? 'Pause animation' : 'Play animation'; play.setAttribute('aria-pressed', String(playing)); requestRender(); });
animation.addEventListener('change', () => {
  if (!ready) return;
  const clip = model.userData.previewAnimations[Number(animation.value)]; if (!clip) return;
  action?.stop(); action = mixer.clipAction(clip); action.play(); action.paused = !playing; requestRender();
});
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== 'app://app' || event.data?.type !== 'satoshi:model-appearance') return;
  if (['dark', 'light', 'checker'].includes(event.data.background)) document.documentElement.dataset.background = event.data.background;
});
document.addEventListener('visibilitychange', () => { lastTime = performance.now(); requestRender(); });
window.addEventListener('pagehide', () => { if (retired) return; retired = true; release(); }, { once: true });

async function start() {
  timeout = setTimeout(() => fail('MODEL_TIMEOUT'), MODEL_LOAD_TIMEOUT_MS);
  try {
    if (!id) throw new Error('Invalid ID');
    phase('Loading 3D inscription…', 'loading');
    let contentType;
    const bytes = await fetchModelBytes(`ord://model-data/${id}`, { signal: abort.signal, maxBytes: MAX_MODEL_BYTES,
      onContentType: value => { contentType = value; },
      onProgress: count => { detail.textContent = `${(count / 1024 / 1024).toFixed(1)} MB received · Loading the original model`; } });
    if (retired) return;
    phase('Preparing model and textures…', 'preparing');
    let gltf, resourceFailed = false;
    if (['model/stl', 'application/sla'].includes(contentType)) {
      validateStlDocument(bytes);
      const geometry = new STLLoader().parse(bytes.buffer); geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ color: geometry.hasColors ? 0xffffff : 0xd6e0ef, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide, vertexColors: Boolean(geometry.hasColors) });
      const root = new THREE.Group(); root.add(new THREE.Mesh(geometry, material)); gltf = { scene: root, scenes: [root], animations: [] };
    } else {
      resources = await prepareModelResources(parseModelDocument(bytes), { signal: abort.signal });
      if (retired) { resources.dispose(); return; }
      const manager = new THREE.LoadingManager();
      manager.onError = () => { resourceFailed = true; };
      manager.setURLModifier(url => { if (!resources.urls.has(url)) throw new Error('Unapproved model resource'); return url; });
      gltf = await new GLTFLoader(manager).parseAsync(resources.model, '');
    }
    if (retired) { for (const root of gltf.scenes) disposeScene(root); return; }
    scene = new THREE.Scene(); model = gltf.scene;
    if (resourceFailed || !model) throw new Error('Missing model resource');
    scene.add(model);
    // Dispose unused scenes too, without disposing resources shared with the selected scene.
    for (const root of gltf.scenes) if (root !== model) scene.add(root);
    for (const root of gltf.scenes) if (root !== model) root.visible = false;
    const bounds = new THREE.Box3().setFromObject(model, true), center = bounds.getCenter(new THREE.Vector3());
    radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    if (!Number.isFinite(radius) || radius <= 0 || radius > 1e9) throw new Error('Invalid model bounds');
    model.position.sub(center);
    phase('Lighting the 3D view…', 'rendering');
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
    catch { fail('MODEL_GRAPHICS'); return; }
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
    const surface = renderer.domElement; surface.tabIndex = 0;
    surface.setAttribute('aria-label', '3D model. Drag to rotate, scroll to zoom, arrow keys to rotate, plus or minus to zoom, Home to reset.');
    stage.prepend(surface);
    camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    controls = new OrbitControls(camera, surface); controls.enableDamping = false; controls.autoRotateSpeed = 1.2; controls.enablePan = false;
    controls.addEventListener('change', requestRender);
    surface.addEventListener('webglcontextlost', event => { event.preventDefault(); fail('MODEL_GRAPHICS'); });
    surface.addEventListener('keydown', event => {
      if (!ready || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') fit();
      else if (['+', '=', '-'].includes(event.key)) zoom(event.key === '-' ? 1.3 : 1 / 1.3);
      else {
        const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
        if (event.key === 'ArrowLeft') spherical.theta -= 0.15; if (event.key === 'ArrowRight') spherical.theta += 0.15;
        if (event.key === 'ArrowUp') spherical.phi -= 0.15; if (event.key === 'ArrowDown') spherical.phi += 0.15;
        spherical.makeSafe(); camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); controls.update(); requestRender();
      }
    });
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer);
    try { environment = pmrem.fromScene(room, 0.04); scene.environment = environment.texture; }
    finally { room.dispose(); pmrem.dispose(); }
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667080, 1));
    const key = new THREE.DirectionalLight(0xffffff, 2.5); key.position.set(3, 5, 4); scene.add(key);
    if (gltf.animations.length) {
      model.userData.previewAnimations = gltf.animations;
      mixer = new THREE.AnimationMixer(model);
      gltf.animations.forEach((clip, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = String(clip.name || `Animation ${index + 1}`).slice(0, 80); animation.append(option); });
      animation.hidden = gltf.animations.length < 2; play.hidden = false;
      action = mixer.clipAction(gltf.animations[0]); action.play(); action.paused = true;
    }
    function resize() {
      if (retired) return;
      const width = Math.max(stage.clientWidth, 1), height = Math.max(stage.clientHeight, 1);
      const scale = Math.min(devicePixelRatio || 1, 2, 4096 / width, 4096 / height, Math.sqrt(4_194_304 / (width * height)));
      renderer.setSize(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), false); camera.aspect = width / height; camera.updateProjectionMatrix();
      requestRender();
    }
    resizeObserver = new ResizeObserver(resize); resizeObserver.observe(stage); resize(); fit();
    renderer.render(scene, camera); // Readiness is the first draw, never iframe load.
    ready = true; clearTimeout(timeout); resources?.dispose();
    status.hidden = true; controlsBar.hidden = false; document.getElementById('hint').hidden = false;
    lastTime = performance.now(); console.info('SATOSHI_MODEL_VIEWER_READY'); publish('ready');
  } catch (error) { fail(error?.code ?? 'INVALID_MODEL'); }
}
void start();
