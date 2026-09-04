# ADR 0001: Fork and migrate instead of rewriting

- Status: Accepted
- Date: 2026-09-05
- Baseline: `a9f91cd98df1bc82686f57d5bc2b2993394c93be`

## Context

V1 already has a working bridge and extensively tested workspace protections: canonical containment, symlink and traversal rejection, sensitive-file filtering, bounded reads/search/diffs, output sanitization, secure state permissions, and secret-redacting logs. A clean rewrite would discard those tested boundaries and combine product migration with security reimplementation.

## Decision

Build V2 as a fork of the named baseline and migrate behind explicit seams in small PRs. Keep main-equivalent behavior available until each replacement has parity, migration, and failure-path coverage. Delete legacy code only after its replacement is proven.

## Consequences

- Existing workspace security behavior is the minimum acceptance bar.
- Temporary duplication is acceptable when it makes rollback and comparison possible.
- Each PR must state which path is authoritative and how to return to the prior path.
- Source moves and cleanup happen after, not before, replacement verification.

## Alternatives considered

- **Clean rewrite:** rejected because it increases regression risk and delays usable checkpoints.
- **Permanent V1 extension:** rejected because bridge, UI control, and file-state concerns need clearer boundaries.

## PR-01 note

This ADR changes no runtime behavior. The migration sequence is defined in [../migration-plan-v2.md](../migration-plan-v2.md).
