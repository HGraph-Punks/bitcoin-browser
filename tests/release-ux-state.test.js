import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sourceStatus, lookupRecovery, providerHealthPresentation } from '../src/renderer/source-status.js';

const provider = (overrides = {}) => ({ network: 'mainnet', enabled: true, local: false, type: 'ord-server', ...overrides });
const model = (providers = [], settings = {}) => ({ providers, settings: { network: 'mainnet', ...settings } });

test('waiting for Core is distinct from failed credentials and respects offline routing', () => {
  const core = provider({ type: 'bitcoin-core', local: true, health: { ok: false, error: { code: 'PROVIDER_COOKIE_UNAVAILABLE' } } });
  assert.equal(sourceStatus(model([core])).tone, 'warn');
  assert.equal(sourceStatus(model([core])).label, 'Waiting for local node');
  assert.equal(sourceStatus(model([core], { offlineMode: true })).title, 'Offline');
  const rejected = { ...core, health: { ok: false, error: { code: 'PROVIDER_AUTH_ERROR' } } };
  assert.equal(sourceStatus(model([core, rejected])).tone, 'fail');
  assert.equal(providerHealthPresentation(core).label, 'STOPPED OR STARTING');
  assert.equal(providerHealthPresentation(rejected).label, 'SIGN-IN REJECTED');
});

test('Core health clearly labels loading, permission problems, and initial sync without claiming readiness', () => {
  const core = provider({ type: 'bitcoin-core', local: true });
  for (const [code, label] of [['PROVIDER_WARMING_UP', 'STARTING'], ['PROVIDER_COOKIE_ACCESS_DENIED', 'FILE ACCESS NEEDED'], ['PROVIDER_COOKIE_READ_FAILED', 'CHECK SIGN-IN FILE']]) {
    assert.equal(providerHealthPresentation({ ...core, health: { ok: false, error: { code } } }).label, label);
  }
  const syncing = providerHealthPresentation({ ...core, health: { ok: true, initialBlockDownload: true, verificationProgress: 0.9059 } });
  assert.equal(syncing.label, 'SYNCING · 90.6%'); assert.match(syncing.message, /some local lookups are not available/);
  assert.doesNotMatch(syncing.message, /fully synced|ready for all/);
  assert.equal(providerHealthPresentation({ ...core, enabled: false, health: { ok: false } }).label, 'DISABLED');
  assert.equal(providerHealthPresentation({ ...core, routingBlocked: true, health: { ok: true } }).label, 'SIGN-IN RECOVERY NEEDED');
});

test('source status distinguishes no source, unchecked, failed and last successful check', () => {
  assert.equal(sourceStatus().tone, 'warn');
  assert.equal(sourceStatus(model()).label, 'No enabled data sources');
  const unchecked = sourceStatus(model([provider()]));
  assert.equal(unchecked.tone, 'unknown'); assert.equal(unchecked.healthy, 0); assert.equal(unchecked.eligible, 1);
  assert.doesNotMatch(unchecked.label, /ready|healthy|verified/i);
  const failed = sourceStatus(model([provider({ health: { ok: false } })]));
  assert.equal(failed.tone, 'fail'); assert.match(failed.notice, /last health check/);
  const healthy = sourceStatus(model([provider({ health: { ok: true } })]));
  assert.equal(healthy.tone, 'ok'); assert.equal(healthy.label, '1 source passed last check');
});

test('source counts exclude disabled, wrong-network and credential-recovery-blocked providers', () => {
  const status = sourceStatus(model([
    provider({ enabled: false, health: { ok: true } }), provider({ network: 'signet', health: { ok: true } }),
    provider({ routingBlocked: true, health: { ok: true } }), provider()
  ]));
  assert.equal(status.eligible, 1); assert.equal(status.healthy, 0); assert.equal(status.tone, 'unknown');
});

test('local-only status never counts a healthy remote source or implies it can be used', () => {
  const providers = [provider({ health: { ok: true } }), provider({ local: true, health: { ok: false } })];
  const status = sourceStatus(model(providers, { localOnly: true }));
  assert.equal(status.eligible, 1); assert.equal(status.healthy, 0); assert.equal(status.tone, 'fail');
  const absent = sourceStatus(model([providers[0]], { localOnly: true }));
  assert.equal(absent.title, 'Local source needed'); assert.match(absent.notice, /Remote data sources will not be used/);
});

test('offline status takes precedence over healthy sources without an implied health request', () => {
  const current = model([provider({ health: { ok: true } })], { offlineMode: true });
  assert.equal(sourceStatus(current).title, 'Offline');
  assert.equal(sourceStatus(current).tone, 'warn'); assert.match(sourceStatus(current).notice, /cached content/);
});

test('credential-recovery status reads no credential values and changes nothing', () => {
  const source = provider({ routingBlocked: true });
  Object.defineProperty(source, 'credentials', { get: () => assert.fail('No credential inspection allowed') });
  const current = Object.freeze(model(Object.freeze([Object.freeze(source)]), Object.freeze({ network: 'mainnet' })));
  const status = sourceStatus(current);
  assert.equal(status.eligible, 0); assert.equal(status.title, 'Review source setup'); assert.match(status.notice, /will not change credentials/);
  assert.doesNotMatch(status.notice, /sign-in required|need sign-in/);
});

test('demo-only sources do not receive the live-source success presentation', () => {
  const status = sourceStatus(model([provider({ type: 'mock', health: { ok: true }, local: true })]));
  assert.equal(status.demo, true); assert.equal(status.tone, 'warn'); assert.match(status.notice, /test data, not live/);
});

test('mixed unchecked and failed sources are not declared universally failed', () => {
  const status = sourceStatus(model([provider(), provider({ health: { ok: false } })]));
  assert.equal(status.failed, false); assert.equal(status.tone, 'unknown');
});

for (const [code, title, route] of [
  ['OFFLINE_CACHE_MISS', 'This page isn’t saved offline', 'settings'],
  ['NO_PROVIDER', 'A compatible data source is needed', 'providers'],
  ['NOT_FOUND', 'No result from this data source', 'providers'],
  ['INSCRIPTION_NOT_FOUND', 'No result from this data source', 'providers'],
  ['PROVIDER_TIMEOUT', 'The data source is taking too long', 'providers'],
  ['ETIMEDOUT', 'The data source is taking too long', 'providers'],
  ['NETWORK_TIMEOUT', 'The data source is taking too long', 'providers'],
  ['RESOURCE_TOO_LARGE', 'This item exceeds a browser limit', 'settings'],
  ['UNEXPECTED', 'This page couldn’t be loaded', 'providers']
]) test(`lookup recovery gives ${code} a plain-language next step without automatic changes`, () => {
  const error = Object.freeze({ code }); const settings = Object.freeze({});
  const recovery = lookupRecovery(error, settings);
  assert.equal(recovery.title, title); assert.equal(recovery.route, `satnav://${route}`);
  assert.ok(recovery.message.length > 40); assert.ok(recovery.action.length > 4);
});

test('offline cache-read failure is not misrepresented as cache absence', () => {
  const recovery = lookupRecovery({ code: 'CACHE_READ_FAILED' }, { offlineMode: true });
  assert.equal(recovery.title, 'The saved page could not be read');
  assert.match(recovery.message, /not proof the page was never saved/);
  assert.doesNotMatch(recovery.message, /not found|isn’t saved/i);
  assert.match(lookupRecovery({ code: 'NOT_FOUND' }).message, /does not prove the item does not exist/);
});

const styles = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const releaseStyles = fs.readFileSync(new URL('../src/renderer/release-ux.css', import.meta.url), 'utf8');
const tokens = text => Object.fromEntries([...text.matchAll(/--([\w-]+):([^;\n}]+)/g)].map(([, key, value]) => [key, value.trim()]));
const dark = tokens(styles.match(/:root\{([^}]+)\}/)[1]);
const light = { ...dark, ...tokens(styles.match(/:root\[data-theme="light"\]\{([^}]+)\}/)[1]) };
function luminance(value) {
  assert.match(value, /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
  const hex = value.length === 4 ? value.slice(1).split('').map(c => c + c).join('') : value.slice(1);
  const rgb = hex.match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function ratio(first, second) { const a = luminance(first), b = luminance(second); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
for (const [theme, palette] of [['dark', dark], ['light', light]]) test(`${theme} shared readable text tokens exceed 4.5:1 on base and selected surfaces`, () => {
  const resolve = token => palette[token].startsWith('var(') ? resolve(palette[token].slice(6, -1)) : palette[token];
  for (const foreground of ['text', 'text-2', 'muted', 'accent-ink', 'good', 'warn', 'bad', 'info']) {
    for (const background of ['bg', 'chrome', 'surface', 'surface-2', 'surface-3', 'hover', 'selected']) {
      const contrast = ratio(resolve(foreground), resolve(background));
      assert.ok(contrast >= 4.5, `${theme}: ${foreground} on ${background} is ${contrast.toFixed(2)}:1`);
    }
  }
  for (const background of ['bg', 'surface', 'selected']) assert.ok(ratio(resolve('focus-ring'), resolve(background)) >= 3);
});

test('release layout uses non-blocking loading, visible focus, larger hit areas and wrapped asset filters', () => {
  assert.match(releaseStyles, /\.page-loading\{[^}]*height:3px[^}]*pointer-events:none[^}]*backdrop-filter:none/);
  assert.match(releaseStyles, /\.tab-close\{[^}]*width:24px;height:24px/);
  assert.match(releaseStyles, /\.toggle\{width:42px;height:26px/);
  assert.match(releaseStyles, /\.side-item\{height:40px/);
  assert.match(releaseStyles, /\.tabs\{overflow-x:auto/);
  assert.match(releaseStyles, /\.inscription-filters\{flex-wrap:wrap;overflow-x:visible/);
  assert.match(releaseStyles, /\.main-stage:focus-visible\{outline:2px solid var\(--focus-ring\)/);
  assert.match(releaseStyles, /@media\(min-width:961px\) and \(max-width:1180px\)/);
  assert.match(releaseStyles, /@container\(max-width:750px\)\{\.home-explore\{grid-template-columns:minmax\(0,1fr\)/);
  assert.doesNotMatch(releaseStyles, /url\(|@import|https?:/);
});
