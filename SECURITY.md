# Security policy

## Supported release

Security fixes target the latest public beta, currently **v0.1.0**, on this repository's `main` branch. This beta has no guaranteed long-term support window. macOS and Windows downloads are explicitly unsigned; macOS is not notarized. See the [installation guides](README.md#download-v010-beta) and release notes for platform status.

## Reporting a vulnerability

Do not publish a working exploit or sensitive user data in a public issue. Email **[patches@turtlemoon.io](mailto:patches@turtlemoon.io)** or use this repository's **Security → Report a vulnerability** private reporting channel. Include:

- affected version and operating system;
- preconditions and threat actor capability;
- exact reproduction steps or a minimal proof of concept;
- impact on keys, signatures, provider credentials, local files, privacy, or code execution;
- whether the issue crosses the inscription, wallet, IPC, protocol, provider, or managed-process boundary; and
- suggested mitigations when available.

We will assess reports and coordinate a fix and disclosure with the reporter. Do not attach private credentials, full profiles, seed phrases or wallet files.

## Non-negotiable invariants

Changes must not weaken these controls:

1. The trusted application shell uses Node integration off, context isolation on, sandboxing on, web security on, and no insecure mixed content.
2. The application session denies permission requests and checks.
3. Popups and `<webview>` are denied.
4. IPC handlers reject senders outside `app://app/renderer/`.
5. Inscription content receives no preload and runs in an opaque sandbox without same-origin, popup, top-navigation, download, or wallet privileges.
6. The browser and Wallet Bridge use separate persistent partitions.
7. Wallet extensions never load into the browser partition.
8. Wallet private keys and seed phrases are not imported or managed. Create can prepare per-inscription transaction material, including an ephemeral reveal key and recovery descriptors, in an authenticated encrypted deployment vault protected by macOS Keychain. This transaction-specific material is separate from wallet custody; see [the creator boundary](docs/CREATOR_MIGRATION.md).
9. Wallet Bridge signing remains disabled in this packaged candidate. Create publication requires exact owner review in its trusted UI and uses the explicitly selected local Core wallet. MCP and viewed content cannot supply owner approval.
10. Provider credentials are not accepted in URLs and are not persisted unless Electron safe storage reports OS encryption.
11. Managed local processes require absolute executable paths and spawn with `shell: false`.
12. Recursive paths are restricted to normalized `/content/*` and `/r/*` namespaces with resource, concurrency, depth, and node bounds.
13. External web/payment URLs open only through the operating system after user confirmation.
14. Electron fuses remain hardened in packaged builds.

`npm run check` rejects common regressions. Code review and packaged runtime testing remain mandatory because static scans cannot prove complete isolation.

## Trust zones

| Zone | Trust | Examples |
|---|---|---|
| Main process | Highest | protocol handlers, IPC, cache, provider credentials, process launching |
| Trusted renderer | Application UI only | tabs, settings, bookmarks, transaction previews |
| Wallet Bridge | Semi-trusted extension host | wallet injection APIs and public accounts |
| Inscription frame | Fully untrusted | arbitrary HTML, JavaScript, SVG, media, recursive dependencies |
| Providers | Untrusted network services | JSON, binary content, error bodies, redirects, latency |
| Local binaries | Operator-trusted | `bitcoind`, `ord`, arguments, data directories |

Data crossing toward a more trusted zone must be validated, bounded, normalized, and represented as data—not executable markup.

## Wallet-extension risk

Loading an unpacked extension grants that extension the permissions declared in its manifest inside the Wallet Bridge session. Isolation prevents it from becoming an inscription API, but a malicious extension can still misrepresent accounts or signatures, track activity within its partition, or display deceptive approval UI. Distributors should publish tested extension IDs/versions/hashes and users should independently verify wallet releases.

## Inscription risk

On-chain availability is not a safety signal. Inscriptions can contain phishing interfaces, flashing media, resource exhaustion attempts, deceptive addresses, offensive material, remote tracking, or exploit payloads targeting the rendering engine. The browser applies defense in depth, but users should keep Electron current and avoid enabling external-content networking unless necessary.

## Dependency and release security

- Use exact dependency versions and review lockfile changes.
- Build from a clean, protected branch with least-privilege CI tokens.
- Generate an SBOM and dependency audit report.
- Publish SHA-256 checksums and an exact build manifest through the official GitHub release.
- Label unsigned beta downloads explicitly. Signed distribution mode requires verified platform credentials; it must never silently fall back to an unsigned build.
- For signed releases, notarize the macOS application and verify Windows publisher signatures.
- Test the packaged application, not only `npm start`.
- Treat Electron upgrades as security releases when Chromium/Node fixes are included.
- Do not embed RPC passwords, signing keys, analytics secrets, or private update keys in the application.

## Scope exclusions

The browser does not provide wallet seed recovery or general private-key management. Create does provide inscription construction and exact publication through a qualified local Core/Ord connection. It is not marketplace escrow, a consensus client or a malware scanner. Transaction preview is an aid, not a substitute for verification in a trusted signing device and wallet.
