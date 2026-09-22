# Data sources and local operation

## Design principle

A source is a replaceable capability provider, not the product's identity. Bitcoin Browser stores canonical Bitcoin navigation targets and displays normalized entities. It never stores a provider's explorer URL as the meaning of a tab or bookmark.

## Built-in adapters

### ord server

Primary capabilities:

```text
ord-recursion, inscription, inscription-number, sat, block,
transaction-raw, output, satpoint, address, rune
```

Used for inscription metadata/content, sat pages, ord recursive endpoints, and ord-indexed views. The adapter permits ordinary explorer paths only for target types whose currently available structured endpoint may depend on the deployed `ord` version. HTML returned where structured data is required becomes an explicit format error.

Ord's [JSON API](https://docs.ordinals.com/guides/api.html) uses `Accept: application/json` for address, inscription-number and rune routes; these are not assumed to be HTML-only explorer pages. Satpoints use `/satpoint/<txid:vout:offset>`, which the [Ord server](https://github.com/ordinals/ord/blob/master/src/subcommand/server.rs) resolves and redirects to the corresponding sat. This requires sat indexing. Existing Ord configurations with `output` gain the dedicated `satpoint` capability; Mempool/Core output support does not qualify them. Deterministic adapter fixtures establish request/normalization behavior, not a tested native Ord version matrix.

Health probe: `/r/blockheight`.

### mempool-compatible API

Primary capabilities:

```text
block, transaction, output, address
```

Routes use the common `/api` REST shape. Deployments with a different base path should use a small adapter rather than adding renderer branches.

Health probe: `/api/blocks/tip/height`.

### Bitcoin Core JSON-RPC

Primary capabilities:

```text
block, transaction, transaction-raw, output
```

Authentication order:

1. configured cookie file;
2. separately encrypted username/password; or
3. unauthenticated local RPC only when the operator has intentionally configured it.

The browser never edits `bitcoin.conf`. Transaction lookup may require `txindex` or a known mempool/wallet transaction depending on Core configuration.

Health probe: `getblockchaininfo`.

### Mock fixture

Deterministic local responses for tests and UI development. It must not be enabled in a production profile unless clearly labelled as fixture data.

## Capability routing

Candidate selection filters in this order:

1. provider enabled;
2. provider network equals current network;
3. local-only policy when enabled;
4. declared target capability; then
5. ordering by explicit preferred ID, observed health, and numeric priority.

Resolution attempts continue after transport/provider failures. Invalid user targets and resource-limit violations are not hidden by fallback. The final failure includes all sanitized attempts.

## Health state

Health is a recent operational signal, not a correctness certificate. A healthy provider may return dishonest or stale data. The UI therefore shows source provenance per entity and retains attempt details.

Recommended future fields:

```ts
interface ProviderHealth {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  height?: number;
  headers?: number;
  initialBlockDownload?: boolean;
  verificationProgress?: number;
  chain?: string;
  error?: SerializedError;
}
```

## Local-only and offline

Local-only excludes providers not configured as local from candidate sets. Each local provider request and redirect must also resolve exclusively to permitted loopback/private destinations. Provider configuration remains intact, so disabling the mode restores capabilities without data loss.

Offline mode prevents entity network resolution and permits stale recursive cache reads. It does not pretend an uncached resource exists. A cache miss produces `OFFLINE_CACHE_MISS`.

## Adding an adapter

1. Define the external API contract and version assumptions.
2. Extend `DataProvider`.
3. Implement a bounded health request.
4. Implement only declared capabilities.
5. Normalize through `normalizeEntity`.
6. Map provider failures to stable application errors.
7. Register in `ProviderManager.refresh`.
8. Add validation for new configuration fields without allowing arbitrary secrets.
9. Add deterministic success, malformed-data, timeout, resource-limit, and fallback tests.
10. Add settings UI while preserving generic provider controls.

Do not add brand conditions to `renderer/app.js` or `renderer/views.js`.

## Recommended local deployment runbook

### Bitcoin Core

- Verify the official binary/signatures.
- Select the intended network.
- Allow the initial block download to complete.
- Use cookie authentication on loopback.
- Restrict RPC exposure with firewall and Core configuration.
- Enable transaction indexing only when operational requirements justify disk/time cost.

### ord

- Verify source or release artifacts.
- Use the same Bitcoin network as the browser provider.
- Complete the ord index before expecting full inscription/sat behavior.
- Bind the server to loopback unless a secured reverse proxy and authentication model are intentionally deployed.
- Confirm the deployed version supports the recursive endpoints required by the application.

### Browser

- Configure both loopback URLs.
- Run health checks.
- Inspect chain height/network status.
- Prefer local ord for `ord-recursion` and ord entities.
- Prefer Bitcoin Core for raw chain entities when desired.
- Enable local-only after verifying required capabilities.
- Warm the content cache for planned offline demonstrations.

## Privacy notes

Every remote target lookup can reveal interest in an identifier and correlate timing/IP address. Multiple fallback providers can increase disclosure. Strict privacy deployments should use local-only mode, avoid external inscription networking, and operate local Bitcoin Core + ord.
