# Codex with ChatGPT

> ChatGPT thinks. Codex works.

Use ChatGPT web as the first-choice research, analysis, planning, synthesis, and
review partner for local Codex sessions. When the ChatGPT page or its read-only
MCP tools can answer a task, C2C delegates it there and returns a concise,
structured result through the machine mailbox. Codex retains all workspace
writes, shell execution, tests, git operations, and recovery locally.

## ChatGPT-first delegation

The default delegation policy is `CHATGPT_FIRST`:

- `RESEARCH` covers Web Search, current facts, external documentation, source
  comparison, and read-only workspace discovery.
- `PLAN` covers architecture, implementation options, migrations, API design,
  documentation, and other synthesis based on MCP reads.
- `REVIEW` covers recorded local status, diffs, tests, and bounded execution
  output after Codex has executed locally.

Web Search is a built-in ChatGPT capability rather than a Connector MCP tool;
the resulting answer still returns through `submit_control_result`. Control
prompts contain only the task goal and correlation fields. They never paste
repository contents, diffs, logs, credentials, or full command output.

## Machine-wide setup

The connection is configured once per machine:

- One connector named **`Codex with ChatGPT`**.
- Connector authentication is **`None`**. The official OpenAI Secure MCP Tunnel
  provides the authenticated transport; the connector does not contain a
  project-specific credential.
- The tunnel owns one `serve-machine --stdio` child. That child is the only
  MCP gateway and can serve every registered workspace on the machine.
- Each workspace maps to one ChatGPT Project. Each local Codex session maps to
  one persistent ChatGPT chat/page inside that Project.
- Browser operations target the exact owned `tabId`; a visible or recently used
  ChatGPT tab is never treated as the target by accident.
- The machine supports at most 100 unexpired session/page leases, counted by
  unique `(projectId, localSessionId)` identities, each representing one
  workspace-local session owner. Released, expired, and retired leases free
  capacity. Up to 100 different sessions can run independently; a claim for a
  new 101st session is rejected with a retryable capacity result and retries
  after capacity frees. Renewing, idempotently reclaiming, or replacing a page
  for an existing session reuses its slot. Only turns within the same local
  session are serialized, because one chat has one ordered conversation.

The design keeps the user's ordinary ChatGPT conversations separate. C2C owns
only the page recorded for a local session, and never takes over another tab.

## Install and setup

Requirements: Node.js 20 or newer, Git, and a ChatGPT account with connector
support. Install and build the repository:

```sh
corepack pnpm install
corepack pnpm build
```

Create or reuse an OpenAI Secure MCP Tunnel and run:

```sh
node bin/c2c.js machine setup \
  --tunnel-id <OPENAI_TUNNEL_ID> \
  --runtime-key-file <RUNTIME_KEY_FILE>
```

`machine setup` installs or updates the one global Skill automatically. There
is no per-workspace Skill installation step. Verify it at any time with
`c2c skill status --json`.

In ChatGPT connector settings create exactly:

| Field | Value |
| --- | --- |
| Name | `Codex with ChatGPT` |
| OpenAI Secure Tunnel | Select the tunnel configured by `machine setup` |
| Authentication | `None` |

ChatGPT selects the configured Secure Tunnel; there is no public Server URL to
copy or paste into the connector.

The runtime key is copied into the machine state directory and is never printed
or committed. The tunnel supervises the gateway, so do not start a second MCP
gateway for an individual workspace.

From the workspace root, register the current workspace when needed. Workspace
commands derive their target from `cwd`; an optional `-w` can only name that
same directory and cannot select another path:

```sh
node bin/c2c.js machine workspace register --json
node bin/c2c.js machine status --json
node bin/c2c.js machine doctor --no-fix --json
```

At the start of each workspace workflow, check for updates and remove obsolete
global sandbox grants:

```sh
node bin/c2c.js update-check -w <workspace-root> --json
node bin/c2c.js sandbox-clean --json
```

Mutable project state stays inside the repository boundary. Git checkouts use
`<git-common-dir>/codex-with-chatgpt`; non-Git workspaces use
`<workspace-root>/.codex-with-chatgpt`. Project metadata is shared, while each
checkout stores session routes and execution records below
`workspaces/<workspaceId>/`. The Gateway keeps the result mailbox and the
authoritative cross-workspace Project URL, physical tab, and generation index
in protected machine state; the C2C checkout also remains outside the workspace
boundary.

The Skill completes Project and session-page setup in the built-in ChatGPT
browser. It reuses the machine-owned Project URL when one is already bound;
otherwise it asks for one Project for the workspace. Each local Codex session
then gets a new chat and its own page in that Project.

### Optional macOS login autostart

After the first machine setup, enable the one machine-wide LaunchAgent once on
macOS:

```sh
c2c autostart enable --json
c2c autostart status --json
```

The LaunchAgent runs hidden `c2c autostart run --quiet` at its wake interval.
That command only calls `ensureMachineGateway`; it reuses the official Tunnel's
existing child and never creates a workspace-specific gateway or a second
Tunnel. To disable it:

```sh
c2c autostart disable --json
```

Autostart is a machine convenience, not a page scheduler. It does not change
the machine-wide capacity of 100 active session/page leases.

## Runtime model

```text
ChatGPT Project A                 ChatGPT Project B
  session A1 -> owned tab A1        session B1 -> owned tab B1
  session A2 -> owned tab A2        session B2 -> owned tab B2
            \                         /
             \                       /
              one global Connector (Authentication: None)
                              |
             official OpenAI Secure MCP Tunnel
                              |
               tunnel-owned node ... serve-machine --stdio
                              |
       machine gateway: registry + capability broker + mailbox
                              |
                    trusted local workspaces
```

The local Skill derives the workspace from its trusted `cwd`. The gateway
assigns stable `projectId` and checkout-specific `workspaceId` values and keeps
the registration in a machine registry. ChatGPT Project and chat URLs are
navigation and memory metadata, not filesystem authorization.

Every control turn receives a short-lived `CONTEXT_ID`. Its binding includes:

```text
machine boot + workspaceId + projectId + registrationId
localSessionId + taskId + iteration + phase
requestId (required outside BOOT; absent for BOOT)
compactionEpoch + page generation + requested scopes
```

ChatGPT must pass `context_id` to every MCP call. The gateway validates the
capability, claims an activity lease, renews it during long calls, and releases
it when the call ends. Expiry, cancellation, browser-page rotation, compaction,
or gateway restart invalidates the old context.

## Control flow

The normal loop is:

```text
RESEARCH -> INIT -> PLAN -> EXECUTED -> REVIEW -> DONE
```

Codex sends only small control messages to the exact owned chat. It never pastes
file contents, diffs, or logs into ChatGPT. ChatGPT reads data through MCP and
returns a schema-bound result to the protected machine mailbox:

- `report_control_progress` is forward-only progress.
- `submit_control_result` accepts one result for one exact
  `RESULT_REQUEST_ID` and correlation tuple.
- Codex waits on that request, acknowledges it, and then advances the session.

The protected machine mailbox is the only result transport. A visible browser
reply is never accepted as a result, including when it is the latest message in
the owned chat.

## Browser ownership

The built-in in-app browser is used for ChatGPT operations. On setup, the Skill
claims a tab using the exact browser, surface, Project URL, chat URL, and
`tabId`. The lease has a generation and owner epoch. Replacing a live page
requires the exact current generation; an unrelated tab cannot be claimed.

For each session:

1. Resolve `c2c session get --json` and capture `sessionIdentity.id`.
2. Resolve the session route and current surface lease.
3. Open or return to only that session's saved chat URL.
4. Include `CONTEXT_ID` and `RESULT_REQUEST_ID` in each control prompt.
5. Wait for the exact mailbox request before sending the next control message.

Computer Use drives each owned in-app browser page through stable URLs and
semantic DOM/browser APIs, always using the exact owned `tabId`. These CUA calls
are Skill host execution steps; the TypeScript CLI only persists and validates
the route/lease. When a saved route exists, the Skill first calls
`cua.getTab(tabId, { browser: "iab" })` and validates the current Project/chat
URL. If the exact tab is missing or invalid, it creates a replacement only for
that local session with
`cua.createBrowserTab("iab", targetUrl, { visible: false })`, then replaces the
lease using the exact generation and tab id. With no saved route, it creates a
hidden Project candidate the same way. It never selects a tab by URL, title, or
foreground state, and never reuses the user's ordinary ChatGPT page.

Normal control remains in the background. The Skill verifies the same exact
`tabId` and Project/chat URL immediately before sending and immediately after
sending, using semantic DOM operations throughout. It does not use
screenshot-coordinate clicking, pass `visible: true`, or focus the page. Only
login, CAPTCHA, 2FA, or explicit consent may temporarily require visibility;
after the user action the page returns to the background and the checks run
again. Do not close or repurpose the owned standby tab when a turn ends.

`surface release` only ends the current lease and keeps the durable session
route for later reuse. When a local Codex session is permanently discarded,
run `c2c surface retire --local-session <id> --json`. Retirement revokes that
session's contexts, terminates its active mailbox request, and removes its page
binding and checkout route. The workspace's ChatGPT Project binding remains
available to other and future sessions.

### Unavailable chats

The Skill inspects the exact owned tab and passes its semantic state to
`c2c surface check`. A missing tab reopens the saved chat; an explicitly
archived or unavailable chat creates a new chat in the same Project without
unarchiving the old conversation. Login or consent requires user action;
loading and generation require waiting, not a duplicate send. The CLI evaluates
the host observation; it does not probe ChatGPT independently.

Before replacing a page, consume any received mailbox result into the local
checkpoint, then acknowledge it. Received results survive the request TTL until
ack. Only confirmed page failure permits cancelling an exact pending request.
The Gateway blocks rotation while work is unresolved. Recovery preserves task
progress, verifies one replacement through BOOT, and fences stale generations.
It never uses session retirement to recover a page. See [the recovery protocol](docs/protocol.md#page-recovery).

The page's current model is used by default. Model/effort metadata does not
operate its selector or guarantee the newest model; explicit model requests
require selection and verification in the page.

## Security properties

- MCP workspace tools are read-only. Result writes are bounded by a live,
  schema-checked request and capability.
- Workspace paths are resolved and contained under the registered root. Symlink
  and traversal escapes are rejected.
- Capabilities and activity leases are short-lived and bound to session, task,
  iteration, phase, compaction epoch, page generation, and scopes.
- A completion fence drains active leases before mailbox completion. A failed
  mailbox write aborts completion so the result can be retried.
- The machine lifetime record is owner-checked by machine id, boot epoch, pid,
  and exact runtime data. A second process cannot silently become the broker.
- Secrets (runtime key, admin token, raw capability) stay in protected machine
  state and are omitted from normal CLI views.

See [docs/architecture.md](docs/architecture.md),
[docs/protocol.md](docs/protocol.md), and
[docs/security.md](docs/security.md) for contracts and failure handling.

## Useful commands

```sh
node bin/c2c.js machine start
node bin/c2c.js machine status --json
node bin/c2c.js machine doctor --no-fix --json
node bin/c2c.js machine stop
node bin/c2c.js workspace --json
node bin/c2c.js surface --json
node bin/c2c.js session --json
node bin/c2c.js control status \
  --request <id> --task <id> --iteration <n> --phase <phase> --json
```

Run checks with:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## License

MIT
