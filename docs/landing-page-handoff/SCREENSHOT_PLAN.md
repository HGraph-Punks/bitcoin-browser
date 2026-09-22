# Product screenshot plan

**Status: awaiting capture. No product screenshot files are included in this handoff.** Browser capture could not be connected in the current session. These are planned filenames and shot directions, not captured assets. The included application icon must not be described as a UI screenshot.

Capture the current **Bitcoin Browser** build, including its renamed header and the single-scroll Ask Bitcoin layout. Avoid historical Satoshi-branded screenshots.

## Capture standards

- Capture only the application window, not the entire desktop. Exclude other apps, notifications and personal context.
- Use consistent dimensions, ideally about 1440 × 960 logical pixels with a high-resolution PNG master. A consistent smaller window is preferable to enlarging a low-resolution image. Record actual pixel dimensions after capture.
- Keep the full app chrome/sidebar in the master. Section crops should still make the relevant function obvious; preserve the unedited master separately.
- Use a clean test workspace and public/example data. Do not read, reset or export the user's profile to obtain a clean shot.
- Do not expose wallet/account identifiers, holdings, private chat, tokens, authentication fields, personal paths, logs or recovery dialogs. Use a disconnected wallet for promotional captures.
- No artificial balances, prices, model replies, successful sync indicators or rankings. Wait for genuine load completion; if a page cannot load, choose another approved example and disclose the change.
- Actual artwork availability and its permission for promotional reuse are separate checks. A public inscription is not automatically public-domain advertising material.
- Keep source/retrieval/cache disclosures when they are necessary to interpret a result. Do not crop a partial inspection into a claim of full verification.
- Save screenshots as PNG masters. Any compressed website derivatives should be generated from those masters without redrawing the interface. Do not invent screenshots with an image generator.

## Priority shots

| Priority | Planned filename | Destination | What it should demonstrate | Suggested caption |
| --- | --- | --- | --- | --- |
| 1 | `01-inscriptions-gallery.png` | `satnav://inscriptions` | Real gallery, search, media filters, curated projects and the current app chrome | “Discover inscriptions in a browser built for Bitcoin.” |
| 2 | `02-3d-inscription.png` | Runestone example below | A fully drawn centered model with 3D controls; no endless loading state | “Rotate, zoom and explore supported on-chain 3D objects.” |
| 3 | `03-rune-details.png` | `rune:DOG•GO•TO•THE•MOON` or `rune:UNCOMMON•GOODS` | Name, identity, supply, mint rules, source snapshot and creation links | “Understand a Rune's supply, rules and on-chain record.” |
| 4 | `04-ask-bitcoin-results.png` | `satnav://ai` | A real public-data question, response, readable result cards and anchored composer | “Ask a question, then open the Bitcoin records behind the answer.” |
| 5 | `05-guided-node-setup.png` | `satnav://node-setup` | The choices for Core, Ord, both or neither, or the storage choices | “Start with public sources. Add your own node when you're ready.” |
| 6 | `06-start.png` | `satnav://home` | The uncluttered starting experience, guided search and optional next steps | “A familiar starting point for exploring Bitcoin.” |
| 7 | `07-runes-discovery.png` | `satnav://runes` | Rune search, curated entry points and a real source listing | “Find a Rune and explore its on-chain details.” |
| 8 | `08-document-viewer.png` | Public PDF example below | The actual PDF page and its native viewer controls | “Read documents inscribed on Bitcoin.” |
| 9 | `09-data-source-choice.png` | `satnav://providers` | Local/public source choice and provenance without credentials/private endpoints | “Choose where your Bitcoin data comes from.” |
| 10 | `10-bitcoin-record.png` | `block:840000` | Real block summary and source details, optionally with related tabs open | “Follow the underlying Bitcoin record.” |

For a compact landing page, obtain shots 1–5 first. Shot 1 is the default hero candidate; shot 6 is an alternative if the hero should emphasize simplicity. The 3D close-up is a strong supporting visual, not proof that every 3D format is supported.

## Exact known examples

These targets are taken from the existing project catalog/documentation, not freshly verified captures:

### Interactive Runestone glTF

```text
inscription:ed76bf35918948b8b78be0e6397ad4916d926dd3d65679a8b7e67d8699a672a0i0
```

Inscription number 63,140,674. It is an inscription example, not a Rune token. Wait for the first actual model draw. Frame an informative angle with rotate/zoom/reset available; do not capture a blank or loading canvas. Promotional artwork rights remain a separate owner review.

### Public whitepaper PDF example

```text
inscription:85b10531435304cbe47d268106b58b57a4416c76573d4b50fa544432597ad670i0
```

Inscription #54. Show a readable page with the actual PDF toolbar. Treat this as an identified example, not a statement about official endorsement or unrestricted artwork/document reuse.

### Small raster example

```text
inscription:6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0
```

Inscription #0. Useful for showing centered, crisp-pixel presentation, but the work is small and should not be used to imply all inscriptions have high-resolution imagery. Rights review still applies.

## Shot-specific guidance

### Inscriptions gallery

Use a clean source-backed listing. Expand the curated section or optional safe artwork only if it helps the composition. Do not relabel “Popular to explore” as a live ranking. Avoid unreviewed or unsuitable artwork in promotional material. If acceptable content cannot be found, capture the real curated discovery UI without pretending it is a full collection gallery.

### Rune details

Capture the currently returned supply and mint snapshot with its labels. Do not hardcode those numbers into evergreen page copy. Do not add prices, a portfolio value, a Buy/Mint button or a chart. A project mark does not indicate that the project endorses the browser.

### Ask Bitcoin

Create a separate, intentionally non-private demonstration chat. Use a connected downloaded model from the already approved local setup. An example question is:

> Find a highly recursive inscription for me to explore.

Or:

> Find DOG in the featured Rune catalog, then look up its current on-chain details.

Capture the real result. Preserve the **Browser-generated lookup summary** label when present; do not imply that the model authored it. Show at least one openable result card and the composer. The latest layout should show one main scroll area, not a page inside another scrolling page. Do not open token options, disclose unrelated conversation, or fabricate server/model success.

### Node setup

Show choices or an unsaved review, not a fake completed sync. Do not download software, save/apply a configuration, start a node or import a snapshot merely to create an illustration. A screenshot of the wizard demonstrates the guided path, not successful native installation. Core/Ord storage and indexing dependencies should remain accurately represented in the adjacent copy.

### Sources and wallet-related imagery

Prefer source-choice UI without personal endpoints or recovery messages. Do not include a funded/connected wallet as a trust signal. A screenshot of a wallet approval does not establish safety or compatibility; wallet imagery is optional and not part of the first five priorities.

## Register each supplied image

For every actual file added later, record:

- Filename and actual pixel dimensions.
- Capture date, source version and operating system.
- Exact page/target and whether data is live, cached or a clearly labeled demonstration fixture.
- Whether the image is a full unedited window capture or a derived crop.
- Privacy review outcome and any removed/redacted information.
- Artwork/mark owner, permission or license status, and required attribution.
- Final alt text describing the real UI, not a security/financial claim.

Suggested alt text for the AI capture: “Bitcoin Browser's Ask Bitcoin page showing a question, a source-labeled inscription result and the message composer.” Adjust it to the actual contents rather than assuming the planned shot succeeded.

Until captures pass these checks, keep the page's image slots explicitly marked as unfinished. Do not ship broken links to these planned filenames.
