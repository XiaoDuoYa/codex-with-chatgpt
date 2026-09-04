# codex-with-chatgpt 2.0 Migration Plan

Status: planned sequence; only PR-01 is implemented  
Baseline: `a9f91cd98df1bc82686f57d5bc2b2993394c93be`

## 1. Migration rules

- Keep main-equivalent behavior working until each replacement is complete and verified.
- Preserve or strengthen every security semantic listed in [architecture-v2.md](architecture-v2.md).
- Use one reviewable PR per step; do not bundle later steps into an earlier PR.
- Run deterministic checks before independent review.
- Remove legacy code only after its replacement passes migration and failure-injection tests.
- Never silently fall back between execution backends, transports, policy profiles, or storage layers.

## 2. Source disposition summary

### Keep as security foundations

`src/config/paths.ts`, `src/execution/sanitize.ts`, `src/mcp/http.ts`, `src/workspace/git.ts`, `src/workspace/ignore.ts`, and `src/workspace/search.ts` retain their responsibilities, subject only to narrowly scoped integration changes.

### Modify or move during staged replacement

The current `auth/`, `bridge/`, `cli/`, `tunnel/`, `pairing/`, `process/`, `logger/`, `mcp/server.ts`, `workspace/manager.ts`, `execution/output.ts`, `config/endpoint.ts`, and `version.ts` modules contain reusable behavior but will move behind V2 boundaries or compatibility packages.

### Delete only after replacement

`src/config/sandbox-allow.ts`, `src/config/ui-prefs.ts`, `src/execution/records.ts`, and `src/session/state.ts` are legacy responsibilities. They must remain until their V2 replacements are live, migrated, and covered by tests.

## 3. Epic A — Foundation and seams

### PR-01: Fork baseline and architecture decisions (this PR)

Issues:

- verify fork baseline is exactly `a9f91cd98df1bc82686f57d5bc2b2993394c93be`
- record pre-change build, typecheck, and test results
- add V2 architecture, this migration plan, six ADRs, and concise repository invariants
- prove the diff changes no runtime, API, dependency, or test behavior

Exit criteria:

- build and typecheck pass
- the complete baseline test suite passes
- only `AGENTS.md` and the requested V2/ADR documents are changed
- PR-02 work has not started

### PR-02: Split the CLI

Issues:

- turn `src/cli/index.ts` into a thin bootstrap
- extract command modules without changing flags, JSON output, or exit behavior
- add CLI parity tests for existing commands

Exit criteria: V1 command contract is unchanged and all existing tests pass.

### PR-03: Stabilize the TransportProvider seam

Issues:

- separate transport lifecycle from Cloudflare-specific provisioning
- define explicit start/stop/status/doctor results and error taxonomy
- remove implicit provider downgrade behavior

Exit criteria: current Cloudflare modes pass parity tests through the provider interface; fallback decisions are explicit.

### PR-04: Isolate Cloudflare and legacy auth

Issues:

- move Cloudflare provisioning, OAuth, pairing, and public-endpoint concerns under a compatibility boundary
- remove core bridge dependencies on compatibility auth
- retain V1 behavior behind an explicit compatibility configuration

Exit criteria: compatibility E2E passes and core modules have no inward dependency on the compatibility package.

## 4. Epic B — Official execution and transport integrations

### PR-05: Add the Secure MCP Tunnel adapter

Issues:

- detect and validate official tunnel-client availability and entitlement prerequisites
- implement configure/start/stop/status/doctor as a thin adapter
- surface typed failures; require explicit opt-in for compatibility transport

Exit criteria: local integration tests cover healthy, unavailable, incompatible, and interrupted tunnel states with no silent Cloudflare fallback.

### PR-06: Introduce generated App Server protocol types

Issues:

- pin a tested Codex/App Server compatibility range
- generate or vendor protocol types with provenance
- add fixtures for initialization, thread, turn, item, approval, and error events

Exit criteria: protocol fixtures validate in CI and unsupported versions fail before task dispatch.

### PR-07: Build the App Server client and supervisor

Issues:

- implement process startup, JSON-RPC correlation, event streaming, interrupt, and shutdown
- project protocol events into typed internal events
- handle crash, disconnect, timeout, and restart without reporting false completion

Exit criteria: lifecycle and failure-injection tests pass; Codex App Server is usable behind an internal backend interface.

## 5. Epic C — Durable domain and project boundary

### PR-08: Add SQLite and the domain model

Issues:

- define Project, Activity, Agent, Job, Approval, Evidence, Review, Operation, and audit-event records
- add versioned transactional migrations and repository interfaces
- configure user-state placement, owner-only permissions, WAL, backup, and recovery checks

Exit criteria: migration/repository tests pass, partial transactions roll back, and secrets are not stored in project trees.

### PR-09: Add Project Registry

Issues:

- register canonical workspace roots through a local privileged path
- expose opaque `project_id` to higher layers instead of absolute cwd
- reuse V1 realpath containment and workspace identity semantics

Exit criteria: traversal, symlink, duplicate-root, moved-root, unknown-project, and cross-project tests pass; control tools accept no arbitrary cwd.

### PR-10: Add the activity state machine and revisions

Issues:

- implement legal transitions and terminal states
- require `expected_revision` on every mutation
- add idempotency, cancellation, and restart reconciliation

Exit criteria: transition-table, concurrency, duplicate-request, stale-event, and recovery tests pass; mismatches return `STALE_REVISION`.

## 6. Epic D — Bounded MCP orchestration

### PR-11: Split MCP data and control planes

Issues:

- preserve read-only workspace tools behind the V1 security policy
- add high-level task/approval tools only
- validate caller scope, project identity, input size, and mutation revision

Exit criteria: MCP schemas and authorization tests pass; no raw shell, generic write, unrestricted git, or cwd input exists.

### PR-12: Add context projections

Issues:

- implement `compact`, `standard`, and bounded `debug` views
- support `since_revision` and explicit unchanged responses
- sanitize and cap event/evidence output

Exit criteria: snapshot, redaction, size-limit, and unchanged-response tests pass; normal polling does not replay full history.

## 7. Epic E — Verification, review, and policy

### PR-13: Add deterministic verification

Issues:

- detect project check commands with explicit configuration precedence
- run required checks in the Codex/workspace boundary
- persist exit code, status, duration, timestamp, repository revision, and sanitized output references

Exit criteria: required failures block acceptance; stale or missing evidence cannot be attached to a newer revision.

### PR-14: Add independent reviewer orchestration

Issues:

- create a reviewer in a distinct Codex thread/worktree by default
- supply goal, success criteria, actual diff, relevant code, and verification evidence
- resolve `ACCEPTED` and `FIX_REQUIRED` without trusting implementer summaries

Exit criteria: independence and evidence-binding tests pass; fix loops are bounded and auditable.

### PR-15: Add capability policy and approvals

Issues:

- model sandbox, network, secrets, deployment, git push, and production side effects separately
- route approvals with actor, scope, expiry, revision, and idempotency
- ensure workspace content cannot create or widen capability grants

Exit criteria: deny/default, approval replay, expiry, cross-project, prompt-injection, and escalation tests pass.

## 8. Epic F — Recovery, cleanup, and release

### PR-16: Add recovery and failure injection

Issues:

- reconcile bridge, App Server, tunnel, database, and repository observations after restart
- inject crashes at dispatch, execution, evidence write, review, and transition boundaries
- map unresolved ambiguity to `RECOVERY_REQUIRED`

Exit criteria: crash matrix passes with no false `DONE`, lost approval, or duplicated side effect.

### PR-17: Migrate state and remove legacy core paths

Issues:

- import supported V1 metadata with backup, validation, and rollback
- delete manual execution records, UI preferences, and sandbox-state writable-root requirements only after replacement
- keep Cloudflare/auth/Computer Use in an explicit compatibility package if still supported

Exit criteria: migration is repeatable and reversible; replacement coverage is green; core dependency checks confirm legacy isolation.

### PR-18: Beta E2E and release gate

Issues:

- run supported ChatGPT/Secure MCP/Codex App Server E2E profiles
- verify read-only and full-control capability profiles where product availability permits
- publish compatibility matrix, migration guide, threat model, operational runbook, and known limitations

Exit criteria: all required security, recovery, version-compatibility, and E2E gates pass; unsupported availability is documented rather than hidden by fallback.

## 9. PR-01 verification record

Fill this section from the final PR-01 run:

| Check | Baseline | PR-01 head |
| --- | --- | --- |
| build | pass | pass |
| typecheck | pass | pass |
| test | 15 files / 164 tests pass | 15 files / 164 tests pass |

PR-02 readiness is a release-manager judgment after PR-01 review. This document does not authorize starting PR-02.
