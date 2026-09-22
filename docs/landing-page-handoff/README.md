# Bitcoin Browser — landing-page handoff

Prepared on **2026-09-12** from the current `1.0.0-rc.1` source, including the Bitcoin Browser rename and single-scroll Ask Bitcoin workspace.

## Give Astra these files

1. [ASTRA_LANDING_PAGE_BRIEF.md](ASTRA_LANDING_PAGE_BRIEF.md) — paste-ready assignment, positioning, page structure, design direction and acceptance criteria.
2. [FEATURES_AND_CLAIMS.md](FEATURES_AND_CLAIMS.md) — detailed feature inventory, user benefits, claim boundaries and repository evidence pointers.
3. [SCREENSHOT_PLAN.md](SCREENSHOT_PLAN.md) — prioritized captures, exact destinations, captions, privacy checks and asset requirements.
4. [assets/bitcoin-browser-icon.png](assets/bitcoin-browser-icon.png) and [assets/bitcoin-browser-icon.svg](assets/bitcoin-browser-icon.svg) — refreshed on **2026-09-21** with the owner-supplied orange globe/Bitcoin mark. The PNG is the original artwork; the SVG embeds it without a font dependency and is not vectorized. These replace the old missing-glyph references, not product screenshots. See [the asset notes](assets/README.md).

**Screenshot status: no product screenshots are included yet.** The supported browser-capture connection was unavailable in this session, and no existing product captures were found in the inspected project paths. The shot list is a capture specification, not evidence that screenshots exist. Do not turn missing captures into fabricated product screens. User-supplied captures can be added after visual/privacy review.

## Product in one sentence

**Bitcoin Browser brings Bitcoin data, inscriptions, Runes, and your local AI into one desktop browsing workspace—with the option to connect or run your own data sources.**

It is a Bitcoin-native explorer with familiar browser behavior, not a replacement for a general web browser, a wallet, an exchange, or a complete global inscription search engine.

## Recommended message hierarchy

Lead with the benefit, not the implementation stack:

1. **Explore Bitcoin in one place.** Open inscriptions, Runes, transactions, blocks and public addresses with familiar tabs and search.
2. **See what lives on Bitcoin.** View art, recursive experiences, 3D objects and documents inside the browser.
3. **Ask questions. Open the evidence.** Connect LM Studio or Ollama and get source-labeled Bitcoin results you can explore.
4. **Start browsing. Add your node when you want.** Use configured public sources, connect existing services, or follow guided Core/Ord setup.

Supporting qualities: readable asset information, source transparency, local bookmarks/history, explicit privacy controls, and separation between viewed content and wallet connections.

## Critical release context

The repository currently describes this build as **in beta qualification, not approved for external testers**. The landing page can introduce the project and its implemented features; it must not imply that an unqualified installer is already a publicly approved release.

- Desktop build targets are macOS, Windows and Linux, with x64/arm64 release configurations. Configuration is not proof of installer availability or platform qualification.
- Packaged PSBT and message signing are disabled. Wallet/version compatibility and native acceptance remain qualification work.
- Native lifecycle, signing/notarization, clean-machine installation and cross-platform/manual acceptance gates remain open in the recorded project status.
- The latest recorded source checkpoint passed 1,984 tests and 438 beta boundary checks. These are engineering results, not a security certification or proof that all wallets/platforms are safe. Tests were not rerun for this documentation-only handoff.

Use **“Early beta in development”** until the owner approves a release. Do not wire a Download CTA to an unapproved artifact. No release, website, waitlist or remote upload was created by preparing this handoff.

## Inputs still needed before publication

- The approved public repository, download/release URL and supported artifact list.
- The final public domain, contact/support destination, privacy/legal links and any organization details.
- Whether the primary CTA should open a qualified download, public source page, or an existing beta-interest form.
- Actual product screenshots and permission to use any third-party artwork shown prominently.
- Actual screenshots reflecting the approved replacement application mark. The owner supplied the new logo on 2026-09-21; use the current asset files, not the historical ZIP's old icon.
- A separately reviewed decision before adding analytics, an email-collection backend or external embeds.

Do not invent these inputs. Historical internal identifiers still contain `satoshi-browser` for profile compatibility; public copy should use **Bitcoin Browser**.

## Verification scope

This pack was checked against source and current project documentation. It does not perform a new security audit, live market-data check, native UI acceptance run, or legal review. Source references in the feature inventory point into the full repository; the handoff remains readable without that checkout.
