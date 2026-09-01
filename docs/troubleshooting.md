# Troubleshooting

The first check is a read-only status and health check:

```
c2c status -w <workspace> --json
c2c doctor -w <workspace> --no-fix --json
```

For the OMP integration, `<workspace>` is `~/Data/OMP`, even when the command
is launched from a child project. `c2c doctor` without `--no-fix` may restart
the bridge or tunnel when repair is requested.

`doctor --json` is a state report, not just a boolean health probe:

- `status: "ok"` means local checks pass and no connector or named-tunnel
  repair is pending.
- `status: "pending"` means the next connector or tunnel action is known.
  In `--no-fix` mode the historical `exitCode` may still be `0`; use the
  JSON status and repair fields rather than the process exit code alone.
- `status: "blocked"` means a local check or repair prerequisite failed.
  Repair mode remains nonzero while a pending repair has not been committed.

Do not open ChatGPT or send `[C2C]` until the doctor gate is green. A
`chatgptRepair` must be completed through the connector recreation and
`connector commit` sequence below.


## Concurrent C2C sessions

The ChatGPT conversation, saved session URL, execution records, and bridge
repair state are shared per workspace. Do not let two coding sessions use the
same browser conversation concurrently. Acquire the workspace lease before
opening ChatGPT or running a mutating command:

```
c2c session lock acquire -w <workspace> --task <task-id> --json
```

Pass the returned token with `--lock-token` to the command, refresh it before
the lease expires, and release it when the loop ends:

```
c2c session lock refresh -w <workspace> --token <token> --json
c2c session lock release -w <workspace> --token <token> --json
```

If acquisition returns `busy`, wait or finish the other task. Never reuse its
token and never force-delete a live lock. A stale lock is reclaimed after its
lease expires.

## Common situations

### "Bridge 未运行"
Run `c2c start -w <workspace> --lock-token <lock-token>` or let `doctor`
repair it with the same token. Bridge logs are available through
`c2c logs -w <workspace>` or `c2c logs -w <workspace> --verbose`.

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next `c2c doctor`
starts a new address and sets `chatgptRepair.needed`. For OMP, run it with
`-w ~/Data/OMP`, then tell the user that the old address expired, delete only
`chatgptRepair.connectorName`, and create it again with the new address. Never
click Reconnect. Do not create a connector for the child project unless
project-level isolation was explicitly requested. Other workspaces keep their
own connectors so two projects can stay connected at once.

Deleting and recreating a connector creates a new ChatGPT app identity. The
saved conversation still references the deleted app and can show
“We couldn't connect your account” even when the bridge is healthy. After
recreating the connector, do not reuse the old session URL:

- Open a fresh ChatGPT conversation.
- Type `@` and select the current connector.
- Send the Boot Prompt, then verify `workspace_info`.
- Commit the verified identity and conversation together:

  ```
  c2c connector commit -w ~/Data/OMP \
    --generation <generation> --fingerprint <fingerprint> \
    --url <conversation-url> --lock-token <lock-token> --json
  ```

The `generation` and `fingerprint` come from `doctor --json`. Run the commit
only after `workspace_info` succeeds; do not call `session set` first.
`session get --json` must report `usable: true` before sending another C2C
control message.

### Connector repair pages
Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Run the status and health checks above first. If `chatgptRepair.needed` is true,
Delete THIS workspace's connector and create it again with the new URL, then
re-run `c2c doctor -w <workspace> --no-fix --json`. Never use Reconnect when the
old public address is dead. If this workspace uses a stable hostname, doctor
sets `namedRepair` instead — re-login to Cloudflare (`c2c tunnel login --lock-token <lock-token>`), then
run doctor again. Do not delete the connector; the address did not change.
After a delete-and-recreate repair, follow the fresh-conversation procedure
above before sending another C2C control message. Fresh pairing code:
`c2c pair --lock-token <lock-token>`.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want the
stable hostname; it runs `c2c tunnel choose --mode named --zone <domain> --lock-token <lock-token>`.

### A pairing code appears on every task
This is not normal after the connector has been authorized. For OMP, verify
`status -w ~/Data/OMP`, `session get -w ~/Data/OMP`, and the saved connector
before asking for a code. If the root bridge has a valid token and
`chatgptRepair.needed` is false, reuse the root connector and saved conversation;
do not run `setup` or `pair`.

The pairing code is a one-time connector authorization code, not a ChatGPT
login code. Repeated prompts usually mean that a child directory was passed as
`-w`, a new connector was created, or the Quick Tunnel URL changed. A
delete-and-recreate repair also invalidates the saved conversation binding, so
create and save a fresh conversation before the next task.

### "配对码无效/过期"
Pairing codes are one-time, memory-only credentials with a default 30-minute
TTL and a five-attempt limit. Run the read-only diagnosis first:

```
c2c doctor -w <workspace> --no-fix --json
```

Create or recreate the reported Connector, then immediately before opening the
OAuth popup run repair-mode doctor with the same lock token:

```
c2c doctor -w <workspace> --json --lock-token <lock-token>
```

Enter `chatgptRepair.pairingCode` immediately. Do not use a code obtained before
Connector creation or wait after obtaining it. Use `c2c pair` only for explicit
reauthorization, not to prepare a code for a Connector that has not been created.

### Legacy endpoint or session state
An old endpoint file is normalized in memory as an unbound version-2
`legacy_state` repair. An old saved conversation without generation and
fingerprint metadata is also unusable. Do not delete state to clear this
condition and do not open the old conversation. Run doctor, recreate only the
reported connector, verify `workspace_info` in a fresh conversation, then use
`connector commit` with the reported generation and fingerprint. The next
endpoint write persists the normalized state.

### Repeated OAuth client registrations
The bridge derives a registration fingerprint from the trimmed client name
and the unique, sorted redirect URI set. Repeating the same DCR request is
idempotent and returns the existing client. If older state contains duplicate
clients, the next load converges to one deterministic canonical client and
retires the duplicate clients and their tokens. This is separate from
connector repair; do not try to fix it by generating another pairing code.

### ChatGPT gets 401 on every tool call
First check whether the root bridge is healthy and whether the connector still
uses the current MCP URL. The access token may have expired and refresh failed,
for example after `c2c unpair` or a long offline period. If the address also
changed, delete THIS workspace's connector and create it again with the new
address. Otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### The pairing page stays open after entering the code
If the bridge log says `Pairing verified` but ChatGPT never receives the
authorization result, update the bridge before retrying. The authorization
page must allow the registered redirect origin in its form policy; an older
build blocked the cross-origin OAuth callback in the browser even though the
bridge had issued the code. After updating, open the connector's Authorize
flow again and use a fresh pairing code.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

The upstream Codex workflow adds that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). The OMP wrapper does not modify
`~/.codex/config.toml`; it keeps the allowlist in the isolated C2C state
directory instead.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### Completely stuck
Do not use `setup` as a routine health check because it creates a new pairing
session. Run the read-only checks first:

```
c2c status -w <workspace> --json
c2c doctor -w <workspace> --no-fix --json
```

If repair is required, run `c2c doctor -w <workspace> --json --lock-token <lock-token>`
and follow its `chatgptRepair` instructions. Complete the fresh-conversation
and `connector commit` sequence before resuming the saved session. Use
`c2c stop -w <workspace> --lock-token <lock-token>` followed by
`c2c setup -w <workspace> --lock-token <lock-token>` only for an explicit full
reinitialization; setup still requires connector authorization, `workspace_info`,
and a binding commit before the session is usable.
