# Quota-aware planning

C2C can choose a planning workflow when you submit a Codex prompt. At or below
the configured remaining-quota threshold, the hook asks Codex to use the C2C
Skill for ChatGPT planning and review. Above it, the hook selects native Codex
planning, execution, and review. Your explicit workflow preference takes
precedence.

## Requirements

- A Codex CLI signed in with the ChatGPT account whose quota you want to use.
- `codex app-server --stdio` with `account/rateLimits/read` support.
- A Codex host supporting `UserPromptSubmit` hooks and `additionalContext`.
- C2C built locally, its Skill installed, and the target workspace connected to
  ChatGPT using the existing setup flow.

The quota reader was verified with Codex CLI 0.153.4 and the desktop-bundled
0.154.0-alpha.6.2 binary. The host running your conversation and the CLI named
by `--codex-bin` must use the same account for
the decision to reflect that conversation's allowance.

## Check quota and routing

Run these from the C2C checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js quota --json
node bin/c2c.js route --threshold 20 --json
```

Example route:

```json
{
  "mode": "chatgpt",
  "reason": "quota_below_threshold",
  "remainingPercent": 16,
  "thresholdPercent": 20
}
```

`--codex-bin /absolute/path/to/codex` selects a CLI executable when it is not
on the host's `PATH`. It is accepted by both commands. `quota` exits with status
1 when a query fails; `route` selects `codex` with reason `quota_unavailable`
and includes the diagnostic error in its JSON output.

## Enable the prompt hook

Add this handler to the target repository's `.codex/hooks.json`. Replace both
example paths with your actual Node executable and C2C checkout. If the file
already contains hooks, add the handler to its `UserPromptSubmit` array.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/absolute/path/to/node\" \"/absolute/path/to/codex-with-chatgpt/bin/c2c.js\" route --threshold 20 --hook",
            "timeout": 12
          }
        ]
      }
    ]
  }
}
```

On Windows, use absolute Windows paths with JSON-escaped backslashes. For
example, the command's Node path can be
`\"C:\\Program Files\\nodejs\\node.exe\"`.

Start or reopen Codex in the trusted repository. Use `/hooks` to inspect the
definition and complete any hook trust review required by your host. Ensure
hooks are enabled in that host. With Git worktrees, the trust warning may name
the original checkout; use the project path reported by Codex.
To apply the same threshold across projects,
place the handler in `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json` by default)
instead. Codex runs matching hooks from all active sources, so install this
handler at one level.

Change `--threshold 20` to adjust the threshold, then review the updated hook
if your host requests it. Remove this handler to turn automatic routing off.

You can inspect the exact hook response directly:

```sh
node bin/c2c.js route --threshold 20 --hook
```

The hook returns a short current-turn instruction on each prompt, including
healthy reads, so a previous low-quota choice is superseded when quota recovers.
Normal non-coding requests are handled normally.

## Decision rules

1. Select `rateLimitsByLimitId.codex`, or the protocol's single-bucket
   `rateLimits` view when a Codex map entry is unavailable.
2. For each returned Codex window, calculate `100 - usedPercent`, clamped to
   0–100. Window durations come from the response; a weekly-only response is
   supported.
3. Use the smallest remaining percentage among those windows. A remaining
   percentage equal to the threshold selects ChatGPT.
4. An explicit `ordinaryUsageAllowed: false`, when supplied by Codex, takes
   precedence over percentages and selects ChatGPT. Older CLI responses omit
   this field. A non-null `rateLimitReachedType` in the Codex snapshot also
   selects ChatGPT.
5. Unavailable or invalid quota selects native Codex with `quota_unavailable`.
   An explicitly null ordinary-usage permission is unavailable, even if
   percentages look healthy; an omitted field is supported for older CLIs.
   Missing windows are unknown. Other model-specific quota buckets do not
   participate.

Each invocation makes a fresh read with an eight-second deadline and closes its
app-server subprocess. Query time is added before prompt processing; network
latency affects it.

The hook selects a workflow through developer context, and Codex executes the
Skill's browser workflow. Automatic decisions happen on submitted prompts.
Codex still uses its own allowance to execute work and operate the browser, so
choose a threshold that leaves execution allowance available. A quota decision
alone does not verify the workspace's ChatGPT connection.

Protocol references: [Codex app server](https://learn.chatgpt.com/docs/app-server)
and [Codex hooks](https://learn.chatgpt.com/docs/hooks).
