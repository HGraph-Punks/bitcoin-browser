# Sponsors and sponsorship inquiries

The project owner identifies **HOL.org** as a sponsoring partner of Bitcoin Browser. Sponsors is an offline internal page at `satnav://sponsors`, reachable from the bottom-left sidebar, About, Help → Sponsors, and the command palette. Searching for Sponsors, HOL.org or Sponsorship finds the same page. Partner recognition uses accessible text, not a fabricated logo or a hotlinked image. No sponsorship tier, payment amount, response deadline or automatic approval is promised.

Companies and individuals are welcome to inquire about sponsorship by opening an issue in the project's GitHub repository. **Inquire on GitHub** opens a prepared issue draft with the title **Sponsorship inquiry**, a short introduction, space for public information and a description of the proposed support. The user signs in if needed, reviews the draft, and submits it on GitHub. The browser never creates or submits an issue itself.

## Destinations and public availability

- Partner website: [HOL.org](https://hol.org/), provided by the owner and checked on 2026-09-18.
- Repository: [HGraphPunks/satoshi-browser-1.0.0-rc.1](https://github.com/HGraphPunks/satoshi-browser-1.0.0-rc.1), taken from this checkout's `origin` remote on 2026-09-18.
- Issue destination: the repository's `/issues/new` page, with only static `title` and `body` query parameters. The use of these parameters follows [GitHub's documented issue-draft links](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue#creating-an-issue-from-a-url-query). No labels, assignees, access tokens or runtime user data are included.

**Publication check still required:** an unauthenticated request to this repository's `/issues` page returned HTTP 404 on 2026-09-18. This does not distinguish private, inaccessible, unavailable or moved repositories. The configured origin is retained pending the owner's confirmation or a replacement public URL. Before advertising sponsorship to everyone, the owner must confirm that this is the intended public repository, enable Issues if necessary, and test the draft link with an ordinary GitHub account. No repository visibility/settings changes, authenticated account access or remote writes were performed. Update `SPONSORSHIP_REPOSITORY` in `src/renderer/sponsors.js` and its tests/documentation if the public destination changes.

## Privacy and interaction boundaries

The page does not fetch sponsor listings, logos or GitHub metadata. It has no payment form, analytics, wallet connection, credentials, GitHub OAuth or new dependency. An optional donation card now shows the owner-approved Bitcoin mainnet address and locally bundled QR, with explicit copy and system-wallet handoff actions; see [donation behavior](DONATIONS.md). No amount is preset and the browser never signs or sends a donation. Both external website links—including middle-clicks—use the existing main-process external-browser confirmation. Cancellation or failure leaves Sponsors in place; errors use the normal feedback path. Accepting opens the user's system browser under that browser's privacy/network settings.

The issue draft contains only fixed public instructions, never diagnostic files, logs, wallet addresses, settings or chat. The page and draft remind the user that issues may be public and not to include private contact details, credentials, seed phrases or payment information. The draft URL is static and under 1,500 characters. The Sponsors renderer adds no IPC, provider, sandbox or CSP authority.

Sponsors uses the app's theme tokens, one page scrollbar, responsive stacked cards, descriptive link names, visible keyboard focus and 44px-minimum link targets. The sidebar's upper navigation can scroll only when space is insufficient, keeping Settings, Sponsors and About visible in the fixed bottom section without squeezing its controls. Live source/cache updates preserve the page's DOM, link focus and scroll position. Explicit navigation and tab changes use the normal view lifecycle.

## Acceptance checks

- Open Sponsors from the sidebar, About, Help and command search; verify its title and HOL.org's sponsoring-partner credit.
- Check dark/light themes, a narrow window, increased zoom and an open inspector. Both cards and all text/actions should remain readable without a nested page scrollbar.
- Tab to both links, and confirm that their names describe the destination. Source/cache updates must not reset focus or scroll.
- Activate each link by ordinary click and middle-click; cancel the external confirmation and verify that Sponsors stays open. Accept only if you intend to visit HOL.org or GitHub in your system browser.
- With repository access, verify that **Inquire on GitHub** shows the expected title and body, without creating an issue. Do not submit a test inquiry unless deliberately requested by the owner.
- Verify that Back/Forward and the About entry work and that both pages show the same donation address/QR. Donation copying and wallet handoff are separate explicit actions; loading the page must not copy, launch, connect or send anything.

Controlled DOM/renderer/navigation tests cover the sponsorship code paths, not live confirmation dialogs or GitHub submission. Later native Mac donation-card layout/copy checks are recorded in [donation verification](DONATIONS.md). Screen-reader, public-repository and cross-platform external-handler acceptance remain separate checks.
