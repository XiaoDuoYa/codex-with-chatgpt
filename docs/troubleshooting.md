# Troubleshooting

Run machine diagnostics first. These commands redact secrets:

```sh
c2c machine status --json
c2c machine doctor --no-fix --json
```

When repair is appropriate, let the managed lifecycle restart the one Tunnel
and its child:

```sh
c2c machine doctor --json
```

Do not start a second gateway for a workspace and do not kill the tunnel child
directly.

## Workspace state and sandbox cleanup

Run the update check from the affected workspace root and clean obsolete global
write grants once after setup or when migrating from an older release:

```sh
c2c update-check -w <workspace-root> --json
c2c sandbox-clean --json
```

Current mutable workspace state is stored at
`<git-common-dir>/codex-with-chatgpt` for Git checkouts and at
`<workspace-root>/.codex-with-chatgpt` for non-Git workspaces. Current commands
do not use the legacy machine-wide state directory.

## Enable or inspect macOS autostart

Autostart is one machine-level LaunchAgent. Enable and verify it once after
machine setup:

```sh
c2c autostart enable --json
c2c autostart status --json
```

launchd runs hidden `c2c autostart run --quiet`; this only invokes
`ensureMachineGateway` and reuses the official Tunnel-owned child. It does not
create a per-workspace gateway, a second Tunnel, or a browser-page queue. To
remove the LaunchAgent:

```sh
c2c autostart disable --json
```

This command is currently supported on macOS LaunchAgents. It is optional on
other platforms and does not change the machine connection itself.

## `machine setup` says the runtime key is invalid

Pass the path to the file containing the OpenAI Secure MCP Tunnel runtime key:

```sh
c2c machine setup \
  --tunnel-id <tunnel-id> \
  --runtime-key-file /private/path/runtime.key
```

The file must be readable, small, and contain only the key. C2C copies it into
protected machine state. Never paste the key into a prompt or commit it.

## The machine is not ready

Inspect the JSON fields `configured`, `tunnel`, `gateway`, `ready`, and `checks`.
Common causes are a missing pinned client, a stopped tunnel, a child that
exited, or an owner record belonging to another process. Run:

```sh
c2c machine doctor --json
```

If the tunnel is configured but unhealthy, `machine doctor` repairs it. If two
processes report the same machine runtime, stop the managed owner cleanly and
run doctor again; do not delete a runtime record belonging to an unknown
process.

## Connector cannot connect

In ChatGPT connector settings verify exactly:

```text
Name:           Codex with ChatGPT
Secure Tunnel:  the tunnel configured by machine setup
Authentication: None
```

Select the configured OpenAI Secure MCP Tunnel; do not enter a public server
URL. Do not create a connector per workspace or alter a connector belonging to
another purpose. After the connector reports connected, test it in the owned
chat with `workspace_info`.

## `workspace_info` reports the wrong workspace

Stop sending control messages. Check the local route and page lease:

Run these commands from the affected workspace root. Workspace commands derive
the target from the trusted `cwd`; an optional `-w` may only resolve to that
same directory.

```sh
c2c workspace --json
c2c session get --local-session <session-id> --json
c2c surface get --local-session <session-id> --json
```

The Project URL, chat URL and `tabId` must all belong to the current workspace
and local session. First call `cua.getTab(tabId, { browser: "iab" })` for the
stored exact tab and validate both URLs. If that call fails or the URL is
wrong, create a hidden replacement with
`cua.createBrowserTab("iab", targetUrl, { visible: false })`, where `targetUrl`
is the saved chat URL or Project URL. Claim only the returned tab for this
`localSessionId`, supplying the exact current replacement generation and tab
id when required. Never repair this by selecting a tab by URL or sending to a
foreground page.

## `surface claim` rejects the page

Check these values:

- The chat URL is inside the supplied Project URL.
- The exact browser is the built-in in-app browser.
- The `tabId` is current and was read from that browser.
- An existing binding is not being replaced without its exact
  `--replace-generation` and `--replace-tab-id` pair.
- The replacement generation equals the current lease exactly.

The session owns one page. The machine permits 100 unexpired session/page
leases, counted by unique `(projectId, localSessionId)` identities, each
representing one workspace-local session owner. A different session should
create its own Project chat and claim its own tab instead of reusing this one.
If all 100 leases are held, a new-session claim is rejected with a retryable
capacity result; wait, back off, and retry after a lease is released, expires,
or the owning session is retired. Renewing, idempotently reclaiming, or
replacing a page for an existing session reuses its slot.

## `control open` reports `CONTROL_REQUEST_ALREADY_OPEN`

This protects the context token already sent to ChatGPT. Inspect the exact
request:

```sh
c2c control status \
  --local-session <session-id> --request <request-id> \
  --task <task-id> --iteration <n> --phase <phase> --json
```

Wait for it or cancel it. Do not open a replacement while the owned page is
still generating, and do not resend the same question in another chat.

## A control result never arrives

First call `cua.getTab(tabId, { browser: "iab" })` for the exact owned tab and
confirm the Project/chat URL and that the page is finished. Then wait on the
local request again:

```sh
c2c control wait \
  --local-session <session-id> --request <request-id> \
  --task <task-id> --iteration <n> --phase <phase> --json
```

Verify ChatGPT used `context_id` on every MCP call and used the same request and
correlation fields when submitting. A timeout alone is not permission to resend.
Do not accept visible browser text as a result; resume or cancel the exact
protected mailbox request.

## A context is rejected as stale

Issue a new context after any of these events:

- Machine gateway restart or changed `bootEpoch`.
- Workspace unregister/re-register.
- Page rotation or changed `generation`.
- Session compaction and changed `compactionEpoch`.
- Capability expiry or cancellation.

Never extend or reuse a stale context. Re-run `control open` after the local
surface and workspace checks pass.

## One session is slow

Backoff and retry only that session. Other sessions do not share its queue or
page lease. Up to 100 unique `(projectId, localSessionId)` identities can hold
unexpired session/page leases concurrently. When all 100 slots are occupied, a new-session
claim is rejected with a retryable capacity result and retries after a lease is
released, expires, or the owning session is retired. Renewals, idempotent
claims, and page replacements for an existing session reuse its slot. ChatGPT
or the browser may have external service limits; those must be diagnosed from
the affected session's page and request.

## The page was closed or moved

Do not claim a random foreground tab or search for a replacement by URL. Use
the host CUA runtime to create a hidden page with
`cua.createBrowserTab("iab", savedChatUrl ?? projectUrl, { visible: false })`.
Claim the returned exact tab for the same `localSessionId`; if a stored lease
exists, supply its exact `--replace-generation` and `--replace-tab-id`. Re-read
that exact tab with `cua.getTab(tabId, { browser: "iab" })`, verify the Project
and chat URL, then issue a new control context and leave the old one cancelled
or expired. Keep the repaired page in the background.

## A human verification screen appears

Only a login page, CAPTCHA, 2FA prompt, or explicit consent screen may require
user interaction. Temporarily make only that session's page visible and ask for
the one required user action. After it is complete, return the page to the
background, re-read the exact `tabId` with `getTab`, verify the Project/chat
URL, and issue a new context if the page generation changed. Do not make a
normal control turn visible.

## Build or type errors

Use the repository's supported toolchain:

```sh
corepack pnpm install
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Check that Node.js is version 20 or newer. Do not mix generated `dist/` output
from another checkout with the current source.

## Safe reset

Prefer `machine stop`, then `machine start`. If the machine state is malformed,
preserve the diagnostic output and remove only the C2C machine-state files after
confirming no other C2C process is running. A fresh setup will require the
Tunnel id and runtime-key file again; it does not affect ChatGPT ordinary chats.
