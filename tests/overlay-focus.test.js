import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');

function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} boundary`);
  return source.slice(from, to);
}

class FakeNode {
  constructor(name, options = {}) {
    this.name = name;
    this.hidden = Boolean(options.hidden);
    this.disabled = Boolean(options.disabled);
    this.tabIndex = options.tabIndex ?? 0;
    this.isConnected = options.isConnected ?? true;
    this.inert = Boolean(options.inert);
    this.isContentEditable = Boolean(options.isContentEditable);
    this.children = [];
    this.parentElement = null;
    this.controls = [];
    this.attributes = new Map();
    this.classes = new Set(options.classes ?? []);
    this.selectorMap = new Map();
    this.classList = {
      contains: (value) => this.classes.has(value),
      add: (value) => this.classes.add(value),
      remove: (value) => this.classes.delete(value)
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) { return selector === ':disabled' ? this.disabled : false; }
  closest() {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.inert || node.classes.has('hidden') || node.getAttribute('aria-hidden') === 'true') return node;
    }
    return null;
  }
  getClientRects() { return this.hidden || !this.isConnected ? [] : [{}]; }
  focus() { document.focusLog.push(this.name); document.activeElement = this; }
  contains(node) { return node === this || this.controls.includes(node) || this.children.some((child) => child.contains?.(node)); }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  querySelectorAll() { return this.controls.filter((node) => node.isConnected && !node.disabled); }
  querySelector(selector) { return this.selectorMap.get(selector) ?? this.controls.find((node) => node.isConnected) ?? null; }
}

let document;

function fixture() {
  const timers = [];
  document = { activeElement: null, focusLog: [] };
  const paletteContainer = new FakeNode('palette-container');
  const elements = {
    app: new FakeNode('app'),
    modal: new FakeNode('modal'),
    'modal-backdrop': new FakeNode('modal-backdrop', { classes: ['hidden'] }),
    'palette-backdrop': new FakeNode('palette-backdrop', { classes: ['hidden'] }),
    'palette-input': new FakeNode('palette-input'),
    omnibox: new FakeNode('omnibox'),
    'main-stage': new FakeNode('main-stage')
  };
  elements['modal-backdrop'].append(elements.modal);
  paletteContainer.controls = [elements['palette-input']];
  elements['palette-input'].parentElement = paletteContainer;
  elements['palette-backdrop'].append(paletteContainer);
  elements.app.append(elements.omnibox, elements['main-stage']);
  elements['palette-backdrop'].selectorMap.set('.command-palette', paletteContainer);
  const clear = (container, children = []) => {
    for (const child of container.controls) child.isConnected = false;
    container.children = Array.isArray(children) ? children : [children];
    container.controls = container.children.flat(Infinity).filter((node) => node instanceof FakeNode);
    for (const child of container.controls) { child.isConnected = true; child.parentElement = container; }
  };
  const setTimeout = (callback) => {
    const timer = { callback, cancelled: false };
    timers.push(timer);
    return timer;
  };
  const clearTimeout = (timer) => { if (timer) timer.cancelled = true; };
  const scope = { elements, document, clear, setTimeout, clearTimeout, renderPalette() {} };
  const actions = vm.runInNewContext(`(() => {
    let modalGeneration = 0;
    let overlayReturnFocus = null;
    let overlayFocusGeneration = 0;
    ${extract('function overlayOpen(', '\nfunction formField(')}
    ${extract('function openPalette(', '\nfunction paletteCandidates(')}
    return { focusableElements, trapFocus, showModal, closeModal, openPalette, closePalette,
      modalGeneration: () => modalGeneration };
  })()`, scope);
  return {
    ...actions, elements, document,
    node(name, options = {}) {
      const node = new FakeNode(name, options);
      (options.parent ?? elements.app).append(node);
      return node;
    },
    flush() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback();
    }
  };
}

function tabEvent(shiftKey = false) {
  return { key: 'Tab', shiftKey, prevented: 0, preventDefault() { this.prevented += 1; } };
}

test('an immediate modal close invalidates its open-focus timer and restores the shell target', () => {
  const f = fixture();
  const shell = f.node('shell');
  const control = f.node('modal-control');
  shell.focus();
  f.document.focusLog.length = 0;
  const generation = f.showModal(control);
  f.closeModal();
  assert.ok(f.modalGeneration() > generation, 'close invalidates provider modal ownership');
  f.flush();
  assert.equal(f.document.activeElement, shell);
  assert.deepEqual(f.document.focusLog, ['shell']);
  assert.equal(control.isConnected, false);
  assert.equal(f.elements.app.inert, false);
});

test('close then reopen cannot let stale close/open timers steal focus from the replacement modal', () => {
  const f = fixture();
  const shell = f.node('shell');
  const first = f.node('first');
  const replacement = f.node('replacement');
  shell.focus();
  f.document.focusLog.length = 0;
  const firstGeneration = f.showModal(first);
  f.closeModal();
  const replacementGeneration = f.showModal(replacement);
  assert.ok(replacementGeneration > firstGeneration);
  f.flush();
  assert.equal(f.document.activeElement, replacement);
  assert.deepEqual(f.document.focusLog, ['replacement']);
  assert.equal(first.isConnected, false);
  assert.equal(f.elements['modal-backdrop'].classList.contains('hidden'), false);
  assert.equal(f.elements.app.inert, true);
});

test('modal and palette transfer preserve the original shell return target', () => {
  const f = fixture();
  const shell = f.node('shell');
  const modalControl = f.node('modal-control');
  shell.focus();
  f.document.focusLog.length = 0;
  f.showModal(modalControl);
  f.flush();
  assert.equal(f.document.activeElement, modalControl);
  f.openPalette();
  f.flush();
  assert.equal(f.document.activeElement, f.elements['palette-input']);
  f.closePalette();
  f.flush();
  assert.equal(f.document.activeElement, shell);
  assert.equal(f.elements.app.inert, false);
});

test('palette and modal transfer preserve the original shell return target', () => {
  const f = fixture();
  const shell = f.node('shell');
  const modalControl = f.node('modal-control');
  shell.focus();
  f.openPalette();
  f.flush();
  assert.equal(f.document.activeElement, f.elements['palette-input']);
  f.showModal(modalControl);
  f.flush();
  assert.equal(f.document.activeElement, modalControl);
  f.closeModal();
  f.flush();
  assert.equal(f.document.activeElement, shell);
  assert.equal(f.elements.app.inert, false);
});

test('a detached return target falls back to the connected shell omnibox', () => {
  const f = fixture();
  const removed = f.node('removed');
  removed.focus();
  f.openPalette();
  f.flush();
  f.closePalette();
  removed.isConnected = false;
  f.flush();
  assert.equal(f.document.activeElement, f.elements.omnibox);
});

test('closing an overlay does not steal deliberate focus newly placed in the shell', () => {
  const f = fixture();
  const opener = f.node('opener');
  const next = f.node('next');
  opener.focus();
  f.openPalette();
  f.flush();
  f.closePalette();
  next.focus();
  f.flush();
  assert.equal(f.document.activeElement, next);
});

test('a return target hidden or inert through an ancestor falls back to the shell omnibox', () => {
  for (const state of ['hidden', 'inert']) {
    const f = fixture();
    const wrapper = f.node(`wrapper-${state}`);
    const opener = f.node(`opener-${state}`, { parent: wrapper });
    opener.focus();
    f.openPalette();
    f.flush();
    f.closePalette();
    wrapper[state] = true;
    f.flush();
    assert.equal(f.document.activeElement, f.elements.omnibox, state);
  }
});

test('focus deliberately placed inside a modal before its timer is preserved', () => {
  const f = fixture();
  const first = f.node('first');
  const chosen = f.node('chosen');
  f.showModal(first, chosen);
  chosen.focus();
  f.document.focusLog.length = 0;
  f.flush();
  assert.equal(f.document.activeElement, chosen);
  assert.deepEqual(f.document.focusLog, []);
});

test('modal replacement retains the first shell owner and focuses only the latest controls', () => {
  const f = fixture();
  const shell = f.node('shell');
  const first = f.node('first');
  const second = f.node('second');
  shell.focus();
  f.document.focusLog.length = 0;
  const firstGeneration = f.showModal(first);
  const secondGeneration = f.showModal(second);
  assert.ok(secondGeneration > firstGeneration);
  f.flush();
  assert.equal(f.document.activeElement, second);
  assert.deepEqual(f.document.focusLog, ['second']);
  f.closeModal();
  f.flush();
  assert.equal(f.document.activeElement, shell);
});

test('an immediate palette close invalidates its open-focus timer and restores the shell target', () => {
  const f = fixture();
  const shell = f.node('shell');
  shell.focus();
  f.document.focusLog.length = 0;
  f.openPalette();
  f.closePalette();
  f.flush();
  assert.equal(f.document.activeElement, shell);
  assert.deepEqual(f.document.focusLog, ['shell']);
  assert.equal(f.elements.app.inert, false);
});

test('focusableElements excludes negative tabindex, hidden, aria-hidden, detached, disabled and inert controls', () => {
  const f = fixture();
  const accepted = f.node('accepted');
  const negative = f.node('negative', { tabIndex: -2 });
  const hidden = f.node('hidden', { hidden: true });
  const ariaHidden = f.node('aria-hidden'); ariaHidden.setAttribute('aria-hidden', 'true');
  const detached = f.node('detached', { isConnected: false });
  const disabled = f.node('disabled', { disabled: true });
  const inert = f.node('inert', { inert: true });
  f.elements.modal.controls = [accepted, negative, hidden, ariaHidden, detached, disabled, inert];
  const focusable = f.focusableElements(f.elements.modal);
  assert.equal(focusable.length, 1);
  assert.equal(focusable[0], accepted);
});

test('trapFocus contains Tab from the container or outside and wraps both directions', () => {
  const f = fixture();
  const first = f.node('first');
  const last = f.node('last');
  const outside = f.node('outside');
  f.elements.modal.controls = [first, last];
  for (const [active, shift, expected] of [
    [f.elements.modal, false, first], [outside, false, first],
    [f.elements.modal, true, last], [outside, true, last],
    [last, false, first], [first, true, last]
  ]) {
    active.focus();
    const event = tabEvent(shift);
    f.trapFocus(event, f.elements.modal);
    assert.equal(event.prevented, 1);
    assert.equal(f.document.activeElement, expected);
  }
});

test('trapFocus falls back to the overlay container when it has no sequential controls', () => {
  const f = fixture();
  const outside = f.node('outside');
  outside.focus();
  const event = tabEvent();
  f.trapFocus(event, f.elements.modal);
  assert.equal(event.prevented, 1);
  assert.equal(f.document.activeElement, f.elements.modal);
});
