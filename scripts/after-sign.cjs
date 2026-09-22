'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.SATOSHI_BROWSER_UNSIGNED_BUILD === '1') return;
  if (process.env.SATOSHI_BROWSER_REQUIRE_NOTARIZATION !== '1') {
    throw new Error('Distributable macOS signing must run through scripts/package.mjs with notarization required');
  }
  const name = context.packager.appInfo.productFilename;
  const bundle = path.join(context.appOutDir, `${name}.app`);
  const run = (executable, args, label) => {
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${label}: ${(result.stderr || result.stdout || result.error?.message || 'unknown failure').trim()}`);
    return result;
  };

  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], 'macOS signature verification failed after signing');
  const metadata = run('/usr/bin/codesign', ['-dvvv', bundle], 'Could not inspect the macOS signature');
  const signatureText = `${metadata.stdout}\n${metadata.stderr}`;
  if (!/^Authority=Developer ID Application: .+$/m.test(signatureText)) {
    throw new Error('macOS distribution requires a Developer ID Application signature');
  }
  if (!/^CodeDirectory .*flags=.*\bruntime\b/m.test(signatureText) || !/^Timestamp=.+$/m.test(signatureText)) {
    throw new Error('macOS distribution requires hardened runtime and a secure signing timestamp');
  }
  const actualTeamId = signatureText.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1] ?? null;
  const expectedTeamId = process.env.SATOSHI_BROWSER_EXPECTED_TEAM_ID?.trim();
  if (!expectedTeamId || actualTeamId !== expectedTeamId) {
    throw new Error(`macOS signature TeamIdentifier mismatch: expected ${expectedTeamId || '[unset]'}, received ${actualTeamId || '[missing]'}`);
  }

  run('/usr/bin/xcrun', ['stapler', 'staple', bundle], 'Could not staple the macOS notarization ticket');
  run('/usr/bin/xcrun', ['stapler', 'validate', bundle], 'The stapled macOS notarization ticket is invalid');
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle], 'Gatekeeper rejected the notarized macOS application');
  console.log(`Verified signed, notarized, stapled macOS application for TeamIdentifier ${actualTeamId}`);
};
