# ADR 0002: Codex App Server Is Primary

Status: accepted

## Context

The current repository centers on a local bridge that exposes workspace services through MCP and tunnel plumbing.

## Decision

Codex App Server becomes the primary execution backend in V2.

## Consequences

- planning and review stay outside execution
- the orchestrator does not become a second harness
- execution semantics remain auditable and workspace-bound
