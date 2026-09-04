# codex-with-chatgpt 2.0 Architecture

Status: target architecture; not implemented by PR-01  
Baseline: `a9f91cd98df1bc82686f57d5bc2b2993394c93be` (`v0.1.2` tag, package version `0.1.1`)

## 1. Purpose

V2 preserves the product idea **“ChatGPT thinks. Codex works.”** while replacing the UI-driven control path with an explicit, durable orchestration boundary. ChatGPT plans, reviews, and makes the final judgment. Codex performs execution through Codex App Server. C2C coordinates the two; it does not reimplement the Codex harness.

PR-01 records this contract only. Every component labeled “V2 target” below is future work.

## 2. Baseline and target

### V1 baseline (implemented today)

```text
ChatGPT Web
  |-- MCP data plane --> Cloudflare tunnel --> local C2C bridge --> workspace
  `-- Computer Use control messages <---------------------------> Codex
```

The bridge currently composes workspace access, read-only MCP tools, OAuth and pairing, Cloudflare tunnel management, daemon/admin lifecycle, and file-backed execution/session state. Its existing documentation remains authoritative for V1 behavior: [architecture.md](architecture.md), [security.md](security.md), and [protocol.md](protocol.md).

### V2 target (not implemented in PR-01)

```text
ChatGPT
   |
   v
OpenAI Secure MCP Tunnel
   |
   v
C2C Orchestrator
   |-- Project Registry
   |-- Policy and Approval Router
   |-- Activity State Machine
   |-- Context Projection
   |-- Verification Gate
   |-- Recovery and Audit
   |
   v
Codex App Server
   |-- Implementer thread/worktree
   `-- Independent reviewer thread/worktree
```

## 3. Architectural invariants

1. ChatGPT owns planning, review, and final judgment; Codex owns execution.
2. C2C never becomes a coding harness or a second shell executor.
3. Codex App Server is the primary execution backend.
4. ChatGPT receives high-level task capabilities, not raw shell or raw filesystem-write tools.
5. Workspace content is untrusted data and cannot change policy, approvals, project selection, network access, or sandbox level.
6. Implementer and reviewer use separate Codex threads by default.
7. Deterministic verification precedes LLM review.
8. Model output is never the source of truth for status, changed files, or verification results.
9. Mutations use optimistic concurrency through `expected_revision`.
10. Unknown or unrecoverable state never becomes `DONE`.
11. Secure MCP Tunnel is the default transport; compatibility transports are explicit.
12. No security boundary may be weakened during migration.
13. Silent fallback is forbidden.

## 4. Trust boundaries

| Boundary | Trusted authority | Untrusted input | Enforcement |
| --- | --- | --- | --- |
| ChatGPT to C2C | MCP tool schema and authenticated caller context | prompts and tool arguments | capability-scoped tools, validation, bounded input |
| Project selection | Project Registry | caller-provided `project_id` | registry lookup to a canonical local root; no caller-provided absolute cwd |
| Workspace reads | V1 workspace policy | paths and repository content | canonical realpath containment, ignore rules, size limits |
| Execution | Codex sandbox and approval policy | task text and workspace content | explicit sandbox/network policy and approval routing |
| State transitions | persisted revision and state machine | delayed agent events | transaction plus `expected_revision`; reject with `STALE_REVISION` |
| Acceptance | verification records and repository state | implementer summaries | deterministic checks, independent review, final judgment |

## 5. Component responsibilities

### C2C Orchestrator

The orchestrator owns coordination, not code execution. It creates activities, dispatches Codex jobs, projects App Server events into durable state, routes approval requests, schedules verification and review, and exposes bounded status views.

### Codex App Server adapter

The adapter is a thin integration layer around the maintained App Server protocol. It owns process supervision, protocol/version compatibility, request correlation, streaming event handling, interrupts, and approval responses. Generated protocol types should be used where available. Unsupported protocol versions fail explicitly.

### Project Registry

External callers select a registered `project_id`. The registry resolves it locally to a canonical root and allowed execution profile. Absolute paths are not accepted through the MCP control plane. Registration and administrative changes are local privileged operations.

### Policy and Approval Router

Policy determines allowed sandbox, network, secret, deployment, and external-side-effect capabilities. Approval decisions are explicit records tied to an activity, operation, revision, actor, and expiry. Repository text cannot create or widen an approval.

### Verification Gate

Verification runs project-configured deterministic checks before reviewer judgment. Initial candidates are `git diff --check`, typecheck, and tests. Evidence is collected from actual process results, not a model claim.

### Independent Reviewer

The reviewer receives the goal, success criteria, actual diff, relevant code, and verification evidence in a separate Codex thread. It returns structured findings and an outcome such as `ACCEPTED` or `FIX_REQUIRED`; it does not directly overwrite activity state.

## 6. Domain model

```text
Project
 `-- Activity
      |-- Agent (Implementer)
      |    `-- Job
      |-- Agent (Reviewer)
      |    `-- Job
      |-- Approval
      |-- Evidence
      |-- Review
      `-- Operation / Audit Event
```

- **Project**: registered local workspace identity and policy profile.
- **Activity**: user-visible unit of work and authoritative lifecycle revision.
- **Agent**: an execution or review role bound to a distinct Codex thread.
- **Job**: one dispatch to an agent with protocol identifiers and timestamps.
- **Approval**: a scoped decision for a proposed capability or action.
- **Evidence**: immutable result of a deterministic check or inspected repository fact.
- **Review**: structured independent assessment tied to evidence and a revision.
- **Operation**: idempotency and audit record for externally requested mutations.

## 7. Activity lifecycle and concurrency

```text
INTAKE -> PLANNING -> READY -> DISPATCHED -> EXECUTING
                                             |
                                             v
                                         VERIFYING -> REVIEWING
                                                        |-- FIX_REQUIRED -> EXECUTING
                                                        `-- ACCEPTED -----> DONE

Terminal: DONE | BLOCKED | CANCELLED | FAILED | RECOVERY_REQUIRED
```

Every mutation supplies `expected_revision`. In one SQLite transaction the service checks the current revision, validates the transition, writes state and audit event, and increments the revision. A mismatch returns `STALE_REVISION` with the current revision; it never retries an unsafe mutation implicitly.

Cancellation and approval responses use idempotency keys. Duplicate requests return the recorded outcome. An App Server disconnect places work into a recoverable or `RECOVERY_REQUIRED` state until reconciliation proves the actual result.

## 8. MCP boundary

### Data plane

The data plane remains read-only and preserves the V1 workspace policy:

```text
workspace_info
list_directory
read_file
search_workspace
git_status
git_diff
```

Evidence/status readers may be added, but they expose sanitized persisted records rather than raw arbitrary files.

### Control plane

The target control surface is high-level delegation:

```text
c2c_task_start
c2c_task_get
c2c_task_continue
c2c_task_steer
c2c_task_cancel
c2c_approval_respond
```

The control plane does not expose generic `shell`, `write_file`, unrestricted `git`, or caller-selected cwd parameters.

## 9. Context projection

Status reads support three bounded views:

- `compact`: state, revision, current phase, and required user action.
- `standard`: compact plus changed-file summary, verification status, and review outcome.
- `debug`: bounded diagnostic events and sanitized output references.

`since_revision` avoids replaying unchanged context. When nothing changed, the response is small and explicit, for example:

```json
{"status":"running","revision":31,"unchanged":true}
```

## 10. Durable state

SQLite is the V2 source of truth for Project, Activity, Agent, Job, Approval, Evidence, Review, Operation, and audit-event records. Repositories isolate storage from the domain layer. Migrations are versioned and transactional; WAL mode and backup/recovery behavior are verified before legacy state is removed.

Secrets remain in OS-appropriate protected storage. SQLite placement follows the existing user state-directory convention, outside project trees, with owner-only permissions where the platform supports them.

## 11. Verification evidence

Each check records at least:

- check name and configured command
- exit code and normalized status
- start/end timestamps and duration
- activity revision and repository revision
- sanitized, bounded output reference

Required-check failure prevents review acceptance. Review evidence must correspond to the same repository and activity revision being accepted.

## 12. Transport and compatibility

Secure MCP Tunnel is the default V2 transport because it connects a private/local MCP server without publishing that server directly to the public internet. C2C configures and supervises the official client through a thin adapter; it does not reimplement the tunnel wire protocol.

Cloudflare transport, its OAuth/pairing path, and any Computer Use relay may remain only as explicitly selected compatibility modes. Missing Secure MCP entitlement, unsupported client versions, or startup failures are reported clearly. No automatic downgrade is allowed.

## 13. V1 security semantics that must survive migration

- canonical realpath containment and workspace-root authorization
- rejection of `..`, absolute-path, null-byte, backslash, and symlink escapes
- sensitive-file deny rules with `.env.example` exception
- additive `.c2cignore` policy
- secret exclusion from reads, listings, search, and every git-diff mode, including renames
- bounded reads, searches, diffs, and outputs
- private-key rejection and credential/home-path redaction in execution output
- loopback-only local listeners and authenticated remote access
- per-workspace identity and authorization boundaries
- OS user-state placement with `0700` directories and `0600` files where supported
- secret-redacting logs

Security regression is a release blocker. Replacement code must have equivalent or stronger tests before the V1 path is removed.

## 14. Failure and fallback policy

- Unsupported App Server protocol: fail with a compatibility error.
- Secure MCP Tunnel unavailable: report the prerequisite; require explicit compatibility-mode selection.
- Unknown job after restart: reconcile from protocol and durable records or enter `RECOVERY_REQUIRED`.
- Verification evidence missing/stale: do not review or mark `DONE`.
- Stale mutation: return `STALE_REVISION`; do not silently replay it.

## 15. References

- OpenAI, [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/) (App Server as the first-class integration method).
- OpenAI Help Center, [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta) (Secure MCP Tunnel for private/local MCP servers; availability is product/workspace dependent).
- V1 repository documents: [architecture.md](architecture.md), [security.md](security.md), [protocol.md](protocol.md).
