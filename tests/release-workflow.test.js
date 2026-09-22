import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { BETA_TARGETS, expectedAssets, validateBetaTag, windowsArtifactTemplates } from '../scripts/beta-release.mjs';
import { createPackagingPlan, linuxReleaseMetadata } from '../scripts/release-policy.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const releaseSource = await fs.readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const ciSource = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = yaml.load(releaseSource);
const ci = yaml.load(ciSource);
const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const steps = (job) => job.steps ?? [];

test('the beta package and lockfile roots agree before release tagging', () => {
  assert.equal(validateBetaTag(`v${pkg.version}`, pkg.version), `v${pkg.version}`);
  for (const root of [lock, lock.packages['']]) {
    assert.equal(root.name, pkg.name);
    assert.equal(root.version, pkg.version);
  }
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
});

test('CI and release use immutable official actions, read-only defaults, and no credential persistence', () => {
  for (const workflow of [ci, release]) {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.ok(job['timeout-minutes'] > 0, name);
      assert.equal(job['continue-on-error'], undefined);
      for (const step of steps(job)) {
        assert.equal(step['continue-on-error'], undefined);
        if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
        if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with['package-manager-cache'], false);
      }
    }
    assert.equal(workflow.on.pull_request_target, undefined);
    assert.equal(workflow.on.workflow_run, undefined);
  }
});

test('PR and weekly checks are credential-free and high/critical audit failures block release', () => {
  assert.doesNotMatch(ciSource, /secrets\.|contents: write/);
  assert.equal(ci.on.schedule.length, 1);
  for (const job of [ci.jobs.verify, release.jobs.verify]) {
    for (const command of ['npm run verify', 'npm run security:beta', 'npm audit --audit-level=high']) {
      assert.ok(steps(job).some((step) => step.run === command), command);
    }
    assert.ok(steps(job).some((step) => step.run === 'npm ci --ignore-scripts --no-audit --no-fund'));
    assert.doesNotMatch(JSON.stringify(job), /secrets\.|omit=dev|audit fix/);
  }
});

test('every release job checks out the planned commit and build gates precede installer uploads', () => {
  assert.deepEqual(release.jobs.build.needs, ['plan', 'verify']);
  assert.deepEqual(release.jobs.publish.needs, ['plan', 'verify', 'build']);
  assert.equal(release.jobs.build.strategy['fail-fast'], false);
  assert.equal(release.jobs.build.strategy.matrix, '${{ fromJSON(needs.plan.outputs.matrix) }}');
  for (const name of ['verify', 'build', 'publish']) {
    const checkout = steps(release.jobs[name]).find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ needs.plan.outputs.commit }}');
  }
  const build = steps(release.jobs.build);
  const stageIndex = build.findIndex((step) => step.run?.includes('beta-release.mjs stage'));
  const uploadIndex = build.findIndex((step) => step.with?.name === 'beta-installers-${{ matrix.id }}');
  const smokeIndexes = build.flatMap((step, index) => step.run?.includes('smoke:packaged -- --distribution') ? [index] : []);
  assert.equal(smokeIndexes.length, 4);
  assert.ok(smokeIndexes.every((index) => index < stageIndex && stageIndex < uploadIndex));
  assert.equal(build[uploadIndex].if, undefined, 'installers upload only on success');
  assert.ok(build.some((step) => step.run === 'npm run verify'));
  assert.ok(build.some((step) => step.run?.includes('assert-native')));
  assert.doesNotMatch(releaseSource + ciSource, /--no-sandbox|disable.*sandbox|sysctl|source:archive|sha256sum|shasum|checksum/i);
});

test('signing credentials are protected and scoped only to their platform build step', () => {
  assert.equal(release.jobs.build.environment, 'beta');
  assert.equal(release.jobs.publish.environment, 'beta');
  const privileged = steps(release.jobs.build).filter((step) => JSON.stringify(step).includes('secrets.'));
  assert.equal(privileged.length, 2);
  const mac = privileged.find((step) => step.if === "runner.os == 'macOS' && needs.plan.outputs.macos_signing == 'signed'");
  const windows = privileged.find((step) => step.if === "runner.os == 'Windows' && needs.plan.outputs.windows_signing == 'signed'");
  assert.equal(mac.env.CSC_LINK, '${{ secrets.CSC_LINK }}');
  assert.equal(mac.env.APPLE_TEAM_ID, '${{ secrets.APPLE_TEAM_ID }}');
  assert.equal(windows.env.WIN_CSC_LINK, '${{ secrets.WIN_CSC_LINK }}');
  assert.equal(windows.env.SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER, '${{ vars.BETA_WINDOWS_PUBLISHER }}');
  assert.doesNotMatch(JSON.stringify(windows), /APPLE_/);
  assert.ok(steps(release.jobs.build).some((step) => step.shell === 'pwsh' && step.run.includes('verify-windows-signatures.ps1')));
  for (const [name, job] of Object.entries(release.jobs)) {
    if (name === 'publish') assert.deepEqual(job.permissions, { contents: 'write' });
    else assert.equal(job.permissions, undefined);
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), /secrets\./);
  }
});

test('Windows signature verification uses the independently configured public publisher and receives no signing secrets', () => {
  const verification = steps(release.jobs.build).find((step) => step.run?.includes('verify-windows-signatures.ps1'));
  assert.deepEqual(verification.env, { SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: '${{ vars.BETA_WINDOWS_PUBLISHER }}' });
  assert.equal(verification.if, "runner.os == 'Windows'");
  assert.equal(verification.shell, 'pwsh');
  assert.doesNotMatch(JSON.stringify(verification), /secrets\./);
});

test('release download staging is separated from bounded test evidence', () => {
  const uploads = Object.values(release.jobs).flatMap(steps).filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].with.path, 'release/beta-assets/${{ matrix.id }}/*');
  assert.equal(uploads[0].with['if-no-files-found'], 'error');
  assert.equal(uploads[1].with.path, 'release/packaged-smoke-beta-${{ matrix.id }}.json');
  assert.equal(uploads[1].if, 'always()');
  const download = steps(release.jobs.publish).find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.pattern, 'beta-installers-*');
  assert.equal(download.with['merge-multiple'], true);
  assert.equal(steps(release.jobs.publish).at(-1).run, 'node scripts/beta-release.mjs draft');
  assert.doesNotMatch(ciSource + releaseSource, /path: release\/\*\*|release\/\*\.yml|release\/\*\.blockmap/);
});

test('manual and pushed beta tags share a strict gate that runs before checkout', () => {
  assert.deepEqual(release.on.push.tags, ['v*-beta.*', 'v*-rc.*']);
  assert.equal(release.on.workflow_dispatch.inputs.tag.required, true);
  assert.deepEqual(release.on.workflow_dispatch.inputs.platforms.options, ['all', 'macos', 'windows', 'linux']);
  const first = release.jobs.plan.steps[0];
  const inline = first.run.match(/^node -e '([\s\S]*)'\s*$/)?.[1];
  assert.ok(inline, 'pre-checkout validation must not evaluate shell-interpolated inputs');
  for (const tag of ['v1.0.0-rc.1', 'v1.2.3-beta.0', 'master', 'v1.0.0', 'v1.0.0-rc.1\n', 'v1.0.0-rc.1; echo unsafe']) {
    const result = spawnSync(process.execPath, ['-e', inline], { env: { BETA_TAG: tag }, encoding: 'utf8' });
    assert.equal(result.status, ['v1.0.0-rc.1', 'v1.2.3-beta.0'].includes(tag) ? 0 : 1, tag);
  }
});

test('packager artifact templates match all staged filenames and preserve existing formats', () => {
  const { Arch, getArtifactArchName } = require('builder-util');
  const { expandMacro } = require('app-builder-lib/out/util/macroExpander.js');
  const names = [];
  for (const target of BETA_TARGETS) {
    const config = pkg.build[target.builder];
    for (const format of config.target) {
      const template = pkg.build[format]?.artifactName ?? config.artifactName;
      const ext = ['nsis', 'portable'].includes(format) ? 'exe' : format;
      names.push(expandMacro(template, getArtifactArchName(Arch[target.arch], ext), { version: pkg.version }, { ext }));
    }
  }
  assert.deepEqual(names.sort(), expectedAssets(pkg.version));
  assert.equal(pkg.build.linux.executableName, 'bitcoin-browser');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.cjs');
  assert.equal(pkg.build.afterSign, 'scripts/after-sign.cjs');
});

test('Linux release defaults use the owner-confirmed repository and public maintainer contact', () => {
  assert.equal(pkg.homepage, 'https://github.com/HGraph-Punks/bitcoin-browser');
  assert.deepEqual(pkg.repository, { type: 'git', url: `${pkg.homepage}.git` });
  assert.equal(pkg.build.linux.maintainer, 'Turtle Moon Command Center <patches@turtlemoon.io>');
  assert.deepEqual(pkg.author, { name: 'Turtle Moon Command Center', email: 'patches@turtlemoon.io' });
  const linux = steps(release.jobs.build).find((step) => step.run?.startsWith('npm run dist:linux'));
  assert.equal(linux.env.SATOSHI_BROWSER_RELEASE_HOMEPAGE, '${{ github.server_url }}/${{ github.repository }}');
  assert.equal(linux.env.SATOSHI_BROWSER_LINUX_MAINTAINER,
    "${{ vars.BETA_LINUX_MAINTAINER || '" + pkg.build.linux.maintainer + "' }}");
  assert.deepEqual(linuxReleaseMetadata({
    SATOSHI_BROWSER_RELEASE_HOMEPAGE: pkg.homepage,
    SATOSHI_BROWSER_LINUX_MAINTAINER: pkg.build.linux.maintainer
  }), [
    `--config.extraMetadata.homepage=${pkg.homepage}`,
    `--config.linux.maintainer=${pkg.build.linux.maintainer}`
  ]);
});

test('unsigned Windows is selected explicitly, receives no signing secrets, and retains native smoke plus status verification', () => {
  const input = release.on.workflow_dispatch.inputs.windows_signing;
  assert.equal(input.required, true);
  assert.equal(input.default, 'signed');
  assert.deepEqual(input.options, ['signed', 'unsigned-beta']);
  assert.equal(release.jobs.plan.env.BETA_WINDOWS_SIGNING, "${{ inputs.windows_signing || 'signed' }}");
  assert.equal(release.jobs.plan.outputs.windows_signing, '${{ steps.plan.outputs.windows_signing }}');
  const build = steps(release.jobs.build);
  const unsigned = build.find((step) => step.run?.startsWith('npm run dist:win') && step.run.includes('--unsigned-windows-beta'));
  assert.equal(unsigned.if, "runner.os == 'Windows' && needs.plan.outputs.windows_signing == 'unsigned-beta'");
  assert.equal(unsigned.env, undefined);
  assert.doesNotMatch(JSON.stringify(unsigned), /secrets\./);
  const smoke = build.find((step) => step.run?.includes('smoke:packaged') && step.run.includes('--unsigned-windows-beta'));
  assert.equal(smoke.if, unsigned.if);
  assert.match(smoke.run, /--distribution --unsigned-windows-beta/);
  const signature = build.find((step) => step.run?.includes('verify-windows-signatures.ps1'));
  assert.equal(signature.if, "runner.os == 'Windows'");
  assert.match(signature.run, /-SigningMode \$\{\{ needs.plan.outputs.windows_signing \}\}/);
  const stage = build.find((step) => step.run?.includes('beta-release.mjs stage'));
  assert.equal(stage.env.BETA_WINDOWS_SIGNING, '${{ needs.plan.outputs.windows_signing }}');
  assert.equal(steps(release.jobs.publish).at(-1).env.BETA_WINDOWS_SIGNING, '${{ needs.plan.outputs.windows_signing }}');
  assert.equal(build.find((step) => step.run?.startsWith('npm run dist:mac')).if, "runner.os == 'macOS' && needs.plan.outputs.macos_signing == 'signed'", 'Windows choice must never control Mac signing');
});

test('unsigned Windows filenames match the pinned builder macros without colliding with signed downloads', () => {
  const { Arch, getArtifactArchName } = require('builder-util');
  const { expandMacro } = require('app-builder-lib/out/util/macroExpander.js');
  const templates = windowsArtifactTemplates('unsigned-beta');
  const windows = BETA_TARGETS.filter((target) => target.platform === 'win32');
  const names = windows.flatMap((target) => ['nsis', 'portable', 'zip'].map((format) => {
    const ext = format === 'zip' ? 'zip' : 'exe';
    return expandMacro(templates[format] ?? templates.win, getArtifactArchName(Arch[target.arch], ext), { version: pkg.version }, { ext });
  })).sort();
  assert.deepEqual(names, expectedAssets(pkg.version, windows, 'unsigned-beta'));
  assert.ok(names.every((name) => !expectedAssets(pkg.version).includes(name)));
});

test('the pinned unsigned Windows builder retains icon/resource editing but has no certificate or signing backend', async () => {
  const yargs = require('yargs/yargs');
  const { configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder.js');
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  const { WindowsSignToolManager } = require('app-builder-lib/out/codeSign/windowsSignToolManager.js');
  const { WinPackager } = require('app-builder-lib/out/winPackager.js');
  const plan = createPackagingPlan(['--win', 'nsis', '--x64', '--unsigned-windows-beta'], { WIN_CSC_LINK: 'NEVER_USE' },
    { platform: 'darwin', packageMetadata: pkg });
  const parsed = normalizeOptions(configureBuildCommand(yargs(plan.args).parserConfiguration({ 'camel-case-expansion': false }).exitProcess(false)).parse());
  const configuration = { ...pkg.build, ...parsed.config, win: { ...pkg.build.win, ...parsed.config.win } };
  await validateConfiguration(configuration, { isEnabled: false });
  assert.equal(configuration.forceCodeSigning, false);
  assert.equal(configuration.win.signAndEditExecutable, true);
  assert.equal(configuration.win.signExecutable, false);
  assert.equal(configuration.win.icon, 'build/icon.ico');
  assert.equal(configuration.extraMetadata.betaWindowsSigning, 'unsigned-beta');
  assert.equal(configuration.afterPack, 'scripts/after-pack.cjs');
  assert.equal(configuration.afterSign, 'scripts/after-sign.cjs');
  const manager = new WindowsSignToolManager({
    platformSpecificBuildOptions: configuration.win,
    getCscLink: (key) => plan.environment[key] ?? plan.environment.CSC_LINK,
    getCscPassword: () => { throw new Error('Unsigned build attempted credential access'); },
    vm: { get value() { throw new Error('Unsigned build attempted certificate-store access'); } },
    appInfo: { type: 'module', productName: 'Bitcoin Browser', computePackageUrl: async () => pkg.homepage },
    info: { getWorkspaceRoot: async () => process.cwd() }
  });
  assert.equal(await manager.cscInfo.value, null);
  assert.equal(await manager.computedPublisherName.value, null);
  assert.equal(await manager.signFile({ path: 'Fixture.exe', options: configuration.win }), false);
  for (const file of ['Fixture.exe', 'Fixture-setup.exe', 'Fixture-portable.exe']) {
    assert.equal(await WinPackager.prototype.signIf.call({
      platformSpecificBuildOptions: configuration.win,
      shouldSignFile: () => true,
      _sign: () => { throw new Error('Unsigned build reached the signing backend'); }
    }, file), false);
  }
});

test('the actual pinned electron-builder schema accepts the expanded distribution configuration', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  await validateConfiguration(pkg.build, { isEnabled: false });
  await validateConfiguration({ ...pkg.build,
    extraMetadata: { homepage: 'https://github.com/test-owner/browser' },
    linux: { ...pkg.build.linux, maintainer: 'Fixture Publisher <publisher@example.test>' }
  }, { isEnabled: false });
});

test('the pinned builder parses a Windows publisher as one literal value without changing release controls', async () => {
  const yargs = require('yargs/yargs');
  const { configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder.js');
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  for (const publisher of ['Fixture Publisher, Inc.', 'Éditeur & Example', 'Example --publish=always --config.afterSign=null']) {
    const plan = createPackagingPlan(['--win', 'nsis', '--x64'], {
      WIN_CSC_LINK: 'TEST_ONLY', SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: publisher
    }, { platform: 'linux' });
    const parsed = normalizeOptions(configureBuildCommand(yargs(plan.args)
      .parserConfiguration({ 'camel-case-expansion': false }).exitProcess(false)).parse());
    assert.equal(parsed.config.win.signtoolOptions.publisherName, publisher);
    assert.equal(parsed.publish, 'never');
    assert.equal(parsed.config.afterSign, 'scripts/after-sign.cjs');
    const configuration = { ...pkg.build, ...parsed.config, win: { ...pkg.build.win, ...parsed.config.win } };
    await validateConfiguration(configuration, { isEnabled: false });
    assert.equal(configuration.forceCodeSigning, true);
  }
});
