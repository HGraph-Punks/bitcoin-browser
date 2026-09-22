# Bitcoin Browser — early beta candidate

**Maintainer: review this draft before publication.** A green workflow is not confirmation that every real wallet, installation format or native beta blocker has been qualified. Keep this release a draft until applicable blockers and the checklist below are resolved.

This beta supports browsing Bitcoin, inscriptions and Runes, configurable data sources, guided local-node setup, and an isolated connection-only Wallet Bridge. No node is required to start browsing. Data availability and privacy depend on the configured providers. Some managed Core/Ord downloads and local-service tests are not available on every architecture.

## Wallet precautions

- Use an empty test wallet and no valuable funds. Install extensions only from verified wallet publishers.
- Bitcoin Browser never asks you to import a seed phrase or private key. Do not enter either into the application.
- Wallet discovery, public-account connection and disconnect are the beta scope. PSBT and message signing are disabled in packaged builds.
- Automated fixture tests do not certify arbitrary wallet extensions. List only exact wallet versions that have completed manual acceptance; otherwise state that real-wallet compatibility is not yet qualified.

## Maintainer publication checklist

- [ ] Every attached OS/architecture passed the source, dependency, signing where applicable, native packaged smoke and shutdown gates for this exact tag.
- [ ] The opening signing disclosure matches every attached download. Record the exact expected certificate publisher for signed Mac/Windows apps. Keep the **UNSIGNED BETA — no verified publisher** warning and `-unsigned` filenames if the Windows exception was selected; never imply those files are signed by Turtle Moon Command Center.
- [ ] Each advertised installer/archive passed clean-user install, launch, quit/reopen, deep-link and uninstall/data-preservation checks.
- [ ] Advertised real-wallet versions passed the connection-only manual matrix without funded wallets or credential inspection.
- [ ] Existing native startup/shutdown and other applicable beta blockers in the repository's requirements matrix are resolved or the release remains a draft.
- [ ] Record tested operating systems and wallet versions, remaining limitations, rollback/recovery advice, and the finalized support/security-reporting destination below. Do not publish placeholder contact details.
- [ ] Final release ownership and trusted-distribution requirements have been reviewed. Legal entity: Turtle Moon Command Center; public brand: Turtle Moon. Checksum generation remains deferred; About details were added separately.

## Compatibility and known issues

Maintainer must replace this paragraph with the actual tested OS/wallet version matrix and current known issues. Do not infer that buildable targets, synthetic fixture passes, or a successful unpacked smoke run prove installer, full-node, or real-wallet compatibility.

## Feedback and recovery

Maintainer must add the finalized feedback/security-reporting destination and previous-version recovery instructions. Bug reports should contain app/OS version, reproduction steps and redacted diagnostics—not seeds, keys, wallet files, authentication cookies or provider credentials. Back up your application profile before switching beta versions; do not delete node data as a troubleshooting shortcut.
