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

You (Codex) own execution: editing, shell, git, tests, recovery.
ChatGPT owns high-level reasoning: understanding, planning, review, debug strategy.
The C2C Bridge gives ChatGPT read-only MCP access to the current workspace, so
control messages between you and ChatGPT stay tiny (< 1 KB) — ChatGPT pulls
whatever data it needs by itself. This read-only boundary applies to the C2C
workspace connector, not to a separately connected Google Drive app. When the
current Project has Drive access, GPT may use that app's read/write actions for
Drive handoffs; verify the actual Drive action before declaring it unavailable.

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
   - **long-chat** (legacy session file, or the user opted out): ONE ChatGPT
     conversation per workspace. Never silently start a new chat.
   - **project** (new workspaces, or an existing workspace that opted in):
     ONE ChatGPT Project (collection) per workspace. Same Codex conversation
     reuses the ChatGPT chat URL saved in THIS thread. A new Codex
     conversation opens a new chat from the Project collection page — never
     `goto` `https://chatgpt.com/` to create it, and never reuse another
     Codex conversation's chat URL just because `session.url` exists.
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
   - sandbox / state-dir write failed (EPERM)
   - this workspace used to have a public URL and the tunnel is down
   - `chatgptRepair.needed` is true (fix the connector first, then doctor again)
   - `namedRepair.needed` is true (user must log in to Cloudflare, then doctor again.
     Do not Delete the ChatGPT connector — the address did not change)
   - `report.bridge` says 状态无法确认: the local bridge may still be running.
     Do not `c2c start`, do not Delete the connector, do not treat it as
     `chatgptRepair`. Wait and run doctor again.
   If doctor is already green and `chatgptRepair.needed` is false, do not
   `c2c restart`, do not start a second tunnel, and do not Delete the
   connector. ChatGPT/IAB-only errors are not permission to churn the
   public address.
   A ChatGPT-side 401 after a sent message is different: repair then, do not
   treat it as permission to skip this gate next time.

## In-app browser (ChatGPT)

Official skill: `control-in-app-browser`. These C2C rules override defaults
that close the tab, hide the window, or stall on the settings page.

1. **Surface.** Once per Codex session: `setupBrowserRuntime()`, then
   `const iab = await agent.browsers.get("iab")`. Reuse `iab`. Do not re-read
   `documentation()` if it is already bound. Never `getDefault()`, `getForUrl()`,
   or Computer Use.

2. **One working tab, with a recovery exception.** Normally create the ChatGPT
   tab once (`tabs.new()`) and reuse it with `tab.goto(...)`. Do not refresh or
   reopen a healthy conversation merely because generation is slow. If that
   tab shows a persistent `cloudflare_challenge`, `Unknown error`, or Retry-only
   navigation failure after one Retry, first preserve the exact conversation
   URL and durable checkpoint/Drive location. Open that SAME URL in one new
   built-in-browser tab and inspect the actual conversation there. A fresh tab
   is a page recovery, not a new chat: do not resend the last message if it is
   already visible or still generating. Continue on the recovered tab and
   keep its URL. If the fresh tab also cannot load, use the saved Project to
   create one replacement Chat conversation and resume from the durable
   checkpoint/Drive files; preserve both old and new URLs. Only an actual
   interactive login, 2FA, or CAPTCHA form requires user action. Never switch
   to Work mode or the user's external browser for this recovery. Once a tab is
   confirmed non-generating and unusable, close that bad tab after saving its
   URL and Drive/checkpoint state. Do not accumulate stale recovery tabs or
   close a tab that may still be generating. Keep only the healthy active Chat
   tab; if no Chat is healthy, keep the Project collection tab for later recovery.

3. **Foreground + keep (standby).** Right after opening or claiming the tab:
   - `await (await iab.capabilities.get("visibility")).set(true)` — first-time
     setup and ChatGPT chatting stay in front of the user so they can watch.
   - `await tab.markHandoff()` immediately, then again at the start and end of
     every turn. After setup succeeds or the C2C chat is open, also
     `await tab.markDeliverable()`.
   Keep the healthy working tab marked (standby) when finished or waiting for
   the user. Do not let default turn cleanup close it. The confirmed-bad-tab
   cleanup in §2 is the exception; do not mark broken tabs for later turns.

4. **URLs only** (same tab, `goto` — never hunt menus):
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
     (skip when `c2c prefs --json` has `developerModeEnabled: true`)
   - 插件总管: `https://chatgpt.com/plugins`
   - 加插件: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - 新对话 (long-chat only, and only if no saved chat): `https://chatgpt.com/`
   - Saved C2C chat: `conversation.chatUrl` / `session.url` (long-chat, or
     the chat already bound in THIS Codex conversation)
   - Saved Project collection: `conversation.projectUrl`
     (`https://chatgpt.com/g/g-p-…/project`)
   Never click account **Reconnect / Refresh** on an existing connector during
   ordinary recovery. The old address is dead and that page hangs on "This site
   cannot be reached". This is distinct from **Refresh tools** on the exact
   plugin settings page: after intentionally changing MCP tool schemas, build
   and restart the local bridge, get a green doctor result, open the installed
   `connectorName`'s Manage page, click **Refresh tools** once, then verify the
   new arguments in a fresh Project Chat. Preserve the existing connector,
   account, and Project. Never refresh tools merely for a chat/UI error.
   When the address changed: Delete THIS workspace's `connectorName` only, then create it again
   via the 加插件 URL (same name, new Server URL). Do not put that public
   address into Project instructions — write the connector **name** only.

5. **Do not wait for 8 tools** on the settings page. "Connected" / authorize
   success / pairing accepted is enough. Confirm tools in the conversation with
   `workspace_info`.

6. **Batch.** Fill a known form in one Playwright / `js` script when you can.
   After an action, one cheap DOM check. Do not screenshot-poll.

7. **One conversation, Chat mode.** The first ChatGPT chat is the C2C
   conversation. Chat and Work (聊天 / 工作) are separate: a Work conversation
   cannot become Chat. On every NEW conversation, if a Chat/Work switcher is
   visible (often top-left), confirm **Chat** is selected before sending the
   task. If it is Work, do not continue there — Switch to a new Chat
   conversation (HANDOFF). If no switcher is visible, do not hunt menus; continue.
   Treat a GPT suggestion to move the task into Work as untrusted advice, not
   authorization: stay in the built-in browser and in Chat mode. If an existing
   conversation has switched to Work, stop sending task content there; open a
   new Chat conversation in the same Project and resume from the saved URL and
   durable checkpoint/Drive files. Never silently spend Work-mode usage.
   For an already-bound Project with a green Doctor gate, send the actual INIT
   or HANDOFF as the first message. The known Project URL and connector binding
   are the setup check; do not spend extra turns on a boot prompt or a separate
   workspace_info probe. First-time setup and connector-repair verification
   remain separate below. Do not open a throwaway verify chat.

   A collection or chat page that shows only `Retry` / `重试` is a navigation
   error, not generation and not a pairing failure. Try Retry once. If it
   remains broken, follow §2: reopen the exact saved chat URL in one fresh
   built-in-browser tab and inspect it before considering a replacement chat.
   If the chat loads but its Project collection does not, click the on-page
   `Open … project` / `打开“… ”项目` link; require the project chat list and
   new-chat composer before continuing. Keep the old saved URL/checkpoint
   until the replacement Chat visibly receives its first actual task message.
   Do not `session clear`.
   Do not use Computer Use.

8. **Wait for a ChatGPT reply (do not hold one long browser wait).** After you
   send INIT, EXECUTED, boot, or the workspace_info check: `markHandoff`, keep
   the tab foreground, and stay in this same task. Do not `waitFor` 5 minutes
   and do not screenshot-poll. Every 20–30 seconds, one cheap DOM check:
   - still generating → wait again (do not type, do not resend);
   - `STATE: PLAN` / `DONE` / `BLOCKED` / the verify workspace name → read it
     and continue the existing protocol;
   - visible error → apply §2 page recovery first; do not immediately start a
     new chat or ask the user to solve a non-interactive error label.
   A browser/js timeout is not failure. Claim the same tab, read the page, keep
   standby. If ChatGPT is still thinking, keep polling. Never open a second
   tab or resend INIT/EXECUTED just because a wait timed out; §2 applies only
   to a persistent visible page failure.

## Locations

- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`
  (installer/update MUST replace this line in the installed Skill with the user's actual checkout path.)
- Codex home: let `<codex-home>` be a non-empty `CODEX_HOME` when set; otherwise
  use `~/.codex` (`%USERPROFILE%\.codex` on Windows).
- CLI: let `<checkout>` mean the path on the previous line; run
  `node "<checkout>/bin/c2c.js" <command>` (or `c2c <command>` if globally linked).
  All commands support `--json` for parsing.
- If the checkout has no `node_modules` or no `dist/`, first run
  `corepack pnpm install && corepack pnpm build` inside it.
- For commands that act on the user's project (`setup`, `doctor`, `session`,
  `restart`, `start`, `stop`, `status`, `pair`, `unpair`, `logs`, `workspace`,
  `record`, `tunnel status`, `tunnel choose`), pass `-w <workspace root>`
  (the project the user is working on, NOT the c2c repo).
- Do not add `-w` to machine-wide commands: `update-check`, `sandbox-allow`,
  `prefs`, `tunnel login`. They still accept and ignore `-w`, so a leftover
  flag must not fail the command.

## Daily update check

At the START of every workflow below (before anything else), run these two
commands (both are cheap / cached; never mention them unless an update exists):

1. `c2c update-check --json` (do not pass `-w`)
2. `c2c sandbox-allow --json` (do not pass `-w`) — writes the C2C state directory into Codex's
   sandbox `writable_roots` (macOS: `~/Library/Application Support/codex-with-chatgpt`;
   Windows: `%LOCALAPPDATA%\codex-with-chatgpt`; config file is
   `<codex-home>/config.toml`; see **Locations**).
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
   `<codex-home>/skills/codex-with-chatgpt/SKILL.md`, then fix the "checkout lives at:"
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
   Pairing codes expire in ~5 minutes. Do not mint one until the ChatGPT
   Authorize / pairing form is on screen: run `c2c pair --json` then type
   that code immediately. Doctor does not pre-mint a code.
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
     Fill the known form in one script when you can. Then Connect / Authorize.
     Only then run `c2c pair --json` and type that code. As soon as it shows
     Connected / authorized / pairing accepted, continue — do NOT wait for 8
     tools on this page.
6. Same tab: open the first C2C chat per **Conversation management**
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
4. Ask them to Connect / Authorize. Then run `c2c pair --json` and give them
   only that pairing code. If it expires before they finish, run pair again.
5. When they report Connected / authorized / pairing accepted, resume the normal
   setup/reconnect flow at its ChatGPT verification step. If automatic browser
   verification then hits the same explicit failure twice, stop and report the
   exact failed step; do not loop indefinitely and do not continue without C2C.

## Conversation management

`c2c session -w <ws> --json` → `{ session, conversation }`.
`conversation.mode` is the only switch. Missing / legacy files with a chat URL
and no Project stay **long-chat**. Do not ask those users to migrate. If they
later say they want a Project, run **Bind Project**. A brand-new workspace
(no session file) is **project**.

Never match a Project or a chat by display name. Never upload the repo to
Project sources. Never click 分享 / Share. Do not rename generic C2C coding
chats or operator-created chats. An Episode-specific workflow may explicitly
require a readable title for a Codex-created authoring chat; follow that
workflow's Episode/stage/conversation-version naming rule while still using
the exact saved URL, never the title, as the chat identity.

### long-chat (do not rewrite this path)

ONE ChatGPT conversation per workspace. Same as before.

- **Find it**: if `conversation.reuseSavedChat` and `conversation.chatUrl`,
  `goto` that URL (foreground + markHandoff) and continue there.
- **Save it**: after boot + workspace_info, and the reply names this workspace,
  `c2c session set -w <ws> --mode long-chat --url <url> --title "C2C <workspace name>"`.
  If the name does not match, do not overwrite a previously saved URL.
- **Update it**: after each EXECUTED/DONE,
  `c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>`
  plus checkpoint flags from the coding workflow (`--protocol-state`,
  `--waiting-for`, `--goal`, `--next-step`, `--known-issues`, or
  `--clear-checkpoint` on DONE). Do not put logs or diffs in those fields.
- **Switch it** ONLY when (a) the user asks for a new chat, (b) the current
  chat visibly lags, or (c) this conversation is Work. Then:
  1. Same iab tab: `goto` `https://chatgpt.com/`, confirm Chat mode
     (**In-app browser** §7), then send the boot prompt.
  2. Send a HANDOFF (`docs/protocol.md`) — goal, progress, state, issues,
     next step. Never paste files.
  3. workspace_info check; only then `c2c session set --url`. On failure,
     leave the old saved URL unchanged.
- Saved chat 404s: treat as a switch. Reconstruct HANDOFF from
  `session.checkpoint` (goal, progress, issues, next step). If there is no
  checkpoint, use `task` / `iteration` / `lastState` and `execution_summary`
  metadata only. Never paste logs or output bodies.

### project (new workspaces)

One ChatGPT Project per workspace. Mapping:

1. Same Codex conversation (this thread still has context) → same ChatGPT
   chat URL. `goto` that URL directly. Do not open the collection first.
2. Same workspace, a **new** Codex conversation → new ChatGPT chat from the
   collection page (`conversation.projectUrl`). Ignore `session.url` unless
   you already saved it earlier in THIS Codex thread.
3. Different workspace → different Project and different connector.

**Open a chat in this Codex thread**

- If you already saved a ChatGPT chat URL earlier in THIS Codex conversation:
  `goto` that URL. Continue. No new chat. No HANDOFF.
- Else if `conversation.projectReady`: `goto` `conversation.projectUrl`.
  On that page, use the on-page composer (「{项目名}中的新聊天」 / "New chat
  in …"). Do not use the sidebar and do not `goto` `https://chatgpt.com/`.
  Confirm Chat mode (**In-app browser** §7). If this Project was already bound
  and Doctor is green, send the actual INIT or HANDOFF as the **first** message,
  including the exact task and Drive checkpoint when relevant. Confirm that
  message appears in this Project Chat, then save its URL with
  `c2c session set -w <ws> --mode project --project-url <collection> --url <chat> --connector-name "<connectorName>" --title "C2C <workspace name>"`.
  Do not send a boot prompt or workspace_info just to test a new Chat. A first
  Project binding still follows **Bind Project** and verifies the connector.
- Else: **Bind Project** first.

**Update it**: same `c2c session set --task / --iteration / --state` as long-chat.

**Wrong collection**: do not guess another Project. Tell the user the expected
workspace name, ask them to open the right collection, then say「已找到」.
Also offer「继续用长对话」. If they pick long-chat:
`c2c session set -w <ws> --mode long-chat` and use the long-chat path.
If the collection 404s or the new chat is not inside the Project, same choice.

**Saved chat 404s** (this thread): `goto` the collection, open a new Chat
there, send HANDOFF from `session.checkpoint` (no logs) as its first message,
confirm it appears, then save the new chat URL. Keep `--project-url`.

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
   `c2c session set -w <ws> --mode project --project-url <url> --connector-name "<connectorName>"`.

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

For an existing Project that performs Drive handoffs, first inspect its saved
instructions. If they still say `When you call tools, use ONLY that connector`,
replace that obsolete sentence with the scoped workspace/Drive distinction
below, preserve the other Project settings, save, and read it back. Do this for
the current workspace's Project only; changing this Skill template alone does
not update instructions already saved in ChatGPT.

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Workspace connector: {{connector_name}}

For workspace, code, git, and released execution output, use ONLY this
Codex with ChatGPT connector; never use another workspace's C2C connector.
This does not restrict the separately connected Google Drive app for files
in this Project. For a Drive handoff, use its Drive read/write actions and
verify the actual saved file. Do not infer Drive is read-only from
workspace_info or from the C2C tool list; report a blocker only if the Drive
action itself is unavailable or fails. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_output (list, then read) when a readable item
exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

For a committed branch or PR whose code is not the connected checkout's
working tree, use git_diff(mode="revision", base_ref=<exact base SHA>,
head_ref=<exact head SHA>) on this same connector. Continue pagination with
the returned baseCommit/headCommit, and use read_file(path=...,
revision=<headCommit>) for full candidate files. First confirm the commits
resolve in this repository; do not review the dirty working tree as a
substitute for the candidate branch. If a commit is absent, ask Codex to
fetch it locally; do not invent an audit from memory or a stale checkout.

`test_status` is the latest record for the whole workspace, not for the Git
revision under review. Never cite its count as tests for `headCommit` unless
its taskId and iteration match this review and the recorded command/output
belongs to the stated revision. Otherwise label it historical and report the
current test result only as Codex's claim until matching execution evidence
is available. Do not silently substitute an older passing suite.

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

Protocol states sent to ChatGPT: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
Local checkpoint states (session only, never a ChatGPT `STATE:` line):
`INIT`, `PLAN_RECEIVED`, `EXECUTING`, `EXECUTED_LOCAL`, `EXECUTED_SENT`, `DONE`, `BLOCKED`.
Do not invent `STATE: RESUME`. If the original chat is gone, send HANDOFF.
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
For every Episode-scoped `[C2C]` message in either direction, include
`EPISODE: <channel>-EP<nnn>` in the header (for example,
`EPISODE: MBC-EP001`). Keep `TASK_ID` and optional `PILOT_ID` separate:
neither identifies the Episode for the reader. Apply this to progress,
handoff, review, error, and completion messages; never infer an Episode ID
for a generic coding task.
ChatGPT's replies are expected to be substantive (see step 3). Docs: `docs/protocol.md`.

0. `c2c tunnel status -w <workspace> --json`. If `needsChoice`, follow
   **Connection choice** first (existing installs: ask once, then remember).
   Then `c2c doctor -w <workspace> --json` (auto-repairs). **Doctor gate:** if local
   is not green, do not open ChatGPT and do not send INIT. If
   `namedRepair.needed` is true, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json` (their browser; Cloudflare exception), then doctor
   again. If `chatgptRepair.needed` is true, tell the user `chatgptRepair.userMessage`
   (one paragraph, no internals), run **Workflow: reconnect after address
   reclaim**, then doctor again and only continue when the gate is green.
   Generate task id: `c2c_` + 4 random hex chars — unless a checkpoint already
   has one (reuse that id; do not mint a second task).
1. `c2c session -w <workspace> --json`. Open ChatGPT on the same iab tab
   per **Conversation management** for `conversation.mode` (foreground +
   markHandoff). long-chat: saved chat, or `https://chatgpt.com/` if none.
   project: this thread's chat URL, or the collection page for a new chat,
   or **Bind Project** if `projectReady` is false. On a NEW conversation
   confirm Chat mode (**In-app browser** §7). For an already-bound Project with
   green Doctor, send the actual INIT or HANDOFF directly; do not prepend a
   boot or workspace_info test. Confirm the message is visible before saving
   the URL. Keep first-time setup and connector-repair checks where specified.
   Do not use the browser to re-read code MCP already provides. After sending
   a control message, wait per
   **In-app browser** §8.

   **Resume from `session.checkpoint` before any INIT.** Missing checkpoint
   (legacy session): continue as a normal new/continued loop. A browser/js
   timeout is not a lost task — claim the original tab; do not INIT, re-run,
   or resend EXECUTED just because a wait timed out.
   - `EXECUTED_SENT` + `waitingFor=GPT_REVIEW`: do not INIT, do not re-run,
     do not resend EXECUTED. Stay on the saved chat and wait for review. If
     that chat 404s: HANDOFF from checkpoint fields (no logs), then wait.
   - `EXECUTED_LOCAL`: local work is done; only send EXECUTED (record first
     if this iteration has no record yet). Do not re-run.
   - `EXECUTING`: not finished. Continue the current PLAN if you still have
     it; otherwise HANDOFF and ask ChatGPT to restate the last PLAN. Do not
     treat it as done and do not INIT a new task.
   - `PLAN_RECEIVED`: execute that plan. Do not INIT.
   - `INIT` / `waitingFor=GPT_PLAN`: claim the tab and wait. Do not resend INIT.
   - `DONE`: summarize to the user if needed; `c2c session set --clear-checkpoint`.
   - `BLOCKED`: surface ChatGPT's reason; do not INIT.
   Never re-pair, never recreate the connector, and never rewrite Project
   instructions just to resume.
2. Send INIT with the user's goal (skip when the checkpoint says not to):

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Produce a C2C PLAN message.
```

   Confirm the INIT message is visibly in that ChatGPT conversation (one cheap
   DOM check). If the page is Retry-only, recover per **In-app browser** §7
   first. Do not write the waiting checkpoint, and do not wait for PLAN, until
   that message is visible.
   Then:
   `c2c session set -w <ws> --task <id> --iteration 0 --state INIT --protocol-state INIT --waiting-for GPT_PLAN --goal "<short goal>" --next-step "wait for PLAN"`
3. Wait for ChatGPT's `STATE: PLAN` reply (**In-app browser** §8 — short DOM
   checks, same tab; do not treat a 5-minute browser timeout as failure).
   Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA.
   A good PLAN also carries RATIONALE and concrete natural-language edit
   suggestions (which file, what to change, why). If the reply is a bare
   one-liner with no rationale or file-level guidance, ask once:
   "Please expand the plan with rationale and concrete per-file suggestions."
   Then:
   `c2c session set -w <ws> --protocol-state PLAN_RECEIVED --waiting-for none --next-step "execute PLAN"`
4. Execute the plan yourself with your own harness (your tools, your judgment;
   ChatGPT does not micro-manage tool calls).
   Before you start:
   `c2c session set -w <ws> --protocol-state EXECUTING --waiting-for none --next-step "finish PLAN then record"`
5. Record the execution so ChatGPT can read it via MCP. Metadata always:
   `c2c record -w <ws> --task c2c_f81a --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok`
   If this iteration ran a **test / build / lint / typecheck** command, also
   pass that command's output. Write stdout/stderr to a local temp file first,
   then:
   `c2c record … --command "pnpm test" --output-file <temp> --exit-code <n>`
   Record both success and failure. Do not record shell history, `.env`,
   keys, or unrelated dumps. Never paste that file (or any log) into ChatGPT.
   If the CLI says the output was not released, still send EXECUTED; ChatGPT
   reviews from git. Then:
   `c2c session set -w <ws> --iteration 1 --state EXECUTED --protocol-state EXECUTED_LOCAL --waiting-for none --next-step "send EXECUTED"`
6. Send EXECUTED (no diffs, no logs). Tell ChatGPT to use MCP, including
   `execution_output` when a readable item exists:

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

   For a clean branch or PR that is **not** the connected checkout's working
   tree, give GPT an exact-revision handoff instead of the generic current-diff
   request. The existing connector can read any commit present in the same
   repository; a second connector or pasted patch is unnecessary:

```
[C2C]
STATE: EXECUTED
TASK_ID: <review task>
ITERATION: <n>
REPOSITORY: <connected repository identity>
BASE_COMMIT: <full SHA>
HEAD_COMMIT: <full SHA>
REVIEW_PATHS: <changed paths or "all changed paths">
TEST_COMMAND: <exact command>
TEST_RESULT: <exit code and concise count; Codex-reported until matching evidence is read>

Review only BASE_COMMIT..HEAD_COMMIT. Use git_diff(mode="revision",
base_ref=BASE_COMMIT, head_ref=HEAD_COMMIT), continue pages using the returned
baseCommit/headCommit, and read_file(path, revision=headCommit) for full files.
Report findings with paths and lines, and distinguish code-review verdict from
release approval. Treat an unrelated test_status record as historical.
```

   Before sending, Codex must verify both SHAs resolve in the repository served
   by this connector and keep the exact local test command/output available. If
   a commit is absent, fetch it into that repository and retry; never ask GPT
   to review a dirty main checkout as a stand-in for the candidate branch.

   Then:
   `c2c session set -w <ws> --protocol-state EXECUTED_SENT --waiting-for GPT_REVIEW --next-step "wait for PLAN or DONE"`
7. ChatGPT reviews via MCP (`git_diff`, `read_file`, `test_status`,
   `execution_output`) and replies DONE / PLAN (next iteration) / BLOCKED.
8. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause and ask
   the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
9. On DONE: summarize the result to the user in plain language.
   `c2c session set -w <ws> --state DONE --clear-checkpoint`
10. On BLOCKED: read ChatGPT's reason, fix what you can, or surface the single
    decision the user must make.
    `c2c session set -w <ws> --protocol-state BLOCKED --waiting-for USER --known-issues "<short reason>"`

## Workflow: ChatGPT-generated media

The connector remains read-only. It can view supported PNG/JPEG/GIF/WebP/SVG
files with `read_image`, but it cannot write into the repository or retrieve a
browser download by itself.

When the user asks ChatGPT web to generate an image or video:

1. Generate it in the workspace's saved ChatGPT conversation using the same
   built-in browser tab and connector rules above.
2. Activate the finished asset's actual Download control through the visible
   ChatGPT UI. Browser screenshots are navigation evidence only; never save,
   crop, rename, or import a screenshot as the requested asset.
3. Import the original download through the local execution harness:
   `c2c asset import -w <ws> --from <downloaded-file> --to <new-workspace-relative-path> --json`.
4. The destination must be new and project-relative. The importer validates
   PNG/JPEG/GIF/WebP/SVG/MP4/MOV/WebM content, rejects active SVG and path
   escapes, and never overwrites an existing file. Include the imported path in
   EXECUTED/review.

## Workflow: disconnect（"断开 ChatGPT"）

1. `c2c unpair -w <workspace>` (revokes all tokens immediately).
2. Optionally remove the connector on the same iab tab via
   `https://chatgpt.com/plugins` (foreground + markHandoff). Only touch
   this workspace's `connectorName`.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: reconnect after address reclaim（全关掉以后地址失效）

This is the normal case when the user quit Codex / the terminal / the machine:
the previous public address is gone. Doctor already started a new one.
`connectorAction: "update"` means Delete + create again — not Reconnect.

`c2c doctor --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pages": { ... } } }`

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
     Edit** on the old card — the old Server URL is dead and the page will
     hang on "This site cannot be reached".
   - Then `goto` the 加插件 URL and create that **same** `connectorName`
     (do not invent a second name):
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: `chatgptRepair.mcpUrl`
      - Authentication: OAuth
     Then Connect / Authorize. Only then run `c2c pair --json` and type that
     code. Continue as soon as it is Connected — do not wait for 8 tools on
     the settings page.
   - If the name is already gone, skip Delete and only create.
4. `c2c doctor --json` again. Same tab: only after the Doctor gate is green,
   reopen the chat this Codex thread was already using (`session.url` /
   the URL you saved earlier in THIS thread). Do not rewrite Project
   instructions — they store the connector **name**, which did not change.
   In that same chat, send the workspace_info check from setup step 6
   (exact `connectorName`). Doctor green is not enough: the old conversation
   may still be bound to the deleted connector.
   - If the reply names this workspace: continue there. Save the URL if needed.
   - If workspace_info fails, times out, or cannot read the name: do **not**
     keep retrying that old URL. project → collection page, new chat in this
     Project, boot + HANDOFF from `session.checkpoint` (no logs) +
     workspace_info, then `c2c session set --url` only after the name matches.
     long-chat → Conversation management switch, same checks. Keep the old
     saved URL until the new chat passes.
5. If the ChatGPT conversation was lost: same as the failure path in step 4.
   No file re-uploading (the workspace lives in MCP). If tools point at
   the wrong connector, open 项目设置 and confirm 指令 still names
   `connectorName` (never paste the new public address).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json`. Doctor gate: do not open ChatGPT / send
   `[C2C]` until local is green, except reconnect settings pages.
2. If `namedRepair.needed`, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json`, then doctor again. Do not Delete the connector.
3. If `chatgptRepair.needed`, follow **reconnect after address reclaim**, then
   doctor again.
4. Otherwise apply the recovery map. Only involve the user for login / 2FA /
   CAPTCHA — one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable / 全关掉后连接失效 | `c2c doctor` → if `namedRepair.needed`, login to Cloudflare and doctor again (do not Delete). If `chatgptRepair.needed`, tell the user the message, then **Delete** THIS workspace's connector only (`connectorName`) and create it again. Never Reconnect. After recreate, re-check `workspace_info` in the saved chat; if it still fails, new chat in the same Project (or long-chat switch) + HANDOFF. |
| Collection page shows only Retry | Retry once, then use §2 to reopen the saved chat URL in one new built-in-browser tab; from a loaded chat, use its Project link if needed. Do not write INIT/EXECUTED waiting checkpoints until the message is visible. |
| Saved chat shows `cloudflare_challenge`, `Unknown error`, or persistent Retry-only page | Save its exact URL and Drive/checkpoint location; Retry once, then open the same URL in one new built-in-browser tab. Inspect before resending. Only if that fails, create a new Chat conversation in the same Project and resume from durable files. Ask the user only for a real interactive login/2FA/CAPTCHA form. |
| ChatGPT says tool call failed / 401 | token expired or revoked → re-pair (new pairing code + authorize) |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Same explicit ChatGPT setup/reconnect browser configuration step fails twice after repair | Stop automating ChatGPT settings and use **Guided manual ChatGPT setup fallback**. Do not count browser/js timeout, loading/generating, or login/2FA waiting as failures. |
| Port conflict | handled automatically; never surface to the user |
| Every new chat “repairs” / cannot write the log or settings directory | `c2c sandbox-allow --json` (once). Do not ask the user. |
| cloudflared missing | install it yourself (brew/winget), then retry |
| Sidebar has no「项目」 | Ask the user to hover「聊天」, click the …, choose「按项目整理」 |
| Collection page is the wrong Project | Ask the user to open the named collection and say「已找到」, or accept long-chat |
