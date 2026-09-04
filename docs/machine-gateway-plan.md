# Machine Gateway Implementation Plan

This is the implementation contract for the machine-wide architecture. It is
intentionally written as an end-state plan: no workspace-specific service or
second connection path is required.

## Product requirements

1. Configure one ChatGPT connector per machine:
   `Codex with ChatGPT`, `Authentication: None`.
2. Use one official OpenAI Secure MCP Tunnel.
3. Let that Tunnel own one `serve-machine --stdio` process.
4. Route any registered workspace from trusted local `cwd` state.
5. Give every workspace one ChatGPT Project.
6. Give every local Codex session one persistent Project chat and one owned
   browser page.
7. Target the exact page `tabId`; never infer ownership from visibility.
8. Allow unlimited cross-session pages and turns. Serialize only a single
   session's ordered control turns.
9. Scope backoff, retry and browser recovery to the affected session.
10. Require `context_id` on every MCP call and `CONTEXT_ID` in every control
    prompt.
11. On macOS, enable one LaunchAgent after setup and verify it with
    `c2c autostart status --json`.

## Delivery layers

### Layer 1: Machine identity and state

- Resolve a stable machine identity and create a unique `bootEpoch` per gateway
  lifetime.
- Store tunnel configuration, runtime key, admin token, lifetime record and
  workspace registrations in protected machine state.
- Store mutable workspace data inside the repository boundary: Git checkouts
  use `<git-common-dir>/codex-with-chatgpt`; non-Git workspaces use
  `<workspace-root>/.codex-with-chatgpt`.
- Keep the authoritative Project URL, physical-tab and generation ownership
  index in protected machine state. Workspace page files are recovery mirrors
  only and are never imported into that authority.
- Make state writes atomic and owner-checked.
- Never include runtime keys or raw capabilities in status output.

Acceptance: a second process cannot publish over a healthy runtime; a stopped
process only clears its own exact record.

### Layer 2: Official Tunnel runtime

- Install and checksum-verify the pinned official tunnel client.
- Start it with the configured tunnel id and file-based runtime key.
- Pass the child command as:

  ```text
  node <checkout>/bin/c2c.js serve-machine --stdio --port 0
  ```

- Report ready only when the Tunnel, child process and gateway health endpoint
  all agree.
- Stop the supervisor first so child ownership remains unambiguous.

Acceptance: `machine status` exposes configured/healthy/ready state and the
actual admin port without exposing secrets.

### Layer 3: Machine autostart

- Install one machine-wide LaunchAgent only on macOS.
- Its `ProgramArguments` must be the hidden command
  `c2c autostart run --quiet`.
- The wake command only invokes `ensureMachineGateway`; it reuses the official
  Tunnel-owned child and never starts a workspace-specific process.
- Enable and verify it once after machine setup:

  ```sh
  c2c autostart enable --json
  c2c autostart status --json
  ```

- Disable it with `c2c autostart disable --json`.

Acceptance: a login or wake event can recover the one managed machine runtime,
while no second Tunnel, gateway, or browser-page scheduler is created.

### Layer 4: Workspace registry

- Register a trusted canonical root and derive `workspaceId` and `projectId`.
- Keep a current `registrationId` and revoke old registrations.
- Validate containment and root identity on every claim.
- Route explicit and automatically detected stale registration removal through
  the same capability-revocation and last-checkout cleanup lifecycle.
- Never use a Project or conversation id as filesystem authorization.

Acceptance: two workspaces can be registered at once; moving or replacing a
checkout requires a fresh registration; traversal and symlink escapes fail.

### Layer 5: Capability broker

- Issue random short-lived `CONTEXT_ID` values.
- Bind each capability to machine boot, workspace registration, Project,
  local session, task, iteration, phase, compaction epoch, page generation and
  scopes.
- Track claims with activity leases and renew them during long MCP calls.
- Revoke on expiry, cancellation, registration change, page rotation,
  compaction or gateway restart.
- Fence completion until leases drain, then write the mailbox result.

Acceptance: a token copied between sessions, tasks, phases, page generations or
machine boots is rejected; mailbox failure never becomes a false completion.

### Layer 6: Surface ownership

- Persist `projectId + localSessionId -> browserId + surfaceId + tabId` in the
  protected machine ownership index.
- Persist `projectId -> normalized projectUrl` independently of session leases
  so new sessions and linked worktrees reuse the existing ChatGPT Project.
- Require exact Project/chat URL matching.
- Enforce one local project per normalized ChatGPT Project URL and one owner
  per physical browser/surface/tab tuple across all registered workspaces.
- Give each surface a generation and owner process epoch.
- Keep a machine-wide generation allocator monotonic across release, expiry,
  and session retirement while pruning inactive per-session entries.
- Permit live replacement only with the exact current generation.
- Do not impose a machine-wide tab or session count.

Acceptance: two local sessions in one Project own different tabs and can submit
independently; another workspace cannot reuse that Project or either tab; a
stale session or edited workspace mirror cannot rotate or replay ownership.

### Layer 7: Mailbox correlation

- Open one request for one question/answer pair.
- Refuse to replace an existing open request with a new context.
- Validate exact request, session, task, iteration, phase and payload schema.
- Use `pending -> received -> acknowledged` with explicit cancellation and
  expiry states.
- Accept results only through the protected machine mailbox. Browser text is
  never a result transport.

Acceptance: a late result for a different request is rejected, and a wait
timeout never causes an implicit resend.

### Layer 8: ChatGPT workflow

- Have `machine setup` install or update one global Skill automatically rather
  than copying a project-specific setup.
- For a new workspace, create one Project and set project-only memory if the
  user chooses that ChatGPT mode.
- Start every new local session from the workspace Project collection page.
- Claim the new chat's exact `tabId` and save its URL only after
  `workspace_info` verifies the workspace.
- Use only the built-in browser, stable URLs and DOM APIs. Do not use
  screenshot-coordinate control for normal operations.
- Put `RESULT_REQUEST_ID`, `CONTEXT_ID`, `LOCAL_SESSION_ID`, `TASK_ID`,
  `ITERATION` and `RESULT_PHASE` in every control prompt.
- Send the next control message only after the current request is terminal.

Acceptance: a user's ordinary ChatGPT tabs remain untouched; each local session
has a visibly independent Project chat; ChatGPT passes `context_id` to every
MCP call.

## CLI surface

Machine lifecycle:

```text
c2c machine setup --tunnel-id ... --runtime-key-file ...
c2c skill status [--json]
c2c machine start
c2c machine status [--json]
c2c machine doctor [--no-fix] [--json]
c2c machine stop
c2c sandbox-clean [--json]
c2c update-check -w <workspace-root> [--json]
c2c autostart enable [--json]
c2c autostart status [--json]
c2c autostart disable [--json]
```

Workspace and context:

```text
c2c machine workspace register   # run from the workspace root
c2c machine workspace unregister --workspace-id ... --project-id ... --registration-id ...
c2c machine context issue ...
c2c machine context cancel --context-id ...
```

Session and page:

```text
c2c workspace                 # run from the workspace root
c2c surface get|claim|commit|renew|release|retire ...
c2c session get|set|clear ...  # set updates task/checkpoint metadata only
```

Control mailbox:

```text
c2c control open ...
c2c control status ...
c2c control wait ...
c2c control ack ...
c2c control cancel ...
```

`control cancel` is keyed by the exact request correlation and does not require
the capability token. Healthy gateways revoke matching live contexts by
request; a zero-match result is valid after a pre-issue crash or gateway
restart. A stopped gateway is restarted before the protected mailbox is
changed, while an uncertain gateway state fails closed.

## Non-goals

- A fixed five-page or any global concurrency limit.
- A single global “active workspace” selected by whichever page is visible.
- User-provided absolute paths as ChatGPT authorization.
- A second MCP broker per workspace.
- Pasting repository content, diffs or logs into prompts.
- Browser screenshot coordinates as the routine automation API.
- Treating Project ids, chat ids, or model output as security credentials.
- Recreating the connection for every turn.

## Verification matrix

| Area | Required check |
| --- | --- |
| Build | `corepack pnpm typecheck` and `corepack pnpm build` |
| Tests | Full Vitest suite, including machine, tunnel, gateway, mailbox and surface tests |
| Tunnel | Official client checksum/version and child `serve-machine --stdio` |
| Isolation | Two or more workspaces and sessions route to their own roots/pages |
| Capacity | More than five session/page owners execute without scheduler rejection |
| Stale state | Old boot, registration, generation, epoch and context are rejected |
| Mailbox | Duplicate open, late result, cancellation and write failure are covered |
| Browser | Exact `tabId` targeting; ordinary user tabs are untouched |
| Secrets | Runtime key, admin token and raw context absent from normal output |
| Docs | README, protocol, security and Skill agree on one connector and `None` auth |

## Rollout order

1. Build and test the machine gateway, registry and broker locally.
2. Install and verify the official Tunnel runtime.
3. On macOS, enable autostart once and verify its status.
4. Register one workspace and claim one Project chat.
5. Run a read-only boot check and a mailbox control turn.
6. Add a second workspace and multiple sessions; verify independent tabs and
   affected-session-only recovery.
7. Install the global Skill and verify a fresh Codex session.
8. Run the full suite, doctor, secret scan, diff check and documentation review.

The rollout is complete only when the one-machine setup works for multiple
workspaces and sessions without any hard-coded page or session cap.
