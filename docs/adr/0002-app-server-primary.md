# ADR 0002: Use Codex App Server as the primary execution backend

- Status: Accepted
- Date: 2026-09-05

## Context

C2C needs Codex-native thread, turn, event, diff, interrupt, and approval semantics. Implementing those semantics in the bridge would create another coding harness. OpenAI describes Codex App Server as the first-class integration method maintained for rich Codex integrations.

## Decision

V2 executes coding work through Codex App Server. C2C adds a thin versioned adapter and supervisor; it does not reproduce the agent loop. App Server events are projected into C2C's durable domain state, and C2C's state is never inferred solely from model prose.

## Consequences

- Protocol/version compatibility becomes an explicit integration concern.
- Startup, streaming, approval, interrupt, crash, and restart behavior require contract tests.
- Unsupported versions fail before dispatch; there is no silent switch to another executor.
- `codex mcp-server` may be evaluated for bounded compatibility cases but is not the primary V2 backend.

## Alternatives considered

- **Reimplement an agent loop:** rejected because C2C must not become a coding harness.
- **Use only MCP server invocation:** not selected as primary because the required lifecycle is richer than a simple tool call.

## Reference

- OpenAI, [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/).

## PR-01 note

No App Server dependency or code is introduced in PR-01.
