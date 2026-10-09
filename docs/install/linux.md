# Install on Linux

The release builds and native runtime checks use **Ubuntu 22.04**, with x64 and ARM64 runners. A graphical desktop is required. Other distributions may work but are not all qualified by those checks. These downloads are not repository-signed packages. Get them from the [official v0.2.0-beta.1 release](https://github.com/HGraph-Punks/bitcoin-browser/releases/tag/v0.2.0-beta.1), then [verify SHA-256](verify-download.md).

Run `uname -m`: `x86_64` means x64 / amd64; `aarch64` or `arm64` means ARM64. Pick the native architecture. The filenames follow each packaging format's naming convention.

| Processor | AppImage | DEB | RPM | tar.gz |
| --- | --- | --- | --- | --- |
| Intel / AMD 64-bit | x86_64 | amd64 | x86_64 | x64 |
| ARM64 | arm64 | arm64 | aarch64 | arm64 |

## DEB — Ubuntu / Debian family

In the download folder, install the matching file with APT so dependencies are resolved:

```sh
sudo apt install ./bitcoin-browser-0.2.0-beta.1-linux-amd64.deb
bitcoin-browser
```

For ARM64, use `bitcoin-browser-0.2.0-beta.1-linux-arm64.deb`. You can also launch **Bitcoin Browser** from your desktop's applications menu. Always launch the app as your normal user; elevated permissions are only for package installation.

## RPM — Fedora / RPM family

```sh
sudo dnf install ./bitcoin-browser-0.2.0-beta.1-linux-x86_64.rpm
bitcoin-browser
```

For ARM64, use `bitcoin-browser-0.2.0-beta.1-linux-aarch64.rpm`. A distribution using another RPM package manager needs its equivalent local-package command. Native runtime qualification uses Ubuntu, so an RPM build is not a claim that every Fedora/RHEL version has been tested.

## AppImage — single executable

```sh
chmod +x bitcoin-browser-0.2.0-beta.1-linux-x86_64.AppImage
./bitcoin-browser-0.2.0-beta.1-linux-x86_64.AppImage
```

For ARM64, substitute `arm64`. If mounting reports a missing FUSE library, install your distribution's FUSE 2 compatibility package (Ubuntu 22.04: `sudo apt install libfuse2`; Ubuntu 24.04: `libfuse2t64`). See [AppImage's FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html). If FUSE cannot be used, prefer the DEB/RPM package or tar archive.

## tar.gz — full application directory

```sh
mkdir -p "$HOME/Applications/bitcoin-browser-0.1.0"
tar -xzf bitcoin-browser-0.2.0-beta.1-linux-x64.tar.gz -C "$HOME/Applications/bitcoin-browser-0.1.0"
cd "$HOME/Applications/bitcoin-browser-0.1.0"
./bitcoin-browser
```

For ARM64, download the `linux-arm64.tar.gz` file. Keep the full extracted directory together; the executable needs its bundled resources and shared libraries. The archive does not install a desktop launcher.

## Desktop dependencies and sandbox startup

DEB/RPM installation resolves declared dependencies. AppImage/tar users need a desktop with GTK, NSS, X11/Wayland support, GBM and audio libraries. Ubuntu 22.04 build/test hosts install:

```sh
sudo apt install libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 libx11-xcb1 libdrm2 libxshmfence1
```

Library package names differ on newer distributions. An error naming a missing library identifies the package to resolve through your distribution's package manager.

If startup reports **No usable sandbox** or a `chrome-sandbox` permission error, prefer the installed DEB/RPM build and check the distribution's user-namespace/AppArmor policy. Managed machines can restrict Chromium-based applications. Do not launch as root, disable the browser sandbox, or turn off the system's namespace restrictions globally. Report your distribution, kernel and exact error so a supported package/policy can be identified.

## Updates and removal

Updates are manual. Quit, back up the [profile](../GETTING_STARTED.md#update-recover-and-report-problems), then install the newer DEB/RPM or replace the entire AppImage/tar directory. Use `sudo apt remove satoshi-browser` or `sudo dnf remove satoshi-browser` for installed packages; the internal package name is retained. AppImage/tar copies can be deleted after quitting.

The default profile is `~/.config/satoshi-browser` (or `$XDG_CONFIG_HOME/satoshi-browser`). It remains after removing the app. Delete it only if you intend to erase local data, including any managed node setup.
