import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../scripts/after-pack.cjs', import.meta.url), 'utf8');
const context = {
  packager: { appInfo: { productFilename: 'Bitcoin Browser' } },
  electronPlatformName: 'darwin',
  appOutDir: '/tmp/package-output'
};

function loadAfterPack({ spawnSync, flipFuses, env = {} }) {
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === 'node:path') return path;
    if (specifier === 'node:child_process') return { spawnSync };
    if (specifier === '@electron/fuses') {
      return {
        flipFuses,
        FuseVersion: { V1: 'v1' },
        FuseV1Options: new Proxy({}, { get: (_target, property) => String(property) })
      };
    }
    throw new Error(`Unexpected require: ${specifier}`);
  };
  const wrapper = vm.runInNewContext(`(function (require, module, exports) { ${source}\n})`, { process: { env } });
  wrapper(localRequire, module, module.exports);
  return module.exports;
}

function result(overrides = {}) {
  return { status: 0, stdout: '', stderr: '', ...overrides };
}

test('Linux fuses target the actual executableName, not the product display name', async () => {
  const calls = [];
  const afterPack = loadAfterPack({
    spawnSync: () => { throw new Error('Linux must not run macOS signing tools'); },
    flipFuses: async (executable, options) => calls.push({ executable, options })
  });
  await afterPack({ ...context, electronPlatformName: 'linux',
    packager: { ...context.packager, executableName: 'bitcoin-browser' } });
  assert.equal(calls[0].executable, path.join(context.appOutDir, 'bitcoin-browser'));
  for (const key of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges']) {
    assert.equal(calls[0].options[key], false, key);
  }
  for (const key of ['EnableCookieEncryption', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) {
    assert.equal(calls[0].options[key], true, key);
  }
});

test('Windows fuses still target the named executable without invoking macOS tools', async () => {
  let executable;
  await loadAfterPack({ spawnSync: () => { throw new Error('Unexpected platform tool'); },
    flipFuses: async (value) => { executable = value; } })({ ...context, electronPlatformName: 'win32' });
  assert.equal(executable, path.join(context.appOutDir, 'Bitcoin Browser.exe'));
});

test('afterPack checks plist mutations and verifies the hardened readback', async () => {
  const calls = [];
  let reads = 0;
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === '/usr/bin/plutil') {
      reads += 1;
      return result({
        stdout: JSON.stringify(reads === 1
          ? { NSCameraUsageDescription: 'unused', NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }
          : { NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } })
      });
    }
    return result();
  };
  const flipFuses = async () => calls.push(['flipFuses']);

  await loadAfterPack({ spawnSync, flipFuses })(context);

  assert.equal(calls[0][0], 'flipFuses');
  assert.deepEqual(calls.filter(([command]) => command === '/usr/libexec/PlistBuddy').map((call) => call[2]), [
    'Delete :NSCameraUsageDescription',
    'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false'
  ]);
  assert.equal(calls.filter(([command]) => command === '/usr/bin/plutil').length, 2);
});

test('afterPack tolerates absent plist keys and creates missing ATS settings', async () => {
  let reads = 0;
  const mutations = [];
  const spawnSync = (command, args) => {
    if (command === '/usr/bin/plutil') {
      reads += 1;
      return result({ stdout: JSON.stringify(reads === 1 ? {} : { NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } }) });
    }
    mutations.push(args[1]);
    return result();
  };

  await loadAfterPack({ spawnSync, flipFuses: async () => {} })(context);
  assert.deepEqual(mutations, [
    'Add :NSAppTransportSecurity dict',
    'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false'
  ]);
});

test('afterPack fails closed on plist inspection, mutation, and readback failures', async (t) => {
  await t.test('inspection command failure', async () => {
    const afterPack = loadAfterPack({
      flipFuses: async () => {},
      spawnSync: () => result({ status: 1, stderr: 'inspection denied' })
    });
    await assert.rejects(afterPack(context), /Could not inspect hardened macOS Info\.plist: inspection denied/);
  });

  await t.test('mutation command failure', async () => {
    const spawnSync = (command) => command === '/usr/bin/plutil'
      ? result({ stdout: JSON.stringify({ NSMicrophoneUsageDescription: 'unused' }) })
      : result({ status: 1, stderr: 'mutation denied' });
    await assert.rejects(
      loadAfterPack({ spawnSync, flipFuses: async () => {} })(context),
      /Could not apply Info\.plist mutation.*mutation denied/
    );
  });

  await t.test('readback retains unwanted state', async () => {
    const plist = JSON.stringify({
      NSCameraUsageDescription: 'still present',
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: false }
    });
    const spawnSync = (command) => command === '/usr/bin/plutil' ? result({ stdout: plist }) : result();
    await assert.rejects(
      loadAfterPack({ spawnSync, flipFuses: async () => {} })(context),
      /hardening verification failed: NSCameraUsageDescription is still present/
    );
  });

  await t.test('readback retains arbitrary network loads', async () => {
    const spawnSync = (command) => {
      if (command !== '/usr/bin/plutil') return result();
      return result({ stdout: JSON.stringify({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }) });
    };
    await assert.rejects(
      loadAfterPack({ spawnSync, flipFuses: async () => {} })(context),
      /hardening verification failed: NSAllowsArbitraryLoads is not false/
    );
  });
});

test('afterPack fails unsigned builds when ad-hoc signing or verification fails', async (t) => {
  for (const [label, failingInvocation, expected] of [
    ['signing', 1, /Could not ad-hoc sign unsigned macOS package: signing failed/],
    ['verification', 2, /Unsigned macOS package failed ad-hoc verification: verification failed/]
  ]) {
    await t.test(label, async () => {
      let plistReads = 0;
      let codesignCalls = 0;
      const spawnSync = (command) => {
        if (command === '/usr/bin/plutil') {
          plistReads += 1;
          return result({ stdout: JSON.stringify({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } }) });
        }
        if (command === '/usr/bin/codesign') {
          codesignCalls += 1;
          if (codesignCalls === failingInvocation) return result({ status: 1, stderr: `${label} failed` });
        }
        return result();
      };
      await assert.rejects(
        loadAfterPack({ spawnSync, flipFuses: async () => {}, env: { SATOSHI_BROWSER_UNSIGNED_BUILD: '1' } })(context),
        expected
      );
      assert.equal(plistReads, 2);
    });
  }
});
