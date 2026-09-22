import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  buildRegtestBlock, REGTEST_BITS, REGTEST_TARGET_HEX, MAX_REGTEST_NONCE_ATTEMPTS
} from '../scripts/regtest-block-fixture.mjs';

// Public regtest genesis identity from pinned Core v31.1 chainparams.cpp.
const GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const INPUT = Object.freeze({
  previousBlockHash: GENESIS, height: 1, timestamp: 1296688603, bits: '207fffff'
});

// These bytes were constructed independently field-by-field, not captured from
// buildRegtestBlock. Hashes were computed with WebCrypto from these literals.
const COINBASE = '02000000' + '01'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + 'ffffffff' + '02' + '5100' + 'ffffffff' + '01'
  + '0000000000000000' + '01' + '6a' + '00000000';
const TXID = '42fe58ad64c8b106c64db02e5c0ece11a370418d8419458885fd32a9abbe1f4f';
const HEADER = '04000000'
  + '06226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f'
  + '4f1fbeaba932fd85884519848d4170a311ce0e5c2eb04dc606b1c864ad58fe42'
  + 'dbe5494d' + 'ffff7f20' + '00000000';
const HASH = '3d9ebdfaed50832adab26965b1b9f52994ecd08bdb8c9a740457fdd033045dc7';

async function independentlyHash(bytes) {
  const first = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(await webcrypto.subtle.digest('SHA-256', first));
}

function fixture(overrides = {}) {
  return buildRegtestBlock({ ...INPUT, ...overrides });
}

function expectInputError(overrides) {
  assert.throws(() => fixture(overrides), { name: 'TypeError', code: 'REGTEST_FIXTURE_INPUT' });
}

test('offline fixture matches independent coinbase, merkle, header, hash and complete block bytes', () => {
  const block = fixture({ maxNonceAttempts: 1 });
  assert.equal(block.coinbaseHex, COINBASE);
  assert.equal(block.coinbaseTxId, TXID);
  assert.equal(block.merkleRoot, TXID);
  assert.equal(block.headerHex, HEADER);
  assert.equal(block.blockHash, HASH);
  assert.equal(block.blockHex, HEADER + '01' + COINBASE);
  assert.equal(block.headerHex.length / 2, 80);
  assert.equal(block.coinbaseHex.length / 2, 63);
  assert.equal(block.blockHex.length / 2, 144);
  assert.equal(block.nonce, 0);
  assert.equal(block.nonceAttempts, 1);
});

test('independent WebCrypto rehashes the literal vector and confirms little-endian proof of work', async () => {
  const txDigest = await independentlyHash(Buffer.from(COINBASE, 'hex'));
  const headerDigest = await independentlyHash(Buffer.from(HEADER, 'hex'));
  assert.equal(Buffer.from(txDigest).reverse().toString('hex'), TXID);
  assert.equal(Buffer.from(headerDigest).reverse().toString('hex'), HASH);
  assert.equal(Buffer.from(HEADER, 'hex').subarray(36, 68).toString('hex'), txDigest.toString('hex'));
  const numericHash = [...headerDigest].reduce((value, byte, index) => value + (BigInt(byte) << BigInt(index * 8)), 0n);
  const target = 0x7fffffn << (8n * (0x20n - 3n));
  assert.equal(numericHash.toString(16).padStart(64, '0'), HASH);
  assert.ok(numericHash <= target);
  assert.equal(target.toString(16).padStart(64, '0'), REGTEST_TARGET_HEX);
  assert.equal(REGTEST_BITS, '207fffff');
  assert.ok(target < ((1n << 255n) - 1n), 'compact target is not the full regtest powLimit');
});

test('BIP34 scriptSig uses independently specified minimal small-number and sign-padding boundaries', () => {
  const cases = [
    [1, '5100'], [2, '5200'], [16, '6000'], [17, '0111'], [127, '017f'],
    [128, '028000'], [150, '029600'], [255, '02ff00'], [256, '020001'],
    [32767, '02ff7f'], [32768, '03008000'], [65535, '03ffff00'], [65536, '03000001'],
    [8388607, '03ffff7f'], [8388608, '0400008000'], [2147483647, '04ffffff7f']
  ];
  for (const [height, expectedScript] of cases) {
    const tx = Buffer.from(fixture({ height }).coinbaseHex, 'hex');
    assert.equal(tx[41], expectedScript.length / 2, `script size at ${height}`);
    assert.equal(tx.subarray(42, 42 + tx[41]).toString('hex'), expectedScript, `script at ${height}`);
    assert.ok(tx[41] >= 2 && tx[41] <= 100);
  }
});

test('coinbase has no witness, no spending destination, zero value and only OP_RETURN at every boundary', () => {
  for (const height of [1, 16, 17, 128, 149, 150, 151, 9600, 2147483647]) {
    const block = fixture({ height });
    const tx = Buffer.from(block.coinbaseHex, 'hex');
    assert.equal(tx.readUInt32LE(0), 2);
    assert.equal(tx[4], 1, 'one input; no SegWit marker/flag');
    assert.equal(tx.subarray(5, 37).toString('hex'), '00'.repeat(32));
    assert.equal(tx.readUInt32LE(37), 0xffffffff);
    let offset = 42 + tx[41];
    assert.equal(tx.readUInt32LE(offset), 0xffffffff, 'final input sequence'); offset += 4;
    assert.equal(tx[offset++], 1, 'exactly one output');
    assert.equal(tx.readBigUInt64LE(offset), 0n, 'subsidy always unclaimed'); offset += 8;
    assert.equal(tx[offset++], 1, 'one script byte');
    assert.equal(tx[offset++], 0x6a, 'OP_RETURN is unspendable for any stack');
    assert.equal(tx.readUInt32LE(offset), 0, 'no locktime'); offset += 4;
    assert.equal(offset, tx.length, 'no hidden outputs, witness, or trailing bytes');
    assert.equal(block.coinbaseValueSats, 0);
    assert.equal(block.coinbaseOutputScriptHex, '6a');
    assert.equal(block.hasWitness, false);
    assert.equal(block.transactionCount, 1);
    assert.equal(block.nativeAcceptance, 'NOT RUN');
  }
});

test('nonce exhaustion is bounded and a later valid nonce requires an explicitly wider window', async () => {
  const failedHeader = Buffer.from(HEADER, 'hex'); failedHeader.writeUInt32LE(2, 76);
  const failedHash = Buffer.from(await independentlyHash(failedHeader)).reverse().toString('hex');
  assert.equal(failedHash, 'da48449b6e146a499eb4b0ca8ab37c5922e6637115dc414f0328c1a7a4eb6c3d');
  assert.ok(BigInt(`0x${failedHash}`) > BigInt(`0x${REGTEST_TARGET_HEX}`));
  assert.throws(() => fixture({ startNonce: 2, maxNonceAttempts: 1 }), error => {
    assert.equal(error.code, 'REGTEST_FIXTURE_NONCE_EXHAUSTED');
    assert.equal(error.nonceAttempts, 1);
    assert.equal(error.startNonce, 2);
    assert.equal(error.endNonce, 2);
    return true;
  });
  const block = fixture({ startNonce: 2, maxNonceAttempts: 2 });
  assert.equal(block.nonce, 3);
  assert.equal(block.nonceAttempts, 2);
  assert.equal(block.blockHash, '0c9f4707603fc8fb1c6dfa0fcd93a7da4bfed1041795060d0e335615ba28180e');
});

test('uint32 final nonce is tested once without implicit wrapping or widening', async () => {
  const header = Buffer.from(HEADER, 'hex'); header.writeUInt32LE(0xffffffff, 76);
  const hash = Buffer.from(await independentlyHash(header)).reverse().toString('hex');
  if (BigInt(`0x${hash}`) <= BigInt(`0x${REGTEST_TARGET_HEX}`)) {
    const block = fixture({ startNonce: 0xffffffff, maxNonceAttempts: 1 });
    assert.equal(block.blockHash, hash);
    assert.equal(block.nonce, 0xffffffff);
    assert.equal(block.nonceAttempts, 1);
  } else {
    assert.throws(() => fixture({ startNonce: 0xffffffff, maxNonceAttempts: 1 }), {
      code: 'REGTEST_FIXTURE_NONCE_EXHAUSTED', startNonce: 0xffffffff, endNonce: 0xffffffff, nonceAttempts: 1
    });
  }
  expectInputError({ startNonce: 0xffffffff, maxNonceAttempts: 2 });
  expectInputError({ startNonce: 0xfffffffe, maxNonceAttempts: 3 });
});

test('explicit hash, timestamp and next-height inputs are serialized without clock or chain substitution', async () => {
  const previousBlockHash = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  for (const timestamp of [1, 0xffffffff]) {
    const block = fixture({ previousBlockHash, timestamp, height: 128 });
    const header = Buffer.from(block.headerHex, 'hex');
    assert.equal(header.subarray(4, 36).toString('hex'), '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
    assert.equal(header.readUInt32LE(68), timestamp);
    assert.equal(header.readUInt32LE(72), 0x207fffff);
    assert.equal(header.readUInt32LE(76), block.nonce);
    assert.equal(Buffer.from(await independentlyHash(header)).reverse().toString('hex'), block.blockHash);
    assert.equal(block.previousBlockHash, previousBlockHash);
    assert.equal(block.height, 128);
    assert.equal(block.timestamp, timestamp);
    assert.equal(block.nativeAcceptance, 'NOT RUN', 'range validity is not contextual chain acceptance');
  }
});

test('same explicit inputs give immutable identical public output and distinct heights give distinct coinbases', () => {
  const options = Object.freeze({ ...INPUT, targetHex: REGTEST_TARGET_HEX });
  const block = buildRegtestBlock(options);
  assert.deepEqual(buildRegtestBlock(options), block);
  assert.ok(Object.isFrozen(block));
  assert.throws(() => { block.coinbaseOutputScriptHex = '51'; }, TypeError);
  assert.ok(Object.values(block).every(value => value === null || typeof value !== 'object'));
  assert.notEqual(fixture({ height: 2 }).coinbaseTxId, block.coinbaseTxId);
  assert.deepEqual(options, { ...INPUT, targetHex: REGTEST_TARGET_HEX });
});

test('malformed option containers and unsupported or accessor fields are rejected without evaluation', () => {
  for (const options of [undefined, null, [], '', 1, true, new Date(0), Object.create(INPUT)]) {
    assert.throws(() => buildRegtestBlock(options), { code: 'REGTEST_FIXTURE_INPUT' });
  }
  for (const key of ['wallet', 'address', 'scriptPubKey', 'coinbaseValueSats', 'transactions', 'network', Symbol('hidden')]) {
    expectInputError({ [key]: 'not-allowed' });
  }
  let getterCalls = 0;
  const options = { ...INPUT };
  Object.defineProperty(options, 'height', { get() { getterCalls += 1; return 1; } });
  assert.throws(() => buildRegtestBlock(options), { code: 'REGTEST_FIXTURE_INPUT' });
  assert.equal(getterCalls, 0);
  assert.equal(buildRegtestBlock(Object.assign(Object.create(null), INPUT)).blockHash, HASH);
});

test('missing, noncanonical, zero and wrong-sized previous hashes are rejected', () => {
  for (const previousBlockHash of [undefined, null, 1, '', '0'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), GENESIS.toUpperCase(), ` ${GENESIS}`, `${GENESIS}\n`, 'g'.repeat(64)]) {
    expectInputError({ previousBlockHash });
  }
});

test('height and timestamp reject coercion, negative, noninteger, unsafe and out-of-range values', () => {
  for (const height of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, 0x80000000, Number.MAX_SAFE_INTEGER, 1n]) {
    expectInputError({ height });
  }
  for (const timestamp of [undefined, null, '1296688603', 0, -1, 1.5, NaN, Infinity, 0x100000000, Number.MAX_SAFE_INTEGER, 1n]) {
    expectInputError({ timestamp });
  }
});

test('bits and target reject other networks, negative or overflow compacts and relaxed pow limits', () => {
  for (const bits of [undefined, null, 0x207fffff, '', '1d00ffff', '1e0377ae', '207FFFFF', '20800001', '23000001', '00000000', '207ffffe', '207fffff00']) {
    expectInputError({ bits });
  }
  for (const targetHex of [null, 0n, '', '00'.repeat(32), '7f' + 'ff'.repeat(31), 'ff'.repeat(32), REGTEST_TARGET_HEX.toUpperCase(), REGTEST_TARGET_HEX.slice(2)]) {
    expectInputError({ targetHex });
  }
});

test('nonce start and work limit reject coercion and unbounded or empty searches', () => {
  assert.equal(MAX_REGTEST_NONCE_ATTEMPTS, 65_536);
  for (const startNonce of [null, '0', -1, 0.1, NaN, Infinity, 0x100000000, Number.MAX_SAFE_INTEGER, 0n]) {
    expectInputError({ startNonce });
  }
  for (const maxNonceAttempts of [null, '1', 0, -1, 0.1, NaN, Infinity, MAX_REGTEST_NONCE_ATTEMPTS + 1, Number.MAX_SAFE_INTEGER, 1n]) {
    expectInputError({ maxNonceAttempts });
  }
  assert.equal(fixture({ maxNonceAttempts: MAX_REGTEST_NONCE_ATTEMPTS }).nonceAttempts, 1);
});
