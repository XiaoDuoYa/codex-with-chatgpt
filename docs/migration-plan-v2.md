# codex-with-chatgpt 2.0 Migration Plan

Baseline: `a9f91cd98df1bc82686f57d5bc2b2993394c93be`

## Goal

Move from the current bridge-centered implementation to a Codex App Server-first architecture without changing baseline behavior in PR-01.

## Scope of PR-01

This pull request is documentation-only:

- no runtime behavior changes
- no API changes
- no dependency changes
- no file moves for source code

## Planned epics

### Epic 1: Architecture contract

- define the V2 architectural boundary
- document what stays in core and what moves out
- preserve current workspace security semantics

### Epic 2: Project Registry

- derive workspace identity from registry metadata
- avoid exposing raw cwd details to higher layers
- keep workspace-to-execution mapping explicit

### Epic 3: Durable state

- move long-lived session and coordination state to SQLite
- keep secrets and workspace binding outside the project tree
- preserve owner-only permissions

### Epic 4: Execution split

- separate planning/review from execution
- keep Codex App Server as the primary execution path
- keep deterministic verification before review

### Epic 5: Transport and compatibility

- make Secure MCP Tunnel the default transport
- keep any legacy compatibility paths isolated from core
- forbid silent fallback between transports

## Non-goals for PR-01

- no code migration
- no CLI changes
- no auth/runtime refactor
- no test expectation updates beyond verification runs

## Acceptance bar

- baseline tests still pass
- build and typecheck still pass
- docs clearly distinguish current state from future state
- no runtime diff is introduced
