# codex-with-chatgpt 2.0 Architecture

Baseline: `a9f91cd98df1bc82686f57d5bc2b2993394c93be`

## 現状

The current codebase is a single local bridge that composes:

- workspace discovery and containment
- OAuth / pairing / token storage
- MCP read endpoints
- tunnel provisioning
- admin / daemon lifecycle
- execution record persistence

The implementation is intentionally conservative about workspace security:

- the bridge binds to loopback only
- public exposure goes through the tunnel
- tokens are bound to a workspace
- workspace content is treated as untrusted
- state is stored under the user state directory, not the project

## 将来

V2 keeps the same security boundary but re-centers the system around three explicit roles:

1. ChatGPT plans, reviews, and decides.
2. Codex App Server executes.
3. The orchestrator mediates project registry, policy, approvals, verification, and recovery.

Target shape:

```text
ChatGPT
  -> Secure MCP Tunnel
  -> C2C Orchestrator
  -> Codex App Server
```

The orchestrator is the control layer. It should not become a new coding harness or a second execution backend.

## 不変条件

- ChatGPT thinks; Codex works.
- Codex App Server is the primary execution backend.
- Secure MCP Tunnel is the default transport.
- Computer Use stays outside core execution.
- Project Registry hides cwd details from higher layers.
- Workspace security semantics are preserved.
- Silent fallback is forbidden.
- Unknown or unrecoverable state must not be marked successful.
- Deterministic verification happens before LLM judgment.

## Design notes

- V2 documentation describes intent only.
- V2 docs must not be read as a claim that baseline behavior has already changed.
- If a file is listed as part of V2 planning, that is a migration target, not a current code path.
