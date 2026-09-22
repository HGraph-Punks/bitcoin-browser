# ADR-003: Use an application-local ord:// transport

Status: Accepted

## Context

Recursive inscription content expects same-context `/content/*` and `/r/*` access. The browser needs source selection, caching, offline reads, ranges, and policy enforcement before bytes reach content.

## Decision

Register `ord://` as a privileged application protocol on the browser session. Normalize requests to safe ord paths and resolve through RecursiveResolver. Represent inscription content as `ord://content/<id>`.

## Consequences

- Recursive requests share one bounded data plane.
- The scheme is explicitly local application behavior, not a Bitcoin consensus rule.
- Relative-reference compatibility requires ongoing fixture testing.
- CSP and iframe sandbox remain separate defenses.
