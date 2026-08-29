# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP Server (RO)    │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only MCP by design**: no write/exec tools exist in the MCP server.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## V0.2 runtime layers

Protocol is the product core. It parses, validates, serializes, and transitions
C2C messages without knowing how ChatGPT reads task data. Transport is the
replaceable data channel. Codex Execution edits files and runs tests.

- `McpTransport` is a compatibility facade over the existing bridge, tunnel,
  OAuth, pairing, and execution-record behavior.
- `GitHubTransport` publishes `.c2c` projections and explicit code paths to a
  dedicated branch with normal, non-force pushes.
- `.c2c/current.json` is the only machine truth. `.c2c/current.md` and
  `.c2c/tasks/<taskId>.json` are deterministic, repairable projections.
- FilePack is future V0.3 work. V0.2 has no FilePack subsystem or command.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with 8 read-only tools; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick Tunnel implementation; business logic is vendor-agnostic |
| `execution/` | JSONL execution records written by `c2c record`, read by `execution_summary` / `test_status` |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace layer
(path containment → ignore rules → pagination) → JSON result.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is a c2c bridge for the same workspace (reuse) or not
(fall back to an ephemeral port). Configuration follows automatically via the
runtime state file; users never see ports.

**Tunnel**: bridge child-process `cloudflared tunnel --url …`; public URL parsed
from logs; the bridge's OAuth issuer switches to the public URL automatically.
Quick Tunnel URLs change per start — `c2c doctor` restarts and the Skill
reconfigures the ChatGPT connector.
