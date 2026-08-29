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
5. ALWAYS use the built-in browser for every browser step (ChatGPT, authorization
   page, verification). NEVER launch or control a third-party/external browser
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
8. ChatGPT settings: only these URLs, for first-time setup AND later repair.
   Never start from chatgpt.com and click through menus.
   - 开发人员模式: https://chatgpt.com/#settings/Security
   - 插件总管: https://chatgpt.com/plugins
   - 加插件: https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

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

Before setup, determine the requested transport. ChatGPT Plus users without a
custom connector use the GitHub workflow below. Run this MCP setup workflow only
when the user explicitly chooses MCP/custom connectors.

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
4. Open ChatGPT in the BUILT-IN browser. NEVER start from chatgpt.com and click
   around. For setup AND later repairs, only these URLs:
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
     Enable 开发人员模式 ("Developer mode") if it is off.
   - 插件总管（管理已有连接）: `https://chatgpt.com/plugins`
   - 加插件 / 连接器: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
     Operate ONLY on `connectorName` from step 3:
      - If that exact name exists: edit its Server URL (do not create another).
      - If it does not exist: create one with that exact name.
      - Never rename, delete, or edit a connector that belongs to another workspace.
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: the `mcpUrl` from step 3
      - Authentication: OAuth
     Then Connect / Authorize, type the pairing code, wait for the 8 read-only tools.
5. Verify: open a new ChatGPT chat, send:
   `Use the "<connectorName>" connector: call workspace_info and read hello-style top-level file. Reply with the workspace name.`
   Confirm the reply matches `workspaceName`.
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

## Workflow: ChatGPT Plus task via GitHub

<!-- PLUS FLOW START -->

Use this path when the user says they have ChatGPT Plus, cannot create a custom
connector, or explicitly selects GitHub. Do not run `c2c setup` for this path.

1. Verify the workspace is a Git repository with a user-approved GitHub remote
   and a clean working tree. Never publish on main/master.
2. Start without changing project defaults:
   `c2c task start "<user goal>" --transport github -w <workspace> --json`.
3. Open or reuse the user's ChatGPT conversation in the built-in browser. Send
   only the returned instruction. ChatGPT reads `.c2c/current.md` and relevant
   files from the dedicated branch, then returns structured PLAN text.
4. Save the reply locally and run
   `c2c task import -w <workspace> --file <plan file> --json`.
5. Execute the validated PLAN with Codex tools. Run its tests. Publish only
   explicit changed files with `c2c task publish -w <workspace>
   --changed-files "file1,file2" --tests "<summary>" --test-command "<command>"
   --review-focus "<focus>" --json`.
6. Send the returned REVIEW instruction to the same ChatGPT conversation.
   Import PLAN, DONE, or BLOCKED with `c2c task import`.
7. DONE remains pending. Run fresh final tests; only after they pass run
   `c2c task publish -w <workspace> --finalize passed --tests "<summary>"
   --test-command "<command>" --json`.
8. On BLOCKED, preserve its reason. Use `c2c task resume` only after the cause
   is fixed. Never edit `.c2c/current.md` as machine state.

<!-- PLUS FLOW END -->

This flow uses no custom connector, ChatGPT private API, API key, cookie, or
browser storage. FilePack is future V0.3 work and has no V0.2 command.

## Conversation management (one chat per workspace)

The workspace has ONE long-lived C2C conversation in ChatGPT. Do not open a new
chat per task or per Codex session.

- **Find it**: `c2c session -w <ws> --json` → `{ session: { url, taskId, ... } }`.
  If a session exists, navigate the built-in browser to that URL and continue there.
- **Save it**: right after creating a new C2C chat (boot prompt sent), read the
  conversation URL from the built-in browser address bar (visible UI state only)
  and run `c2c session set -w <ws> --url <url> --title "C2C <workspace name>"`.
- **Update it**: after each EXECUTED/DONE, run
  `c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>`.
- **Switch it** ONLY when (a) the user explicitly asks for a new chat, or
  (b) the current chat has become so long it visibly lags. When switching:
  1. Create the new chat and send the boot prompt.
  2. Immediately send a HANDOFF message (template in `docs/protocol.md`) —
     a short brief of: original goal, iterations so far, what is already DONE,
     current state, known issues, and the next expected step. The new chat must
     be able to continue the task without re-asking anything; it re-reads code
     via MCP, so never paste files into the handoff.
  3. `c2c session set` with the new URL (this overwrites the old one).
- If the saved chat 404s or was deleted, treat it as a switch: new chat + boot
  prompt + HANDOFF reconstructed from `c2c session get` and recent
  `execution_summary` records.

## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX"）

Protocol states: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
ChatGPT's replies are expected to be substantive (see step 3). Docs: `docs/protocol.md`.

0. Ensure the bridge is healthy: `c2c doctor -w <workspace> --json` (auto-repairs).
   If `chatgptRepair.needed` is true, tell the user `chatgptRepair.userMessage`
   (one paragraph, no internals), then run **Workflow: reconnect after address
   reclaim** below before continuing. Generate task id: `c2c_` + 8 random hex chars.
1. Open the saved C2C conversation (`c2c session --json`); only create a new chat
   if none is saved. On a NEW conversation first send the boot prompt from
   `docs/protocol.md` §Boot Prompt, then save the session URL.
2. Send INIT with the user's goal:

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a9c2d
ITERATION: 0

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Produce a C2C PLAN message.
```

3. Wait for ChatGPT's `STATE: PLAN` reply. Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA.
   A good PLAN also carries RATIONALE and concrete natural-language edit
   suggestions (which file, what to change, why). If the reply is a bare
   one-liner with no rationale or file-level guidance, ask once:
   "Please expand the plan with rationale and concrete per-file suggestions."
4. Execute the plan yourself with your own harness (your tools, your judgment;
   ChatGPT does not micro-manage tool calls).
5. Record the execution so ChatGPT can read it via MCP:
   `c2c record -w <ws> --task c2c_f81a9c2d --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok`
6. Send EXECUTED (no diffs, no logs):

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a9c2d
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
2. Optionally remove the connector in ChatGPT settings via Computer Use.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: reconnect after address reclaim（全关掉以后地址失效）

This is the normal case when the user quit Codex / the terminal / the machine:
the previous public address is gone. Doctor already started a new one.

`c2c doctor --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pairingCode": "...", "pages": { ... } } }`

1. Tell the user exactly `chatgptRepair.userMessage`. Then you repair. Do not
   ask them to click around ChatGPT unless a login wall appears.
2. Built-in browser only. Same URLs as first-time setup — never hunt menus:
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
   - 插件总管（改已有连接用这个）: `https://chatgpt.com/plugins`
   - 加插件（当前项目还没有自己的连接才用）: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
3. Prefer the plugins hub. Operate ONLY on `chatgptRepair.connectorName`:
   if it exists, edit its Server URL to `chatgptRepair.mcpUrl`; if it is gone,
   create that exact name. Never touch another workspace's connector.
   Then Connect / Authorize and type `chatgptRepair.pairingCode`
   (or `c2c pair --json` if it expired).
4. Resume the original ChatGPT conversation (`c2c session`). Do not start a new
   audit/task chat just because the address changed.
5. If the ChatGPT conversation was lost, follow Conversation management → Switch:
   new chat, boot prompt, HANDOFF. No file re-uploading (the workspace lives in MCP).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json`.
2. If `chatgptRepair.needed`, follow **reconnect after address reclaim**.
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
