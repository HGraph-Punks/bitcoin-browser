# Release-focused UI/UX pass

Implemented September 19, 2026. This is a usability improvement, not a declaration that the separate beta qualification, native compatibility or signing gates have passed.

## User-facing changes

- **Start:** one primary Search action; three clearly described destinations for Inscriptions, Runes and Ask Bitcoin. Wallet connection and running a node are explicitly optional. Destination cards have a larger clickable area. Search examples, wallet/node setup, shortcuts and status remain available in native disclosures. Ask Bitcoin resumes the existing live chat owner instead of creating an empty conversation when one can be resumed.
- **Navigation:** sidebar labels stay visible down to a 961-pixel window width; the narrower icon rail has named controls and hover titles. Inscription records and previews keep Inscriptions selected, Rune records keep Runes selected, and the node walkthrough keeps Local node selected. A keyboard-visible Skip to page content control bypasses the shell.
- **Tabs:** overflowing tabs can scroll horizontally, newly active tabs scroll into view, and passive source/cache updates no longer rebuild the tab strip. Title/icon changes restore owned tab/close-button focus. Close buttons have 24 × 24 CSS-pixel targets and do not lose Enter/Space activation to the surrounding tab. Inactive close buttons are excluded from sequential Tab traversal.
- **Address bar:** explicit combobox state, selected options, active-descendant association and retained input focus. Up/Down select; Enter opens; Escape closes without deleting the query; Tab leaves normally. Composition, modifier combinations and ordinary editing keys are not intercepted. Saved-item suggestions explain that they search history/bookmarks on this device, not a global search engine.
- **Async search:** a new parse immediately retires the preceding actionable suggestions. Both successful and rejected stale replies are ignored after typing, closing, changing tabs or losing focus. Older blur timers and ArrowUp continuations cannot alter a newer popup. The input is bounded to 4,096 characters and the popup to nine candidates.
- **Loading:** a slim, pointer-transparent progress line replaces the blocking page overlay. Generic Bitcoin records show a dedicated loading page rather than unrelated saved-item results behind an overlay. Gallery, Rune and inscription preview loading remain owned by their existing views. Users can change the lookup or use other tabs while waiting.
- **Recovery:** plain-language guidance for no compatible source, not-found responses, timeout, offline cache misses, offline cache-read errors and resource limits. Retry, the relevant settings/source page and Back to Start remain explicit actions. Error code, message and supplied details remain available under a closed Technical details disclosure; provider strings are rendered as text.
- **Trust cues:** source indicators distinguish unchecked, failed, offline, unavailable, demo-only and last-successful-check states. General availability excludes disabled, wrong-network, local-only-excluded and routing-blocked sources. A health check is not presented as independent record verification. Generic records foreground Key details and Data source/Snapshot, retain raw data and inspection, and no longer fabricate an attempt when none was recorded. Copy identifier accurately names its existing canonical-copy behavior.
- **Readability:** stronger shared muted text in both themes; separate accessible light-theme accent text/focus colors without changing the orange brand/button fill; stronger semantic colors and clearer focus. Inscription filters and provider actions wrap, medium-width labels remain visible, and Home cards stack at narrow container widths. Existing reduced-motion support remains intact.

## Preserved behavior and boundaries

All existing lookup types, galleries, collector insights, popular-asset sections, inscription formats, viewing controls, saving/bookmarking, developer inspection, wallet controls, data-source configuration, node setup and local-AI capability remain. The AI keeps its single transcript scroll area. No new external request, market feed, telemetry, account, dependency or font service is introduced by these changes.

No wallet signing/broadcasting authority, credential-storage behavior, preload/IPC method, provider routing policy, content sandbox/CSP or service-management permission changed in this pass. Source-status projection reads already supplied public descriptors; it neither tests a connection nor reads or repairs credentials. Existing configured lookups still make their normal user-directed requests.

“Passed last check” describes a stored health result, not present connectivity, freshness, support for every asset type or trustworthiness of the record. A missing result from one source is not proof that the asset does not exist. “Isolated preview” describes the existing shell/wallet isolation, not a general guarantee that all arbitrary content is harmless.

## Verification

The full Node 22 suite passes **2,095/2,095 tests**, with no skips or cancellations. The release-focused subset passes **63/63** (new state/UI tests plus Start and bookmark-control checks). Existing delayed-library publication checks also pass with the real status helper supplied to their isolated renderer fixture.

Coverage exercises the actual renderer/controller functions with controlled DOM collaborators, not replacement implementations of the search or tab controller. It includes stale success/rejection ordering, request ownership, keyboard modifiers/IME, Enter during a pending parse, focus and disclosure retention, tab-close event boundaries, sidebar mapping, skip-command admission, loading dispatch, inert error text, contextual recovery and source exclusions.

Color tests resolve the actual theme tokens and check eight shared text roles against seven solid base/hover/selected surfaces in each theme at **at least 4.5:1**; focus-ring tokens are checked at **at least 3:1** on the sampled backgrounds. This is a token regression check, not a claim that every pixel, image, translucent overlay, disabled control or native component is certified accessible.

The generated PDF/JXL viewers are current. Syntax/security-invariant checks and `git diff --check` pass. No public release, signing, dependency audit or new release hashing workflow is part of this UI pass.

Design references used: the [WAI-ARIA combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/), [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [minimum target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). These guide particular controls; they do not establish whole-application conformance.

## Native visual acceptance still required

The supported interactive Browser runtime was unavailable during this pass. Controlled DOM/CSS tests and a source-shell launch do not establish native pixel layout, screen-reader output, real wallet-extension compatibility or cross-platform release acceptance.

On the refreshed source build, review:

1. **First visit:** Start at normal and increased zoom, both themes, and windows around 1,280, 1,024 and 900 pixels wide. Confirm that Search is the obvious first action, card descriptions fit, and optional setup is discoverable without dominating the page.
2. **Keyboard:** Tab to Skip to page content; verify visible focus. Type in the address bar, use Up/Down/Enter/Escape/Tab, and confirm the chosen suggestion is announced with a screen reader. Check a composition-based input method if available.
3. **Tab overflow:** open enough tabs to overflow, switch with the keyboard, and close with keyboard and mouse. Confirm the active tab is visible and passive source updates do not move the reader or lose focus. Try trackpad horizontal scrolling.
4. **Wait and recover:** use a disposable, unavailable data source, initiate a lookup and verify that navigation remains usable. Inspect retry, source/settings recovery and closed technical details. Check offline cache absence separately from a cache-read failure; do not damage a real profile to manufacture errors.
5. **Assets:** browse inscriptions and Runes, combine page-local filters, open collector details, view an image/text/3D example and return. Verify selection context, readable labels, artwork sizing and available advanced controls.
6. **AI:** enter from Start, connect only if desired, open a result and return through Start or the sidebar. Check that the live conversation resumes and retains one transcript scroll area. Chats are still memory-only and do not survive an app restart.
7. **Setup and wallet:** open the node walkthrough and wallet screen without installing a service or connecting funds. Check text, focus, field labels and wrapped actions. This visual check does not qualify installation or wallet safety.

Do not infer a release GO from this checklist. The README's native startup/shutdown, signing/notarization, wallet/version and cross-platform qualification gates remain authoritative. The public sponsorship inquiry URL also still needs the owner's access check recorded in [Sponsors](SPONSORS.md).
