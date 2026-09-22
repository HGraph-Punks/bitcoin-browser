import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installAppProtocol } from '../src/main/app-protocol.js';
import { renderAbout } from '../src/renderer/about.js';
import { renderAbout as renderAboutFromViews } from '../src/renderer/views.js';
import { clear } from '../src/renderer/dom.js';
import { TURTLE_MOON_LOGO, TURTLE_MOON_WEBSITE } from '../src/renderer/assets/turtle-moon.js';
import { BITCOIN_BROWSER_LOGO } from '../src/renderer/assets/bitcoin-browser.js';
import { DONATION } from '../src/shared/donation.js';

// Real renderer functions and event callbacks, with an intentionally small DOM
// collaborator. This does not establish native layout or screen-reader behavior.
class TestNode {
  constructor(tag, text = '') {
    this.tagName = tag.toUpperCase(); this.text = text; this.children = [];
    this.attributes = {}; this.listeners = {}; this.dataset = {}; this.style = {};
    this.className = ''; this.open = false; this.scrollTop = 0;
    this.classList = { toggle: (name, enabled) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    } };
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'open') this.open = true; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  focus() { document.activeElement = this; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase()) ? [child] : [],
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = {
  activeElement: null, createElement: tag => new TestNode(tag),
  createTextNode: text => new TestNode('#text', String(text))
};

function model() {
  return { activeTabId: 'about-tab', requestSequence: { 'about-tab': 7 }, bootstrap: {
    application: { version: '1.2.3-beta.4', platform: 'darwin', arch: 'arm64', packaged: false },
    state: { schemaVersion: 9 }, secureStorageAvailable: true
  } };
}
const aboutResult = () => ({ target: { kind: 'internal', value: 'about', canonical: 'satnav://about' } });
function fixture(value = model()) {
  const calls = [];
  const context = {
    navigate: target => calls.push(['navigate', target]),
    copy: async value => { calls.push(['copy', value]); return true; },
    openExternal: async value => { calls.push(['external', value]); return true; },
    exportDiagnostics: () => calls.push(['export']),
    revealPath: key => calls.push(['reveal', key])
  };
  return { root: renderAbout(value, context), calls, context, model: value };
}
const control = (root, label) => {
  const found = root.querySelectorAll('button').find(node => node.textContent === label);
  assert.ok(found, `Missing button: ${label}`); return found;
};

test('About exposes the public brand, Turtle Moon credit and runtime version without remote work', () => {
  const f = fixture();
  assert.equal(renderAboutFromViews, renderAbout);
  assert.equal(f.root.querySelectorAll('h1').length, 1);
  assert.equal(f.root.querySelector('h1').textContent, 'Bitcoin Browser');
  assert.ok(f.root.querySelectorAll('h2').some(node => node.textContent === 'Turtle Moon'));
  assert.match(f.root.textContent, /Turtle Moon created Bitcoin Browser/);
  assert.match(f.root.textContent, /Version 1\.2\.3-beta\.4/);
  assert.match(f.root.textContent, /Early beta/);
  assert.deepEqual(f.calls, []);
  for (const tag of ['iframe', 'script', 'video', 'audio', 'input']) {
    assert.equal(f.root.querySelectorAll(tag).length, 0, `No unexpected ${tag} in offline About`);
  }
  assert.equal(f.root.querySelectorAll('img').length, 3);
  assert.equal(f.root.querySelectorAll('a').length, 1);
});

test('Turtle Moon branding uses the local marketing-site SVG, never a live image endpoint', () => {
  const f = fixture(), image = f.root.querySelector('.about-creator-logo');
  assert.equal(image.getAttribute('src'), TURTLE_MOON_LOGO.src);
  assert.equal(TURTLE_MOON_LOGO.src, './assets/turtle-moon.svg');
  assert.deepEqual([TURTLE_MOON_LOGO.width, TURTLE_MOON_LOGO.height], [100, 100]);
  assert.equal(Object.isFrozen(TURTLE_MOON_LOGO), true);
  assert.equal(image.getAttribute('alt'), 'Turtle Moon logo');
  assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(image.getAttribute('width'), '72');
  assert.equal(image.getAttribute('height'), '72');
  assert.deepEqual(f.calls, []);
});

test('bundled logo retains the approved turtle/crescent geometry and brand colors without active SVG content', () => {
  const svg = fs.readFileSync(new URL('../src/renderer/assets/turtle-moon.svg', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(svg) < 1024);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">/);
  assert.deepEqual([...svg.matchAll(/<([A-Za-z][\w:-]*)\b/g)].map(match => match[1]), ['svg', 'rect', 'g', 'path', 'path', 'circle']);
  assert.deepEqual([...svg.matchAll(/<path d="([^"]+)"/g)].map(match => match[1]), [
    'M71 11A37 37 0 0 0 19 53c10-10 23-15 37-15a28 28 0 0 1 15-27Z',
    'M17 64c8-16 24-24 42-21l-7 20c-11 11-23 12-41 9l6-8ZM57 48c2-12 13-19 24-14 8 4 9 11 3 17l-12 8c-3 17-10 27-21 33l4-22c-10 8-19 10-30 8L14 86c-7 4-13 2-11-3l9-9c19 5 34-1 43-11Z'
  ]);
  assert.match(svg, /<rect width="100" height="100" rx="18" fill="#f7f4ed"/);
  assert.match(svg, /<g fill="#2f4f3e" transform="translate\(8 5\) scale\(\.86\)"/);
  assert.match(svg, /<circle cx="77" cy="40" r="2\.5" fill="#f7f4ed"/);
  assert.doesNotMatch(svg, /<!|<script|<foreignObject|<image|\bon\w+\s*=|(?:href|src)\s*=|url\(|@import|localhost|data:|<animate/i);
});

test('the bundled SVG is served through the existing protected app protocol with no external request', async () => {
  let handler;
  installAppProtocol({ protocol: { handle(scheme, callback) { assert.equal(scheme, 'app'); handler = callback; } } },
    fileURLToPath(new URL('../', import.meta.url)), null);
  const url = new URL(TURTLE_MOON_LOGO.src, 'app://app/renderer/index.html').href;
  assert.equal(url, 'app://app/renderer/assets/turtle-moon.svg');
  const response = await handler(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(await response.text(), fs.readFileSync(new URL('../src/renderer/assets/turtle-moon.svg', import.meta.url), 'utf8'));
});

test('website activation prevents embedded navigation and delegates only the fixed HTTPS URL to the normal confirmation path', async () => {
  const f = fixture(), link = f.root.querySelector('a');
  assert.equal(TURTLE_MOON_WEBSITE, 'https://turtlemoon.io/');
  assert.equal(link.getAttribute('href'), TURTLE_MOON_WEBSITE);
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(link.getAttribute('aria-label'), /after confirmation/);
  assert.match(f.root.querySelector('.about-creator').textContent, /system browser after confirmation/);
  let prevented = 0;
  await link.listeners.click({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.deepEqual(f.calls, [['navigate', TURTLE_MOON_WEBSITE]]);
  await link.listeners.auxclick({ button: 1, preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  assert.deepEqual(f.calls, [['navigate', TURTLE_MOON_WEBSITE], ['navigate', TURTLE_MOON_WEBSITE]]);
  link.listeners.auxclick({ button: 2, preventDefault: assert.fail });
  assert.equal(f.calls.length, 2, 'Right-click does not trigger a website launch');
});

test('an unavailable logo preserves the company name and functional website without a remote fallback', async () => {
  const f = fixture(), image = f.root.querySelector('.about-creator-logo');
  image.listeners.error();
  assert.equal(image.hidden, true);
  assert.equal(image.getAttribute('src'), TURTLE_MOON_LOGO.src);
  assert.match(f.root.querySelector('.about-creator').textContent, /Turtle Moon/);
  assert.deepEqual(f.calls, []);
  await f.root.querySelector('a').listeners.click({ preventDefault() {} });
  assert.deepEqual(f.calls, [['navigate', TURTLE_MOON_WEBSITE]]);
});

test('About replaces the placeholder with the owner-approved QR, full address and explicit donation actions', async () => {
  const f = fixture();
  assert.equal(f.root.querySelector('.about-donation-placeholder'), null);
  const support = f.root.querySelector('.about-support');
  assert.equal(support.querySelector('.donation-address').textContent, DONATION.address);
  assert.equal(support.querySelector('img').getAttribute('src'), DONATION.qr);
  assert.match(support.textContent, /Bitcoin · mainnet/);
  assert.match(support.textContent, /No wallet connection needed/);
  assert.deepEqual(f.calls, []);
  await control(support, 'Copy address').listeners.click();
  await control(support, 'Open in wallet').listeners.click();
  assert.deepEqual(f.calls, [['copy', DONATION.address], ['external', DONATION.uri]]);
  assert.match(support.querySelector('.donation-status').textContent, /not a payment confirmation/);
});

test('build information and license default to native closed disclosures, with documentation outside', () => {
  const f = fixture(), disclosures = f.root.querySelectorAll('details');
  assert.deepEqual(disclosures.map(node => node.querySelector('summary').textContent), ['Build & troubleshooting', 'Open-source license']);
  for (const node of disclosures) {
    assert.equal(node.open, false);
    assert.equal(node.getAttribute('open'), null);
    assert.equal(node.children[0].tagName, 'SUMMARY');
    assert.equal(node.children[0].getAttribute('role'), null, 'Native disclosure semantics stay intact');
  }
  assert.equal(f.root.querySelector('.about-help').querySelector('button').textContent, 'Documentation');
  const entries = f.root.querySelector('.about-build-info').children;
  assert.deepEqual(entries.map(node => [node.querySelector('dt').textContent, node.querySelector('dd').textContent]), [
    ['Version', '1.2.3-beta.4'], ['Platform', 'darwin arm64'], ['Packaged', 'No'], ['State schema', '9'], ['Secure storage', 'Yes']
  ]);
});

test('existing documentation, diagnostic export and exact local-folder actions remain explicit and intact', () => {
  const f = fixture();
  assert.match(f.root.textContent, /Redaction is best-effort: review the saved file before sharing it/);
  assert.match(f.root.querySelector('.about-troubleshooting').textContent, /Inscription frames are untrusted opaque sandboxes/);
  assert.match(f.root.querySelector('.about-troubleshooting').textContent, /Analytics are absent in this build/);
  for (const label of ['Documentation', 'Export diagnostics', 'Reveal application data', 'Reveal cache', 'Reveal logs']) {
    const button = control(f.root, label);
    assert.equal(button.getAttribute('type'), 'button');
    button.listeners.click();
  }
  assert.deepEqual(f.calls, [['navigate', 'satnav://documentation'], ['export'], ['reveal', 'data'], ['reveal', 'cache'], ['reveal', 'logs']]);
});

test('About offers an internal Sponsors entry alongside direct optional donations', () => {
  const f = fixture(), section = f.root.querySelector('.about-sponsors');
  assert.match(section.textContent, /sponsoring partners/);
  control(section, 'View sponsors').listeners.click();
  assert.deepEqual(f.calls, [['navigate', 'satnav://sponsors']]);
  assert.equal(section.querySelectorAll('a').length, 0, 'Sponsorship navigation stays inside the browser');
  assert.equal(f.root.querySelector('.about-support').querySelectorAll('button').length, 2);
  assert.equal(f.root.querySelector('.about-support').querySelectorAll('a').length, 0);
});

test('missing build data is honest, and supplied metadata is rendered as text, not HTML', () => {
  const missing = fixture({});
  assert.match(missing.root.textContent, /Version Unknown/);
  assert.equal(missing.root.querySelectorAll('dd').every(node => node.textContent === 'Unknown'), true);
  const value = model();
  value.bootstrap.application.version = '<img src="https://invalid.test" onerror="bad()">';
  value.bootstrap.secureStorageAvailable = false;
  const f = fixture(value);
  assert.match(f.root.textContent, /<img src=/);
  assert.equal(f.root.querySelectorAll('img').length, 3, 'Only the trusted product/creator logos and supplied donation QR exist');
  assert.equal(f.root.querySelector('.about-creator-logo').getAttribute('src'), TURTLE_MOON_LOGO.src);
  assert.equal(f.root.querySelectorAll('dd').at(-1).textContent, 'No');
});

test('About distinguishes the application logo from its creator and retains text on image failure', () => {
  const f = fixture(), image = f.root.querySelector('.about-product-logo');
  assert.equal(image.getAttribute('src'), BITCOIN_BROWSER_LOGO.src);
  assert.equal(image.getAttribute('width'), '88');
  assert.equal(image.getAttribute('height'), '88');
  assert.equal(image.getAttribute('alt'), '');
  assert.equal(image.getAttribute('aria-hidden'), 'true');
  image.listeners.error();
  assert.equal(image.hidden, true);
  assert.equal(f.root.querySelector('h1').textContent, 'Bitcoin Browser');
  assert.equal(f.root.querySelector('.about-creator-logo').getAttribute('src'), TURTLE_MOON_LOGO.src);
  assert.deepEqual(f.calls, []);
});

test('local MIT text exactly preserves the repository license and its contributor attribution', () => {
  const f = fixture();
  const license = fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.equal(f.root.querySelector('.about-license-text').textContent, license.trim());
  assert.match(f.root.querySelector('.about-license').textContent, /third-party software retains its own licenses/);
});

test('About retention rejects actual navigation, errors, tab changes and changed build information', () => {
  const f = fixture(), next = structuredClone(f.model);
  assert.equal(f.root.retainAbout(aboutResult(), next), true);
  assert.equal(f.root.retainAbout({ target: { kind: 'home' } }, next), false);
  assert.equal(f.root.retainAbout({ target: { kind: 'internal', value: 'documentation' } }, next), false);
  assert.equal(f.root.retainAbout({ ...aboutResult(), error: { code: 'FIXTURE' } }, next), false);
  assert.equal(f.root.retainAbout(aboutResult(), { ...next, activeTabId: 'other-tab' }), false);
  assert.equal(f.root.retainAbout(aboutResult(), { ...next, requestSequence: { 'about-tab': 8 } }), false);
  next.bootstrap.application.version = '1.2.4';
  assert.equal(f.root.retainAbout(aboutResult(), next), false);
});

test('actual page dispatcher preserves About disclosures, focused controls and scroll on background updates', () => {
  const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderPage() {'), end = source.indexOf('\nfunction renderDrawer()', start);
  assert.ok(start > 0 && end > start);
  const f = fixture(), page = new TestNode('div'), stage = new TestNode('main');
  let value = f.model, result = aboutResult();
  const renderPage = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    state: () => value, currentResult: () => result, elements: { page, 'main-stage': stage },
    context: f.context, clear, renderAbout, renderDocumentation: () => new TestNode('section', 'Documentation')
  });
  renderPage();
  const original = page.children[0], details = original.querySelector('.about-troubleshooting');
  details.open = true;
  const focused = control(original, 'Export diagnostics'); focused.focus();
  stage.scrollTop = 375;
  value = { ...value, providers: [{ health: { ok: true } }], cache: { bytes: 99 } };
  renderPage();
  assert.equal(page.children[0], original);
  assert.equal(details.open, true);
  assert.equal(document.activeElement, focused);
  assert.equal(stage.scrollTop, 375);
  value = { ...value, requestSequence: { 'about-tab': 8 } };
  renderPage();
  assert.notEqual(page.children[0], original);
  assert.equal(stage.scrollTop, 0);
  result = { target: { kind: 'internal', value: 'documentation' } };
  renderPage();
  assert.equal(page.children[0].textContent, 'Documentation');
});

test('About styles use theme tokens, responsive containers and no second scrolling region or remote assets', () => {
  const css = fs.readFileSync(new URL('../src/renderer/about.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\.\/about\.css"/);
  assert.match(css, /container-type:\s*inline-size/);
  assert.match(css, /@container\s*\(max-width:\s*680px\)/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /summary:focus-visible/);
  assert.match(css, /\.about-website-link:focus-visible/);
  assert.match(css, /\.about-creator-logo\[hidden\]/);
  assert.match(css, /object-fit:\s*contain/);
  assert.match(css, /\.about-creator-logo\s*\{[^}]*image-rendering:\s*auto/);
  assert.doesNotMatch(css, /image-rendering:\s*pixelated/);
  assert.match(css, /white-space:\s*pre-wrap/);
  assert.match(css, /color:\s*var\(--text-2\)/);
  assert.doesNotMatch(css, /overflow(?:-y|-x)?:\s*(?:auto|scroll)|max-height:|height:\s*\d+(?:vh|dvh)|url\(|@import/);
});
