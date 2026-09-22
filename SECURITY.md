# Security policy

## Supported release

Security fixes target the latest tagged release candidate or stable release on the default branch. A distributor should publish its own support window and signed-advisory process.

## Reporting a vulnerability

Do not publish a working exploit or sensitive user data in a public issue. Contact the repository security owner through the private security-advisory channel configured for the deployed repository. Include:

- affected version and operating system;
- preconditions and threat actor capability;
- exact reproduction steps or a minimal proof of concept;
- impact on keys, signatures, provider credentials, local files, privacy, or code execution;
- whether the issue crosses the inscription, wallet, IPC, protocol, provider, or managed-process boundary; and
- suggested mitigations when available.

A production fork must replace this generic policy with a monitored security contact before distribution.

## Non-negotiable invariants

Changes must not weaken these controls:

1. The trusted application shell uses Node integration off, context isolation on, sandboxing on, web security on, and no insecure mixed content.
2. The application session denies permission requests and checks.
3. Popups and `<webview>` are denied.
4. IPC handlers reject senders outside `app://app/renderer/`.
5. Inscription content receives no preload and runs in an opaque sandbox without same-origin, popup, top-navigation, download, or wallet privileges.
6. The browser and Wallet Bridge use separate persistent partitions.
7. Wallet extensions never load into the browser partition.
8. Private keys and seed phrases are not imported, generated, or persisted.
9. Every signing action originates in the trusted shell, receives native review, then receives the wallet's own review.
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
- Sign installers and publish SHA-256 checksums through an authenticated channel.
- Notarize macOS builds and verify Windows signatures on a clean machine.
- Test the packaged application, not only `npm start`.
- Treat Electron upgrades as security releases when Chromium/Node fixes are included.
- Do not embed RPC passwords, signing keys, analytics secrets, or private update keys in the application.

## Scope exclusions

This repository is not a wallet, key manager, minting service, marketplace escrow, consensus client, or malware scanner. Transaction preview is an aid, not a substitute for verification in a trusted signing device and wallet.
