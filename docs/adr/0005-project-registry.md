# ADR 0005: Resolve workspaces through a Project Registry

- Status: Accepted
- Date: 2026-09-05

## Context

An external model-supplied absolute cwd would expose host layout and turn project selection into an unsafe capability. V1 already has strong canonical workspace containment, but V2 needs durable mapping between orchestration state and local workspaces.

## Decision

Introduce a local Project Registry. Remote/control-plane requests provide an opaque `project_id`; the registry resolves it to a canonical local root and allowed profile. Registration and root changes occur only through a local privileged administration path. Higher layers never accept arbitrary cwd.

## Consequences

- Host paths are absent from normal external task requests and responses.
- Unknown, moved, duplicated, or cross-project mappings fail explicitly.
- Registry resolution reuses V1 realpath containment and security rules.
- Project identity becomes stable input to activities, policies, evidence, and audit records.

## Alternatives considered

- **Accept cwd with validation:** rejected because it still exposes host paths and lets callers attempt project selection.
- **Use process cwd implicitly:** rejected because it is ambiguous across daemon, restart, and multi-project operation.

## PR-01 note

No registry or workspace API is implemented in PR-01.
