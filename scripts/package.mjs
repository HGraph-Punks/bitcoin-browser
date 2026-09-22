import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPackagingPlan, inspectPackagingArguments, targetsMacDistribution } from './release-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv.slice(2);
let plan;
try {
  const { unsigned, unsignedMacosBeta, args } = inspectPackagingArguments(input);
  const identities = !unsigned && !unsignedMacosBeta && targetsMacDistribution(args) && !process.env.CSC_LINK && !process.env.CSC_NAME
    ? spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', timeout: 15_000 })
    : null;
  const packageMetadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  plan = createPackagingPlan(input, process.env, { identityResult: identities, packageMetadata });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const child = spawn(process.execPath, [cli, ...plan.args], {
  cwd: root,
  stdio: 'inherit',
  env: plan.environment
});

child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
