# ADR 0006: SQLite for Durable State

Status: accepted

## Context

The current implementation stores runtime, auth, tunnel, and session state as JSON files in the user state directory.

## Decision

V2 uses SQLite for durable state.

## Consequences

- coordination state becomes transactional
- workspace binding remains outside the project tree
- file-based state can remain as legacy compatibility only if isolated from core
