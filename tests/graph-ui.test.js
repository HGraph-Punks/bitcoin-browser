import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function loadGraph(');
const end = source.indexOf('\nasync function saveContent(', begin);
assert.ok(begin >= 0 && end > begin);
const inscriptionId = `${'a'.repeat(64)}i0`;
const canonical = `inscription:${inscriptionId}`;

function fixture() {
  const model = {
    activeTabId: 'a',
    tabs: [{ id: 'a', target: canonical }, { id: 'b', target: 'satnav://home' }],
    results: { a: { target: { kind: 'inscription', value: inscriptionId, canonical } } },
    graphs: {}, requestSequence: { a: 1 }, developerOpen: false, drawerTab: 'raw'
  };
  const calls = [];
  const toasts = [];
  const patches = [];
  const context = {
    state: () => model,
    activeTab: () => model.tabs.find((tab) => tab.id === model.activeTabId),
    currentResult: () => model.results[model.activeTabId],
    patch(value, options) { Object.assign(model, typeof value === 'function' ? value(model) : value); patches.push(options); },
    api: { resolver: { graph: (id) => new Promise((resolve, reject) => calls.push({ id, resolve, reject })) } },
    normalizeError: (error) => ({ code: error.code ?? 'INTERNAL_ERROR', message: error.message }),
    toast: (...args) => toasts.push(args)
  };
  return { model, calls, patches, toasts, loadGraph: vm.runInNewContext(`(${source.slice(begin, end)})`, context) };
}

test('graph results remain attached to the originating background tab without changing active drawer selection', async () => {
  const { model, calls, patches, loadGraph } = fixture();
  const pending = loadGraph();
  assert.equal(calls[0].id, inscriptionId);
  assert.equal(model.graphs.a.loading, true);
  model.activeTabId = 'b';
  model.drawerTab = 'raw';
  model.developerOpen = false;
  const data = { nodes: [], edges: [], cycles: [] };
  calls[0].resolve(data);
  await pending;
  assert.equal(model.graphs.a.data, data);
  assert.equal(model.graphs.a.canonical, canonical);
  assert.equal(model.activeTabId, 'b');
  assert.equal(model.drawerTab, 'raw');
  assert.equal(model.developerOpen, false);
  assert.equal(patches.some((options) => options.page), false);
});

for (const outcome of ['resolve', 'reject']) {
  test(`obsolete graph ${outcome} cannot replace a newer graph request`, async () => {
    const { model, calls, loadGraph } = fixture();
    const older = loadGraph();
    const newer = loadGraph();
    const data = { nodes: [{ path: 'newer graph' }], edges: [], cycles: [] };
    calls[1].resolve(data);
    await newer;
    calls[0][outcome](outcome === 'resolve' ? { nodes: ['obsolete'] } : new Error('obsolete failure'));
    await older;
    assert.equal(model.graphs.a.data, data);
    assert.equal(model.graphs.a.error, null);
  });

  test(`late graph ${outcome} cannot recreate state after its tab is closed`, async () => {
    const { model, calls, loadGraph } = fixture();
    const pending = loadGraph();
    model.tabs = model.tabs.filter((tab) => tab.id !== 'a');
    delete model.graphs.a;
    delete model.results.a;
    delete model.requestSequence.a;
    model.activeTabId = 'b';
    calls[0][outcome](outcome === 'resolve' ? { nodes: [] } : new Error('closed tab'));
    await pending;
    assert.equal(Object.hasOwn(model.graphs, 'a'), false);
  });
}

test('same-tab navigation and reload invalidate graph work even before another graph is built', async () => {
  for (const change of ['target', 'reload']) {
    const { model, calls, loadGraph } = fixture();
    const pending = loadGraph();
    if (change === 'target') {
      model.tabs[0].target = 'satnav://home';
      model.results.a = { target: { kind: 'home', canonical: 'satnav://home' } };
    } else model.requestSequence.a += 1;
    const waiting = model.graphs.a;
    calls[0].resolve({ nodes: ['obsolete graph'] });
    await pending;
    assert.equal(model.graphs.a, waiting);
    assert.equal(model.graphs.a.data, null);
  }
});

test('current graph errors are surfaced and targets without inscription IDs never call the resolver', async () => {
  const { model, calls, toasts, loadGraph } = fixture();
  const pending = loadGraph();
  calls[0].reject(Object.assign(new Error('fixture offline miss'), { code: 'OFFLINE_CACHE_MISS' }));
  await pending;
  assert.equal(model.graphs.a.loading, false);
  assert.equal(model.graphs.a.error.code, 'OFFLINE_CACHE_MISS');
  assert.equal(model.graphs.a.data, null);
  model.results.a = { target: { kind: 'block', value: 100, canonical: 'block:100' } };
  await loadGraph();
  assert.equal(calls.length, 1);
  assert.equal(toasts[0][0], 'Graph unavailable');
});
