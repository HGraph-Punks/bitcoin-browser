import { h, button } from './dom.js';

const LOGO_URL = new URL('./assets/bitcoin-browser-logo.png', import.meta.url).href;
const MAX_LOGO_PARTICLES = 2300;
const STAR_PARTICLES = 420;
const ORBIT_PARTICLES = 200;
const STRIDE = 11;

// Sample the bundled mark's dark globe/Bitcoin strokes, never its transparent
// background. No external resource, asset upload, texture or library is needed.
export function sampleLogoTargets(pixels, width, height, limit = MAX_LOGO_PARTICLES) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 512 || height > 512 || pixels.length !== width * height * 4) throw new Error('Invalid logo mask');
  const points = [];
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const i = (y * width + x) * 4;
    if (pixels[i + 3] > 200 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 80) points.push([(x / width - .5) * 1.92, (.5 - y / height) * 1.92]);
  }
  const count = Math.min(points.length, Math.max(0, Math.min(MAX_LOGO_PARTICLES, Math.floor(limit))));
  return Array.from({ length: count }, (_, i) => points[Math.floor(i * points.length / count)]);
}

export function createParticleGeometry(targets) {
  if (!targets.length || targets.length > MAX_LOGO_PARTICLES) throw new Error('Invalid particle count');
  const data = new Float32Array((targets.length + STAR_PARTICLES + ORBIT_PARTICLES) * STRIDE);
  let seed = 842000;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const put = (index, x, y, kind) => {
    const angle = random() * Math.PI * 2, radius = 1.3 + random() * 1.9;
    const values = [x, y, kind === 0 ? (random() - .5) * .06 : (random() - .5) * .6, Math.cos(angle) * radius, Math.sin(angle) * radius, (random() - .5) * 1.8, random(), kind, kind === 0 ? 4.1 + random() * 2 : 2.1 + random() * 2, random(), random()];
    data.set(values, index * STRIDE);
  };
  targets.forEach(([x, y], i) => put(i, x, y, 0));
  for (let i = 0; i < STAR_PARTICLES; i++) put(targets.length + i, (random() - .5) * 4.6, (random() - .5) * 3.2, 1);
  for (let i = 0; i < ORBIT_PARTICLES; i++) {
    const angle = i / ORBIT_PARTICLES * Math.PI * 2;
    put(targets.length + STAR_PARTICLES + i, Math.cos(angle) * 1.13, Math.sin(angle) * .48, 2);
  }
  return data;
}

const VERTEX = `
precision highp float;
attribute vec3 a_target;
attribute vec3 a_origin;
attribute vec2 a_identity;
attribute vec3 a_detail;
uniform float u_time;
uniform float u_progress;
uniform float u_aspect;
uniform float u_dpr;
uniform vec3 u_pointer;
varying vec3 v_color;
varying float v_alpha;
void main() {
  float seed = a_identity.x;
  float kind = a_identity.y;
  float angle = (1.0 - u_progress) * (2.2 + seed * 1.7);
  mat2 turn = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  vec3 origin = a_origin;
  origin.xy = turn * origin.xy;
  vec3 pos = mix(origin, a_target, u_progress);
  float drift = sin(u_time * .48 + seed * 17.0);
  if (kind > .5 && kind < 1.5) {
    pos = a_target;
    pos.xy += vec2(sin(u_time * .12 + seed * 8.0), cos(u_time * .1 + seed * 13.0)) * .065;
  } else if (kind > 1.5) {
    float orbit = u_time * .085;
    pos.xy = mat2(cos(orbit), -sin(orbit), sin(orbit), cos(orbit)) * a_target.xy;
    pos.y += sin(u_time * .17 + seed * 5.0) * .022;
  } else {
    pos.xy *= 1.0 + sin(u_time * .65) * .007 * u_progress;
    pos.xy += vec2(sin(seed * 80.0 + u_time), cos(seed * 64.0 + u_time)) * .003 * u_progress;
  }
  if (kind < .5 || kind > 1.5) { pos.xy *= .78; pos.y += .16; }
  vec2 delta = pos.xy - u_pointer.xy;
  float distance = length(delta);
  pos.xy += delta / max(distance, .02) * exp(-distance * distance * 14.0) * u_pointer.z * .075;
  float depth = 1.0 + pos.z * .18;
  gl_Position = vec4(pos.x / u_aspect / depth, pos.y / depth, 0.0, 1.0);
  gl_PointSize = a_detail.x * u_dpr / depth;
  v_color = mix(vec3(1.0, .47, .08), vec3(1.0, .85, .48), seed * .8);
  if (kind > .5 && kind < 1.5 && seed > .8) v_color = vec3(.3, .7, .79);
  v_alpha = kind < .5 ? .66 + drift * .18 : kind > 1.5 ? .3 : .18 + seed * .25;
}`;
const FRAGMENT = `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
void main() {
  float radius = length(gl_PointCoord * 2.0 - 1.0);
  float glow = exp(-radius * radius * 4.2) * (1.0 - smoothstep(.7, 1.0, radius));
  gl_FragColor = vec4(v_color, glow * v_alpha);
}`;

function createRenderer(canvas, geometry) {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', premultipliedAlpha: true });
  if (!gl) throw new Error('WebGL unavailable');
  const shaders = [], program = gl.createProgram(), buffer = gl.createBuffer();
  const dispose = () => { if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program); for (const shader of shaders) gl.deleteShader(shader); };
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type); if (!shader) throw new Error('Shader unavailable'); shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed');
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, geometry, gl.STATIC_DRAW);
    for (const [name, size, offset] of [['a_target', 3, 0], ['a_origin', 3, 3], ['a_identity', 2, 6], ['a_detail', 3, 8]]) {
      const location = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    }
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE); gl.clearColor(0, 0, 0, 0);
    const uniforms = Object.fromEntries(['time', 'progress', 'aspect', 'dpr', 'pointer'].map(name => [name, gl.getUniformLocation(program, 'u_' + name)]));
    return {
      gl, dispose,
      draw(time, pointer) {
        const rect = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 1.75, 1400 / Math.max(rect.width, 1), 1000 / Math.max(rect.height, 1));
        const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        gl.viewport(0, 0, width, height); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(program);
        const phase = Math.min(1, Math.max(0, (time - .12) / 3.2)), progress = phase * phase * (3 - 2 * phase);
        gl.uniform1f(uniforms.time, time); gl.uniform1f(uniforms.progress, progress); gl.uniform1f(uniforms.aspect, width / height); gl.uniform1f(uniforms.dpr, dpr); gl.uniform3f(uniforms.pointer, ...pointer);
        gl.drawArrays(gl.POINTS, 0, geometry.length / STRIDE);
      }
    };
  } catch (error) { dispose(); throw error; }
}

export function createHomeIntro() {
  const canvas = h('canvas', { className: 'home-particle-canvas', 'aria-hidden': 'true' });
  const fallback = h('img', { className: 'home-intro-logo', src: LOGO_URL, alt: '', 'aria-hidden': 'true', width: 256, height: 256, draggable: 'false' });
  const pause = button('Pause animation', { className: 'home-motion-control', onClick: () => { paused = !paused; sync(); } });
  const replay = button('Replay intro', { className: 'home-motion-control', onClick: () => { elapsed = 0; paused = false; lastFrame = null; sync(); } });
  const controls = h('div', { className: 'home-motion-controls', ariaLabel: 'Introduction animation controls' }, pause, replay);
  const stage = h('div', { className: 'home-intro-scene', dataset: { motionState: 'static' } },
    h('div', { className: 'home-scene-grid', 'aria-hidden': 'true' }),
    h('div', { className: 'home-scene-halo', 'aria-hidden': 'true' }), canvas, fallback,
    h('div', { className: 'home-scene-caption', 'aria-hidden': 'true' }, h('span', {}, 'ONE NETWORK. ENDLESS POSSIBILITY.'), h('strong', {}, 'BITCOIN BROWSER')),
    controls);
  let renderer = null, geometry = null, elapsed = 0, frames = 0, lastFrame = null, raf = null, disposed = false, initializing = false, paused = false, onScreen = true, generation = 0, failed = false;
  const pointer = [0, 0, 0], removers = [];
  const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const listen = (target, name, handler, options) => { target.addEventListener(name, handler, options); removers.push(() => target.removeEventListener(name, handler, options)); };
  const stop = () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; lastFrame = null; };
  const release = () => { renderer?.dispose(); renderer = null; canvas.width = canvas.height = 1; stage.classList.toggle('webgl-active', false); };
  const allowed = () => !disposed && !failed && !media?.matches && !paused && !document.hidden && onScreen && stage.isConnected;
  const state = value => { stage.dataset.motionState = value; };
  function frame(timestamp) {
    raf = null; if (!allowed() || !renderer) { sync(); return; }
    raf = requestAnimationFrame(frame);
    if (lastFrame !== null && timestamp - lastFrame < 1000 / 30) return;
    elapsed += lastFrame === null ? 0 : Math.min(.08, (timestamp - lastFrame) / 1000); lastFrame = timestamp;
    renderer.draw(elapsed, pointer); frames++;
    state(elapsed < 3.32 ? 'assembling' : 'ambient');
  }
  async function initialize() {
    if (initializing || renderer || !allowed()) return;
    initializing = true; const token = generation;
    try {
      if (!geometry) {
        await fallback.decode(); if (disposed || generation !== token || media?.matches) return;
        const mask = document.createElement('canvas'); mask.width = mask.height = 192;
        const ctx = mask.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('Logo mask unavailable');
        ctx.drawImage(fallback, 0, 0, 192, 192); geometry = createParticleGeometry(sampleLogoTargets(ctx.getImageData(0, 0, 192, 192).data, 192, 192));
      }
      if (!allowed()) return;
      renderer = createRenderer(canvas, geometry); stage.classList.toggle('webgl-active', true); controls.hidden = false;
      renderer.draw(elapsed, pointer); frames++; sync();
    } catch { failed = true; release(); controls.hidden = true; state('static'); }
    finally { initializing = false; if (!renderer && allowed()) queueMicrotask(sync); }
  }
  function sync() {
    if (disposed) return;
    pause.textContent = paused ? 'Resume animation' : 'Pause animation'; pause.setAttribute('aria-pressed', String(paused));
    if (media?.matches) { generation++; stop(); release(); controls.hidden = true; state('static'); return; }
    if (!allowed()) { stop(); state(failed ? 'static' : paused ? 'paused' : 'suspended'); return; }
    if (!renderer) { void initialize(); return; }
    if (raf === null) raf = requestAnimationFrame(frame);
  }
  stage.animationState = () => ({ state: stage.dataset.motionState, frames, elapsed, particles: geometry?.length / STRIDE || 0, renderer: renderer ? 'webgl' : 'static', disposed });
  stage.dispose = () => { if (disposed) return; disposed = true; generation++; stop(); for (const remove of removers) remove(); resize?.disconnect(); intersection?.disconnect(); release(); state('disposed'); };
  let resize, intersection;
  controls.hidden = true;
  // The domain renderer is also used without a browser/GPU in unit tests.
  if (typeof globalThis.requestAnimationFrame !== 'function' || typeof fallback.decode !== 'function') return stage;
  listen(document, 'visibilitychange', sync);
  if (media) listen(media, 'change', sync);
  listen(window, 'pagehide', () => stage.dispose());
  listen(canvas, 'webglcontextlost', event => { event.preventDefault(); failed = true; stop(); release(); controls.hidden = true; state('static'); });
  listen(canvas, 'pointermove', event => {
    const rect = canvas.getBoundingClientRect(); pointer[0] = (event.clientX - rect.left - rect.width / 2) / (rect.height / 2); pointer[1] = (rect.height / 2 - event.clientY + rect.top) / (rect.height / 2); pointer[2] = 1;
  }, { passive: true });
  listen(canvas, 'pointerleave', () => { pointer[2] = 0; });
  if (typeof ResizeObserver === 'function') { resize = new ResizeObserver(() => { if (renderer && allowed()) renderer.draw(elapsed, pointer); }); resize.observe(stage); }
  if (typeof IntersectionObserver === 'function') { intersection = new IntersectionObserver(entries => { onScreen = entries[0]?.isIntersecting ?? false; sync(); }, { threshold: .05 }); intersection.observe(stage); }
  raf = requestAnimationFrame(() => { raf = null; sync(); });
  return stage;
}
