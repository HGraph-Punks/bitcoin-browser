# ADR-001: Use Electron for the desktop shell

Status: Accepted for v1

## Context

The product must host rich HTML/JavaScript inscription content, apply Chromium sandbox controls, run cross-platform, and connect injected browser-extension wallets in a partition isolated from browsing content.

## Decision

Use Electron with a main process, trusted sandboxed renderer, separate sandboxed Wallet Bridge renderer/session, and nested opaque inscription iframe.

## Consequences

- Mature Chromium behavior and extension loading are available.
- Security requires prompt Electron upgrades and strict settings/fuses.
- Runtime size is larger than lightweight native-webview frameworks.
- Renderer/main boundaries must be continuously tested.
- A future native shell migration would preserve navigation/provider/resolver contracts, not Electron-specific window code.
