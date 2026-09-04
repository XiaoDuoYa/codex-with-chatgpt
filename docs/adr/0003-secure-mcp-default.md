# ADR 0003: Secure MCP Tunnel by Default

Status: accepted

## Context

The current implementation already treats public exposure as a tunnel-mediated path, with loopback-only bridge binding.

## Decision

Secure MCP Tunnel is the default transport for V2.

## Consequences

- public transport remains explicit
- loopback-only local services stay private
- compatibility transport paths, if any, stay outside core
