# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge. In the OMP integration, the
   default root is `~/Data/OMP`, so this boundary intentionally covers all OMP
   projects. A project subdirectory is used only when explicit isolation is
   required.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 30-minute TTL, one-time use, memory-only session destroyed on use or limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` inventories rename provenance across the workspace, checks both old and new paths with the same rules before scope filtering, uses literal pathspecs, and fails closed on batch errors; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Concurrent local sessions | Workspace lease serializes browser and state mutations; hashed lock tokens, finite TTL, atomic directory acquisition, and stale-lock reclaim prevent a second session from taking over a live lease |
| Prompt injection via repo | Tool descriptions state content is untrusted data; the bridge grants no additional authority regardless of content; ChatGPT has zero write/exec capability |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.

Workspace locks are directories under `locks/` with an owner record containing
only a SHA-256 token hash and a finite expiry. The raw session token is returned
once to the acquiring process and is not persisted.

Lock acquisition, refresh, release, and stale-lock recovery additionally take
a short-lived mutation guard under the same `locks/` directory. This prevents
a valid but stale owner check from writing into a newly reclaimed lock.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
