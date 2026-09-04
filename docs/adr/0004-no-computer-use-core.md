# ADR 0004: Keep Computer Use outside the core protocol

- Status: Accepted
- Date: 2026-09-05

## Context

V1 uses Computer Use for small control-plane messages between Codex and ChatGPT. UI automation couples correctness to page state and UI behavior, and it is difficult to reconcile deterministically after interruption. V2 needs an auditable server-shaped control plane.

## Decision

Computer Use is not part of V2 core execution or orchestration. Core control uses high-level MCP task operations backed by durable activity state and Codex App Server events. A UI relay may exist only as an isolated, explicitly selected compatibility feature.

## Consequences

- Core state transitions no longer depend on browser observations.
- Every mutation can be validated, revision-checked, persisted, and audited.
- Compatibility UI failures cannot change core policy or completion state.
- There is no silent injection of Computer Use when a control-plane capability is unavailable.

## Alternatives considered

- **Harden the UI protocol as core:** rejected because it cannot provide the same deterministic lifecycle boundary.
- **Remove all compatibility support immediately:** rejected; fork migration requires staged parity and rollback.

## PR-01 note

The existing V1 Computer Use workflow remains unchanged in PR-01.
