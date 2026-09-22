import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DONATION } from '../src/shared/donation.js';
import { parseNavigationInput } from '../src/shared/navigation.js';
import { installAppProtocol } from '../src/main/app-protocol.js';
import { renderDonation } from '../src/renderer/donation.js';

const bytes = name => fs.readFileSync(new URL(`../${name}`, import.meta.url));
class TestNode {
  constructor(tag, text = '') { this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ''; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase()) ? [child] : [],
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.Node = TestNode;
globalThis.document = { createElement: tag => new TestNode(tag), createTextNode: text => new TestNode('#text', String(text)) };
function fixture(overrides = {}) {
  const copies = [], opened = [];
  const root = renderDonation({
    copy: async value => { copies.push(value); return true; },
    openExternal: async value => { opened.push(value); return true; },
    navigate: assert.fail, wallet: { connect: assert.fail, signPsbt: assert.fail }, ...overrides
  });
  return { root, copies, opened, copy: root.querySelector('.donation-copy'), open: root.querySelector('.donation-open'), status: root.querySelector('.donation-status') };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('the immutable donation recipient matches the owner file and a valid mainnet Base58Check address', () => {
  assert.equal(DONATION.address, '1NrPJqSjJ6edVExCQrRv5e7sY367jbiyem');
  assert.equal(DONATION.address, bytes('donation-ledger-btc.md').toString('utf8').trim());
  assert.equal(Object.isFrozen(DONATION), true); assert.equal(DONATION.network, 'mainnet');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of DONATION.address) { const digit = alphabet.indexOf(char); assert.ok(digit >= 0); value = value * 58n + BigInt(digit); }
  let hex = value.toString(16); if (hex.length % 2) hex = `0${hex}`;
  const decoded = Buffer.concat([Buffer.alloc(DONATION.address.match(/^1*/)[0].length), Buffer.from(hex, 'hex')]);
  assert.equal(decoded.length, 25); assert.equal(decoded[0], 0, 'Mainnet P2PKH version');
  const sha = value => createHash('sha256').update(value).digest();
  assert.ok(decoded.subarray(21).equals(sha(sha(decoded.subarray(0, 21))).subarray(0, 4)));
  const uri = new URL(DONATION.uri);
  assert.equal(uri.protocol, 'bitcoin:'); assert.equal(uri.pathname, DONATION.address);
  assert.equal(uri.search + uri.hash + uri.host, '', 'No preset amount, payment endpoint, callback or other parameters');
  assert.equal(parseNavigationInput(DONATION.uri).value, DONATION.uri);
  assert.equal(parseNavigationInput(DONATION.uri).kind, 'payment');
});

test('the locally bundled QR is an unchanged copy of the owner-supplied image', () => {
  const png = bytes('src/renderer/assets/donation-qr.png');
  // Independently decoded with the native Core Image QR detector on 2026-09-21.
  // Decode again if either source changes; do not silently replace the recipient.
  assert.ok(png.equals(bytes('Screen Shot 2026-09-05 at 12.35.54 AM.png')));
  assert.equal(png.length, 17603);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [418, 418]);
  assert.equal(DONATION.qr, './assets/donation-qr.png');
});

test('the QR is available offline through the existing protected application origin', async () => {
  let handler;
  installAppProtocol({ protocol: { handle: (_scheme, value) => { handler = value; } } }, fileURLToPath(new URL('../', import.meta.url)), null);
  const response = await handler(new Request(new URL(DONATION.qr, 'app://app/renderer/index.html')));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes('src/renderer/assets/donation-qr.png')));
});

test('initial render is passive, shows the complete mainnet address and does not depend on current browsing network', () => {
  for (const network of ['mainnet', 'testnet', 'signet', 'regtest']) {
    const f = fixture({ model: { settings: { network }, address: 'UNTRUSTED_RECIPIENT' } });
    assert.deepEqual(f.copies, []); assert.deepEqual(f.opened, []);
    assert.equal(f.root.querySelector('.donation-address').textContent, DONATION.address);
    assert.match(f.root.textContent, /Bitcoin · mainnet/); assert.match(f.root.textContent, /not Lightning/);
    assert.match(f.root.textContent, /not inscriptions or Runes/); assert.match(f.root.textContent, /never sends funds automatically/);
    assert.doesNotMatch(f.root.textContent, /UNTRUSTED_RECIPIENT/);
    assert.equal(f.root.querySelector('img').getAttribute('src'), DONATION.qr);
    assert.equal(f.root.querySelector('img').getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(f.status.getAttribute('role'), 'status'); assert.equal(f.status.getAttribute('aria-atomic'), 'true');
    assert.equal(f.root.querySelectorAll('button').length, 2);
    for (const tag of ['a', 'form', 'input', 'iframe', 'script', 'canvas']) assert.equal(f.root.querySelectorAll(tag).length, 0);
  }
});

test('copy acts only on the immutable address and reports success only after clipboard confirmation', async () => {
  const gate = deferred(), values = [], f = fixture({ copy: value => { values.push(value); return gate.promise; } });
  f.root.querySelector('.donation-address').textContent = 'UNTRUSTED_DOM_TEXT';
  const pending = f.copy.listeners.click({ target: { value: 'UNTRUSTED_EVENT' } });
  assert.equal(f.copy.disabled, true); assert.equal(f.status.textContent, '');
  await f.copy.listeners.click(); assert.deepEqual(values, [DONATION.address]);
  gate.resolve(true); await pending;
  assert.match(f.status.textContent, /Address copied/); assert.equal(f.copy.disabled, false); assert.deepEqual(f.opened, []);
});

test('clipboard failures remain recoverable without falsely claiming success or exposing raw errors', async () => {
  for (const outcome of [false, undefined, 'throws']) {
    const f = fixture({ copy: async () => { if (outcome === 'throws') throw Error('PRIVATE_ERROR_DETAIL'); return outcome; } });
    await f.copy.listeners.click();
    assert.match(f.status.textContent, /Could not copy/); assert.match(f.status.textContent, /full address/);
    assert.doesNotMatch(f.status.textContent, /Address copied|PRIVATE_ERROR_DETAIL/);
    assert.equal(f.copy.disabled, false); assert.equal(f.root.querySelector('.donation-address').textContent, DONATION.address);
  }
});

test('wallet opening forwards only the fixed amount-free URI, blocks double activation and never claims a donation was sent', async () => {
  const gate = deferred(), opened = [], f = fixture({ openExternal: url => { opened.push(url); return gate.promise; } });
  const pending = f.open.listeners.click({ target: { href: 'bitcoin:UNTRUSTED_ADDRESS?amount=10' } });
  assert.equal(f.open.disabled, true); await f.open.listeners.click(); assert.deepEqual(opened, [DONATION.uri]);
  gate.resolve(true); await pending;
  assert.match(f.status.textContent, /not a payment confirmation/); assert.match(f.status.textContent, /choose an amount/);
  assert.equal(f.open.disabled, false); assert.deepEqual(f.copies, []);
});

test('wallet cancellation and missing-handler errors preserve the card and usable copy/scan alternatives', async () => {
  for (const code of ['USER_REJECTED', 'OPEN_FAILED']) {
    const f = fixture({ openExternal: async () => { throw Object.assign(Error('PRIVATE_ERROR_DETAIL'), { code }); } });
    await f.open.listeners.click();
    assert.match(f.status.textContent, code === 'USER_REJECTED' ? /canceled/ : /Could not open a wallet/);
    assert.match(f.status.textContent, /copy the address|Copy the address/); assert.match(f.status.textContent, /QR code/);
    assert.doesNotMatch(f.status.textContent, /PRIVATE_ERROR_DETAIL|Wallet request opened/);
    assert.equal(f.open.disabled, false);
    await f.copy.listeners.click(); assert.deepEqual(f.copies, [DONATION.address]);
  }
});

test('late feedback from an older action cannot overwrite the latest donation action status', async () => {
  const gate = deferred(), f = fixture({ copy: () => gate.promise });
  const copying = f.copy.listeners.click(); await f.open.listeners.click();
  gate.resolve(true); await copying;
  assert.match(f.status.textContent, /Wallet request opened/);
});

test('an unavailable QR retains the recipient and both actions without a remote fallback', async () => {
  const f = fixture(), image = f.root.querySelector('img');
  image.listeners.error(); assert.equal(image.hidden, true); assert.equal(image.getAttribute('src'), DONATION.qr);
  assert.match(f.root.querySelector('figcaption').textContent, /QR unavailable/);
  assert.equal(f.root.querySelector('.donation-address').textContent, DONATION.address);
  await f.copy.listeners.click(); assert.deepEqual(f.copies, [DONATION.address]);
});

test('donation styles retain the QR quiet zone, selectable full address and keyboard feedback without extra scrolling', () => {
  const css = bytes('src/renderer/donation.css').toString('utf8');
  assert.match(bytes('src/renderer/index.html').toString('utf8'), /href="\.\/donation\.css"/);
  assert.match(css, /\.donation-qr\s*\{[^}]*background:\s*#fff/);
  assert.match(css, /object-fit:\s*contain/); assert.match(css, /\.donation-qr\[hidden\]/);
  assert.match(css, /user-select:\s*all/); assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /focus-visible/); assert.match(css, /min-height:\s*44px/);
  assert.doesNotMatch(css, /filter:|overflow(?:-x|-y)?:\s*(?:auto|scroll)|url\(|@import/);
  const source = bytes('src/renderer/donation.js').toString('utf8');
  assert.doesNotMatch(source, /fetch\(|innerHTML|window\.open|signPsbt\(|signMessage\(|wallet\.connect|localStorage/);
});
