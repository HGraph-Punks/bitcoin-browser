# Paste-ready assignment for GPT-6 Astra

You are creating the promotional landing page for **Bitcoin Browser**, a Bitcoin-native desktop browsing application. Use the attached feature inventory and actual approved screenshot assets as the product source of truth. Build a persuasive, approachable page without inventing capabilities, public availability, partnerships or trust claims.

## Objective

Help a curious Bitcoin user understand, within a few seconds, what the app does, why it is useful, and how to take the next approved beta step. Make inscriptions, Runes and Bitcoin research feel approachable. Show the optional local-node path as an invitation, not a prerequisite or a wall of setup instructions.

This is a landing page, not a redesign of the desktop application. Preserve the browser's identity and accurately represent the current product.

## Product positioning

**Bitcoin Browser brings Bitcoin data, inscriptions, Runes, and your local AI into one desktop browsing workspace—with the option to connect or run your own data sources.**

It is not an exchange, wallet, general web-browser replacement or complete global inscription search engine.

Primary audience: curious Bitcoin users, inscription collectors/explorers and Rune users who want a coherent browsing experience.

Secondary audience: local-node operators and technical users who value source transparency, raw records and retained advanced controls.

Recommended headline: **Explore Bitcoin in one place.**

Recommended subhead: **Browse inscriptions and Runes, follow transactions and blocks, and ask your local AI to help you explore. Start with configured public sources—or connect your own node.**

Use **Early beta in development** until the owner explicitly approves a qualified public release. The repository currently records beta qualification as incomplete.

## Four main product stories

1. **See what lives on Bitcoin.** A dedicated inscription gallery, readable text/JSON, centered art, interactive 3D and local document/media viewers. Exact lookup and page filters are implemented; global keyword/collection search is not.
2. **Understand Runes at a glance.** Identity, supply, burned amounts, decimal places, mint rules and creation links. This is source-backed read-only exploration, not prices or trading.
3. **Ask questions. Open the evidence.** Connect user-run LM Studio or Ollama, choose a tool-capable model, and get explanations with browser-produced source cards. The AI can query eligible Core/Ord/public data sources but cannot access wallets, sign, spend or change settings. The current chat has one main scroll area and retains position on sidebar return.
4. **Your node, at your pace.** Browse without running a node; connect existing Core/Ord services or follow guided setup for Core, Ord, both or neither. Storage/sync/index requirements still apply. Snapshot-assisted compact setup is an advanced, explicitly limited preview, not an instant-sync promise.

## Recommended page structure

1. **Navigation:** product mark/name, Features, Local AI, Your node, FAQ, and one approved CTA. Do not crowd navigation with every internal tool.
2. **Hero:** the headline/subhead above, honest beta status, one primary CTA, a secondary “Explore features” anchor, and the strongest real product screenshot.
3. **Quick orientation:** three short statements such as “Bitcoin-native navigation,” “Optional local AI,” and “Choose your data sources.” These are feature descriptions, not certifications or popularity badges.
4. **Inscriptions showcase:** gallery plus a real artwork/3D close-up; explain discovery and viewing in everyday language. Keep third-party artwork permissions explicit.
5. **Runes showcase:** a readable actual Rune-detail capture. Explain supply and mint rules without inventing live market metrics.
6. **Ask Bitcoin showcase:** an actual non-private question with openable source cards. Explain local-server setup briefly and include a small accuracy/privacy caveat.
7. **Optional node path:** a simple progression—start browsing, connect a node, or follow guided setup. Use the genuine setup screen. Keep storage/Ord dependency caveats nearby, not buried in legal text.
8. **Supporting features:** compact cards for tabs/bookmarks, source provenance, cached offline access and advanced inspection. Do not display the entire engineering inventory by default.
9. **Trust by explanation:** concise factual statements about content/wallet separation, no seed import, explicit connections and no included app telemetry. State that packaged signing is disabled and third-party wallets still require qualification. Avoid shield graphics implying certification.
10. **FAQ and final CTA:** answer practical questions, reiterate beta status, link only to approved real destinations.

## Visual direction

Aim for a calm, polished desktop product page: spacious typography, generous margins, genuine UI imagery, restrained motion and Bitcoin-orange accents. This is product software, not a speculative-token promotion.

Existing source palette:

- Main background: `#090b0e`.
- Raised surfaces: `#11151a` and `#171c22`.
- Primary text: `#e9edf2`; secondary text: `#aeb7c3`.
- Borders: `#262d36`.
- Accent: `#f7931a`; secondary accent: `#ffb454`.

The current font stack names Inter then system sans-serif; it does not imply a bundled Inter font. Use licensed locally available assets or system fonts. **Brand update, 2026-09-21:** the owner supplied the orange globe/Bitcoin logo now included in `assets/bitcoin-browser-icon.png`. Use that mark with the **Bitcoin Browser** name, preserving colors and proportions. The accompanying SVG embeds the same PNG without a font dependency; it is not a vector trace. These current assets replace the old missing-glyph references, while the historical ZIP remains unchanged. Do not redesign the supplied logo.

Use a light variant only if it improves legibility; do not obscure the actual dark app UI with heavy perspective, glare, decorative overlays or unreadably small screenshots. Avoid coin-rain imagery, trading dashboards, giant gradient hype, auto-playing art, testimonial carousels and fake partner logos. A screenshot viewer must be keyboard accessible; do not create nested page scrolling like the prior AI UI problem.

## Screenshot and content integrity

Read `SCREENSHOT_PLAN.md`. At handoff time **no product screenshots are included**; only the app icon is supplied. Never present a fabricated UI, AI-generated mockup, logo image, fixture result or shot-list filename as a real product screenshot. If actual captures are missing, use an explicitly labeled placeholder during implementation and report it as unfinished for publication.

Keep genuine source/time/cache labels in screenshots. Do not Photoshop successful connection states, balances, scan counts, model answers, prices or completed node sync. Capture only public/example material with approved rights; no private conversations, wallet accounts, tokens or local paths. Third-party project icons inside the app are not evidence of a partnership.

## Copy constraints

- Lead with user outcomes; introduce “Ord,” “RPC,” “UTXO,” “indexing” and “PSBT” only where useful in an optional explanation.
- Clearly distinguish current capabilities, configured platform targets and uncompleted qualification.
- Say “curated projects,” not “live most-popular rankings.”
- Say “source-backed results,” not “AI answers are verified and always correct.”
- Say “connect local AI,” not “AI is built in and nothing ever leaves your computer.”
- Say “guided node setup,” not “one-click instant full node.”
- Say “wallet connections are isolated,” not “all wallets are guaranteed safe.”
- Do not advertise BRC-20, trading, portfolio tracking, persistent chat history, an included model, mobile apps, auto-updates or unavailable preview formats.
- Do not publish volatile counts/prices/sync-time promises or fixture metrics as product facts.
- The engineering test counts are optional internal evidence, not marketing trust badges.

## FAQ content to cover

- Do I need a Bitcoin node? No; configured public sources can be used. Local setup is optional.
- Is this a wallet or exchange? No. There is an isolated connection bridge for supported wallets; packaged signing is disabled.
- Can I search every inscription by keywords? No. Exact identifiers, source listings, current-page filters and bounded AI/catalog discovery are available.
- Does the AI run locally? The app connects to your local LM Studio/Ollama endpoint. You must choose trusted downloaded models and disable server-side cloud routing; the server controls its own behavior/logging.
- Can it run offline? Eligible previously cached Bitcoin content can be read, with explicit misses. This is not whole-device network isolation or a promise about independently running services/extensions.
- What platforms can I download? List only owner-approved available artifacts. macOS/Windows/Linux x64/arm64 are configured targets, not proof that all builds are ready.
- Can I browse 3D inscriptions? Supported glTF/GLB 2.0 and STL, subject to documented resource/extension/platform limits.
- How long does node setup take? It depends on hardware, connection, storage and indexes; archival sync/indexing can take substantial time. Do not give a guaranteed duration.

## Implementation requirements

Inspect the landing-page workspace and follow its existing stack and instructions. Do not assume a framework or add a backend merely because the desktop app uses Electron. Do not modify the browser runtime or its release settings as part of the landing page.

Deliver a responsive, semantic, accessible page with visible focus, readable contrast, reduced-motion support, practical image sizes, descriptive alt text, no unexpected horizontal overflow and no scroll traps. Use one main document scroll. Avoid decorative animation that moves screenshots or prevents reading. Keep the core content usable without JavaScript where practical.

Use local optimized assets, explicit image dimensions, below-the-fold lazy loading, sensible metadata and a clear product title/description. Avoid third-party scripts, analytics, embeds, cookies, form submissions or unapproved network dependencies by default. If a signup form is approved later, implement actual consent, success/error behavior and the real endpoint; do not ship a fake working form.

Do not invent the public repository URL, download URLs, domain, release approval, pricing, testimonials, usage figures, support contact or legal/company details. Ask for the missing inputs that block publication. The primary CTA must reflect a real owner-approved destination; while none exists, display honest availability copy instead of a deceptive Download button.

## Definition of done

- A polished page whose main purpose is understandable without technical knowledge.
- Every advertised capability matches `FEATURES_AND_CLAIMS.md`; limitations are visible where they affect expectations.
- Real, approved screenshots are used and their key UI is legible on desktop and mobile; missing imagery is reported, not fabricated.
- Only qualified, real download/repository/signup links are active.
- Responsive, keyboard, contrast, reduced-motion, link, image and performance checks are run, with actual results reported.
- No unsupported wallet/security/privacy/popularity/platform promises, invented testimonials, or unauthorized external services.
- A short handoff names changed files, validation results and any remaining publication blockers. Do not deploy or publish without the owner's instruction.
