# Install on Windows

Use a supported 64-bit Windows installation; **Windows 11** is the recommended desktop baseline. Choose **x64** for Intel/AMD or **arm64** for Windows on ARM. Find **System type** in Settings → System → About. There is no 32-bit build. Download from the [v0.1.0 release](https://github.com/HGraph-Punks/bitcoin-browser/releases/tag/v0.1.0) and [verify the SHA-256 hash](verify-download.md).

The application, setup and portable executables are **unsigned beta builds** with no Authenticode publisher certificate. The filenames include `unsigned`. Windows may warn or block them.

## Setup EXE — standard installation

1. Download `bitcoin-browser-0.1.0-windows-x64-unsigned-setup.exe` (or the `arm64` version).
2. Open it. Review any Windows prompt using the guidance below.
3. Follow the installer to choose the offered installation location and finish.
4. Open **Bitcoin Browser** from the Start menu, then follow [getting started](../GETTING_STARTED.md).

## Portable EXE — no installer

1. Download `bitcoin-browser-0.1.0-windows-x64-unsigned-portable.exe` (or `arm64`).
2. Save it in a folder you can write to and open it normally. The first launch may take longer while files are extracted.
3. Keep the EXE for later launches. No Start menu installation is required.

“Portable” describes the launcher, not a self-contained browsing profile: settings and history still use `%APPDATA%\satoshi-browser` on this computer. Do not assume they travel with the EXE.

## ZIP — unpacked application

1. Download `bitcoin-browser-0.1.0-windows-x64-unsigned.zip` (or `arm64`).
2. Right-click → **Extract All** into a permanent folder.
3. Open **Bitcoin Browser.exe** inside that folder. Keep all DLLs, resources, locales and other files alongside it; do not run directly inside the ZIP.

## Windows security prompts

For an ordinary SmartScreen reputation warning, Windows may offer **More info → Run anyway**. Only use an offered exception after verifying this beta's source and hash. **Unknown publisher** is expected for this unsigned release. Run the browser as your normal user, not as administrator.

Smart App Control or an organization's policy can block unsigned software without a per-app exception. This beta may not run on that configuration; keep those protections enabled and report the limitation. [Microsoft explains Smart App Control's treatment of untrusted apps](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions). Do not disable antivirus or ignore a malware detection.

## Updates and removal

Quit all Bitcoin Browser windows. For Setup, run the next version's installer. For ZIP, extract the new release into a new folder instead of mixing DLLs. For Portable, replace the launcher after quitting. Back up the [profile](../GETTING_STARTED.md#update-recover-and-report-problems) first.

Remove an installed copy through Settings → Apps → Installed apps. Delete a portable EXE or ZIP folder to remove that copy. Profile data remains at `%APPDATA%\satoshi-browser`; remove it separately only if you intend to erase it.
