# Optional Bitcoin donations

About and Sponsors share one local donation card for **Turtle Moon · Bitcoin Browser development**. Nothing is requested on startup and donation is never a prerequisite for browsing. The full public destination is:

```text
1NrPJqSjJ6edVExCQrRv5e7sY367jbiyem
```

The owner supplied this address in `donation-ledger-btc.md` and the QR in `Screen Shot 2026-09-05 at 12.35.54 AM.png` on 2026-09-21. The mainnet P2PKH/Base58Check checksum passes. The native macOS Core Image QR detector independently decoded the image to exactly that address. Its unchanged 418 × 418, 17,603-byte copy is bundled at `src/renderer/assets/donation-qr.png`. This verifies consistency and address validity, not the team's possession of a private key; no key, wallet or balance was inspected.

## User flow and boundaries

- **Copy address** copies only the exact case-sensitive address through the existing clipboard helper. It reports success only when that helper confirms it. Failures leave the full selectable address and QR available.
- **Open in wallet** passes only `bitcoin:1NrPJqSjJ6edVExCQrRv5e7sY367jbiyem` to existing main-process external-opening IPC. Its Cancel-default native dialog displays the exact URI. Approval requests the operating system's registered wallet handler; users choose an amount, review the address/fee and confirm in their own wallet. No handler/cancellation errors navigate away from the donation card.
- **Scan the QR** uses the supplied address-only code in a phone or other Bitcoin wallet. Its black-on-white image and quiet zone remain unchanged across app themes, with no network-based generator or analytics.

The address-only URI is supported by the [Bitcoin URI specification, BIP 321](https://github.com/bitcoin/bips/blob/master/bip-0321.mediawiki), which replaces BIP 21 and preserves compatibility with its basic address form. No amount, external payment URL, payment callback, Lightning invoice or tracking parameter is included. No native Bitcoin handler is installed or replaced by this application. A successful handoff is explicitly **not** a payment confirmation.

The card always labels **Bitcoin · mainnet**, independently of the network being browsed. It explicitly says on-chain BTC, not Lightning, and reminds users to review the address/fee and not spend inscriptions or Runes. Donation addresses must never come from AI/model output, provider responses, runtime settings or connected wallets. `src/shared/donation.js` is the shared immutable recipient configuration.

There is no transaction construction, fee selection, PSBT, signing, broadcast, extension wallet connection, credential access, balance lookup, donation history, receipt or automatic payment. No new runtime dependencies, IPC channels, protocol permissions or CSP exceptions are needed. Loading About/Sponsors only reads bundled assets. User-triggered wallet opening retains existing consent; accepting it brings the external wallet under that wallet's own behavior and privacy settings.

## Verification and maintenance

`tests/donation.test.js` checks the owner-file match, address checksum, URI contents, unchanged bounded QR bytes, local protocol delivery, passive rendering, explicit actions, duplicate-click guards, honest success/failure feedback, QR failure fallback, stale feedback ordering and accessible styling. About/Sponsors integration and main-process IPC tests cover the shared card, exact destination and confirmation-before-handoff boundary. These deterministic checks use collaborators, not a real payment or funded wallet. Donation checks are included in `npm run security:beta`.

When replacing the address, update the owner source, immutable configuration and matching QR together; independently decode the new QR before shipping. Re-run the checksum/byte tests, actual packaged image-decoding and narrow/dark/light layout checks. Visually check the full address and scanability at displayed size. Never regenerate a financial QR with image-generation software or accept a QR whose decoded destination differs from the displayed/copy/wallet destination.

Native Windows/Linux wallet-handler behavior and a real user-approved wallet payment remain separate manual checks. Automated and visual reviews must not send funds or assert that a wallet request resulted in a donation. Broader beta release/signing gates are unaffected.

The 2026-09-21 packaged macOS arm64 review passed in a fresh disposable profile: About/Sponsors at 1280, 740 and 370 CSS pixels in both themes, complete address display, a white 168-pixel QR and 44-pixel action targets. Screenshots were visually reviewed, and native Core Image decoded a captured on-screen QR to the same address. Synthetic clipboard success/failure checks exercised the actual UI without reading or altering the real clipboard. The owned test app exited cleanly; no real wallet was opened or payment attempted. See [implementation status](IMPLEMENTATION_STATUS.md) for counts, evidence and the reopened local test app.
