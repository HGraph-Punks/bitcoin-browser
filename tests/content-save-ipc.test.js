import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { INSCRIPTION_ID_RE, parseNavigationInput } from '../src/shared/navigation.js';
import { assertString } from '../src/shared/validation.js';
import { writeContentFile } from '../src/main/content-export.js';

const inscriptionId = `${'a'.repeat(64)}i0`;
const content = Buffer.from('synthetic inscription bytes\n', 'utf8');
const original = Buffer.from('pre-existing destination bytes\n', 'utf8');
const ipcSource = (await fs.readFile(new URL('../src/main/ipc.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export function registerIpc', 'function registerIpc');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-save-ipc-'));
  const destination = path.join(directory, 'saved.txt');
  const handlers = new Map();
  const effects = { dialogs: 0, resolves: 0, writes: 0 };
  const observedWriteContentFile = async (...args) => {
    effects.writes += 1;
    return writeContentFile(...args);
  };
  const dialog = {
    async showSaveDialog() {
      effects.dialogs += 1;
      return options.cancelled ? { canceled: true } : { canceled: false, filePath: destination };
    }
  };
  const registerIpc = vm.runInNewContext(`${ipcSource}\nregisterIpc`, {
    fs, path, dialog, shell: {}, IPC, AppError, serializeError, INSCRIPTION_ID_RE,
    parseNavigationInput, assertString, inspectPsbt: () => ({}), buildDiagnostics: async () => ({}),
    writeDiagnostics: async () => {}, writeContentFile: observedWriteContentFile, Promise, URL, process, structuredClone,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} }
  });
  const lifecycle = registerIpc({
    getMainWindow: () => null,
    app: { getName: () => 'Fixture', getVersion: () => '1', getPath: () => directory, isPackaged: false },
    stateStore: { snapshot: () => ({}), recoveryStatus: null, get: () => ({}), updateSettings: async () => ({}) },
    providerManager: { list: () => [], healthAll: async () => [] },
    resolver: {
      async resolve(resourcePath, requestOptions) {
        effects.resolves += 1;
        assert.equal(resourcePath, `/content/${inscriptionId}`);
        assert.equal(requestOptions.accept, '*/*');
        assert.deepEqual(Object.keys(requestOptions), ['accept']);
        if (options.resolve) return options.resolve();
        return { data: content, headers: { 'content-type': 'text/plain; charset=utf-8' }, provenance: { sha256: 'synthetic-sha256' } };
      },
      configure: async () => {}, inspectGraph: async () => ({})
    },
    cache: { directory, stats: () => ({}), clear: async () => {} },
    secureStore: { availabilityStatus: () => true }, walletManager: { snapshot: () => ({}) },
    extensionManager: { list: () => [] }, localServiceManager: { list: () => [] },
    dataDirectory: directory, logDirectory: directory
  });
  const invoke = (url = 'app://app/renderer/index.html') => handlers.get(IPC.CONTENT_SAVE)(
    { senderFrame: { url }, sender: { getURL: () => url } }, { inscriptionId }
  );
  t.after(async () => {
    await lifecycle.shutdown();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, destination, effects, invoke, lifecycle };
}

test('a partial write failure preserves the complete pre-existing destination', async (t) => {
  let destination;
  const ipcFs = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        async writeFile(data) {
          await handle.write(data.subarray(0, 7));
          throw new AppError('SYNTHETIC_PARTIAL_WRITE', 'Synthetic write failed after partial temporary output', { status: 507 });
        },
        sync: () => handle.sync(),
        close: () => handle.close()
      };
    }
  };
  const f = await fixture(t);
  destination = f.destination;
  await fs.writeFile(destination, original);

  let error;
  try { await writeContentFile(destination, content, { fs: ipcFs, randomId: () => 'partial-write' }); }
  catch (caught) { error = caught; }

  assert.equal(error.code, 'CONTENT_SAVE_FAILED');
  assert.equal(error.details.stage, 'write');
  assert.equal(error.details.cause.code, 'SYNTHETIC_PARTIAL_WRITE');
  assert.equal(error.details.contentMutationCommitted, false);
  assert.deepEqual(await fs.readFile(destination), original);
  assert.deepEqual(await fs.readdir(f.directory), ['saved.txt']);
});

test('successful save atomically replaces a destination with the exact accepted bytes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.destination, original);

  const response = await f.invoke();

  assert.equal(JSON.stringify(response), JSON.stringify({ ok: true, result: {
    filePath: f.destination, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), mime: 'text/plain'
  } }));
  assert.deepEqual(await fs.readFile(f.destination), content);
  assert.deepEqual(await fs.readdir(f.directory), ['saved.txt']);
});

test('cancelled native save selection leaves an existing destination untouched', async (t) => {
  const f = await fixture(t, { cancelled: true });
  await fs.writeFile(f.destination, original);

  const response = await f.invoke();

  assert.equal(response.error.code, 'USER_REJECTED');
  assert.deepEqual(await fs.readFile(f.destination), original);
  assert.equal(f.effects.writes, 0);
  assert.deepEqual(await fs.readdir(f.directory), ['saved.txt']);
});

test('untrusted content save is denied before resolution, dialog, or filesystem access', async (t) => {
  const f = await fixture(t);

  const response = await f.invoke('ord://content/r/blockheight');

  assert.equal(response.error.code, 'UNTRUSTED_IPC_SENDER');
  assert.deepEqual(f.effects, { dialogs: 0, resolves: 0, writes: 0 });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('saving through a destination symlink replaces the link without modifying its target', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'symlink-target.txt');
  await fs.writeFile(target, original);
  await fs.symlink(target, f.destination);

  const response = await f.invoke();

  assert.equal(response.ok, true);
  assert.equal((await fs.lstat(f.destination)).isSymbolicLink(), false);
  assert.deepEqual(await fs.readFile(f.destination), content);
  assert.deepEqual(await fs.readFile(target), original);
});

test('saving to one hard link replaces only that directory entry', async (t) => {
  const f = await fixture(t);
  const sibling = path.join(f.directory, 'hardlink-sibling.txt');
  await fs.writeFile(sibling, original);
  await fs.link(sibling, f.destination);

  const response = await f.invoke();

  assert.equal(response.ok, true);
  assert.deepEqual(await fs.readFile(f.destination), content);
  assert.deepEqual(await fs.readFile(sibling), original);
  assert.notEqual((await fs.stat(f.destination)).ino, (await fs.stat(sibling)).ino);
});

function failingFileSystem(stage, primary) {
  return {
    ...fs,
    async open(...args) {
      if (stage === 'open') throw primary;
      const handle = await fs.open(...args);
      return {
        writeFile: async (data) => {
          if (stage === 'write') throw primary;
          return handle.writeFile(data);
        },
        sync: async () => {
          if (stage === 'sync') throw primary;
          return handle.sync();
        },
        close: async () => {
          if (stage === 'close') {
            stage = 'closed-on-cleanup';
            throw primary;
          }
          return handle.close();
        }
      };
    },
    async rename(...args) {
      if (stage === 'rename') throw primary;
      return fs.rename(...args);
    }
  };
}

for (const stage of ['open', 'write', 'sync', 'close', 'rename']) {
  test(`${stage} failure preserves destination and removes only the owned temporary file`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `content-export-${stage}-`));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'selected.bin');
    await fs.writeFile(destination, original);
    const primary = new AppError(`SYNTHETIC_${stage.toUpperCase()}`, `Synthetic ${stage} failure`, { status: 500 });

    await assert.rejects(
      writeContentFile(destination, content, { fs: failingFileSystem(stage, primary), randomId: () => `failure-${stage}` }),
      (error) => {
        assert.equal(error.code, 'CONTENT_SAVE_FAILED');
        assert.equal(error.details.stage, stage);
        assert.equal(error.details.contentMutationCommitted, false);
        assert.equal(error.details.cause.code, primary.code);
        assert.equal(error.cause, primary);
        return true;
      }
    );
    assert.deepEqual(await fs.readFile(destination), original);
    assert.deepEqual(await fs.readdir(directory), ['selected.bin']);
  });
}

test('local filesystem serialization retains native code and direct cause identity', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-export-native-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'selected.bin');
  await fs.writeFile(destination, original);
  const nativeError = Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
  const fileSystem = { ...fs, async open() { throw nativeError; } };

  await assert.rejects(writeContentFile(destination, content, { fs: fileSystem, randomId: () => 'native-error' }), (error) => {
    assert.equal(error.code, 'CONTENT_SAVE_FAILED');
    assert.equal(error.status, 507);
    assert.equal(error.cause, nativeError);
    assert.equal(error.details.stage, 'open');
    assert.equal(error.details.filesystemCode, 'ENOSPC');
    assert.equal(error.details.cause.code, 'ENOSPC');
    return true;
  });
  assert.deepEqual(await fs.readFile(destination), original);
  assert.deepEqual(await fs.readdir(directory), ['selected.bin']);
});

test('cleanup failures remain secondary to the write failure with bounded owned-path evidence', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-export-cleanup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'selected.bin');
  await fs.writeFile(destination, original);
  const primary = new AppError('SYNTHETIC_PRIMARY', 'Synthetic primary write failure', { status: 500 });
  let handle;
  const fileSystem = {
    ...fs,
    async open(...args) {
      handle = await fs.open(...args);
      return {
        writeFile: async () => { throw primary; },
        sync: () => handle.sync(),
        close: async () => { throw new AppError('SYNTHETIC_CLOSE', 'Synthetic close cleanup failure', { status: 500 }); }
      };
    },
    async unlink() { throw Object.assign(new Error('Synthetic native unlink cleanup failure'), { code: 'EACCES' }); }
  };

  let error;
  try { await writeContentFile(destination, content, { fs: fileSystem, randomId: () => 'cleanup-errors' }); }
  catch (caught) { error = caught; }
  try {
    assert.equal(error.code, 'CONTENT_SAVE_FAILED');
    assert.equal(error.cause, primary);
    assert.equal(error.details.cause.code, 'SYNTHETIC_PRIMARY');
    assert.deepEqual(error.details.cleanupErrors.map(({ stage, code }) => [stage, code]), [
      ['close', 'SYNTHETIC_CLOSE'], ['unlink', 'EACCES']
    ]);
    assert.equal(path.dirname(error.details.temporaryPath), directory);
    assert.deepEqual(await fs.readFile(destination), original);
  } finally {
    await handle?.close();
  }
});

test('temporary collisions retry without taking ownership and exhaust after exactly three attempts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-export-collision-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'selected.bin');
  await fs.writeFile(destination, original);
  for (const id of ['one', 'two', 'three']) await fs.writeFile(path.join(directory, `.satoshi-content-${id}.tmp`), id);
  let index = 0;
  await assert.rejects(writeContentFile(destination, content, {
    randomId: () => ['one', 'two', 'three'][index++]
  }), (error) => {
    assert.equal(error.code, 'CONTENT_SAVE_FAILED');
    assert.equal(error.details.stage, 'open');
    assert.equal(error.details.filesystemCode, 'EEXIST');
    return true;
  });
  assert.equal(index, 3);
  assert.deepEqual(await fs.readFile(destination), original);
  assert.deepEqual(await fs.readFile(path.join(directory, '.satoshi-content-one.tmp'), 'utf8'), 'one');

  index = 0;
  const saved = await writeContentFile(destination, content, { randomId: () => ['one', 'available'][index++] });
  assert.equal(index, 2);
  assert.equal(saved.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(await fs.readFile(destination), content);
  assert.equal(await fs.readFile(path.join(directory, '.satoshi-content-one.tmp'), 'utf8'), 'one');
});

test('payload bytes and hash are captured before the first asynchronous filesystem boundary', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-export-capture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'selected.bin');
  const mutable = Buffer.from('captured-original');
  const expected = Buffer.from(mutable);
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const observed = new Promise((resolve) => { entered = resolve; });
  const fileSystem = {
    ...fs,
    async lstat(file) {
      entered();
      await held;
      return fs.lstat(file);
    }
  };
  const saving = writeContentFile(destination, mutable, { fs: fileSystem, randomId: () => 'captured' });
  try {
    await observed;
    mutable.fill(0x78);
  } finally {
    release();
  }
  const result = await saving;
  assert.deepEqual(await fs.readFile(destination), expected);
  assert.equal(result.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
});

test('fixed temporary naming supports a long valid destination basename', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-export-long-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, `${'d'.repeat(230)}.bin`);
  await writeContentFile(destination, content, { randomId: () => 'short-fixed-id' });
  assert.deepEqual(await fs.readFile(destination), content);
  assert.deepEqual(await fs.readdir(directory), [path.basename(destination)]);
});

test('non-regular destination is refused before temporary creation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-export-nonregular-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'selected-directory');
  await fs.mkdir(destination);
  await assert.rejects(writeContentFile(destination, content, { randomId: () => 'never-owned' }), (error) => {
    assert.equal(error.code, 'CONTENT_SAVE_FAILED');
    assert.equal(error.details.stage, 'destination-check');
    assert.equal(error.details.cause.code, 'INVALID_CONTENT_DESTINATION');
    return true;
  });
  assert.deepEqual(await fs.readdir(directory), ['selected-directory']);
});

test('invalid destination, payload, and size limits reject before filesystem authority', async () => {
  let fileSystemCalls = 0;
  const noAuthority = new Proxy({}, { get() { fileSystemCalls += 1; throw new Error('filesystem must not be reached'); } });
  const absolute = path.join(os.tmpdir(), 'content-export-never-written');
  const cases = [
    ['', content, {}, 'INVALID_CONTENT_DESTINATION'],
    ['relative.bin', content, {}, 'INVALID_CONTENT_DESTINATION'],
    [`${absolute}\0tail`, content, {}, 'INVALID_CONTENT_DESTINATION'],
    [absolute, 'not-binary', {}, 'INVALID_CONTENT_BYTES'],
    [absolute, content, { maxBytes: -1 }, 'VALIDATION_ERROR'],
    [absolute, content, { maxBytes: 1024 * 1024 * 1024 + 1 }, 'VALIDATION_ERROR'],
    [absolute, content, { maxBytes: 2 }, 'CONTENT_TOO_LARGE']
  ];
  for (const [file, data, options, code] of cases) {
    await assert.rejects(writeContentFile(file, data, { fs: noAuthority, ...options }), { code });
  }
  assert.equal(fileSystemCalls, 0);
});

test('empty payload and a sliced Uint8Array save exact captured views', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-export-byte-views-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const emptyDestination = path.join(directory, 'empty.bin');
  const viewDestination = path.join(directory, 'view.bin');

  const empty = await writeContentFile(emptyDestination, Buffer.alloc(0), { maxBytes: 0, randomId: () => 'empty' });
  assert.equal(empty.bytes, 0);
  assert.equal(empty.sha256, crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.deepEqual(await fs.readFile(emptyDestination), Buffer.alloc(0));

  const source = new Uint8Array([9, 1, 2, 3, 8]);
  const view = source.subarray(1, 4);
  const expected = Buffer.from([1, 2, 3]);
  const saved = await writeContentFile(viewDestination, view, { maxBytes: 3, randomId: () => 'view' });
  assert.equal(saved.bytes, 3);
  assert.equal(saved.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
  assert.deepEqual(await fs.readFile(viewDestination), expected);
});

test('IPC shutdown drains accepted content resolution and the completed atomic write', async (t) => {
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const observed = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, {
    async resolve() {
      entered();
      await held;
      return { data: content, headers: { 'content-type': 'text/plain' }, provenance: { sha256: 'wrong-on-purpose' } };
    }
  });
  const saving = f.invoke();
  await observed;
  let drained = false;
  const shutdown = f.lifecycle.shutdown().then(() => { drained = true; });
  try {
    await Promise.resolve();
    assert.equal(drained, false);
  } finally {
    release();
    await Promise.allSettled([saving, shutdown]);
  }
  const response = await saving;
  assert.equal(response.ok, true);
  assert.equal(response.result.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(await fs.readFile(f.destination), content);
  await shutdown;
  assert.equal(drained, true);
});
