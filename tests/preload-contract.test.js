import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const preloadSource = await fs.readFile(new URL('../src/main/preload.cjs', import.meta.url), 'utf8');

function loadPreload(invoke) {
  const exposed = new Map();
  const ipcRenderer = {
    invoke,
    on() {},
    removeListener() {}
  };
  vm.runInNewContext(preloadSource, {
    require(specifier) {
      assert.equal(specifier, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
        ipcRenderer
      };
    }
  }, { filename: 'preload.cjs' });
  return exposed.get('satBrowser');
}

test('preload unwraps successful IPC envelopes', async () => {
  const api = loadPreload(async (channel, payload) => ({ ok: true, result: { channel, payload } }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(await api.navigation.parse('sat:0'))),
    { channel: 'navigation:parse', payload: { input: 'sat:0' } }
  );
});

test('recovery facade forwards one reviewed request and retains committed recovery error metadata', async () => {
  const request = { id: 'source', token: 'synthetic-token', mode: 'clear-stored' };
  const calls = [];
  const api = loadPreload(async (channel, payload) => {
    calls.push({ channel, payload });
    return { ok: false, error: { code: 'SYNTHETIC_FINALIZATION_FAILED', message: 'Synthetic recovery failure', status: 500,
      details: { providerMutationCommitted: true, operation: 'recover', providerId: 'source', providers: [], settings: {} } } };
  });
  await assert.rejects(api.providers.recover(request), (error) => error.details.providerMutationCommitted === true && error.details.operation === 'recover');
  assert.deepEqual(calls, [{ channel: 'providers:recover', payload: request }]);
});

test('cleanup facade forwards exact read-only ID and separate reviewed deletion while retaining outcome metadata', async () => {
  const calls = [];
  const api = loadPreload(async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === 'providers:cleanup-review') return { ok: true, result: { id: payload.id, token: 'synthetic-reviewed-token' } };
    return { ok: false, error: { code: 'PROVIDER_CREDENTIAL_CLEANUP_FAILED', message: 'Synthetic cleanup failure',
      details: { operation: 'cleanup', providerMutationCommitted: true, cleanups: [], cleanupCompleted: false } } };
  });
  const request = await api.providers.reviewCleanup('source');
  await assert.rejects(api.providers.cleanup(request), error => error.details.operation === 'cleanup'
    && error.details.providerMutationCommitted === true && error.details.cleanupCompleted === false);
  assert.equal(calls[1].payload, request);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ channel: 'providers:cleanup-review', payload: { id: 'source' } }, { channel: 'providers:cleanup', payload: request }]);
});

test('preload rejects with serializable application error metadata', async () => {
  const api = loadPreload(async () => ({
    ok: false,
    error: {
      name: 'AppError',
      code: 'ALL_PROVIDERS_FAILED',
      message: 'Every provider failed',
      status: 503,
      retryable: true,
      details: { attempts: [{ providerId: 'ord', ok: false }] }
    }
  }));

  await assert.rejects(api.navigation.resolve('sat:0'), (error) => {
    assert.equal(error instanceof Error, false);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), {
      name: 'SatBrowserError',
      code: 'ALL_PROVIDERS_FAILED',
      message: 'Every provider failed',
      status: 503,
      retryable: true,
      details: { attempts: [{ providerId: 'ord', ok: false }] }
    });
    return true;
  });
});

test('preload normalizes IPC transport failures to a serializable record', async () => {
  const api = loadPreload(async () => {
    const error = new Error('IPC channel closed');
    error.code = 'CHANNEL_CLOSED';
    throw error;
  });

  await assert.rejects(api.app.bootstrap(), (error) => {
    assert.deepEqual(JSON.parse(JSON.stringify(error)), {
      name: 'SatBrowserError',
      code: 'CHANNEL_CLOSED',
      message: 'IPC channel closed',
      status: 500,
      retryable: false,
      details: null
    });
    return true;
  });
});
