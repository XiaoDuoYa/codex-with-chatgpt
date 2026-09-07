# Codex with ChatGPT

[English](README.md) | [简体中文](README.zh-CN.md) | [Installation](#install-and-setup)

> ChatGPT thinks. Codex works.

Use ChatGPT web as the first-choice research, analysis, planning, synthesis, and
review partner for local Codex sessions. When the ChatGPT page or its read-only
MCP tools can answer a task, C2C delegates it there and returns a concise,
structured result through exact Computer Use page observation. Codex retains all workspace
writes, shell execution, tests, git operations, and recovery locally.

## ChatGPT-first delegation

The default delegation policy is `CHATGPT_FIRST`, but only for evidence-closed
subtasks whose required inputs are available to the ChatGPT page or its current
authorized tools:

- `RESEARCH` covers Web Search, current facts, external documentation, source
  comparison, and read-only workspace discovery.
- `PLAN` covers architecture, implementation options, migrations, API design,
  documentation, and other synthesis based on MCP reads.
- `REVIEW` covers the current working-tree diff and execution evidence already
  recorded for the same local session, task, and iteration.

Task labels do not establish capability. The connector does not read arbitrary
commits, refs, PR diffs, parent commits, historical source snapshots, sensitive
files, or data outside the registered workspace. It also cannot edit files, run
commands or tests, mutate Git/PR state, deploy services, change accounts or
permissions, or verify final runtime success. Codex keeps those responsibilities
and either performs them locally or prepares a bounded, verified workspace
artifact before delegating only the remaining analysis.

For mixed tasks, Codex first resolves refs and gathers or records missing
evidence; ChatGPT then researches, plans, or reviews the supported read-only
question; Codex finally applies changes and verifies the result. A known
capability gap is not sent merely to produce a predictable `BLOCKED` response.

Web Search is a built-in ChatGPT capability rather than a Connector MCP tool.
In the current comparison mode, the resulting answer is collected from the
exact bound response by Computer Use. Control
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

This is a self-hosted project: each user installs it on their own computer and
uses their own OpenAI account, tunnel, and credentials. A public Git repository
does not give other users access to the maintainer's machine or tunnel.

The transport is **OpenAI Secure MCP Tunnel**, not a public MCP URL or a local
OAuth service. The local client connects outbound to OpenAI over HTTPS; no
inbound firewall port, public domain, or per-project OAuth setup is needed.
`Authentication: None` disables connector-level OAuth, not tunnel authentication
or C2C's short-lived, task-scoped authorization. C2C does not call a model API;
the **tunnel runtime API key** authenticates the transport and is still required.

### Install through Codex

Start with an **ordinary local task in Codex desktop**, not
`$codex-with-chatgpt`: the Skill is not installed yet, and installation cannot
depend on a ChatGPT connection that does not exist. Send Codex:

```text
Install the main branch of https://github.com/peak-xiong/codex-with-chatgpt
for the current OS user. First read the installation section of README.md,
check the OS, Git, Node.js, Corepack, this task's in-app browser capability,
and any existing C2C installation.
Confirm the source directory before cloning and building. Preserve existing
changes, installation settings, and sessions; do not overwrite or clean them.
If a healthy C2C installation already uses an official Secure MCP Tunnel, reuse
its installed tunnel ID and protected runtime key through
`machine setup --reuse-existing`; do not recreate the tunnel or ask for the key
again.
Otherwise, after preflight and a clean source build, pause and guide me through
creating my own official Secure MCP Tunnel. Wait for my tunnel ID and the
absolute path to a private runtime-key file.
Do not guess accounts, organizations, workspaces, tunnel IDs, or credentials.
Do not inspect, display, or upload the key contents. If permissions, login,
or consent are missing, explain the user action needed. Do not switch accounts,
expand permissions, or substitute public URLs, OAuth, or another tunnel provider.
```

Steps 1–6 below are also the sequence Codex should follow. **Do not repeat local
commands that Codex has already completed**; the command blocks are execution
references for Codex or users checking its work.

| Operation | Responsible party |
| --- | --- |
| Choose the account/organization/workspace, create or select a cloud tunnel, associate the workspace | User confirms in OpenAI's official UI for first-time setup; an administrator may need to grant access |
| Obtain the runtime key, save it privately, complete login and consent | User for first-time setup or key rotation; share only the file path with Codex |
| Check the environment, build, install globally, run diagnostics | Codex executes locally, not in a ChatGPT conversation |
| Create or reuse the ChatGPT connector | User in the confirmed ChatGPT workspace; Codex then verifies it |

### 1. Check prerequisites

- Git, a supported Node.js LTS release satisfying Node.js >= 20, and Corepack.
  Check `node --version`, `git --version`, and `corepack --version`. If Corepack
  is absent, install a version compatible with your Node.js release before
  continuing. The repository pins its pnpm version in `package.json`.
- Codex desktop with the in-app browser and Computer Use available to the
  session. Installing the CLI alone does not supply browser automation.
- A ChatGPT account/workspace with developer-mode custom apps and Secure Tunnel
  access. Availability and administrator permissions must be checked in your
  own account; a subscription alone is not proof of access.
- Permission to create/use a tunnel in the intended Platform organization and
  associate it with the intended ChatGPT workspace.
- Outbound HTTPS access to `api.openai.com:443`, plus access to GitHub and the
  package registry for installation. The computer must remain awake and online
  while ChatGPT uses local tools.

The current live validation environment is **macOS with Codex desktop**. The
code includes other platform targets, but native Windows/Linux installation and
the complete browser workflow are not yet verified. The shell examples below
use macOS/POSIX syntax; they are not PowerShell instructions.

See the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
for current account, permission, and networking requirements. Secure Tunnel is
for private connections/developer-mode apps; it does **not** satisfy public
plugin-store submission requirements. Publishing this source for self-hosting
is different from distributing one public ChatGPT plugin.

### 2. Clone and build a clean source checkout

For the machine-gateway preview tracked in [PR #409](https://github.com/XiaoDuoYa/codex-with-chatgpt/pull/409),
the following fork's `main` contains this implementation. Do not assume another
repository or branch already includes it. Use `git clone`, not Download ZIP:
the installer builds from a clean, committed Git revision.

```sh
git clone --branch main --single-branch https://github.com/peak-xiong/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --help
git status --short
```

Keep this checkout for future updates. `git status --short` must be empty
before installation. If you have changes, preserve them or use a separate clean
clone; do not reset or delete your work just to satisfy the installer.

### 3. Create your own tunnel and prepare the key (first installation only)

This stage happens in OpenAI's official UI, **not through local `machine setup`**.
Skip it when preflight confirms a healthy existing C2C installation backed by
the official Secure MCP Tunnel. Existing-install updates use the protected key
already managed by C2C and must not recreate the tunnel or request its key again.

1. Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
   and confirm the account and intended organization in the organization
   selector. UI locations may change. Create a tunnel for this computer with
   a name of your choice, or reuse the one already dedicated to it. Do not
   select a tunnel in use by another computer.
2. Associate the tunnel with the **ChatGPT workspace** where you will use the
   connector. A Platform organization, a Platform API Project, and a ChatGPT
   workspace are different scopes. The ChatGPT Project for your code workspace
   is created later during pairing, not here.
3. Save the configuration and record the actual `tunnel_id` returned by the
   page, not its display name, a Project ID, or a URL. This alone does not
   start a local client or prove the connection works.
4. Obtain a **runtime API key** for this tunnel through the intended
   organization's credential-management process. The official guide requires
   a runtime key but does not promise a "generate runtime key" button on every
   account's Tunnel page. Do not assume creating a tunnel also returns a key.
   Ask the organization administrator if the entry point or permissions are unclear.
5. Save **only the key** in a private UTF-8 text file outside all repositories,
   using a trusted editor or secret manager. Do not include JSON, `export`, a
   variable name, or quotes around the key. On macOS, Codex can check that the
   file exists and run `chmod 600 "/absolute/private/path/tunnel-runtime.key"`
   without inspecting it with commands such as `cat`. The installer reads
   the key file locally and stores a protected copy.

Permissions are **Platform organization-level**: creating/editing requires
Tunnels `Read + Manage`; running the client and selecting a tunnel in ChatGPT
require `Read + Use`. Platform Project access or ChatGPT developer-mode access
alone is insufficient. See the [official permissions guide](https://developers.openai.com/api/docs/guides/rbac).
If access is missing, stop and contact the organization administrator; do not
ask Codex to elevate permissions automatically.

Keep the original key in secure storage for updates. Do not put it in shell
command arguments, chat prompts, Project instructions, screenshots, or Git.
Never reuse a maintainer's key, tunnel ID, or ChatGPT Project URL.

The examples use placeholders. Replace `<YOUR_TUNNEL_ID>` with your real ID and
the example file path with your private file's absolute path. A tunnel ID is
not the runtime key, and a ChatGPT login/session token is not a substitute.
`Authentication: None` does not remove the need for this key.

### 4. Install once for your local user

After step 3, reply in the **same Codex installation task** with the following,
replacing both placeholders. Do not paste the key contents:

```text
I have confirmed the account, Platform organization, and ChatGPT workspace,
and associated the tunnel with that workspace.
Tunnel ID: <YOUR_TUNNEL_ID>
Runtime-key file (absolute path): /absolute/private/path/tunnel-runtime.key
Run machine setup from the clean source checkout you just built, installing
for the current OS user. Pass only the key-file path to the installer; do not
print, upload, or display the file contents in chat.
Check the global Skill, machine status, and machine doctor --no-fix, and report
the actual results. Then wait for me to create or confirm the ChatGPT connector
before workspace pairing and round-trip acceptance.
```

Codex should run the following from the source checkout built in step 2,
without `sudo`. The global `c2c` may not exist on first install, so use the
source entrypoint. Replace all placeholders first; retain quotes for paths
containing spaces:

```sh
node bin/c2c.js machine setup \
  --tunnel-id "<YOUR_TUNNEL_ID>" \
  --runtime-key-file "/absolute/private/path/tunnel-runtime.key" --json
```

For a healthy existing installation, use the updated source entrypoint and the
explicit reuse mode instead. It does not read the key into the conversation or
accept an arbitrary replacement path:

```sh
node bin/c2c.js machine setup --reuse-existing --json
```

`--reuse-existing` is rejected when no valid machine configuration exists and
cannot be combined with `--tunnel-id` or `--runtime-key-file`. To change the
tunnel or rotate its key, use the first-time form with both explicit values.

Expect `ok: true` and `configured: true`. Setup deploys the verified runtime,
installs the global Skill and `c2c` launcher, installs the project's pinned
official tunnel client, and starts the one tunnel-owned gateway. The first-time
form privately copies the supplied runtime key; reuse mode leaves the protected
installed key in place. **Setup does not create a cloud tunnel, associate a
ChatGPT workspace, or create the ChatGPT connector**; for first-time setup, the
first two must already be completed in step 3.

The official generic tutorial's `tunnel-client init/run` commands and sample
MCP server are for standalone integrations. Here, `machine setup` manages
those local components. **Do not also run that sample setup**, or start another
`tunnel-client` or `serve-machine` for an individual project.

The launcher is `~/.local/bin/c2c`. If your shell cannot find it, add this to
your shell's startup configuration and reload that shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

For an immediate check without changing PATH, use
`"$HOME/.local/bin/c2c" machine status --json`.

### 5. Connect ChatGPT once

In the intended ChatGPT account/workspace, enable developer mode if needed
(currently Settings > Security and login; an administrator may need to grant
access). Open [ChatGPT Plugins](https://chatgpt.com/plugins), use the plus/create
entry for a developer-mode app, and configure the following. Depending on the
UI version, the entry may be called an app, plugin, or connector.

| Field | Value |
| --- | --- |
| Name | `Codex with ChatGPT` |
| Connection | `Tunnel` |
| OpenAI Secure Tunnel | Select the same tunnel configured in step 4 |
| Authentication | `None` |

Reuse this connector if it already exists. There is no public Server URL to
paste, and the runtime key belongs on the local machine, not in this form.
Keep the gateway running during tool discovery. If the tunnel is missing from
the list, check its workspace association and your Read + Use permissions first.
If the UI allows entering a tunnel ID manually, use the same real, associated
ID you have permission to use; manual entry does not bypass authorization.
If Tunnel is not an available connection type, stop and check account access
or administrator settings, rather than selecting a public URL or OAuth.
Tell Codex the connector is configured before proceeding to step 6. A connector
card alone is not proof of result delivery.

After creating the app or changing its tool schemas, verify the task-needed
read tools and input contracts in the existing app while the gateway is healthy.
Use **Refresh** once if the current UI offers it and discovery needs updating;
do not assume a fixed menu path exists. Opening Manage or restarting the Tunnel
does not prove that schemas were refreshed. A real scoped read is verified
separately in step 6. Keep the same global app; do not recreate it per project.

### 6. Verify installation, then the real round trip

Use the global command from now on:

```sh
c2c skill status --json
c2c machine status --json
c2c machine doctor --no-fix --json
```

Expect Skill `installed: true` and `matches: true`, machine `ready: true`, and
doctor `ok: true`. These checks do not prove ChatGPT can return results.

Open your actual project in Codex desktop. In a new session, ask:

```text
Use $codex-with-chatgpt to pair this workspace and verify local reads and
structured result delivery. Run two consecutive read-only questions in this
session's dedicated ChatGPT chat. Require Computer Use to validate each exact
response marker against its request and page identity; do not edit business
code or accept uncorrelated page text.
```

The Skill registers the current workspace, creates its ChatGPT Project on
first pairing (or uses an exact existing Project URL you explicitly approve),
and verifies the session's dedicated chat. An existing authoritative binding
is reused. Keep control questions in Chat mode with the connector available
in that exact message. A missing Skill may require reopening Codex desktop;
existing sessions must read the updated Skill, not reinstall it per project.

Acceptance has three separate levels:

| Level | Required evidence |
| --- | --- |
| Installed and connected | Global Skill matches; machine ready; doctor passes |
| Workspace reads | BOOT returns the expected workspace/project IDs and actual local evidence |
| Result delivery | Computer Use validates the exact tab/chat/generation/response and its schema-bound result marker |

Mailbox callback code and historical live-return records are retained for a
later comparison. Production currently does not register those callback tools.
The page marker is accepted only after exact Computer Use correlation and schema
validation; arbitrary browser prose is never accepted.
See [current verification boundaries](docs/issue-log.md#最新回传验收修复).

### Use another project or session

Global means **one installation for this OS user and Codex configuration**,
not a shared installation for every user, computer, or ChatGPT account.

| Scope | What happens |
| --- | --- |
| This machine/user | One runtime, Skill, tunnel, and connector |
| New workspace | Register and pair with its own ChatGPT Project once |
| New local session | Bind one dedicated chat/page within that Project |
| Next task in that session | Reuse its page; create only a fresh task authorization |

From the root of the project you want ChatGPT to access:

```sh
cd /absolute/path/to/your-project
c2c machine workspace register --json
c2c workspace --json
```

The Skill performs registration when needed; the commands above are useful for
verification. Do not run `node bin/c2c.js` from a business project that does not
contain the C2C source. Workspace commands use the trusted current directory;
`-w` cannot select a different directory. No extra connector, tunnel, or copied
Skill is needed for another project. New computers/users need their own setup.

### Installation locations and updates

Default locations on macOS (all belong to the current OS user):

| Item | Location |
| --- | --- |
| CLI launcher | `~/.local/bin/c2c` |
| Global Skill | `~/.codex/skills/codex-with-chatgpt/SKILL.md` |
| Managed runtime | `~/Library/Application Support/codex-with-chatgpt/installation/current` |
| Git project state | `<git-common-dir>/codex-with-chatgpt` |
| Non-Git project state | `<workspace-root>/.codex-with-chatgpt` |

`CODEX_HOME` changes the Skill's configuration root. `C2C_STATE_DIR` changes
machine state, not registered repository-local state; normally leave it unset.
The managed runtime is not the source Git checkout. Do not edit it or run
`git pull` there. The gateway owns the protected mailbox and cross-workspace
page indexes; local project state holds routes/checkpoints and execution records.

To update, let active tasks finish first: setup may restart the shared gateway
and invalidate old authorizations. In the original clean source checkout:

```sh
cd /absolute/path/to/codex-with-chatgpt
git status --short
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --reuse-existing --json
c2c skill status --json
c2c machine doctor --no-fix --json
```

Proceed past the status check only when it is empty. Reuse the installed
tunnel/key and keep the existing connector; updates do not require the original
key-file path or per-project installs. Use the two-argument first-time form only
for a deliberate tunnel change or key rotation.
Run setup with the **updated source entrypoint** shown above, not the old
installed `c2c`, which would reuse its own runtime. The Skill obtains fresh
authorizations after restart and preserves established Project/chat mappings.
If the update changes tool contracts, verify discovery in the existing
`Codex with ChatGPT` app as described in step 5. Use Refresh only if offered and
needed; missing UI controls do not justify recreating the connector.
`c2c update-check --json` checks for updates; it does not install them. A
`checked: false` response is not proof that your installation is up to date.

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

### Common setup problems

| Symptom | Next check |
| --- | --- |
| `corepack` or `c2c` not found | Install Corepack for your Node version; check the launcher and PATH from step 4 |
| `machine setup` is an unknown command | Check the repository/branch and rebuild step 2; older OAuth releases use a different architecture |
| `--reuse-existing` reports no configuration or key | This machine has no reusable official Tunnel setup; complete steps 3–4 with your own tunnel ID and private key-file path |
| Installer requires clean Git source | Use a Git clone and preserve your changes before installing; a ZIP download is insufficient |
| Tunnel absent in ChatGPT | Verify the selected account/workspace, tunnel association, and Read + Use permissions |
| Machine not ready | Run `c2c machine doctor --no-fix --json`; check network/key permissions and the one managed client |
| Final response is not detected | Verify the exact owned tab, chat, generation, response id, request id, and `C2C_HOST_OBSERVED_RESULT` marker; do not inspect another page or resend while generation is active |

For controlled repair and exact-session recovery, see [Troubleshooting](docs/troubleshooting.md).

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
requestId (required for every phase, including BOOT)
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
file contents, diffs, or logs into ChatGPT. ChatGPT reads bounded data through
read-only MCP tools and ends the exact response with a schema-bound
`C2C_HOST_OBSERVED_RESULT` marker. Computer Use verifies the exact tab, chat,
generation, response id, request id, phase and payload schema before advancing
the session.

This is a temporary comparison mode. Mailbox callback implementation remains in
the source tree, but `get_control_result_status`, `report_control_progress`, and
`submit_control_result` are not registered by the production MCP server and
`c2c.result.write` is not granted by `control open`.

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
5. Wait for the exact Computer Use result before sending the next control message.

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
session's contexts, terminates its active control request, and removes its page
binding and checkout route. The workspace's ChatGPT Project binding remains
available to other and future sessions.

### Unavailable chats

The Skill inspects the exact owned tab and passes its semantic state to
`c2c surface check`. A missing tab reopens the saved chat; an explicitly
archived or unavailable chat creates a new chat in the same Project without
unarchiving the old conversation. Login or consent is completed by the user:
Codex provides the observed entry or service URL and instructions, without
starting/submitting login, filling credentials/codes, or switching accounts.
After the user reports completion, Codex rechecks the page and authorization;
loading and generation require waiting, not a duplicate send. The CLI evaluates
the host observation; it does not probe ChatGPT independently.

The C2C app does not have to appear in the picker or as a selected chip.
When the route and authorization are healthy, Codex may send the normal
correlated request naming the connector and ask ChatGPT to discover/use its
tools directly. Workspace tasks begin with workspace_info to verify identity.
This uses the same owned chat and request, with no extra discovery message.
Actual tool results establish availability; a model's unsupported claim does not.
Missing UI alone never requires manual selection or chat replacement. Confirmed
tool/authorization failures follow the result protocol, and platform refusals
are not retried through another page.

Before replacing a page, preserve any verified Computer Use result in the local
checkpoint. Only confirmed page failure permits cancelling an exact pending request.
The Gateway blocks rotation while work is unresolved. Recovery preserves task
progress, verifies one replacement through BOOT, and fences stale generations.
It never uses session retirement to recover a page. See [the recovery protocol](docs/protocol.md#page-recovery).

The page's current model is used by default. Model/effort metadata does not
operate its selector or guarantee the newest model; explicit model requests
require selection and verification in the page.

## Security properties

- MCP workspace tools are read-only. Computer Use results are bounded by a live,
  schema-checked request and exact page/response identity.
- Workspace paths are resolved and contained under the registered root. Symlink
  and traversal escapes are rejected.
- Capabilities and activity leases are short-lived and bound to session, task,
  iteration, phase, compaction epoch, page generation, and scopes.
- The retained mailbox completion fence is dormant in the current production
  transport and remains covered by tests for later comparison.
- The machine lifetime record is owner-checked by machine id, boot epoch, pid,
  and exact runtime data. A second process cannot silently become the broker.
- Secrets (runtime key, admin token, raw capability) stay in protected machine
  state and are omitted from normal CLI views.

See [docs/architecture.md](docs/architecture.md),
[docs/protocol.md](docs/protocol.md), and
[docs/security.md](docs/security.md) for contracts and failure handling.

## Useful commands

```sh
c2c machine start
c2c machine status --json
c2c machine doctor --no-fix --json
c2c machine stop
c2c workspace --json
c2c surface get --local-session <session-id> --json
c2c session get --local-session <session-id> --json
c2c control status \
  --local-session <session-id> --request <id> --task <id> \
  --iteration <n> --phase <phase> --json
```

`machine stop` stops the shared connection for all workspaces; let their active
tasks finish first. Run source checks from the C2C source checkout:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## License

MIT
