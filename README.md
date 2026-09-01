# Codex with ChatGPT
**version:** v0.2.0

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
Codex 只负责执行。不用 API Key、不搞逆向代理——官方网页 + 只读 MCP 桥接。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the subscription you already pay for; Codex only executes.
No API keys, no reverse proxy — official web UI plus a read-only MCP bridge.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，执行权
完全保留在 Codex 手里。你的仓库永远不会被上传：ChatGPT 通过一条安全的、
OAuth 保护的**只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

**EN** — Use the ChatGPT web app as the planning and review brain for your
Codex coding sessions, while Codex keeps full ownership of execution. Your
repository is never uploaded: ChatGPT reads exactly the lines it needs through
a secure, OAuth-protected, **read-only** MCP connection to your current
workspace.

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
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行。
  （首次连接时在内置浏览器中输入一次配对码；同一 workspace 后续任务复用已有 connector，不会重复输入）。
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
5. First-time setup: follow the SKILL.md "first-time setup" workflow.
   Enter the pairing code once in the BUILT-IN browser; later tasks in the same
   workspace reuse the existing connector and do not ask for the code again.
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

The only step that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once).

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

Deleting and recreating the connector changes its ChatGPT app identity, so the
saved conversation must also be replaced. After repair, open a fresh ChatGPT
conversation, add the current connector with `@`, send the Boot Prompt, verify
`workspace_info`, then commit the new binding:

```sh
c2c connector commit -w <workspace> \
  --generation <generation> --fingerprint <fingerprint> --url <conversation-url> \
  --lock-token <token> --json
```

Run that command only after `workspace_info` succeeds. It writes the verified
conversation metadata and the connector binding as one transition; do not call
`session set` before the commit. A saved session is reusable only when its
generation and fingerprint exactly match the current `connectorBound` state.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or login fails, Codex stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## OMPで使う場合

このワークスペースでは、upstream の Codex Skill ではなく [`skill/omp/SKILL.md`](skill/omp/SKILL.md) を使います。OMP 用ラッパーは次です。

```sh
./scripts/omp-c2c.sh status -w /Users/arica/Data/OMP --json
./scripts/omp-c2c.sh tunnel status -w /Users/arica/Data/OMP --json
./scripts/omp-c2c.sh doctor -w /Users/arica/Data/OMP --no-fix --json
```

状態変更やChatGPTのブラウザ操作を始める前に、workspaceのセッション排他を取得します。
返されたtokenを作業中だけ保持し、変更系コマンドへ`--lock-token <token>`を渡します。
完了時は`session lock release`を実行します。

```sh
./scripts/omp-c2c.sh session lock acquire \
  -w /Users/arica/Data/OMP --task <task_id> --json
```

初回接続または明示的な復旧だけ、次を実行します。

```sh
./scripts/omp-c2c.sh setup -w /Users/arica/Data/OMP --json --lock-token <token>
```

`setup`は既存の有効な配対を確認する通常ヘルスチェックではありません。
出力に`pairingCode`が含まれていても、Connectorを作成する前に保存・入力しません。
先に`doctor --no-fix --json`で診断し、ChatGPT側でConnectorを作成または再作成した直後、OAuth認可画面を開く直前に同じlock tokenで`doctor --json`（修復あり）を一度だけ実行します。
返された`chatgptRepair.pairingCode`と`pairingExpiresAt`を直ちにOAuth popupへ入力してください。
配対が進行中なら新しいコードを発行せず、通常タスクでは`setup`も`pair`も呼びません。
Pairing codeは30分で期限切れになり、一回限りです。
期限切れや明示的な再認可だけ、現在のロック token で`pair`を実行します。

OMPではQuick Tunnelを既定とし、固定ドメインはユーザーが明示的に選んだ場合だけ設定します。
固定ドメインを使う場合は、セッション排他を保持したまま`tunnel login -w /Users/arica/Data/OMP --lock-token <token>`を実行し、
続けて`tunnel choose --mode named --zone <domain> --lock-token <token>`で設定します。

ChatGPT Webへ接続するときは`--no-tunnel`を使いません。
通常タスクでは、まず`status`、`session get`、`tunnel status`、`doctor --no-fix --json`を読み取り、
`session get`の`usable: true`と、doctorの`status: "ok"`を確認して既存のconnector、OAuthトークン、会話を再利用します。
doctorのJSONは`status: "pending"`を修復待ち、`status: "blocked"`を障害として示します。
`--no-fix`の`exitCode`が0でも、`status`や`chatgptRepair.needed`を無視してChatGPTへ送信してはいけません。

Quick TunnelのURLが変わった場合は、doctor JSONに出た同じ名前のConnectorだけを削除して再作成します。
新しいConnectorで`workspace_info`が成功した後、`connector commit --generation <generation> --fingerprint <fingerprint> --url <conversation-url> --lock-token <token>`を実行します。
この順序で、会話URLを先に保存し、検証済みのconnector bindingを同じ処理で確定します。
commit前の`session set`は禁止です。commit後に保存済み会話の`usable`がtrueであることを確認してからC2C制御メッセージを送信します。
Connector再作成でアプリの識別子が変わるため、保存済み会話は使わず、新しいChatGPT会話で`@`から現行connectorを選びます。
固定ドメインのnamed tunnelが停止した場合は、Cloudflareへ再ログインして復旧し、Connectorは削除しません。

旧endpoint stateは読み取り時にversion 2へ正規化され、connector bindingなしの`legacy_state`保留として扱われます。
旧保存会話やbindingなしの会話は再利用せず、現行Connectorで`workspace_info`を確認してから`connector commit`で移行します。
OAuthのDCRはclient名と重複除去・ソート済みredirect URIからfingerprintを作り、同じfingerprintの再登録を同じclientへ収束させます。
既存stateに重複clientがあれば、token数、作成時刻、client IDの順でcanonical clientを選び、重複clientとそのtokenを退役させます。

ユーザーがプロジェクト単位の分離を明示した場合だけ、そのサブディレクトリを`-w`に指定します。
配対コード（`XXXX-XXXX`）はChatGPTのログインコードではなく、connector初回認可用の一回限りの確認コードです。


---

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  read-only MCP      │   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│    Codex Harness    │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs itself through 8 read-only
  tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary`.
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.

## Security model (short version)

- **Read-only by construction**: write/delete/shell/commit tools simply do not
  exist on the server. No prompt injection can enable them.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested). In the OMP integration, `/Users/arica/Data/OMP`
  is the default workspace; a child project is used only for explicit isolation.
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (30-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest: path security, OAuth, pairing, MCP e2e

c2c session lock acquire -w <workspace> --task <task-id> --json
c2c doctor -w <workspace> --no-fix --json
c2c setup --workspace <workspace> --lock-token <token>  # first setup/recovery only
c2c connector commit -w <workspace> --generation <n> \
  --fingerprint <fingerprint> --url <conversation-url> \
  --lock-token <token> --json
c2c session get -w <workspace> --json  # require usable: true
c2c session lock release -w <workspace> --token <token> --json
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you).

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        8 read-only tools, stateless Streamable HTTP
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  session/    workspace session lease and bridge-start lock
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
