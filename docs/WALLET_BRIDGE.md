# Wallet Bridge

## Purpose

Wallet connectivity is an explicit application capability, not a property of viewed content. Bitcoin Browser hosts injected wallet providers in a dedicated Electron partition and window so arbitrary inscriptions cannot discover or invoke them.

## Partitions

```text
Application shell  persist:satoshi-browser-app
Wallet Bridge      persist:satoshi-browser-wallet at https://wallet.satoshi.invalid
```

Only the Wallet Bridge session loads unpacked extensions. Its reserved `.invalid` HTTPS origin is intercepted locally and serves only `src/wallet` assets; other HTTPS requests are delegated to the wallet session for extension backends. This standard origin makes MV3 content-script matching possible. The application session and `app://app/renderer/` have no injected wallet provider.

## Packaged beta gate

Every packaged `1.0.0-rc.1` build sets `signingEnabled: false`. PSBT and message signing IPC returns `FEATURE_DISABLED` before checking connection state, parsing a payload, showing native review, or calling the bridge. The UI visibly disables both signing controls. Discovery, public-account connection, and disconnect are enabled. A non-signing MV3 fixture passed in the historical packaged matrix; the newer discovery/connection lifecycle changes have local real-component VM coverage, not current-source packaged qualification. Native launches remain paused pending explicit approval for possible macOS Keychain queries.

## Public wallet state

Only bounded public descriptors cross into the application:

```ts
interface PublicWalletState {
  connected: boolean;
  walletId: string | null;
  walletName: string | null;
  accounts: Array<{
    address: string;
    publicKey: string | null;
    purpose: string | null;
    addressType: string | null;
    network: string | null;
  }>;
  connectedAt: string | null;
}
```

No seed, mnemonic, private key, signing key, wallet database, authentication token, or unrestricted provider object may cross the bridge.

Opaque wallet IDs must be nonempty strings of at most 120 characters. Overlong IDs are rejected rather than truncated into another identity. Main accepts at most 50 valid public wallet descriptors after scanning at most 500 entries, and at most 20 valid public accounts after scanning at most 200 entries. Malformed entries do not cause property dereferences or string coercion. A connected state requires both an exact valid wallet ID and at least one valid public account; invalid authority becomes disconnected with no accounts.

## Bridge protocol

Main-to-bridge commands:

```ts
interface WalletCommand {
  requestId: string | null;
  action: 'refresh' | 'connect' | 'disconnect' | 'signPsbt' | 'signMessage';
  payload: unknown;
}
```

Bridge-to-main events:

```text
discovered  sanitized wallet descriptors
state       public state from direct Bridge controls or discovery-driven revocation
result      bounded success or error for one main-originated request ID
```

The main coordinator accepts events only from the exact current Wallet Bridge `webContents` ID.

Main-originated connect/disconnect commands publish only correlated results, not an additional uncorrelated state event. The main process tracks connection intent separately from window lifetime, rejects obsolete requests, checks readiness before admission and checks the exact selected wallet ID before accepting a successful result. Direct Bridge controls still publish state as an explicit new intent. Disconnect revokes public authority immediately; late approval or remote cleanup cannot restore or overwrite a newer connection. Extension removal retains its distinct cancellation error.

The renderer checks connection generation and registry/provider identity around asynchronous work. Benign refresh and unrelated late registration retain stable wrapper identity. Unregistering or replacing the selected provider revokes its authority; pending obsolete results cannot publish. Reconnecting to the same provider waits for its older disconnect transport to settle, while another provider remains usable. These guarantees concern app connection state, not cancellation of an extension-owned popup or proof that an external wallet has revoked its own permissions.

## Discovery adapters

The initial bridge recognizes:

- Wallet Standard registration events with a Sats Connect feature provider;
- `window.BitcoinProvider` and `window.LeatherProvider` JSON-RPC-like providers;
- UniSat-style `requestAccounts`, `signPsbt`, and `signMessage` providers;
- commonly named OKX/Magic Eden Bitcoin injection objects; and
- conservative detection of window objects exposing `requestAccounts` or `request`.

This is interoperability glue, not proof of a universal standard. Maintain tested fixtures for each supported wallet/version and remove heuristic entries that create false positives.

Wallet Standard uses a frozen API object containing a `register` method for both initial `app-ready` and late `register-wallet` handshakes. The app now implements that object contract, ignores duplicate registration of the same wallet object, and gives unregister callbacks ownership of their exact registration. Distinct same-name wallets get distinct, bounded bridge-lifetime IDs; stale unregister callbacks cannot remove a later registration. This follows the [primary Wallet Standard app registry](https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/app/src/wallets.ts) and [browser event contract](https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/base/src/window.ts).

Account fixtures cover direct arrays, top-level `addresses`/`accounts`, their nested `result` forms and the existing nested-address adapter form. RPC dispatch remains a single selected positional or object-style call; it does not retry a rejected request in another shape. These fixtures do not establish that every named wallet/version supports the chosen RPC method or approval/permission lifecycle. The real wallet/version matrix remains mandatory before advertising compatibility or enabling signing.

## Permission model

Current scopes are implicit and minimal:

| Action | Required state | Native confirmation | Wallet confirmation |
|---|---|---:|---:|
| Discover | user opens/discovers bridge | no | no |
| Connect/read approved accounts | explicit wallet choice | wallet UI | yes |
| Disconnect | connected or bridge state | no | provider-dependent |
| Inspect PSBT | none | no | no |
| Sign PSBT | disabled in packaged beta | not reachable | not reachable |
| Sign message | disabled in packaged beta | not reachable | not reachable |

Future permission persistence should be capability-scoped and user-revocable, for example `accounts:read`, `psbt:sign`, and `message:sign`. It must remain associated with the trusted application—not inscription origin.

## Future PSBT signing flow

The following flow is required only after the signing gate is intentionally removed and the advertised wallet matrix is complete.

1. Trusted renderer submits encoded PSBT to main IPC.
2. Main parser validates magic, maps, counts, lengths, supported transaction form, and trailing bytes.
3. Main computes recognized output addresses/types, totals, fee when all inputs are known, warnings, and SHA-256.
4. Main opens a native review dialog with counts, total output, fee status, representative outputs, and warnings.
5. User chooses Continue.
6. Bridge invokes the connected provider.
7. Wallet extension performs final review/signing.
8. Result is sanitized and returned.

The browser does not assert that a preview proves inscription preservation, rare-sat safety, fee market appropriateness, or absence of wallet-specific mutation. Those require wallet/indexer-aware simulation and should be added as explicit analyzers.

## Extension installation

The user selects an unpacked extension directory through a native directory picker. The manager validates `manifest.json`, accepts manifest v2 or v3, asks Electron to load it with file access disabled, and persists only public extension metadata/path.

Risks:

- unpacked extensions are executable code with declared permissions;
- extension updates are not automatically verified;
- browser-store installation/update flows are not provided;
- a malicious extension can lie or track within the wallet partition.

Production distributions should prefer reviewed extension IDs and version hashes, and may replace unpacked installation with a signed allowlist.

## Hardware wallets

Hardware-wallet support is mediated by the connected wallet extension. The application session denies USB/HID permissions, and the browser does not implement device protocols. This preserves key isolation and avoids expanding the main-process attack surface.
