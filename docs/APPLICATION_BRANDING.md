# Bitcoin Browser application logo

The owner supplied the square, transparent `bitcoin-browser-logo.png` on 2026-09-21 and requested its use throughout the application. It is the source of truth. Preserve its globe/Bitcoin artwork, colors, aspect ratio and transparency; do not substitute a Unicode Bitcoin glyph, token logo, sponsor logo or AI-generated interpretation.

## Outputs and placements

| Asset | Use |
| --- | --- |
| `build/icon.icns` | macOS application/Dock icon, including 1024-pixel Retina artwork |
| `build/icon.ico` | Windows app/installer icon, seven sizes from 16 to 256 pixels |
| `build/icon.png` | 512-pixel Linux packaging icon |
| `build/icon.svg` | Font-independent compatibility wrapper embedding the exact original PNG; not vectorized artwork |
| `src/renderer/assets/bitcoin-browser-logo.png` | 256-pixel local image for the header, About, Ask Bitcoin welcome/reply labels, favicon and native window icons |
| `src/wallet/bitcoin-browser-logo.png` | Identical 256-pixel copy served within the Wallet Bridge's existing isolated origin |
| `docs/landing-page-handoff/assets/bitcoin-browser-icon.*` | Optional refreshed marketing references: original PNG and the same raster-embedded SVG |

The creator's Turtle Moon mark, HOL.org sponsorship, external wallets' own identities, curated project artwork and Bitcoin data/currency symbols are separate from the application logo and remain unchanged. Previously generated release bundles and the historical landing-page ZIP are not silently rewritten.

## Regenerate and verify

With the project's locked dependencies installed and Node 22:

```sh
npm run build:icons
npm run check:icons
```

If refreshing the optional local landing-page handoff as well:

```sh
npm run build:icons -- --marketing
npm run check:icons -- --marketing
```

The script uses the existing pinned electron-builder icon toolset and its verified download mechanism. Its first use may download that official build tool; the supplied artwork is processed locally, never uploaded. It converts to native formats and resizes without cropping, recoloring or replacing the original file. `--check` regenerates into an owned temporary directory and compares bytes; it does not overwrite the tracked outputs or generate release hashes/manifests. Optional marketing outputs are excluded unless explicitly requested.

App images are bundled in the ASAR and use existing local protocol/CSP rules. The Wallet Bridge keeps its own copy so no cross-partition image permission is needed. Adjacent text retains product identity when dynamic images fail; decorative duplicates have empty alternative text. Header spacing for macOS window controls and the single-scroll chat layout are unchanged. A source-mode Mac launch sets the Dock image explicitly; packaged Macs use the generated native icon.

Tests check PNG dimensions, native icon container sizes, matching embedded artwork across formats, local protocol delivery, retained wallet isolation, non-executable model content, accessible names and image-failure behavior. Native Windows/Linux visual acceptance and broader beta release gates remain separate qualification work.

The 2026-09-21 Mac arm64 developer build was checked in two fresh disposable profiles, including actual image decoding, native-container/ASAR byte comparison, header spacing clear of macOS window controls, and narrow About layouts. Screenshots were visually reviewed for About in both themes, Ask Bitcoin's welcome and Wallet Bridge. Both owned test processes exited cleanly; neither connected to a model or wallet. The usual approved test profile was then reopened on About with the refreshed bundle. See [implementation status](IMPLEMENTATION_STATUS.md) for the test counts, evidence location and release limitations.
