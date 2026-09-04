---
name: codex-with-chatgpt
description: >
  Use ChatGPT (web) as the planning and review brain for Codex coding sessions,
  while Codex keeps full execution ownership. Use when the user says
  "使用 Codex with ChatGPT ..." / "Set up Codex with ChatGPT" / "用 ChatGPT 规划",
  when they ask to connect ChatGPT to the current workspace, disconnect it,
  or run a task through the ChatGPT planning loop.
---

# Codex with ChatGPT

ChatGPT thinks. Codex works.

You (Codex) own the local harness: routing, correlation, editing, shell, git,
tests, recovery, and final verification. Keep local reasoning focused on safely
applying and checking the returned work.
ChatGPT owns codebase discovery through MCP, architecture/debug analysis,
planning, review, and web research that requires browsing or waiting.
The C2C Bridge gives ChatGPT read-only MCP access to the current workspace, plus
bounded `report_control_progress` and `submit_control_result` tools for returning
progress and RESEARCH/PLAN/REVIEW/DONE/BLOCKED payloads to local state. Control messages between you and ChatGPT stay tiny
(< 1 KB) — ChatGPT pulls whatever data it needs by itself and Codex reads
substantive results locally when a result request is active.

**Work allocation**

- Before PLAN, Codex performs only connection, session, and routing checks. Do
  not duplicate repository exploration that ChatGPT can perform through MCP.
- ChatGPT searches/reads the code it needs, performs any necessary current-web
  research itself, waits for that research to finish, and returns concrete
  structured guidance. Current-web research is a separate `RESEARCH` request
  with conclusions, source URLs, publication dates, key evidence, and open
  questions; do not bury it inside a PLAN or REVIEW payload.
- Codex reads only the local context needed to apply those actions, edits the
  workspace, runs commands/tests, and independently verifies the result. If the
  advice is insufficient, ask ChatGPT to refine it in the same correlated turn
  or next PLAN/REVIEW turn; do not silently replace the requested collaboration
  with a large local analysis pass.
- This Skill cannot select or change the active Codex model. Model choice belongs
  to the user or host runtime. Never claim that C2C switched to a cheaper model.
  A low-cost local model can apply structured guidance when it is capable of the
  required edits, but execution correctness still has to pass local verification.

**Golden rules**

1. NEVER paste file contents, diffs, or logs into ChatGPT. ChatGPT reads them through MCP.
2. NEVER show the user technical internals (MCP, OAuth, PKCE, tunnel, ports, localhost).
   Speak in terms of "连接 ChatGPT / 安全连接 / 配对". The only exception is the
   **guided manual ChatGPT setup** below: expose only the exact settings
   field labels/values the user must enter, without explaining internals.
3. The pairing code is the ONLY credential you may ever type into a browser.
   Never touch OAuth tokens, cookies, or session storage.
4. If something fails, run `c2c doctor` and repair silently. Only involve the user
   for logins, CAPTCHA, 2FA, explicit consent screens, or **guided manual
   ChatGPT setup** below — and then give them ONE action.
   Before the first ChatGPT connection on this machine, `c2c prefs --json`:
   - `setupMode` missing: tell the user exactly `setupChoicePrompt`, wait for
     「1」or「2」, then `c2c prefs set --setup-mode auto|manual --json`.
     Do not start ChatGPT configuration until they answer. Do not guess.
   - `setupMode` is `manual`: skip automatic ChatGPT settings. Use guided
     manual from the start (chosen, not a failure).
   - `setupMode` is `auto`: automatic browser setup. Two explicit failures of
     the same configuration step after repair then enter guided manual.
     A browser/js timeout, a page still loading/generating, or waiting for
     user login/2FA does NOT count as a failure. Do not change the saved
     `setupMode` when falling back.
   `developerModeEnabled: true` means skip `#settings/Security` until a
   connector create fails because developer mode is required. Then open
   that page, enable it, and `c2c prefs set --developer-mode --json`.
   These prefs are for this machine, not per workspace. Do not ask again
   on reconnect or a second repo. A new computer (empty prefs) asks/checks
   once.
5. ALWAYS use the built-in in-app browser (iab) for every ChatGPT step.
   Follow **In-app browser (ChatGPT)** below. NEVER Computer Use (no
   screenshot-click). NEVER launch or control a third-party/external browser
   (Chrome, Safari, Edge…), and never use `open <url>` to hand off to one.
   - The ONLY exception: the user explicitly says the Cloudflare login must use
     their own browser session — that single Cloudflare login step may go through
     their browser; everything else stays in the built-in browser.
   - If the user asks to run ChatGPT in their own browser, refuse politely and
     explain: "Codex 需要持续调用 ChatGPT 和配置连接，这会频繁操作页面，可能影响
     你浏览器的正常使用。ChatGPT 只能跑在内置浏览器里。" Only if the user replies
     with an explicit "我愿意承担影响" may you proceed in their browser; otherwise
     keep ChatGPT in the built-in browser, every time they ask.
6. Conversation reuse depends on `c2c session --json` → `conversation.mode`
   (see Conversation management). Do not invent a second mode.
   - The first session read returns `sessionIdentity.id`. Capture it as
     `<localSessionId>` and pass `--local-session <localSessionId>` to every
     later `c2c session` and `c2c control` command in this Codex task. Do not
     re-resolve identity midway through a workflow.
   - It also returns `route`. Before every `[C2C]` RESEARCH, INIT, EXECUTED, or HANDOFF,
     enforce the routing gate in **Conversation management**. Never send a
     control message in whichever ChatGPT chat merely happens to be visible.
   - **long-chat** (no Project collection): ONE ChatGPT conversation per local
     Codex session. Reuse only that session's saved URL; a different local
     session starts and owns a different chat.
   - **project** (new workspaces, or an existing workspace that opted in):
     ONE ChatGPT Project (collection) per workspace. Same local Codex session
     reuses the ChatGPT chat URL saved for THIS session. A new local Codex
     session opens a new chat from the Project collection page — never
     `goto` `https://chatgpt.com/` to create it, and never reuse another
     session's chat URL just because `session.url` exists.
   Each workspace also has exactly ONE ChatGPT connector. Do not create a
   second connector for the same workspace. Other workspaces may have their
   own connectors — never edit those.
7. After first-time setup, never ask the user to approve writing C2C's local
   settings directory. Run `c2c sandbox-allow --json` (idempotent). If it fails
   with EPERM / Operation not permitted, request elevated permissions and retry
   ONCE. After `{ "alreadyAllowed": true }` or `{ "added": true }`, stay silent.
8. ChatGPT pages: only the URLs in **In-app browser (ChatGPT)**. Never start
   from chatgpt.com and click through menus.
9. **Doctor gate.** After `c2c doctor --json`, do not `goto` ChatGPT and do not
   send `[C2C]` until local is green — except the reconnect settings pages when
   `chatgptRepair.needed` is true. Not green:
   - `report.bridge.ok` is not true
   - `report.mcp.ok` is not true (unauthenticated local `/mcp` must be 401)
   - `report.oauth.ok` is not true (an existing connector may need the new
     bounded result-write authorization)
   - sandbox / state-dir write failed (EPERM)
   - this workspace used to have a public URL and the tunnel is down
   - `chatgptRepair.needed` is true (fix the connector first, then doctor again)
   - `namedRepair.needed` is true (user must log in to Cloudflare, then doctor again.
     Do not Delete the ChatGPT connector — the address did not change)
   - `report.bridge` says 状态无法确认: the local bridge may still be running.
     Do not `c2c start`, do not Delete the connector, do not treat it as
     `chatgptRepair`. Wait and run doctor again.
   A ChatGPT-side 401 after a sent message is different: repair then, do not
   treat it as permission to skip this gate next time.
10. **Let ChatGPT finish research.** A longer wait while ChatGPT is searching
    the web or reading the connector is normal. Continue the same mailbox wait
    and generation checks; never resend the question, switch chats, or perform
    the same broad research locally merely because it takes longer.

## In-app browser (ChatGPT)

Official skill: `control-in-app-browser`. These C2C rules override defaults
that close the tab, hide the window, or stall on the settings page.

1. **Surface.** Once per Codex session: `setupBrowserRuntime()`, then
   `const iab = await agent.browsers.get("iab")`. Reuse `iab`. Do not re-read
   `documentation()` if it is already bound. Never `getDefault()`, `getForUrl()`,
   or Computer Use.

2. **One tab per local Codex session.** If this session already has a saved
   chat, claim only a tab whose normalized URL equals its `route.expectedChatUrl`.
   For this comparison: require HTTPS `chatgpt.com`, drop query/hash and a
   trailing slash, and canonicalize any Project segment
   `g-p-<32 hex>-<display-slug>` to `g-p-<32 hex>`. ChatGPT may add or remove
   that display slug while keeping the same Project and conversation.
   Never claim or navigate a tab showing another active local session's chat.
   If this local session has no tab yet, create a fresh one even when another
   C2C tab is open. After that, reuse only this session's tab and use
   `tab.goto(...)` to switch its URL. Do not `goto` the URL it is already on.

3. **Foreground + keep (standby).** Right after opening or claiming the tab:
   - `await (await iab.capabilities.get("visibility")).set(true)` — first-time
     setup and ChatGPT chatting stay in front of the user so they can watch.
   - `await tab.markHandoff()` immediately, then again at the start and end of
     every turn. After setup succeeds or the C2C chat is open, also
     `await tab.markDeliverable()`.
   Never close this tab. Finished, waiting for the user, or timed out: leave it
   marked (standby). Do not let default turn cleanup close it.

4. **URLs only** (same tab, `goto` — never hunt menus):
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
     (skip when `c2c prefs --json` has `developerModeEnabled: true`)
   - 插件总管: `https://chatgpt.com/plugins`
   - 加插件: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - 新对话 (long-chat only, and only if no saved chat): `https://chatgpt.com/`
   - Saved C2C chat: `conversation.chatUrl` / `session.url` (long-chat, or
     the chat already bound to THIS local Codex session)
   - Saved Project collection: `conversation.projectUrl`
     (`https://chatgpt.com/g/g-p-…/project`)
   Never click Reconnect / Refresh on an existing connector. The old address is
   dead and that page hangs on "This site cannot be reached". When the address
   changed: Delete THIS workspace's `connectorName` only, then create it again
   via the 加插件 URL (same name, new Server URL). Do not put that public
   address into Project instructions — write the connector **name** only.

5. **Do not wait for a fixed tool count** on the settings page. "Connected" / authorize
   success / pairing accepted is enough. Confirm tools in the conversation with
   `workspace_info`.

6. **Batch.** Fill a known form in one Playwright / `js` script when you can.
   After an action, one cheap DOM check. Do not screenshot-poll.

7. **One conversation, Chat mode.** The first ChatGPT chat is the C2C
   conversation. Chat and Work (聊天 / 工作) are separate: a Work conversation
   cannot become Chat. On every NEW conversation, if a Chat/Work switcher is
   visible (often top-left), confirm **Chat** is selected before the boot
   prompt. If it is Work, do not continue there — Switch to a new Chat
   conversation (HANDOFF). If no switcher is visible, do not hunt menus; continue.
   Send the boot prompt and the workspace_info check in that Chat conversation.
   Confirm the reply names the current workspace **before** saving or replacing
   the session URL. If validation fails, keep the old saved URL. Do not open a
   throwaway verify chat and later another C2C chat.

8. **Wait on the selected result transport.** After every send, `markHandoff`,
   keep the tab foreground, and stay in this same task.
   One `RESULT_REQUEST_ID` represents exactly one question and one answer. Never
   open or send the next control question until the current request is received
   and acknowledged, cancelled, or expired. Never read a generic "latest"
   mailbox file or the last visible assistant message.
   - Boot and `workspace_info` verification always use one cheap DOM check every
     20–30 seconds. They do not have a mailbox request, so inspect only the
     assistant answer paired with that exact verification prompt in the
     candidate chat; never use the latest answer from another turn.
   - For RESEARCH / INIT / EXECUTED with `resultTransport=mailbox`, wait with
     `c2c control wait -w <ws> --local-session <localSessionId> --request <id> --task <taskId> --iteration <n> --phase <RESEARCH|PLAN|REVIEW> --json`.
     Read the substantive
     result from that JSON only; do not parse the visible ChatGPT reply.
   - For RESEARCH / INIT / EXECUTED with `resultTransport=auto`, use the same local wait.
     A wait timeout alone is not enough if ChatGPT is still generating: wait
     locally again. Fall back only when the same page has a completed
     substantive reply but no mailbox result, the request expired, or ChatGPT
     visibly reports that `submit_control_result` failed. Before parsing a
     completed visible reply, find the exact outbound user message containing
     this `RESULT_REQUEST_ID` and inspect only its associated assistant answer.
     Accept it only when it echoes the same `RESULT_REQUEST_ID`,
     `LOCAL_SESSION_ID`, `TASK_ID`, `ITERATION`, and `RESULT_PHASE`; otherwise
     treat it as unrelated. Cancel a
     still-pending request before parsing with
     `c2c control cancel -w <ws> --local-session <localSessionId> --request <id> --task <taskId> --iteration <n> --phase <RESEARCH|PLAN|REVIEW> --json`.
     If
     cancellation races with receipt, use the local result instead. After
     accepting a browser fallback, pass `--clear-mailbox` on the checkpoint
     update.
   - With `resultTransport=browser`, use the DOM loop: every 20–30
     seconds check whether ChatGPT is still generating, completed, or shows an
     error. Select only the assistant answer associated with the exact outbound
     `[C2C]` message and require matching LOCAL_SESSION_ID / TASK_ID / ITERATION /
     expected state;
     do not use whichever answer appears last. Do not screenshot-poll.
   A browser/js timeout is not failure. A local mailbox timeout does not permit
   resending RESEARCH/INIT/EXECUTED. Never open a second tab or duplicate a request.

## Locations

- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`
  (installer/update MUST replace this line in the installed Skill with the user's actual checkout path.)
- CLI: let `<checkout>` mean the path on the previous line; run
  `node "<checkout>/bin/c2c.js" <command>` (or `c2c <command>` if globally linked).
  All commands support `--json` for parsing.
- If the checkout has no `node_modules` or no `dist/`, first run
  `corepack pnpm install && corepack pnpm build` inside it.
- Always pass `-w <workspace root>` (the project the user is working on, NOT the c2c repo).

## Autostart

When the user asks for login/boot autostart, use C2C's managed autostart
entrypoint:

1. `c2c autostart enable -w <workspace> --json`
2. Verify with `c2c autostart status -w <workspace> --json`.
3. Run `c2c doctor -w <workspace> --json` and respect the Doctor gate.

The OS autostart service must only wake C2C. Never create or preserve a
separate script/service whose ProgramArguments run `cloudflared tunnel run`
or kill a cloudflared process directly. C2C owns bridge startup, named tunnel
startup, tunnel status, and repair. To remove this behavior, use
`c2c autostart disable -w <workspace> --json`.

## Daily update check

At the START of every workflow below (before anything else), run these two
commands (both are cheap / cached; never mention them unless an update exists):

1. `c2c update-check --json`
2. `c2c sandbox-allow --json` — writes the C2C state directory into Codex's
   sandbox `writable_roots` (macOS: `~/Library/Application Support/codex-with-chatgpt`;
   Windows: `%LOCALAPPDATA%\codex-with-chatgpt`; config file is
   `~/.codex/config.toml` on both, or `%USERPROFILE%\.codex\config.toml` on Windows).
   If already allowlisted, this is a no-op and does not trigger elevation.

- `{ "updateAvailable": false }` → continue silently. Never mention the check.
- `{ "updateAvailable": true }` → tell the user one line:
  "检测到 Codex with ChatGPT 有新版本，我先更新一下（约 1 分钟），随后继续你的任务。"
  Then run the update workflow below, and CONTINUE the original task afterwards.

## Workflow: update（"更新 Codex with ChatGPT"，or triggered by the daily check）

Inside the checkout directory (see Locations):

1. `git pull --ff-only` (if it fails due to local edits: `git stash && git pull --ff-only`).
2. `corepack pnpm install && corepack pnpm build`.
3. Re-install the Skill: copy `skill/SKILL.md` to
   `~/.codex/skills/codex-with-chatgpt/SKILL.md`, then fix the "checkout lives at:"
   line in the copy to the actual checkout path.
4. `c2c sandbox-allow --json` (so existing installs pick up the sandbox allowlist),
   then `c2c restart -w <workspace>` so the bridge runs the new code, then
   `c2c update-check --force --json` to refresh the cache (should now report up to date).
5. Tell the user "✓ 已更新到最新版本" — then resume whatever task triggered this.
   (The updated SKILL.md takes effect from the next Codex session; that's expected.)

## Connection choice (once per workspace)

Ask this **before** the public address exists (`c2c setup` / first `doctor --fix`
that starts a tunnel). Do not mention tunnels, wrangler, DNS, or hostnames.
Speak only of 临时地址 / 固定域名 / 登录 Cloudflare.

1. `c2c tunnel status -w <workspace> --json`
2. If `needsChoice` is false: do not ask again.
3. If `needsChoice` is true: tell the user exactly `userPrompt` and wait.
   - 没有账号 / 没有域名 / 临时 / 不用 →
     `c2c tunnel choose -w <ws> --mode quick --json`
   - 有域名（例如 example.com）→ first tell them `loginPrompt`, then
     `c2c tunnel choose -w <ws> --mode named --zone <domain> --json`.
     This may open the user's own browser (the Cloudflare exception in
     Golden rule 5). Wait until the command finishes.
     If they said they have an account but gave no domain: ask once for the
     domain. If the command returns `need: "zone"`, ask once and retry.
     If `fallback` is true: tell them `userMessage` and continue on the
     temporary address. Do not retry named unless they ask.
4. Never put connection credentials in the project. The CLI stores them in
   the C2C state directory.

## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置"）

1. Detect prerequisites yourself: `node --version` (>= 20), and check `cloudflared`.
   - If cloudflared is missing on macOS run `brew install cloudflared`; on Windows use
     `winget install Cloudflare.cloudflared`. Do this yourself; don't ask.
2. If the c2c repo has no `node_modules`, run `pnpm install && pnpm build` in it.
3. Run `c2c sandbox-allow --json`, then **Connection choice**, then
   `c2c setup -w <workspace> --json`.
   `sandbox-allow` edits Codex `config.toml` only — it adds C2C's state directory
   to `[sandbox_workspace_write].writable_roots` so later chats can write logs
   without elevation. If the write is denied, request approval and retry once.
   → returns `{ mcpUrl, pairingCode, workspaceName, connectorName, ... }`.
   `connectorName` is this workspace's plugin title (legacy installs stay
   `Codex with ChatGPT`; additional workspaces get `Codex with ChatGPT · <name>`).
   Pairing codes expire in ~5 minutes: run `c2c pair --json` for a fresh one if you're slow.
4. `c2c prefs --json` (this machine, not this workspace).
   - If `setupMode` is null: tell the user exactly `setupChoicePrompt`. Wait
     for「1」or「2」. Then `c2c prefs set --setup-mode auto` or `--setup-mode manual`.
     Do not open ChatGPT settings and do not start automatic configuration
     until they answer. Do not default to auto.
   - If they later ask to switch: same `c2c prefs set --setup-mode` command.
     Do not re-ask on a later workspace or on reconnect.
   - `setupMode: "manual"`: skip step 5's automatic ChatGPT settings. Go to
     **Guided manual ChatGPT setup** (chosen). Opening line:
     `接下来用手动教学配置。一次只需要做一个操作。`
     Do not say 自动配置没有成功.
   - `setupMode: "auto"`: continue with step 5. Keep the two-failure fallback.
5. Open ChatGPT on the ONE iab tab (see **In-app browser**). Foreground +
   markHandoff immediately. Same tab, `goto` only:
   - 开发人员模式: skip `https://chatgpt.com/#settings/Security` when
     `developerModeEnabled` is true. Otherwise open it, enable 开发人员模式
     ("Developer mode") if it is off, then `c2c prefs set --developer-mode`.
     Never record it as off. If creating the connector later says developer
     mode is required, open this page, enable it, save `--developer-mode`,
     and retry create — do not skip that recovery.
   - 已有该 `connectorName`: `https://chatgpt.com/plugins` — Delete it (never
     Reconnect). Then `goto` the 加插件 URL below.
   - 还没有 / 刚删掉: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
     Operate ONLY on `connectorName` from step 3:
      - If that exact name exists: Delete it, then create it again. Never
        Reconnect, never edit-in-place, never open the old Server URL.
      - If it does not exist: create one with that exact name.
      - Never rename, delete, or edit a connector that belongs to another workspace.
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: the `mcpUrl` from step 3
      - Authentication: OAuth
     Fill the known form in one script when you can. Then Connect / Authorize
     and type the pairing code. As soon as it shows Connected / authorized /
     pairing accepted, continue — do NOT wait for a fixed tool count on this page.
6. Same tab: open the first C2C chat per **Conversation management**
   (first run `c2c session -w <workspace> --json` and capture
   `sessionIdentity.id` as `<localSessionId>`).
   (Project collection for a new workspace; `https://chatgpt.com/` only
   in long-chat). Confirm Chat mode per **In-app browser** §7 (if it is Work,
   open a new Chat conversation instead). Send the boot prompt from
   `docs/protocol.md` §Boot Prompt, then (same chat) send:
   `Use the "<connectorName>" connector: call workspace_info and read hello-style top-level file. Reply with the workspace name.`
   Confirm the reply matches `workspaceName` (wait per **In-app browser** §8).
   Only then save the chat URL with `c2c session set` (see Conversation
   management). If the name does not match, do not save. markDeliverable.
7. Report to the user exactly in this shape (no internals):

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

If a login wall appears (ChatGPT, Cloudflare): stop, tell the user the ONE thing
to do ("请登录 ChatGPT，完成后告诉我'好了'"), then continue.

### Guided manual ChatGPT setup

Enter this path when `setupMode` is `manual` (chosen at the start), or when
automatic ChatGPT browser configuration fails twice at the same explicit
setup/reconnect step after `c2c doctor` / repair. Do NOT enter the failure
path for a browser/js timeout without a visible error, a page that is
still loading/generating, or while waiting for login / 2FA / CAPTCHA.
A chosen manual path does not wait for those two failures.

Stop automating ChatGPT settings. Keep the current local C2C state and the
current `mcpUrl`, `pairingCode`, `workspaceName`, and `connectorName`. Do not
silently fall back to Codex-only execution and do not permanently disable C2C.
Do not change the saved `setupMode` when this is a failure fallback.

Opening line:

- Chosen (`setupMode: "manual"`): `接下来用手动教学配置。一次只需要做一个操作。`
- Failure fallback: `自动配置没有成功，我来带你手动完成。一次只需要做一个操作。`

Then guide ONE action at a time, waiting for the user to say「好了」before the
next action:

1. If `developerModeEnabled` is not true: ask them to open
   `https://chatgpt.com/#settings/Security` and enable 开发人员模式. After they
   say「好了」, `c2c prefs set --developer-mode`. If it is already remembered,
   skip this step.
2. Ask them to open `https://chatgpt.com/plugins`. If the exact `connectorName`
   exists, delete only that connector. Never ask them to touch another workspace's connector.
3. Ask them to open
   `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   and create the exact `connectorName` with:
   - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
   - Server URL: the current `mcpUrl`
   - Authentication: OAuth
4. Ask them to Connect / Authorize and enter the current pairing code. If it
   expired, run `c2c pair --json` and give them only the fresh pairing code.
5. When they report Connected / authorized / pairing accepted, resume the normal
   setup/reconnect flow at its ChatGPT verification step. If automatic browser
   verification then hits the same explicit failure twice, stop and report the
   exact failed step; do not loop indefinitely and do not continue without C2C.

## Conversation management

`c2c session -w <ws> --json` →
`{ sessionIdentity, session, conversation, route, resultTransport }`.
Capture `sessionIdentity.id` once as `<localSessionId>` and use it explicitly
for the rest of the workflow. `codex-thread` / `codex-session` identities are
durable. A runtime or process fallback is valid only while its owning runtime
continues, so explicit propagation is mandatory.

`conversation.mode` is the only switch. A brand-new workspace (no session
state) is **project**. Unsupported or corrupt session state must be repaired or
rebound explicitly; never infer a chat from stale state. If an existing
workspace is explicitly set to long-chat and the user later wants a Project,
run **Bind Project**.

`resultTransport` is independent of conversation mode:

- `mailbox`: structured local result only; a missing result is an error.
- `auto` (default): local result first, browser parsing only after explicit
  mailbox timeout/expiry/tool failure.
- `browser`: legacy visible-reply parsing; do not open mailbox requests.

Never match a Project or a chat by display name. Never upload the repo to
Project sources. Never click 分享 / Share. Do not rename ChatGPT chats.

### Routing gate (before every control message)

Use `route`, not the currently visible page, as the source of truth:

- `resume-chat`: `route.expectedChatUrl` is the only chat for this local Codex
  session. Normalize the current tab URL with **In-app browser** §2. If it
  differs, `goto` `route.targetUrl`, wait for the same normalized conversation
  URL, and only then send.
  Perform the final normalized-URL assertion and composer submission in the
  same browser script; abort without sending if the URL changed.
- `create-project-chat`: `goto route.targetUrl` (the saved collection), create
  a chat with the collection composer. As soon as the first boot send creates a
  `/c/` URL, capture it as `candidateChatUrl`; route every workspace verification
  message back to that candidate if the page changes. After `workspace_info`
  succeeds, save the candidate URL for `<localSessionId>`, then re-read
  `c2c session -w <ws> --local-session <localSessionId> --json`. Do not
  send `[C2C]` until the new route is `resume-chat` and `controlReady=true`.
- `create-long-chat`: `goto route.targetUrl`, create/boot/verify the chat, save
  its `candidateChatUrl` for `<localSessionId>` only after verification, then
  re-read the session and require the same `resume-chat` gate. Before it is
  saved, never send a verification message from a different URL.
- `bind-project`: run **Bind Project**. No control message is allowed yet.

Re-check this gate after a login redirect, a settings/reconnect operation, a
HANDOFF, or whenever the user changes the visible ChatGPT page. During a wait,
navigate back to `route.expectedChatUrl` before inspecting browser state. A
mailbox result may be consumed locally without changing the visible page.

### long-chat

No Project collection. Each local Codex session still owns exactly one ChatGPT
conversation and never borrows another local session's saved URL.

- **Find it**: if `conversation.reuseSavedChat` and `conversation.chatUrl`,
  `goto` that URL (foreground + markHandoff) and continue there.
- **Save it**: after boot + workspace_info, and the reply names this workspace,
  `c2c session set -w <ws> --local-session <localSessionId> --mode long-chat --url <url> --title "C2C <workspace name>"`.
  If the name does not match, do not overwrite a previously saved URL.
- **Update it**: after each EXECUTED/DONE,
  `c2c session set -w <ws> --local-session <localSessionId> --task <id> --iteration <n> --state <STATE>`
  plus checkpoint flags from the coding workflow (`--protocol-state`,
  `--waiting-for`, `--goal`, `--next-step`, `--known-issues`, or
  `--clear-checkpoint` on DONE). Do not put logs or diffs in those fields.
- **Switch it** ONLY when (a) the user asks for a new chat, (b) the current
  chat visibly lags, or (c) this conversation is Work. Then:
  1. Same iab tab: `goto` `https://chatgpt.com/`, confirm Chat mode
     (**In-app browser** §7), then send the boot prompt.
  2. Run the workspace_info check; only then
     `c2c session set --local-session <localSessionId> --url <url>` and re-read
     the route. On failure, leave the old saved URL unchanged.
  3. After the route is `resume-chat`, send a HANDOFF (`docs/protocol.md`) —
     goal, progress, state, issues, next step. If the checkpoint is waiting on
     a mailbox result, include its `RESULT_REQUEST_ID` and `RESULT_PHASE`.
     Never paste files.
- Saved chat 404s: treat as a switch. Reconstruct HANDOFF from
  `session.checkpoint` (goal, progress, issues, next step). If there is no
  checkpoint, use `task` / `iteration` / `lastState` and `execution_summary`
  metadata only. Never paste logs or output bodies.

### project (new workspaces)

One ChatGPT Project per workspace. Mapping:

1. Same local Codex session → same ChatGPT
   chat URL. `goto` that URL directly. Do not open the collection first.
2. Same workspace, a **new** local Codex session → new ChatGPT chat from the
   collection page (`conversation.projectUrl`). Its `session.url` starts empty;
   never borrow another local session's chat URL.
3. Different workspace → different Project and different connector.

**Open a chat for this local Codex session**

- If `conversation.reuseSavedChat` and `conversation.chatUrl` are set:
  `goto` that URL. Continue. No new chat. No HANDOFF.
- Else if `conversation.projectReady`: `goto` `conversation.projectUrl`.
  On that page, use the on-page composer (「{项目名}中的新聊天」 / "New chat
  in …"). Do not use the sidebar and do not `goto` `https://chatgpt.com/`.
  Confirm Chat mode (**In-app browser** §7). Boot prompt, then workspace_info
  with the **exact** `connectorName`. After the reply names this workspace,
  `c2c session set -w <ws> --local-session <localSessionId> --mode project --project-url <collection> --url <chat> --connector-name "<connectorName>" --title "C2C <workspace name>"`.
  Re-read the route. If this local Codex session is continuing a previous C2C
  task, send HANDOFF only after the route is `resume-chat`. Include the active
  mailbox request id and phase when the checkpoint is waiting for a result.
- Else: **Bind Project** first.

**Update it**: same `c2c session set --local-session <localSessionId>
--task / --iteration / --state` as long-chat.

**Wrong collection**: do not guess another Project. Tell the user the expected
workspace name, ask them to open the right collection, then say「已找到」.
Also offer「继续用长对话」. If they pick long-chat:
`c2c session set -w <ws> --local-session <localSessionId> --mode long-chat`
and use the long-chat path.
If the collection 404s or the new chat is not inside the Project, same choice.

**Saved chat 404s** (this local session): `goto` the collection, open a new chat
there, boot + workspace_info, then save the new chat URL for
`<localSessionId>` and re-read the route. Only after `resume-chat` is confirmed,
send HANDOFF from `session.checkpoint` (including an active mailbox request
id/phase, but no logs). Keep `--project-url`.

### Bind Project (user creates the collection once)

Do this for a new workspace, or when an existing user asks to switch to
Project. Do **not** click the ChatGPT sidebar to create the Project
(Computer Use is forbidden; IAB must not hunt that menu).

1. Tell the user exactly this (fill in the workspace name):

```
请在 ChatGPT 里新建一个项目，名字用「<workspaceName>」，记忆请选「仅限项目记忆」。

如果侧栏里看不到「项目」：把鼠标放在「聊天」上，点右边出现的三个点，选择「按项目整理」。

建好后会打开合集页面。看到页面后跟我说「好了」。
```

2. Wait for「好了」/ the collection page. Same iab tab: read the address bar.
   It must look like `https://chatgpt.com/g/g-p-…/project`. If it does not,
   ask them to open that project until it does. Then:
   `c2c session set -w <ws> --local-session <localSessionId> --mode project --project-url <url> --connector-name "<connectorName>"`.

3. On that same collection page only, open 右上角 **… → 项目设置**.
   Do not click 分享. Do not add 来源 / files.
   - 记忆: 仅限项目记忆 (project-only). Leave 库访问权限 disabled.
   - 指令: paste **Project instructions** below (fill `{{…}}` from
     `workspace_info` / setup). Use the exact `connectorName` from setup.
     Never write the public / temporary address into 指令.
   Save and close settings.

4. Still on the collection page, create the first chat with the on-page
   composer, then boot + workspace_info as in setup step 5. Save the chat URL.

### Project instructions (paste into 项目设置 → 指令)

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_summary, test_status, and execution_output with the
exact local_session_id, task_id, and iteration from that control message.
For execution_output, list then read with the same correlation fields. If an
item is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

Own the expensive reasoning work: search and read the relevant code through the
connector, analyze architecture and debugging evidence, and use ChatGPT web
research when the task depends on current external facts. Wait for research to
finish before submitting. A RESEARCH request must return a standalone RESEARCH
payload with the question, summary, conclusions, source title/URL/publication
date/key evidence, and open questions. Do not duplicate those fields inside a
PLAN or REVIEW. Codex will apply edits and run local verification.

When Codex provides RESULT_REQUEST_ID, you may call report_control_progress
with the exact requestId, localSessionId, taskId, iteration, and phase from the
newest Codex control question. Progress may move forward only through
SEARCHING, READING_CODE, and SYNTHESIZING; report each state at most once and
do not use progress messages for substantive results. Then call
submit_control_result exactly once with that same correlation tuple. Never
reuse identifiers from an earlier turn. The
result is advisory only. Do not include patches, shell commands, diffs, logs,
file bodies, credentials, or absolute / traversal paths. After the tool
succeeds, keep the visible reply to a short receipt that echoes
RESULT_REQUEST_ID, LOCAL_SESSION_ID, TASK_ID, ITERATION, RESULT_PHASE, and the
returned RESULT_ID.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and
no 40-step epics. Use C2C control messages.
```

## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX"）

Protocol states sent to ChatGPT: optional RESEARCH → INIT → PLAN → EXECUTING → EXECUTED → (REVIEW | DONE | BLOCKED).
Local checkpoint states (session only, never a ChatGPT `STATE:` line):
`RESEARCH_SENT`, `RESEARCH_RECEIVED`, `INIT`, `PLAN_RECEIVED`, `EXECUTING`,
`EXECUTED_LOCAL`, `EXECUTED_SENT`, `DONE`, `BLOCKED`.
Do not invent `STATE: RESUME`. If the original chat is gone, send HANDOFF.
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
ChatGPT's structured results are expected to be substantive (see step 3).
Docs: `docs/protocol.md`.

0. `c2c tunnel status -w <workspace> --json`. If `needsChoice`, follow
   **Connection choice** first (existing installs: ask once, then remember).
   Then `c2c doctor -w <workspace> --json` (auto-repairs). **Doctor gate:** if local
   is not green, do not open ChatGPT and do not send INIT. If
   `namedRepair.needed` is true, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json` (their browser; Cloudflare exception), then doctor
   again. If `chatgptRepair.needed` is true, tell the user `chatgptRepair.userMessage`
   (one paragraph, no internals), run **Workflow: connector or authorization
   repair**, then doctor again and only continue when the gate is green.
   Generate task id: `c2c_` + 16 random hex chars — unless a checkpoint already
   has one (reuse that id; do not mint a second task).
1. Run `c2c session -w <workspace> --json`. Capture
   `sessionIdentity.id` as `<localSessionId>` and keep its `resultTransport`
   value for this loop (`auto` by default; never invent another value). Use
   `route` to open ChatGPT on the same iab tab and enforce the **Routing gate**
   (foreground + markHandoff). Never infer the destination from the visible
   page. On a NEW conversation
   confirm Chat mode (**In-app browser** §7), then send the boot prompt from
   `docs/protocol.md` §Boot Prompt and the workspace_info check (name the
   exact `connectorName`). Confirm the reply names the current workspace
   before saving the session URL. Do not use the browser to re-read code MCP
   already provides. After sending a control message, wait per
   **In-app browser** §8.

   **Resume from `session.checkpoint` before any INIT.** With no active
   checkpoint, continue as a normal new/continued loop. A browser/js
   timeout is not a lost task — claim the original tab; do not INIT, re-run,
   or resend EXECUTED just because a wait timed out.
   - When `resultTransport` is not `browser`, `waitingFor` is `GPT_RESEARCH`,
     `GPT_PLAN`, or `GPT_REVIEW`, and the checkpoint has a matching `mailboxRequestId` /
     `mailboxPhase`, run
     `c2c control status -w <ws> --local-session <localSessionId> --request <id> --task <taskId> --iteration <n> --phase <RESEARCH|PLAN|REVIEW> --json`,
     then
     `c2c control wait -w <ws> --local-session <localSessionId> --request <id> --task <taskId> --iteration <n> --phase <RESEARCH|PLAN|REVIEW> --json`
     if still pending. Consume that request before inspecting the page or sending
     anything again. `control open` is idempotent for the same local session,
     task, iteration, and phase until its result is acknowledged, so call it
     again to recover the id if the checkpoint write was interrupted. Because
     opening local state and sending a browser message cannot be one atomic
     operation, recover the turn before sending: run `control status` for the
     returned id. Consume a received result immediately. If it is pending,
     inspect only this routed chat for an outbound user message containing that
     exact `RESULT_REQUEST_ID`. When found, rebuild the matching checkpoint and
     wait without resending. Only when the exact outbound message is absent may
     the pending request be sent once and checkpointed. Never decide from the
     latest assistant answer.
   - `EXECUTED_SENT` + `waitingFor=GPT_REVIEW`: do not INIT, do not re-run,
     do not resend EXECUTED. Stay on the saved chat and wait for the result. If
     that chat 404s: HANDOFF from checkpoint fields (no logs), then wait.
   - `EXECUTED_LOCAL`: local work is done; only send EXECUTED (record first
     if this iteration has no record yet). Do not re-run.
   - `EXECUTING`: not finished. Continue the current PLAN if you still have
     it; otherwise HANDOFF and ask ChatGPT to restate the last PLAN. Do not
     treat it as done and do not INIT a new task.
   - `PLAN_RECEIVED`: execute that plan. Do not INIT.
   - `RESEARCH_SENT` / `waitingFor=GPT_RESEARCH`: claim the tab and wait for
     the exact RESEARCH request. Do not resend it. After receipt and ack, save
     `RESEARCH_RECEIVED`, then continue with INIT in the same chat.
   - `RESEARCH_RECEIVED`: the research turn is complete; send INIT in the same
     chat and tell ChatGPT to plan from that research. Do not repeat research.
   - `INIT` / `waitingFor=GPT_PLAN`: claim the tab and wait locally when a
     mailbox request exists; otherwise use the browser path. Do not resend INIT.
   - `DONE`: summarize to the user if needed;
     `c2c session set --local-session <localSessionId> --clear-checkpoint`.
   - `BLOCKED`: surface ChatGPT's reason; do not INIT.
   Never re-pair, never recreate the connector, and never rewrite Project
   instructions just to resume.
2. If the task depends on current external facts, the user asked for web
   research, or a prior result identifies an unresolved external question,
   complete one formal RESEARCH turn before INIT. Do not open a RESEARCH turn
   for repository-only work. In `browser` transport, skip the separate turn and
   ask ChatGPT to research inside INIT. Otherwise run:

   `c2c control open -w <ws> --local-session <localSessionId> --task <id> --iteration 0 --phase RESEARCH --json`

   Immediately enforce the routing gate, then send:

```
[C2C]
STATE: RESEARCH
LOCAL_SESSION_ID: <localSessionId>
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 0
RESULT_REQUEST_ID: <request.requestId>
RESULT_PHASE: RESEARCH

QUESTION:
<the external question that must be settled, one paragraph>

INSTRUCTION:
Research current public sources and inspect relevant workspace code through the
connector. As work advances, call report_control_progress with this exact
correlation tuple, moving only forward through SEARCHING, READING_CODE, and
SYNTHESIZING. Submit one RESEARCH or BLOCKED result with
submit_control_result. A RESEARCH result must include conclusions and source
title, URL, publication date (null only when unavailable), key evidence, and
open questions. After success, reply only with the correlation receipt.
```

   Save the checkpoint:
   `c2c session set -w <ws> --local-session <localSessionId> --task <id> --iteration 0 --state RESEARCH --protocol-state RESEARCH_SENT --waiting-for GPT_RESEARCH --goal "<short goal>" --next-step "wait for RESEARCH" --mailbox-request <id> --mailbox-phase RESEARCH`
   Wait with the exact RESEARCH correlation. `control status` and `control wait`
   expose only the latest validated progress state; progress never counts as an
   answer. Require `RESEARCH` or `BLOCKED`. For RESEARCH, require at least one
   source and read the substantive payload locally, then acknowledge it:
   `c2c control ack -w <ws> --local-session <localSessionId> --request <id> --task <taskId> --iteration 0 --phase RESEARCH --json`.
   Save `RESEARCH_RECEIVED` with `waitingFor=none`, `next-step="send INIT"`, and
   `--clear-mailbox`. Only then open the PLAN request. A BLOCKED result follows
   the terminal path below.
3. Prepare and send INIT (skip when the checkpoint says not to). Unless
   `resultTransport` is `browser`, first run:

   `c2c control open -w <ws> --local-session <localSessionId> --task <id> --iteration 0 --phase PLAN --json`

   Keep the returned `request.requestId`. `control open` binds it to this local
   Codex session. Include it in INIT; in `browser` mode omit the
   `RESULT_REQUEST_ID` line and use the legacy instruction.
   Immediately before sending, re-read
   `c2c session -w <ws> --local-session <localSessionId> --json` and enforce
   `route.action=resume-chat`, `route.controlReady=true`, and the exact expected
   chat URL.

```
[C2C]
STATE: INIT
LOCAL_SESSION_ID: <localSessionId>
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 0
RESULT_REQUEST_ID: <request.requestId>
RESULT_PHASE: PLAN

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Use any completed RESEARCH turn in this chat; do not repeat it. Perform the
repository analysis yourself. You may report forward-only progress with
report_control_progress using this exact correlation tuple.
Submit one substantive PLAN or BLOCKED result with submit_control_result using
the exact RESULT_REQUEST_ID, LOCAL_SESSION_ID, TASK_ID, ITERATION, and
RESULT_PHASE above. After success, reply only with a correlation receipt
containing those five values and the returned RESULT_ID.
```

   Then:
   `c2c session set -w <ws> --local-session <localSessionId> --task <id> --iteration 0 --state INIT --protocol-state INIT --waiting-for GPT_PLAN --goal "<short goal>" --next-step "wait for PLAN" --mailbox-request <id> --mailbox-phase PLAN`
   Omit mailbox flags in `browser` mode.
4. Wait per **In-app browser** §8. For `mailbox` / `auto`, run:

   `c2c control wait -w <ws> --local-session <localSessionId> --request <id> --task <taskId> --iteration 0 --phase PLAN --json`

   The CLI rejects any request/result file that does not match this exact
   request, local session, task, iteration, phase, and integrity hash. Require
   kind `PLAN` or `BLOCKED`, and read the substantive `payload` locally. Then run
   `c2c control ack -w <ws> --local-session <localSessionId> --request <id> --task <taskId> --iteration 0 --phase PLAN --json`. Never scrape the short
   receipt. In `auto`, the browser
   reply is a fallback only under §8; `mailbox` never falls back to parsing.
   A PLAN must carry goal, rationale, concrete actions, tests, and success
   criteria. The schema enforces this for mailbox results; apply the same
   standard to a browser result and ask once for expansion if it is too thin.
   The first accepted PLAN schedules execution iteration 1. A REVIEW accepted
   for iteration `<n>` schedules iteration `<n + 1>`; never record or send two
   executions under the same iteration number. Once a non-terminal result is
   acknowledged, clear its mailbox pointer from the active checkpoint before
   advancing the iteration; the immutable mailbox files remain the audit log.
   Then:
   `c2c session set -w <ws> --local-session <localSessionId> --iteration 1 --protocol-state PLAN_RECEIVED --waiting-for none --next-step "execute PLAN" --clear-mailbox`
   For BLOCKED, use the terminal path in step 11 instead of executing.
5. Execute the plan yourself with your own harness (your tools, your judgment;
   ChatGPT does not micro-manage tool calls). Use iteration 1 after INIT; after
   a REVIEW for iteration `<n>`, increment to `<n + 1>` before changing the
   checkpoint or recording any evidence.
   Before you start:
   `c2c session set -w <ws> --local-session <localSessionId> --protocol-state EXECUTING --waiting-for none --next-step "finish PLAN then record"`
6. Record the execution so ChatGPT can read it via MCP. Metadata always:
   `c2c record -w <ws> --local-session <localSessionId> --task c2c_f81a0c9e72ab43d1 --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok`
   If this iteration ran a **test / build / lint / typecheck** command, also
   pass that command's output. Write stdout/stderr to a local temp file first,
   then:
   `c2c record … --command "pnpm test" --output-file <temp> --exit-code <n>`
   Record both success and failure. Do not record shell history, `.env`,
   keys, or unrelated dumps. Never paste that file (or any log) into ChatGPT.
   If the CLI says the output was not released, still send EXECUTED; ChatGPT
   reviews from git. Then:
   `c2c session set -w <ws> --local-session <localSessionId> --iteration 1 --state EXECUTED --protocol-state EXECUTED_LOCAL --waiting-for none --next-step "send EXECUTED"`
7. Prepare and send EXECUTED (no diffs, no logs). Unless `resultTransport` is
   `browser`, first run:

   `c2c control open -w <ws> --local-session <localSessionId> --task <id> --iteration <n> --phase REVIEW --json`

   Immediately before sending, re-read the session with
   `--local-session <localSessionId>` and enforce the same `resume-chat` route.
   Include the returned request id and tell ChatGPT to use MCP, including
   `execution_output` when a readable item exists:

```
[C2C]
STATE: EXECUTED
LOCAL_SESSION_ID: <localSessionId>
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 1
RESULT_REQUEST_ID: <request.requestId>
RESULT_PHASE: REVIEW

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
Call execution_summary, test_status, and execution_output with the exact
LOCAL_SESSION_ID, TASK_ID, and ITERATION above. If execution_output lists a
readable item for this iteration, list then read it using the same values.
If status is restricted, ignore it and review from git_diff.
You may call report_control_progress with the exact correlation tuple while
working, moving only forward through the supported states.
Submit REVIEW, DONE, or BLOCKED with submit_control_result using the exact
RESULT_REQUEST_ID, LOCAL_SESSION_ID, TASK_ID, ITERATION, and RESULT_PHASE above.
After success, reply only with a correlation receipt containing those five
values and the returned RESULT_ID.
```

   Then:
   `c2c session set -w <ws> --local-session <localSessionId> --protocol-state EXECUTED_SENT --waiting-for GPT_REVIEW --next-step "wait for REVIEW, DONE, or BLOCKED" --mailbox-request <id> --mailbox-phase REVIEW`
   In `browser` mode omit the request header, mailbox flags, and submit-tool
   instruction.
8. Wait through the same transport as step 4, passing `--task <taskId>
   --iteration <n> --phase REVIEW` to both `control wait` and `control ack`.
   For mailbox results, let the CLI validate and acknowledge the exact request
   before acting. ChatGPT reviews via MCP (`git_diff`,
   `read_file`, `test_status`, `execution_output`) and returns:
   - `REVIEW`: findings and actions for the next iteration. Save
     `PLAN_RECEIVED` with `--iteration <n + 1> --clear-mailbox`, then execute
     those actions. The acknowledged result remains in the mailbox audit log
     correlated to reviewed iteration `<n>`; the checkpoint's incremented
     iteration identifies the next execution. In legacy `browser` mode, accept an equivalent visible
     `STATE: PLAN` result. In an `auto` browser fallback, save it with
     `--clear-mailbox` instead of mailbox metadata.
   - `DONE`: success criteria met; continue to step 10.
   - `BLOCKED`: continue to step 11.
9. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause and ask
   the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
10. On DONE: summarize the result to the user in plain language.
   `c2c session set -w <ws> --local-session <localSessionId> --state DONE --clear-checkpoint`
11. On BLOCKED: read the structured reason, fix what you can, or surface the
    single decision the user must make.
    `c2c session set -w <ws> --local-session <localSessionId> --protocol-state BLOCKED --waiting-for USER --known-issues "<short reason>" --mailbox-request <id> --mailbox-phase <RESEARCH|PLAN|REVIEW> --mailbox-result <resultId>`

## Workflow: disconnect（"断开 ChatGPT"）

1. `c2c unpair -w <workspace>` (revokes all tokens immediately).
2. Optionally remove the connector on the same iab tab via
   `https://chatgpt.com/plugins` (foreground + markHandoff). Only touch
   this workspace's `connectorName`.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: connector or authorization repair（连接地址失效或权限升级）

This covers either a reclaimed public address or an existing connector whose
OAuth grant predates `c2c.result.write`. Doctor has already repaired local
services and generated a new pairing code. Both cases require a fresh grant;
never try to extend an existing token locally.
`connectorAction: "update"` means Delete + create again — not Reconnect.

`c2c doctor --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pairingCode": "...", "pages": { ... } } }`

1. Tell the user exactly `chatgptRepair.userMessage`. Then you repair. Do not
   ask them to click around ChatGPT unless a login wall appears. Do not open
   the C2C chat and do not send `[C2C]` until this repair finishes and a
   follow-up doctor is green. Never "try a message first to see if it works".
   Reuse `c2c prefs --json`. Do not re-ask setup mode. If `setupMode` is
   `manual`, use **Guided manual ChatGPT setup** (chosen) instead of automating.
2. Same one iab tab as setup (foreground + markHandoff). Settings URLs only
   until Connected — never hunt menus:
   - 开发人员模式: skip `https://chatgpt.com/#settings/Security` when
     `developerModeEnabled` is true. If create/delete then says developer
     mode is required, open it, enable, `c2c prefs set --developer-mode`.
   - 插件总管（只用来 Delete）: `https://chatgpt.com/plugins`
   - 加插件（Delete 之后必走）: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
3. Operate ONLY on `chatgptRepair.connectorName`. Never touch another
   workspace's connector.
   - If that exact name exists on the plugins hub: **Delete** it. Confirm the
     delete if ChatGPT asks. **Never click Reconnect, Refresh, Connect, or
     Edit** on the old card: a replaced Server URL may hang, and reconnecting
     cannot add a newly required scope to the old grant.
   - Then `goto` the 加插件 URL and create that **same** `connectorName`
     (do not invent a second name):
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: `chatgptRepair.mcpUrl`
      - Authentication: OAuth
     Then Connect / Authorize and type `chatgptRepair.pairingCode`
     (or `c2c pair --json` if it expired). Continue as soon as it is Connected —
     do not wait for a fixed tool count on the settings page.
   - If the name is already gone, skip Delete and only create.
4. `c2c doctor --json` again. Same tab: only after the Doctor gate is green,
   reopen the chat this local Codex session was already using (`session.url` /
   the URL saved for THIS local session). Do not start a new
   audit/task chat just because the address changed. Do not rewrite Project
   instructions — they store the connector **name**, which did not change.
5. If the ChatGPT conversation was lost: long-chat → Conversation
   management switch. project → collection page, new chat, boot + workspace_info,
   save its URL for `<localSessionId>`, confirm the `resume-chat` route, then HANDOFF.
   No file re-uploading (the workspace lives in MCP). After recreating the
   same-name connector, the Project still uses that name. If tools point at
   the wrong connector, open 项目设置 and confirm 指令 still names
   `connectorName` (never paste the new public address).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json`. Doctor gate: do not open ChatGPT / send
   `[C2C]` until local is green, except reconnect settings pages.
2. If `namedRepair.needed`, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json`, then doctor again. Do not Delete the connector.
3. If `chatgptRepair.needed`, follow **connector or authorization repair**, then
   doctor again.
4. Otherwise apply the recovery map. Only involve the user for login / 2FA /
   CAPTCHA — one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable / 全关掉后连接失效 | `c2c doctor` → if `namedRepair.needed`, login to Cloudflare and doctor again (do not Delete). If `chatgptRepair.needed`, tell the user the message, then **Delete** THIS workspace's connector only (`connectorName`) and create it again. Never Reconnect. |
| ChatGPT says tool call failed / 401 | token expired or revoked → re-pair (new pairing code + authorize) |
| Doctor reports that the existing ChatGPT authorization lacks result-write access | Delete and recreate only this workspace's connector using `chatgptRepair`; scopes cannot be added to an existing grant locally. |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Same explicit ChatGPT setup/reconnect browser configuration step fails twice after repair | Stop automating ChatGPT settings and use **Guided manual ChatGPT setup fallback**. Do not count browser/js timeout, loading/generating, or login/2FA waiting as failures. |
| Port conflict | handled automatically; never surface to the user |
| Every new chat “repairs” / cannot write the log or settings directory | `c2c sandbox-allow --json` (once). Do not ask the user. |
| cloudflared missing | install it yourself (brew/winget), then retry |
| Sidebar has no「项目」 | Ask the user to hover「聊天」, click the …, choose「按项目整理」 |
| Collection page is the wrong Project | Ask the user to open the named collection and say「已找到」, or accept long-chat |
