# Verify a download

Download the app file and **SHA256SUMS** from the same [official v0.2.0-beta.1 release](https://github.com/HGraph-Punks/bitcoin-browser/releases/tag/v0.2.0-beta.1). Confirm the owner is **HGraph-Punks**, the repository is **bitcoin-browser**, and the tag is **v0.2.0-beta.1**.

## macOS

In Terminal, type `shasum -a 256 ` (including the trailing space), drag the downloaded file into the window and press Enter. Compare all 64 hexadecimal characters with the entry for that exact filename in SHA256SUMS.

Example for Apple silicon:

```sh
cd ~/Downloads
shasum -a 256 bitcoin-browser-0.2.0-beta.1-macos-arm64-unsigned.dmg
```

## Windows

Open PowerShell in the download folder:

```powershell
Get-FileHash .\bitcoin-browser-0.2.0-beta.1-windows-x64-unsigned-setup.exe -Algorithm SHA256
```

Compare the complete Hash value with the corresponding SHA256SUMS entry; uppercase/lowercase does not matter. Substitute the filename you actually downloaded.

## Linux

```sh
cd ~/Downloads
sha256sum bitcoin-browser-0.2.0-beta.1-linux-x86_64.AppImage
```

Compare the whole hash with the exact filename's SHA256SUMS entry. If you downloaded the entire release set, `sha256sum --check SHA256SUMS` checks it together; missing assets will otherwise be reported as missing.

A mismatch means the file is not the release's recorded bytes: do not open it; re-download and report a repeated mismatch. Matching hashes detect corruption or substitution relative to the published list. They do not prove an unsigned app is safe and do not replace a platform publisher signature.
