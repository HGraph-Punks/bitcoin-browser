# ADR-005: Do not import or custody private keys

Status: Accepted

## Context

Key custody would greatly increase attack surface, backup obligations, regulatory/security expectations, and consequences of renderer/main compromise.

## Decision

Satoshi Browser stores only approved public account descriptors. Signing is delegated to external wallet providers after native and wallet confirmation. Hardware devices are mediated by wallets.

## Consequences

- The application is not a standalone wallet.
- Users need a compatible wallet for signing.
- Key exfiltration risk is substantially reduced.
- Transaction preview must be independent and conservative.
