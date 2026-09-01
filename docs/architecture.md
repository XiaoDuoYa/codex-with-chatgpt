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
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## Session serialization

The OMP integration treats the ChatGPT browser conversation and the workspace
state as one serialized session. Before setup, repair, tunnel selection,
pairing, session persistence, or execution-record writes, the caller acquires
`c2c session lock acquire -w <workspace> --task <task-id> --json`. The returned
token is kept by the caller and passed as `--lock-token` to every mutating CLI
command. Read-only status commands do not require the lock.

The lock is an owner-only state directory with an atomic `mkdir` acquisition,
hashed bearer token, lease expiry, and atomic owner-file replacement. A
crashed caller therefore cannot hold the workspace forever. An expired lock is
reclaimed by renaming the lock directory before removal, so two recovery
processes cannot both claim the same lease. The caller releases the lock in a
`finally` path and refreshes it before a long review.

Each lock acquisition, refresh, release, and stale-lock reclaim also runs
under a short-lived per-workspace mutation guard. This closes the
check-then-write gap between reading the current owner and changing the lock
directory; the guard itself has a finite lease for crash recovery.

## OMP integration workspace

The bridge accepts any existing directory as its workspace root, as selected by `-w`. The OMP integration uses `/Users/arica/Data/OMP` as the canonical root for normal tasks, regardless of the current project directory. A child directory is selected only when the caller explicitly requests project-level isolation.

The root choice is an integration policy, not a change to the bridge boundary. Each bridge still serves exactly one root, and every token remains bound to that root.

## Endpoint, connector, and conversation identity

The endpoint file stores two different facts and never infers one from the
other:

- `observed` is the bridge's latest address observation.
- `connectorBound` is the address and connector identity explicitly committed
  after ChatGPT has accepted the connector and `workspace_info` has succeeded.

When the observed MCP URL differs from the bound URL, the bridge creates a
`pendingRepair` record with a monotonically increasing `generation` and a
stable `fingerprint`. Repeated observations of the same pending URL update
the observation without creating another generation. A URL observation alone
therefore cannot make a saved conversation usable.

The recovery transition is explicit and ordered:

1. `doctor --json` reports the current `generation`, `fingerprint`, MCP URL,
   connector name, and repair status.
2. The Skill recreates only that connector, then creates a fresh ChatGPT
   conversation and verifies `workspace_info`.
3. `connector commit --generation ... --fingerprint ... --url ...` writes the
   verified conversation metadata and advances `connectorBound` atomically.

The commit writes the session first and rolls it back when the binding write
fails. `session set` is reserved for metadata updates after a binding exists
and requires the current generation and fingerprint. `session get --json`
reports `usable: true` only when those values exactly match
`connectorBound`; missing, legacy, unbound, or mismatched sessions are
unusable and must not be opened.

Legacy endpoint files are read through a version-2 normalization path. They
become an unbound `legacy_state` repair, and legacy sessions remain unusable
until a current connector is verified and committed. The normalized state is
persisted by the next endpoint write; this prevents an old URL from silently
becoming a valid connector binding.

## OAuth client identity and duplicate convergence

Dynamic client registration uses a semantic fingerprint of the trimmed client
name and the de-duplicated, sorted redirect URI set. Repeating the same
registration returns the existing client instead of creating another client
identity. When older state contains duplicates, loading selects one canonical
client deterministically by active token count, newest creation time, then
client ID, and retires the duplicate clients and their tokens.

Every OAuth mutation takes a file-level lock, reloads the latest state, applies
the mutation, and writes the merged state. This prevents concurrent bridge
processes from losing registrations or tokens. `unpair` retires all clients,
tokens, and authorization codes; it is an explicit revocation boundary rather
than a routine health check.

## Doctor status contract

`doctor --json` returns a top-level `status` of `ok`, `pending`, or `blocked`.
`pending` means local checks are complete but connector or named-tunnel repair
still requires the prescribed next action. In read-only `--no-fix` mode the
historical diagnostic exit code remains zero, while JSON still exposes
`status: "pending"` and `ok: false`. Repair mode exits nonzero until the
pending repair is committed; `blocked` indicates an unresolved local failure.


## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with 8 read-only tools; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records written by `c2c record`, read by `execution_summary` / `test_status` |
| `session/` | Lease-based workspace session lock and short-lived bridge lifecycle lock |
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

The pairing session is memory-only and defaults to a 30-minute TTL, with five
verification attempts and one-time use. The setup response may contain a
pairing code, but the Skill does not use it before the ChatGPT Connector
exists. It runs `doctor --no-fix --json` for diagnosis, creates or recreates
the Connector, then runs repair-mode `doctor --json --lock-token <token>`
immediately before opening the OAuth popup and enters the returned code at
once. This just-in-time order leaves the longer TTL for the connector UI
without persisting or weakening the pairing credential.

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

For the OMP adaptation, the workspace remains fixed at `/Users/arica/Data/OMP`
and Quick Tunnel remains the default unless the user explicitly chooses a named
hostname. When a Quick Tunnel address changes, the OMP Skill deletes and
recreates only that workspace's connector. Deleting and recreating changes the
ChatGPT app identity, so the saved conversation is no longer usable for MCP.
The Skill must create a fresh conversation, add the current connector, send the
Boot Prompt, verify `workspace_info`, and save the new URL. When a named tunnel
needs repair, it asks for Cloudflare login without deleting the connector.
