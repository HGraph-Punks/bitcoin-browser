import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnostics, DIAGNOSTICS_LIMITS, MAX_DIAGNOSTICS_BYTES } from '../src/main/diagnostics.js';

function fixture(overrides = {}) {
  return {
    stateStore: { snapshot: () => ({}) },
    app: { getName: () => 'Bitcoin Browser', getVersion: () => 'test', isPackaged: false },
    providerManager: { list: () => [] },
    cache: { stats: () => ({ entries: 0, bytes: 0 }) },
    localServiceManager: { list: () => [] },
    secureStore: { availabilityStatus: () => null, available: () => { throw new Error('must not probe'); } },
    ...overrides
  };
}

test('diagnostics redact wallet, path, argument, authorization, and log secrets', async () => {
  const state = {
    wallet: { accounts: [{ address: 'bc1qthisisacompletewalletaddress', publicKey: '02secretpublickey' }] },
    extensions: [{ id: 'extension', path: '/Users/test/private/wallet-extension' }],
    localServices: [{ id: 'core', executable: '/opt/bitcoin/bin/bitcoind', cwd: '/Users/test/bitcoin', args: ['--rpcpassword=supersecret', '--server=1'] }]
  };
  const diagnostics = await buildDiagnostics({
    stateStore: { snapshot: () => structuredClone(state) },
    app: { getName: () => 'Bitcoin Browser', getVersion: () => 'test', isPackaged: false },
    providerManager: { list: () => [{ id: 'provider', credentialsStored: true }] },
    cache: { stats: () => ({ entries: 1, bytes: 10, directory: '/Users/test/private/cache' }) },
    localServiceManager: { list: () => [{
      id: 'core', executable: '/opt/bitcoin/bin/bitcoind', cwd: '/Users/test/bitcoin', args: ['--token=token-value'],
      logs: [{ stream: 'stderr', text: 'Authorization: Bearer bearer-value password=hunter2 seed phrase: alpha beta gamma' }]
    }] },
    secureStore: { availabilityStatus: () => true, available: () => { throw new Error('must not probe'); } }
  });
  const serialized = JSON.stringify(diagnostics);
  for (const secret of ['bc1qthisisacompletewalletaddress', '02secretpublickey', 'supersecret', 'token-value', 'bearer-value', 'hunter2', 'alpha beta gamma', '/Users/test/private']) {
    assert.equal(serialized.includes(secret), false, `diagnostics leaked ${secret}`);
  }
  assert.match(serialized, /\[redacted/);
  assert.equal(diagnostics.secureStorageAvailable, true);
});

test('diagnostics redact split arguments, quoted logs, URL credentials and provider error text', async () => {
  const args = ['--rpcpassword', 'split-password', '--authorization', 'Bearer split-auth', '--api-key=inline-key', '--server=1'];
  const logs = [
    { text: '{"authorization": "Bearer json-auth", "cookie": "session=json-cookie", "password": "spaces in json-password"}' },
    { text: "{'token': 'single-quoted-token'} --rpcpassword inline-password --authorization Bearer inline-auth" },
    { text: 'GET https://user:url-password@example.invalid/api?token=query-token&mode=ok wss://url-username@example.invalid/socket' },
    { text: 'seed phrase: fake mnemonic words for fixture only' },
    { text: '{"password":"escaped \\" quote-password"}' },
    { text: 'Cookie: first=cookie-first; second=cookie-second; third=cookie-third\nordinary log line' },
    { text: 'Set-Cookie: session=cookie-session; extra=cookie-extra' },
    { text: '{"cookie": "first=json-cookie-first; second=json-cookie-second"}' },
    { text: 'rpc_password=underscored-password; access_token=prefixed-token' }
  ];
  const result = await buildDiagnostics(fixture({
    stateStore: { snapshot: () => ({ localServices: [{ args }], credentials: { refreshToken: 'structured-token', privateKey: 'fixture-private-key' } }) },
    providerManager: { list: () => [{ lastError: 'Authorization: Basic provider-auth', baseUrl: 'https://user:provider-password@example.invalid' }] },
    localServiceManager: { list: () => [{ args, logs }] }
  }));
  const serialized = JSON.stringify(result);
  for (const secret of ['split-password', 'split-auth', 'inline-key', 'json-auth', 'json-cookie', 'json-password', 'single-quoted-token', 'inline-password', 'inline-auth', 'url-password', 'query-token', 'url-username', 'fake mnemonic words', 'quote-password', 'structured-token', 'fixture-private-key', 'provider-auth', 'provider-password', 'cookie-first', 'cookie-second', 'cookie-third', 'cookie-session', 'cookie-extra', 'json-cookie-first', 'json-cookie-second', 'underscored-password', 'prefixed-token']) {
    assert.equal(serialized.includes(secret), false, `diagnostics leaked ${secret}`);
  }
  assert.equal(result.services[0].args.at(-1), '--server=1');
  assert.match(serialized, /example.invalid/);
  assert.match(serialized, /ordinary log line/);
  assert.equal(result.redaction.truncated, false);
});

test('diagnostics tolerate malformed optional collections without an active secure-storage check', async () => {
  const result = await buildDiagnostics(fixture({
    stateStore: { snapshot: () => ({
      wallet: { accounts: [null, 'invalid', { address: 123, publicKey: 'fixture-key' }, { address: 'short' }] },
      extensions: [null, { path: 12 }],
      localServices: [null, { executable: {}, args: 'invalid', logs: 'invalid' }]
    }) },
    localServiceManager: { list: () => [null, { args: [null, '--token', { value: 'do-not-serialize' }] }] }
  }));
  assert.equal(result.secureStorageAvailable, null);
  assert.equal(result.state.wallet.accounts.length, 2);
  assert.equal(result.state.wallet.accounts[1].address, '[redacted]');
  assert.deepEqual(result.state.localServices[0].args, []);
  assert.deepEqual(result.services[0].args, ['[invalid argument]', '--token', '[redacted]']);
  assert.equal(JSON.stringify(result).includes('fixture-key'), false);
  assert.match(result.notes[0], /review this file before sharing/);
});

test('diagnostics bound collections, strings, keys and total output and disclose truncation', async () => {
  const history = Array.from({ length: 250 }, (_, index) => ({ canonical: `sat:${index}`, title: '\u0000'.repeat(50_000) }));
  const result = await buildDiagnostics(fixture({
    stateStore: { snapshot: () => ({ history, ['x'.repeat(1000)]: 'oversized key' }) },
    localServiceManager: { list: () => Array.from({ length: 200 }, () => ({ logs: Array.from({ length: 100 }, (_, index) => ({ text: `log-${index}` })) })) }
  }));
  const serialized = JSON.stringify(result, null, 2);
  assert.ok(Buffer.byteLength(serialized) < MAX_DIAGNOSTICS_BYTES);
  assert.ok(result.state.history.length <= DIAGNOSTICS_LIMITS.arrayEntries);
  assert.ok(result.state.history[0].title.length <= DIAGNOSTICS_LIMITS.stringCharacters + 12);
  assert.equal(result.redaction.truncated, true);
  assert.ok(result.redaction.counts.strings > 0);
  assert.ok(result.redaction.counts.characters > 0);
  assert.deepEqual(JSON.parse(serialized).redaction.limits, DIAGNOSTICS_LIMITS);

  const logs = await buildDiagnostics(fixture({ localServiceManager: { list: () => [{ logs: Array.from({ length: 100 }, (_, index) => ({ text: `log-${index}` })) }] } }));
  assert.equal(logs.services[0].logs.length, 50);
  assert.equal(logs.services[0].logs[0].text, 'log-50');
  const keys = await buildDiagnostics(fixture({ stateStore: { snapshot: () => ({ ['x'.repeat(1000)]: 'value' }) } }));
  assert.ok(Object.keys(keys.state).every((key) => key.length <= DIAGNOSTICS_LIMITS.keyCharacters + 12));
});

test('diagnostics bound cycles, nesting and nodes and redact truncated quoted secrets', async () => {
  const cyclic = { stable: 'value' }; cyclic.self = cyclic;
  let deep = {};
  for (let index = 0; index < 100; index += 1) deep = { child: deep };
  const result = await buildDiagnostics(fixture({
    stateStore: { snapshot: () => ({ cyclic, deep, message: '{"password":"' + 'sensitive-fragment '.repeat(3000) }) }
  }));
  assert.equal(result.state.cyclic.self, '[circular]');
  assert.equal(result.redaction.truncated, true);
  assert.ok(result.redaction.counts.cycles > 0);
  assert.ok(result.redaction.counts.depth > 0);
  assert.equal(JSON.stringify(result).includes('sensitive-fragment'), false);

  const nodes = await buildDiagnostics(fixture({ stateStore: { snapshot: () => ({ large: Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => Array(100).fill(0))) }) } }));
  assert.ok(nodes.redaction.counts.nodes > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(nodes, null, 2)) < MAX_DIAGNOSTICS_BYTES);
});
