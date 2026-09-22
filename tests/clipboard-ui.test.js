import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const copyBegin = appSource.indexOf('const MAX_CLIPBOARD_TEXT_LENGTH');
const copyEnd = appSource.indexOf('\n\nconst context =', copyBegin);
assert.ok(copyBegin >= 0 && copyEnd > copyBegin);

function copyFixture(copyImplementation) {
  const calls = [];
  const copy = vm.runInNewContext(`(() => { ${appSource.slice(copyBegin, copyEnd)}; return copyToClipboard; })()`, {
    copyText: async (value) => { calls.push(['copy', value]); return copyImplementation(value); },
    toast: (...args) => calls.push(['toast', ...args])
  });
  return { copy, calls };
}

test('canonical and account strings copy with bounded accessible success feedback', async () => {
  const fixture = copyFixture(() => true);
  assert.equal(await fixture.copy('address:bc1qfixtureaccount'), true);
  assert.deepEqual(fixture.calls, [
    ['copy', 'address:bc1qfixtureaccount'],
    ['toast', 'Copied', 'address:bc1qfixtureaccount', 'success']
  ]);
  assert.equal(await fixture.copy('bc1qfixtureaccount'), true);
});

test('clipboard denial and thrown fallback failure always resolve false with feedback', async () => {
  const denied = copyFixture(() => false);
  assert.equal(await denied.copy('block:840000'), false);
  assert.deepEqual(denied.calls.at(-1), ['toast', 'Copy failed', 'Clipboard access was unavailable.', 'error']);

  const failed = copyFixture(() => { throw new Error('mocked clipboard unavailable'); });
  assert.equal(await failed.copy('block:840000'), false);
  assert.deepEqual(failed.calls.at(-1), ['toast', 'Copy failed', 'Clipboard access was unavailable.', 'error']);
});

test('invalid, empty, and oversized values never reach the clipboard', async () => {
  const fixture = copyFixture(() => true);
  for (const value of [null, {}, '', 'x'.repeat(1024 * 1024 + 1)]) {
    assert.equal(await fixture.copy(value), false);
  }
  assert.equal(fixture.calls.some(([name]) => name === 'copy'), false);
  assert.equal(fixture.calls.filter(([name]) => name === 'toast').length, 4);
});

function realCopyTextFixture({ api = 'reject', exec = true, selectThrows = false, moveFocus = false } = {}) {
  const domSource = fs.readFileSync(new URL('../src/renderer/dom.js', import.meta.url), 'utf8');
  const begin = domSource.indexOf('export async function copyText(');
  const end = domSource.indexOf('\n\nexport function safeJson(', begin);
  const previous = {
    isConnected: true, selectionStart: 2, selectionEnd: 5, selectionDirection: 'forward', focusCalls: [], selectionCalls: [],
    focus(options) { this.focusCalls.push(options); document.activeElement = this; },
    setSelectionRange(...args) { this.selectionCalls.push(args); }
  };
  const unrelated = { isConnected: true };
  const textarea = {
    selectCalls: 0, removed: false,
    select() { this.selectCalls += 1; document.activeElement = this; if (selectThrows) throw new Error('select failed'); },
    remove() { this.removed = true; }
  };
  const body = { appended: null, append(node) { this.appended = node; } };
  const document = {
    activeElement: previous, body,
    execCommand(command) {
      assert.equal(command, 'copy');
      if (moveFocus) this.activeElement = unrelated;
      if (exec instanceof Error) throw exec;
      return exec;
    }
  };
  const hCalls = [];
  const copyText = vm.runInNewContext(`(${domSource.slice(begin, end).replace('export async function copyText', 'async function')})`, {
    navigator: { clipboard: { writeText: async () => { if (api === 'reject') throw new Error('mocked denial'); return undefined; } } },
    document,
    h: (...args) => { hCalls.push(args); return textarea; }
  });
  return { copyText, textarea, previous, unrelated, document, body, hCalls };
}

test('real copyText API success never creates a fallback textarea', async () => {
  const fixture = realCopyTextFixture({ api: 'success' });
  assert.equal(await fixture.copyText('canonical:value'), true);
  assert.equal(fixture.hCalls.length, 0);
  assert.equal(fixture.body.appended, null);
});

test('real copyText fallback carries exact value/options and restores focus and selection', async () => {
  const fixture = realCopyTextFixture();
  assert.equal(await fixture.copyText('canonical:value'), true);
  assert.equal(fixture.hCalls[0][0], 'textarea');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.hCalls[0][1])), {
    value: 'canonical:value', style: { position: 'fixed', opacity: '0', pointerEvents: 'none' }
  });
  assert.equal(fixture.textarea.removed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.previous.focusCalls)), [{ preventScroll: true }]);
  assert.deepEqual(fixture.previous.selectionCalls, [[2, 5, 'forward']]);
});

test('real copyText normalizes false and thrown fallback failures with guaranteed cleanup', async () => {
  for (const options of [{ exec: false }, { exec: new Error('copy failed') }, { selectThrows: true }]) {
    const fixture = realCopyTextFixture(options);
    assert.equal(await fixture.copyText('canonical:value'), false);
    assert.equal(fixture.textarea.removed, true);
  }
});

test('fallback does not steal focus back after a synchronous handler moves it', async () => {
  const fixture = realCopyTextFixture({ moveFocus: true });
  assert.equal(await fixture.copyText('canonical:value'), true);
  assert.equal(fixture.document.activeElement, fixture.unrelated);
  assert.deepEqual(fixture.previous.focusCalls, []);
});

test('copy feedback toast is emitted as an accessible status', () => {
  const begin = appSource.indexOf('function toast(');
  const end = appSource.indexOf('\n\nfunction applyTheme(', begin);
  const created = [];
  const node = { addEventListener() {}, remove() {} };
  const toast = vm.runInNewContext(`(${appSource.slice(begin, end)})`, {
    h: (...args) => { created.push(args); return node; },
    elements: { toasts: { append(value) { assert.equal(value, node); } } },
    setTimeout: () => 1,
    clearTimeout() {}
  });
  toast('Copied', 'canonical:value', 'success');
  assert.equal(created.at(-1)[0], 'div');
  assert.equal(created.at(-1)[1].role, 'status');
});
