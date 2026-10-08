# Bitcoin Browser Create — macOS candidate

Version: **0.2.0-rc.3**, macOS arm64, Electron **44.2.0**. This is a local release candidate. Developer ID signing, Apple notarization, production inscription qualification and public redistribution are distinct gates. The candidate does not claim notarization or mainnet execution qualification.

## Try the build

Open `release/0.2.0-rc.3/mac-arm64/Bitcoin Browser.app`, then choose **Create** in the title bar. Browse and Create use the same native application window. Create opens its own project home with 13 starters and the Build → Test → Inscribe workflow. Existing browser data uses the original application identity.

Use **Explore library catalog** to search supported libraries and research inscriptions, inspect provenance/restrictions and copy an example. Drafts and published results use Bitcoin Browser's native content viewer and source preferences. There is no separate browsing engine.

To bring over saved work, quit Website Builder and use **Create → Import Builder workspace**, choosing the old `projects` folder. Original data is preserved; existing IDs are skipped. Unsaved drafts should first be saved/exported. This imports project source/assets/history only. Existing deployment records, node credentials, wallet material and AI connections stay in the original application.

## Verification

Evidence is retained in `docs/evidence/creator-*.json`. Each receipt states its package version, driver and fixture scope. A passed RC1 receipt establishes RC1 behavior; final RC2 qualification must be recorded independently.

The final browser suite passes **2,258/2,258** checks. The creator suite passes **38/38** domain/MCP/native-boundary checks. TypeScript and the browser's static/security checks pass. The creator domain count remains unchanged after the final browser-only content decoding correction.

The exact signed **RC3** package executes all nine real interactive experiences against Brotli-compressed pinned public library bytes. It also passes library search/details/clipboard, immediate-save mode switching, project restoration, 47 actual native-executable MCP tools and JSZip generation. See [the package experience receipt](evidence/creator-packaged.json).

The signed RC3 package also completes **two actual regtest inscriptions** through a disposable Core/Ord wallet. Checks include denial of MCP spending approval, tamper rejection, no broadcast before exact UI review, desktop restart, encrypted funding-wallet refusal, external Core unlocking, per-resource review, chain/content verification, native clipboard, AI revocation and release of reserved inputs. The completed root runs its recursively inscribed script in native Browse with no Node, creator or browser API. See [the package publication receipt](evidence/creator-packaged-regtest.json). All review clicks use the owned fixture wallet; no real coins or owner wallet were used.

Development qualification covers the native file-grant command paths and public receipt export, with only the OS chooser's returned owned fixture path supplied by the harness. It does not claim interactive OS file-chooser UX qualification. The unavailable-storage fixture injects a nonresponsive async storage API in development, proves bounded failure/no vault/no broadcast, and preserves editing. Packaged publication uses the unmodified native OS protector.

The package driver uses a loopback Chromium renderer debugging endpoint and normal app IPC/UI. It waits for the actual shell document to be ready, avoiding attachment during the initial empty document. Main-process inspection stays disabled by the packaged fuses. Only the owned fixture node connection is preconfigured. No credential-store implementation is patched in the package.

[Package integrity verification](evidence/creator-package-integrity.json) checks the ZIP hash, source inventory, packaged ASAR source/payload, unpacked worker hashes, Developer ID/hardened runtime and seven inherited release fuses. Lockfiles and TypeScript declarations are source inputs and are intentionally excluded by the packager. Runtime source and payload hashes match the final candidate.

Archive SHA-256: `b2e007ae05b85b23bc7fa960e2c8a5bbb09de317a3f3291da072a53371100b6d`. Signing identity: `Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)`. The candidate is **not notarized or published**.

The interim RC1/RC2 packages are preserved in the migration checkout. Their failed compressed-result checks motivated the native negotiation/decoding fix; final RC3 evidence above supersedes those interim scopes. Cache/provenance retain wire bytes, while custom-protocol responses decode with output bounds and correct range/HEAD headers.

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
```

To package a new local candidate, first choose an unused candidate version in both package manifests/lockfiles and set the root build output to `release/<version>`. The existing public `dist` policy continues to require notarization. This separate command produces a local signed candidate only:

```sh
node scripts/package-creator-candidate.mjs --developer-id='Developer ID Application: MoonScape Labs Inc (YAXG2D45G6)'
npm --prefix src/creator run test:native -- --library-cache=/absolute/verified-cache --executable='/absolute/candidate/Bitcoin Browser.app/Contents/MacOS/Bitcoin Browser'
npm --prefix src/creator run test:regtest -- --packaged --tools-dir=/absolute/qualified-tools
```

The archive SHA-256, complete source inventory, creator input/payload hashes and signature identity are in the versioned release manifest. The runtime has bundled compiler/merge workers and stdio MCP; it does not need a separate Node installation or a sibling Builder checkout. Locked development dependencies must be installed in both root and creator workspaces.

## Public release limits

Apple notarization credentials and the owner's synced mainnet node were unavailable. Mainnet transaction execution, inherited broader browser release gates and library/source redistribution review remain prerequisites for a public release. D3/JSZip and previous library license restrictions remain enforced. Wallet seed recovery is excluded, as requested. Windows/Linux native builds were not newly qualified.

See [the complete feature mapping and migration plan](CREATOR_MIGRATION.md).
