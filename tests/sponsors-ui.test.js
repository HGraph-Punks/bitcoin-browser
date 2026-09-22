import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { clear } from '../src/renderer/dom.js';
import { HOL_WEBSITE, SPONSORSHIP_INQUIRY_URL, SPONSORSHIP_REPOSITORY, renderSponsors } from '../src/renderer/sponsors.js';
import { renderSponsors as renderSponsorsFromViews } from '../src/renderer/views.js';
import { DONATION } from '../src/shared/donation.js';

// Exercise the actual renderer and event handlers with a small DOM collaborator.
// Native visual/accessibility behavior and GitHub availability are separate checks.
class TestNode {
  constructor(tag, text = '') {
    this.tagName = tag.toUpperCase(); this.text = text; this.children = [];
    this.attributes = {}; this.listeners = {}; this.className = ''; this.scrollTop = 0;
    this.classList = { toggle: (name, enabled) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    } };
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
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

const sponsorsResult = () => ({ target: { kind: 'internal', value: 'sponsors', canonical: 'satnav://sponsors' } });
function fixture() {
  const calls = [], model = { activeTabId: 'sponsors-tab', requestSequence: { 'sponsors-tab': 4 }, bootstrap: {} };
  const context = { navigate: target => { calls.push(target); return Promise.resolve(); } };
  return { root: renderSponsors(model, context), calls, model, context };
}

test('Sponsors credits HOL.org, welcomes companies and individuals, and renders without remote or wallet actions', () => {
  const f = fixture();
  assert.equal(renderSponsorsFromViews, renderSponsors);
  assert.deepEqual(f.root.querySelectorAll('h1').map(node => node.textContent), ['Sponsors']);
  assert.deepEqual(f.root.querySelectorAll('h2').map(node => node.textContent), ['HOL.org', 'Become a sponsor', 'Donate Bitcoin']);
  assert.match(f.root.querySelector('.sponsors-partner').textContent, /Sponsoring partner/);
  assert.match(f.root.textContent, /Any company or individual can become a sponsor/);
  assert.match(f.root.textContent, /Open an issue on our GitHub/);
  assert.match(f.root.textContent, /review and submit it on GitHub/);
  assert.match(f.root.textContent, /does not sign or send payments/);
  assert.deepEqual(f.calls, []);
  for (const tag of ['iframe', 'script', 'object', 'form', 'input', 'textarea', 'canvas', 'video', 'audio']) {
    assert.equal(f.root.querySelectorAll(tag).length, 0, `No unexpected ${tag}`);
  }
  assert.equal(f.root.querySelectorAll('a').length, 2);
  assert.equal(f.root.querySelectorAll('img').length, 1);
  assert.equal(f.root.querySelector('img').getAttribute('src'), DONATION.qr);
  assert.equal(f.root.querySelector('.donation-address').textContent, DONATION.address);
  assert.doesNotMatch(f.root.textContent, /bitcoin:|(?:bc1|tb1|bcrt1)[a-z0-9]{10,}/i);
});

test('the sponsorship draft targets the configured GitHub repository with only static title and body parameters', () => {
  assert.equal(SPONSORSHIP_REPOSITORY, 'https://github.com/HGraphPunks/satoshi-browser-1.0.0-rc.1');
  assert.equal(HOL_WEBSITE, 'https://hol.org/');
  const url = new URL(SPONSORSHIP_INQUIRY_URL);
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/HGraphPunks/satoshi-browser-1.0.0-rc.1/issues/new');
  assert.equal(url.username + url.password + url.hash + url.port, '');
  assert.deepEqual([...url.searchParams.keys()], ['title', 'body']);
  assert.equal(url.searchParams.get('title'), 'Sponsorship inquiry');
  assert.match(url.searchParams.get('body'), /inquire about becoming a sponsor/);
  assert.match(url.searchParams.get('body'), /public information only/);
  assert.match(url.searchParams.get('body'), /Do not include private contact details, credentials, seed phrases, or payment information/);
  assert.ok(SPONSORSHIP_INQUIRY_URL.length < 1500);
  const untrusted = renderSponsors({ activeTabId: 'private-chat', settings: { apiKey: 'PRIVATE_FIXTURE' }, wallet: { address: 'PRIVATE_FIXTURE' } }, {});
  assert.doesNotMatch(untrusted.textContent, /PRIVATE_FIXTURE/);
  assert.equal(untrusted.querySelectorAll('a')[1].getAttribute('href'), SPONSORSHIP_INQUIRY_URL);
});

test('both links intercept clicks and middle-clicks and use only the fixed confirmation-gated destination', async () => {
  const f = fixture();
  for (const [index, url] of [HOL_WEBSITE, SPONSORSHIP_INQUIRY_URL].entries()) {
    const link = f.root.querySelectorAll('a')[index];
    assert.equal(link.getAttribute('href'), url);
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(link.getAttribute('referrerpolicy'), 'no-referrer');
    assert.match(link.getAttribute('aria-label'), /after confirmation/);
    assert.equal(link.getAttribute('target'), null);
    let prevented = 0;
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      await link.listeners.click({ ...modifiers, target: { href: 'https://invalid.test/' }, preventDefault() { prevented++; } });
      assert.equal(f.calls.at(-1), url, 'Destination comes from the reviewed constant, not event data');
    }
    await link.listeners.auxclick({ button: 1, preventDefault() { prevented++; } });
    assert.equal(prevented, 5);
    assert.equal(f.calls.at(-1), url);
    const before = f.calls.length;
    link.listeners.auxclick({ button: 2, preventDefault: assert.fail });
    assert.equal(f.calls.length, before, 'Right-click does not launch an external site');
  }
  assert.deepEqual(f.calls, [...Array(5).fill(HOL_WEBSITE), ...Array(5).fill(SPONSORSHIP_INQUIRY_URL)]);
});

test('the inquiry action explains account access, public visibility and manual review without automatic collection', () => {
  const f = fixture(), link = f.root.querySelectorAll('a')[1], note = f.root.querySelector('.sponsors-issue-note');
  assert.equal(link.getAttribute('aria-describedby'), note.getAttribute('id'));
  assert.match(note.textContent, /GitHub account and repository access required/);
  assert.match(note.textContent, /Issues may be public/);
  assert.match(note.textContent, /do not include private contact details, credentials, seed phrases or payment information/);
  assert.match(f.root.querySelector('.sponsors-footnote').textContent, /system browser after confirmation/);
  const source = fs.readFileSync(new URL('../src/renderer/sponsors.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|window\.open|innerHTML|localStorage|satBrowser|api\.github\.com/);
  assert.deepEqual(f.calls, []);
});

test('Sponsors retention permits only background updates to the same tab and navigation', () => {
  const f = fixture(), next = structuredClone(f.model);
  assert.equal(f.root.retainSponsors(sponsorsResult(), next), true);
  assert.equal(f.root.retainSponsors({ target: { kind: 'home' } }, next), false);
  assert.equal(f.root.retainSponsors({ target: { kind: 'internal', value: 'about' } }, next), false);
  assert.equal(f.root.retainSponsors({ ...sponsorsResult(), error: { code: 'FIXTURE' } }, next), false);
  assert.equal(f.root.retainSponsors(sponsorsResult(), { ...next, activeTabId: 'other-tab' }), false);
  assert.equal(f.root.retainSponsors(sponsorsResult(), { ...next, requestSequence: { 'sponsors-tab': 5 } }), false);
});

test('actual page dispatch preserves Sponsors focus and scroll during source updates but rebuilds on navigation', () => {
  const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderPage() {'), end = source.indexOf('\nfunction renderDrawer()', start);
  assert.ok(start > 0 && end > start);
  const f = fixture(), page = new TestNode('div'), stage = new TestNode('main');
  let value = f.model, result = sponsorsResult();
  const renderPage = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    state: () => value, currentResult: () => result, elements: { page, 'main-stage': stage },
    context: f.context, clear, renderSponsors, renderAbout: () => new TestNode('section', 'About')
  });
  renderPage();
  const original = page.children[0], focused = original.querySelectorAll('a')[1];
  focused.focus(); stage.scrollTop = 310;
  value = { ...value, providers: [{ health: { ok: true } }], cache: { bytes: 99 } };
  renderPage();
  assert.equal(page.children[0], original);
  assert.equal(document.activeElement, focused);
  assert.equal(stage.scrollTop, 310);
  value = { ...value, requestSequence: { 'sponsors-tab': 5 } };
  renderPage();
  assert.notEqual(page.children[0], original);
  assert.equal(stage.scrollTop, 0);
  result = { target: { kind: 'internal', value: 'about' } };
  renderPage();
  assert.equal(page.children[0].textContent, 'About');
});

test('Sponsors styling respects themes, keyboard focus, narrow containers and the single page scrollbar', () => {
  const css = fs.readFileSync(new URL('../src/renderer/sponsors.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\.\/sponsors.css"/);
  assert.match(css, /color:\s*var\(--text(?:-2)?\)/);
  assert.match(css, /container-type:\s*inline-size/);
  assert.match(css, /@container\s*\(max-width:\s*700px\)/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /overflow(?:-y)?:\s*(?:auto|scroll)|max-height:|url\(|@import|https?:|animation:/);
});

test('the extra Sponsors sidebar entry cannot push Settings or About outside a short window', () => {
  const css = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const footer = html.match(/<div class="sidebar-bottom">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.deepEqual([...footer.matchAll(/data-route="([^"]+)"/g)].map(match => match[1]), ['settings', 'sponsors', 'about']);
  assert.match(css, /\.sidebar nav\{[^}]*min-height:0;[^}]*overflow-y:auto/);
  assert.match(css, /\.sidebar nav>\.side-item,\.sidebar nav>\.side-divider\{flex-shrink:0\}/);
  assert.match(css, /\.sidebar-bottom\{flex-shrink:0;padding-top:8px\}/);
});
