# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │ browser control messages
              MCP reads │          │ RESEARCH / INIT / EXECUTED (< 1 KB)
      + progress/result submit     │
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │ MCP + OAuth/Pairing │
             │   Tunnel Manager    │
             └──────┬────────┬─────┘
          read-only │        │ bounded advisory result
                   ▼        ▼
       ┌────────────────┐  ┌─────────────────────┐
       │Local Workspace │  │Local Control Mailbox│
       └───────▲────────┘  └──────────▲──────────┘
               │                      │ read / acknowledge
               │ edit / shell / git   │
               └──────────┬───────────┘
                    ┌─────┴───────┐
                    │Codex Harness│
                    └─────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Browser UI = outbound control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Local mailbox = return plane**: ChatGPT reports bounded forward-only
  progress and submits a one-shot, schema-bound advisory result; Codex reads
  both locally instead of scraping page text.
- **Capability separation**: ChatGPT cannot write the workspace or run commands.
  Its only write capabilities target C2C progress/result state and require both
  a dedicated OAuth scope and an active, expiring request id.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.
- **Local session is the concurrency boundary**: one Project is shared by the
  workspace, while each local Codex session owns its chat URL, checkpoint, and
  mailbox requests.

## Work allocation and model boundary

ChatGPT performs repository discovery through MCP, architecture/debug analysis,
planning, review, and web research that needs browsing or waiting. Research that
materially affects a decision uses its own request and returns conclusions,
source URLs, publication dates, key evidence, and open questions before
planning begins. Codex keeps the local
harness: exact conversation routing, request correlation, edits, commands,
tests, git, recovery, and final verification.

C2C does not control the model assigned to the current Codex task. A user or
host may choose a low-cost local model to apply ChatGPT's structured guidance,
but the Skill cannot switch models and never reports that it did. This keeps
cost policy outside the protocol while preserving a verifiable execution
boundary.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with 9 read-only workspace/data tools plus `report_control_progress` and `submit_control_result`; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `control/` | Research/result/progress schemas and one-shot mailbox lifecycle: open, report, submit, wait, acknowledge, cancel, prune |
| `session/` | Workspace-level Project binding plus per-local-session chat URLs and checkpoints |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace layer
(path containment → ignore rules → pagination) → JSON result.

**Control result**: Codex opens a request bound to workspace, local session,
task, iteration, phase and expiry → sends its `RESULT_REQUEST_ID`,
`LOCAL_SESSION_ID`, and `RESULT_PHASE` in RESEARCH, INIT, or EXECUTED → ChatGPT
may call `report_control_progress` and then calls `submit_control_result` with
the exact correlation tuple and
`c2c.result.write` → the bridge validates the
kind-specific schema, size, request binding and one-shot semantics → writes
under the C2C state directory → Codex waits and acknowledges locally with the
same tuple. A local session permits only one unfinished question. Stored result
metadata and its canonical content hash are verified again on every read, so a
stale, swapped, or modified file is never returned as the current answer.
Identical retries are idempotent; conflicting retries are rejected. Progress
can only advance through SEARCHING, READING_CODE, and SYNTHESIZING, so it is
bounded to three transitions and cannot become an arbitrary logging channel.

**Conversation mapping**: one workspace-level record holds Project URL and
connector name. A separate record keyed by the resolved local session identity
holds each local session's canonical ChatGPT chat URL and checkpoint. Identity
prefers `CODEX_THREAD_ID` / `CODEX_SESSION_ID`, then derives a runtime-stable ID
from the Codex or terminal context; callers can always override it with
`--local-session`. `c2c session --json` returns an explicit browser route, and
the Skill verifies that route before every control message. Workspace and
thread state updates share one workspace-level cross-process lock, so a local
session update cannot write back stale Project or connector metadata.
Concurrent local sessions therefore share workspace context without sharing a
ChatGPT chat or result queue, even when the visible browser page was changed.

**Execution evidence**: Codex records each run with the same local session,
high-entropy task id, and iteration. `execution_summary`, `test_status`, and
`execution_output` require those correlation fields; output body reads verify
them again. A cross-process lock serializes the shared output index, while JSON
state replacement is atomic, so concurrent local sessions cannot reuse an
output id or expose a partial state file. Execution JSONL readers ignore only
an unterminated final fragment left by an interrupted append; the next append
repairs that tail under the same lock. Any malformed newline-terminated record
still fails closed.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens. The
authorization code is consumed only after its client, redirect URI, and PKCE
verifier all match; rejected exchanges do not destroy an otherwise valid code.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is a c2c bridge for the same workspace (reuse) or not
(fall back to an ephemeral port). Configuration follows automatically via the
runtime state file; users never see ports.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's ChatGPT connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named`). The Skill asks
before the first public URL exists; `cloudflared tunnel login` is the only extra
user step. Tunnel name, hostname and preference live under the OS state dir
(`tunnels/<workspaceId>.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, C2C falls back to Quick Tunnel. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the ChatGPT connector.
