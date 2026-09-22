import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const domSource = fs.readFileSync(new URL('../src/renderer/dom.js', import.meta.url), 'utf8');

function extract(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} boundary`);
  return source.slice(from, to);
}

class FakeNode {
  constructor(tag = '#text', text = '') {
    this.tagName = tag === '#text' ? undefined : tag.toUpperCase();
    this.textContent = text;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
  }
  append(...nodes) {
    this.children.push(...nodes);
    if (this.tagName === 'SELECT') {
      const explicitlySelected = nodes.find((node) => node.selected);
      const selected = explicitlySelected ?? (!this.value ? nodes.find((node) => node.tagName === 'OPTION') : null);
      if (selected) this.value = selected.value;
    }
  }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'type') this.type = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      if (node !== this && matches(node, selector)) found.push(node);
      for (const child of node.children ?? []) visit(child);
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function matches(node, selector) {
  if (!node.tagName) return false;
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  if (selector === 'input, select, textarea') return ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName);
  if (selector === 'label') return node.tagName === 'LABEL';
  if (selector === '[role="group"]') return node.getAttribute('role') === 'group';
  if (selector === '[data-capability]') return Object.hasOwn(node.dataset, 'capability');
  return node.tagName === selector.toUpperCase();
}

function textOf(node) { return node.tagName ? node.children.map(textOf).join('') : node.textContent; }

function fixture() {
  const occupiedIds = new Set();
  const document = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (value) => new FakeNode('#text', String(value)),
    createDocumentFragment: () => new FakeNode('fragment'),
    getElementById: (id) => occupiedIds.has(id) ? { id } : null
  };
  const dom = vm.runInNewContext(`(() => {
    ${domSource.replaceAll('export ', '')}
    return { h, clear, button };
  })()`, { document, Node: FakeNode, Intl, Date, BigInt, Set });
  let shown;
  const scope = {
    ...dom, document,
    providerOutcomeRecovery: null, providerSnapshotPending: false, pendingProviderMutations: new Map(),
    state: () => ({ settings: { network: 'mainnet' } }),
    showModal: (...children) => { shown = new FakeNode('div'); shown.append(...children); return 1; },
    modalHeader: (title, subtitle) => dom.h('header', {}, title, subtitle),
    closeModal() {}, confirmProviderRemoval() {}, confirmServiceRemoval() {},
    providerCapabilitiesFor: (type) => ({ 'ord-server': ['inscription', 'satpoint'], mempool: ['block'], 'bitcoin-core': ['block'], mock: ['block', 'inscription'] })[type] ?? [],
    defaultProviderCapabilitiesFor: (type) => ({ 'ord-server': ['inscription'], mempool: ['block'], 'bitcoin-core': ['block'], mock: ['block'] })[type] ?? [],
    PROVIDER_CAPABILITIES: ['block', 'inscription', 'satpoint'],
    api: {}, patch() {}, toast() {}, queueAuthorityMutation() {}, reloadResolvableTarget() {}
  };
  const actions = vm.runInNewContext(`(() => {
    ${extract(appSource, 'let formFieldSequence = 0;', '\nconst ALL_PROVIDER_CAPABILITIES')}
    const ALL_PROVIDER_CAPABILITIES = PROVIDER_CAPABILITIES;
    ${extract(appSource, 'function capabilitiesFor(', '\nfunction confirmProviderRemoval(')}
    ${extract(appSource, 'function openServiceModal(', '\nfunction confirmServiceRemoval(')}
    return { formField, inputField, checkbox, openProviderModal, openServiceModal };
  })()`, scope);
  return { ...actions, dom, shown: () => shown, occupy: (id) => occupiedIds.add(id) };
}

function assertAssociatedFields(root, expectedCount) {
  const fields = root.querySelectorAll('input, select, textarea').filter((node) => node.getAttribute('type') !== 'checkbox');
  assert.equal(fields.length, expectedCount);
  const labels = root.querySelectorAll('label');
  for (const control of fields) {
    assert.ok(control.id, `${control.tagName} has an id`);
    assert.equal(labels.filter((label) => label.htmlFor === control.id || label.getAttribute('for') === control.id).length, 1);
  }
}

test('formField binds a caption and help text to an input while preserving caller IDs and describedby tokens', () => {
  const f = fixture();
  const control = f.inputField('value', { id: 'caller-id', 'aria-describedby': 'existing' });
  const field = f.formField('Name', control, { help: 'Helpful copy' });
  const label = field.querySelector('label');
  const help = field.querySelector('.help');
  assert.equal(control.id, 'caller-id');
  assert.equal(label.htmlFor || label.getAttribute('for'), 'caller-id');
  assert.ok(help.id);
  assert.deepEqual(control.getAttribute('aria-describedby').split(/\s+/).sort(), ['existing', help.id].sort());
});

test('provider modal associates all nine scalar controls and exposes named capability and status groups', () => {
  const f = fixture();
  f.openProviderModal();
  const root = f.shown();
  assertAssociatedFields(root, 9);
  const groups = root.querySelectorAll('[role="group"]');
  assert.equal(groups.length, 2);
  for (const group of groups) {
    const captionId = group.getAttribute('aria-labelledby');
    assert.ok(captionId);
    const caption = root.querySelectorAll('.form-field-label').find((node) => node.id === captionId);
    assert.ok(caption);
    assert.ok(['Capabilities', 'Status'].includes(textOf(caption)));
    assert.equal(caption.tagName, 'SPAN');
  }
  assert.equal(root.querySelectorAll('[data-capability]').length, 2, 'dynamic Ord capability controls rendered');
});

test('service modal associates inputs and textarea and names Status and Launch behavior groups', () => {
  const f = fixture();
  f.openServiceModal({ id: 'svc', name: 'Service', executable: '/bin/true', cwd: '/tmp', args: ['server'], enabled: true, autoStart: false });
  const root = f.shown();
  assertAssociatedFields(root, 5);
  assert.equal(root.querySelectorAll('textarea').length, 1);
  const groups = root.querySelectorAll('[role="group"]');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => {
    const captionId = group.getAttribute('aria-labelledby');
    return textOf(root.querySelectorAll('.form-field-label').find((caption) => caption.id === captionId));
  }), ['Status', 'Launch behavior']);
  assert.equal(root.querySelector('input').disabled, true, 'editing preserves disabled identifier');
});

test('generated field IDs are unique across repeated forms and checkbox text names each control', () => {
  const f = fixture();
  f.openProviderModal();
  const firstRoot = f.shown();
  const first = [...firstRoot.querySelectorAll('input, select, textarea').filter((node) => node.type !== 'checkbox').map((node) => node.id),
    ...firstRoot.querySelectorAll('.form-field-label').map((node) => node.id).filter(Boolean), ...firstRoot.querySelectorAll('.help').map((node) => node.id)];
  f.openProviderModal();
  const secondRoot = f.shown();
  const second = [...secondRoot.querySelectorAll('input, select, textarea').filter((node) => node.type !== 'checkbox').map((node) => node.id),
    ...secondRoot.querySelectorAll('.form-field-label').map((node) => node.id).filter(Boolean), ...secondRoot.querySelectorAll('.help').map((node) => node.id)];
  assert.equal(new Set([...first, ...second]).size, first.length + second.length);
  for (const checkbox of secondRoot.querySelectorAll('input').filter((node) => node.getAttribute('type') === 'checkbox')) {
    const owner = secondRoot.querySelectorAll('label').find((label) => label.children.includes(checkbox));
    assert.ok(owner && textOf(owner).trim(), 'checkbox has a visible accessible name');
  }
});

test('group help describes the group and existing scalar description tokens are deduplicated', () => {
  const f = fixture();
  const scalar = f.inputField('', { id: 'fixed', 'aria-describedby': 'existing existing' });
  const scalarField = f.formField('Scalar', scalar, { help: 'Scalar help' });
  assert.deepEqual(scalar.getAttribute('aria-describedby').split(/\s+/), ['existing', scalarField.querySelector('.help').id]);
  assert.equal(textOf(scalarField.querySelector('.help')), 'Scalar help');
  const groupContent = f.checkbox('Choice', true);
  const group = f.formField('Choices', groupContent, { help: 'Group help' });
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-describedby'), group.querySelector('.help').id);
  assert.equal(textOf(group.querySelector('.help')), 'Group help');
  assert.equal(groupContent.getAttribute('aria-describedby'), null);
});

test('textarea help resolves to displayed text and a no-help field preserves existing descriptions', () => {
  const f = fixture();
  const textarea = f.dom.h('textarea', { 'aria-describedby': 'prior' });
  const field = f.formField('Arguments', textarea, { help: 'One argument per line.' });
  const help = field.querySelector('.help');
  assert.equal(textOf(help), 'One argument per line.');
  assert.deepEqual(textarea.getAttribute('aria-describedby').split(/\s+/), ['prior', help.id]);
  const noHelp = f.inputField('', { 'aria-describedby': 'external-description' });
  const noHelpField = f.formField('No help', noHelp);
  assert.equal(noHelp.getAttribute('aria-describedby'), 'external-description');
  assert.equal(noHelpField.querySelector('.help'), null);
});

test('a disconnected caller ID matching the next generated value is reserved from help IDs', () => {
  const f = fixture();
  const control = f.inputField('', { id: 'form-field-1' });
  const field = f.formField('Reserved', control, { help: 'Description' });
  assert.equal(control.id, 'form-field-1');
  assert.notEqual(field.querySelector('.help').id, control.id);
  assert.equal(field.querySelector('label').htmlFor, control.id);
});

test('generated IDs avoid document collisions and preserve dynamic disabled fields', () => {
  const f = fixture();
  f.occupy('form-field-1');
  const field = f.formField('Colliding field', f.inputField());
  assert.notEqual(field.querySelector('input').id, 'form-field-1');
  f.openProviderModal({ id: 'core', name: 'Core', type: 'bitcoin-core', network: 'mainnet', baseUrl: 'http://127.0.0.1:8332', priority: 1, cookieFile: '', enabled: true, capabilities: ['block'] });
  const controls = f.shown().querySelectorAll('input, select, textarea');
  assert.equal(controls[0].disabled, true, 'editing identifier remains disabled');
  const base = controls.find((control) => control.getAttribute('placeholder') === 'http://127.0.0.1:80');
  const cookie = controls.find((control) => control.getAttribute('placeholder') === '/absolute/path/to/.cookie');
  const type = controls.find((control) => control.tagName === 'SELECT');
  assert.equal(base.disabled, false);
  assert.equal(cookie.disabled, false);
  type.value = 'mock';
  type.listeners.change();
  assert.equal(base.disabled, true, 'mock dynamically disables Base URL');
  assert.equal(cookie.disabled, true, 'non-Core adapter dynamically disables cookie file');
  assert.equal(f.shown().querySelectorAll('[data-capability]').length, 2);
});
