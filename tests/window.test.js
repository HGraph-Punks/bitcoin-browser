import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let source = fs.readFileSync(new URL('../src/main/window.js', import.meta.url), 'utf8');
source = source.replace(/^import .*;\n/gm, '');
source = source.replace(/export function /g, 'function ');
source += '\nmodule.exports = { createWindowBoundsPersistence };';

function loadBoundsPersistence() {
  const module = { exports: {} };
  const wrapper = vm.runInNewContext(`(function (module, exports) { ${source} })`, {
    setTimeout, clearTimeout, Promise, WeakMap, process
  });
  wrapper(module, module.exports);
  return module.exports.createWindowBoundsPersistence;
}

class FakeWindow {
  constructor() {
    this.listeners = new Map();
    this.bounds = { x: 10, y: 20, width: 900, height: 700 };
  }
  on(event, callback) { this.listeners.set(event, callback); }
  emit(event) { this.listeners.get(event)?.(); }
  isDestroyed() { return false; }
  isMaximized() { return false; }
  isFullScreen() { return false; }
  getBounds() { return { ...this.bounds }; }
}

test('window close captures pending debounced bounds and flush waits for persistence', async () => {
  const createPersistence = loadBoundsPersistence();
  const window = new FakeWindow();
  const persisted = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const stateStore = {
    async mutate(callback) {
      await blocked;
      const draft = {};
      callback(draft);
      persisted.push(draft.windowBounds);
    }
  };
  const controller = createPersistence(window, stateStore, null, 10_000);

  window.emit('resize');
  window.bounds = { x: 30, y: 40, width: 1100, height: 800 };
  window.emit('close');
  let flushed = false;
  const flushing = controller.flush().then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);

  release();
  await flushing;
  assert.deepEqual(persisted.at(-1), { x: 30, y: 40, width: 1100, height: 800 });
  const writesAfterFlush = persisted.length;
  window.bounds = { x: 1, y: 2, width: 3, height: 4 };
  window.emit('resize');
  window.emit('move');
  window.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persisted.length, writesAfterFlush);
});
