import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

function executePreload(file, exposedName) {
  let facade;
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = async () => ({ ok: true, result: null });
  ipcRenderer.send = () => {};
  const source = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(`(function(require) { ${source}\n})`, {})((specifier) => {
    assert.equal(specifier, 'electron');
    return {
      contextBridge: {
        exposeInMainWorld(name, value) {
          assert.equal(name, exposedName);
          facade = value;
        }
      },
      ipcRenderer
    };
  });
  return { facade, ipcRenderer };
}

test('application preload subscriptions are independent and their disposers remove only the owned wrapper', () => {
  const { facade, ipcRenderer } = executePreload(new URL('../src/main/preload.cjs', import.meta.url), 'satBrowser');
  const first = [];
  const second = [];
  const disposeFirst = facade.app.onCommand((value) => first.push(value));
  const disposeSecond = facade.app.onCommand((value) => second.push(value));
  const disposeInvalid = facade.app.onCommand(null);

  ipcRenderer.emit('app:command', { sender: 'fixture' }, 'first');
  assert.deepEqual(first, ['first']);
  assert.deepEqual(second, ['first']);
  assert.equal(ipcRenderer.listenerCount('app:command'), 2);

  disposeFirst();
  disposeFirst();
  disposeInvalid();
  ipcRenderer.emit('app:command', { sender: 'fixture' }, 'second');
  assert.deepEqual(first, ['first']);
  assert.deepEqual(second, ['first', 'second']);
  assert.equal(ipcRenderer.listenerCount('app:command'), 1);

  disposeSecond();
  assert.equal(ipcRenderer.listenerCount('app:command'), 0);
});

test('application event channels retain separate ownership and do not deliver after disposal', () => {
  const { facade, ipcRenderer } = executePreload(new URL('../src/main/preload.cjs', import.meta.url), 'satBrowser');
  const commands = [];
  const links = [];
  const wallets = [];
  const disposers = [
    facade.app.onCommand((value) => commands.push(value)),
    facade.app.onDeepLink((value) => links.push(value)),
    facade.wallet.onState((value) => wallets.push(value))
  ];

  ipcRenderer.emit('app:command', {}, 'reload');
  ipcRenderer.emit('app:deep-link', {}, 'satnav://history');
  ipcRenderer.emit('wallet:state', {}, { connected: false });
  assert.deepEqual(commands, ['reload']);
  assert.deepEqual(links, ['satnav://history']);
  assert.deepEqual(wallets, [{ connected: false }]);

  for (const dispose of disposers) dispose();
  ipcRenderer.emit('app:command', {}, 'home');
  ipcRenderer.emit('app:deep-link', {}, 'satnav://bookmarks');
  ipcRenderer.emit('wallet:state', {}, { connected: true });
  assert.deepEqual(commands, ['reload']);
  assert.deepEqual(links, ['satnav://history']);
  assert.deepEqual(wallets, [{ connected: false }]);
});

test('wallet preload command disposer is idempotent and suppresses subsequent command delivery', () => {
  const { facade, ipcRenderer } = executePreload(new URL('../src/wallet/preload.cjs', import.meta.url), 'walletHost');
  const first = [];
  const second = [];
  const disposeFirst = facade.onCommand((value) => first.push(value));
  const disposeSecond = facade.onCommand((value) => second.push(value));

  ipcRenderer.emit('wallet-bridge:command', {}, { requestId: 'one' });
  disposeFirst();
  disposeFirst();
  ipcRenderer.emit('wallet-bridge:command', {}, { requestId: 'two' });
  assert.deepEqual(first, [{ requestId: 'one' }]);
  assert.deepEqual(second, [{ requestId: 'one' }, { requestId: 'two' }]);

  disposeSecond();
  assert.equal(ipcRenderer.listenerCount('wallet-bridge:command'), 0);
  ipcRenderer.emit('wallet-bridge:command', {}, { requestId: 'late' });
  assert.equal(second.length, 2);
});
