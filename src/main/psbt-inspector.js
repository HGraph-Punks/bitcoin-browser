import crypto from 'node:crypto';
import { AppError } from '../shared/errors.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  remaining() { return this.buffer.length - this.offset; }

  bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.buffer.length) {
      throw new AppError('INVALID_PSBT', 'Unexpected end of PSBT data', { status: 400 });
    }
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u32() { return this.bytes(4).readUInt32LE(0); }
  i32() { return this.bytes(4).readInt32LE(0); }
  u64() { return this.bytes(8).readBigUInt64LE(0); }

  compact() {
    const prefix = this.bytes(1)[0];
    if (prefix < 0xfd) return prefix;
    if (prefix === 0xfd) {
      const value = this.bytes(2).readUInt16LE(0);
      if (value < 0xfd) throw new AppError('INVALID_PSBT', 'Compact integer is not minimally encoded', { status: 400 });
      return value;
    }
    if (prefix === 0xfe) {
      const value = this.u32();
      if (value <= 0xffff) throw new AppError('INVALID_PSBT', 'Compact integer is not minimally encoded', { status: 400 });
      return value;
    }
    const value = this.u64();
    if (value <= 0xffffffffn) throw new AppError('INVALID_PSBT', 'Compact integer is not minimally encoded', { status: 400 });
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('INVALID_PSBT', 'Compact integer exceeds safe limits', { status: 400 });
    return Number(value);
  }
}

function encodeCompact(value) {
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const output = Buffer.alloc(3);
    output[0] = 0xfd;
    output.writeUInt16LE(value, 1);
    return output;
  }
  const output = Buffer.alloc(5);
  output[0] = 0xfe;
  output.writeUInt32LE(value, 1);
  return output;
}

function u32Buffer(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value);
  return output;
}

function u64Buffer(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value);
  return output;
}

function reverseHex(buffer) {
  return Buffer.from(buffer).reverse().toString('hex');
}

function parseTransaction(buffer) {
  const reader = new Reader(buffer);
  const version = reader.i32();
  let hasWitness = false;
  if (reader.remaining() >= 2 && reader.buffer[reader.offset] === 0 && reader.buffer[reader.offset + 1] !== 0) {
    reader.offset += 2;
    hasWitness = true;
  }
  const inputCount = reader.compact();
  if (inputCount > 100_000) throw new AppError('INVALID_PSBT', 'Transaction has too many inputs', { status: 400 });
  const inputs = [];
  for (let index = 0; index < inputCount; index += 1) {
    const txid = reverseHex(reader.bytes(32));
    const vout = reader.u32();
    const scriptLength = reader.compact();
    const scriptSig = reader.bytes(scriptLength).toString('hex');
    const sequence = reader.u32();
    inputs.push({ txid, vout, scriptSig, sequence });
  }
  const outputCount = reader.compact();
  if (outputCount > 100_000) throw new AppError('INVALID_PSBT', 'Transaction has too many outputs', { status: 400 });
  const outputs = [];
  for (let index = 0; index < outputCount; index += 1) {
    const value = reader.u64();
    const scriptLength = reader.compact();
    const script = reader.bytes(scriptLength);
    outputs.push({ value, script });
  }
  if (hasWitness) {
    for (let index = 0; index < inputCount; index += 1) {
      const itemCount = reader.compact();
      for (let item = 0; item < itemCount; item += 1) reader.bytes(reader.compact());
    }
  }
  const locktime = reader.u32();
  if (reader.remaining() !== 0) throw new AppError('INVALID_PSBT', 'Transaction contains trailing bytes', { status: 400 });
  const stripped = Buffer.concat([
    u32Buffer(version >>> 0),
    encodeCompact(inputs.length),
    ...inputs.flatMap((input) => [
      Buffer.from(input.txid, 'hex').reverse(),
      u32Buffer(input.vout),
      encodeCompact(Buffer.byteLength(input.scriptSig, 'hex')),
      Buffer.from(input.scriptSig, 'hex'),
      u32Buffer(input.sequence)
    ]),
    encodeCompact(outputs.length),
    ...outputs.flatMap((output) => [u64Buffer(output.value), encodeCompact(output.script.length), output.script]),
    u32Buffer(locktime)
  ]);
  return { version, inputs, outputs, locktime, hasWitness, txid: reverseHex(sha256d(stripped)) };
}

function parseMap(reader) {
  const pairs = [];
  const seen = new Set();
  while (true) {
    const keyLength = reader.compact();
    if (keyLength === 0) break;
    if (keyLength > 1_000_000) throw new AppError('INVALID_PSBT', 'PSBT key is too large', { status: 400 });
    const key = reader.bytes(keyLength);
    const keyHex = key.toString('hex');
    if (seen.has(keyHex)) throw new AppError('INVALID_PSBT', 'PSBT map contains a duplicate key', { status: 400 });
    seen.add(keyHex);
    const valueLength = reader.compact();
    if (valueLength > 16 * 1024 * 1024) throw new AppError('INVALID_PSBT', 'PSBT value is too large', { status: 400 });
    const value = reader.bytes(valueLength);
    pairs.push({ type: key[0], keyData: key.subarray(1), value });
    if (pairs.length > 100_000) throw new AppError('INVALID_PSBT', 'PSBT map contains too many entries', { status: 400 });
  }
  return pairs;
}

function sha256d(buffer) {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buffer).digest()).digest();
}

function base58Check(payload) {
  const data = Buffer.concat([payload, sha256d(payload).subarray(0, 4)]);
  let number = BigInt(`0x${data.toString('hex') || '0'}`);
  let encoded = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = BASE58[remainder] + encoded;
    number /= 58n;
  }
  for (const byte of data) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) if ((top >>> index) & 1) checksum ^= generators[index];
  }
  return checksum >>> 0;
}

function hrpExpand(hrp) {
  return [...hrp].map((character) => character.charCodeAt(0) >>> 5).concat([0], [...hrp].map((character) => character.charCodeAt(0) & 31));
}

function convertBits(data, fromBits, toBits, pad = true) {
  let accumulator = 0;
  let bits = 0;
  const output = [];
  const maxValue = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) throw new AppError('INVALID_SCRIPT', 'Invalid witness program', { status: 400 });
    accumulator = (accumulator << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      output.push((accumulator >>> bits) & maxValue);
    }
  }
  if (pad && bits > 0) output.push((accumulator << (toBits - bits)) & maxValue);
  else if (!pad && (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue))) throw new AppError('INVALID_SCRIPT', 'Invalid witness padding', { status: 400 });
  return output;
}

function segwitAddress(hrp, version, program) {
  const values = [version, ...convertBits([...program], 8, 5, true)];
  const constant = version === 0 ? 1 : 0x2bc830a3;
  const polymod = bech32Polymod([...hrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = [];
  for (let index = 0; index < 6; index += 1) checksum.push((polymod >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...values, ...checksum].map((value) => BECH32[value]).join('')}`;
}

function networkParams(network) {
  if (network === 'mainnet') return { p2pkh: 0x00, p2sh: 0x05, hrp: 'bc' };
  if (network === 'regtest') return { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'bcrt' };
  return { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tb' };
}

function classifyScript(script, network) {
  const params = networkParams(network);
  const hex = script.toString('hex');
  if (script.length === 25 && hex.startsWith('76a914') && hex.endsWith('88ac')) {
    return { type: 'p2pkh', address: base58Check(Buffer.concat([Buffer.from([params.p2pkh]), script.subarray(3, 23)])) };
  }
  if (script.length === 23 && hex.startsWith('a914') && hex.endsWith('87')) {
    return { type: 'p2sh', address: base58Check(Buffer.concat([Buffer.from([params.p2sh]), script.subarray(2, 22)])) };
  }
  if (script.length === 22 && script[0] === 0 && script[1] === 20) return { type: 'p2wpkh', address: segwitAddress(params.hrp, 0, script.subarray(2)) };
  if (script.length === 34 && script[0] === 0 && script[1] === 32) return { type: 'p2wsh', address: segwitAddress(params.hrp, 0, script.subarray(2)) };
  if (script.length === 34 && script[0] === 0x51 && script[1] === 32) return { type: 'p2tr', address: segwitAddress(params.hrp, 1, script.subarray(2)) };
  if (script[0] === 0x6a) return { type: 'op_return', address: null };
  return { type: 'unknown', address: null };
}

function txOutFromBuffer(value) {
  const reader = new Reader(value);
  const amount = reader.u64();
  const script = reader.bytes(reader.compact());
  if (reader.remaining() !== 0) throw new AppError('INVALID_PSBT', 'Witness UTXO contains trailing bytes', { status: 400 });
  return { value: amount, script };
}

function asSats(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function compactFromValue(buffer) {
  const reader = new Reader(buffer);
  const value = reader.compact();
  if (reader.remaining() !== 0) throw new AppError('INVALID_PSBT', 'Invalid compact integer in PSBT field', { status: 400 });
  return value;
}

function exactField(map, type, length, name, options = {}) {
  const field = map.find((pair) => pair.type === type && pair.keyData.length === 0);
  if (!field) {
    if (options.required) throw new AppError('INVALID_PSBT', `PSBT is missing ${name}`, { status: 400 });
    return null;
  }
  if (length !== null && field.value.length !== length) {
    throw new AppError('INVALID_PSBT', `${name} must be ${length} bytes`, { status: 400 });
  }
  return field;
}

export function inspectPsbt(input, network = 'mainnet') {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 24 * 1024 * 1024) throw new AppError('INVALID_PSBT', 'PSBT is empty or too large', { status: 400 });
  let buffer;
  try {
    buffer = /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  } catch {
    throw new AppError('INVALID_PSBT', 'PSBT must be base64 or hex encoded', { status: 400 });
  }
  if (buffer.length < 6 || !buffer.subarray(0, 5).equals(Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]))) {
    throw new AppError('INVALID_PSBT', 'Missing PSBT magic bytes', { status: 400 });
  }
  const reader = new Reader(buffer.subarray(5));
  const globalMap = parseMap(reader);
  const unsignedField = globalMap.find((pair) => pair.type === 0x00 && pair.keyData.length === 0);
  const versionField = exactField(globalMap, 0xfb, 4, 'PSBT version');
  const psbtVersion = versionField ? versionField.value.readUInt32LE(0) : 0;
  if (![0, 2].includes(psbtVersion)) throw new AppError('INVALID_PSBT', `Unsupported PSBT version ${psbtVersion}`, { status: 400 });
  if (psbtVersion === 0 && !unsignedField) throw new AppError('INVALID_PSBT', 'PSBT v0 is missing its unsigned transaction', { status: 400 });
  if (psbtVersion === 2 && unsignedField) throw new AppError('INVALID_PSBT', 'PSBT v2 must not contain a global unsigned transaction', { status: 400 });
  let transaction = unsignedField ? parseTransaction(unsignedField.value) : null;
  let inputCount = transaction?.inputs.length;
  let outputCount = transaction?.outputs.length;
  if (!transaction && psbtVersion >= 2) {
    const inputCountField = exactField(globalMap, 0x04, null, 'PSBT v2 input count', { required: true });
    const outputCountField = exactField(globalMap, 0x05, null, 'PSBT v2 output count', { required: true });
    inputCount = compactFromValue(inputCountField.value);
    outputCount = compactFromValue(outputCountField.value);
  }
  if (!Number.isSafeInteger(inputCount) || !Number.isSafeInteger(outputCount) || inputCount > 100_000 || outputCount > 100_000) {
    throw new AppError('INVALID_PSBT', 'Could not determine safe PSBT input/output counts', { status: 400 });
  }
  const inputMaps = Array.from({ length: inputCount }, () => parseMap(reader));
  const outputMaps = Array.from({ length: outputCount }, () => parseMap(reader));
  if (reader.remaining() !== 0) throw new AppError('INVALID_PSBT', 'PSBT contains trailing bytes', { status: 400 });

  if (!transaction && psbtVersion >= 2) {
    const transactionVersion = exactField(globalMap, 0x02, 4, 'PSBT v2 transaction version', { required: true });
    const fallbackLocktime = exactField(globalMap, 0x03, 4, 'PSBT v2 fallback locktime');
    const inputs = inputMaps.map((map) => {
      const previousTxid = exactField(map, 0x0e, 32, 'PSBT v2 previous transaction ID', { required: true });
      const previousVout = exactField(map, 0x0f, 4, 'PSBT v2 output index', { required: true });
      const sequence = exactField(map, 0x10, 4, 'PSBT v2 sequence');
      return {
        txid: reverseHex(previousTxid.value),
        vout: previousVout.value.readUInt32LE(0),
        sequence: sequence?.value.readUInt32LE(0) ?? 0xffffffff
      };
    });
    const outputs = outputMaps.map((map) => {
      const amount = exactField(map, 0x03, 8, 'PSBT v2 output amount', { required: true });
      const script = exactField(map, 0x04, null, 'PSBT v2 output script', { required: true });
      return { value: amount.value.readBigUInt64LE(0), script: script.value };
    });
    transaction = { version: transactionVersion.value.readInt32LE(0), locktime: fallbackLocktime?.value.readUInt32LE(0) ?? 0, inputs, outputs, hasWitness: false };
  }

  let totalInput = 0n;
  let allInputsKnown = true;
  const inputs = inputMaps.map((map, index) => {
    const witness = map.find((pair) => pair.type === 0x01 && pair.keyData.length === 0);
    const nonWitness = map.find((pair) => pair.type === 0x00 && pair.keyData.length === 0);
    const sighash = map.find((pair) => pair.type === 0x03 && pair.keyData.length === 0);
    if (sighash && sighash.value.length !== 4) throw new AppError('INVALID_PSBT', 'PSBT sighash type must be 4 bytes', { status: 400 });
    let utxo = null;
    if (witness) utxo = txOutFromBuffer(witness.value);
    else if (nonWitness && transaction.inputs[index]?.vout !== null) {
      const previous = parseTransaction(nonWitness.value);
      if (previous.txid !== transaction.inputs[index].txid) {
        throw new AppError('INVALID_PSBT', `Input ${index} non-witness UTXO does not match its previous transaction ID`, { status: 400 });
      }
      utxo = previous.outputs[transaction.inputs[index].vout] ?? null;
    }
    if (utxo) totalInput += utxo.value;
    else allInputsKnown = false;
    return {
      index,
      previousTxid: transaction.inputs[index]?.txid ?? null,
      previousVout: transaction.inputs[index]?.vout ?? null,
      value: utxo ? asSats(utxo.value) : null,
      scriptType: utxo ? classifyScript(utxo.script, network).type : null,
      sighashType: sighash?.value.length === 4 ? sighash.value.readUInt32LE(0) : null,
      hasWitnessUtxo: Boolean(witness),
      hasNonWitnessUtxo: Boolean(nonWitness),
      partialSignatures: map.filter((pair) => pair.type === 0x02).length,
      taprootKeySignature: map.some((pair) => pair.type === 0x13)
    };
  });

  let totalOutput = 0n;
  const outputs = transaction.outputs.map((output, index) => {
    totalOutput += output.value;
    const classified = classifyScript(output.script, network);
    return {
      index,
      value: asSats(output.value),
      address: classified.address,
      scriptType: classified.type,
      scriptHex: output.script.toString('hex'),
      unknown: classified.type === 'unknown'
    };
  });
  const fee = allInputsKnown && totalInput >= totalOutput ? totalInput - totalOutput : null;
  return {
    encoding: /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 ? 'hex' : 'base64',
    psbtVersion,
    bytes: buffer.length,
    network,
    transactionVersion: transaction.version,
    locktime: transaction.locktime,
    inputCount,
    outputCount,
    totalInput: allInputsKnown ? asSats(totalInput) : null,
    totalOutput: asSats(totalOutput),
    fee: fee === null ? null : asSats(fee),
    feeKnown: fee !== null,
    unknownOutputCount: outputs.filter((output) => output.unknown).length,
    inputs,
    outputs,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    warnings: [
      ...(!allInputsKnown ? ['Fee cannot be calculated because one or more input UTXOs are absent.'] : []),
      ...(outputs.some((output) => output.unknown) ? ['One or more output scripts could not be converted to a standard address.'] : []),
      ...(psbtVersion >= 2 ? ['PSBT v2 preview support is conservative; verify all details in the signing wallet.'] : [])
    ]
  };
}
