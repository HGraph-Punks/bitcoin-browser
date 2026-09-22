import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedWindowsPublisher } from './release-policy.mjs';
import { expectedAssets, selectedTargets, validateWindowsSigning } from './beta-release.mjs';

// PowerShell supplies public metadata from Get-AuthenticodeSignature. Windows
// performs cryptographic/trust verification; this helper enforces our release
// identity and inventory contract. It never reads a certificate store or key.
export function validateWindowsSignatures(evidence, { version, arch, publisher, signingMode = 'signed' }) {
  validateWindowsSigning(signingMode);
  const expectedPublisher = signingMode === 'signed'
    ? expectedWindowsPublisher({ SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: publisher }) : null;
  if (!['x64', 'arm64'].includes(arch)) throw new Error('A supported Windows architecture is required');
  const targets = selectedTargets('windows').filter((target) => target.arch === arch);
  const expected = ['Bitcoin Browser.exe', ...expectedAssets(version, targets, signingMode).filter((name) => name.endsWith('.exe'))].sort();
  if (!Array.isArray(evidence) || evidence.length !== expected.length
      || evidence.some((item) => !item || typeof item !== 'object' || typeof item.file !== 'string')
      || JSON.stringify(evidence.map((item) => item.file).sort()) !== JSON.stringify(expected)) {
    throw new Error('Windows signature evidence must include exactly the application, setup installer, and portable executable');
  }
  let subject;
  for (const item of evidence) {
    if (signingMode === 'unsigned-beta') {
      if (item.status !== 'NotSigned' || item.signatureType !== 'None' || item.timestamped !== false || item.publisher !== null || item.subject !== null) {
        throw new Error(`Explicit unsigned beta must be unsigned, not signed or carrying a broken signature: ${item.file}`);
      }
      continue;
    }
    if (item.status !== 'Valid' || item.signatureType !== 'Authenticode' || item.timestamped !== true) {
      throw new Error(`Executable must have a valid, embedded, timestamped Authenticode signature: ${item.file}`);
    }
    if (item.publisher !== expectedPublisher) throw new Error(`Executable does not match the configured Windows publisher: ${item.file}`);
    if (typeof item.subject !== 'string' || !item.subject.trim() || item.subject.length > 4096 || /[\u0000-\u001f\u007f]/.test(item.subject)) {
      throw new Error(`Executable has missing or invalid signer subject metadata: ${item.file}`);
    }
    subject ??= item.subject;
    if (item.subject !== subject) throw new Error(`Installer publisher does not match the application: ${item.file}`);
  }
  return { publisher: expectedPublisher, files: expected, signingMode };
}

async function main() {
  if (![4, 6].includes(process.argv.length) || process.argv[2] !== '--arch' || !['x64', 'arm64'].includes(process.argv[3])
      || process.argv.length === 6 && process.argv[4] !== '--mode') {
    throw new Error('Usage: node scripts/windows-signature-policy.mjs --arch x64|arm64 [--mode signed|unsigned-beta] (public signature JSON on stdin)');
  }
  const signingMode = validateWindowsSigning(process.argv[5]);
  const publisher = signingMode === 'signed' ? expectedWindowsPublisher(process.env) : null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('Windows signature evidence exceeds its 64 KiB limit');
    chunks.push(chunk);
  }
  let evidence;
  try { evidence = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Windows signature evidence must be valid JSON'); }
  const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = validateWindowsSignatures(evidence, { version, arch: process.argv[3], publisher, signingMode });
  for (const file of result.files) console.log(signingMode === 'signed'
    ? `Verified signed executable for configured publisher: ${file}` : `Verified explicitly UNSIGNED beta executable: ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
