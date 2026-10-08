# Bitcoin Website Builder user guide

The macOS application creates ordinary HTML, CSS, JavaScript, and assets that can become a recursive Bitcoin website. Authoring needs no wallet, node, account, or AI subscription. This release candidate has a network-aware local Core/Ord inscription route. Actual mainnet execution and the final signed macOS package remain release gates. Wallet recovery is outside the release scope.

## Install and start

The local candidate is a macOS arm64 `.app` inside a ZIP archive. Extract the ZIP and move **Bitcoin Website Builder.app** to your Applications folder. A public macOS download needs Developer ID signing and notarization; the local candidate is signed for local testing only. No Node.js installation is needed to run the packaged editor. Uninstall by removing the application. Saved projects are stored separately in the application's user-data directory and survive removal of the app.

For development, use Node 22.13 or newer, run `npm ci`, then `npm start`. `npm run package:mac` creates a local macOS candidate after compiling release bundles. The package process refuses to replace an existing release archive.

## Create a first website

1. Choose **Personal website**, **Gallery**, or another starter. Enter a project name and choose **Create website**.
2. In **Content**, edit the headline, description, introduction, and accent color. Click outside a field to apply it.
3. Choose **Assets** to import images or other web assets. Give images useful alternative text. Imported files keep their original bytes.
4. Use **Desktop**, **Tablet**, and **Phone** to inspect the layout. Explore navigation and interactive controls in the actual preview.
5. Select **Test website**. Fix static blockers and inspect preview errors and blocked requests before preparing publication.

The application saves projects locally. Source files autosave after a short pause. **Saved on this device** means the project mutation has completed. Previewing does not publish a website.

## Edit source and resolve conflicts

Open **Code** to edit HTML, CSS, JavaScript, JSON, or SVG. Relative file links are converted to recursive content references during compilation. Renaming a file updates parsed references; deleting a file that is still used requires fixing those references first. Visual controls operate on marked template regions and preserve unrelated code.

If an assistant or another operation saves a newer revision while you have a source draft, your draft stays open. Select **Review changes**. Separate changes are combined automatically. For an overlap, choose **Use my draft**, **Use saved source**, or **Edit complete result**. Review the complete source and select **Save merged source**. A newer saved edit makes that review stale; **Refresh review** combines a completed result with the newer source. **Back to my draft** retains the original draft and the current review. **Save a copy** exports your review result through a native dialog.

Source drafts also receive separate local recovery copies after a short typing pause. These copies do not modify saved history or an inscription plan. After a forced termination, reopen the project to recover its newest unresolved draft, then review or export it. Typing that has not reached the recovery copy can still be lost in an abrupt termination. See the [recovery guide](RECOVERY.md).

## History and backups

**History → Name this moment** labels the current revision. Select an earlier version to compare source and settings. **Restore version** creates a new revision, preserving the versions that followed it. Undo can reverse a restore. AI edits and merges keep a checkpoint of the preceding source.

**Export → Project archive** saves the current website as a `.btcsite` file. **Website source folder** exports ordinary source and assets. **Final root HTML** is available only when local dependencies no longer need publication. Open an archive with **Open project** or import a static website folder.

An archive contains the current project, rather than its complete history or publication journal. Back up the complete application user-data directory while the app is closed to preserve those records. Publication recovery needs its protected vault as well as its records; see [RECOVERY.md](RECOVERY.md).

## Libraries and offline behavior

Open **Explore library catalog** from the home screen, or **Libraries → Browse possibilities** inside a project. Search by capability, version, use case or inscription ID, then choose a card to see code examples, dependencies and qualification details. **Use now** offers Three.js, two p5 versions, Phaser, Tone, Matter.js, anime.js, D3 and JSZip. **Add to this project** inserts the include and credits; use **Copy example** and open **Code** to add its behavior. A starter creates a separate project, preserving the project you already have. Falling shapes, Motion study and Data garden join the existing creative experiences.

**Discover more** makes the report’s 149 inscription IDs browsable, including styles, fonts, frameworks, audio tools and Bitcoin helpers. **Needs review** keeps flagged versions and unresolved metadata visible for inspection. These research records cannot be added until qualified. Some supported libraries also have pending production license reviews, displayed in their details. Read the [library browser review](LIBRARY_BROWSER.md) for the scope and evidence.

The first preview of an on-chain library requires its public gateway content. Retrieved bytes are hash-checked and cached. A later cached preview can work without that download. Dynamic chain data requires its provider; a missing resource or provider remains an actionable error. The app does not silently turn a live chain-data request into a snapshot.

Generated websites retain open-source credits. **Restore credits** repairs the managed credit region while preserving custom source. Builds reject removal or alteration of required retained notice text.

## Connect an AI client

Open **AI connection**, choose the project grant and whether creation is allowed, then choose **Create connection & copy settings**. Paste the generated `mcpServers` entry into a compatible client and keep the app open. Packaged settings launch the packaged executable directly, without Node or the source repository.

Edits appear in the desktop and carry the connection's attribution. Revision checks prevent an assistant from overwriting newer source. Connections can be revoked. Publication planning needs a separate opt-in grant; an assistant can request an exact owner review but cannot approve it. The [MCP contract](MCP_CONTRACT.md) documents the tools and limits.

## Publish through your local Core / Ord node

The advanced local route needs the qualified Bitcoin Core 31.1.0 and Ord 0.29.0 tools, a synced regtest index, and confirmed native Taproot funding. Development commands `npm run tools:regtest` and `npm run dev:regtest` install checksum-pinned tools and start an owned disposable test network. They print the connection fields and wallet destination. The launcher creates a fresh network each time.

Open **Inscribe**, select **Regtest** for those disposable connection fields, and select the RPC cookie through the native chooser. A packaged app also asks for the qualified Ord executable when it is not already available. The app validates the executable's exact hash and both node/index versions and networks. Host paths and credentials are never passed to the AI client.

Choose a destination and fee rate, then **Prepare exact review**. Review the network, content hashes, selected funding inputs, change, postage, and miner fees. Postage stays at the destination and is separate from the miner fee. Approving publishes that exact resource. Dependencies confirm and verify before the next resource is reviewed; the root publishes last. Saved receipts contain the verified IDs and costs. Mainnet library references cannot be reused on a regtest chain.

After a verified publication, copy its root ID, open the selected explorer, and export the receipt. Keep the original chain and recovery records if you need to inspect or resume that release. See [RECOVERY.md](RECOVERY.md) before canceling or changing a backend.

For production, choose **Bitcoin mainnet** and the endpoints for your own fully synchronized Core 31.1.0 and Ord 0.29.0 node. The RPC and explorer endpoints must be local `http://127.0.0.1` addresses with explicit ports. The app rejects a different network, incomplete node sync, chain warnings, missing indexes, or a different Ord binary/server version. It needs a descriptor wallet with a local signer, confirmed cardinal Taproot funding, and macOS secure storage. Mainnet execution must be qualified before public release.

Review any **Protected funding outputs** when connecting. Enter one `txid:vout` per line to exclude rare sats or outputs you want to keep. The app automatically excludes indexed inscriptions and runes; it does not claim to identify every collectible sat. Unlock an encrypted funding wallet through Bitcoin Core when requested, then resume the exact reviewed plan. Never send a wallet password or seed to the builder or an AI client.

Mainnet reviews identify real Bitcoin, destination, every selected input/change output, fixed miner fees and postage. Each resource requires its own owner click. Core’s current relay minimum and standard transaction weight are checked. A resource too large to relay must be reduced; the app does not split it invisibly. Reused catalog libraries must have a completed distribution review and must match their confirmed transaction envelopes and local Ord content. Pending p5/Phaser distribution reviews block inscription with those libraries. Their previews remain available.

The app preserves exact interrupted transaction pairs. It does not provide wallet recovery, portable signing-key export, or transaction fee replacement. Keep your Core wallet backups under your own existing wallet procedure and keep the app’s private publication records for any interrupted commit/reveal.
