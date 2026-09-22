import { UNSIGNED_WINDOWS_DIRECTORY, validateBetaTag, windowsArtifactTemplates } from './beta-release.mjs';

const APPLE_ID_KEYS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const API_KEY_KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

function present(environment, key) {
  return typeof environment[key] === 'string' && environment[key].trim().length > 0;
}

function inspectGroup(environment, keys) {
  const configured = keys.filter((key) => present(environment, key));
  return {
    configured,
    complete: configured.length === keys.length,
    partial: configured.length > 0 && configured.length < keys.length,
    missing: keys.filter((key) => !configured.includes(key))
  };
}

function targetsPlatform(argumentsList, target, platform) {
  const platforms = new Set();
  for (const argument of argumentsList) {
    const flag = argument.split('=')[0];
    if (['--mac', '--macos', '-m', '-o'].includes(flag)) platforms.add('mac');
    else if (['--win', '--windows', '-w'].includes(flag)) platforms.add('win');
    else if (['--linux', '-l'].includes(flag)) platforms.add('linux');
    else if (/^-[mowl]+$/.test(flag)) {
      if (/[mo]/.test(flag)) platforms.add('mac');
      if (flag.includes('w')) platforms.add('win');
      if (flag.includes('l')) platforms.add('linux');
    }
  }
  return platforms.size === 0 ? ({ darwin: 'mac', win32: 'win', linux: 'linux' })[platform] === target : platforms.has(target);
}

export function targetsMacDistribution(args, platform = process.platform) {
  return targetsPlatform(args, 'mac', platform);
}

export function targetsWindowsDistribution(args, platform = process.platform) {
  return targetsPlatform(args, 'win', platform);
}

export function expectedWindowsPublisher(environment) {
  const value = environment.SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER must contain the exact certificate publisher name (1–256 characters, no control characters)');
  }
  return value.trim();
}

export function linuxReleaseMetadata(environment) {
  const homepage = String(environment.SATOSHI_BROWSER_RELEASE_HOMEPAGE ?? '').trim();
  const maintainer = String(environment.SATOSHI_BROWSER_LINUX_MAINTAINER ?? '').trim();
  if (!homepage && !maintainer) return [];
  let url;
  try { url = new URL(homepage); } catch { throw new Error('Linux release metadata requires an HTTPS project homepage'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\r\n]/.test(homepage)) {
    throw new Error('Linux release metadata requires an HTTPS project homepage without credentials, query, or fragment');
  }
  if (!/^[^<>\r\n]+ <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(maintainer)) {
    throw new Error('SATOSHI_BROWSER_LINUX_MAINTAINER must be a real publisher contact: Name <email>');
  }
  return [`--config.extraMetadata.homepage=${url.href}`, `--config.linux.maintainer=${maintainer}`];
}

export function inspectNotarizationEnvironment(environment) {
  const appleId = inspectGroup(environment, APPLE_ID_KEYS);
  const apiKey = inspectGroup(environment, API_KEY_KEYS);
  const hasKeychain = present(environment, 'APPLE_KEYCHAIN');
  const hasKeychainProfile = present(environment, 'APPLE_KEYCHAIN_PROFILE');

  // APPLE_TEAM_ID alone is also useful as publisher metadata with API/keychain
  // credentials; builder selects Apple ID auth only when ID/password is set.
  if (appleId.partial && (present(environment, 'APPLE_ID') || present(environment, 'APPLE_APP_SPECIFIC_PASSWORD'))) {
    throw new Error(`Incomplete Apple ID notarization configuration; missing ${appleId.missing.join(', ')}`);
  }
  if (apiKey.partial) {
    throw new Error(`Incomplete App Store Connect API-key notarization configuration; missing ${apiKey.missing.join(', ')}`);
  }
  if (hasKeychain && !hasKeychainProfile) {
    throw new Error('APPLE_KEYCHAIN requires APPLE_KEYCHAIN_PROFILE for notarization');
  }

  if (appleId.complete) {
    if (present(environment, 'SATOSHI_BROWSER_EXPECTED_TEAM_ID') && environment.SATOSHI_BROWSER_EXPECTED_TEAM_ID.trim() !== environment.APPLE_TEAM_ID.trim()) {
      throw new Error('APPLE_TEAM_ID conflicts with SATOSHI_BROWSER_EXPECTED_TEAM_ID');
    }
    return { mode: 'apple-id', expectedTeamId: environment.APPLE_TEAM_ID.trim() };
  }
  if (apiKey.complete) {
    const expectedTeamId = String(environment.SATOSHI_BROWSER_EXPECTED_TEAM_ID ?? '').trim();
    if (!expectedTeamId) throw new Error('SATOSHI_BROWSER_EXPECTED_TEAM_ID is required with App Store Connect API-key notarization');
    return { mode: 'api-key', expectedTeamId };
  }
  if (hasKeychainProfile) {
    const expectedTeamId = String(environment.SATOSHI_BROWSER_EXPECTED_TEAM_ID ?? '').trim();
    if (!expectedTeamId) throw new Error('SATOSHI_BROWSER_EXPECTED_TEAM_ID is required with keychain-profile notarization');
    return { mode: 'keychain-profile', expectedTeamId };
  }
  throw new Error('macOS distributable builds require notarization credentials: Apple ID, App Store Connect API key, or APPLE_KEYCHAIN_PROFILE');
}

export function assertMacDistributionEnvironment(environment, identityResult) {
  const hasLinkedCertificate = present(environment, 'CSC_LINK');
  const hasNamedCertificate = present(environment, 'CSC_NAME') && environment.CSC_NAME.trim() !== '-';
  const hasLocalDeveloperId = identityResult?.status === 0 && /Developer ID Application:/i.test(identityResult.stdout ?? '');
  if (!hasLinkedCertificate && !hasNamedCertificate && !hasLocalDeveloperId) {
    throw new Error('A Developer ID Application identity is required for macOS distributable builds; use npm run pack for a local test package');
  }

  const notarization = inspectNotarizationEnvironment(environment);
  if (!/^[A-Z0-9]{10}$/.test(notarization.expectedTeamId)) {
    throw new Error('The expected Apple Team ID must contain exactly 10 uppercase letters or digits');
  }
  return notarization;
}

// Keep the release wrapper intentionally smaller than electron-builder's CLI.
// Config/project/prepackaged/publish overrides can bypass the verification hooks;
// changing those requires a reviewed edit to this project's build configuration.
export function inspectPackagingArguments(input) {
  const unsigned = input.includes('--unsigned');
  const unsignedWindowsBeta = input.includes('--unsigned-windows-beta');
  const args = input.filter((argument) => !['--unsigned', '--unsigned-windows-beta'].includes(argument));
  const targets = new Set(['dmg', 'zip', 'nsis', 'portable', 'AppImage', 'deb', 'rpm', 'tar.gz']);
  const targetValues = [];
  let acceptingTargets = false;
  for (const argument of args) {
    if (/^(?:--(?:mac|macos|win|windows|linux)|-[mowl]+)(?:=|$)/.test(argument)) {
      acceptingTargets = true;
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : null;
      if (value !== null) {
        if (!targets.has(value)) throw new Error(`Unsupported packaging target: ${value}`);
        targetValues.push(value);
      }
    } else if (['--dir', '--x64', '--arm64', '--universal', '--ia32', '--armv7l'].includes(argument)) {
      acceptingTargets = false;
    } else if (acceptingTargets && targets.has(argument)) {
      targetValues.push(argument);
    } else {
      throw new Error(`Unsupported packaging argument: ${argument}. Edit the reviewed package.json build configuration instead of overriding release policy.`);
    }
  }
  if (unsigned && (!args.includes('--dir') || targetValues.length > 0)) {
    throw new Error('Unsigned developer builds require --dir and cannot produce installers or archives; use npm run pack');
  }
  if (unsignedWindowsBeta && (unsigned || args.includes('--dir')
      || !targetsWindowsDistribution(args, 'explicit-only') || targetsMacDistribution(args, 'explicit-only') || targetsPlatform(args, 'linux', 'explicit-only')
      || args.some((argument) => ['--universal', '--ia32', '--armv7l'].includes(argument))
      || targetValues.some((target) => !['nsis', 'portable', 'zip'].includes(target)))) {
    throw new Error('Unsigned Windows beta requires an explicit Windows-only x64/arm64 distribution; it cannot be combined with developer, macOS, Linux, or directory-only builds');
  }
  return { unsigned, unsignedWindowsBeta, args };
}

function withoutSigningCredentials(environment) {
  for (const key of Object.keys(environment)) {
    if (/^(?:CSC_|WIN_CSC_|APPLE_|AZURE_)/.test(key) || ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'].includes(key)) delete environment[key];
  }
  environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

export function createPackagingPlan(input, environment, { platform = process.platform, identityResult, packageMetadata } = {}) {
  const { unsigned, unsignedWindowsBeta, args } = inspectPackagingArguments(input);
  const env = {
    ...environment,
    SATOSHI_BROWSER_UNSIGNED_BUILD: unsigned ? '1' : '0',
    SATOSHI_BROWSER_UNSIGNED_WINDOWS_BETA: unsignedWindowsBeta ? '1' : '0',
    SATOSHI_BROWSER_REQUIRE_NOTARIZATION: '0'
  };
  const builderArgs = [...args, '--publish=never'];
  if (unsignedWindowsBeta) {
    validateBetaTag(`v${packageMetadata?.version}`, packageMetadata?.version);
    const win = packageMetadata?.build?.win;
    if (packageMetadata?.build?.extends != null || packageMetadata?.build?.cscLink != null || win?.cscLink != null
        || win?.azureSignOptions != null || win?.signtoolOptions != null && Object.keys(win.signtoolOptions).length > 0) {
      throw new Error('Unsigned Windows beta cannot consume embedded signing configuration; review package.json before continuing');
    }
    withoutSigningCredentials(env);
    delete env.SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER;
    const templates = windowsArtifactTemplates('unsigned-beta');
    builderArgs.push(`--config.directories.output=release/${UNSIGNED_WINDOWS_DIRECTORY}`, '--config.forceCodeSigning=false',
      '--config.win.signAndEditExecutable=true', '--config.win.signExecutable=false', '--config.extraMetadata.betaWindowsSigning=unsigned-beta',
      `--config.win.artifactName=${templates.win}`, `--config.nsis.artifactName=${templates.nsis}`, `--config.portable.artifactName=${templates.portable}`);
  } else if (unsigned) {
    // A CI signing/notary environment must not turn local packaging into a
    // credential-consuming build. Only the explicit distribution path signs.
    withoutSigningCredentials(env);
    builderArgs.push('--config.directories.output=release/developer', '--config.mac.identity=null');
  } else if (targetsMacDistribution(args, platform)) {
    const notarization = assertMacDistributionEnvironment(env, identityResult);
    env.SATOSHI_BROWSER_EXPECTED_TEAM_ID = notarization.expectedTeamId;
    env.SATOSHI_BROWSER_REQUIRE_NOTARIZATION = '1';
    // afterSign is skipped by builder if signing never occurred. Make that an
    // error, and seal the critical settings before invoking the builder.
    builderArgs.push('--config.forceCodeSigning=true', '--config.mac.hardenedRuntime=true', '--config.mac.notarize=true');
  }
  if (!unsigned && !unsignedWindowsBeta && targetsWindowsDistribution(args, platform)) {
    if (!present(env, 'WIN_CSC_LINK') && !present(env, 'CSC_LINK')) {
      throw new Error('Windows distributable builds require WIN_CSC_LINK (or CSC_LINK) for code signing; use npm run pack for a local test package');
    }
    const publisher = expectedWindowsPublisher(env);
    env.SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER = publisher;
    builderArgs.push('--config.forceCodeSigning=true', `--config.win.signtoolOptions.publisherName=${publisher}`);
  }
  if (!unsigned && targetsPlatform(args, 'linux', platform)) builderArgs.push(...linuxReleaseMetadata(env));
  builderArgs.push('--config.afterPack=scripts/after-pack.cjs', '--config.afterSign=scripts/after-sign.cjs');
  return { args: builderArgs, environment: env };
}
