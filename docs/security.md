# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. All workspaces
   of a user share one bridge host process, but every token is bound to a
   single `workspace_id` and requests are dispatched by the token's owning
   workspace store: a token for project A can never read project B (403), and
   a record stored in A that claims B's identity is rejected outright.
   Pairing codes resolve to exactly their own workspace; a wrong code burns no
   attempts on unrelated workspaces (a host-level limiter punishes guesses).
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
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits); a wrong code burns one of 5 attempts bound to the unguessable, 10-minute authorization request (IP-independent) plus a per-IP rate limit (10/min); codes are one-time use and expire in 5 minutes |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals no workspace information at all — workspace membership is available only through the loopback-only, admin-token-authenticated API |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file, host records included) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404. The admin token is host-scoped by design: anyone who can read the user's state directory can register any local folder as a workspace. This is an accepted trade-off — the state directory already holds the host token and tunnel credentials, so splitting per-workspace capabilities would not raise the real bar |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Prompt injection via repo | Tool descriptions state content is untrusted data; the bridge grants no additional authority regardless of content; ChatGPT has zero write/exec capability |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`).
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Only SHA-256 hashes of tokens are persisted — a stolen state file
does not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
