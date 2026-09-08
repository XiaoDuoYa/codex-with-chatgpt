# C2C Protocol

This document defines the machine gateway, browser routing, correlated control
state, and ChatGPT prompt contracts. The mailbox callback implementation is
retained but inactive while Computer Use is the result transport. Values shown
as `<...>` are placeholders; never
send a placeholder as a real identifier.

## Identifiers and scopes

The gateway uses these identifiers:

| Identifier | Meaning |
| --- | --- |
| `machineId` | Stable identity of the current machine |
| `bootEpoch` | Unique gateway lifetime; changes on restart |
| `workspaceId` | Identity of the canonical checkout root |
| `projectId` | Stable ChatGPT Project association for the workspace |
| `registrationId` | Current machine registry record |
| `localSessionId` | Codex session identity from the host runtime |
| `taskId` | Current local task |
| `iteration` | Zero-based execution iteration |
| `phase` | `BOOT`, `RESEARCH`, `PLAN`, `REVIEW`, or related control phase |
| `generation` | Current owned browser page generation |
| `compactionEpoch` | Session context-compaction counter |

The initial capability lease defaults to 30 minutes, configurable up to one
hour per lease. For a pending control request, fresh host-observed generation
can renew the same authorization before expiry; there is no fixed total task
duration. BOOT has an exact control request but normally uses a short fixed
lease because it is a bounded route check. Per-MCP-call activity leases are
shorter and renewed while that individual call is active.

The gateway scopes are:

```text
workspace.read
workspace.search
git.read
execution.read
c2c.result.write
```

The least set needed for a phase is requested. `c2c.result.write` remains
reserved for dormant mailbox callback tests and is not granted by production
`control open`. An MCP tool rejects a context that lacks its required scope.

## Machine setup contract

The machine is configured once:

```sh
c2c machine setup \
  --tunnel-id <tunnel-id> \
  --runtime-key-file <runtime-key-file>
```

That two-argument form is required for first-time setup, a tunnel change, or
runtime-key rotation. To deploy an updated clean source revision over a healthy
existing installation without requesting the original key-file path again, run:

```sh
c2c machine setup --reuse-existing
```

Reuse is explicit, requires an existing protected machine configuration, and
cannot be combined with either first-time option. It preserves the tunnel
association, protected runtime key, connector, and saved Project/chat routes.

Both forms install or update the one global Skill and pinned official OpenAI
Secure MCP Tunnel client, store configuration in protected machine state, and
start the tunnel-owned child. First-time setup copies the supplied runtime key;
reuse mode leaves the protected installed key in place:

```text
c2c serve-machine --stdio --port 0
```

Each device has one connector association; one ChatGPT account may contain
several devices' connectors. Bind each device's exact app separately:

```text
Name:           <this device's exact ChatGPT app name>
Secure Tunnel:  the tunnel configured above
Authentication: None
```

Select the configured tunnel in ChatGPT; there is no public server URL to copy.
Do not put a runtime key, admin token, or capability token in Project
instructions, source files, prompts other than the current `CONTEXT_ID`, or
logs.

After creation or a tool/schema update, inspect the existing app's task-needed
tool contracts while the gateway is healthy. If the actual UI offers Refresh
and discovery needs updating, use it once and recheck. Do not assume a fixed
Manage > Refresh path exists, or treat opening Manage as proof of refresh.
Restarting the Tunnel alone is not evidence that ChatGPT discovered new schemas.
Confirm required read tools and input contracts; callback tools are intentionally
absent in Computer Use mode. A scoped real read validates transport separately
from catalog visibility. If contracts remain unavailable or stale, report that
specific limitation without recreating apps or changing permissions/providers.
This is machine-wide discovery, not per-workspace installation.

On macOS, enable machine autostart once after setup and verify it:

```sh
c2c autostart enable --json
c2c autostart status --json
```

The LaunchAgent invokes hidden `c2c autostart run --quiet`. That command only
calls `ensureMachineGateway` and reuses the official Tunnel-owned
`serve-machine --stdio` child. It never starts a workspace-specific gateway or
another Tunnel. Disable it with `c2c autostart disable --json`.

## Workspace registration

### Device connector binding

Routing starts above the workspace: device identity → configured Tunnel → exact
ChatGPT app → local workspace/Project → local session/Chat/owned tab. A product
name or matching repository on two computers is not a device selector.

After creating or choosing this device's app, record the user-confirmed exact
name once. Add its stable URL when it is observed in the UI:

```sh
c2c machine connector set --name '<exact app name>' \
  --plugin-url 'https://chatgpt.com/plugins/plugin_<observed-id>' --json
c2c machine connector get --json
```

The URL is optional when not exposed; do not invent it. If names are ambiguous,
obtain the exact app identity before dispatch. A name-only rename preserves a
known stable app URL; choosing a different app requires its new URL explicitly.
The binding lives in the private machine state directory, `machine/connector.json`,
and binds `machineId + tunnelId + associationId` to the app name and optional URL.
It is shared by all workspaces on this device and survives normal setup/updates.
Changing machine or Tunnel association makes it stale; resolve the mapping once
instead of guessing or copying another machine's state. Do not sync machine
identity, credentials, connector binding, or browser ownership files across devices.

Upgrades preserve old sessions but do not silently invent an app mapping.
If no binding exists, Codex records the user's already established device/app
choice with the command above. `control open` refuses local-MCP dispatch before
creating a request when the binding is missing/stale. No tunnel recreation,
per-project configuration, UI chip, login or service restart is needed to bind.
`session get`, `machine status` and setup output expose the binding status;
`control open` returns the exact target and includes it in the delivery prompt.
Old per-workspace `connectorName` values are historical mirrors, not routing
authority. Keep existing live requests on their original prompts; binding edits
apply to new requests. Do not downgrade the runtime/Skill to a version that
ignores device bindings.

`workspace_info` reports the serving server's `machineId` and `associationId`
after capability validation. Check them and the workspace identity before further
reads. These are actual server identity fields, not a claim that the server can
inspect ChatGPT's plugin registration. The configured URL/name guides app
selection; independent gateways reject each other's capabilities. A mismatched
or unknown target ends this attempt with BLOCKED instead of trying the token
against another device's app. Visible app selection remains optional. Results
still use Computer Use with the exact local request/page correlation.
For least-privilege turns without `workspace.read`, the generated contract skips
workspace_info and preserves the requested scopes; it still specifies the exact
target app, and that gateway validates its own capability before any scoped read.

### Register this workspace

Run workspace-scoped commands from the workspace root. The local harness
derives the trusted root from the current process `cwd`; an optional `-w` may
only resolve to that exact `cwd`, and cannot select another path.

The local harness registers the current workspace:

```sh
c2c machine workspace register --json
```

The response contains `workspaceId`, `projectId`, `registrationId`, and a
display name. The root is canonicalized locally. ChatGPT never submits a root
to select a different workspace; it only receives the workspace selected by
the local capability binding.

Next run `c2c surface get --local-session <local-session-id> --json`. A
non-null `projectUrl` is the machine-authoritative existing Project and must be
reused. Create a Project only when this value is null; never rediscover one by
display name.

Session-route, page-recovery mirror, execution and update-check state stays
inside the workspace repository boundary. Git checkouts use
`<git-common-dir>/codex-with-chatgpt`; non-Git workspaces use
`<workspace-root>/.codex-with-chatgpt`. The protected machine state directory
owns the authoritative mailbox, runtime configuration, and cross-workspace
Project URL, physical-tab and generation records. A workspace mirror is never
imported into that authority.

Unregister requires all three registration identities:

```sh
c2c machine workspace unregister \
  --workspace-id <workspace-id> \
  --project-id <project-id> \
  --registration-id <registration-id>
```

Unregistering revokes turns for that registration. A fresh registration is
required before the workspace can receive another turn.

## Surface lease contract

### Browser tab identity

Persist a provider's stable, resolvable tab identity in `tabId`. In the in-app
browser, use the returned `providerTabId`, including its namespace (for example
`browser-use:fc6c0073-5fb5-4a4e-81f7-307535575b6a`). Task-local short indices such
as `2` can identify different pages in different Codex tasks and must not be
used for new machine-wide claims. Resolve the exact provider ID with
`cua.getTab(providerTabId, { browser: "iab" })` and verify the candidate URL
before claiming. Carry that same string through claim, BOOT, observations,
commit, renewal and replacement; never strip a prefix or invent an ID.

Tab locators have separate bounded validation from path-safe C2C request and
session IDs. Existing saved IDs remain readable and unchanged. For a legacy
short-ID binding, a successful lookup or URL match alone does not establish
stable identity across tasks: use guarded replacement with its saved exact
generation and old ID if continuity cannot be proven. Do not clear a conflicting
owner or migrate another session's record to make a claim succeed.
Older runtimes cannot read namespaced locators; keep the upgraded runtime and
Skill together once these bindings exist rather than manually downgrading one.

### First Project selection

An unpaired workspace must create its own Project through the host browser UI,
or use an exact existing URL explicitly selected by the user. A sidebar title,
foreground page, checkpoint URL or successful MCP workspace read does not prove
that selection. Add this fresh host observation to the first claim:

```sh
c2c surface claim --local-session <id> --tab-id <returned-tab-id> \
  --project-url <observed-project-url> --project-selection '<selection-json>' --json
```

```json
{
  "source": "created",
  "projectUrl": "https://chatgpt.com/g/g-p-.../project",
  "observedTitle": "<workspace.name>",
  "observedAt": "<current-ISO-timestamp>"
}
```

`source: user-confirmed` is reserved for a real user choice of that exact URL;
it permits a different display title. Creation must have the expected workspace
title. Observations expire after five minutes for new claims. The Gateway rejects
missing/mismatched evidence before BOOT and stores accepted evidence inside the
machine-owned candidate lease, scoped by its owner/session/tab/generation.
Commit requires that recorded candidate evidence for a first association. An
interrupted candidate can resume; it does not become a durable Project until
BOOT and commit. Existing authoritative associations retain their exact URL.

This is a trusted-host observation contract, like `surface check`, not an
independent browser proof. The host must never manufacture the observation.
The existing machine-wide uniqueness locks also reject a Project reserved by
another workspace. On a conflict, inspect the winner and wait for its pairing;
do not relabel, move chats, or adopt an unrelated Project to bypass the conflict.

One local session first claims a temporary lease for the candidate ChatGPT
page after opening the correct Project collection in the built-in browser. A
new Project chat does not have a `/c/` URL yet, so `chatUrl` is optional during
claim:

```sh
c2c surface claim \
  --local-session <local-session-id> \
  --tab-id <exact-tab-id> \
  --project-url <project-url> \
  --json
```

When re-entering an existing session, include its saved `--chat-url`. For a
new session, the lease is a Project-only candidate:

The lease stores:

```json
{
  "projectId": "...",
  "localSessionId": "...",
  "browserId": "iab",
  "surfaceId": "chatgpt",
  "tabId": "...",
  "projectUrl": "https://chatgpt.com/g/g-p-.../project",
  "chatUrl": "https://chatgpt.com/g/g-p-.../c/...",
  "generation": 1,
  "ownerProcessEpoch": "...",
  "expiresAt": "..."
}
```

The claim does not write a durable Project/chat binding. Open a BOOT control
request and capability using the current candidate lease. BOOT is the only
phase that may use a candidate lease without a chat URL:

```sh
c2c control open \
  --local-session <local-session-id> --task <boot-task-id> \
  --iteration 0 --phase BOOT \
  --scopes workspace.read --ttl-ms 300000 --json
```

The returned request records the exact candidate `surfaceGeneration` and
`surfaceTabId`. Both must match at commit; a retained pre-v2 request whose tab
identity is unknown remains readable but cannot authorize a BOOT route. ChatGPT
calls `workspace_info`, performs the bounded read, and only after all expected
IDs match ends the exact response with `C2C_HOST_OBSERVED_RESULT`, the request
ID, and `{"kind":"BOOT","payload":{}}`. After Computer Use validates that
exact result and the browser has created the first
chat, read the exact resulting `/c/` URL. It must belong to the claimed Project.
Commit the candidate with that request and observed URL. Only commit creates the
durable binding and saves the session route:

```sh
c2c surface commit \
  --local-session <local-session-id> \
  --generation <generation> --tab-id <exact-tab-id> \
  --boot-request <boot-request-id> \
  --chat-url <observed-chat-url> --json
```

Commit rejects a missing, pending, `BLOCKED`, failed, expired, wrong-session, or
wrong-generation BOOT result. On success it revokes residual BOOT authority.
Uncorrelated page text cannot authorize a route.

Until this commit succeeds, no non-BOOT turn may be issued for the candidate.
When the candidate already has a `chatUrl`, commit must preserve that exact
canonical chat. A different chat inside the same Project still requires explicit
replacement with a fresh generation. Only a Project-only candidate learns its
first chat URL during commit.

On verification failure, cancel the BOOT context and release the candidate
instead. `generation` starts at 1 and increases on exact replacement. A replacement
must provide `--replace-generation` and `--replace-tab-id` equal to the
currently stored binding, including after its active lease expires or is
released. An old owner, different Project, or different chat URL cannot rotate
the page.
Renew the lease after long waits:

```sh
c2c surface renew \
  --local-session <local-session-id> \
  --generation <generation> --tab-id <exact-tab-id> --json
```

Release uses the same exact `--generation` and `--tab-id` pair. A delayed
renew or release for an older generation is rejected instead of touching the
replacement page.

Release is temporary and retains the durable route. Permanently retiring a
local Codex session is an explicit operation:

```sh
c2c surface retire --local-session <local-session-id> --json
```

Retirement revokes that session's live contexts, closes its active control
request, removes its page lease
and binding, and deletes its checkout route. It does not remove the workspace's
machine-authoritative ChatGPT Project binding while another checkout remains.

### Host CUA execution

These are Skill execution steps performed by the host CUA runtime. The
TypeScript CLI cannot invoke `cua` directly; it persists and validates the
surface lease that the Skill uses.

The progress page is session-scoped. Keep its exact tab/chat across tasks,
RESEARCH/PLAN/REVIEW and context renewal. Call `tab.markHandoff()` on that same
page at each turn's start/end; a mark is not ownership evidence. Do not allocate
another page, repeat BOOT, or retire/release the route merely because a healthy
task finished. Independent sessions retain independent progress pages.

For C2C, ordinary discovery may use the current chat's picker or prompt-directed
tool discovery in the normal correlated request. A visible app selection is
optional; do not open the catalog solely because a chip or picker entry is absent. Any
exceptional settings or pre-send recovery probe helper is hidden, turn-local and unmarked, with its exact
creation handle retained by the host. Close it after use/failure only after a
fresh check confirms it remains that helper and has not been taken over. Never
close user pages, current progress/candidate pages, another session's pages, or
unrecorded historical tabs. There is no persistent helper cleanup service or
ownership inference from title/URL; interrupted cleanup with uncertain ownership
is reported. A successful new progress candidate alone receives the handoff mark.

When a session has a saved route, the first browser operation is always the
exact-tab lookup:

```javascript
const tab = await cua.getTab(tabId, { browser: "iab" });
```

Validate the returned current URL against the saved `projectUrl` and `chatUrl`.
A saved route without a `tabId` is invalid for browser routing and follows the
same replacement branch; it is never a reason to select a tab by URL.
If the call fails, the tab is closed, or the URL is not the saved Project/chat,
create a hidden replacement only for this `localSessionId`:

```javascript
const replacement = await cua.createBrowserTab("iab", targetUrl, { visible: false });
```

Use the saved chat URL when present, otherwise the Project URL. Claim the
returned stable provider tab id (see "Browser tab identity") with the session's `--local-session`; if a lease is
stored, provide its exact current `--replace-generation` and
`--replace-tab-id`. Re-read that exact id with `getTab` and validate the URL
before sending. With no saved route, create a hidden Project candidate with
`createBrowserTab("iab", projectUrl, { visible: false })`, claim it for this
session, create the chat through semantic DOM operations, verify its resulting
chat URL, and commit the route. Never choose an existing tab by URL, title,
recency, or foreground state, and never reuse a user's ordinary ChatGPT page.

For every normal control turn, repeat `getTab` on the stored exact `tabId`
before sending and verify the Project/chat URL. Send through semantic DOM
operations while the page remains in the background, then call `getTab` on the
same exact id again and verify the URL before accepting the send or waiting for
the result. Do not pass `visible: true` or focus the page for this normal path.
Only login, CAPTCHA, 2FA, or explicit consent may temporarily make a page
visible; return it to the background and repeat both checks after the user
action. Screenshot-coordinate operations are not allowed for routine navigation
or submission.

## Page recovery

The host owns browser observation and creation. The CLI cannot call the host's
Computer Use runtime, and the Gateway cannot infer archival from a route file.
Login is user-operated. On an authentication screen, report the observed login
entry or relevant service URL and the required user action. Do not initiate or
submit login, enter account identifiers/passwords/verification codes, retrieve
saved credentials, solve CAPTCHA or switch accounts. Leave consent and permission
prompts to the user too. After the user reports completion, recheck the exact page,
identity and live authorization; preserve task progress without reusing expired
capabilities. App-picker visibility alone is not an authentication failure.
After resolving the exact `tabId`, inspect its semantic state and pass the fresh
observation to:

```sh
c2c surface check --local-session <id> --tab-id <id> --generation <n> \
  --page-state <state> --observed-url <url> --json
```

| Observed state | Action |
| --- | --- |
| Ready composer in the exact committed chat | Resume if the mailbox has no unresolved request |
| Exact tab missing/closed, or URL changed | Reopen the saved chat in a hidden owned candidate |
| Explicit archived/unavailable conversation at the exact saved chat URL | Create a new chat in the same owned tab from the saved Project URL, with a fresh generation |
| C2C picker entry or selected-app chip missing | Keep the chat; attempt the normal authorized request with prompt-directed tool discovery |
| Explicit chat-specific tool unavailability confirmed, and same-Project replacement capability established | Resolve the request, then use guarded same-tab recovery; UI absence alone never establishes this state |
| Login, CAPTCHA, 2FA, consent | Show the observed entry or service URL; the user completes login/consent, then the host rechecks the same page |
| Loading/generating | Wait with bounded backoff and lease renewal |
| Inconclusive UI or absent route | Inspect/pair; do not infer archived or deleted |

`--page-state` is one of `ready`, `archived`, `unavailable`,
`connector-unavailable`, `missing`,
`auth-required`, `consent-required`, `loading`, `generating`, or `unknown`.
Omit the observed URL only for a missing tab or an inconclusive/loading probe.
Stale tab/generation observations fail. The check is not a persistent attestation:
the host must recheck immediately before and after each send.

`connector-unavailable` must not be inferred from a missing picker entry,
selected-app chip or empty search result. On a healthy authorized route, first
allow prompt-directed discovery in the normal correlated request, as described
in "Result delivery preflight". Successful tool use keeps the original chat
regardless of the UI. A model-only unavailable claim is an unverified report,
not independent proof that the chat must be replaced.

Before probing a different composer, inspect the current control request. Do not
probe/rotate while it is generating or unresolved; first consume any durable
result and preserve progress. Only after explicit chat-specific tool
unavailability is confirmed independently of picker visibility,
the host may create at most one hidden turn-local helper at the saved Project URL
to inspect its new-Chat composer. Retain its exact creation handle. Do not claim
it as a session page, send a message or deliver any capability to it. Reuse the
same semantic search, then close only this owned helper after a fresh ownership
check, also on failure. Never navigate the old progress tab to obtain this proof.

Use at most one recheck for ambiguous helper observations. If still inconclusive,
end the recovery inspection with a diagnostic and preserve the original route.
A new composer's picker can corroborate availability but cannot by itself prove
the old chat is broken. Only confirmed chat-specific failure plus established
same-Project replacement capability allows `connector-unavailable`. Re-resolve
the old exact tab, URL, generation and active request before reporting it.
No message is sent in the helper. This flow never retries or routes around a
platform-refused task; a discovery inspection bound is not a generation deadline.

The decision also returns `tabAction`: `keep` retains the exact tab,
`navigate-owned` rotates its chat in place, `create` allocates one hidden
candidate, and `inspect` authorizes neither navigation nor allocation. An expired
or restarted lease on a still-live matching page uses `keep` with reclaim/BOOT
as needed. A mismatched URL, including a redirect home, does not establish that
the saved chat is unavailable: preserve the navigated page and recheck the saved
chat in the bounded replacement. A Project-only candidate's unavailable state
requires inspection; it is not evidence that a session chat was archived.

Before replacing a page, read the active `control` in `surface get/check`.
Preserve any verified Computer Use result in the local checkpoint. Cancel only
the exact still-pending request on a confirmed page failure. The Gateway blocks
generation rotation while work is unresolved. Idempotent claims of the same live
lease remain allowed.

For `navigate-owned`, first claim a Project-only candidate with the **same**
tab ID, no chat URL, and the latest exact replacement tab/generation. After the
claim succeeds, navigate this owned tab to the saved Project and run the existing
BOOT/commit sequence. This revokes old contexts before navigating and changes
generation/chat, not tab ID. For `create`, create one hidden candidate at the
returned target and claim it with the same replacement guards. A lost tab
reuses the original chat; a confirmed archived/unavailable/connector-unavailable
chat gets a new chat in
the same Project. Do not unarchive automatically. After an interrupted claim,
reuse the recorded candidate and repeat verification before committing. Failed
verification releases only that candidate. A second recreation failure stops the
episode with a concrete diagnostic; it does not create an unbounded series of chats.

Recovery preserves localSessionId, task, iteration and checkpoint progress; it
does not use session retirement (which intentionally discards received results).
Successful rotation revokes previous live contexts and existing generation guards
reject late reads/results. Save the new route only after BOOT verification and
issue a new control context only for the remaining question. Loading, generation
or a wait-slice timeout alone must not trigger cancellation or replay.

The current page model is the default. Observe the selector's label; neither
`modelId` nor `effort` changes the webpage. An explicit user model/effort request
requires semantic selection and verification before sending. Do not assume a
historical conversation automatically switches to the latest model.

## Session contract

Read the session route at the beginning of a local task, and re-read the current
surface lease before every normal control turn:

```sh
c2c session get --local-session <local-session-id> --json
```

The result includes `sessionIdentity`, `conversation`, `route`, and `surface`.
The route must identify the Project collection and this session's saved chat.
The first session in a workspace creates a Project; each later local session
creates a new chat from that Project collection page. Never reuse another
session's chat URL.

The pre-send surface check must use the host CUA procedure above; an initial
route snapshot is not sufficient for a later turn.

For a newly paired or replacement candidate, persist only the validated URL
after Computer Use validates its exact BOOT result:

```sh
c2c surface commit \
  --local-session <local-session-id> \
  --generation <generation> --tab-id <exact-tab-id> \
  --boot-request <boot-request-id> \
  --chat-url <observed-chat-url> --json
```

If the page validation fails, keep the old pointer and do not send a control
message.

`c2c session set` updates task and checkpoint metadata only. It cannot accept or
persist `--url`, `--project-url`, `--connector-name`, or `--mode`; only the
verified `surface commit` operation may write the Project/chat route. Route
fields that appear inside a checkpoint remain mirrors of the committed route
and are never promoted to top-level session routing.

## Delegation capability gate

`CHATGPT_FIRST` applies to evidence-closed subtasks, not to broad business task
names. Before creating a mailbox request, the host must map every required input
and operation to a currently available page capability, C2C read tool, or
approved read-only plugin operation.

Supported delegation inputs are:

- ChatGPT-native Web Search and external HTTP(S) sources actually consulted.
- Bounded reads and searches in the currently registered workspace.
- Current Git working-tree comparisons: unstaged, staged, or working tree versus
  `HEAD`.
- Execution records and bounded output already registered for the exact local
  session, task, and iteration.
- Task-scoped, preflight-approved third-party read operations.

The host must not delegate operations that require arbitrary commit/ref/PR or
merge-base resolution, historical source snapshots, another workspace,
sensitive files, local writes, commands/tests, Git or PR mutations, deployment,
account/permission changes, credentials, or final execution verification.
Instead, split mixed work: Codex gathers and verifies local evidence, ChatGPT
analyzes the evidence-closed question, and Codex executes and verifies the
result.

For a historical Git review, Codex may create a bounded workspace artifact only
after resolving the requested ref and parent and verifying that it contains the
complete changed-file list and diff. ChatGPT may review that artifact, but it
does not resolve the ref, approve deployment, or claim that commit-matched source
is available unless the host provided and verified it. If the evidence cannot
be made complete, keep the review local and do not open a control request.

Known missing capability or evidence is a host preflight failure, not a reason
to create a request that is expected to return `BLOCKED`. `BLOCKED` remains the
terminal result for a gap discovered after otherwise valid delegation.

## Capability contract

For a control turn, the harness opens a correlated request and issues a capability
with the same correlation:

```sh
c2c control open \
  --local-session <local-session-id> \
  --task <task-id> --iteration <n> --phase <RESEARCH|PLAN|REVIEW> --json
```

The response contains `RESULT_REQUEST_ID`, `CONTEXT_ID`, expiration, exact
`tabId`, the surface `generation`, `resultTransport: "computer_use"`, and
`resultContract` (current-phase payload examples and dispatch instructions).
The capability is bound to:

```text
workspaceId, projectId, registrationId
localSessionId, taskId, iteration, phase
requestId (required for every phase, including BOOT)
compactionEpoch, generation, scopes, bootEpoch
```

Use least-privilege scopes after the delegation gate passes. Web-only research
needs no local MCP scope; workspace analysis adds `workspace.read` and
`workspace.search` plus `git.read` only when current Git state is relevant;
execution review adds `execution.read` only when a matching record already
exists. A scope authorizes a supported tool but does not create missing evidence
or add arbitrary-ref Git access.

To cancel before expiry:

```sh
c2c control cancel \
  --local-session <local-session-id> \
  --request <request-id> --task <task-id> --iteration <n> \
  --phase <phase> --json
```

Cancellation uses the exact request correlation to revoke every matching live
capability. A healthy gateway returning zero matches is still a successful cleanup;
this covers a crash before capability issuance and a gateway restart. If the
managed gateway is stopped, start it and then cancel through its authenticated
admin endpoint. An uncertain gateway state refuses to touch the mailbox. A
request that is already open is never silently replaced: inspect or cancel it
before opening another.

## MCP request contract

### Plugin dispatch preflight

One C2C connector remains sufficient for local workspaces. ChatGPT's other
plugins are separate app transports and are not exposed or authorized by the
C2C tunnel. Select only task-needed installed plugins that are callable in the
owned Project Chat. Catalog installation and Work-mode trial links are not
evidence of Chat-mode availability. Do not switch modes, reconnect, install apps,
or authorize external writes automatically.

For GitHub, first run `c2c repository-identity --json` locally. It resolves the
branch push remote / `remote.pushDefault` / branch remote / origin, in that order,
unless `--remote` is explicit. It resolves SSH host aliases, lists sanitized fetch
and push targets, and probes the effective `gh` actor for github.com only. Multiple
push destinations and unsupported hosts remain unknown. Personal destinations
require the matching owner; organization destinations require verified read
access. Select the intended personal fork rather than treating upstream owner as
the author. Git author/committer are separate metadata; Git transport identity is
explicitly unknown and must be verified separately before a local push.

For a plugin-dependent control turn, add `--plugins '<id,...>'` and
`--plugin-preflight '<json>'`. Use the actual plugin IDs and observed state:

```json
{
  "workspaceId": "<workspace-id>",
  "localSessionId": "<session-id>",
  "taskId": "<task-id>",
  "iteration": 0,
  "phase": "PLAN",
  "tabId": "<owned-tab-id>",
  "generation": 1,
  "chatUrl": "https://chatgpt.com/g/g-p-.../c/...",
  "bootEpoch": "<current-gateway-epoch>",
  "observedAt": "<current-ISO-timestamp>",
  "chatgptAccount": "<host-observed-account-and-workspace-key>",
  "requestedOperations": [{"plugin": "GitHub", "tool": "<observed-read-tool-id>"}],
  "plugins": [{
    "id": "GitHub",
    "availability": "available",
    "usesGitHub": true,
    "tools": [{"tool": "<observed-read-tool-id>", "availability": "available", "effect": "read"}],
    "githubActor": {"login": "<observed-login>", "id": "123", "source": "authenticated-profile"}
  }]
}
```

Availability is `available`, `unavailable`, `work-only`, `consent-required` or
`unknown`, both for an app and for each observed tool. Ordinary task intent
requires explicit `requestedOperations` separately from observed `tools`.
Tool effects are `read`, `profile`, `write` or `unknown`; determine them from
actual exposed tool contracts, never their names. Only requested, available
`read` operations pass. The policy returns exact `allowedOperations`; it never
grants every tool from an app. A mixed read/write app may contribute its selected
reads without granting its writes. Missing, duplicate, wildcard, unrequested,
unknown-effect and unavailable tools are rejected. Every selected app must have
at least one requested operation. No app-wide compatibility path exists.

ChatGPT-native Web Search is distinct from installed apps and can be used for
RESEARCH without third-party grants. Codex plugin installation does not install
that plugin in ChatGPT. If an allowed operation disappears or fails, return it
as unavailable in the correlated Computer Use result. Do not open a trial tab, change
mode/model, or substitute another app; a new selection requires fresh preflight.
Unrelated C2C-only tasks remain usable in the same progress page.

Bundles with GitHub dependencies set `usesGitHub: true`. The host must
obtain login and stable ID from an authenticated own-profile tool in this chat;
connection emails, display names, installed-account lists and local `gh` output
do not establish the plugin actor. Without a profile tool, stop before repository
operations. To discover an initially unknown identity, open a separate `RESEARCH`
turn with `--plugin-intent identity-discovery --plugins <one-GitHub-plugin-id>`.
Its fresh preflight includes the actually exposed `authenticatedProfileTool`
name in the plugin entry, with `availability: available` and `usesGitHub: true`;
`githubActor` may be absent. The tool's observed contract must return the
authenticated caller's own profile, not accept a chosen account or repository.
Do not invent a tool name or supply business `requestedOperations` in discovery.
This mode emits `access: authenticated-profile-only`,
the exact one-tool `allowedOperations`, and `repositoryAccess: none`.
No C2C scope is granted; additional scopes are rejected. No repository
reads/searches, other app data or writes are permitted. Return the observed
login/stable ID in the final Computer Use marker, persist that verified result,
then use a **new** business-turn request and fresh matching evidence. An empty
ordinary plugin allowlist does not imply a discovery exception.

For ordinary `--plugin-intent task` (the default), the CLI injects fresh
`github: {repository, expectedActor}` from the selected
local remote (`--github-remote` when explicitly needed). A supplied repository
must match it. Owner API callers provide that same trusted-local snapshot. Both
CLI and Gateway check the exact task, session, page/generation, boot epoch, selected
plugin set and five-minute freshness before issuing a plugin-dependent turn.
The CLI rejects before opening a mailbox when preflight fails. Read/status/ack and
ordinary C2C-only work remain usable. Include returned `pluginPolicy` in the prompt:
no unlisted plugin, only scoped reads in the selected repository, and no writes.

These are host dispatch checks, not independent browser/account attestation or a
permission sandbox for third-party tools. Re-observe immediately before use and
after account, model, page or connection changes; never reuse another chat's proof.
Provider/platform controls still own permission enforcement. Do not claim all
plugins work with every model, or that a particular GitHub plugin is universally
read-only: inspect its actual exposed tools and retain C2C's read-only policy.

Every ChatGPT MCP call includes the tool's normal arguments plus:

```json
{
  "context_id": "c2c_ctx_<43-url-safe-characters>"
}
```

The context id is not optional, and it is not inferred from a Project URL or
current browser tab. The gateway validates it before reading any path. It then
claims and renews an activity lease. The tool releases the lease when it
returns, including errors.

Production tools are read-only workspace tools:

```text
workspace_info
list_directory
read_file
search_workspace
git_status
git_diff
test_status
execution_summary
execution_output
```

The retained mailbox callbacks `get_control_result_status`,
`report_control_progress`, and `submit_control_result` are intentionally not
registered while the active result transport is `computer_use`.

## Result delivery preflight

Machine health, tool availability, a successful read and accepted result delivery
are separate. Before sending, verify the exact owned chat URL and authorization.
A visible C2C chip or picker entry is optional, not a dispatch prerequisite.
If available, the host may select the existing connector for convenience;
absence or loss of that visual selection does not require manual intervention.

Send the normal correlated request once, naming its bound device connector and
asking ChatGPT to discover that app's C2C tools with the supplied context_id.
For workspace tasks, request workspace_info first and verify the expected
machine/association and workspace/project identity before further reads. Add this to the existing
BOOT/task question, not as a second message or a repeated BOOT. A healthy
connection with unknown UI visibility permits this bounded discovery; known
authorization failures do not. Web-only work needs no connector read.

Actual tool invocation and its returned result establish read capability, not
a chip or a model's unsupported claim. Record model-only reports as unverified.
Use the correlated Computer Use result for completion. If required tools cannot
be discovered/called, return BLOCKED under the same result contract. Do not
retry a platform refusal, switch accounts/apps/chats or weaken authorization.

`control open --json` returns a ready-to-send `deliveryPrompt` containing the
exact correlation, all `resultContract.instructions`, and phase examples.
Include it verbatim with the actual task question in the exact owned message;
do not drop the refusal/failure result branch when shortening prompts. This
text contains the capability, so send it only to that page, never to logs or
public artifacts. The structured `resultContract` exposes the same instructions.
ChatGPT must end the exact response with `C2C_HOST_OBSERVED_RESULT`, the exact
`RESULT_REQUEST_ID`, and one phase-valid `{kind,payload}` object. Computer Use
extracts only that marker from the exact bound response. The host validates tab,
chat, generation, response identity, freshness, request, phase, schema, and
payload size before accepting it.

Every delivery prompt declares `RESULT_TRANSPORT: COMPUTER_USE_ONLY` and
`MAILBOX_CALLBACKS: DISABLED_EXPECTED`. Those declarations override earlier C2C
mailbox directions in the same conversation. The absence of
`get_control_result_status`, `report_control_progress`, and
`submit_control_result` is expected, is not a blocker, and must not be reported
as `BLOCKED`. The page marker itself is the delivery; there is no mailbox receipt.

Unavailable read tools, explicit platform rejection or required approval stop
business work. ChatGPT returns `BLOCKED` in the same final marker. Record phase,
request ID, timestamp and sanitized observed error/trace;
distinguish actual MCP error evidence from a model-reported error. Do not infer
that missing selection caused a rejection, or that a safety check came from
C2C. Do not bypass platform checks, change read/write annotations, switch
accounts/models/apps, or treat arbitrary browser text as a result. Do not cancel
merely for a generation timeout. After resolution, use a fresh control request
and context, not a resend of failed authorization.

## Result payloads

The final page marker contains only the exact `RESULT_REQUEST_ID` and one
`{kind,payload}` object. The control request and verified page observation
supply workspace, local session, task, iteration, phase, tab, chat, generation,
and response identity. Extra marker objects or mismatched correlation are rejected.
`resultContract.examples` contains schema-valid scaffolds for all allowed kinds
of the requested phase. Replace their placeholders with actual findings. They
are not evidence and must never be submitted verbatim as a successful answer.

BOOT accepts only `BOOT` or `BLOCKED`. A successful BOOT result is exactly:

```json
{"kind":"BOOT","payload":{}}
```

The empty payload is intentional: the capability already binds the workspace,
Project, session, request and candidate generation. BOOT is accepted only after
the prompt-directed workspace checks and exact Computer Use observation.

Local-only RESEARCH needs no external URL:

```json
{
  "kind": "RESEARCH",
  "payload": {
    "question": "What is the sum in the local fixture?",
    "summary": "17 + 25 = 42",
    "conclusions": ["fixture.txt:1-4 contains 17 and 25; their sum is 42."],
    "sources": [],
    "openQuestions": []
  }
}
```

This is only a shape example; use the file and values actually read. `sources`
contains external sources actually consulted, with `title`, `url`,
`publishedDate` (real `YYYY-MM-DD` or `null`) and `keyEvidence`. Only HTTP(S)
URLs without credentials are accepted. Cite local paths/lines in `conclusions`,
not as `workspace:/`, `file://`, or invented public URLs. Empty `sources` is
valid; empty `conclusions` is not. Web research still cites its real sources.

Business refusal, missing input and inability to finish return terminal
`BLOCKED` in the same final Computer Use marker. ChatGPT must include it in the
first final page reply and must not wait for the user to interrupt, send another
message, or request a callback. There are no progress callbacks. An explicit
safety or approval block on a required read is reported as `BLOCKED`; do not try
another tool, channel, app, or account to bypass it.

`BLOCKED` uses `payload: {"reason": "<observed blocker>", "needs": ["<needed action>"]}`
and the original request phase. It does not use the RESEARCH payload shape.
PLAN accepts PLAN/BLOCKED; REVIEW accepts REVIEW/DONE/BLOCKED. Use DONE for
a clean review instead of inventing findings to populate a REVIEW payload.
New results are limited to 16 KiB of canonical UTF-8 JSON, with tighter text
and list limits; `BLOCKED.reason` is at most 600 characters and `needs` contains
at most five items of 240 characters. Reject overflow rather than truncating it.
Previously accepted mailbox results retain their original 32 KiB read limit.
They are historical data and are not the active transport.

Acceptance requires `pending -> cancelled + hostObservedResult`, with
`wait.delivery: computer_use`, for each exact request. Test consecutive messages
in one chat and concurrent requests in separate workspaces, not only a first
read. Local SDK tests do not certify ChatGPT page behavior. Keep
installed/healthy/readable and live round-trip verification distinct.

## Boot prompt

Open a BOOT request for the claimed candidate and send its returned
`deliveryPrompt` verbatim in Chat mode. Append only the expected workspace ID,
Project ID and workspace name, plus the task-specific check: call
`workspace_info`, compare those values, and read one non-sensitive top-level
hello-style file before returning BOOT. A required read or identity failure
returns BLOCKED through the generated contract. Do not append another delivery
template or send a second identity-check message.

Only after Computer Use validates BOOT in the exact correlated response and the
independently observed Project/chat URLs match the selected Project may the host
commit the route. A page claim about success without protocol validation is not
delivery. Callback tools are intentionally absent in this mode.

Surface commit is a durable, idempotent sequence, not an indivisible filesystem
transaction. After partial local failure, replay the same candidate, BOOT
request, generation, tab and observed chat URL to finish cleanup. Do not create
another BOOT request or result.

## Control prompt

Use `control open`'s `deliveryPrompt` as the single delivery template. It supplies
the request/context/session/task/iteration/phase correlation, Computer Use-only
transport, schema examples and proactive BLOCKED output. Append only the concise
task, bounded evidence paths and any required `pluginPolicy`. Do not paste source,
diffs, logs or credentials, duplicate the protocol fields, or restore callback
directions from older conversation messages.

Choose an evidence-closed task as described in "Delegation capability gate".
For external facts, ask for actually consulted HTTP(S) sources. For local-only
RESEARCH, use `sources: []` and relative file/line citations in conclusions.
For execution review, identify the registered record and supported working-tree
comparison; scope grants do not create missing evidence.

The policy delegates thinking, not execution or additional permissions. Codex
validates the exact page result, implements changes and verifies local outcomes.

## Dormant mailbox protocol

The mailbox callback implementation below is retained for comparison and tests,
but production does not register or call it while `resultTransport` is
`computer_use`. Do not run `control ack` in the active flow.

The lifecycle is:

```text
pending -> received -> acknowledged
       \\-> cancelled
       \\-> expired
```

Wait for one exact request:

```sh
c2c control wait \
  --local-session <local-session-id> \
  --request <request-id> --task <task-id> --iteration <n> \
  --phase <phase> --json
```

Then acknowledge it:

```sh
c2c control ack \
  --local-session <local-session-id> \
  --request <request-id> --task <task-id> --iteration <n> \
  --phase <phase> --json
```

This dormant lifecycle remains tested but is not used by production. In the
active flow, do not send the next question until the exact request has a
verified Computer Use result, is cancelled, or expires. A wait timeout is not
permission to resend while the page is generating.

The normal mailbox lifecycle is locked per `localSessionId`; `open`, `ack`,
`cancel`, and result writes do not acquire a workspace-wide lifecycle lock or
queue other sessions. Pruning uses a separate short maintenance lock and
processes each session independently. The surface metadata ownership lock is
only a brief atomic uniqueness guard for lease commits and replacements; it
does not limit or serialize browser turns.

## Waiting and terminal observations

The exact Computer Use page observation is authoritative for active results.
A successful read or uncorrelated final page message is not delivery. Pending
means only that no validated result has been accepted; it does not establish
that ChatGPT is still generating.

`control open`, `status`, `wait` and `observe` return a `wait` policy:

| Field | Meaning |
| --- | --- |
| `leaseExpiresAt` | Current activity lease expiry; fresh generating observations renew it |
| `leaseRemainingMs` | Remaining activity lease, not a total task budget |
| `elapsedMs` | Time since original request creation, for diagnostics only |
| `checkPageAfterMs` | At most 30 seconds; earlier at half the remaining activity lease |
| `outcome` | `pending`, `delivered`, `blocked` or `terminal` |
| `delivery` | `computer_use` or `none` in the active mode; `mcp` exists only for dormant mailbox tests |
| `nextAction` | `mark_send_attempted`, `confirm_send`, `inspect_response_start`, `inspect_exact_response` or `stop`; `persist_then_ack` is dormant |

`control wait` caps each slice at 30 seconds even if a larger `--timeout-ms`
is supplied. Exit code 0 means a Computer Use result was validated, including a
business refusal; it does not mean the business task succeeded. Code 1 means
no result was validated; inspect the structured status. There is no fixed total task
deadline: a half-hour or longer task continues automatically while the host
observes the exact response still working. A wait slice is not a failure and
never requires the user to interrupt or send a continuation message.

After a pending slice, the host uses the exact saved `tabId` and verifies its
Project/chat URL. Through semantic CUA operations, locate the user prompt with
this `RESULT_REQUEST_ID` and inspect its paired assistant response, not the
last page message or a full-page keyword search. Only a completed response's
explicit terminal status or an explicit platform send/response error is
failure evidence. Quoted old BLOCKED text, a loading page, continued generation,
or the temporary absence of an assistant response is not such evidence.
Ambiguous UI remains `unknown` and is rechecked.

Each request has a monotonically increasing `observationSequence` and one exact
response identity. The normal ordered lifecycle is:

```text
send_attempted -> sent -> response_created -> generating* -> final
       \-----------------> response_start_failed
                       \-> response_start_failed
```

`response_start_failed` requires an explicit error attached to this send and
never means merely "no response is visible yet". `unknown` records an ambiguous
check without advancing the last definitive state or changing its required
next action. `page_lost` and `authority_invalid` may terminate from any stage. An
exact replay is idempotent; a conflicting sequence, lower sequence, skipped
transition, or different `responseId` is rejected.

For fresh ongoing activity or a confirmed final result/failure, the host submits an
observation locally:

```sh
c2c control observe \
  --local-session <localSessionId> \
  --request <request-id> --task <task-id> --iteration <n> --phase <phase> \
  --page-observation '<observed-json>' --json
```

`<observed-json>` has this shape. Replace values with the real host observation;
this example is neither a probe nor evidence:

```json
{
  "tabId": "owned-tab-id",
  "generation": 1,
  "observedUrl": "https://chatgpt.com/g/g-p-example/c/chat-example",
  "observedAt": "2026-01-01T00:00:00.000Z",
  "responseToRequestId": "request-id",
  "observationSequence": 5,
  "responseId": "host-response-id",
  "state": "final",
  "responseIsFinal": true,
  "delivery": "computer_use",
  "terminalResult": {
    "kind": "PLAN",
    "payload": {
      "goal": "Use the actual requested outcome",
      "rationale": "Use evidence observed by ChatGPT",
      "actions": [{"change":"Implement the verified action","why":"Meet the goal"}],
      "tests": [],
      "successCriteria": ["The requested outcome is verifiable"]
    }
  }
}
```

The CLI cannot operate CUA; the host must actually inspect the page before
calling it. The Gateway validates the exact request/session/task/phase, saved
tab/chat/generation, canonical chat URL and fresh timestamp (within 60 seconds,
not before the request). It does not independently verify the host's UI claim.
`responseToRequestId` means the host observed which prompt the response answers;
do not fill it from an unrelated page or a quoted request ID.

Those page, route, lease, and freshness checks gate only the first persistence
of an observation. Once a terminal Computer Use result or `hostFailure` is durable, an
exact terminal replay may bypass the current-page and 60-second gates solely to
finish observation and active-pointer cleanup after delay, restart, or route
replacement. Mailbox comparison must prove the replay matches the stored
stored result or failure exactly; it cannot refresh the event, renew access, or
reclassify the outcome. Plain
cancellation similarly revokes the exact request once its terminal marker is
durable, even if active-pointer cleanup fails and must be replayed.

All states include `tabId`, `generation`, `observedAt`,
`responseToRequestId`, and `observationSequence`. States observed on a live page
also include the canonical `observedUrl`. `response_created`, `generating`, and
`final` require the exact `responseId`; later events must keep that same value.
`send_attempted`, `sent`, and `unknown` are nonterminal. A fresh, newly ordered
`generating` observation renews the same live request and capability using the
original capability lease duration, and renews the exact owned surface. The
original request creation time, correlation, token, scopes and page generation
stay unchanged. Renewal is host-only; ChatGPT need not send a progress callback
or receive another message. Persisted request renewal is one atomic sidecar
under the session/request locks, shared by status, reopen, waiting and receipt
checks. It cannot revive expired, cancelled, revoked or completed authority.
Replaying the same observation does not move capability expiry forward again.

The host automatically repeats observe/wait for ongoing generation. `unknown`
and pending state alone do not extend authorization; recheck
ambiguous UI with backoff while the activity lease is valid. Without fresh
generating evidence the lease still expires, so an abandoned task cannot retain
local access indefinitely. Expiry, revoked authorization or gateway restart
ends this attempt without resurrecting the token or duplicating the task.
Preserve any already validated result before closing local failure state.

For a successful `final`, require `responseIsFinal: true`,
`delivery: computer_use`, and a `terminalResult` parsed from the exact marker.
It accepts only one current schema-valid `{kind,payload}` allowed by the original
phase. It must come from the exact response, never an older quoted reply.

For a final response with no valid marker, classify the host failure `reason` as
`model_refusal`, `tool_unavailable`, `platform_blocked`, `capability_invalid`, or
`callback_missing`. A still-generating or missing response is not completion
evidence. Other `source` values are
`model_reported`, `platform_error` or `mcp_error`; choose the latter two only
when the actual error was observed, not quoted by ChatGPT. Optional `tool` is
`report_control_progress`, `submit_control_result`, `get_control_result_status`
or `business_tool`; do not include personal connector names. Optional `errorCode`
is `TOKEN_REVOKED`, `TOKEN_EXPIRED`, `STALE_BINDING_EPOCH`, `TOOL_UNAVAILABLE`,
`SAFETY_CHECK_BLOCKED`, `APPROVAL_REQUIRED`, or `UNKNOWN`. Unknown causes remain
unknown. Raw excerpts and arbitrary error strings are rejected without echoing
them. No capability, key, cookie, or business payload belongs in a failure record.

`response_start_failed` is allowed after `send_attempted` or `sent`, records
`reason: response_start_failed`, `source: host_observed`, and requires
`evidence: explicit_send_error` or `explicit_response_error`. A missing response,
idle page, or one inconclusive check must use `unknown` and cannot cancel the
request. `page_lost` records the same-named reason without requiring a URL.
`authority_invalid` records
`reason: capability_invalid` plus `TOKEN_REVOKED`, `TOKEN_EXPIRED`, or
`STALE_BINDING_EPOCH`. The Gateway rejects this state while any matching
request capability remains live. These terminal observations stop only the
affected session and never create a result.

The authenticated host-only `/admin/mailbox/observe` endpoint is not an MCP
tool. Despite its retained route name, it is the active Computer Use result
ingress. A validated terminal result is stored as `hostObservedResult`; a page
failure is stored separately as `hostFailure`. The request is closed and its
exact capabilities are revoked. `result` remains null, no mailbox result ID or
receipt is created, and no acknowledgment is allowed.
Other sessions and task checkpoints are not changed. Terminal persistence is a
recoverable, idempotent transaction: once cancellation is durable, retries
finish the observation and active-pointer cleanup, while the Gateway revokes
the exact request capability even if a later local write fails.

The host then persists the failure checkpoint with `waitingFor: none` and ends
the failed attempt automatically. No user confirmation, interruption or extra
ChatGPT prompt is needed to record a failure. This does not imply successful
business completion or permission to retry a refusal. Ask the user only for an
actual required login, CAPTCHA, 2FA, consent or missing decision; never use
automatic recovery to bypass those gates or a platform safety block.

## Correlation and recovery

At every checkpoint compare:

```text
RESULT_REQUEST_ID
LOCAL_SESSION_ID
TASK_ID
ITERATION
RESULT_PHASE
CONTEXT_ID / generation
```

On compaction, increment `compactionEpoch` and issue a new context. On page
rotation, claim a new generation and issue a new context. On gateway restart,
wait for the new `bootEpoch`, re-register the workspace, and issue a new
context. Never reuse a stale capability.

Browser text is never accepted as an MCP control result. Only a schema-valid
terminal object paired to the exact response may be retained as separately
labelled host-observed evidence; it cannot become a receipt. Recovery resumes
or cancels the exact protected mailbox request and issues a fresh context when required.
