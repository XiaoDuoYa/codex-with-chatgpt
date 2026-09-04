# AGENTS.md

## V2 invariants

- ChatGPT thinks; Codex works.
- Codex App Server is the primary execution backend.
- Secure MCP Tunnel is the default transport.
- Computer Use is outside core execution.
- Project Registry hides raw cwd details from higher layers.
- Durable state uses SQLite.
- Workspace security semantics from V1 remain intact.
- Silent fallback is forbidden.

## PR-01 rule

PR-01 is documentation-only. Do not change runtime behavior, APIs, dependencies, or source layout.
