# Architecture

## Goals

Bitcoin Browser is a desktop-native information browser for Bitcoin and Ordinals. The architecture prioritizes protocol correctness, local sovereignty, replaceable sources, recursive composition, content isolation, wallet separation, deterministic recovery, and an interface that exposes advanced functionality without forcing it into every default view.

## Process topology

```text
┌──────────────────────────────── Electron main process ────────────────────────────────┐
│ lifecycle · secure state · provider routing · recursive cache · custom protocols     │
│ local process manager · transaction parser · wallet coordinator · diagnostics         │
└──────────────────┬─────────────────────────────┬───────────────────────────────────────┘
                   │ validated IPC               │ validated wallet events
      ┌────────────▼─────────────┐     ┌─────────▼─────────────────┐
      │ Trusted browser renderer│     │ Wallet Bridge renderer    │
      │ app://app/renderer/      │     │ wallet.satoshi.invalid   │
      │ no Node / isolated world│     │ separate partition        │
      └────────────┬─────────────┘     │ extension injection only  │
                   │ iframe            └───────────────────────────┘
      ┌────────────▼───────────────────────────────────────────────┐
      │ Untrusted inscription frame                               │
      │ ord://content/* or ord://r/*                              │
      │ opaque sandbox; no preload, IPC, wallet, popup, top-nav  │
      └────────────────────────────────────────────────────────────┘
```

The main process is the only layer allowed to access the filesystem, launch local processes, communicate with providers, persist credentials, register custom protocols, or coordinate wallet requests. The trusted renderer gets a narrow context-bridge facade. Inscription content is never trusted renderer markup.

## Modules

### Shared domain

`src/shared/navigation.js` defines target grammar, canonicalization, ambiguity, deep links, and capability mapping. It has no Electron dependency and can be fuzzed or reused by command-line tooling.

`src/shared/validation.js` validates settings and provider configuration and recursively sanitizes untrusted JSON. Provider URLs may use only HTTP(S), may not embed credentials, and can enter local routing only when the request-time DNS/IP policy proves every destination is loopback or private.

`src/shared/errors.js` provides stable application error codes and safe renderer envelopes. Provider bodies and stack traces do not cross IPC by default.

### Main process

`StateStore` stores schema-versioned JSON atomically with a previous-file backup. It bounds tabs and history and validates provider/settings records during migration.

`SecureStore` encrypts secrets with Electron `safeStorage`. It refuses writes when OS encryption is unavailable.

`ProviderManager` creates provider adapters from validated configuration, filters by network/local/capability, orders by explicit preference, observed health, and priority, then records every attempt.

`RecursiveResolver` maps safe `ord://` resources to ord-capable sources, enforces cache/resource/concurrency policy, computes content hashes, supports byte ranges, and builds bounded dependency graphs for text-like resources.

`WalletManager` owns the separate Wallet Bridge window at the reserved intercepted origin `https://wallet.satoshi.invalid`, receives sanitized public state, and coordinates commands. The standard HTTPS origin lets extension match patterns work while the separate partition prevents injection into the trusted shell. Packaged beta builds reject signing before any bridge command or native dialog.

`LocalServiceManager` persists local process configurations and launches them directly with an argument vector. It owns stdout/stderr capture and termination.

`ipc.js` is the application capability boundary. Each invoke handler authenticates the sender URL before validating payloads and calling domain services.

### Renderers

The browser renderer is a DOM-only ESM application. It uses text nodes for remote values. Tab navigation, local library pages, settings, provider management, local services, wallet state, developer inspection, and command actions are centralized in `app.js`; views are in `views.js`.

The Wallet Bridge renderer adapts several injected-wallet shapes. It cannot call main-process APIs directly except for the dedicated ready/event/command channels exposed by its own preload.

## Domain model

### Navigation target

```ts
interface NavigationTarget {
  kind:
    | 'home' | 'internal' | 'search' | 'collection'
    | 'inscription' | 'inscription-number' | 'content'
    | 'sat' | 'sat-name' | 'sat-degree'
    | 'block' | 'transaction' | 'output' | 'satpoint'
    | 'address' | 'rune' | 'recursive'
    | 'external-web' | 'payment';
  value: string | null;
  canonical: string;
  display: string;
  confidence: 'high' | 'medium' | 'low';
  ambiguous: boolean;
  alternatives: Array<Pick<NavigationTarget, 'kind' | 'value' | 'canonical' | 'display'>>;
}
```

A target is a navigation intent, not provider data. Bare ambiguous values retain alternatives. Canonical strings are stored in tabs, history, and bookmarks.

### Normalized entity

```ts
interface NormalizedEntity {
  schemaVersion: 1;
  type: string;
  id: string;
  canonical: string;
  network: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  summary: Record<string, unknown>;
  data: unknown; // bounded, sanitized provider-native payload
  links: Array<{ rel: string; kind: string; value: string; title?: string }>;
  source: {
    id: string;
    name: string;
    type: string;
    latencyMs: number | null;
    endpoint: string | null;
  };
  fetchedAt: string;
}
```

The normalized summary serves the default view. The complete bounded payload remains available in developer inspection to preserve expert functionality.

### Provider

```ts
interface ProviderConfig {
  id: string;
  type: 'ord-server' | 'mempool' | 'bitcoin-core' | 'mock';
  name: string;
  network: Network;
  baseUrl: string;
  enabled: boolean;
  priority: number;      // lower first
  local: boolean;        // request-time policy permits only loopback/private DNS answers
  capabilities: ProviderCapability[];
  cookieFile?: string;
}

interface Provider {
  supports(capability: ProviderCapability): boolean;
  health(options): Promise<ProviderHealth>;
  resolve(target, limits): Promise<NormalizedEntity>;
  fetchPath?(path, limits): Promise<BinaryResponse>;
}
```

`ProviderManager` is the only component that selects adapters. The UI consumes descriptors and normalized entities.

### Resolver response

```ts
interface ResolverResponse {
  status: number;
  headers: Record<string, string>;
  data: Buffer;
  provenance: {
    providerId: string;
    providerName: string;
    endpoint: string;
    fetchedAt: string;
    sha256: string;
    attempts: ProviderAttempt[];
  };
  cache: 'hit' | 'miss' | 'stale';
}
```

Cache keys include schema revision, network, preferred source, `Accept`, and normalized path:

```text
v2|<network>|<preferred-or-auto>|<accept>|<path>
```

This avoids serving data fetched under an incompatible source preference or response representation.

### Tab state

```ts
interface TabState {
  id: string;
  title: string;
  target: string;
  history: string[];   // max 200 persisted per tab
  historyIndex: number;
  pinned: boolean;
  lastAccessedAt: number;
}
```

Provider results and loading state are ephemeral; canonical tab history persists.

## Navigation pipeline

```text
user/deep link/history
        │
        ▼
parseNavigationInput
        │
        ├─ external-web/payment ──> native confirmation ──> OS handler
        ├─ home/internal/search ──> local renderer view
        └─ entity target
                 │
                 ▼
          targetCapability
                 │
                 ▼
        ProviderManager.candidates
                 │
         preference/health/priority
                 │
                 ▼
        adapter.resolve + normalize
                 │
                 ├─ success: entity + attempts + history
                 └─ failure: stable error + all attempts
```

No hidden provider-specific URL is placed in tab history. Switching providers or entering local-only mode does not invalidate the navigation model.

## Recursive pipeline

`ord://` URL handling is registered only on the trusted browser session. The protocol handler calls the resolver, not the network directly.

```text
iframe fetch(ord://…)
  -> protocol handler
  -> normalize safe /content or /r path
  -> cache lookup (stale allowed only offline)
  -> capability routing to ord source
  -> bounded network request
  -> selected response headers + CSP
  -> hash/provenance + cache write
  -> Response to sandboxed frame
```

### Dependency graph

Graph inspection starts from `/content/<id>` and breadth-first scans text-like nodes. It recognizes explicit inscription-content references and `/r/*` paths, records edges, tracks ancestors for cycles, and stops at configured byte/depth/node limits. It does not execute JavaScript or infer dynamic URLs.

## Storage

```text
userData/
  state/state.json
  state/state.backup.json
  secure/secrets.json        encrypted values only
  cache/index.json
  cache/objects/<sha256>
  logs/satoshi-browser.log
```

Writes use restrictive modes where supported. State and cache index writes use temporary-file rename. Cache entries are content blobs keyed by a digest of the logical cache key.

## Error taxonomy

Representative stable codes:

| Class | Codes |
|---|---|
| Input | `VALIDATION_ERROR`, `INVALID_TARGET`, `INVALID_URL`, `UNSAFE_URL`, `UNSAFE_ORD_PATH`, `INVALID_PSBT` |
| Availability | `NO_PROVIDER`, `NO_ORD_PROVIDER`, `ALL_PROVIDERS_FAILED`, `OFFLINE_CACHE_MISS`, `PROVIDER_TIMEOUT` |
| Provider | `NOT_FOUND`, `PROVIDER_HTTP_ERROR`, `PROVIDER_FORMAT_UNSUPPORTED`, `PROVIDER_RPC_ERROR`, `PROVIDER_AUTH_ERROR` |
| Limits | `RESOURCE_TOO_LARGE`, range status 416, graph truncation |
| Wallet | `WALLET_NOT_CONNECTED`, `WALLET_TIMEOUT`, `WALLET_BRIDGE_TIMEOUT`, `WALLET_BRIDGE_CRASHED`, `USER_REJECTED` |
| Security | `UNTRUSTED_IPC_SENDER`, `UNSAFE_PATH`, `SECURE_STORAGE_UNAVAILABLE` |
| Local services | `SERVICE_DISABLED`, `SERVICE_NOT_CONFIGURED`, `SERVICE_EXECUTABLE_MISSING` |

Errors crossing IPC contain code, message, status, retryability, and sanitized details.

## IPC boundary

The preload exposes grouped operations instead of raw `ipcRenderer`. All invoke handlers use the same trusted-sender check. Wallet bridge channels are not exposed to the application renderer.

Main groups:

```text
app, navigation, content, providers, settings, tabs, history,
bookmarks, cache, resolver, psbt, extensions, wallet, services,
diagnostics
```

Adding a channel requires:

1. a constant in the shared and preload channel tables;
2. a constrained facade method;
3. trusted-sender enforcement;
4. payload validation and bounds;
5. domain-layer implementation;
6. stable errors; and
7. unit/integration tests.

## Security headers

Trusted app assets receive a self-only CSP, no object/embed support, no base URI, no form submission, and no framing. Inscription responses receive no-sniff, no-referrer, permissions denial, and a content CSP. The renderer iframe adds sandbox restrictions that are independent from the response CSP.

## Extensibility

Provider adapters are the supported initial extension point. A general in-process plugin API is intentionally deferred because arbitrary plugins would collapse the security model. Future extension manifests should be declarative, signed, capability-scoped, and out-of-process.

Potential safe extension points:

- provider adapter subprocesses over a versioned local RPC contract;
- read-only entity decorators operating on sanitized normalized data;
- address grammar aliases with deterministic tests;
- content MIME renderers inside the same untrusted sandbox; and
- export transforms with explicit file dialogs.

## Observability

The logger writes structured JSON lines locally. Diagnostics include app/platform state, providers, source health, service state, cache state, and redacted settings. No telemetry endpoint exists. A production operator may add opt-in analytics only with a documented schema, data retention, consent, and local disablement.
