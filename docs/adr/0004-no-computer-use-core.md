# ADR 0004: Computer Use Stays Out of Core

Status: accepted

## Context

The current codebase keeps execution and transport logic in the local bridge and state files.

## Decision

Computer Use is not part of core execution in V2.

## Consequences

- the core stays deterministic and server-shaped
- control-plane actions remain separate from execution
- no fallback path may quietly inject Computer Use into core behavior
