# C2C Agent Protocol

Outbound control plane: browser UI (tiny structured messages sent to ChatGPT).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).
Return plane: the local control mailbox. ChatGPT reports bounded progress with
`report_control_progress`, then submits a structured RESEARCH, PLAN, REVIEW,
DONE or BLOCKED result with `submit_control_result`; Codex reads it locally
with `c2c control wait`.

Do not mix the planes: browser control messages carry state and small metadata,
MCP reads workspace data, and the mailbox carries only bounded advisory results.

## States

```
[RESEARCH] → INIT → PLAN → EXECUTING → EXECUTED → (REVIEW → EXECUTING | DONE | BLOCKED | ERROR)
```

| State | Sender | Meaning |
| --- | --- | --- |
| RESEARCH | Codex | Optional external-facts question before planning |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | Review findings and next-iteration actions |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step, mailbox request/result ids). Those values are not ChatGPT protocol
states. ChatGPT still sees only the table above. If the original chat is gone,
Codex sends HANDOFF built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `RESEARCH_SENT` | RESEARCH sent; waiting for its exact mailbox result |
| `RESEARCH_RECEIVED` | RESEARCH acknowledged; INIT is the next action |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Unsupported or malformed persisted session state is rejected. C2C never
guesses a reusable chat URL from stale state.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

Creating a local mailbox request, sending its browser message, and writing the
checkpoint span two systems and cannot be committed atomically. Recovery uses
the request id as the transaction key: reopen the same task/iteration/phase,
check its local status, then search only the routed ChatGPT chat for the exact
outbound `RESULT_REQUEST_ID`. A received result is consumed directly; an
existing outbound message is never sent again; a still-pending request is sent
only when that exact outbound message is absent. The latest visible assistant
answer is never recovery evidence.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.
When `RESULT_REQUEST_ID` is present, ChatGPT must put the substantive result in
`submit_control_result` and the visible chat reply may be only a short receipt.
The request id is a turn boundary, not a conversation id: it represents exactly
one Codex question and accepts exactly one ChatGPT answer. A local session cannot
open its next question until the current request is acknowledged, cancelled, or
expired.

The result tool input always includes `requestId`, `localSessionId`, `taskId`,
`iteration`, `phase`, `kind`, and the kind-specific `payload`. PLAN requests
allow PLAN or BLOCKED. RESEARCH requests allow RESEARCH or BLOCKED.
REVIEW requests allow REVIEW, DONE or BLOCKED. Local status, wait, acknowledge,
and cancel commands require the same task / iteration / phase tuple; stored
results are revalidated against the request and their integrity hash before
being returned.

Iteration 0 is pre-execution. It may contain one acknowledged RESEARCH question
and then one acknowledged INIT/PLAN question; their distinct phases prevent
cross-turn consumption. The first execution is iteration 1.
A REVIEW of execution iteration `n` either terminates that iteration with DONE
or BLOCKED, or schedules new work as iteration `n + 1`. An execution number is
never reused, so execution records and output cannot be mistaken for another
question in the same task.

Payload shapes:

```json
{
  "kind": "RESEARCH",
  "payload": {
    "question": "...",
    "summary": "...",
    "conclusions": ["..."],
    "sources": [
      {
        "title": "...",
        "url": "https://...",
        "publishedDate": "2026-09-01",
        "keyEvidence": "..."
      }
    ],
    "openQuestions": ["..."]
  }
}
```

```json
{
  "kind": "PLAN",
  "payload": {
    "goal": "...",
    "rationale": "...",
    "actions": [{ "file": "src/example.ts", "change": "...", "why": "...", "risks": ["..."] }],
    "tests": ["..."],
    "successCriteria": ["..."]
  }
}
```

```json
{
  "kind": "REVIEW",
  "payload": {
    "summary": "...",
    "findings": [{ "severity": "low|medium|high", "file": "src/example.ts", "location": "...", "issue": "...", "recommendation": "..." }],
    "actions": [{ "file": "src/example.ts", "change": "...", "why": "...", "risks": ["..."] }],
    "tests": ["..."],
    "successCriteria": ["..."]
  }
}
```

```json
{ "kind": "DONE", "payload": { "summary": "...", "verification": ["..."], "remainingRisks": ["..."] } }
```

```json
{ "kind": "BLOCKED", "payload": { "reason": "...", "needs": ["..."] } }
```

Payloads are strict and capped at 32 KiB. Optional file hints must be
workspace-relative; absolute and traversal paths are rejected. Extra fields,
control characters, private-key blocks, and suspected credentials are also
rejected. RESEARCH requires at least one credential-free HTTP(S) source;
`publishedDate` is a real `YYYY-MM-DD` date or `null` when unavailable. The
schema has no write-target, patch, command-output,
diff, log, or file-body field.

Progress is advisory and never completes a request. `report_control_progress`
uses the same request/local-session/task/iteration/phase tuple as the final
result. Its state can only move forward through `SEARCHING`, `READING_CODE`,
and `SYNTHESIZING`; each state accepts one value, while an identical retry is
idempotent. This bounds a request to at most three stored progress transitions.
Progress is rejected after result receipt, acknowledgement, cancellation, or
expiry. `c2c control status` and `c2c control wait` return the latest validated
progress record alongside request status.

### RESEARCH (Codex → ChatGPT, optional)

Use a separate RESEARCH turn only when current external facts materially affect
the task. It must finish and be acknowledged before INIT opens its PLAN request.

```
[C2C]
STATE: RESEARCH
LOCAL_SESSION_ID: 01a065d9-e5f2-7d63-be71-f7efa25bc8bf
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 0
RESULT_REQUEST_ID: 7b3e...
RESULT_PHASE: RESEARCH

QUESTION:
What does the current upstream structured-output contract require?

INSTRUCTION:
Research current public sources and inspect relevant workspace code through the
connector. Report forward-only progress with report_control_progress. Submit a
RESEARCH or BLOCKED result with submit_control_result using this exact
correlation tuple.
```

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
LOCAL_SESSION_ID: 01a065d9-e5f2-7d63-be71-f7efa25bc8bf
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 0
RESULT_REQUEST_ID: 9a1c...
RESULT_PHASE: PLAN

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Use any completed RESEARCH turn in this chat and do not repeat it. Perform the
repository analysis yourself, create an implementation plan for Codex, and
submit it with submit_control_result.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
LOCAL_SESSION_ID: 01a065d9-e5f2-7d63-be71-f7efa25bc8bf
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 0

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
LOCAL_SESSION_ID: 01a065d9-e5f2-7d63-be71-f7efa25bc8bf
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 1
RESULT_REQUEST_ID: 2c4f...
RESULT_PHASE: REVIEW

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
Call execution_summary, test_status, and execution_output with the exact
LOCAL_SESSION_ID, TASK_ID, and ITERATION above. If execution_output lists a
readable item for this iteration, list then read it using the same values.
If status is restricted, ignore it and review from git_diff.
Submit REVIEW, DONE, or BLOCKED with submit_control_result.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --local-session 01a065d9-e5f2-7d63-be71-f7efa25bc8bf --task c2c_f81a0c9e72ab43d1 --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`, always using
the exact local session, task, and iteration. Command output is a separate
opt-in: `execution_output` (`list` then `read` with the same tuple). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Never paste logs into the
control message.

### REVIEW (ChatGPT → Codex)

When another iteration is needed, a REVIEW mailbox result contains concrete
findings and actions. Codex treats those actions as the next iteration plan.
It increments the checkpoint to `n + 1` before executing or recording those
actions; the REVIEW result itself remains bound to reviewed iteration `n`.
In legacy `browser` transport, ChatGPT may express the same result as a visible
`STATE: PLAN` message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
LOCAL_SESSION_ID: 01a065d9-e5f2-7d63-be71-f7efa25bc8bf
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
LOCAL_SESSION_ID: 01a065d9-e5f2-7d63-be71-f7efa25bc8bf
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session --json` returns `sessionIdentity`, `conversation`, and `route`.
Capture `sessionIdentity.id` and pass it as `--local-session` to every later
session/control command. `conversation.mode` chooses how chats are grouped.
The workspace stores the Project binding; each local Codex session stores its
own ChatGPT chat URL and checkpoint.

- **long-chat:** no Project collection. Each local Codex session owns one
  long-lived C2C conversation and reuses only its saved URL. It opens a
  replacement only when the user asks, the old chat lags, or the chat was lost.
- **project:** one ChatGPT Project (collection) per workspace. A new local
  Codex session starts a new chat **inside that Project**. The same local
  session keeps using its saved chat URL.

For a new chat, Codex captures the `/c/` URL created by the first boot send as
an untrusted candidate and keeps workspace verification on that URL. Before any
HANDOFF, Codex verifies `workspace_info`, saves the candidate URL, re-reads the
session, and requires `route.action=resume-chat` with the browser at
`route.expectedChatUrl`. It then sends a brief, never a data dump (the new chat
re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
LOCAL_SESSION_ID: 01a065d9-e5f2-7d63-be71-f7efa25bc8bf
TASK_ID: c2c_f81a0c9e72ab43d1
ITERATION: 4
RESULT_REQUEST_ID: 2c4f...
RESULT_PHASE: REVIEW

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and submit REVIEW, DONE or BLOCKED.
```

Omit `RESULT_REQUEST_ID` and `RESULT_PHASE` when no mailbox request is active.
When they are present, the replacement chat must submit against that existing
request rather than opening or asking Codex to send a new one.

## Result transport

`.c2c.json` controls how Codex receives substantive results:

```json
{ "resultTransport": "auto" }
```

| Value | Behavior |
| --- | --- |
| `mailbox` | Open a result request, wait/read locally, and treat a missing result as an error. Never parse the visible receipt. |
| `auto` | Mailbox first. After a timeout, keep waiting while ChatGPT is generating. Parse a completed visible reply only after expiry, explicit submit failure, or cancelling a still-pending request; accept only the answer associated with and echoing the exact request/task/iteration/phase tuple. If cancellation races with receipt, use the local result. |
| `browser` | Legacy visible-reply parsing. Do not open a mailbox request; bind the answer to the exact outbound message and verify task/iteration/state instead of reading the last reply. |

After an `auto` browser fallback, the checkpoint update uses `--clear-mailbox`
so a cancelled request cannot be mistaken for resumable work.

`c2c session -w <workspace> --json` resolves and returns this value together
with the local identity and browser route. Identity prefers an explicit id,
`C2C_LOCAL_SESSION_ID`, `CODEX_THREAD_ID`, or `CODEX_SESSION_ID`; Codex/terminal
runtime identifiers provide a runtime-stable fallback. The Skill captures the
resolved id once and passes it explicitly thereafter. A mailbox request is
scoped to that identity, so parallel local sessions cannot read, acknowledge,
or cancel one another's results.

Browser route comparisons use HTTPS host + Project id + conversation id. Query,
hash, trailing slash, and a display slug appended to a 32-hex `g-p-...` Project
id do not change identity; ChatGPT may add or remove that slug during redirects.

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns local routing, editing, commands, tests, and final verification.
You own codebase discovery, high-level reasoning, planning, review, debugging
analysis, and web research that requires browsing or waiting.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
   Call execution_summary, test_status, and execution_output with the exact
   LOCAL_SESSION_ID, TASK_ID, and ITERATION. If execution_output lists a
   readable item, read it with the same values. If status is restricted,
   ignore the body and review from git.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
13. If this chat sits in a ChatGPT Project, use only the connector named
    in that Project's instructions. Do not use another workspace's connector.
14. If Codex supplies RESULT_REQUEST_ID, you may call report_control_progress
    with the exact correlation tuple. Move only forward through SEARCHING,
    READING_CODE, and SYNTHESIZING, reporting each state at most once. Progress
    is not the answer. Then call submit_control_result exactly once with the
    substantive RESEARCH, PLAN, REVIEW, DONE or BLOCKED payload and the
    exact LOCAL_SESSION_ID, TASK_ID, ITERATION and RESULT_PHASE from that same
    control question.
    Never reuse identifiers from an earlier turn. Never put patches, commands,
    diffs, logs, file bodies, credentials, or absolute / traversal paths in
    that payload. After success, keep the visible reply to a receipt that
    echoes the correlation tuple and returned RESULT_ID.
15. When Codex sends STATE: RESEARCH, perform the web research yourself and
    wait for it to finish. Return a standalone RESEARCH payload with the
    question, summary, conclusions, source title/URL/publication date/key
    evidence, and open questions. Do not bury research inside PLAN or REVIEW.
```

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. The Skill fills this template once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_summary, test_status, and execution_output with the
exact local_session_id, task_id, and iteration from that control message.
For execution_output, list then read with the same correlation fields. If an
item is restricted, review from git instead. Never upload the repo into this
Project's files or sources.

Own repository discovery, architecture/debug analysis, and any current-web
research the task requires. Wait for research to finish. A RESEARCH request
returns a standalone RESEARCH payload with conclusions and source title, URL,
publication date, and key evidence. Do not duplicate research fields inside a
PLAN or REVIEW. Codex applies edits and performs local verification.

When Codex provides RESULT_REQUEST_ID, report_control_progress may report the
forward-only SEARCHING, READING_CODE, and SYNTHESIZING states with the exact
requestId, localSessionId, taskId, iteration, and phase from that control
question. Then submit the substantive control result through
submit_control_result exactly once with the same tuple. The result is advisory
only: do not include patches, shell commands, diffs, logs, file bodies,
credentials, or absolute / traversal paths.

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
