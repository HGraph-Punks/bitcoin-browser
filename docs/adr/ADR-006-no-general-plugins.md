# ADR-006: Defer general in-process plugins

Status: Accepted for v1

## Context

The product needs extensibility, but arbitrary renderer/main plugins could bypass provider normalization, content sandboxing, IPC validation, secrets, and wallet separation.

## Decision

Support source adapters compiled into the reviewed application. Defer general plugins until a signed declarative/out-of-process capability model exists.

## Consequences

- Initial third-party extensibility is narrower.
- Security invariants remain understandable.
- Future provider subprocesses can use a versioned local RPC contract.
- Difficult functionality is not removed; it is implemented in reviewed modules until a safe plugin model exists.
