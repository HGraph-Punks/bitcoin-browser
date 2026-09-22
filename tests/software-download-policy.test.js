import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { NodeSoftware } from '../src/main/node-software.js';

const ORIGINS = Object.freeze([
  'https://bitcoincore.org', 'https://github.com',
  'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'
]);
const TOKEN = 'synthetic-signed-token-never-record';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A single inert archive member. The fixture is never executed or quarantined.
function archiveFor(member, bytes) {
  const header = Buffer.alloc(512);
  header.write(member, 0, 100);
  header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return zlib.gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512), Buffer.alloc(1024)]));
}

async function fixture(t, { kind = 'core', url = 'https://bitcoincore.org/bin/synthetic.tar.gz' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-download-policy-'));
  const bytes = Buffer.from('inert fixture bytes, not an executable');
  const member = kind === 'core' ? 'fixture/bin/bitcoind' : 'fixture/ord';
  const archive = archiveFor(member, bytes);
  const descriptor = {
    kind, name: 'Synthetic software', version: '1.0', url, sha256: sha(archive), member,
    format: 'tar.gz', executableName: kind === 'core' ? 'bitcoind' : 'ord'
  };
  const manager = new NodeSoftware({ directory, platform: 'test', arch: 'test' });
  manager.catalog = () => ({ core: null, ord: null, [kind]: descriptor });
  const finalDirectory = path.join(directory, kind, descriptor.version);
  t.after(async () => {
    try { await manager.shutdown(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  return { directory, finalDirectory, archive, bytes, descriptor, manager };
}

// Replace both protocol primitives and DNS so an unexpected target cannot cause
// real network activity. Only the production requestBuffer orchestrates hops.
function network(t, route, { lookup } = {}) {
  const requests = []; const lookups = [];
  t.mock.method(dns, 'lookup', async (hostname, options) => {
    lookups.push(hostname);
    return lookup ? lookup(hostname, options) : [{ address: '93.184.216.34', family: 4 }];
  });
  const request = (parsed, options, onResponse) => {
    const call = { url: new URL(parsed), options, index: requests.length };
    requests.push(call);
    const emitter = new EventEmitter();
    let ended = false;
    const onAbort = () => queueMicrotask(() => emitter.emit('error', options.signal.reason));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    emitter.write = () => { throw new Error('Software download must not send a request body'); };
    emitter.end = () => {
      assert.equal(ended, false); ended = true;
      queueMicrotask(() => {
        if (options.signal?.aborted) { emitter.emit('error', options.signal.reason); return; }
        const result = route(call);
        if (result?.pending) return;
        options.signal?.removeEventListener('abort', onAbort);
        if (result?.error) { emitter.emit('error', result.error); return; }
        const response = Readable.from(result?.body === undefined ? [] : [result.body]);
        response.statusCode = result?.status ?? 200;
        response.headers = result?.headers ?? {};
        response.statusMessage = result?.statusMessage ?? 'Synthetic response';
        onResponse(response);
      });
      return emitter;
    };
    return emitter;
  };
  t.mock.method(http, 'request', request);
  t.mock.method(https, 'request', request);
  return { requests, lookups };
}

const provenance = (responses) => ({ schemaVersion: 1, policy: 'https-software-origins-v1', responses });

async function noPublication(f) {
  assert.equal(await fs.access(f.finalDirectory).then(() => true, () => false), false);
}

function safeDownloadError(error, { policy = false, responses = [] } = {}) {
  assert.equal(error.code, policy ? 'SOFTWARE_DOWNLOAD_POLICY' : 'SOFTWARE_DOWNLOAD_FAILED');
  if (policy) { assert.equal(error.status, 403); assert.equal(error.retryable, false); }
  assert.equal(error.cause, undefined, 'raw transport causes must not survive the software boundary');
  assert.match(error.details?.reasonCode, /^[A-Z][A-Z0-9_]{0,63}$/);
  assert.deepEqual(error.details.downloadProvenance, responses.length ? provenance(responses) : null);
  const rendered = JSON.stringify({ message: error.message, stack: error.stack, details: error.details, cause: error.cause });
  for (const forbidden of [TOKEN, '/private-download/', 'access_token=', 'unapproved.example']) {
    assert.equal(rendered.includes(forbidden), false, `download error exposed ${forbidden}`);
  }
  assert.equal(rendered.includes('https://bitcoincore.org/bin/'), false);
  return true;
}

test('default software downloader records only actual response origins and keeps cached manifest format unchanged', async (t) => {
  const f = await fixture(t);
  const net = network(t, () => ({ body: f.archive }));
  const fresh = await f.manager.install('core');
  assert.deepEqual(fresh.downloadProvenance, provenance([{ origin: ORIGINS[0], status: 200 }]));
  assert.deepEqual(await fs.readFile(fresh.executable), f.bytes);
  assert.deepEqual(net.lookups, ['bitcoincore.org']);
  const manifestFile = path.join(f.finalDirectory, 'manifest.json');
  const manifestBefore = await fs.readFile(manifestFile);
  assert.deepEqual(JSON.parse(manifestBefore), {
    kind: 'core', version: '1.0', sha256: f.descriptor.sha256, executableSha256: sha(f.bytes)
  });
  const cached = await f.manager.install('core');
  assert.equal(cached.downloadProvenance, null, 'cached verification must not claim a fresh HTTP observation');
  assert.equal(cached.executable, fresh.executable);
  assert.equal(cached.sha256, fresh.sha256);
  assert.equal(net.requests.length, 1);
  assert.deepEqual(await fs.readFile(manifestFile), manifestBefore);
});

test('default Ord downloader follows approved GitHub CDN hops and retains signed query only in transient requests', async (t) => {
  const f = await fixture(t, { kind: 'ord', url: 'https://github.com/ordinals/ord/releases/download/fixture/ord.tar.gz' });
  const signed = `https://release-assets.githubusercontent.com/private-download/asset?access_token=${TOKEN}&part=1%2F2`;
  const final = `https://objects.githubusercontent.com/private-download/asset?access_token=${TOKEN}&part=1%2F2`;
  const net = network(t, ({ index }) => index === 0 ? { status: 302, headers: { location: signed } }
    : index === 1 ? { status: 307, headers: { location: final } } : { body: f.archive });
  const result = await f.manager.install('ord');
  assert.equal(net.requests[1].url.href, signed);
  assert.equal(net.requests[2].url.href, final);
  assert.deepEqual(net.lookups, ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  assert.deepEqual(result.downloadProvenance, provenance([
    { origin: ORIGINS[1], status: 302 }, { origin: ORIGINS[2], status: 307 }, { origin: ORIGINS[3], status: 200 }
  ]));
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes('/private-download/'), false);
  assert.equal((await fs.readFile(path.join(f.finalDirectory, 'manifest.json'), 'utf8')).includes(TOKEN), false);
  assert.deepEqual(await fs.readFile(result.executable), f.bytes);
});

test('software requests supply a frozen approved-origin snapshot, redirect bound, and response observer', async (t) => {
  const f = await fixture(t); let observed = false;
  f.manager.request = async (_url, options) => {
    assert.deepEqual(options.allowedOrigins, ORIGINS);
    assert.equal(Object.isFrozen(options.allowedOrigins), true);
    assert.equal(options.maxRedirects, 5);
    assert.equal(options.networkPolicy, 'remote');
    assert.equal(options.redirect, 'follow');
    assert.equal(typeof options.onResponse, 'function');
    options.onResponse(Object.freeze({ origin: ORIGINS[0], status: 200 }));
    observed = true;
    return { ok: true, status: 200, data: f.archive };
  };
  const result = await f.manager.install('core');
  assert.equal(observed, true);
  assert.deepEqual(result.downloadProvenance, provenance([{ origin: ORIGINS[0], status: 200 }]));
});

test('trusted injected downloader without response observations reports no invented provenance', async (t) => {
  const f = await fixture(t);
  f.manager.request = async () => ({ ok: true, status: 200, data: f.archive, url: `https://github.com/private-download/?access_token=${TOKEN}` });
  assert.equal((await f.manager.install('core')).downloadProvenance, null);
  assert.equal((await f.manager.install('core')).downloadProvenance, null);
});

for (const url of ['https://GITHUB.COM/fixture.tar.gz', 'https://github.com:443/fixture.tar.gz', 'https://%67ithub.com/fixture.tar.gz']) {
  test(`software retains standard canonical-origin compatibility for ${url}`, async (t) => {
    const f = await fixture(t, { url });
    const net = network(t, () => ({ body: f.archive }));
    const result = await f.manager.install('core');
    assert.deepEqual(net.lookups, ['github.com']);
    assert.equal(net.requests.length, 1);
    assert.deepEqual(result.downloadProvenance, provenance([{ origin: ORIGINS[1], status: 200 }]));
  });
}

const rejectedTargets = [
  ['unapproved origin', `https://unapproved.example/private-download/?access_token=${TOKEN}`],
  ['HTTPS downgrade', `http://bitcoincore.org/private-download/?access_token=${TOKEN}`],
  ['trailing-dot alias', `https://github.com./private-download/?access_token=${TOKEN}`],
  ['suffix lookalike', `https://github.com.unapproved.example/private-download/?access_token=${TOKEN}`],
  ['nondefault port', `https://github.com:8443/private-download/?access_token=${TOKEN}`],
  ['URL userinfo', `https://user:${TOKEN}@github.com/private-download/`]
];

for (const [label, target] of rejectedTargets) {
  test(`software initial ${label} is rejected before DNS and request admission`, async (t) => {
    const f = await fixture(t, { url: target });
    const net = network(t, () => ({ body: f.archive }));
    await assert.rejects(f.manager.install('core'), (error) => safeDownloadError(error, { policy: true }));
    assert.deepEqual(net.lookups, []); assert.deepEqual(net.requests, []);
    await noPublication(f);
  });
  test(`software redirect to ${label} is rejected before target DNS and request admission`, async (t) => {
    const f = await fixture(t);
    const net = network(t, ({ index }) => index === 0 ? { status: 302, headers: { location: target } } : { body: f.archive });
    await assert.rejects(f.manager.install('core'), (error) => safeDownloadError(error, {
      policy: true, responses: [{ origin: ORIGINS[0], status: 302 }]
    }));
    assert.deepEqual(net.lookups, ['bitcoincore.org']); assert.equal(net.requests.length, 1);
    await noPublication(f);
  });
}

test('software accepts exactly five approved redirect transitions before the final archive response', async (t) => {
  const f = await fixture(t);
  const net = network(t, ({ index }) => index < 5
    ? { status: 302, headers: { location: `/private-download/${index}?access_token=${TOKEN}` } }
    : { body: f.archive });
  const result = await f.manager.install('core');
  assert.equal(net.requests.length, 6); assert.equal(net.lookups.length, 6);
  assert.deepEqual(result.downloadProvenance, provenance([
    ...Array.from({ length: 5 }, () => ({ origin: ORIGINS[0], status: 302 })),
    { origin: ORIGINS[0], status: 200 }
  ]));
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('software redirect budget rejects a sixth transition without another request', async (t) => {
  const f = await fixture(t);
  const net = network(t, ({ index }) => ({ status: 302, headers: { location: `/private-download/${index}?access_token=${TOKEN}` } }));
  await assert.rejects(f.manager.install('core'), (error) => safeDownloadError(error, {
    policy: true, responses: Array.from({ length: 6 }, () => ({ origin: ORIGINS[0], status: 302 }))
  }));
  assert.equal(net.requests.length, 6); assert.equal(net.lookups.length, 6);
  await noPublication(f);
});

test('approved software hostname resolving to loopback is rejected before transport', async (t) => {
  const f = await fixture(t);
  const net = network(t, () => ({ body: f.archive }), { lookup: () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(f.manager.install('core'), (error) => safeDownloadError(error, { policy: true }));
  assert.deepEqual(net.lookups, ['bitcoincore.org']); assert.equal(net.requests.length, 0);
  await noPublication(f);
});

test('software transport failures retain bounded reason and safe provenance, not upstream error or signed URL', async (t) => {
  const f = await fixture(t);
  const upstream = new Error(`connection refused https://github.com/private-download/?access_token=${TOKEN}`);
  upstream.code = `CODE_${TOKEN}`;
  const net = network(t, ({ index }) => index === 0
    ? { status: 302, headers: { location: `https://github.com/private-download/?access_token=${TOKEN}` } }
    : { error: upstream });
  await assert.rejects(f.manager.install('core'), (error) => safeDownloadError(error, {
    responses: [{ origin: ORIGINS[0], status: 302 }]
  }));
  assert.equal(net.requests.length, 2);
  await noPublication(f);
});

test('software DNS errors are wrapped without hostname, token, or raw cause', async (t) => {
  const f = await fixture(t);
  const net = network(t, () => ({ body: f.archive }), {
    lookup: () => { throw new Error(`DNS response body https://unapproved.example/private-download/?access_token=${TOKEN}`); }
  });
  await assert.rejects(f.manager.install('core'), (error) => safeDownloadError(error));
  assert.equal(net.requests.length, 0);
  await noPublication(f);
});

test('software HTTP failure never publishes response body or executable', async (t) => {
  const f = await fixture(t);
  network(t, () => ({ status: 503, statusMessage: TOKEN, body: Buffer.from(`private-download/${TOKEN}`) }));
  await assert.rejects(f.manager.install('core'), (error) => safeDownloadError(error, {
    responses: [{ origin: ORIGINS[0], status: 503 }]
  }));
  await noPublication(f);
});

test('caller cancellation during real default transport preserves the exact reason and never publishes', async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  let enter; const entered = new Promise((resolve) => { enter = resolve; });
  const net = network(t, () => { enter(); return { pending: true }; });
  const reason = new Error('Synthetic caller cancellation');
  const pending = f.manager.install('core', { signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error === reason);
  await entered; controller.abort(reason); await rejected;
  assert.equal(net.requests.length, 1);
  await noPublication(f);
});

test('shutdown aborts and drains the real default downloader with the application shutdown reason', async (t) => {
  const f = await fixture(t);
  let enter; const entered = new Promise((resolve) => { enter = resolve; });
  const net = network(t, () => { enter(); return { pending: true }; });
  const pending = f.manager.install('core');
  const rejected = assert.rejects(pending, { code: 'APP_SHUTTING_DOWN' });
  await entered; await f.manager.shutdown(); await rejected;
  assert.equal(net.requests.length, 1);
  assert.equal(f.manager.pending.size, 0);
  await noPublication(f);
});

for (const phase of ['version directory', 'missing manifest']) {
  test(`cancellation during ${phase} metadata is checked before default download admission`, async (t) => {
    const f = await fixture(t); const controller = new AbortController();
    const reason = new Error(`Synthetic ${phase} cancellation`);
    const cancelAt = phase === 'version directory' ? f.finalDirectory : path.join(f.finalDirectory, 'manifest.json');
    let reached = false;
    f.manager.fs = {
      ...fs,
      lstat: async (file, ...args) => {
        try { return await fs.lstat(file, ...args); }
        finally { if (file === cancelAt) { reached = true; controller.abort(reason); } }
      }
    };
    const net = network(t, () => ({ body: f.archive }));
    await assert.rejects(f.manager.install('core', { signal: controller.signal }), (error) => error === reason);
    assert.equal(reached, true);
    assert.deepEqual(net.lookups, []); assert.deepEqual(net.requests, []);
    await noPublication(f);
  });
}

test('caller cancellation while resolving a download hostname prevents transport admission', async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  const reason = new Error('Synthetic DNS cancellation');
  const net = network(t, () => ({ body: f.archive }), {
    lookup: () => { controller.abort(reason); return [{ address: '93.184.216.34', family: 4 }]; }
  });
  await assert.rejects(f.manager.install('core', { signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(net.lookups, ['bitcoincore.org']); assert.equal(net.requests.length, 0);
  await noPublication(f);
});
