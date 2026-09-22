import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPsbt } from '../src/main/psbt-inspector.js';

function fixturePsbt() {
  const unsignedTx = Buffer.concat([
    Buffer.from('02000000', 'hex'),
    Buffer.from([1]), Buffer.alloc(32), Buffer.from('00000000', 'hex'), Buffer.from([0]), Buffer.from('ffffffff', 'hex'),
    Buffer.from([1]), Buffer.from('e803000000000000', 'hex'), Buffer.from([22]), Buffer.from(`0014${'00'.repeat(20)}`, 'hex'),
    Buffer.from('00000000', 'hex')
  ]);
  return Buffer.concat([
    Buffer.from('70736274ff', 'hex'),
    Buffer.from([1, 0, unsignedTx.length]), unsignedTx,
    Buffer.from([0]),
    Buffer.from([0]),
    Buffer.from([0])
  ]);
}

function mapPair(type, value) {
  return Buffer.concat([Buffer.from([1, type, value.length]), value]);
}

function fixturePsbtV2(overrides = {}) {
  const globalMap = Buffer.concat([
    mapPair(0xfb, overrides.version ?? Buffer.from('02000000', 'hex')),
    mapPair(0x02, Buffer.from('02000000', 'hex')),
    mapPair(0x04, Buffer.from([1])),
    mapPair(0x05, Buffer.from([1])),
    Buffer.from([0])
  ]);
  const inputMap = Buffer.concat([
    mapPair(0x0e, Buffer.alloc(32)),
    mapPair(0x0f, Buffer.from('00000000', 'hex')),
    Buffer.from([0])
  ]);
  const outputFields = [];
  if (!overrides.omitAmount) outputFields.push(mapPair(0x03, Buffer.from('e803000000000000', 'hex')));
  if (!overrides.omitScript) outputFields.push(mapPair(0x04, Buffer.from(`0014${'00'.repeat(20)}`, 'hex')));
  return Buffer.concat([Buffer.from('70736274ff', 'hex'), globalMap, inputMap, ...outputFields, Buffer.from([0])]);
}

test('inspects a deterministic PSBT without network access', () => {
  const psbt = fixturePsbt();
  const preview = inspectPsbt(psbt.toString('base64'), 'mainnet');
  assert.equal(preview.psbtVersion, 0);
  assert.equal(preview.inputCount, 1);
  assert.equal(preview.outputCount, 1);
  assert.equal(preview.totalOutput, 1000);
  assert.equal(preview.outputs[0].scriptType, 'p2wpkh');
  assert.match(preview.outputs[0].address, /^bc1q/);
  assert.equal(preview.feeKnown, false);
  assert.equal(preview.sha256.length, 64);
});

test('accepts hex and rejects malformed payloads', () => {
  const preview = inspectPsbt(fixturePsbt().toString('hex'), 'signet');
  assert.equal(preview.encoding, 'hex');
  assert.match(preview.outputs[0].address, /^tb1q/);
  assert.throws(() => inspectPsbt('not a psbt'), { code: 'INVALID_PSBT' });
  assert.throws(() => inspectPsbt(Buffer.from('psbt').toString('base64')), { code: 'INVALID_PSBT' });
});

test('decodes required PSBT v2 transaction fields', () => {
  const preview = inspectPsbt(fixturePsbtV2().toString('hex'));
  assert.equal(preview.psbtVersion, 2);
  assert.equal(preview.transactionVersion, 2);
  assert.equal(preview.inputs[0].previousTxid, '0'.repeat(64));
  assert.equal(preview.inputs[0].previousVout, 0);
  assert.equal(preview.outputs[0].value, 1000);
});

test('rejects malformed field lengths and incomplete PSBT v2 outputs', () => {
  assert.throws(() => inspectPsbt(fixturePsbtV2({ version: Buffer.alloc(0) }).toString('hex')), { code: 'INVALID_PSBT' });
  assert.throws(() => inspectPsbt(fixturePsbtV2({ omitAmount: true }).toString('hex')), { code: 'INVALID_PSBT' });
  assert.throws(() => inspectPsbt(fixturePsbtV2({ omitScript: true }).toString('hex')), { code: 'INVALID_PSBT' });
});

test('normalizes every truncated deterministic fixture to INVALID_PSBT', () => {
  const fixture = fixturePsbt();
  for (let length = 5; length < fixture.length; length += 1) {
    assert.throws(() => inspectPsbt(fixture.subarray(0, length).toString('hex')), { code: 'INVALID_PSBT' });
  }
});

test('rejects a non-witness UTXO that does not match the referenced txid', () => {
  const previous = Buffer.concat([
    Buffer.from('01000000', 'hex'),
    Buffer.from([1]), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'), Buffer.from([0]), Buffer.from('ffffffff', 'hex'),
    Buffer.from([1]), Buffer.from('d007000000000000', 'hex'), Buffer.from([0]),
    Buffer.from('00000000', 'hex')
  ]);
  const base = fixturePsbt();
  const inputSeparator = base.length - 2;
  const withUtxo = Buffer.concat([base.subarray(0, inputSeparator), mapPair(0x00, previous), base.subarray(inputSeparator)]);
  assert.throws(() => inspectPsbt(withUtxo.toString('hex')), { code: 'INVALID_PSBT' });
});

test('rejects duplicate keys and declared oversized values', () => {
  const version = mapPair(0xfb, Buffer.from('02000000', 'hex'));
  const duplicate = Buffer.concat([Buffer.from('70736274ff', 'hex'), version, version, Buffer.from([0])]);
  assert.throws(() => inspectPsbt(duplicate.toString('hex')), { code: 'INVALID_PSBT' });

  const length = Buffer.alloc(5);
  length[0] = 0xfe;
  length.writeUInt32LE(16 * 1024 * 1024 + 1, 1);
  const oversized = Buffer.concat([Buffer.from('70736274ff', 'hex'), Buffer.from([1, 1]), length]);
  assert.throws(() => inspectPsbt(oversized.toString('hex')), { code: 'INVALID_PSBT' });
});

test('bounded deterministic mutation corpus never leaks native parser errors', () => {
  const fixture = fixturePsbt();
  let state = 0x5a17c9e3;
  for (let iteration = 0; iteration < 256; iteration += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const mutated = Buffer.from(fixture);
    const offset = state % mutated.length;
    mutated[offset] ^= 1 << (state % 8);
    try {
      inspectPsbt(mutated.toString('hex'));
    } catch (error) {
      assert.equal(error.code, 'INVALID_PSBT', `iteration ${iteration} leaked ${error.name}: ${error.message}`);
    }
  }
});
