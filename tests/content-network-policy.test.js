import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTENT_NETWORK_REQUEST_FILTER,
  createContentNetworkPolicyApplier,
  effectiveContentNetworkPolicy,
  isContentRequestAllowed
} from '../src/main/content-network-policy.js';

const settings = (contentNetworkPolicy, offlineMode = false, localOnly = false) => ({ contentNetworkPolicy, offlineMode, localOnly });

test('content request filter explicitly registers HTTP-family and WebSocket schemes', () => {
  assert.deepEqual(CONTENT_NETWORK_REQUEST_FILTER, { urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] });
  assert.equal(Object.isFrozen(CONTENT_NETWORK_REQUEST_FILTER), true);
  assert.equal(Object.isFrozen(CONTENT_NETWORK_REQUEST_FILTER.urls), true);
});

test('main registration consumes the shared content request filter', () => {
  const source = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ CONTENT_NETWORK_REQUEST_FILTER, createContentNetworkPolicyApplier, isContentRequestAllowed \} from '\.\/content-network-policy\.js';/);
  assert.equal(source.match(/appSession\.webRequest\.onBeforeRequest\(CONTENT_NETWORK_REQUEST_FILTER,/g)?.length, 1);
  assert.doesNotMatch(source, /appSession\.webRequest\.onBeforeRequest\(\{ urls:/);
});

test('effective content policy is blocked offline regardless of the saved policy', () => {
  assert.equal(effectiveContentNetworkPolicy(settings('https-only', true)), 'blocked');
  assert.equal(effectiveContentNetworkPolicy(settings('https-only', false)), 'https-only');
  assert.equal(effectiveContentNetworkPolicy(settings('blocked', false)), 'blocked');
});

test('content request policy covers every scheme, mode, and resource-type boundary', () => {
  for (const scheme of ['app:', 'ord:', 'data:', 'blob:', 'devtools:']) {
    for (const mode of [settings('blocked'), settings('https-only'), settings('https-only', true)]) {
      assert.equal(isContentRequestAllowed({ url: `${scheme}${scheme === 'data:' ? 'text/plain,ok' : '//fixture/path'}`, resourceType: 'mainFrame' }, mode), true, `${scheme} internal request`);
    }
  }

  for (const scheme of ['https:', 'wss:']) {
    assert.equal(isContentRequestAllowed({ url: `${scheme}//example.test/path`, resourceType: 'xhr' }, settings('blocked')), false);
    assert.equal(isContentRequestAllowed({ url: `${scheme}//example.test/path`, resourceType: 'xhr' }, settings('https-only', true)), false);
    assert.equal(isContentRequestAllowed({ url: `${scheme}//example.test/path`, resourceType: 'mainFrame' }, settings('https-only')), false);
    assert.equal(isContentRequestAllowed({ url: `${scheme}//example.test/path`, resourceType: 'xhr' }, settings('https-only')), true);
  }

  for (const scheme of ['http:', 'ws:', 'file:', 'ftp:', 'javascript:']) {
    assert.equal(isContentRequestAllowed({ url: `${scheme}//example.test/path`, resourceType: 'image' }, settings('https-only')), false, `${scheme} external request`);
  }
  assert.equal(isContentRequestAllowed({ url: 'not a URL', resourceType: 'xhr' }, settings('https-only')), false);
});

test('local-only remains provider-scoped and does not alter inscription networking', () => {
  const request = { url: 'https://example.test/resource', resourceType: 'image' };
  assert.equal(isContentRequestAllowed(request, settings('https-only', false, false)), true);
  assert.equal(isContentRequestAllowed(request, settings('https-only', false, true)), true);
});

test('failed content network cutoff remains pending for an identical blocked retry', async () => {
  let calls = 0;
  const apply = createContentNetworkPolicyApplier(async () => {
    calls += 1;
    if (calls === 1) throw new Error('fixture close failure');
  });
  const compatible = settings('https-only');
  const offline = settings('https-only', true);

  await assert.rejects(apply(compatible, offline), /fixture close failure/);
  await apply(offline, offline);
  assert.equal(calls, 2);
  await apply(offline, offline);
  assert.equal(calls, 2);
});

test('ordinary blocked updates do not close connections', async () => {
  let calls = 0;
  const apply = createContentNetworkPolicyApplier(async () => { calls += 1; });
  const blocked = settings('blocked');

  await apply(blocked, { ...blocked, theme: 'dark' });
  assert.equal(calls, 0);
});

test('compatible then blocked transitions close once per tightening', async () => {
  let calls = 0;
  const apply = createContentNetworkPolicyApplier(async () => { calls += 1; });
  const blocked = settings('blocked');
  const compatible = settings('https-only');

  await apply(blocked, compatible);
  assert.equal(calls, 0);
  await apply(compatible, blocked);
  assert.equal(calls, 1);
  await apply(blocked, blocked);
  assert.equal(calls, 1);
  await apply(blocked, compatible);
  await apply(compatible, settings('https-only', true));
  assert.equal(calls, 2);
});
