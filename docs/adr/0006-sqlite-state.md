# ADR 0006: Use SQLite for durable orchestration state

- Status: Accepted
- Date: 2026-09-05

## Context

V1 stores runtime, endpoint, tunnel, auth, execution, and session information in separate files. V2 adds concurrent activities, revisions, approvals, evidence, reviews, idempotent operations, and crash recovery. These records need atomic multi-record transitions and queryable history.

## Decision

Use SQLite as the source of truth for V2 Project, Activity, Agent, Job, Approval, Evidence, Review, Operation, and audit-event records. Access it through repository interfaces so the domain does not depend on a driver. Use versioned transactional migrations, WAL mode after validation, backup/restore tests, and the existing OS user-state location and permissions.

## Consequences

- State transitions and revision increments can commit atomically.
- Recovery can distinguish incomplete, stale, and terminal work.
- Migration and schema compatibility become release-gated responsibilities.
- Secrets remain in appropriate protected storage; SQLite adoption is not permission to centralize credentials in plaintext.

## Alternatives considered

- **Continue independent JSON/JSONL files:** rejected because cross-record atomicity and concurrency would be reimplemented poorly.
- **External database service:** rejected for the local-first default because it adds deployment and trust dependencies.

## PR-01 note

PR-01 adds no database package, schema, or state migration.
