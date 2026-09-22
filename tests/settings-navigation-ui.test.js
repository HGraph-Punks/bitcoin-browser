import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/renderer/views.js', import.meta.url), 'utf8');
const begin = source.indexOf('function settingRow(');
const end = source.indexOf('\nexport function renderWallet(', begin);
assert.ok(begin >= 0 && end > begin);
const cacheStart = source.indexOf('function cacheDisplayValue(');
const cacheEnd = source.indexOf('\nexport function updateCacheViews(', cacheStart);
assert.ok(cacheStart >= 0 && cacheEnd > cacheStart);

// Real view and handlers, with a deliberately small DOM collaborator. Actual
// keyboard defaults, layout and media emulation are packaged checks, not this VM.
function fixture() {
  const calls = [];
  let reduced = false;
  let focused;
  const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat(Infinity) });
  const render = vm.runInNewContext(`(() => {
    ${source.slice(cacheStart, cacheEnd)}
    ${source.slice(begin, end).replace('export function renderSettings', 'function renderSettings')}
    return renderSettings;
  })()`, {
    h, button: (label) => h('button', {}, label), pageHeader: () => h('header'),
    toggleControl: () => h('button'), badge: () => h('span'), formatBytes: () => '0 B',
    window: { matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return { matches: reduced }; } }
  });
  const tree = render({ settings: {} }, {});
  const all = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    all.push(node);
    node.children.forEach(visit);
  }
  visit(tree);
  const layout = all.find((node) => node.attrs.className === 'settings-layout');
  const nav = all.find((node) => node.attrs.className === 'settings-nav');
  const sections = all.filter((node) => node.tag === 'section');
  layout.isConnected = true;
  layout.querySelectorAll = (selector) => { assert.equal(selector, '.settings-group'); return sections; };
  for (const section of sections) {
    section.id = section.attrs.id;
    const heading = section.children[0].children[0];
    heading.focus = (options) => { calls.push(['focus', heading.attrs.id, { ...options }]); focused = heading; };
    section.querySelector = (selector) => { assert.equal(selector, 'h2'); return heading; };
    section.scrollIntoView = (options) => calls.push(['scroll', section.id, { ...options }]);
  }
  for (const control of nav.children) {
    control.closest = (selector) => { assert.equal(selector, '.settings-layout'); return layout; };
    control.getAttribute = (name) => control.attrs[name];
  }
  return { calls, nav, sections, layout, setReduced(value) { reduced = value; },
    focused: () => focused, click(index) { const control = nav.children[index]; control.attrs.onClick({ currentTarget: control }); } };
}

test('all five Settings navigation controls identify a named destination with a programmatically focusable heading', () => {
  const f = fixture();
  assert.equal(f.nav.attrs.ariaLabel, 'Settings sections');
  assert.deepEqual(f.nav.children.map((node) => node.children[0]), ['General', 'Privacy', 'Recursion', 'Storage', 'Developer']);
  assert.equal(f.sections.length, 5);
  f.nav.children.forEach((node, index) => {
    assert.equal(node.attrs.type, 'button');
    assert.notEqual(node.attrs.className, 'active', 'no permanently highlighted General button');
    assert.equal(node.attrs['aria-controls'], f.sections[index].attrs.id);
    const heading = f.sections[index].children[0].children[0];
    assert.equal(f.sections[index].attrs['aria-labelledby'], heading.attrs.id);
    assert.equal(heading.attrs.tabindex, -1, 'heading must not add an extra normal tab stop');
  });
});

test('each Settings action focuses its own heading before scrolling the exact target', () => {
  const f = fixture();
  for (let index = 0; index < 5; index += 1) {
    f.click(index);
    assert.deepEqual(f.calls.slice(-2), [
      ['focus', `${f.sections[index].id}-heading`, { preventScroll: true }],
      ['scroll', f.sections[index].id, { behavior: 'smooth', block: 'start' }]
    ]);
  }
});

test('Settings navigation rechecks reduced motion at each activation without rerendering', () => {
  const f = fixture();
  f.setReduced(true);
  f.click(4);
  assert.equal(f.calls.at(-1)[2].behavior, 'instant');
  f.setReduced(false);
  f.click(1);
  assert.equal(f.calls.at(-1)[2].behavior, 'smooth');
  f.setReduced(true);
  f.click(0);
  assert.equal(f.calls.at(-1)[2].behavior, 'instant');
});

test('detached Settings controls cannot focus a replacement view with identical IDs', () => {
  const f = fixture();
  f.layout.isConnected = false;
  f.click(4);
  assert.deepEqual(f.calls, []);
  assert.equal(f.focused(), undefined);
});

test('missing Settings section or heading does not scroll or steal focus', () => {
  for (const missing of ['section', 'heading']) {
    const f = fixture();
    if (missing === 'section') f.sections.splice(4, 1);
    else f.sections[4].querySelector = () => null;
    f.click(4);
    assert.deepEqual(f.calls, []);
  }
});
