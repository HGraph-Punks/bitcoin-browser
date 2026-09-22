# Signing policy

**v0.1.0 is an explicitly unsigned public beta.** macOS DMG/ZIP filenames and Windows Setup/Portable/ZIP filenames include `unsigned`. The macOS app has an ad-hoc integrity signature for Apple silicon compatibility, but no Apple Developer ID signature or notarization. Windows executables have no Authenticode signer. Linux has no package/repository signing in this release.

Use the [platform installation guides](../README.md#download-v010-beta) for first-launch prompts and the [release guide](RELEASING.md) for the explicit build flags. Checksums check the published bytes and do not establish a verified platform publisher. Do not advertise these builds as signed, notarized or free of OS warnings.

## Future signed macOS release

Distribution mode without `--unsigned-macos-beta` requires Developer ID and notarization. The GitHub workflow's protected `beta` environment uses `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. The exported signing identity must include its private key; never put it in this repository. The team ID is checked against the resulting application signature.

The hooks verify publisher identity, hardening and notarization, staple the application ticket and check Gatekeeper before archives are built. The app's notarization does not mean the DMG container has a separate verified ticket. Test downloaded files as well as staging output. See [Apple Developer ID](https://developer.apple.com/developer-id/) for publisher setup.

## Future signed Windows release

Distribution mode without `--unsigned-windows-beta` requires the configured signing identity: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` and `SATOSHI_BROWSER_EXPECTED_WINDOWS_PUBLISHER`. GitHub supplies the latter from the public `BETA_WINDOWS_PUBLISHER` environment variable. It must exactly match the issued certificate's publisher; do not infer identity from the file being verified.

The verifier checks the app, Setup and Portable executables and requires valid timestamped signatures from the expected publisher. ZIP contents also need inspection. Signing is not a guarantee of immediate SmartScreen reputation. A hardware-backed or managed signing service needs its own tested integration; do not assume a certificate provides an exportable PFX.

## Credential boundaries

Configure environment protections before adding future signing secrets. Scope them only to the appropriate build step; never expose them to pull-request or unsigned jobs. Actions and dependencies remain pinned. Publish a complete inventory and signing status for the selected mode, preserving sandbox and runtime checks in either case.
