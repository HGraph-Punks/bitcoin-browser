'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const unwantedUsageKeys = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
];

function runChecked(command, args, description) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || `exit status ${result.status}`;
    throw new Error(`${description}: ${String(detail).trim()}`);
  }
  return result.stdout;
}

function readPlist(infoPlist) {
  const output = runChecked(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', infoPlist],
    'Could not inspect hardened macOS Info.plist'
  );
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Could not parse hardened macOS Info.plist: ${error.message}`);
  }
}

function mutatePlist(infoPlist, command) {
  runChecked('/usr/libexec/PlistBuddy', ['-c', command, infoPlist], `Could not apply Info.plist mutation "${command}"`);
}

module.exports = async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const target = context.electronPlatformName;
  const executable = target === 'darwin'
    ? path.join(context.appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
    : target === 'win32'
      ? path.join(context.appOutDir, `${name}.exe`)
      : path.join(context.appOutDir, context.packager.executableName);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });
  if (target === 'darwin') {
    const bundle = path.join(context.appOutDir, `${name}.app`);
    const infoPlist = path.join(bundle, 'Contents', 'Info.plist');
    const plist = readPlist(infoPlist);
    for (const key of unwantedUsageKeys) {
      if (Object.hasOwn(plist, key)) mutatePlist(infoPlist, `Delete :${key}`);
    }
    let transportSecurity = plist.NSAppTransportSecurity;
    if (!transportSecurity || typeof transportSecurity !== 'object' || Array.isArray(transportSecurity)) {
      if (Object.hasOwn(plist, 'NSAppTransportSecurity')) mutatePlist(infoPlist, 'Delete :NSAppTransportSecurity');
      mutatePlist(infoPlist, 'Add :NSAppTransportSecurity dict');
      transportSecurity = {};
    }
    mutatePlist(
      infoPlist,
      Object.hasOwn(transportSecurity, 'NSAllowsArbitraryLoads')
        ? 'Set :NSAppTransportSecurity:NSAllowsArbitraryLoads false'
        : 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false'
    );
    const hardenedPlist = readPlist(infoPlist);
    const retainedUsageKey = unwantedUsageKeys.find((key) => Object.hasOwn(hardenedPlist, key));
    if (retainedUsageKey) throw new Error(`Info.plist hardening verification failed: ${retainedUsageKey} is still present`);
    if (hardenedPlist.NSAppTransportSecurity?.NSAllowsArbitraryLoads !== false) {
      throw new Error('Info.plist hardening verification failed: NSAllowsArbitraryLoads is not false');
    }
    // Fuses and Info.plist hardening intentionally happen before the final
    // distribution signature. An explicitly unsigned developer package has no
    // later electron-builder signing phase, so repair its invalidated Electron
    // signatures with an ad-hoc identity to keep the local artifact launchable.
    if (process.env.SATOSHI_BROWSER_UNSIGNED_BUILD === '1' || process.env.SATOSHI_BROWSER_UNSIGNED_MACOS_BETA === '1') {
      runChecked('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], 'Could not ad-hoc sign unsigned macOS package');
      runChecked('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], 'Unsigned macOS package failed ad-hoc verification');
    }
  }
};
