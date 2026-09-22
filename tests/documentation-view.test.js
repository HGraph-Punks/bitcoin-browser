import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.style = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { this.listeners.get('click')?.({ currentTarget: this }); }
  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (!(child instanceof FakeNode)) continue;
      if (selector === 'button' && child.tagName === 'BUTTON') matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
}

class FakeText extends FakeNode {
  constructor(value) { super('#text'); this.textContent = String(value); }
}

globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (value) => new FakeText(value),
  createDocumentFragment: () => new FakeNode('#fragment')
};

const { renderAbout, renderDocumentation } = await import('../src/renderer/views.js');

function text(node) {
  return node instanceof FakeNode ? `${node.textContent}${node.children.map(text).join('')}` : '';
}

function buttonByLabel(root, label) {
  const hasExactStrong = (node) => node.children.some((child) => child instanceof FakeNode
    && ((child.tagName === 'STRONG' && text(child) === label) || hasExactStrong(child)));
  return root.querySelectorAll('button').find((node) => text(node) === label || hasExactStrong(node));
}

function descendants(root) {
  return [root, ...root.children.filter((child) => child instanceof FakeNode).flatMap(descendants)];
}

function model(settings = {}) {
  return {
    settings: { network: 'mainnet', localOnly: false, offlineMode: false, ...settings },
    bootstrap: {
      application: { version: '1.0.0-rc.1', platform: 'test', arch: 'arm64', packaged: true },
      state: { schemaVersion: 3 }, secureStorageAvailable: true
    }
  };
}

test('documentation rendering is offline and invokes no navigation, prefill, or privileged API', () => {
  const calls = [];
  const ctx = new Proxy({
    navigate: (target) => calls.push(['navigate', target]),
    prefill: (target) => calls.push(['prefill', target])
  }, { get(target, key) { return key in target ? target[key] : () => calls.push([String(key)]); } });
  const root = renderDocumentation(model({ localOnly: true, offlineMode: true }), ctx);
  assert.deepEqual(calls, []);
  const content = text(root);
  for (const expected of [
    'No Bitcoin node is required', 'sat:0', 'block:840000', '/r/blockheight',
    'instead of silently guessing', 'not a machine-wide firewall', 'cache-only', 'separate network session',
    'cannot sign PSBTs or messages', 'private key or seed phrase', 'signing requests are not sent', 'Inspect the saved file before sharing',
    'restore its backup', 'does not invent a support contact', 'guided lookup', 'History and bookmarks',
    'Refresh results', 'Search phrases may be saved in local history', 'Global keyword search is not available', 'Content-type filters apply to the current page',
    'Recover a source', 'Cookie files and source configuration are preserved', 'Refresh source state never resubmits recovery'
  ]) assert.match(content, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(content, /LOCAL ONLY/);
  assert.match(content, /OFFLINE/);
});

test('documentation contains no remote, embedded, executable, or raw-HTML element authority', () => {
  const root = renderDocumentation(model(), { navigate() {}, prefill() {} });
  for (const node of descendants(root)) {
    assert.ok(!['A', 'IFRAME', 'SCRIPT', 'OBJECT', 'EMBED'].includes(node.tagName), `unexpected ${node.tagName}`);
    for (const name of ['href', 'src', 'srcdoc', 'innerHTML']) assert.equal(node.attributes.has(name), false, `${node.tagName} ${name}`);
  }
});

test('documentation controls map to exact internal routes and example actions', () => {
  const actions = [];
  const root = renderDocumentation(model(), {
    navigate: (target) => actions.push(['navigate', target]),
    prefill: (target) => actions.push(['prefill', target])
  });
  const labels = ['Home', 'About', 'Data sources', 'Local node', 'Genesis sat', 'Block height', 'Recursive endpoint', 'Open Home', 'Network settings', 'Wallet', 'Settings', 'About this build'];
  for (const label of labels) {
    const control = buttonByLabel(root, label);
    assert.ok(control, `missing ${label}`);
    control.click();
  }
  assert.deepEqual(actions, [
    ['navigate', 'satnav://home'], ['navigate', 'satnav://about'],
    ['navigate', 'satnav://providers'], ['navigate', 'satnav://services'],
    ['navigate', 'sat:0'], ['navigate', 'block:840000'], ['prefill', '/r/blockheight'],
    ['navigate', 'satnav://home'], ['navigate', 'satnav://settings'],
    ['navigate', 'satnav://wallet'], ['navigate', 'satnav://settings'], ['navigate', 'satnav://about']
  ]);
});

test('About preserves build and privacy content and links to Documentation without eager action', () => {
  const actions = [];
  const root = renderAbout(model(), {
    navigate: (target) => actions.push(target), exportDiagnostics() {}, revealPath() {}
  });
  assert.deepEqual(actions, []);
  const content = text(root);
  assert.match(content, /1\.0\.0-rc\.1/);
  assert.match(content, /Inscription frames are untrusted opaque sandboxes/);
  assert.match(content, /Analytics are absent/);
  buttonByLabel(root, 'Documentation').click();
  assert.deepEqual(actions, ['satnav://documentation']);
});
