# Bitcoin Browser Create — macOS candidate

Version: **0.2.0-rc.7**, macOS arm64, Electron **44.2.0**. This is a local release candidate. Developer ID signing, Apple notarization, production inscription qualification and public redistribution are distinct gates. The candidate does not claim notarization or mainnet execution qualification.

## Try the build

Open `release/0.2.0-rc.7/mac-arm64/Bitcoin Browser.app`, then choose **Create** in the title bar. Browse and Create use the same native application window. Create opens its own project home with 24 starters and the Build → Test → Inscribe workflow. Existing browser data uses the original application identity.

Use **Explore library catalog** to search supported libraries and research inscriptions, inspect provenance/restrictions and copy an example. Drafts and published results use Bitcoin Browser's native content viewer and source preferences. There is no separate browsing engine.

To bring over saved work, quit Website Builder and use **Create → Import Builder workspace**, choosing the old `projects` folder. Original data is preserved; existing IDs are skipped. Unsaved drafts should first be saved/exported. This imports project source/assets/history only. Existing deployment records, node credentials, wallet material and AI connections stay in the original application.


### Create a collection or Rune

Choose **Image collection** or **Recursive collection gallery**. **Add images** selects multiple PNG, JPEG, GIF, WebP or SVG files through the native chooser. Import up to 64 images / 64 MB at a time, with up to 128 members in a project. Arrange their order, edit titles/descriptions, add typed traits and see trait frequencies. Duplicate an artwork as an edition to preserve identical bytes while receiving a distinct inscription ID. Choose grid, full artwork showcase or crisp pixel layout.

**Import metadata** accepts a JSON array of `{file, name, description, attributes}` records. Match the filename or full project path to exactly one imported image; attributes use `{trait_type, value}`. The complete import is validated before changes are saved. Removal from the collection retains source assets. Renames update the collection manifest. Managed gallery edits preserve unrelated custom code and library notices.

Publication groups members into separate-output batches of at most 16, with a conservative size budget. Actual commit/reveal weight must remain below Bitcoin's standard transaction limit; a large individual image still needs reduction before it can publish. Each batch has its own exact approval showing members, hashes, metadata, outputs, postage and fees. The gallery publishes after all images confirm and verify, using their actual IDs. Gallery display does not create parent–child provenance.

Choose **Runes** in the left sidebar, then **Rune etching**, for a native design screen with no website or iframe. Set an uppercase name with optional spacers, one Unicode symbol, divisibility, premine and an optional open mint with exact amount, cap and block windows. Exact decimal / 128-bit arithmetic prevents rounded supply values. Turbo is optional and starts disabled. The connected Ord node checks names during preparation and again before reveal.

A Rune publication etches the actual runestone with a JSON design manifest inscription. A positive premine receives a separate wallet-owned Taproot output; its address and postage appear in the review. The commit must reach six confirmations before the saved reveal can be submitted. Use **Reconcile & resume** when mature. Restart and cancellation preserve the exact transaction; they do not silently construct or reprice another one. A verified Rune receipt opens the native Bitcoin Browser Rune viewer.

Additional starters target one-of-one artwork, PFP/pixel characters, seeded generative SVG art, interactive stories and collectible artifact cards. Home filters separate collections, art, experiences and Runes. All eight added starters work without an external library. The four interactive art/story/card starters are exercised inside the native opaque draft iframe.

Source, collection metadata and Rune settings share project history and portable archives. Valid form edits save automatically; navigation waits for pending edits, and invalid designs remain visible instead of publishing older settings. Scoped MCP adds `collection_configure`, `collection_duplicate` and `rune_configure`; agents still cannot authorize spending or accept library warnings.

### Create a meta-protocol inscription

Choose **Bitmap**, **BRC-20** or **Sats Names** in the left sidebar. Bitmap creates a mined-block district claim; BRC-20 provides legacy four-byte deployment and public minting; Sats Names provides plain or JSON registration with optional avatar/website relay. Each native editor shows exact payload, MIME and UTF-8 byte count, with save/copy actions, source/history and no website preview.

Use **Test** to validate the design, then **Inscribe** for the exact Core/Ord transaction review. The protocol acknowledgement starts unchecked and is required before authorization. All three payloads publish uncompressed. Confirmation verifies bytes on-chain; protocol acceptance, availability and token balances remain unverified without a compatible indexer. [Read protocol scope and research](CREATOR_METAPROTOCOLS.md).

### Include an unqualified library

In a project, use **Libraries → Browse possibilities → Discover more / Needs review**. Click **Add to this project** to open the warning modal. It identifies the library and exact inscription ID, explains incomplete security/runtime/license/dependency checks, and shows the report's specific flags. The acceptance checkbox starts unchecked; **Accept warning and add** stays disabled until it is checked. **Cancel** and **Escape** leave source unchanged and return focus to Add. The sidebar uses the same modal for supported libraries with pending qualification. A pending library already included by a starter offers **Review warning**.

For research entries choose classic JavaScript, a JavaScript module, a stylesheet, or a resource preload. After acceptance the native resolver fetches bounded content using Browse's mainnet source preferences; its exact decoded bytes and MIME are pinned. A changed response is rejected during preview. Missing dependencies must be included explicitly. Failed fetches, mismatched formats and concurrent edits cannot partially add a library.

The project retains acceptance, pin and format in revision history and portable `.btcsite` archives. **In this project** includes research entries. They remain visibly unqualified, with warnings in Test; acceptance does not grant distribution rights. Existing unreviewed-license inscription restrictions remain enforced, and transaction review is separate. Scoped agents cannot submit or forge desktop warning acceptance through the MCP tool.

The research UI/runtime test uses an owned loopback fixture under a research catalog ID to prove the flow and sandbox; it does not qualify that real inscription. Supported experience tests use the catalog's actual pinned public bytes.

## Verification

RC7 adds the native WebGL Start homepage. See [homepage qualification](HOME_EXPERIENCE.md) for the current UI checks. The transaction receipts below qualify **RC6**; RC7 does not change the transaction engine and does not claim a new financial execution test.

RC6 source-native qualification passed all 24 starters, native Rune/Bitmap/BRC-20/SNS authoring, exact payload copy and normalized saves across Browse switching. It also completed actual uncompressed Bitmap, BRC-20 deploy, BRC-20 mint and SNS inscriptions, with acknowledgement enforcement and explicitly unverified protocol acceptance. The real-node domain harness rejected an unmined Bitmap height before preparation. [Native protocol transaction receipt](evidence/creator-ordinals-native.json).

Evidence is retained in `docs/evidence/creator-*.json`. Each receipt states its package version, driver and fixture scope. Each signed candidate is tested independently; the receipt version identifies the tested package.

The RC7 browser suite passes **2,263/2,263** checks. The creator suite passes **54/54** domain/MCP/native-boundary checks. TypeScript and the browser's static/security checks pass. The creator suite includes warning acceptance, research pinning, history/archive round trips, format checks, source failures and preservation of the publication license gate.

The signed **RC7** package executed all nine real library experiences against Brotli-compressed pinned public bytes and the four added interactive art/story/card starters. It passed all 24 starters and category filters, collection editions and previews, exact Rune arithmetic, invalid-design blocking, immediate form saving on mode exit, concurrent-edit protection, managed preview synchronization and malformed-design repair. It also passed mandatory library warning acceptance, Cancel/Escape/focus restoration, accepted research execution in the opaque sandbox, sidebar Add, library search/details/clipboard, project restoration, 51 actual native-executable MCP tools and JSZip generation. See [the RC7 package experience receipt](evidence/creator-packaged.json).

The signed **RC6** package also completed the existing website flow with **two actual regtest inscriptions** through a disposable Core/Ord wallet. Checks include denial of MCP spending approval, tamper rejection, no broadcast before exact UI review, desktop restart, encrypted funding-wallet refusal, external Core unlocking, per-resource review, chain/content verification, AI revocation and release of reserved inputs. The completed root runs its recursively inscribed script in native Browse with no Node, creator or browser API. See [the package publication receipt](evidence/creator-packaged-regtest.json). All review clicks use the owned fixture wallet; no real coins or owner wallet were used.

Development qualification covers the native file-grant command paths and public receipt export, with only the OS chooser's returned owned fixture path supplied by the harness. It does not claim interactive OS file-chooser UX qualification. The unavailable-storage fixture injects a nonresponsive async storage API in development, proves bounded failure/no vault/no broadcast, and preserves editing. Packaged publication uses the unmodified native OS protector.

The package driver uses a loopback Chromium renderer debugging endpoint and normal app IPC/UI. It waits for the actual shell document to be ready, avoiding attachment during the initial empty document. Main-process inspection stays disabled by the packaged fuses. Only the owned fixture node connection is preconfigured. No credential-store implementation is patched in the package.

[Package integrity verification](evidence/creator-package-integrity.json) checks the ZIP hash, source inventory, packaged ASAR source/payload, unpacked worker hashes, Developer ID/hardened runtime and seven inherited release fuses. Lockfiles and TypeScript declarations are source inputs and are intentionally excluded by the packager. Runtime source and payload hashes match the final candidate.

The current archive SHA-256 is recorded in `release/0.2.0-rc.7/SHA256SUMS` and its release manifest. Signing identity: `Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)`. The candidate is **not notarized or published**.

The interim RC1/RC2 packages are preserved in the migration checkout. Their failed compressed-result checks motivated the native negotiation/decoding fix; RC3 established the corrected behavior; RC4 retains those boundaries and adds explicit library warning acceptance. Cache/provenance retain wire bytes, while custom-protocol responses decode with output bounds and correct range/HEAD headers.

Real Ordinals domain qualification covers separate image outputs, identical editions, CBOR metadata, a recursive gallery, a maximum u128 mint cap, positive-premine etching, zero-premine preparation, six-confirmation maturity and restart. See [the Ordinals transaction receipt](evidence/creator-ordinals-regtest.json). The exact signed **RC6** package additionally completed a two-image separate-output batch and recursive gallery, etched a zero-premine Rune after six confirmations, and inscribed four uncompressed protocol operations: Bitmap, BRC-20 deploy, BRC-20 public mint and SNS. Every receipt opened native Browse. Early Rune resume was disabled; protocol authorization without the initially unchecked acknowledgement was rejected; nothing broadcast before desktop review. Protocol acceptance remains explicitly unverified in every new protocol receipt. See [the RC6 Ordinals package receipt](evidence/creator-ordinals-packaged.json). The development harness separately exercises multi-image and metadata native grants. No owner wallet or mainnet coins are used.

Inspected exact-package RC6 screenshots: [Create home](evidence/creator-ui/create-home-rc6.png), [native Rune editor](evidence/creator-ui/rune-editor-rc6.png), [Bitmap](evidence/creator-ui/bitmap-editor-rc6.png), [BRC-20](evidence/creator-ui/brc20-editor-rc6.png) and [Sats Names](evidence/creator-ui/sns-editor-rc6.png).

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
