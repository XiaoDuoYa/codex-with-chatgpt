# Codex with ChatGPT

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

> [!IMPORTANT]
> **遇到问题？** 请先向 Codex 发送 **「更新 Codex with ChatGPT」** 并重试。更新到最新版本可以解决大多数已知问题。  
> **Having trouble?** First ask Codex to **“Update Codex with ChatGPT”** and try again. Updating to the latest version resolves most known issues.

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
Codex 只负责执行。不用 API Key、不搞逆向代理——官方网页 + 工作区只读 MCP
桥接 + 本地结构化结果回传。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the subscription you already pay for; Codex only executes.
No API keys, no reverse proxy — official web UI plus workspace-read-only MCP
access and a bounded local result mailbox.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，执行权
完全保留在 Codex 手里。你的仓库永远不会被上传：ChatGPT 通过一条安全的、
OAuth 保护的连接按需读取代码，并且只能向 C2C 本地状态提交一次性、结构化的
建议结果，不能修改工作区。

**EN** — Use the ChatGPT web app as the planning and review brain for your
Codex coding sessions, while Codex keeps full ownership of execution. Your
repository is never uploaded: ChatGPT reads exactly the lines it needs through
a secure, OAuth-protected connection. Its only write capabilities are bounded
progress and one-shot advisory results stored in C2C local state, never in your
workspace.

ChatGPT can also own code discovery and current-web research, including waits;
formal research returns separately with conclusions, source links, publication
dates, key evidence, and open questions before implementation planning.
Codex remains responsible for applying edits and verifying them locally. C2C
does not switch the active Codex model; model selection stays with the user or
host runtime.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## One-paste install · 一段话安装

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/XiaoDuoYa/codex-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/XiaoDuoYa/codex-with-chatgpt into
   ~/codex-with-chatgpt (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: copy skill/SKILL.md to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md, and update the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```


**Updates · 更新** — The Skill checks GitHub once a day and updates itself when a
new version is released; no action needed. You can also say "更新 Codex with ChatGPT"
anytime. / Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Setup → Use (manual)

1. Install the Codex Skill: copy `skill/` to `~/.codex/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."** (中文: "使用 Codex with ChatGPT 完成首次配置。")
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only steps that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once). A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. Codex
then saves that collection link and starts chats from that page. Existing
workspaces can stay outside Projects until you ask to switch; each local Codex
session still keeps its own ChatGPT chat URL.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or the login fails, Codex stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
        MCP data reads  │          │ Browser control plane
 + progress/result send │          │ RESEARCH / INIT / EXECUTED (<1 KB)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │ MCP + result mailbox│   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────┬────────┬─────┘
          read-only │        │ bounded result to C2C state
                   ▼        ▼
       ┌────────────────┐  ┌─────────────────────┐
       │Local Workspace │  │Local Control Mailbox│
       └───────▲────────┘  └──────────▲──────────┘
               │ edit/git/tests       │ local read/ack
               └──────────┬───────────┘
                    ┌─────┴───────┐
                    │Codex Harness│
                    └─────────────┘
```

- **Outbound control plane (browser UI)**: Codex sends tiny `[C2C]` RESEARCH,
  INIT, and EXECUTED messages. The full state loop is
  `[RESEARCH] → INIT → PLAN → EXECUTED → REVIEW → DONE`; no diffs, logs, or file bodies are
  ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs itself through 9 read-only
  tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary`,
  `execution_output`.
- **Return plane (local mailbox)**: `report_control_progress` exposes bounded
  forward-only progress, and `submit_control_result` accepts only a schema-bound
  RESEARCH/PLAN/REVIEW/DONE/BLOCKED payload for an active one-shot request.
  Each request is one question/answer turn; Codex reads and acknowledges it
  locally with the exact local-session/task/iteration/phase tuple, without
  parsing page text.
- **Parallel sessions**: one ChatGPT Project belongs to the workspace; each
  local Codex session gets its own ChatGPT chat, checkpoint, and result request.
  C2C returns the exact saved URL as a routing gate, so switching the visible
  page cannot redirect a task into another session's chat.
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and only the execution records matching the current local session,
  task, and iteration through MCP. It never trusts "all tests passed" claims
  blindly.

Result delivery defaults to mailbox-first with a browser fallback. Set it per
workspace in `.c2c.json` when you need a strict mode:

```json
{ "resultTransport": "auto" }
```

Supported values are `auto` (default), `mailbox`, and `browser` (legacy).

## Security model (short version)

- **Workspace-read-only by construction**: write/delete/shell/commit tools do
  not exist. The two bounded write tools store progress or schema-bound advice
  in C2C state, cannot select a workspace write target, and require a scoped,
  expiring one-shot request.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest: path security, OAuth, pairing, mailbox, MCP e2e

c2c setup           # bridge + tunnel + pairing code, all in one
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you).

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        9 read-only data tools + bounded progress/result submit, stateless HTTP
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  control/    research/result/progress schemas and local mailbox lifecycle
  session/    workspace Project binding + per-local-session chat/checkpoint
  process/    daemon lifecycle
  cli/        the c2c CLI
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
```

## Status & disclaimer

V1. Verified end-to-end: bridge, OAuth + pairing, public tunnel, ChatGPT
connector setup, zero-touch first-run experience.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE)
