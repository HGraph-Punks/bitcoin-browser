# Website Builder → Bitcoin Browser

The migration brings the Website Builder RC11 feature set into **Create**, a distinct mode of Bitcoin Browser. **Browse** retains the browser's existing tabs, navigation, providers, content viewers, wallet bridge and node manager. The creator does not launch another application or run a second browsing engine.

Builder source checkpoint: `96141f4` (committed before migration). Candidate version: `0.2.0-rc.5`. Public release remains gated by Apple notarization, publication qualification and the existing library license restrictions.

## Product design

- The persistent Browse / Create selector occupies the same title-bar position in both modes. Create has its own project home and a focused **Build → Test → Inscribe** workflow. Browsing tabs and the address bar belong to Browse.
- Create preserves the visual editor, code editor, source file tree, assets, history, merge review, library explorer and responsive preview widths. There are 21 starters and 149 distinct research inscription IDs; 9 visible supported library choices retain their verification and licensing distinctions.
- Leaving Create flushes the active code draft and queued source edits before changing mode. A failed save keeps the user in Create. Returning restores the last project; Browse restores its existing saved tabs.
- Drafts use the existing native `ord:` protocol and the same opaque iframe sandbox as original inscription content. There is no Website Builder `site:` protocol, embedded separate app, webview, extra BrowserWindow or creator-owned WebContentsView.
- Library inscriptions and completed publications open in native Browse. A completed publication's already-qualified local Ord endpoint becomes a read-only browser source on its matching network. Upstream library provenance is available in a native detail dialog with explicit inscription viewing and URL copying; it never opens the OS web browser.
- Browsing source preferences, local-only policy, offline mode, resource budgets, cancellation and cache behavior also apply to preview library and chain-data requests. Hash verification remains mandatory after the native resolver returns library bytes. A mainnet catalog library cannot be resolved through a regtest source.

## Feature mapping and implementation

| Builder feature | Bitcoin Browser location / adapter | Migration behavior |
| --- | --- | --- |
| Project home and 21 starters | Create home; original `templates` and `ProjectStore` | Source and settings formats preserved |
| Visual content and appearance | Create → Build → Content | Marker-preserving source edits retained |
| Multi-file code editor | Create → Build → Code | CodeMirror, local source autosave and revision checks retained |
| Assets and safe file operations | Create → Build → Assets / Code | Native file grants, asset hashes, rename and delete graph checks retained |
| Supported and research libraries | Create → Libraries / Explore catalog | Exact IDs, pinned hashes, notices, source claims and restriction states retained |
| Nine interactive experiences | Native draft iframe | Actual 3D, p5 variants, Phaser, Tone, WebGL, Matter, anime and D3 recipes |
| JSZip example | Create library example + native draft | Archive generation is executed in isolated content |
| Live draft preview | Native `ord://draft-<project>-<build>` route | Build-bound resources, range/HEAD support, native sources, console and resource observations |
| Build and Test reports | Create → Test | Original compiler worker, findings, stages, dependency lock and source checkpoint |
| Import/export | Native creator file dialogs | `.btcsite`, source folders, assets, drafts, HTML and publication receipts retained |
| Undo/redo, checkpoints, history and diffs | Create → History | Monotonic revisions, attribution and retained immutable versions |
| Concurrent edits and merge | Creator merge review | Exact revision/path/result-hash binding and retry semantics retained |
| Interrupted source draft recovery | Private `creator/drafts` | Same recoverable local draft protocol |
| AI / MCP tools | Create → AI connection | 50 scoped tools; actual browser executable starts `--creator-mcp`; no owner spending approval through MCP |
| Inscription backend | Create → Inscribe | Local Core 31.1.0 / Ord 0.29.0 connection, loopback validation and native cookie/executable grants |
| Frozen plans and exact review | Create → Inscribe | Original owner review, plan hash, quote expiry, fee/destination/funding checks |
| Transaction execution and receipts | Private `creator/deployments` | Original OS-protected transaction vault, journal, reservations, resume and verification |
| View published result | Native Browse | Inscription route on the receipt's matching network and read-only local source |
| Theme | Existing browser settings | Shared preference; creator appearance does not replace browser settings |
| Wallet recovery | Excluded | No seed import/export or general wallet recovery added |

## Architecture

`src/creator/source` contains the committed builder's domain, compiler, deployment, agent and UI modules with narrow host adaptations. The creator has its own exact lockfile and 41 retained bundled dependency notices. `scripts/build-creator.mjs` creates deterministic runtime bundles and bounded compiler/merge worker payloads. Workers are unpacked from ASAR because worker threads need actual filesystem entrypoints. The packaged app runs without a development Node installation or creator `node_modules`.

`src/main/creator-integration.js` owns lazy initialization, exact sender authorization, mode navigation and shutdown. Only the live main window's exact creator main document can invoke `builder:command`; an ordinary browser document, arbitrary same-origin page, subframe or inscription is rejected. The browser document only gets an `open Create` facade. The creation preload is exposed only on the exact creation document. Preview content receives neither facade nor Node access.

`src/creator/source/main/native-preview.ts` handles draft content within the existing browser content protocol. Each origin includes a project identity and complete build hash, so requests for an obsolete build fail closed. The response CSP rejects external draft requests even when ordinary inscription compatibility browsing permits HTTPS. Unknown resources cannot fall through to the public resolver. Local project assets and pinned catalog bytes are the only content resources admitted, plus the three explicitly supported native chain-data endpoints.

Source UI and transaction services remain distinct. The browser's packaged wallet bridge remains unable to sign. The Create inscription engine can use the user's explicitly selected local Core wallet through the existing exact-review flow; this does not enable the browser's wallet extension signing feature. It does retain protected per-transaction material needed for interrupted exact publication. Seed recovery stays out of scope.

## Migration stages

1. **Freeze and inventory:** commit RC11; inspect native browser protocols, settings, provider routing, wallet isolation, lifecycle and release policy. Completed before implementation.
2. **Port domain functionality:** bring across project, compiler, merge, portable source, library catalog, source recovery, deployment and scoped MCP modules. Preserve schemas and validation. Implemented.
3. **Native integration:** adapt preview and resource fetching, add exact mode IPC authorization, persist project selection, flush before mode exit, share theme and hand published content to native Browse. Implemented.
4. **UX integration:** clear Browse / Create navigation, creator branding, separate workflows, searchable library experience, native source details and explicit old-project import. Implemented.
5. **Validation:** run browser regression suite, creator type/domain/MCP tests, real native library interactions, packaged creator/MCP startup and regtest execution. Record current results in `CREATOR_BUILD.md` and `docs/evidence/creator-*.json`. No evidence from RC11 alone proves a migrated native or packaged workflow.
6. **Delivery:** produce a separate macOS arm64 creator candidate, preserve existing browser artifacts and profiles, and publish only after the release gates below pass.

## Importing existing projects

Quit Website Builder, then choose **Create → Import Builder workspace** and select its `projects` directory. Only UUID project directories and their manifests, versions, revisions and assets are copied. Active writer ownership, symbolic links, unexpected entries, oversized trees, invalid manifests and asset substitutions are rejected. Current source and assets are validated before any selected project becomes visible. Existing project IDs are skipped rather than overwritten, preserving repeated-import behavior. Original project data is retained.

Project identity, history, checkpoints, source, settings, libraries and assets stay intact. The import does not copy wallet material, RPC cookies, node credentials, deployment vaults or AI tokens. Existing publication records remain with their original application; a new Browser connection receives new owner approvals. Unsaved original source drafts should first be saved or exported in Website Builder. Portable `.btcsite` import remains available when a raw workspace cannot be imported.

## Release gates and limits

- The owner's mainnet node was unavailable during builder qualification; real-chain inscription validation remains pending. Keep the visible mainnet qualification notice and exact spending review.
- Apple notarization credentials were not available. A locally signed or ad-hoc candidate is not an Apple-notarized public release. Existing public signing policy must continue to fail closed.
- D3/JSZip bundled dependency license review and previous catalog license restrictions remain unchanged. Discovery records and restricted historical artifacts may be included for authoring and native preview only after explicit desktop warning acceptance. Their exact fetched bytes are pinned without marking them qualified. The publication license gate remains enforced.
- Builder-provided runtime receipts establish the imported examples' earlier tests. The new native browser receipts establish the migrated execution scope separately. Neither proves a complete current security audit of every reported inscription library.
- Initial delivery targets macOS arm64. Existing cross-platform browser code is retained, but this migration does not claim new Windows/Linux native package qualification.
- Before public redistribution, confirm licensing of the imported application source as well as retained third-party notices. The original private builder had no application license declaration.

## Reproducible development

```sh
npm ci
npm ci --prefix src/creator
npm run build:viewers
npm run build:creator
npm run check
npm run check:creator
npm test
npm run test:creator
npm start
```

Build and packaging use each repository's pinned lockfile. The production runtime does not depend on a sibling Website Builder checkout. The native qualification script requires a supplied SHA-256-named cache of the catalog's verified public library bytes and uses only an owned profile and loopback fixture source.

## Ordinals creation extension

RC5 adds native multi-image collection import, ordering, distinct editions, typed traits, metadata import, bounded separate-output batch publication and verified recursive galleries. Collection and Rune JSON settings are project source, preserved by history and archives. A dedicated Runes creator uses exact 128-bit amounts, actual Ord etchings, owner review, a six-confirmation commitment wait and native Rune viewing. Added authoring tools follow existing project grants; spending approval and unqualified-library acceptance remain desktop-only. See [the current build guide](CREATOR_BUILD.md) and versioned evidence for qualification scope.
