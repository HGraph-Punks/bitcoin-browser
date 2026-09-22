import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function queueAuthorityMutation('), end = source.indexOf('function activeTab()', start);
assert.ok(start > 0 && end > start);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
function fixture() {
  const download = deferred(), published = [], calls = [], errors = [];
  const current = { settings: { offlineMode: false }, providers: [], services: [] };
  let readFailure = false;
  const functions = vm.runInNewContext(`(() => {
    let providerRefreshSequence=0, authorityMutationSequence=0, authorityMutationTail=Promise.resolve(), routingMaintenanceVersion=0;
    ${source.slice(start, end)}
    return { runEasyNodeSetup, queueAuthorityMutation };
  })()`, { Promise, Error, Object, Array,
    api: { nodeSetup: { run: async action => { calls.push(action); return download.promise; } },
      providers: { snapshot: async () => { calls.push('snapshot'); if (readFailure) throw new Error('fixture read failed'); return structuredClone(current); } },
      services: { list: async () => structuredClone(current.services) } },
    validProviderSnapshot: value => value.settings && value.providers,
    publishProviderSnapshot: value => published.push(value), publishServices: value => published.push({ services: value }),
    markProviderOutcomeUnknown: message => errors.push(message), runPendingRoutingMaintenance() {} });
  return { ...functions, download, current, published, calls, errors, failRead: () => { readFailure = true; } };
}

test('easy download leaves privacy mutations unblocked and only publishes a fresh post-action snapshot', async () => {
  const f = fixture(); const running = f.runEasyNodeSetup({ token: 'main-owned' });
  await f.queueAuthorityMutation(async () => { f.current.settings.offlineMode = true; });
  assert.equal(f.current.settings.offlineMode, true); assert.equal(f.published.length, 0);
  f.current.services = [{ id: 'core', status: 'running' }];
  f.download.resolve({ committed: true, setupId: 'saved', settings: { offlineMode: false }, services: [{ status: 'stopped' }] });
  await running;
  assert.equal(f.published[0].settings.offlineMode, true); assert.equal(f.published[1].services[0].status, 'running');
  assert.deepEqual(f.calls, ['easy-start', 'snapshot']);
  assert.match(source, /if \(action === 'easy-start'\) return runEasyNodeSetup\(payload\)/);
});

test('postcommit publication failure preserves saved identity and never replays setup', async () => {
  const f = fixture(); f.failRead(); const running = f.runEasyNodeSetup({ token: 'owned' });
  const rejected = assert.rejects(running, error => error.code === 'NODE_SETUP_SAVED_REFRESH_FAILED' && error.details.setupCommitted && error.details.setupId === 'saved');
  f.download.resolve({ committed: true, setupId: 'saved' }); await rejected;
  assert.equal(f.published.length, 0); assert.equal(f.errors.length, 1); assert.deepEqual(f.calls, ['easy-start', 'snapshot']);
});

test('main-process postcommit error refreshes browser authority without hiding the recovery error', async () => {
  const f = fixture(), failure = Object.assign(new Error('Saved; status unknown'), { details: { setupCommitted: true, setupId: 'saved' } });
  const running = f.runEasyNodeSetup({ token: 'owned' }); const rejected = assert.rejects(running, error => error === failure);
  f.download.reject(failure); await rejected; assert.equal(f.published.length, 2); assert.deepEqual(f.calls, ['easy-start', 'snapshot']);
});

test('rejected precommit consent neither refreshes authority nor retries installation', async () => {
  const f = fixture(), failure = new Error('User declined'); const running = f.runEasyNodeSetup({ token: 'owned' });
  const rejected = assert.rejects(running, error => error === failure); f.download.reject(failure); await rejected;
  assert.equal(f.published.length, 0); assert.deepEqual(f.calls, ['easy-start']);
});
