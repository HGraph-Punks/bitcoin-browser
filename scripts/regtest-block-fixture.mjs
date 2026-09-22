import { createHash } from 'node:crypto';

// Offline, no-wallet fixture for the separately approved D-02 native harness.
// Serialization/rules were checked against these pinned Bitcoin Core 31.1 sources:
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/primitives/block.h
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/primitives/transaction.h
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/kernel/chainparams.cpp
// https://github.com/bitcoin/bitcoin/blob/v31.1/test/functional/test_framework/blocktools.py
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/consensus/merkle.cpp
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/consensus/tx_check.cpp
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/validation.cpp
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/script/script.h
// https://github.com/bitcoin/bitcoin/blob/v31.1/src/pow.cpp
// The builder does not execute Core or establish its acceptance/readiness.

export const REGTEST_BITS = '207fffff';
export const REGTEST_TARGET_HEX = '7fffff0000000000000000000000000000000000000000000000000000000000';
export const MAX_REGTEST_NONCE_ATTEMPTS = 65_536;

const UINT32_MAX = 0xffffffff;
const TARGET = BigInt(`0x${REGTEST_TARGET_HEX}`);
const INPUT_KEYS = new Set([
  'previousBlockHash', 'height', 'timestamp', 'bits', 'targetHex',
  'startNonce', 'maxNonceAttempts'
]);

function invalid(message) {
  return Object.assign(new TypeError(message), { code: 'REGTEST_FIXTURE_INPUT' });
}

function assertInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function hash256(bytes) {
  return createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();
}

function displayedHash(bytes) {
  return Buffer.from(bytes).reverse().toString('hex');
}

function coinbaseHeight(height) {
  // CScript << nHeight uses OP_1..OP_16 at small heights. A trailing OP_0
  // makes these scripts satisfy the consensus minimum of two scriptSig bytes.
  if (height <= 16) return Buffer.from([0x50 + height, 0x00]);
  const encoded = [];
  let remaining = height;
  while (remaining > 0) {
    encoded.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  // CScriptNum is signed-magnitude little-endian; positive values whose high
  // bit is set need a sign-padding byte before the minimal direct data push.
  if (encoded.at(-1) & 0x80) encoded.push(0x00);
  return Buffer.from([encoded.length, ...encoded]);
}

/**
 * Build one bounded, deterministic, regtest-only proof-of-work fixture.
 *
 * Required: display-order previousBlockHash, next height, uint32 timestamp,
 * and the exact REGTEST_BITS string. An explicitly supplied targetHex must
 * equal its decoded target (not the slightly larger chain powLimit).
 *
 * There is exactly one non-witness coinbase and one zero-value OP_RETURN
 * output. All subsidy is deliberately unclaimed, including after halvings.
 * There is no recipient, spendable output, wallet or inscription fixture.
 *
 * Before submitting, the caller MUST independently verify the RPC chain is
 * regtest, the previous hash/height still match its tip, and the timestamp is
 * above median-time-past and within Core's wall-clock future bound. This pure
 * function cannot prove those contextual facts, Core acceptance, IBD exit,
 * txindex completion, or Ord indexing. No RPC or submit operation is included.
 */
export function buildRegtestBlock(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw invalid('Fixture options must be a plain object.');
  }
  for (const key of Reflect.ownKeys(options)) {
    if (!INPUT_KEYS.has(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) {
      throw invalid('Fixture options may contain only supported data fields.');
    }
  }
  const {
    previousBlockHash, height, timestamp, bits,
    targetHex = REGTEST_TARGET_HEX,
    startNonce = 0,
    maxNonceAttempts = 4096
  } = options;
  if (typeof previousBlockHash !== 'string' || !/^[0-9a-f]{64}$/.test(previousBlockHash)
    || previousBlockHash === '0'.repeat(64)) {
    throw invalid('previousBlockHash must be a nonzero, lowercase, 32-byte display-order hash.');
  }
  assertInteger(height, 'height', 1, 0x7fffffff);
  assertInteger(timestamp, 'timestamp', 1, UINT32_MAX);
  if (bits !== REGTEST_BITS || targetHex !== REGTEST_TARGET_HEX) {
    throw invalid('Only the exact standard regtest bits and decoded target are supported.');
  }
  assertInteger(startNonce, 'startNonce', 0, UINT32_MAX);
  assertInteger(maxNonceAttempts, 'maxNonceAttempts', 1, MAX_REGTEST_NONCE_ATTEMPTS);
  if (startNonce + maxNonceAttempts - 1 > UINT32_MAX) {
    throw invalid('The bounded nonce window must not wrap uint32.');
  }

  const scriptSig = coinbaseHeight(height);
  const coinbase = Buffer.concat([
    uint32(2),                           // transaction version
    Buffer.from([0x01]),                 // one input, CompactSize
    Buffer.alloc(32), uint32(UINT32_MAX), // null coinbase outpoint
    Buffer.from([scriptSig.length]), scriptSig,
    uint32(UINT32_MAX),                  // final sequence
    Buffer.from([0x01]),                 // one output, CompactSize
    Buffer.alloc(8),                     // zero satoshis; never claim subsidy
    Buffer.from([0x01, 0x6a]),           // one-byte script: OP_RETURN
    uint32(0)                           // no locktime
  ]);
  const merkleBytes = hash256(coinbase);  // one transaction: no pair rehash
  const header = Buffer.concat([
    uint32(4),
    Buffer.from(previousBlockHash, 'hex').reverse(),
    merkleBytes,
    uint32(timestamp), uint32(Number.parseInt(bits, 16)), uint32(startNonce)
  ]);
  for (let attempt = 0; attempt < maxNonceAttempts; attempt += 1) {
    const nonce = startNonce + attempt;
    header.writeUInt32LE(nonce, 76);
    const blockHash = displayedHash(hash256(header));
    if (BigInt(`0x${blockHash}`) <= TARGET) {
      return Object.freeze({
        network: 'regtest',
        blockHex: Buffer.concat([header, Buffer.from([0x01]), coinbase]).toString('hex'),
        blockHash,
        headerHex: header.toString('hex'),
        coinbaseHex: coinbase.toString('hex'),
        coinbaseTxId: displayedHash(merkleBytes),
        merkleRoot: displayedHash(merkleBytes),
        previousBlockHash,
        height,
        timestamp,
        bits,
        targetHex,
        nonce,
        nonceAttempts: attempt + 1,
        transactionCount: 1,
        coinbaseValueSats: 0,
        coinbaseOutputScriptHex: '6a',
        hasWitness: false,
        nativeAcceptance: 'NOT RUN'
      });
    }
  }
  throw Object.assign(new Error('No proof of work found inside the explicit regtest nonce window.'), {
    code: 'REGTEST_FIXTURE_NONCE_EXHAUSTED',
    nonceAttempts: maxNonceAttempts,
    startNonce,
    endNonce: startNonce + maxNonceAttempts - 1
  });
}
