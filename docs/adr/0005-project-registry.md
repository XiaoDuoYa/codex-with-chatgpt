# ADR 0005: Project Registry Hides cwd

Status: accepted

## Context

Current workspace identity is derived from the local root and persisted state.

## Decision

V2 introduces a Project Registry layer that owns workspace identity and hides raw cwd details from higher layers.

## Consequences

- workspace mapping becomes explicit
- raw local paths stop leaking into control logic
- project selection can be reasoned about without depending on the caller's process cwd
