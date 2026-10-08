# Threat model

## Assets

Highest-value assets and guarantees:

- wallet seeds and funding private keys remain outside the application;
- transaction-specific inscription reveal material stays in authenticated, OS-protected deployment records;
- signing intent and payload are not silently changed;
- provider RPC credentials remain confidential;
- local Bitcoin/ord data and filesystem are not exposed to inscriptions;
- the application cannot be navigated into attacker-controlled privileged content;
- tab/history/bookmark data are not leaked without consent;
- recursive content cannot exhaust unbounded CPU, memory, disk, sockets, or graph work;
- source provenance and fallback attempts are not concealed;
- managed binaries are launched only from explicit operator configuration; and
- update/build provenance can be independently verified.

## Adversaries

1. A malicious inscription author controlling HTML, JavaScript, CSS, SVG, media, and recursive dependencies.
2. A compromised or dishonest remote ord/indexer/API provider.
3. A malicious or compromised wallet extension.
4. A phishing site or payment URI reached from inscription content.
5. An attacker controlling a provider URL, redirect target, RPC error, or oversized response.
6. A local unprivileged user attempting to read state/cache/secrets.
7. A supply-chain attacker targeting npm dependencies, Electron, CI, installers, or auto-update infrastructure.
8. An operator mistake that points local-service configuration at an unintended executable or dangerous arguments.
9. A future UI change that removes visible safety context or bypasses progressive disclosure.

## Trust boundaries and mitigations

### Untrusted inscription to trusted shell

Threats:

- Electron/Chromium exploit;
- top-level navigation to attacker content;
- popup phishing;
- wallet provider discovery/signing;
- clipboard, camera, USB, filesystem, payment, or credential access;
- shared-origin DOM/storage access;
- external tracking;
- deceptive native-looking UI.

Controls:

- separate iframe, no webview;
- no preload or IPC in the frame;
- sandbox omits same-origin, popup, top-navigation, and download tokens;
- app-session permissions denied;
- restrictive `Permissions-Policy`;
- external content networking blocked by default;
- shell window refuses non-app navigation and new windows;
- no wallet extensions in the browser partition;
- content security policy and no-sniff headers;
- current Electron/Chromium required;
- native chrome remains visually distinct from content canvas.

Residual risk: a rendering-engine zero day can cross web isolation. Prompt Electron patching and platform sandboxing remain critical.

### Provider to main process

Threats:

- malformed or deeply nested JSON;
- content-length deception and memory exhaustion;
- slowloris/timeout exhaustion;
- redirect to unexpected hosts;
- HTML returned where structured data is expected;
- inconsistent or false chain data;
- RPC credential exfiltration through a malicious URL;
- source correlation of browsing activity.

Controls:

- bounded request time and bytes;
- JSON sanitization depth/key limits;
- explicit capability and network selection;
- credentials cannot be embedded in URLs;
- Core credentials are scoped to the selected Core endpoint;
- normalized data is displayed as text;
- attempts and provenance are retained;
- local-only and offline modes;
- every local-provider request/redirect is re-resolved and pinned only to loopback/private answers;
- every remote-provider request/redirect rejects loopback, private, link-local, multicast, shared, and reserved answers;
- source health does not imply trust or correctness.

Residual risk: this release does not perform multi-source consensus comparison or cryptographic verification of all provider claims. Local Bitcoin Core + ord is the strongest available sovereignty mode.

### Wallet Bridge to main shell

Threats:

- extension lies about accounts or results;
- extension returns oversized/cyclic values;
- extension silently tracks bridge use;
- wallet method mismatch signs a different representation;
- extension attempts to navigate or open popups;
- stale account state.

Controls:

- separate persistent partition;
- wallet events sanitized and bounded;
- bridge main navigation constrained to its app page;
- popup denial;
- no wallet API in inscription content;
- signing requires connected state and native confirmation;
- PSBT parsed independently before forwarding;
- wallet still performs final approval;
- no key/seed import.

Residual risk: extension behavior remains part of the user's wallet trust. A tested release matrix is required.

### Trusted renderer to main process

Threats:

- renderer compromise invokes arbitrary privileged IPC;
- malformed payload reaches filesystem/process/network code;
- attacker-controlled frame impersonates app IPC sender.

Controls:

- context isolation and sandbox;
- no raw Electron API;
- invoke handlers validate `senderFrame.url` against the trusted app route;
- payload validation at every domain boundary;
- file paths selected through native dialogs or validated absolute paths;
- external navigation whitelisted by scheme and confirmed.

Residual risk: an XSS in the trusted renderer would have its exposed app capabilities. Remote content is never inserted as HTML; new UI code must preserve that rule.

### Local service execution

Threats:

- command injection;
- PATH hijack;
- unexpected working directory;
- hostile environment variables;
- orphan process;
- log memory growth.

Controls:

- absolute executable required and verified as a file;
- `spawn(executable, args, { shell: false })`;
- no command string parsing;
- working directory explicit or executable directory;
- Node-specific environment injection variables removed;
- bounded in-memory logs;
- graceful termination then forced kill;
- processes stopped on application quit.

Residual risk: configured binaries and flags have the user's privileges. The UI must label this as privileged operator configuration.

### Recursive resolver

Threats:

- traversal to local app resources;
- loops and explosive dependency graphs;
- oversized resources;
- too many concurrent requests;
- cache poisoning across networks/providers;
- stale volatile chain state;
- dangerous MIME interpretation.

Controls:

- safe path grammar restricted to `/content` and `/r`;
- path/query length and characters bounded;
- traversal and backslashes rejected;
- cache key includes network, source preference, accept, and path;
- separate TTL classes;
- per-resource byte limit;
- global concurrency semaphore;
- graph depth/node/aggregate-byte limits;
- cycle reporting;
- no-sniff and MIME-aware CSP;
- byte ranges validated.

Residual risk: dynamic JavaScript dependency construction cannot be fully graphed statically. Runtime requests still pass through the bounded resolver.

## Abuse cases

### Inscription displays a fake wallet-connect button

The inscription can draw the button, but cannot access the Wallet Bridge or native IPC. Any link or top navigation is sandbox-blocked. The actual wallet surface remains native application chrome/page.

### Remote provider serves a malicious HTML page as inscription JSON

The entity adapter rejects obvious HTML for structured routes. Even if malicious strings enter normalized JSON, the trusted renderer writes them as text nodes.

### User pastes an enormous PSBT

The parser rejects empty/oversized input before allocating unbounded structures, bounds map counts/lengths, rejects trailing bytes, and never performs network resolution.

### Recursive content requests a billion dependencies

Runtime requests are bounded by the resolver semaphore and resource limit. Developer graph inspection stops at configured node/depth/aggregate-byte limits and reports truncation.

### Malicious extension tries to call app IPC

It runs in the wallet renderer/extension context, not the trusted app renderer URL. Main invoke handlers reject non-app senders. Wallet-specific event channels additionally verify the exact bridge `webContents` ID.

### Local provider URL contains a password

Validation rejects URLs with username or password components. Credentials are stored separately only through OS-backed encryption.

## Required security tests before stable release

- packaged Electron exploit-boundary smoke tests;
- navigation and popup attempts from hostile inscription fixtures;
- IPC sender tests from subframes and wallet contexts;
- protocol traversal/query/range fuzzing;
- large/deep JSON and binary response tests;
- redirect and DNS/loopback reclassification tests;
- wallet compatibility and malicious-wallet fixture tests;
- PSBT corpus and mutation fuzzing;
- local-service argument/path tests on all platforms;
- state/cache corruption recovery tests;
- dependency audit/SBOM/signature verification; and
- manual CSP/permission validation in packaged builds.

## Create mode boundary

Create is a different trusted main document, authenticated against the live main window, its main frame and exact URL. The native Browse document can request entering Create but cannot invoke creator commands. Both documents render untrusted content only through the existing opaque native `ord:` iframe. Draft origins bind project and build identity; obsolete builds, unknown resources and external URLs fail closed. Library bytes pass the native browser resolver and then match the catalog's pinned hash.

A compromised Create renderer would hold source-editing and owner publication capabilities. Source content must never be inserted into that document as executable markup. MCP connections are independently scoped, authenticated, revoked and denied spending approval. Native cookie and executable grants stay outside MCP payloads.

Create's additional assets are immutable source history, recoverable unsaved source drafts and the per-transaction deployment vault. An altered sealed record is rejected before broadcast. Exact owner review binds the transaction, inputs, output destination, fee, network and resource. Vault startup has a bounded secure-storage timeout; an unavailable Keychain leaves authoring available. Wallet recovery is not offered. This local candidate has no real mainnet execution qualification.
