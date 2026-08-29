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
whatever data it needs by itself.

**Golden rules**

1. NEVER paste file contents, diffs, or logs into ChatGPT. ChatGPT reads them through MCP.
2. NEVER show the user technical internals (MCP, OAuth, PKCE, tunnel, ports, localhost).
   Speak in terms of "连接 ChatGPT / 安全连接 / 配对".
3. The pairing code is the ONLY credential you may ever type into a browser.
   Never touch OAuth tokens, cookies, or session storage.
4. If something fails, run `c2c doctor` and repair silently. Only involve the user
   for logins, CAPTCHA, 2FA, or explicit consent screens — and then give them ONE action.
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
6. Reuse ONE ChatGPT conversation per workspace (see Conversation management).
   Never silently start a new chat. Each workspace also has exactly ONE ChatGPT
   connector. Do not create a second connector for the same workspace. Other
   workspaces may have their own connectors — never edit those.
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
   A ChatGPT-side 401 after a sent message is different: repair then, do not
   treat it as permission to skip this gate next time.

## In-app browser (ChatGPT)

Official skill: `control-in-app-browser`. These C2C rules override defaults
that close the tab, hide the window, or stall on the settings page.

1. **Surface.** Once per Codex session: `setupBrowserRuntime()`, then
   `const iab = await agent.browsers.get("iab")`. Reuse `iab`. Do not re-read
   `documentation()` if it is already bound. Never `getDefault()`, `getForUrl()`,
   or Computer Use.

2. **One tab.** Create the ChatGPT tab once (`tabs.new()`). After that, only
   `tab.goto(...)` to switch URLs. If the tab still exists, claim it — never
   open a second ChatGPT tab. Do not `goto` the URL you are already on.

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
   - 插件总管: `https://chatgpt.com/plugins`
   - 加插件: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - 新对话 (only if no saved session): `https://chatgpt.com/`
   - Saved C2C chat: the URL from `c2c session`

5. **Do not wait for 8 tools** on the settings page. "Connected" / authorize
   success / pairing accepted is enough. Confirm tools in the conversation with
   `workspace_info`.

6. **Batch.** Fill a known form in one Playwright / `js` script when you can.
   After an action, one cheap DOM check. Do not screenshot-poll.

7. **One conversation.** The first ChatGPT chat is the C2C conversation. Send
   the boot prompt and the workspace_info check there. Save that URL. Do not
   open a throwaway verify chat and later another C2C chat.

8. **Wait for a ChatGPT reply (do not hold one long browser wait).** After you
   send INIT, EXECUTED, boot, or the workspace_info check: `markHandoff`, keep
   the tab foreground, and stay in this same task. Do not `waitFor` 5 minutes
   and do not screenshot-poll. Every 20–30 seconds, one cheap DOM check:
   - still generating → wait again (do not type, do not resend);
   - `STATE: PLAN` / `DONE` / `BLOCKED` / the verify workspace name → read it
     and continue the existing protocol;
   - visible error → repair; do not start a new chat.
   A browser/js timeout is not failure. Claim the same tab, read the page, keep
   standby. If ChatGPT is still thinking, keep polling. Never open a second
   tab and never resend INIT/EXECUTED just because a wait timed out.

## Locations

- The codex-with-chatgpt checkout lives at: `/Users/xiaoduo_/Codex_With_ChatGPT`
- CLI: run `node /Users/xiaoduo_/Codex_With_ChatGPT/bin/c2c.js <command>`
  (or `c2c <command>` if globally linked). All commands support `--json` for parsing.
- If the checkout has no `node_modules` or no `dist/`, first run
  `corepack pnpm install && corepack pnpm build` inside it.
- Always pass `-w <workspace root>` (the project the user is working on, NOT the c2c repo).

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

## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置"）

1. Detect prerequisites yourself: `node --version` (>= 20), and check `cloudflared`.
   - If cloudflared is missing on macOS run `brew install cloudflared`; on Windows use
     `winget install Cloudflare.cloudflared`. Do this yourself; don't ask.
2. If the c2c repo has no `node_modules`, run `pnpm install && pnpm build` in it.
3. Run: `c2c sandbox-allow --json` then `c2c setup -w <workspace> --json`.
   `sandbox-allow` edits Codex `config.toml` only — it adds C2C's state directory
   to `[sandbox_workspace_write].writable_roots` so later chats can write logs
   without elevation. If the write is denied, request approval and retry once.
   → returns `{ mcpUrl, pairingCode, workspaceName, connectorName, ... }`.
   `connectorName` is this workspace's plugin title (legacy installs stay
   `Codex with ChatGPT`; additional workspaces get `Codex with ChatGPT · <name>`).
   Pairing codes expire in ~5 minutes: run `c2c pair --json` for a fresh one if you're slow.
4. Open ChatGPT on the ONE iab tab (see **In-app browser**). Foreground +
   markHandoff immediately. Same tab, `goto` only:
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
     Enable 开发人员模式 ("Developer mode") if it is off.
   - 已有该 `connectorName`: `https://chatgpt.com/plugins` and edit its Server URL.
   - 还没有: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
     Operate ONLY on `connectorName` from step 3:
      - If that exact name exists: edit its Server URL (do not create another).
      - If it does not exist: create one with that exact name.
      - Never rename, delete, or edit a connector that belongs to another workspace.
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: the `mcpUrl` from step 3
      - Authentication: OAuth
     Fill the known form in one script when you can. Then Connect / Authorize
     and type the pairing code. As soon as it shows Connected / authorized /
     pairing accepted, continue — do NOT wait for 8 tools on this page.
5. Same tab: `goto` `https://chatgpt.com/` (this IS the C2C conversation, not a
   throwaway). Send the boot prompt from `docs/protocol.md` §Boot Prompt, then
   (same chat) send:
   `Use the "<connectorName>" connector: call workspace_info and read hello-style top-level file. Reply with the workspace name.`
   Confirm the reply matches `workspaceName` (wait per **In-app browser** §8).
   Save the chat URL with `c2c session set` (see Conversation management).
   markDeliverable.
6. Report to the user exactly in this shape (no internals):

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

## Conversation management (one chat per workspace)

The workspace has ONE long-lived C2C conversation in ChatGPT. Do not open a new
chat per task or per Codex session.

- **Find it**: `c2c session -w <ws> --json` → `{ session: { url, taskId, ... } }`.
  If a session exists, `goto` that URL on the same iab tab (foreground +
  markHandoff) and continue there.
- **Save it**: right after creating a new C2C chat (boot prompt sent), read the
  conversation URL from the iab address bar (visible UI state only)
  and run `c2c session set -w <ws> --url <url> --title "C2C <workspace name>"`.
- **Update it**: after each EXECUTED/DONE, run
  `c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>`.
- **Switch it** ONLY when (a) the user explicitly asks for a new chat, or
  (b) the current chat has become so long it visibly lags. When switching:
  1. Same iab tab: `goto` `https://chatgpt.com/`, send the boot prompt.
  2. Immediately send a HANDOFF message (template in `docs/protocol.md`) —
     a short brief of: original goal, iterations so far, what is already DONE,
     current state, known issues, and the next expected step. The new chat must
     be able to continue the task without re-asking anything; it re-reads code
     via MCP, so never paste files into the handoff.
  3. `c2c session set` with the new URL (this overwrites the old one).
- If the saved chat 404s or was deleted, treat it as a switch: new chat + boot
  prompt + HANDOFF reconstructed from `c2c session get` and recent
  `execution_summary` records.

## Execution Modes

- **Web-Control Relay Mode (Zero-Copy Autonomous Loop, Recommended)**:
  When the local execution relay is enabled (`c2c relay enable`), ChatGPT Web directly submits PLANs to the local configured executor (`agy` default, or `codex`) via the `execution_submit` MCP tool, monitors progress via `execution_status`, and reviews results via `git_diff` / `test_status` without manual copy-paste or browser relay.
- **Local Orchestrator Mode (In-App Browser Relay)**:
  If the execution relay is disabled, Codex coordinates through the in-app browser using the step-by-step protocol below.

## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX"）

Protocol states: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
ChatGPT's replies are expected to be substantive (see step 3). Docs: `docs/protocol.md`.

0. `c2c doctor -w <workspace> --json` (auto-repairs). **Doctor gate:** if local
   is not green, do not open ChatGPT and do not send INIT. If
   `chatgptRepair.needed` is true, tell the user `chatgptRepair.userMessage`
   (one paragraph, no internals), run **Workflow: reconnect after address
   reclaim**, then doctor again and only continue when the gate is green.
   Generate task id: `c2c_` + 4 random hex chars.
1. Open the saved C2C conversation on the same iab tab (`c2c session --json`);
   only `goto` `https://chatgpt.com/` if none is saved. Foreground + markHandoff.
   On a NEW conversation first send the boot prompt from
   `docs/protocol.md` §Boot Prompt, then save the session URL. Do not use the
   browser to re-read code MCP already provides. After sending a control
   message, wait per **In-app browser** §8.
2. Send INIT with the user's goal:

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

3. Wait for ChatGPT's `STATE: PLAN` reply (**In-app browser** §8 — short DOM
   checks, same tab; do not treat a 5-minute browser timeout as failure).
   Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA.
   A good PLAN also carries RATIONALE and concrete natural-language edit
   suggestions (which file, what to change, why). If the reply is a bare
   one-liner with no rationale or file-level guidance, ask once:
   "Please expand the plan with rationale and concrete per-file suggestions."
4. Execute the plan automatically via the configured executor (`agy` by default; switch via `c2c executor set codex`):
   - Secure Plan File Transport (avoids shell escaping/argv limits):
     1. Write the PLAN text verbatim to a temporary file inside the C2C state directory:
        `<C2C state dir>/plans/<task_id>-<iteration>.md` (e.g., owner-only permissions).
     2. Run `c2c exec -w <ws> --plan-file <temp_plan_path> --task <task_id> --iteration <iter>`.
     3. Clean up the temporary plan file in `finally`.
   - `c2c exec` invokes the selected executor (`agy` or `codex`) via streaming stdin, runs tests, and automatically records execution metadata with authoritative Git-based changed-file delta tracking.
5. Verification & Record:
   - `c2c exec` automatically writes the execution record to the local bridge.
   - If execution succeeded (`exitStatus: ok`), proceed to Step 6.
   - If execution was blocked (`exitStatus: blocked`) or failed, handle recovery or surface the decision.
6. Send EXECUTED (no diffs, no logs):

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
```

7. ChatGPT reviews via MCP (git_diff, read_file, test_status) and replies
   DONE / PLAN (next iteration) / BLOCKED.
8. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause and ask
   the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
9. On DONE: summarize the result to the user in plain language.
10. On BLOCKED: read ChatGPT's reason, fix what you can, or surface the single
    decision the user must make.

## Workflow: disconnect（"断开 ChatGPT"）

1. `c2c unpair -w <workspace>` (revokes all tokens immediately).
2. Optionally remove the connector on the same iab tab via
   `https://chatgpt.com/plugins` (foreground + markHandoff). Only touch
   this workspace's `connectorName`.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: reconnect after address reclaim（全关掉以后地址失效）

This is the normal case when the user quit Codex / the terminal / the machine:
the previous public address is gone. Doctor already started a new one.

`c2c doctor --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pairingCode": "...", "pages": { ... } } }`

1. Tell the user exactly `chatgptRepair.userMessage`. Then you repair. Do not
   ask them to click around ChatGPT unless a login wall appears. Do not open
   the C2C chat and do not send `[C2C]` until this repair finishes and a
   follow-up doctor is green.
2. Same one iab tab as setup (foreground + markHandoff). Settings URLs only
   until Connected — never hunt menus:
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
   - 插件总管（改已有连接用这个）: `https://chatgpt.com/plugins`
   - 加插件（当前项目还没有自己的连接才用）: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
3. Prefer the plugins hub. Operate ONLY on `chatgptRepair.connectorName`:
   if it exists, edit its Server URL to `chatgptRepair.mcpUrl`; if it is gone,
   create that exact name. Never touch another workspace's connector.
   Then Connect / Authorize and type `chatgptRepair.pairingCode`
   (or `c2c pair --json` if it expired). Continue as soon as it is Connected —
   do not wait for 8 tools on the settings page.
4. `c2c doctor --json` again. Same tab: `goto` the saved conversation
   (`c2c session`) only after the Doctor gate is green. Do not start a new
   audit/task chat just because the address changed.
5. If the ChatGPT conversation was lost, follow Conversation management → Switch:
   new chat, boot prompt, HANDOFF. No file re-uploading (the workspace lives in MCP).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json`. Doctor gate: do not open ChatGPT / send
   `[C2C]` until local is green, except reconnect settings pages.
2. If `chatgptRepair.needed`, follow **reconnect after address reclaim**, then
   doctor again.
3. Otherwise apply the recovery map. Only involve the user for login / 2FA /
   CAPTCHA — one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable / 全关掉后连接失效 | `c2c doctor` → if `chatgptRepair.needed`, tell the user the message, then update THIS workspace's connector only (`connectorName`). |
| ChatGPT says tool call failed / 401 | token expired or revoked → re-pair (new pairing code + authorize) |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Port conflict | handled automatically; never surface to the user |
| Every new chat “repairs” / cannot write the log or settings directory | `c2c sandbox-allow --json` (once). Do not ask the user. |
| cloudflared missing | install it yourself (brew/winget), then retry |
