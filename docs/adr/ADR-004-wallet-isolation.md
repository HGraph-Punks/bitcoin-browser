# ADR-004: Host wallets in a separate persistent partition

Status: Accepted

## Context

Injected wallets are designed for web origins, while inscription content is arbitrary untrusted web content. Loading extensions into the main browsing session could grant inscriptions wallet authority.

## Decision

Load wallet extensions only in `persist:satoshi-browser-wallet` and only on the Wallet Bridge app page. Return bounded public state and command results through a dedicated coordinator. Keep the main browser in `persist:satoshi-browser-app` with no wallet injection.

## Consequences

- Inscription content cannot invoke extension APIs by origin.
- Wallet workflows require a separate visible surface.
- Extension compatibility must be adapted/tested.
- A malicious wallet remains dangerous within its own trust role, but does not become an inscription API.
