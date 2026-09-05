# Codex with ChatGPT

[English](README.md) | [简体中文](README.zh-CN.md) | [Installation](#install-and-setup)

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
After preflight and a clean source build, pause and guide me through creating
my own official Secure MCP Tunnel. Wait for my tunnel ID and the absolute path
to a private runtime-key file.
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
| Choose the account/organization/workspace, create or select a cloud tunnel, associate the workspace | User confirms in OpenAI's official UI; an administrator may need to grant access |
| Obtain the runtime key, save it privately, complete login and consent | User; share only the file path with Codex |
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

### 3. Create your own tunnel and prepare the key

This stage happens in OpenAI's official UI, **not through local `machine setup`**.

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

Expect `ok: true` and `configured: true`. Setup deploys the verified runtime,
installs the global Skill and `c2c` launcher, installs the project's pinned
official tunnel client, privately copies the runtime key, and starts the one
tunnel-owned gateway. **It does not create a cloud tunnel, associate a ChatGPT
workspace, or create the ChatGPT connector**; the first two must already be
completed in step 3.

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
session's dedicated ChatGPT chat. Require each exact mailbox request to be
received and acknowledged; do not edit business code or treat page text as a
successful result.
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
| Result delivery | Each exact request reaches `received` then `acknowledged`, including a later message in the same chat |

There are historical successful live returns, but the latest acceptance also
found `submit_control_result` unavailable in a later ChatGPT message. The local
format fix and automated tests do not resolve or certify that platform-side
availability. If the tool is unavailable or approval is blocked, stop and
report it; do not bypass the check or accept browser prose as a receipt.
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
node bin/c2c.js machine setup \
  --tunnel-id "<YOUR_TUNNEL_ID>" \
  --runtime-key-file "/absolute/private/path/tunnel-runtime.key" --json
c2c skill status --json
c2c machine doctor --no-fix --json
```

Proceed past the status check only when it is empty. Use the same tunnel/key
and keep the existing connector; updates do not require per-project installs.
Run setup with the **updated source entrypoint** shown above, not the old
installed `c2c`, which would reuse its own runtime. The Skill obtains fresh
authorizations after restart and preserves established Project/chat mappings.
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
| Installer requires clean Git source | Use a Git clone and preserve your changes before installing; a ZIP download is insufficient |
| Tunnel absent in ChatGPT | Verify the selected account/workspace, tunnel association, and Read + Use permissions |
| Machine not ready | Run `c2c machine doctor --no-fix --json`; check network/key permissions and the one managed client |
| Reads work but no mailbox result | Check current-message callback availability; do not claim full success or bypass platform approval |

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
