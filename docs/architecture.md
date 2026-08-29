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
- **Read-only by design**: no write/exec tools exist in V1 at all.
- **Workspace is the security boundary**: every token is bound to one workspace;
  a shared host dispatches each request to the workspace its token names.

## One host per machine

A single bridge process serves **all** workspaces of a user (and therefore all
parallel agent sessions — any tool that runs `c2c`). The
first session spawns the host; later sessions register their workspace with
the running host through the loopback-only admin API instead of starting a
competing process. This matters because the public address is machine-wide: two bridges would each run
their own `cloudflared` for the same hostname with different local upstream
ports, and Cloudflare would round-robin requests onto the wrong workspace —
surfacing as random 401s and endless re-pairing. With one host there is
exactly one tunnel and one upstream, so dispatch is always correct.

- Adoption record: `runtime/host.json` (pid, port, admin token, random
  instance nonce, workspace ids), guarded by `runtime/host.lock`. Sessions
  verify the nonce against the authenticated `/admin/info` before trusting a
  record; stale per-workspace runtime records self-heal on the next
  `ensureBridge`, and a pre-upgrade single-workspace bridge found on the
  preferred port is migrated (stopped) instead of being left to split the
  fixed domain.
- Dispatch: `/mcp` bearer tokens are resolved together with the store that
  holds them; a record whose `workspaceId` differs from its owning store is
  rejected. A pairing code selects its workspace via a non-mutating match
  (wrong codes never consume unrelated workspaces' attempts; a host-level
  limiter punishes guesses). OAuth clients live in one host-wide registry.
- Lifecycle: `c2c stop` unregisters one workspace; the host shuts down when
  the last one leaves. `c2c restart` restarts only the current workspace's
  membership and reuses the running host; `c2c tunnel named/quick` are
  machine-global config commands — they persist `tunnel.json` and, when a
  host is running, ask it to swap the tunnel provider live; they never start
  a bridge or register a workspace.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only multi-workspace host (registry, per-workspace stores/pairing/MCP handlers, token dispatch), runtime + host state, admin API |
| `mcp/` | McpServer with 8 read-only tools; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591, host-wide `ClientRegistry`), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick Tunnel |
| `execution/` | JSONL execution records written by `c2c record`, read by `execution_summary` / `test_status` |
| `process/` | Host spawn/adopt (lock + `host.json`), workspace registration, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → host `/mcp` → bearer middleware
(401; 403 for a workspace this host does not serve) → dispatch by the token's
`workspaceId` → stateless StreamableHTTP transport → tool handler → workspace
layer (path containment → ignore rules → pagination) → JSON result.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified against every
hosted workspace (the code selects the workspace) → 302 with authorization
code → `/oauth/token` (PKCE S256, tokens issued by that workspace's store) →
access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. Parallel sessions never race
for it — they join the running host (`runtime/host.json` + lock). The
ephemeral fallback exists only for conflicts with foreign programs.

**Tunnel**: the host runs exactly one `cloudflared` Quick Tunnel whose URL rotates per start — `c2c doctor` restarts it and the Skill reconfigures the ChatGPT connector.
