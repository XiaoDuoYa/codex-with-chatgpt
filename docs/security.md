# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
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
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per authorization request, per-IP rate limit (10/min), 5-minute TTL, one-time use; hostile requests cannot invalidate another request's code |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file streams and caps lines/bytes even for a single huge line; git_diff paginates with hard caps; search caps files/matches and runs fallback regexes in a terminable worker |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` exposes only a random per-run identifier |
| Admin API abuse | Loopback-only + workspace-isolated random admin token + one active bridge per workspace; proxy-marked requests are rejected and unauthenticated probes get 404 |
| Log credential leakage/forgery | Logger redacts credentials and encodes CR/LF/control characters before writing one physical record |
| Prompt injection via repo | Tool descriptions state content is untrusted data; the bridge grants no additional authority regardless of content; ChatGPT has zero write/exec capability |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

Logs and non-secret operational cache live under the OS-convention app dir.
Authorization state, runtime discovery and the local admin credential live in
the selected workspace's ignored `.c2c-local/` directory, which is denied by
all workspace read/list/search/diff/status tools. This prevents one sandboxed
workspace from changing another workspace's security state. Files are written
with owner-only permissions where the operating system supports them. Only
SHA-256 hashes of access/refresh tokens are persisted.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw access/refresh tokens are never written anywhere.
Keychain integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
