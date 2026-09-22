# Feature reference

Detailed browsing, source, recursion and wallet behavior carried forward from the Satoshi Browser source. Start with the [getting started guide](GETTING_STARTED.md) and [current beta downloads](../README.md#download-v010-beta).

## Browse syntax

Start includes a guided lookup for inscriptions, blocks, transactions, addresses, and sats. Enter an identifier and choose **Search**, or expand **Search options & examples** to select a type and see its help. **Try an example** only fills the field. Automatic recognition asks you to choose when a number, hash, or sat name has several meanings. Exact lookups use your configured sources and the current network/privacy settings. Browsing requires neither a connected wallet nor your own node; **Tools & setup** retains both optional paths.

Open **Inscriptions** in the sidebar, choose **Explore inscriptions** on Home, or enter `satnav://inscriptions`. Browse the configured source’s inscription index page by page, paste a number/ID/inscription link into **Find**, or expand **Find by block**. Cards open the existing full inscription viewer. Search and block drafts survive loading/error publication; media filters operate only on the current page. Number/ID lookup is source-wide. Global collection-name, keyword, and content-text search are not available and require an additional search index.

The **Collector trait** filter combines with media filters to find non-common sats, 9ball/palindrome/coin-boundary sats, cursed/vindicated inscriptions, reinscriptions or records without available rarity on the loaded page. Open an inscription and choose **Details** for rarity explanations, scheduled class supply, sat name/mining block, inscription date/fee, output postage and native provenance links. A missing sat number is not treated as common. Local calculations are mainnet-only; reported source charms remain separately attributed. Runes have a local **Mint status** filter and **Supply at a glance** on detail pages. Remaining capacity is not a guarantee that minting is currently open. These features use existing metadata and preserve exact integer token amounts; they do not introduce prices, verified collection ranks, holder counts or wallet permissions.

The gallery uses existing inscription-provider authority, network selection, local-only/offline settings and caches; no new remote search service or provider default is added. It reads Ord JSON listings or a bounded public-page fallback when JSON is disabled. Provider HTML is parsed for identifiers, never embedded in the shell. Up to 24 cards are displayed, with at most four metadata requests concurrently. Only raster images declared and received at 2 MiB or less preview automatically; interactive content, SVG, text, audio and video open on selection. This is an encoded-byte bound, not a decoded-image memory guarantee. Live index pagination can shift as new inscriptions arrive.

Both **Inscriptions** and **Runes** include **Popular to explore**, with three curated mainnet cards and **Show all 6**. Rune cards open existing supply/mint details; inscription project cards open one exact example, not a complete collection. **Show safe artwork** requests only eligible bounded raster previews through your configured sources. The new cards add no automatic content requests, live ranking feed, market prices, wallet access or provider account. **Asset details** contains exact IDs and optional external references. See [catalog references, privacy boundaries and limitations](POPULAR_DISCOVERY.md).

Real project logos and collection icons are bundled for immediate, offline display without contacting third-party image servers. These identify the project and are separate from the exact-example preview. [Image sources and rights notes](POPULAR_ASSET_LOGOS.md) record the original assets; no remote logo feed or new permission is added.

Choose **History and bookmarks** to search saved titles and identifiers on this device, or use `search:your phrase` in the address bar. Matching is case-insensitive and requires every word. Results show up to 30 unique targets, with bookmarks first; use **Refresh results** after library changes. Search phrases may appear in local history, but are not sent to a search service. Saved-item matching is separate from the provider-backed Inscriptions gallery.

The omnibox accepts bare identifiers where recognition is safe and explicit prefixes where ambiguity exists.

**Ask Bitcoin** adds a dedicated local-AI chat and source-results workspace (`satnav://ai`). Connect a user-run LM Studio or Ollama server, choose a chat model, and ask about Bitcoin entities, inscriptions or Runes. Read-only tool results open as normal browser tabs; the AI cannot access wallets, sign, execute code or change settings. Connection is explicit, chats are memory-only, and Bitcoin lookups respect your existing source/privacy settings. See [setup, privacy, supported tools and beta limitations](LOCAL_AI.md).

| Target | Examples |
|---|---|
| Inscription | `inscription:<txid>i0`, `#12345`, `satnav://inscription/<id>` |
| Inscription gallery | `satnav://inscriptions`, `satnav://inscriptions?block=840000` |
| Sat | `sat:0`, `sat:nvtdijuwxlp`, degree notation |
| Transaction | `tx:<txid>` |
| Block | `block:840000`, `block:<hash>` |
| Output | `output:<txid>:0` |
| Satpoint | `satpoint:<txid>:0:42` |
| Address | `address:bc1…` |
| Rune | `rune:UNCOMMON•GOODS` |
| Explore Runes | `satnav://runes` |
| Ask Bitcoin (local AI) | `satnav://ai` |
| Recursive resource | `/r/blockheight`, `/content/<id>`, `ord://r/blockheight` |
| Internal page | `satnav://wallet`, `satnav://providers`, `satnav://settings` |
| External web | `https://…` or `web:https://…`; opens in the system browser after confirmation |
| Bitcoin payment | `bitcoin:…`; opens in the system wallet after confirmation |

A 64-character hexadecimal value can be a transaction ID or block hash. A bare integer can be a sat number, block height, or inscription number. Bitcoin Browser displays the alternatives instead of silently guessing. Prefixes make intent deterministic.

## Local sovereign topology

For the easiest setup, choose **Set up a local node** on Home or **Guided setup** in Local node (`satnav://node-setup`). New setups first show a locally calculated computer-capacity recommendation. **Set up Bitcoin Core** downloads, configures and starts compact mainnet Core after **one native confirmation**, using fresh storage and conservative memory/validation-thread targets. It requires 30 GiB free for this recommended path; total storage can grow and the initial historical download is still substantial. No hardware profile is uploaded. See [capacity-aware setup and its limits](EASY_NODE_SETUP.md).

**Customize setup** retains the five-step walkthrough for Core + Ord, Core only, Ord only, or **Not now** without changing configuration. For each selected service, download the supported program, select an installed executable, or connect a running loopback service. Archive storage, optional snapshot-assisted sync, custom networks/ports, index options and advanced editors remain available.

In the customizable walkthrough, downloads, saving configuration, and starting services remain separate confirmed actions. The simple Core path combines those three operations in one explicit native review. Managed downloads pin Bitcoin Core 31.1 and Ord 0.29.0 by SHA-256; this is integrity checking, **not publisher-signature verification**. macOS launch protections remain enabled. The download catalog covers macOS arm64/x64, Windows x64 and Linux x64; Linux arm64 has Core only. Unsupported entries link to official downloads. Native installation and launch compatibility still require qualification.

Managed downloads permit only HTTPS on the default port at `bitcoincore.org`, `github.com`, `release-assets.githubusercontent.com`, and `objects.githubusercontent.com`. Each redirect is checked before its destination is contacted; a changed upstream destination produces an actionable failure instead of widening that policy. Fresh download results retain only a bounded list of response origins and HTTP statuses, not signed URL paths, query tokens, headers, or response bodies. Verified cached installations have no new download trace. This restriction is specific to managed software downloads; it does not change custom provider endpoints.

Managed services use fresh dedicated data folders, never edit personal `bitcoin.conf`/Ord configurations, and bind RPC/HTTP to loopback. On public networks, Core verifies the chain with outbound peer connections; inbound peer serving is off in the guided default. For **mainnet**, plan conservatively for about 1 TiB for managed archival Core plus 512 GiB for managed Ord, or more with sat indexing; actual requirements vary and sync can take days. The review counts only the components managed by this setup. Compact storage is the easy Core recommendation and is also available in the walkthrough's visible storage choices, with historical-lookup limitations. Testnet3, signet, and regtest have no fixed capacity recommendation in the walkthrough. When free space can be checked, managed startup requires at least 2 GiB available; this is a minimum safeguard, not enough space for a full sync or a limit on future disk growth. The new easy-setup path separately requires the more conservative 30 GiB allowance before installation.

New **regtest** setups default to **Core peer connections: Off — local test chain only** in Advanced settings. This disables Core peer activity and DNS seeding at startup; blocks must be supplied locally. Select **Automatic — allow peer traffic** when intentionally connecting a regtest network. The choice appears in Review and the native confirmation. Older saved setups retain their original commands and ownership checks. This is application configuration, not an OS firewall: authenticated Core RPC can change network activity. Choosing existing Core, Ord only, or neither does not change another process's peer policy. Regtest storage and indexing time depend on the locally supplied blocks and selected indexes; the bounded native fixture is a separate qualification procedure in [NATIVE_NODE_REGTEST_PLAN.md](NATIVE_NODE_REGTEST_PLAN.md).

When all selected services are already running, the walkthrough saves connections without asking for a new node storage folder or checking unused storage. **Check connections** reads their current status; it does not start or stop those external processes. Their existing storage remains their own responsibility. Saved-plan ownership and provider/network checks still apply.

Managed Ord requires archival Core with `txindex=1` and `rest=1`. **Ord only does not remove that dependency**: select the existing Core RPC URL and cookie file, or connect a running Ord server without managing it. The browser waits for Core sync, its transaction index and REST before launching managed Ord. Cookie values are used only for normal app-managed local authentication, not displayed by the walkthrough. No wallet is created and no funds are used.

One guided setup is saved per browser profile. Reopen Guided setup and choose **Resume existing setup** for status/start/stop. Autostart is off by default and explicitly opt-in. Stopping affects only app-managed processes, never an already-running service you connected. Advanced edits remain possible; the walkthrough then refuses to control changed definitions until reviewed through advanced controls. Node data is never automatically deleted. Existing providers remain enabled, so browsing may use them while the local node syncs; select local-only routing when you want only local providers.

A recommended local deployment is:

```text
Bitcoin Browser
  ├─ ord provider adapter ──> http://127.0.0.1:<ord-port>
  │                            └─ ord index + recursive endpoints
  └─ Bitcoin Core adapter ──> http://127.0.0.1:<rpc-port>
                               └─ bitcoind blockchain/transaction data
```

1. Install and fully verify Bitcoin Core using its official release process.
2. Configure `server=1`; enable `txindex=1` when transaction lookup requirements demand it.
3. Build or install `ord` from a release you have verified.
4. Start `ord server` against the intended Bitcoin Core network and data directory.
5. In **Data sources**, edit the local `ord` URL and Bitcoin Core RPC source.
6. For Bitcoin Core authentication, prefer a local cookie file. A username/password pair can be stored only when OS encryption is available.
7. Run a source health check, set the local source as preferred, then enable **Local-only routing**.
8. Enable **Offline mode** only after required resources have been cached; cache misses remain explicit.

Browser offline mode blocks provider resolution and external inscription requests, even if HTTPS/WSS compatibility was previously selected. Tightening that policy also closes the browser session's existing connections before settings success is reported; exact active-WebSocket behavior still requires runtime qualification. Local-only is a provider-routing setting. Neither control disconnects Wallet Bridge extensions, which use a separate network session; neither is a machine-wide firewall.

The **Local node** screen retains full executable/argument editing and process logs. Its **Guided setup** adds reviewed flags and fresh configuration for the pinned versions. Choose the advanced path for custom versions, flags, authentication or topology; these remain available without the walkthrough.

If **Stop** reports an error, inspect the service's status and logs: the process may already have exited, but with an error or after forced termination. The browser retains that outcome instead of reporting a clean stop. **Refresh services** only reads current state; it does not repeat Stop. Removal keeps the configuration and logs if its stop fails, so review the failure before explicitly trying removal again. Generic process termination is not proof that a node flushed its database safely. In particular, Node's Windows signal emulation terminates processes abruptly; graceful native Core/Ord shutdown remains a platform qualification gate. See [Node's child-process signal contract](https://nodejs.org/download/release/v22.23.2/docs/api/child_process.html#subprocesskillsignal).

## Recursive resources

`ord://` is an application-local transport mapped to `ord server` content and recursive endpoints. It does not claim to be a Bitcoin consensus protocol or a new on-chain URL scheme.

Examples:

```text
ord://content/<inscription-id>
ord://r/blockheight
ord://r/inscription/<inscription-id>
```

Resolution behavior:

1. Parse and normalize only `/content/*` and `/r/*` paths.
2. Reject traversal, backslashes, NULs, unsafe queries, oversized paths, and unrelated schemes.
3. Select an eligible `ord-recursion` provider for the configured network and source policy.
4. Read from a provider-specific cache key when available.
5. Enforce timeout, maximum response size, bounded concurrency, and optional byte ranges.
6. Record provider attempts and SHA-256 content provenance.
7. Cache immutable inscription content for a long lifetime and volatile chain-tip endpoints briefly.
8. Apply restrictive response headers and a content security policy before rendering.

The developer inspector can scan text-like inscription content for `/content/<id>` and `/r/*` references, construct a bounded dependency graph, and report cycles or truncation. This graph is developer tooling, not a claim that every dependency follows one module standard.

## Wallet model

The application has two persistent Electron partitions:

```text
persist:satoshi-browser-app      trusted browser shell; no wallet provider
persist:satoshi-browser-wallet   isolated Wallet Bridge at https://wallet.satoshi.invalid
```

The main shell communicates through a narrow context-isolated preload API. Inscription frames receive no preload, IPC API, extension injection, or shared origin. Wallet actions are available only to trusted `app://app/renderer/` IPC senders.

Connection and signing flow:

1. The user opens Wallet Bridge or starts discovery.
2. Compatible injected providers are enumerated inside the wallet partition.
3. The user explicitly connects and approves account disclosure in the wallet.
4. Public account descriptors return to the main shell.
5. In packaged beta builds, PSBT/message signing stops here with `FEATURE_DISABLED`; the controls are visibly unavailable.
6. A future signing-enabled build must parse the PSBT locally, obtain native review, invoke the exact validated wallet adapter, and retain the wallet's final approval.
7. Bitcoin Browser never receives or derives a private key.

Wallet injection APIs are not perfectly standardized across all extensions. The bridge includes Wallet Standard/Sats Connect-style discovery, common JSON-RPC providers, and UniSat-compatible methods. Release owners must maintain a tested compatibility matrix rather than claiming universal wallet support.

## Provider adapters

Provider UI and navigation depend on normalized capabilities rather than brand-specific routes.

```js
// Conceptual adapter contract
class DataProvider {
  supports(capability) {}
  health({ timeoutMs }) {}
  resolve(target, { timeoutMs, maxBytes, signal }) {}
  // ord-capable providers additionally implement:
  fetchPath(path, { accept, range, timeoutMs, maxBytes, signal }) {}
}
```

Built-in capability names:

```text
ord-recursion, inscription, inscription-number, sat, block,
transaction, transaction-raw, output, satpoint, address, rune
```

Add a new provider by extending `src/main/providers/base.js`, normalizing its responses through `normalizeEntity`, registering it in `ProviderManager.refresh`, adding deterministic fixtures, and proving fallback/error behavior in tests. The renderer must not import the provider implementation.

Satpoints require an Ord provider with sat indexing; generic transaction-output support is not sufficient. Fee recommendations have no current navigation/IPC/UI feature and are not offered as a configurable capability.

### Recover a source's saved sign-in details

If **Data sources** shows **Sign-in recovery needed**, choose **Recover source**. Review the source name, endpoint, Bitcoin network and authentication method before approving the action.

- For Bitcoin Core with RPC username/password authentication, enter both values afresh for the reviewed destination. Recovery replaces this app's saved pair; neither old value is reused.
- If your Core-compatible endpoint requires no stored username/password, choose **Use no stored sign-in details** and review that separate action. It clears the saved pair, does not change the server's authentication requirements, and requires a new acknowledgment before submission.
- For a source using a Bitcoin Core cookie or a public API, recovery clears only this app's stored RPC username/password and repairs its recovery metadata. An existing cookie file and its configured path are preserved.
- Source configuration, enabled status and routing preference are preserved. Successful recovery does not prove connectivity or that the supplied credentials are accepted; run a health check afterward.

An interrupted or failed recovery may leave the source blocked. If instructed, use **Refresh source state**, then close and reopen **Recover source** to review the current state before another attempt. Refreshing never resubmits the change. Do not remove and recreate a source to bypass its recovery warning. Migration of ordinary legacy credential records still needs a separate owner decision; native credential-store and recovery-interface qualification remain open for this beta.

### Finish cleanup after removing a source

If removal succeeds but retained sign-in storage cleanup does not, **Data sources** keeps a cleanup warning after restart. Choose **Review credential cleanup**, check the exact source ID, and explicitly approve deletion of this app's retained sign-in storage for that ID. This does not delete a Bitcoin Core cookie file, node data, cached content, another source, or a currently configured replacement. Reusing the ID stays blocked until cleanup is confirmed.

Each deletion review can be submitted only once. If its outcome is unclear or cleanup fails, use **Refresh source state** and open a new review; refreshing never repeats deletion. An unreadable storage file is reported as unavailable, not as successful cleanup. A conflict with a configured source must be reviewed first and provides no cleanup authorization.

For older saved data without a recorded removal, expand **Review an older removed source** and enter an exact source ID you already know. This checks only that ID's app-owned storage without displaying credential values. It does not scan credential stores or prove that a source was previously removed. Any deletion requires a separate acknowledgment, and the ID alone cannot confirm an account or destination.

## Security defaults

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- app permissions denied
- popups denied
- `<webview>` prohibited
- trusted IPC sender validation
- separate browser and wallet partitions
- opaque inscription iframe sandbox
- no same-origin privilege for inscription content
- no external inscription networking by default
- no shell execution for managed processes
- no embedded provider credentials in URLs
- no secret persistence when OS encryption is unavailable
- Electron fuses disable RunAsNode, Node options, CLI inspect, and non-ASAR app loading

Read [`SECURITY.md`](../SECURITY.md) and [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) before changing protocol handlers, session policy, IPC, wallet code, extension loading, or managed services.

