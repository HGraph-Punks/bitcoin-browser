import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/renderer/state.js';
import * as constants from '../src/shared/constants.js';
import { parseNavigationInput } from '../src/shared/navigation.js';

const rendererSource = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const windowSource = fs.readFileSync(new URL('../src/main/window.js', import.meta.url), 'utf8');
const viewImports = rendererSource.match(/import\s*\{([^}]+)\}\s*from '\.\/views\.js';/)[1].split(',').map(name => name.trim());

// Execute the actual renderer definitions and menu construction. Only Electron,
// DOM rendering and IPC transport are deterministic collaborators. This does
// not claim native accelerator delivery, native focus, or screen-reader support.
function fixture(platform = 'darwin') {
  const nodes = new Map(), listeners = new Map(), pending = [], timers = [], saves = [], messages = [], toasts = [];
  const document = {
    activeElement: null,
    getElementById(name) {
      if (!nodes.has(name)) {
        const classes = new Set(name.endsWith('-backdrop') ? ['hidden'] : []);
        const node = {
          name, value: '', children: [], attributes: {}, isConnected: true, selections: 0,
          classList: {
            contains: value => classes.has(value),
            add: value => classes.add(value), remove: value => classes.delete(value),
            toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); }
          },
          addEventListener: (event, listener) => listeners.set(`${name}:${event}`, listener),
          querySelector(selector) { return this.children.find(child => selector === '.node-setup' && child.view === 'renderNodeSetup') ?? null; },
          setAttribute(key, value) { this.attributes[key] = value; },
          removeAttribute(key) { delete this.attributes[key]; },
          focus() { document.activeElement = this; },
          blur() { if (document.activeElement === this) document.activeElement = null; },
          select() { this.selections += 1; }
        };
        nodes.set(name, node);
      }
      return nodes.get(name);
    },
    addEventListener: (event, listener) => listeners.set(`document:${event}`, listener),
    querySelectorAll: () => []
  };
  let commandListener;
  const api = {
    app: { onCommand: listener => { commandListener = listener; }, onDeepLink() {}, openExternal: assert.fail },
    wallet: { onState() {} },
    navigation: { parse: async input => parseNavigationInput(input), resolve: assert.fail },
    tabs: { save: async (tabs, activeId) => { saves.push({ tabs: structuredClone(tabs), activeId }); } },
    history: { record: assert.fail }
  };
  const views = Object.fromEntries(viewImports.map(name => [name, (...args) => ({ view: name, args })]));
  views.updateServicesView = (node, model) => { node.children = [{ view: 'renderServices', args: [model] }]; return true; };
  const scope = {
    forgetAiTab() {},
    ...constants, ...views, Store, document, window: { satBrowser: api }, pending, toasts,
    renderNodeSetup: ctx => ({ view: 'renderNodeSetup', dataset: { owner: String(ctx.model.activeTabId) }, disposed: false, dispose() { this.disposed = true; } }),
    clear: (node, ...children) => { node.children = children.flat(); },
    h: (tag, attributes, ...children) => ({ tag, attributes, id: attributes.id, children: children.flat(), scrollIntoView() {} }),
    setTimeout: callback => { timers.push(callback); }, clearTimeout() {}
  };
  assert.match(rendererSource, /\nbootstrap\(\);\s*$/);
  const actions = vm.runInNewContext(`(() => {
    ${rendererSource.replace(/^import[\s\S]*?;\n/gm, '').replace(/\nbootstrap\(\);\s*$/, '')}
    renderChrome = () => {};
    renderDrawer = () => {};
    toast = (...args) => toasts.push(args);
    const actualNavigate = navigate;
    navigate = (...args) => { const operation = actualNavigate(...args); pending.push(operation); return operation; };
    let nextId = 0;
    id = () => 'tab-' + (++nextId);
    MODEL.patch({ bootstrap: { version: 'fixture' }, settings: { offlineMode: true },
      tabs: [safeTab({ id: 'initial', target: 'satnav://home' })], activeTabId: 'initial' });
    navigationReady = true;
    installEvents();
    return { executeCommand, navigate, paletteCandidates, openPalette, runPaletteSelection,
      state, renderPage, setReady: value => { navigationReady = value; } };
  })()`, scope);
  let currentWindow = makeWindow('initial-window'), menu;
  function makeWindow(name, destroyed = false) {
    return { isDestroyed: () => destroyed, webContents: { send(channel, command) {
      messages.push({ name, channel, command });
      assert.equal(channel, constants.IPC.APP_COMMAND);
      commandListener(command);
    } } };
  }
  const install = vm.runInNewContext(`${windowSource.slice(windowSource.indexOf('export function installApplicationMenu')).replace('export ', '')}\ninstallApplicationMenu;`, {
    IPC: constants.IPC, APP_NAME: constants.APP_NAME, process: { platform },
    Menu: { buildFromTemplate: template => template, setApplicationMenu: value => { menu = value; } }
  });
  install(() => currentWindow);
  const item = label => {
    const found = menu.flatMap(entry => entry.submenu ?? []).find(entry => entry.label === label);
    assert.ok(found, `Missing menu item: ${label}`);
    return found;
  };
  return {
    ...actions, nodes, document, messages, menu, item, saves, toasts,
    setWindow: value => { currentWindow = value; }, makeWindow,
    async settle() { const work = pending.splice(0); await Promise.all(work); assert.equal(pending.length, 0, 'Unexpected nested navigation'); },
    flushTimers() { for (const callback of timers.splice(0)) callback(); },
    key(event) {
      let prevented = 0;
      listeners.get('document:keydown')({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
        ...event, preventDefault: () => { prevented += 1; } });
      return prevented;
    },
    overlay(name, visible = true) {
      document.getElementById(`${name}-backdrop`).classList.toggle('hidden', !visible);
      document.getElementById('app').inert = visible;
    }
  };
}

test('Help Documentation reaches its distinct internal page through the real dispatcher and navigation', async () => {
  const f = fixture();
  f.item('Documentation').click();
  await f.settle();
  assert.equal(f.state().tabs[0].target, 'satnav://documentation');
  assert.equal(f.state().tabs[0].title, 'Documentation');
  assert.equal(f.nodes.get('page').children[0].view, 'renderDocumentation');
  assert.equal(f.messages[0].command, 'documentation');
  f.item('About Bitcoin Browser').click();
  await f.settle();
  assert.equal(f.state().tabs[0].target, 'satnav://about');
  assert.equal(f.nodes.get('page').children[0].view, 'renderAbout');
  assert.deepEqual([...f.state().tabs[0].history], ['satnav://home', 'satnav://documentation', 'satnav://about']);
  assert.equal(f.saves.at(-1).tabs[0].target, 'satnav://about');
});

test('direct Documentation navigation selects the implemented view, not the Home fallback', async () => {
  const f = fixture();
  await f.navigate('SATNAV://DOCUMENTATION');
  await f.settle();
  assert.equal(f.nodes.get('page').children[0].view, 'renderDocumentation');
});

test('Help Sponsors opens the implemented page and retains ordinary Back/Forward on every desktop menu', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const f = fixture(platform);
    f.item('Sponsors').click();
    await f.settle();
    assert.equal(f.messages[0].command, 'sponsors');
    assert.equal(f.state().tabs[0].target, 'satnav://sponsors');
    assert.equal(f.state().tabs[0].title, 'Sponsors');
    assert.equal(f.nodes.get('page').children[0].view, 'renderSponsors');
    assert.equal(f.saves.at(-1).tabs[0].target, 'satnav://sponsors');
    f.item('Back').click(); await f.settle();
    assert.equal(f.state().tabs[0].target, 'satnav://home');
    f.item('Forward').click(); await f.settle();
    assert.equal(f.state().tabs[0].target, 'satnav://sponsors');
    assert.equal(f.nodes.get('page').children[0].view, 'renderSponsors');
  }
});

test('Sponsors palette activation routes to the same local view without resolving a Bitcoin source', async () => {
  const f = fixture();
  f.openPalette();
  f.nodes.get('palette-input').value = 'HOL.org';
  f.state().paletteIndex = f.paletteCandidates().findIndex(entry => entry.id === 'sponsors');
  assert.ok(f.state().paletteIndex >= 0);
  f.runPaletteSelection();
  await f.settle();
  assert.equal(f.nodes.get('palette-backdrop').classList.contains('hidden'), true);
  assert.equal(f.nodes.get('app').inert, false);
  assert.equal(f.state().tabs[0].target, 'satnav://sponsors');
  assert.equal(f.nodes.get('page').children[0].view, 'renderSponsors');
});

test('guided setup uses an internal route, retains its form on updates, and disposes it on route or tab changes', async () => {
  const f = fixture();
  await f.navigate('satnav://node-setup');
  const original = f.nodes.get('page').children[0];
  assert.equal(original.view, 'renderNodeSetup');
  f.renderPage(); assert.equal(f.nodes.get('page').children[0], original);
  await f.navigate('satnav://services'); assert.equal(original.disposed, true);
  await f.navigate('satnav://node-setup');
  const second = f.nodes.get('page').children[0]; assert.notEqual(second, original);
  f.key({ key: 't', metaKey: true }); await f.settle();
  assert.equal(second.disposed, true);
});

test('Documentation is discoverable and executable in the command palette', async () => {
  const f = fixture();
  f.openPalette();
  f.nodes.get('palette-input').value = 'documentation';
  const command = f.paletteCandidates().find(entry => entry.id === 'documentation');
  assert.ok(command, 'Documentation palette entry');
  f.state().paletteIndex = f.paletteCandidates().indexOf(command);
  // Candidate objects from COMMANDS retain identity across filtering.
  f.runPaletteSelection();
  await f.settle();
  assert.equal(f.nodes.get('palette-backdrop').classList.contains('hidden'), true);
  assert.equal(f.nodes.get('app').inert, false);
  assert.equal(f.state().tabs[0].target, 'satnav://documentation');
  assert.equal(f.nodes.get('page').children[0].view, 'renderDocumentation');
});

test('About palette selection reaches the same internal view as the native menu without provider resolution', async () => {
  const f = fixture();
  f.openPalette();
  f.nodes.get('palette-input').value = 'Turtle Moon';
  const candidates = f.paletteCandidates();
  f.state().paletteIndex = candidates.findIndex(entry => entry.id === 'about');
  assert.ok(f.state().paletteIndex >= 0);
  f.runPaletteSelection();
  await f.settle();
  assert.equal(f.nodes.get('palette-backdrop').classList.contains('hidden'), true);
  assert.equal(f.nodes.get('app').inert, false);
  assert.equal(f.state().tabs[0].target, 'satnav://about');
  assert.equal(f.state().tabs[0].title, 'About');
  assert.equal(f.nodes.get('page').children[0].view, 'renderAbout');
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform} menu preserves advertised commands, accelerators and native roles`, () => {
    const f = fixture(platform);
    assert.deepEqual(f.menu.filter(entry => entry.role === 'appMenu').length, platform === 'darwin' ? 1 : 0);
    const file = f.menu.find(entry => entry.label === 'File');
    assert.equal(file.submenu.at(-1).role, platform === 'darwin' ? 'close' : 'quit');
    for (const [label, accelerator] of [
      ['New Tab', 'CmdOrCtrl+T'], ['Close Tab', 'CmdOrCtrl+W'], ['Focus Omnibox', 'CmdOrCtrl+L'],
      ['Reload Data', 'CmdOrCtrl+R'], ['Command Palette', 'CmdOrCtrl+Shift+P'],
      ['Back', 'Alt+Left'], ['Forward', 'Alt+Right'], ['Home', 'CmdOrCtrl+Shift+H'],
      ['Wallet', 'CmdOrCtrl+Shift+W'], ['Developer Inspector', 'CmdOrCtrl+Shift+I']
    ]) assert.equal(f.item(label).accelerator, accelerator, label);
    const roles = f.menu.flatMap(entry => entry.submenu ?? []).map(entry => entry.role).filter(Boolean);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'toggleDevTools']) {
      assert.ok(roles.includes(role), role);
    }
  });
}

test('menu delivery uses the current live window and ignores null or destroyed windows', async () => {
  const f = fixture();
  f.setWindow(null);
  f.item('Documentation').click();
  f.setWindow(f.makeWindow('destroyed', true));
  f.item('Documentation').click();
  assert.deepEqual(f.messages, []);
  f.setWindow(f.makeWindow('replacement'));
  f.item('Documentation').click();
  await f.settle();
  assert.deepEqual(f.messages, [{ name: 'replacement', channel: constants.IPC.APP_COMMAND, command: 'documentation' }]);
  assert.equal(f.state().tabs[0].target, 'satnav://documentation');
});

test('macOS application menu uses the public brand without changing native service, hide, or quit roles', () => {
  const f = fixture('darwin'), menu = f.menu.find(item => item.role === 'appMenu');
  assert.equal(menu.label, 'Bitcoin Browser');
  assert.equal(menu.submenu.find(item => item.role === 'hide').label, 'Hide Bitcoin Browser');
  assert.equal(menu.submenu.find(item => item.role === 'quit').label, 'Quit Bitcoin Browser');
  for (const role of ['services', 'hideOthers', 'unhide']) assert.ok(menu.submenu.some(item => item.role === role));
  assert.ok(menu.submenu.some(item => item.label === 'About Bitcoin Browser' && typeof item.click === 'function'));
});

for (const overlay of ['modal', 'palette']) {
  test(`menu commands cannot mutate or focus the inert shell beneath an open ${overlay}`, async () => {
    const f = fixture();
    f.overlay(overlay);
    const before = JSON.stringify(f.state());
    for (const label of ['New Tab', 'Close Tab', 'Focus Omnibox', 'Reload Data', 'Back', 'Forward', 'Home', 'Wallet', 'Providers', 'Developer Inspector', 'Documentation', 'Sponsors', 'About Bitcoin Browser', 'Command Palette']) {
      f.item(label).click();
      await f.settle();
      assert.equal(JSON.stringify(f.state()), before, label);
      assert.equal(f.document.activeElement, null, label);
      assert.equal(f.nodes.get(`${overlay}-backdrop`).classList.contains('hidden'), false, label);
    }
    assert.equal(f.saves.length, 0);
    assert.equal(f.nodes.get('app').inert, true);
  });

  test(`service-state events still publish while the ${overlay} is open`, async () => {
    const f = fixture();
    await f.navigate('satnav://services');
    await f.settle();
    f.overlay(overlay);
    const services = [{ id: 'fixture-service', status: 'stopped' }];
    f.executeCommand({ type: 'services-updated', services });
    assert.deepEqual(f.state().services, services);
    assert.equal(f.nodes.get('page').children[0].view, 'renderServices');
    assert.equal(f.nodes.get('page').children[0].args[0].services, services);
    assert.equal(f.nodes.get(`${overlay}-backdrop`).classList.contains('hidden'), false);
    assert.equal(f.nodes.get('app').inert, true);
  });
}

test('startup guard ignores menu and keyboard actions until the session is ready', async () => {
  const f = fixture();
  f.setReady(false);
  f.item('Documentation').click();
  f.item('Sponsors').click();
  f.item('New Tab').click();
  assert.equal(f.key({ key: 't', ctrlKey: true }), 0);
  await f.settle();
  assert.equal(f.state().tabs.length, 1);
  assert.equal(f.state().tabs[0].target, 'satnav://home');
  assert.equal(f.saves.length, 0);
});

test('unknown and malformed command identifiers cannot invoke inherited or coerced actions', async () => {
  const f = fixture();
  const before = JSON.stringify(f.state());
  for (const command of [null, undefined, {}, [], 1, '__proto__', 'constructor', 'toString', 'not-a-command',
    { type: '__proto__' }, { type: ['home'] }, { type: { toString: () => 'home' } }]) {
    assert.doesNotThrow(() => f.executeCommand(command));
    await f.settle();
    assert.equal(JSON.stringify(f.state()), before);
  }
  assert.equal(f.saves.length, 0);
});

for (const modifier of ['metaKey', 'ctrlKey']) {
  test(`${modifier} shortcuts accept exact advertised chords and reject extra modifiers`, async () => {
    const f = fixture();
    for (const key of ['l', 't', 'w']) {
      for (const extra of [{ shiftKey: true }, { altKey: true }, { altKey: true, shiftKey: true }]) {
        const before = JSON.stringify(f.state());
        assert.equal(f.key({ key, [modifier]: true, ...extra }), 0, `${key} ${JSON.stringify(extra)}`);
        await f.settle();
        assert.equal(JSON.stringify(f.state()), before);
        assert.equal(f.document.activeElement, null);
      }
    }
    assert.equal(f.key({ key: 'P', [modifier]: true, shiftKey: true, altKey: true }), 0);
    for (const key of ['l', 't', 'w', 'P']) {
      assert.equal(f.key({ key, metaKey: true, ctrlKey: true, shiftKey: key === 'P' }), 0);
    }
    assert.equal(f.key({ key: 'L', [modifier]: true }), 1);
    assert.equal(f.document.activeElement, f.nodes.get('omnibox'));
    assert.equal(f.nodes.get('omnibox').selections, 1);
    assert.equal(f.key({ key: 't', [modifier]: true }), 1);
    await f.settle();
    assert.equal(f.state().tabs.length, 2);
    assert.equal(f.key({ key: 'w', [modifier]: true }), 1);
    await f.settle();
    assert.equal(f.state().tabs.length, 1);
    assert.equal(f.key({ key: 'P', [modifier]: true, shiftKey: true }), 1);
    assert.equal(f.nodes.get('palette-backdrop').classList.contains('hidden'), false);
  });
}

test('Alt history shortcuts reject Shift and command/control additions', async () => {
  const f = fixture();
  await f.navigate('satnav://about');
  await f.settle();
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { ctrlKey: true, metaKey: true }]) {
    assert.equal(f.key({ key: 'ArrowLeft', altKey: true, ...extra }), 0);
    await f.settle();
    assert.equal(f.state().tabs[0].target, 'satnav://about');
  }
  assert.equal(f.key({ key: 'ArrowLeft', altKey: true }), 1);
  await f.settle();
  assert.equal(f.state().tabs[0].target, 'satnav://home');
  assert.equal(f.key({ key: 'ArrowRight', altKey: true }), 1);
  await f.settle();
  assert.equal(f.state().tabs[0].target, 'satnav://about');
});

test('ordinary keyboard commands obey both overlay guards and resume after dismissal', async () => {
  const f = fixture();
  for (const overlay of ['modal', 'palette']) {
    f.overlay(overlay);
    assert.equal(f.key({ key: 't', ctrlKey: true }), 0);
    assert.equal(f.key({ key: 'l', metaKey: true }), 0);
    assert.equal(f.state().tabs.length, 1);
    f.overlay(overlay, false);
  }
  assert.equal(f.key({ key: 't', ctrlKey: true }), 1);
  await f.settle();
  assert.equal(f.state().tabs.length, 2);
});
