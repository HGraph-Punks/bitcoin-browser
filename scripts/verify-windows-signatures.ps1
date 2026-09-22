param(
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Architecture,
  [ValidateSet('signed', 'unsigned-beta')][string]$SigningMode = 'signed'
)
$ErrorActionPreference = 'Stop'
if ($SigningMode -eq 'signed' -and [string]::IsNullOrWhiteSpace($env:SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER)) {
  throw 'Set the beta environment variable BETA_WINDOWS_PUBLISHER to the exact certificate publisher name before releasing.'
}
$unpackedDirectory = if ($Architecture -eq 'x64') { 'win-unpacked' } else { 'win-arm64-unpacked' }
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
$releaseDirectory = Join-Path $PSScriptRoot '../release'
$qualifier = ''
if ($SigningMode -eq 'unsigned-beta') {
  $releaseDirectory = Join-Path $releaseDirectory 'unsigned-windows-beta'
  $qualifier = '-unsigned'
}
$files = @(
  (Join-Path $releaseDirectory "$unpackedDirectory/Bitcoin Browser.exe"),
  (Join-Path $releaseDirectory "bitcoin-browser-$version-windows-$Architecture$qualifier-setup.exe"),
  (Join-Path $releaseDirectory "bitcoin-browser-$version-windows-$Architecture$qualifier-portable.exe")
)
$evidence = @(foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing beta executable: $file" }
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($SigningMode -eq 'signed' -and ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate)) {
    throw "Executable must have a valid, timestamped Authenticode signature: $file ($($signature.Status))"
  }
  [pscustomobject]@{
    file = [System.IO.Path]::GetFileName($file)
    status = $signature.Status.ToString()
    signatureType = $signature.SignatureType.ToString()
    timestamped = $null -ne $signature.TimeStamperCertificate
    publisher = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }
    subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
  }
})
# Pass only public metadata, never certificate material, to the portable policy
# tests/validator. UTF-8 preserves legal publisher names on all native runners.
$previousOutputEncoding = $OutputEncoding
try {
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  ConvertTo-Json -InputObject $evidence -Depth 3 -Compress | & node (Join-Path $PSScriptRoot 'windows-signature-policy.mjs') --arch $Architecture --mode $SigningMode
  if ($LASTEXITCODE -ne 0) { throw 'Windows signature identity/inventory verification failed.' }
} finally {
  $OutputEncoding = $previousOutputEncoding
}
