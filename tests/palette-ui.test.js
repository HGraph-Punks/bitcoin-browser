import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

class FakeNode {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.className = ''; this.value = ''; this.listeners = {}; this.scrollCount = 0; }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  focus() { document.activeElement = this; }
  scrollIntoView(options) { this.scrollCount += 1; this.lastScrollOptions = options; }
  get classList() { return { contains: (name) => this.className.split(' ').includes(name), add: (name) => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}`; }, remove: (name) => { this.className = this.className.split(' ').filter((item) => item !== name).join(' '); } }; }
}

globalThis.Node = FakeNode;
globalThis.document = { activeElement: null, createElement: (tag) => new FakeNode(tag), createTextNode: (text) => ({ textContent: String(text) }) };
const { h, clear } = await import('../src/renderer/dom.js');

function functionsFixture() {
  const begin = appSource.indexOf('const COMMANDS = [');
  const end = appSource.indexOf('\nfunction executeCommand(', begin);
  assert.ok(begin >= 0 && end > begin, 'actual palette functions must remain extractable');
  const listenerBegin = appSource.indexOf("  elements['palette-input'].addEventListener('input'", end);
  const listenerEnd = appSource.indexOf("  document.addEventListener('keydown'", listenerBegin);
  assert.ok(listenerBegin > end && listenerEnd > listenerBegin, 'actual palette input listeners must remain extractable');
  const input = new FakeNode('input');
  const results = new FakeNode('div');
  const backdrop = new FakeNode('div'); backdrop.className = 'palette-backdrop';
  const modalBackdrop = new FakeNode('div'); modalBackdrop.className = 'hidden';
  const app = new FakeNode('main');
  const omnibox = new FakeNode('input');
  const model = { paletteIndex: 0 };
  const runs = [];
  const context = {
    elements: { 'palette-input': input, 'palette-results': results, 'palette-backdrop': backdrop, 'modal-backdrop': modalBackdrop, app, omnibox },
    MODEL: { patch(value) { Object.assign(model, value); } }, state: () => model,
    h, clear,
    navigate: (value) => runs.push(`browse:${value}`),
    openAiWorkspace: () => runs.push('resume-ai-workspace'),
    newTab: () => runs.push('new-tab'), toggleDeveloper: () => runs.push('developer'), refreshProviders: () => runs.push('health'),
    updateSettings: () => runs.push('settings-update'),
    document, setTimeout: (fn) => fn(), queueMicrotask: (fn) => fn(), closeModal() {}, rememberOverlayFocus() {}, focusOverlay: () => input.focus(), restoreOverlayFocus() {},
    overlayOpen: () => !backdrop.classList.contains('hidden')
  };
  const exported = vm.runInNewContext(`(() => { ${appSource.slice(begin, end)}; function installPaletteInputEvents() { ${appSource.slice(listenerBegin, listenerEnd)} }
    return { COMMANDS, openPalette, closePalette, paletteCandidates, renderPalette, movePalette, runPaletteSelection, installPaletteInputEvents }; })()`, context);
  return { ...exported, input, results, backdrop, model, runs };
}

test('palette input exposes the complete collapsed combobox contract in actual markup', () => {
  const tag = html.match(/<input\s+[^>]*id="palette-input"[^>]*>/)?.[0] ?? '';
  assert.match(tag, /role="combobox"/);
  assert.match(tag, /aria-label="[^"]+"/);
  assert.match(tag, /aria-controls="palette-results"/);
  assert.match(tag, /aria-autocomplete="list"/);
  assert.match(tag, /aria-expanded="false"/);
  assert.match(html, /id="palette-results"[^>]*role="listbox"[^>]*aria-label="[^"]+"/);
});

test('actual renderPalette exposes exactly one selected option excluded from sequential Tab order', () => {
  const f = functionsFixture(); f.renderPalette();
  assert.equal(f.results.children.length, f.COMMANDS.length);
  const selected = f.results.children.filter((node) => node.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1);
  assert.ok(f.results.children.every((node) => node.getAttribute('tabindex') === '-1'));
  assert.ok(f.results.children.filter((node) => node !== selected[0]).every((node) => node.getAttribute('aria-selected') === 'false'));
  assert.ok(selected[0].id);
  assert.equal(f.input.getAttribute('aria-activedescendant'), selected[0].id);
  assert.equal(new Set(f.results.children.map((node) => node.id)).size, f.COMMANDS.length);
  assert.ok(f.results.children.every((node) => node.children[0].getAttribute('aria-hidden') === 'true'));
  const ids = f.results.children.map((node) => node.id);
  f.renderPalette();
  assert.deepEqual(f.results.children.map((node) => node.id), ids);
});

test('filtering clamps selection and arrows wrap while focus stays in input and selected result scrolls', () => {
  const f = functionsFixture(); f.input.focus(); f.model.paletteIndex = 2; f.input.value = 'Settings'; f.renderPalette();
  assert.equal(f.model.paletteIndex, 1);
  assert.equal(document.activeElement, f.input);
  assert.equal(f.results.children[1].scrollCount, 1);
  f.input.value = ''; f.movePalette(-1);
  assert.equal(f.model.paletteIndex, 0);
  f.model.paletteIndex = 0; f.movePalette(-1);
  assert.equal(f.model.paletteIndex, f.COMMANDS.length - 1);
  assert.equal(document.activeElement, f.input);
  assert.equal(f.input.getAttribute('aria-activedescendant'), f.results.children.at(-1).id);
  assert.equal(JSON.stringify(f.results.children.at(-1).lastScrollOptions), JSON.stringify({ block: 'nearest', inline: 'nearest', behavior: 'instant' }));
});

test('installed input listeners render Browse and move down then up without moving DOM focus', () => {
  const f = functionsFixture(); f.installPaletteInputEvents(); f.input.focus();
  f.input.value = 'Settings';
  f.input.listeners.input[0]({ type: 'input' });
  assert.equal(f.paletteCandidates()[0].id, 'navigate');
  assert.equal(f.results.children.length, 2);
  assert.equal(f.model.paletteIndex, 0);
  const down = { key: 'ArrowDown', preventDefault() { this.prevented = true; } };
  f.input.listeners.keydown[0](down);
  assert.equal(down.prevented, true);
  assert.equal(f.model.paletteIndex, 1);
  const up = { key: 'ArrowUp', preventDefault() { this.prevented = true; } };
  f.input.listeners.keydown[0](up);
  assert.equal(up.prevented, true);
  assert.equal(f.model.paletteIndex, 0);
  assert.equal(document.activeElement, f.input);
  assert.match(f.input.getAttribute('aria-activedescendant'), /^palette-option-/);
});

test('Enter and click dispatch one command and dismiss; Escape dismisses without dispatch', () => {
  const entered = functionsFixture(); entered.renderPalette(); entered.installPaletteInputEvents();
  const enterEvent = { key: 'Enter', preventDefault() { this.prevented = true; } }; entered.input.listeners.keydown[0](enterEvent);
  assert.deepEqual(entered.runs, ['browse:satnav://home']); assert.equal(enterEvent.prevented, true); assert.ok(entered.backdrop.classList.contains('hidden'));

  const clicked = functionsFixture(); clicked.renderPalette(); clicked.input.focus();
  const pointer = { preventDefault() { this.prevented = true; } }; clicked.results.children[1].listeners.mousedown[0](pointer);
  assert.equal(pointer.prevented, true); assert.equal(document.activeElement, clicked.input);
  clicked.results.children[1].listeners.click[0]();
  assert.deepEqual(clicked.runs, ['new-tab']); assert.ok(clicked.backdrop.classList.contains('hidden'));

  const escaped = functionsFixture(); escaped.installPaletteInputEvents();
  escaped.input.listeners.keydown[0]({ key: 'Escape', preventDefault() { throw new Error('Escape must not claim selection'); } });
  assert.deepEqual(escaped.runs, []); assert.ok(escaped.backdrop.classList.contains('hidden'));
  assert.equal(escaped.input.getAttribute('aria-activedescendant'), null);
  assert.equal(escaped.input.getAttribute('aria-expanded'), 'false');
});

test('open and close maintain expanded state and remove active descendant', () => {
  const f = functionsFixture(); f.openPalette();
  assert.equal(f.input.getAttribute('aria-expanded'), 'true');
  assert.ok(f.input.getAttribute('aria-activedescendant'));
  f.closePalette();
  assert.equal(f.input.getAttribute('aria-expanded'), 'false');
  assert.equal(f.input.getAttribute('aria-activedescendant'), null);
});

test('inscription gallery is reachable from the sidebar and palette without changing existing command order', () => {
  const f = functionsFixture();
  assert.deepEqual(Array.from(f.COMMANDS.slice(0, 2), item => item.id), ['home', 'new-tab']);
  f.COMMANDS.find(item => item.id === 'inscriptions').run();
  assert.deepEqual(f.runs, ['browse:satnav://inscriptions']);
  assert.match(html, /data-route="inscriptions"[^>]*aria-label="Explore inscriptions"/);
  assert.match(html, /href="\.\/inscriptions.css"/);
});

test('Ask Bitcoin palette entry resumes the workspace instead of navigating a result tab into a new chat', () => {
  const f = functionsFixture();
  f.COMMANDS.find(item => item.id === 'ai').run();
  assert.deepEqual(f.runs, ['resume-ai-workspace']);
});

test('About is discoverable by product or creator and reachable from the compact sidebar and palette', () => {
  const f = functionsFixture();
  for (const query of ['about', 'Bitcoin Browser', 'Turtle Moon']) {
    f.input.value = query;
    assert.ok(f.paletteCandidates().some(item => item.id === 'about'), query);
  }
  f.COMMANDS.find(item => item.id === 'about').run();
  assert.deepEqual(f.runs, ['browse:satnav://about']);
  assert.deepEqual(Array.from(f.COMMANDS.slice(0, 2), item => item.id), ['home', 'new-tab']);
  assert.match(html, /data-route="about"[^>]*aria-label="About Bitcoin Browser"[^>]*title="About Bitcoin Browser"/);
});

test('Sponsors is searchable by sponsor, partner name or inquiry and has an accessible sidebar entry', () => {
  const f = functionsFixture();
  for (const query of ['sponsor', 'HOL.org', 'Sponsorship', 'inquiries']) {
    f.input.value = query;
    assert.ok(f.paletteCandidates().some(item => item.id === 'sponsors'), query);
  }
  f.COMMANDS.find(item => item.id === 'sponsors').run();
  assert.deepEqual(f.runs, ['browse:satnav://sponsors']);
  assert.match(html, /data-route="sponsors"[^>]*aria-label="Sponsors and sponsorship inquiries"[^>]*title="Sponsors"/);
  assert.match(html, /data-route="sponsors"[^>]*><span class="side-icon" aria-hidden="true"/);
});
