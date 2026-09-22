# ADR-002: Normalize data behind capability-based providers

Status: Accepted

## Context

ord, Bitcoin Core, public explorers, and self-hosted APIs expose different routes and shapes. Coupling the UI to one provider would recreate a website wrapper and undermine local operation.

## Decision

Canonical targets map to capabilities. ProviderManager selects compatible adapters. Adapters return a versioned normalized entity plus bounded raw data and provenance.

## Consequences

- Tabs/bookmarks survive provider changes.
- Fallback is observable.
- Adapter maintenance absorbs external API churn.
- Some provider-specific detail remains only in raw data until normalization evolves.
