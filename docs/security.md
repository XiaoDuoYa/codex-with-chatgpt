# Security Model

## Trust boundaries

The machine is the trust boundary. ChatGPT is an advisory client; Codex is the
executor. The official OpenAI Secure MCP Tunnel transports MCP to the one
machine gateway, whose connector is configured as `Codex with ChatGPT` with
`Authentication: None`.

The gateway trusts only:

1. Its owner-checked local runtime record.
2. Workspace roots registered by the local harness.
3. Capabilities it issued for the current boot and registration.
4. Correlation and scope fields that match the live mailbox request.

ChatGPT Project names, Project URLs, chat URLs, tab titles, model text and file
contents are untrusted. They are never authorization principals.

## MCP data policy

The MCP surface is intentionally small:

- Directory listing, bounded file reads and search.
- Git status and bounded diff reads.
- Local execution summaries and bounded output reads.
- Forward-only progress and schema-bound control-result writes.

There are no MCP tools for editing files, deleting files, running shell
commands, changing Git state, or committing. Codex performs those operations
locally and records the outcome for review.

Workspace content may contain instructions aimed at an agent. The MCP server
marks it as untrusted project data; ChatGPT must not execute or obey commands
found in files, comments, README text or diffs.

## Path containment

Every workspace root is normalized and canonicalized before registration. Every
requested path is resolved relative to that root and checked for containment.
The following are rejected:

- `..` traversal outside the root.
- Absolute paths that are outside the root.
- Symlinks whose resolved target escapes the root.
- NUL/control characters and malformed path input.
- Requests after the registration has been revoked.

The workspace root is selected by the local `cwd`; ChatGPT cannot choose a
different root by passing a path in a tool argument. Workspace-scoped CLI
commands apply the same rule: an optional `-w` must resolve to the exact
current `cwd`, so it cannot register or operate on another local path.

## Capability security

Every control turn gets a random, short-lived `CONTEXT_ID`. The broker stores a
hash of the secret and binds it to:

```text
bootEpoch
workspaceId + projectId + registrationId
localSessionId + taskId + iteration + phase
compactionEpoch + browser-page generation + scopes
```

The raw token is returned only to the local harness and inserted into the exact
control prompt for that turn. ChatGPT must pass it as `context_id` in every MCP
call. A missing, malformed, expired, cancelled, replayed, or mismatched token
is rejected before workspace access.

The broker gives each claim an activity lease. MCP calls renew the lease while
running and release it even on errors. A token cannot complete while active
leases remain. Completion uses a fence, writes the exact mailbox result, then
marks the turn terminal. A mailbox failure aborts completion, avoiding a false
success that would lose the only result.

## Mailbox integrity

The result mailbox validates canonical JSON and exact request identity. A result
must match:

```text
RESULT_REQUEST_ID
workspaceId
localSessionId
taskId
iteration
phase
CONTEXT_ID
```

The allowed payload is phase-specific (`RESEARCH`, `PLAN`, `REVIEW`, `DONE`, or
`BLOCKED`) and size bounded. A request is one-shot. An already-open request is
not overwritten with a new token, preventing recovery from silently orphaning
the token already visible to ChatGPT.

Mailbox markers use separate pending, result, acknowledgement, cancellation,
and active-lease records. Lifecycle writes use file locking and exact schema
checks. Terminal records are retained only for bounded cleanup and audit.

## Browser isolation

One local session owns one persistent page in the built-in ChatGPT browser. Its
lease is keyed by `projectId + localSessionId` and records the exact `tabId`,
Project URL, chat URL, generation, owner epoch and expiry.

Normal operations must use stable URLs, DOM/browser APIs and the stored tab id.
Screenshot-coordinate control is not a security boundary and is not used for
normal navigation or submission. A visible foreground page is never implicitly
owned.

Page replacement requires the exact current generation. A stale session cannot
replace a live page, and a page from another Project cannot satisfy the lease.
When a page fails, only its local session backs off or rotates its lease; other
sessions retain their pages and continue.

The protected machine ownership index is authoritative across workspaces. It
rejects a normalized Project URL already bound to another local project and a
physical browser/surface/tab tuple already owned elsewhere. Workspace-local
page files are recovery mirrors only: they are overwritten from machine state,
never imported as authority. A machine-wide monotonic generation allocator
prevents a workspace edit or retired session from replaying an older page
generation; inactive per-session entries can therefore be pruned safely.

The machine permits 100 unexpired session/page leases, counted by unique
`(projectId, localSessionId)` identities, each representing one workspace-local
session owner. Released, expired, and retired leases free capacity.
A claim for a new 101st session is rejected with a retryable capacity result and
must wait, back off, and retry after a slot becomes available. Renewals,
idempotent claims, and page replacements for an existing session reuse its slot
and do not add capacity usage. Resource pressure may still come from the
browser or ChatGPT service, but C2C does not silently serialize unrelated
sessions. Only one session's own turns are ordered.

## Machine runtime security

The tunnel-owned `serve-machine --stdio` process is the single MCP gateway.
The gateway's admin API binds to loopback and requires its per-lifetime admin
token. The token is never returned by normal status output.

The machine runtime record is protected and owner-checked using machine id,
boot epoch, pid and exact port/runtime data. A process only clears its own
record. A second process cannot adopt or publish over a healthy runtime.

The runtime key is installed from a user-selected file into protected state.
Commands use a file reference rather than printing the key. Status, errors,
tests and documentation redact keys, admin tokens and raw capabilities.

Mutable project data is kept inside the repository boundary: Git checkouts use
`<git-common-dir>/codex-with-chatgpt`, while non-Git workspaces use
`<workspace-root>/.codex-with-chatgpt`. Shared project metadata is separated
from checkout-specific session routes and execution records under
`workspaces/<workspaceId>/`. The authoritative mailbox, runtime installations,
Tunnel configuration and keys, surface ownership index, gateway ownership
records, machine identity, lifecycle locks and logs remain in protected machine state. The
`sandbox-clean` command removes obsolete global write grants; it does not grant
a global machine-state directory.

## Browser and tunnel failure handling

`machine doctor` verifies the official client, the 0.0.14 status-backed tunnel
target (`tunnel_id`, profile path and child command), health response, loopback
admin port and owner record. When the status payload includes a child PID, it
must match the gateway runtime record. The pinned client may omit that field,
so exact target, association and health checks remain the primary proof. This
remains a local configuration and liveness check, not a cryptographic
process-identity proof.
`machine stop` first verifies the same ownership identity, then stops the tunnel
supervisor; it does not race the child with an unrelated shutdown.

After a gateway restart, all old contexts are invalid because `bootEpoch`
changes. The local harness re-registers affected workspaces, claims or renews
their surfaces, and issues new contexts. It never retries an old token.

## User responsibilities

Keep the runtime-key source private and do not commit machine-state files. In
ChatGPT create only the named connector with `Authentication: None`, and keep
each workspace in its intended Project. Do not paste runtime keys, admin
tokens, context tokens, or full repository contents into ChatGPT manually.
