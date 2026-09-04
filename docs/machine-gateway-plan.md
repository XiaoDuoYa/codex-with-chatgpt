# Machine Gateway Plan

Status: Phase 1 safety foundation complete; account-side tunnel E2E and Phase 2
integration remain pending, and the shipped transport is still per-workspace

## Outcome

Configure ChatGPT once per machine, then let any local Codex workspace use the
same connector without exposing one workspace to another or taking ownership
of the user's normal ChatGPT conversations.

Success means:

- the second workspace requires no ChatGPT connector setup;
- a tool call without a live, locally issued turn capability cannot enumerate
  or read any registered workspace;
- each local Codex session owns a separate, persistent ChatGPT browser page;
- moving a Git checkout keeps its logical Project mapping while preserving a
  checkout-specific filesystem boundary;
- any number of session pages may remain parked, while at most five pages are
  actively submitting or generating by default; later work queues without
  reusing, navigating, or evicting another session's page.

## Decisions

1. Use one machine daemon, one OpenAI Secure MCP Tunnel runtime, and one
   ChatGPT connector.
2. Keep ChatGPT Projects and chats as organization and continuity metadata.
   They are never authorization inputs.
3. Resolve the workspace only from trusted local registration. A model-provided
   workspace name, Project id, conversation id, current tab, cwd, or absolute
   path cannot select a filesystem root.
4. Require a high-entropy, short-lived turn capability for every data-plane
   tool call. Store only its SHA-256 hash locally.
5. Retain the existing mailbox correlation and workspace path protections.
6. Use a dedicated managed ChatGPT page per local session. A model or effort
   change may rotate that page, but never changes workspace access or transfers
   ownership to another session.
7. Replace obsolete per-workspace transport and authorization paths after the
   global path passes its end-to-end gate. Do not maintain two permanent stacks.

## Target Architecture

```text
ChatGPT Project A / chats A1, A2 ----+
ChatGPT Project B / chats B1, B2 ----+--> one machine connector
                                             |
                                      OpenAI Secure MCP Tunnel
                                             |
                                      machine gateway daemon
                                             |
                                      turn capability broker
                                      /                    \
                              Workspace A              Workspace B
                                      \                    /
                                  correlated local mailbox
```

The tunnel runtime credential authenticates the machine runtime to the tunnel
control plane. It is not a model API key and it is never sent to ChatGPT. The
connector may use `Authentication: None` only because every workspace tool is
separately gated by a turn capability.

## Identity Model

Identity is deliberately split instead of overloading a path hash:

```text
projectId
  workspaceId + registrationId
    localSessionId
      taskId + iteration + phase
        compactionEpoch + generation
```

- `projectId` identifies the logical local repository. For Git repositories it
  is random local metadata stored in the Git common directory, so a directory
  move preserves it and linked worktrees share it. Independent clones receive
  different ids. If that metadata is malformed, read-only, or cannot be
  atomically created, identity explicitly degrades to a path-based id; move and
  linked-worktree continuity are then unavailable until the metadata is fixed.
- `workspaceId` identifies one canonical checkout root and remains the
  filesystem security boundary.
- `registrationId` identifies the current incarnation of that checkout root.
  The gateway records the root filesystem identity and Git project identity,
  then revalidates both before every lease-based resolution. Replacing a
  directory at the same path retires the old registration.
- `localSessionId` identifies one Codex task/conversation route.
- `taskId`, `iteration`, and `phase` bind one protocol turn and mailbox result.
- `compactionEpoch` invalidates context from before a compaction.
- `generation` invalidates an old page owner after refresh, reconnect, handoff,
  cancellation, or surface replacement.
- `modelId` and `effort` are surface scheduling attributes and optional
  capability constraints. They never authorize a workspace.

## Turn Capability Lifecycle

A capability binds:

```text
workspaceId + projectId + registrationId + localSessionId + taskId + iteration + phase
+ scopes + compactionEpoch + generation + bootEpoch + absoluteExpiry
```

Lifecycle:

1. The local Codex skill registers the canonical workspace and turn over an
   owner-only local control channel.
2. The gateway returns a random capability to that turn only.
3. Each MCP invocation claims the capability and creates an activity lease.
4. Completion closes the claim gate, waits for all leases to release, verifies
   the completion fence, and only then commits the result. Existing leases may
   renew while the gate is closed so long-running calls cannot be mistaken for
   completed work.
5. Completion, cancellation, expiry, ownership rotation, checkout replacement,
   or gateway restart
   rejects all later claims. A bounded tombstone distinguishes a replay from an
   unknown token without retaining the raw token. Draining terminal turns are
   never evicted while a lease is live; the overall capability bound limits
   them until they drain.

## Browser Page Ownership

Page ownership and execution concurrency are separate limits:

```text
localSessionId
  -> browser surface id + tab id
  -> ChatGPT Project URL
  -> ChatGPT chat URL
  -> ownership generation + lease
```

- Every local Codex session gets its own persistent in-app browser page and
  ChatGPT chat. An idle page is parked for that session; it is not returned to
  a shared page pool or claimed by another session.
- The default concurrency of five counts only pages actively submitting a
  message, waiting for generation, or collecting the correlated result. It is
  configurable and is not a limit on local sessions, saved chats, or parked
  pages.
- Browser automation targets the owned tab directly by id, so active sessions
  do not depend on the globally focused page. Screenshot/coordinate Computer
  Use is reserved for UI that cannot be addressed through the tab DOM and is
  serialized behind one machine-wide input lock.
- Login, CAPTCHA, 2FA, and consent screens remain foreground, user-controlled
  operations. Ordinary ChatGPT pages that are not registered to a local C2C
  session are never claimed or navigated.

## Delivery Plan

### Phase 0: Tunnel eligibility spike

Validate the target ChatGPT account and supported operating systems against the
official tunnel runtime. Confirm stdio transport, connector `Auth=None`, health,
reconnect, and whether per-chat MCP session metadata is stable and distinct.

Gate: proceed with the official tunnel only when reconnect works and no runtime
credential reaches prompts, process arguments, or logs. Otherwise keep the
machine gateway design and select one different transport before Phase 3.

### Phase 1: Safety foundation

- add stable `projectId` while retaining checkout-specific `workspaceId` and a
  root-incarnation `registrationId`;
- add the in-memory turn capability broker, activity leases, completion fence,
  cancellation, expiry, boot epoch, and bounded tombstones;
- start with one active turn;
- add replay, cross-workspace, cross-session, expiry, and completion-race tests.

Gate: all mismatched or stale claims fail closed, directory moves retain the
Git project id when its common metadata is healthy and writable, degraded
identity is explicit, and existing workspace behavior remains green.

### Phase 2: Machine gateway

- replace the bridge's constructor-bound Workspace with a machine registry;
- expose an owner-only local registration/control API;
- resolve an immutable `TurnContext` from the capability for every MCP call;
- bind mailbox submission to the same capability without reusing request ids as
  general-purpose capabilities;
- run one daemon and one health/doctor lifecycle per machine.

Gate: two workspaces and two local sessions can run in either order without
cross-reading, and a prompt-supplied root never changes routing.

### Phase 3: One connector and tunnel

- connect the gateway's stdio MCP server to one Secure MCP Tunnel runtime;
- store the runtime credential in the OS credential store or an owner-only
  state file;
- make setup idempotent and machine-scoped;
- remove the per-workspace Cloudflare tunnel, connector, OAuth, and pairing
  paths after the end-to-end gate passes.

Gate: initial machine setup creates one connector; adding a second repository
does not open ChatGPT settings or create another connector.

### Phase 4: Surface ownership

- allocate one persistent managed ChatGPT page and chat per local session,
  identified by browser surface id, tab id, and ownership generation;
- keep Project URL and chat URL mapping for navigation and memory only;
- rotate on model/effort changes or compaction when required;
- park an idle session's page without making it available to another session;
- never claim or navigate a user's ordinary ChatGPT tab.

Gate: concurrent sessions retain distinct URLs, cancellation releases exactly
one owner, and the user's previously active ordinary chat remains unchanged.

### Phase 5: Bounded concurrency

- allow at most five actively automated or generating pages by default while
  retaining any number of parked session-owned pages;
- serialize work within one task;
- queue a sixth task and wake it when a completed or cancelled surface releases;
- never evict a running surface;
- target ordinary browser operations by tab id; serialize the rare global-input
  Computer Use fallback;
- recover leases and ownership safely after browser or daemon failure.

Gate: five unique owners run, the sixth waits, and release wakes one correct
waiter without reviving an old capability.

## Security Invariants

- No active capability means no workspace discovery.
- Only trusted local registration can bind a canonical root.
- A capability is exact to workspace, registration incarnation, session, task,
  iteration, phase, scope, epoch, generation, boot, and expiry.
- Root filesystem and project identity are revalidated before lease routing.
- All leases release in `finally`; completion cannot pass with live activity.
- Project/chat ids and model output are never filesystem authorization.
- Mailbox results remain exactly-once and correlation-bound.
- Realpath containment, symlink escape prevention, and sensitive-file filtering
  cannot regress.
- Runtime credentials and raw capabilities never appear in logs.

## Explicitly Out Of Scope

- Using a ChatGPT Project or conversation id as a security principal.
- A mutable global `activeWorkspace`.
- Letting the model submit an absolute local path.
- Scraping the last visible assistant response as task completion.
- Creating a new tunnel or connector for every turn or workspace.
- Avoiding all ChatGPT Web sessions. That requires a separately billed model
  API and is a different product mode.

## References

- `miuuyy/codex-chatgpt-web` at `985e0d9`: global connector, Secure Tunnel,
  turn broker, leases, completion fence, and managed conversation surfaces.
- `Zhenyu98/codex-chatgpt-bridge` at `351c66f`: desired-state lifecycle,
  health gates, recoverable restart, and ownership checks.
- This project: canonical workspace containment, per-session Project/chat
  mapping, and correlated result mailbox.
