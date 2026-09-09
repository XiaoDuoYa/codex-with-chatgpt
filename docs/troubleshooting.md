# Troubleshooting

First move, always:

```
c2c gateway doctor
```

It checks the shared Gateway, the current workspace lease, MCP, OAuth and the
tunnel — and repairs what it can without asking.

## Common situations

### "Gateway 未运行"
`c2c gateway setup -w <workspace>` (or let `c2c gateway doctor` start it).
Gateway logs are in the C2C state directory under `logs/gateway.out.log`.

If the Gateway state is **uncertain** (无法确认), do not start a second
Gateway and do not change the ChatGPT connector. Wait and run the Gateway
doctor again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next
`c2c gateway doctor` restarts the shared Gateway and tunnel. With a named
hostname, the existing global connector remains valid; with a temporary
address, re-authorize the single global connector only when the address really
changed.

On the first start after upgrading from the old per-workspace Bridge, Gateway
imports the local OAuth state once and rebinds it to the shared connector. No
new pairing is needed while a valid refresh authorization exists. If the state
was already revoked or expired, run `c2c gateway pair` and authorize once.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c gateway doctor`, then re-authorize the single global
connector only if its address changed. Fresh pairing code: `c2c gateway pair`.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps one Gateway hostname such as `example.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes:

```
c2c gateway pair
```

generates a fresh one (older codes become invalid immediately).

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after a long offline
period). Re-authorize the single global connector if the address also changed;
otherwise run Authorize again in ChatGPT and enter a fresh pairing code. Never
use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c gateway setup`, `c2c gateway doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
Handled automatically: the shared Gateway is reused and each new workspace is
attached through a short-lived local lease. A free port is selected when the
preferred one is occupied.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Projects remain per workspace, but all of them use the
single shared Gateway connector.

### Completely stuck
```
c2c gateway stop
c2c gateway setup -w <workspace>
```

re-creates the Gateway, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
