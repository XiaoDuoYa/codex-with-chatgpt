# Codex with ChatGPT

<p align="center">
  <strong>English</strong> | <a href="README.ja.md">日本語</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
</p>

> **ChatGPT thinks. Codex works.**  
> Use ChatGPT as the planning brain while keeping the Codex harness.

---

## The Problem

ChatGPT Plus/Pro web quota often sits idle while your coding agent (Codex) burns scarce API tokens on high-level planning and code reviews. 

This project offloads the "thinking" to the web ChatGPT subscription you already pay for, while Codex handles all local execution (editing files, running tests, fixing errors). 

No API keys needed, no reverse proxies — just the official ChatGPT web interface connected to a secure, read-only MCP bridge.

## What It Is

**Codex with ChatGPT** connects the ChatGPT web app as the planning and review "brain" for your local coding sessions, while keeping full execution ownership in Codex.

Your repository is never bulk-uploaded: ChatGPT reads only the specific lines or files it needs through a secure, OAuth 2.1-protected, **read-only** Model Context Protocol (MCP) bridge to your workspace.

## Quick Install (One-Prompt Automation)

Don't know git, Node, or terminals? You don't need to. Copy the prompt below, paste it directly to your coding agent (Codex), and grab a coffee:

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

**Automatic Updates**: The Skill checks GitHub once a day and updates itself automatically. You can also tell Codex **"Update Codex with ChatGPT"** anytime.

---

## Manual Setup & Usage

1. **Install Skill**: Copy the `skill/` directory to `~/.codex/skills/codex-with-chatgpt/`.
2. **Initial Setup**: Tell Codex: **"Set up Codex with ChatGPT."**
3. **Use Normally**: Tell Codex: **"Use Codex with ChatGPT to implement [feature/task]."**

Codex handles configuration automatically and displays:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only step that may require your interaction is logging into ChatGPT if prompted.

---

## How It Works

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

- **Control Plane (State Messages)**: Codex and ChatGPT exchange tiny structured `[C2C]` state messages (`INIT → PLAN → EXECUTED → REVIEW → DONE`). No raw file contents, logs, or full diffs are pasted into the chat.
- **Data Plane (MCP)**: ChatGPT pulls necessary context on demand through 8 read-only tools:
  `workspace_info`, `list_directory`, `read_file`, `search_workspace`, `git_status`, `git_diff`, `test_status`, `execution_summary`.
- **Independent Review**: After Codex finishes code execution, ChatGPT independently inspects the real `git_diff` and test records via MCP rather than blindly trusting execution claims.

---

## Security Model

- **Read-Only by Construction**: Write, delete, shell execution, and commit tools do not exist on the server. Prompt injection cannot enable destructive operations.
- **One Workspace = One Boundary**: Every OAuth token is strictly bound to a single `workspace_id`. Path containment uses canonical `realpath` checks (symlinks, `../`, and absolute-path traversal are prevented).
- **Sensitive File Protection**: `.env*`, private keys, SSH credentials, and cloud secrets are blocked by default (`.env.example` is allowed). Custom rules can be added in `.c2cignore`.
- **Protected Endpoints**: The public MCP endpoint requires OAuth 2.1 (PKCE S256, Dynamic Client Registration, rotating refresh tokens). Unauthorized requests return `401`; cross-workspace tokens return `403`.
- **Ephemeral Credentials**: Long-lived credentials are never exposed to the browser. Authorization uses a one-time pairing code (5-minute TTL, rate-limited, destroyed immediately upon use).

For details, see [docs/security.md](docs/security.md).

---

## For Developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` CLI
pnpm test           # vitest: unit and integration tests

c2c setup           # Bridge + tunnel + pairing code all in one
c2c sandbox-allow   # Whitelist the settings dir in Codex (macOS / Windows)
c2c status / doctor / pair / unpair / logs / stop
```

**Requirements**: Node.js >= 20, git, `cloudflared` (auto-detected or installed by the Skill).

**Documentation**:
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)

---

## Project Layout

```
src/
  bridge/     Loopback HTTP server, port recovery, admin API
  mcp/        8 read-only tools, stateless Streamable HTTP transport
  auth/       OAuth 2.1 (PKCE, DCR, refresh token rotation, revocation)
  pairing/    One-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  Path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick Tunnel
  execution/  Execution records for the review loop
  process/    Daemon lifecycle management
  cli/        The c2c CLI commands
skill/        The Codex Skill definition
tests/        Unit & integration test suites
docs/         Architecture, protocol, security, and troubleshooting docs
```

---

## Disclaimer & License

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

Released under the [MIT License](LICENSE).
