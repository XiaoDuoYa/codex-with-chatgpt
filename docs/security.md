# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Browser automation only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.
4. **The control mailbox is not workspace access.** Its two MCP write tools
   accept bounded progress or one advisory result for an active one-shot request
   and write under C2C's OS state directory. Neither can select a path or modify
   the repo.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token. A token issued by another workspace's Bridge is unknown and rejected with 401; the middleware also rejects any in-store audience mismatch. |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| Dynamic client registration exhaustion | Registration is accepted only during a locally initiated pairing window, with at most 10 attempts per pairing session. At most 20 recent unapproved clients are retained, stale unapproved clients expire after 10 minutes, and capacity is checked before persisted state changes. |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI. Client, redirect, and verifier are checked before consumption, so an invalid exchange cannot invalidate a legitimate pending exchange. Registered redirect URIs reject credentials and fragments. |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair`. Persisted clients/tokens are loaded only after strict schema, scope, timestamp, redirect-URI, uniqueness, and workspace-audience validation. |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404. Shutdown uses the authenticated admin identity and never signals a PID that cannot be verified. |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. Every list/read is filtered by local session, high-entropy task id and iteration; a body read rechecks the tuple. ChatGPT still cannot run commands. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Persisted workspace/thread identities and canonical URLs are checked against their storage paths; state files are atomically replaced and workspace/thread updates share a workspace-level cross-process lock. Resume uses the existing chat or HANDOFF with no log paste or re-pairing. |
| Forged control result | `submit_control_result` requires `c2c.result.write` plus a random active request id and exact local-session/task/iteration/phase tuple bound to workspace and expiry |
| Progress used as a data channel | `report_control_progress` accepts only three forward-only states and one optional 500-character secret-screened message. Each state can be accepted once; progress is rejected after the request stops being pending. |
| Result replay / overwrite | A per-request cross-process lock serializes progress/submit transitions and one result file is created exclusively; lifecycle changes take a workspace lock before the request lock, so acknowledgement/cancellation finishes before the next question can open. An identical retry is idempotent and a different second payload is rejected. Conflicting terminal markers or impossible result/terminal combinations fail integrity checks. |
| Cross-turn result mix-up | Each request is one question; only one may remain unfinished per local session. Status/wait/ack/cancel require the expected request, task, iteration and phase, and every local read verifies the stored envelope plus canonical content hash before returning it |
| Cross-session result mix-up | Each request records its resolved local session id; the Skill captures it once and passes it explicitly to status/wait/ack/cancel, which reject another session before returning a result |
| Wrong ChatGPT chat | Saved chat URLs are restricted to HTTPS ChatGPT conversation URLs and normalized to stable Project/conversation ids, so ChatGPT's slugged and id-only aliases compare equal. Project chats must belong to the configured Project, and the Skill checks the returned route before every control message. |
| Mailbox path traversal | Workspace, local-session, task and request ids use a restricted identifier grammar; MCP callers cannot choose any mailbox or write-target path. Optional advisory file hints must be workspace-relative. |
| Unsafe result payload | Strict kind-specific schemas reject extra fields, absolute/traversal file hints, control characters, private-key blocks and suspected credentials; canonical UTF-8 payload size is capped at 32 KiB and there are no patch, command-output, diff, log or file-body fields. Standalone RESEARCH results require credential-free HTTP(S) URLs and validated publication dates. |

## Token & scope design

Scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`c2c.result.write`, `offline_access`. Tools enforce scopes individually
(`INSUFFICIENT_SCOPE`). The write scope alone is insufficient: submission also
requires an unexpired one-shot result request. Progress and final submission
share the same per-request lock and exact correlation checks.
Doctor evaluates the ChatGPT connector with the most recently issued active
grant. An anonymous newer registration, unrelated local token, older inactive
connector grant, or zero active connector tokens cannot satisfy the result-write
authorization gate.
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Control requests and
results live under `control-mailbox/<workspaceId>/`; callers cannot choose this
path. Only SHA-256 hashes of tokens are persisted — a stolen state file does
not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these workspace capabilities do not exist on the server. The two write tools
can only report bounded progress or submit a schema-bound advisory result to
C2C state for an active request. They cannot choose a workspace write target;
optional workspace-relative file hints are inert advice, and the schema has no
patch, command-output, diff, log, or file-body field.
