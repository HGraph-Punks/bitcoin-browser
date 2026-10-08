# ADR-005: Keep wallet keys outside the application

Status: Accepted; extended for Create in 0.2.0-rc.3

## Decision

Bitcoin Browser does not import, generate, export or recover a user's wallet seed or general wallet private keys. The Wallet Bridge remains isolated, and packaged bridge signing remains disabled in this candidate.

Create can construct inscriptions through an explicitly selected local Bitcoin Core 31.1.0 / Ord 0.29.0 wallet. The owner reviews each frozen transaction plan in the trusted Create UI before the local signer is invoked. Scoped MCP tools can plan and request review, but cannot approve spending.

Inscription construction necessarily creates transaction-specific reveal material. The deployment vault retains its ephemeral reveal key, recovery descriptors and exact transaction package as authenticated encrypted records, protected by an OS-encrypted vault key. This is a deliberate extension of the original public-account-only storage model. It supports resuming an interrupted approved inscription; it does not introduce general wallet recovery.

## Consequences

- Wallet seeds and funding keys stay in the selected external wallet/Core.
- Create's transaction vault and native owner-review boundary are additional security assets.
- Missing or unavailable OS secure storage stops publication while source authoring remains available.
- Importing a Builder workspace copies project source and history; it does not copy deployment vaults, wallet material, node credentials or AI tokens.
- A public release needs separate mainnet execution qualification and retained library/source license review.

See [the migration architecture](../CREATOR_MIGRATION.md) and [qualification evidence](../CREATOR_BUILD.md).
