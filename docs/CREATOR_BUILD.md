# Bitcoin Browser Create — macOS candidate

Version: **0.2.0-rc.5**, macOS arm64, Electron **44.2.0**. This is a local release candidate. Developer ID signing, Apple notarization, production inscription qualification and public redistribution are distinct gates. The candidate does not claim notarization or mainnet execution qualification.

## Try the build

Open `release/0.2.0-rc.5/mac-arm64/Bitcoin Browser.app`, then choose **Create** in the title bar. Browse and Create use the same native application window. Create opens its own project home with 21 starters and the Build → Test → Inscribe workflow. Existing browser data uses the original application identity.

Use **Explore library catalog** to search supported libraries and research inscriptions, inspect provenance/restrictions and copy an example. Drafts and published results use Bitcoin Browser's native content viewer and source preferences. There is no separate browsing engine.

To bring over saved work, quit Website Builder and use **Create → Import Builder workspace**, choosing the old `projects` folder. Original data is preserved; existing IDs are skipped. Unsaved drafts should first be saved/exported. This imports project source/assets/history only. Existing deployment records, node credentials, wallet material and AI connections stay in the original application.


### Create a collection or Rune

Choose **Image collection** or **Recursive collection gallery**. **Add images** selects multiple PNG, JPEG, GIF, WebP or SVG files through the native chooser. Import up to 64 images / 64 MB at a time, with up to 128 members in a project. Arrange their order, edit titles/descriptions, add typed traits and see trait frequencies. Duplicate an artwork as an edition to preserve identical bytes while receiving a distinct inscription ID. Choose grid, full artwork showcase or crisp pixel layout.

**Import metadata** accepts a JSON array of `{file, name, description, attributes}` records. Match the filename or full project path to exactly one imported image; attributes use `{trait_type, value}`. The complete import is validated before changes are saved. Removal from the collection retains source assets. Renames update the collection manifest. Managed gallery edits preserve unrelated custom code and library notices.

Publication groups members into separate-output batches of at most 16, with a conservative size budget. Actual commit/reveal weight must remain below Bitcoin's standard transaction limit; a large individual image still needs reduction before it can publish. Each batch has its own exact approval showing members, hashes, metadata, outputs, postage and fees. The gallery publishes after all images confirm and verify, using their actual IDs. Gallery display does not create parent–child provenance.

Choose **Rune etching** for a dedicated design screen. Set an uppercase name with optional spacers, one Unicode symbol, divisibility, premine and an optional open mint with exact amount, cap and block windows. Exact decimal / 128-bit arithmetic prevents rounded supply values. Turbo is optional and starts disabled. The connected Ord node checks names during preparation and again before reveal.

A Rune publication etches the actual runestone with a JSON design manifest inscription. A positive premine receives a separate wallet-owned Taproot output; its address and postage appear in the review. The commit must reach six confirmations before the saved reveal can be submitted. Use **Reconcile & resume** when mature. Restart and cancellation preserve the exact transaction; they do not silently construct or reprice another one. A verified Rune receipt opens the native Bitcoin Browser Rune viewer.

Additional starters target one-of-one artwork, PFP/pixel characters, seeded generative SVG art, interactive stories and collectible artifact cards. Home filters separate collections, art, experiences and Runes. All eight added starters work without an external library. The four interactive art/story/card starters are exercised inside the native opaque draft iframe.

Source, collection metadata and Rune settings share project history and portable archives. Valid form edits save automatically; navigation waits for pending edits, and invalid designs remain visible instead of publishing older settings. Scoped MCP adds `collection_configure`, `collection_duplicate` and `rune_configure`; agents still cannot authorize spending or accept library warnings.

### Include an unqualified library

In a project, use **Libraries → Browse possibilities → Discover more / Needs review**. Click **Add to this project** to open the warning modal. It identifies the library and exact inscription ID, explains incomplete security/runtime/license/dependency checks, and shows the report's specific flags. The acceptance checkbox starts unchecked; **Accept warning and add** stays disabled until it is checked. **Cancel** and **Escape** leave source unchanged and return focus to Add. The sidebar uses the same modal for supported libraries with pending qualification. A pending library already included by a starter offers **Review warning**.

For research entries choose classic JavaScript, a JavaScript module, a stylesheet, or a resource preload. After acceptance the native resolver fetches bounded content using Browse's mainnet source preferences; its exact decoded bytes and MIME are pinned. A changed response is rejected during preview. Missing dependencies must be included explicitly. Failed fetches, mismatched formats and concurrent edits cannot partially add a library.

The project retains acceptance, pin and format in revision history and portable `.btcsite` archives. **In this project** includes research entries. They remain visibly unqualified, with warnings in Test; acceptance does not grant distribution rights. Existing unreviewed-license inscription restrictions remain enforced, and transaction review is separate. Scoped agents cannot submit or forge desktop warning acceptance through the MCP tool.

The research UI/runtime test uses an owned loopback fixture under a research catalog ID to prove the flow and sandbox; it does not qualify that real inscription. Supported experience tests use the catalog's actual pinned public bytes.

## Verification

Evidence is retained in `docs/evidence/creator-*.json`. Each receipt states its package version, driver and fixture scope. Each signed candidate is tested independently; the receipt version identifies the tested package.

The final browser suite passes **2,258/2,258** checks. The creator suite passes **49/49** domain/MCP/native-boundary checks. TypeScript and the browser's static/security checks pass. The creator suite includes warning acceptance, research pinning, history/archive round trips, format checks, source failures and preservation of the publication license gate.

The signed **RC5** package executed all nine real library experiences against Brotli-compressed pinned public bytes and the four added interactive art/story/card starters. It passed all 21 starters and category filters, collection editions and previews, exact Rune arithmetic, invalid-design blocking, immediate form saving on mode exit, concurrent-edit protection, managed preview synchronization and malformed-design repair. It also passed mandatory library warning acceptance, Cancel/Escape/focus restoration, accepted research execution in the opaque sandbox, sidebar Add, library search/details/clipboard, project restoration, 50 actual native-executable MCP tools and JSZip generation. See [the RC5 package experience receipt](evidence/creator-packaged.json).

The signed **RC5** package also completed the existing website flow with **two actual regtest inscriptions** through a disposable Core/Ord wallet. Checks include denial of MCP spending approval, tamper rejection, no broadcast before exact UI review, desktop restart, encrypted funding-wallet refusal, external Core unlocking, per-resource review, chain/content verification, AI revocation and release of reserved inputs. The completed root runs its recursively inscribed script in native Browse with no Node, creator or browser API. See [the package publication receipt](evidence/creator-packaged-regtest.json). All review clicks use the owned fixture wallet; no real coins or owner wallet were used.

Development qualification covers the native file-grant command paths and public receipt export, with only the OS chooser's returned owned fixture path supplied by the harness. It does not claim interactive OS file-chooser UX qualification. The unavailable-storage fixture injects a nonresponsive async storage API in development, proves bounded failure/no vault/no broadcast, and preserves editing. Packaged publication uses the unmodified native OS protector.

The package driver uses a loopback Chromium renderer debugging endpoint and normal app IPC/UI. It waits for the actual shell document to be ready, avoiding attachment during the initial empty document. Main-process inspection stays disabled by the packaged fuses. Only the owned fixture node connection is preconfigured. No credential-store implementation is patched in the package.

[Package integrity verification](evidence/creator-package-integrity.json) checks the ZIP hash, source inventory, packaged ASAR source/payload, unpacked worker hashes, Developer ID/hardened runtime and seven inherited release fuses. Lockfiles and TypeScript declarations are source inputs and are intentionally excluded by the packager. Runtime source and payload hashes match the final candidate.

The current archive SHA-256 is recorded in `release/0.2.0-rc.5/SHA256SUMS` and its release manifest. Signing identity: `Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)`. The candidate is **not notarized or published**.

The interim RC1/RC2 packages are preserved in the migration checkout. Their failed compressed-result checks motivated the native negotiation/decoding fix; RC3 established the corrected behavior; RC4 retains those boundaries and adds explicit library warning acceptance. Cache/provenance retain wire bytes, while custom-protocol responses decode with output bounds and correct range/HEAD headers.

Real Ordinals domain qualification covers separate image outputs, identical editions, CBOR metadata, a recursive gallery, a maximum u128 mint cap, positive-premine etching, zero-premine preparation, six-confirmation maturity and restart. See [the Ordinals transaction receipt](evidence/creator-ordinals-regtest.json). The exact signed **RC5** package additionally completed a two-image separate-output batch and recursive gallery, then actually etched a zero-premine Rune after six confirmations. Both receipts opened their native Browse views; early Rune resume was disabled, and nothing broadcast before desktop review. See [the RC5 Ordinals package receipt](evidence/creator-ordinals-packaged.json). The development harness separately exercises multi-image and metadata native grants. No owner wallet or mainnet coins are used.

Inspected RC5 screenshots: [Create home](evidence/creator-ui/create-home-rc5.png), [collection editor](evidence/creator-ui/collection-editor-rc5.png), [batch review](evidence/creator-ui/batch-review-rc5.png) and [Rune review](evidence/creator-ui/rune-review-rc5.png).

## Reproduce

```sh
npm ci
npm ci --prefix src/creator
npm run build:viewers
npm run build:creator
npm run check
npm run check:creator
npm test
npm run test:creator
node scripts/check-creator-candidate.mjs
```

For native experience qualification, supply an absolute cache path containing the verified public catalog bytes, named by SHA-256. The harness checks every hash, serves Brotli bytes on loopback, creates an owned browser profile and executes actual interactions:

```sh
npm --prefix src/creator run test:native -- --library-cache=/absolute/verified-cache
```

The inscription harness requires the pinned macOS arm64 Core 31.1.0 / Ord 0.29.0 tools in the documented tool layout. It creates its own regtest chain/wallet and never targets an owner wallet:

```sh
npm --prefix src/creator run test:regtest -- --tools-dir=/absolute/qualified-tools
npm --prefix src/creator run test:regtest -- --unavailable-storage --tools-dir=/absolute/qualified-tools
src/creator/node_modules/.bin/tsx scripts/test-creator-ordinals-regtest.ts --tools-dir=/absolute/qualified-tools
src/creator/node_modules/.bin/tsx scripts/test-creator-ordinals-native.ts --tools-dir=/absolute/qualified-tools
```

To package a new local candidate, first choose an unused candidate version in both package manifests/lockfiles and set the root build output to `release/<version>`. The existing public `dist` policy continues to require notarization. This separate command produces a local signed candidate only:

```sh
node scripts/package-creator-candidate.mjs --developer-id='Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)'
npm --prefix src/creator run test:native -- --library-cache=/absolute/verified-cache --executable='/absolute/candidate/Bitcoin Browser.app/Contents/MacOS/Bitcoin Browser'
npm --prefix src/creator run test:regtest -- --packaged --tools-dir=/absolute/qualified-tools
src/creator/node_modules/.bin/tsx scripts/test-creator-ordinals-native.ts --packaged --tools-dir=/absolute/qualified-tools
```

The archive SHA-256, complete source inventory, creator input/payload hashes and signature identity are in the versioned release manifest. The runtime has bundled compiler/merge workers and stdio MCP; it does not need a separate Node installation or a sibling Builder checkout. Locked development dependencies must be installed in both root and creator workspaces.

## Public release limits

Apple notarization credentials and the owner's synced mainnet node were unavailable. Mainnet transaction execution, inherited broader browser release gates and library/source redistribution review remain prerequisites for a public release. D3/JSZip and previous library license restrictions remain enforced. Wallet seed recovery is excluded, as requested. Windows/Linux native builds were not newly qualified.

See [the complete feature mapping and migration plan](CREATOR_MIGRATION.md).
