import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateWindowsSignatures } from '../scripts/windows-signature-policy.mjs';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const publisher = 'Éditeur & Example, Inc.';
const script = fileURLToPath(new URL('../scripts/windows-signature-policy.mjs', import.meta.url));
function fixture(arch = 'x64') {
  return ['Bitcoin Browser.exe', `bitcoin-browser-${version}-windows-${arch}-setup.exe`, `bitcoin-browser-${version}-windows-${arch}-portable.exe`]
    .map((file) => ({ file, status: 'Valid', signatureType: 'Authenticode', timestamped: true,
      publisher, subject: `CN=${publisher}, O=Example, C=US` }));
}
const options = { version, arch: 'x64', publisher };

test('Windows signature policy accepts all three timestamped executables from the expected publisher on each architecture', () => {
  for (const arch of ['x64', 'arm64']) {
    const evidence = fixture(arch);
    assert.deepEqual(validateWindowsSignatures(evidence, { ...options, arch }), {
      publisher, files: evidence.map((item) => item.file).sort(), signingMode: 'signed'
    });
  }
});

function unsignedFixture(arch = 'x64') {
  return fixture(arch).map((item) => ({
    file: item.file.replace(`-windows-${arch}`, `-windows-${arch}-unsigned`),
    status: 'NotSigned', signatureType: 'None', timestamped: false, publisher: null, subject: null
  }));
}

test('an explicitly selected unsigned beta requires NotSigned metadata for all three distinctly named executables', () => {
  for (const arch of ['x64', 'arm64']) {
    const evidence = unsignedFixture(arch);
    assert.deepEqual(validateWindowsSignatures(evidence, { version, arch, signingMode: 'unsigned-beta' }), {
      publisher: null, files: evidence.map((item) => item.file).sort(), signingMode: 'unsigned-beta'
    });
  }
  assert.throws(() => validateWindowsSignatures(unsignedFixture(), options), /exactly the application/);
  assert.throws(() => validateWindowsSignatures(fixture(), { ...options, signingMode: 'unsigned-beta' }), /exactly the application/);
});

test('unsigned status checks reject broken, partial, accidentally signed, and uncertain signatures instead of treating them as unsigned', () => {
  for (let index = 0; index < 3; index += 1) {
    for (const mutation of [{ status: 'HashMismatch' }, { status: 'UnknownError' }, { status: 'Valid' }, { status: 'NotTrusted' },
      { signatureType: 'Authenticode' }, { signatureType: 'Catalog' }, { timestamped: true }, { publisher: 'Fixture' }, { subject: 'CN=Fixture' }]) {
      const evidence = unsignedFixture();
      Object.assign(evidence[index], mutation);
      assert.throws(() => validateWindowsSignatures(evidence, { version, arch: 'x64', signingMode: 'unsigned-beta' }), /Explicit unsigned beta must be unsigned/);
    }
  }
});

test('the real CLI accepts unsigned Windows only through its explicit mode argument and does not require credentials', () => {
  const result = run(JSON.stringify(unsignedFixture()), {}, ['--arch', 'x64', '--mode', 'unsigned-beta']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 3);
  assert.match(result.stdout, /Verified explicitly UNSIGNED beta executable/);
  assert.doesNotMatch(result.stdout, /configured publisher/);
  const implicit = run(JSON.stringify(unsignedFixture()), { BETA_WINDOWS_SIGNING: 'unsigned-beta' });
  assert.equal(implicit.status, 1);
  assert.match(implicit.stderr, /EXPECTED_WINDOWS_PUBLISHER/);
  const invalid = run(JSON.stringify(unsignedFixture()), {}, ['--arch', 'x64', '--mode', 'auto']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Windows signing must be/);
});

test('matching app and installer identities cannot substitute for the expected publisher', () => {
  const evidence = fixture().map((item) => ({ ...item, publisher: 'Another Publisher', subject: 'CN=Another Publisher' }));
  assert.throws(() => validateWindowsSignatures(evidence, options), /configured Windows publisher/);
  assert.throws(() => validateWindowsSignatures(fixture(), { ...options, publisher: undefined }), /EXPECTED_WINDOWS_PUBLISHER/);
});

test('every executable independently requires an embedded, trusted, timestamped signature', () => {
  for (let index = 0; index < 3; index += 1) {
    for (const mutation of [
      { status: 'NotSigned' }, { status: 'NotTrusted' }, { status: 'HashMismatch' }, { status: 'UnknownError' },
      { status: null }, { signatureType: 'Catalog' }, { signatureType: 'None' },
      { timestamped: false }, { timestamped: 'true' }, { timestamped: null }
    ]) {
      const evidence = fixture();
      Object.assign(evidence[index], mutation);
      assert.throws(() => validateWindowsSignatures(evidence, options), /valid, embedded, timestamped/);
    }
  }
});

test('exact publisher spelling and full subject agreement are mandatory for each executable', () => {
  for (let index = 0; index < 3; index += 1) {
    for (const mutation of [{ publisher: publisher.toLowerCase() }, { publisher: `${publisher} ` }, { publisher: null },
      { subject: '' }, { subject: null }, { subject: 'x'.repeat(4097) }, { subject: 'CN=bad\nsubject' }, { subject: 'CN=another legal entity' }]) {
      const evidence = fixture();
      Object.assign(evidence[index], mutation);
      assert.throws(() => validateWindowsSignatures(evidence, options), /publisher|subject/);
    }
  }
});

test('missing, duplicate, extra, wrong-version, and wrong-architecture signature inventories fail closed', () => {
  const evidence = fixture();
  for (const input of [null, {}, [], evidence.slice(1), [evidence[0], evidence[0], evidence[2]], [...evidence, evidence[0]],
    [null, evidence[1], evidence[2]], evidence.map((item) => ({ ...item, file: `other-${item.file}` })), fixture('arm64')]) {
    assert.throws(() => validateWindowsSignatures(input, options), /exactly the application/);
  }
  assert.throws(() => validateWindowsSignatures(evidence, { ...options, arch: 'ia32' }), /supported Windows architecture/);
});

function run(input, env = { SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER: publisher }, args = ['--arch', 'x64']) {
  return spawnSync(process.execPath, [script, ...args], { input, env, encoding: 'utf8', timeout: 5_000 });
}

test('the real signature CLI accepts UTF-8 public metadata and emits only allowlisted filenames', () => {
  const result = run(JSON.stringify(fixture()));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 3);
  assert.match(result.stdout, /Verified signed executable for configured publisher: Bitcoin Browser.exe/);
  assert.doesNotMatch(result.stdout, /CN=|Éditeur/);
});

test('the real signature CLI rejects malformed, oversized, incomplete, and unconfigured evidence', () => {
  for (const [input, env, args, pattern] of [
    ['not json', undefined, undefined, /valid JSON/],
    ['x'.repeat(65 * 1024), undefined, undefined, /64 KiB limit/],
    [JSON.stringify(fixture()), {}, undefined, /EXPECTED_WINDOWS_PUBLISHER/],
    [JSON.stringify(fixture().slice(0, 2)), undefined, undefined, /exactly the application/],
    [JSON.stringify(fixture()), undefined, ['--arch', 'ia32'], /Usage:/]
  ]) {
    const result = run(input, env, args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, pattern);
    assert.equal(result.stdout, '');
  }
});

test('Windows metadata reader uses literal artifact paths, the native trust verdict, UTF-8, and a checked policy exit', () => {
  const source = fs.readFileSync(new URL('../scripts/verify-windows-signatures.ps1', import.meta.url), 'utf8');
  assert.match(source, /Get-AuthenticodeSignature -LiteralPath \$file/);
  assert.match(source, /\$signature\.Status -ne 'Valid'/);
  assert.match(source, /\$null -eq \$signature\.TimeStamperCertificate/);
  assert.match(source, /X509NameType\]::SimpleName, \$false/);
  assert.match(source, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(source, /windows-signature-policy\.mjs/);
  assert.match(source, /\$LASTEXITCODE -ne 0/);
  assert.doesNotMatch(source, /cert:\\|Export-PfxCertificate|Get-ChildItem|Set-AuthenticodeSignature/);
});
