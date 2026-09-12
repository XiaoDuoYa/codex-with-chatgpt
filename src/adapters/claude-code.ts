import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { Workspace } from "../workspace/manager.js";
import { appendExecutionRecord, readExecutionRecords } from "../execution/records.js";
import { readLastEndpoint } from "../config/endpoint.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { readUiPrefs } from "../config/ui-prefs.js";
import {
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  type SavedSession,
  type TaskCheckpoint,
} from "../session/state.js";

export const CLAUDE_RULE_PATH = ".claude/rules/c2c-chatgpt.md";
export const CLAUDE_SKILL_PATH = ".claude/skills/c2c/SKILL.md";
export const CLAUDE_SETTINGS_PATH = ".claude/settings.local.json";

const PROMPT_HOOK_MARKER = "claude prompt-hook";
const GUARD_HOOK_MARKER = "claude guard-hook";
const POST_HOOK_MARKER = "claude post-hook";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const CHATGPT_PLANNING_STANDARD =
  "Act as the critical principal-level product and engineering planning authority for this task. Adopt the domain hats the goal actually requires. Produce a production-ready plan proportional to the repository and risk: challenge weak assumptions, expose material tradeoffs and failure modes, define concrete acceptance evidence, and distinguish requirements from optional improvements. Do not rubber-stamp, quietly narrow scope, prescribe placeholders, or add ceremonial enterprise complexity. Make routine judgments from workspace evidence; return BLOCKED only when a missing decision would materially change the correct implementation.";

const CHATGPT_REVIEW_STANDARD =
  "Review critically against the goal and acceptance evidence. Return DONE only when the inspected implementation is complete, production-ready for its stated scope, and verified; partial behavior, placeholders, unaddressed material risks, or unsupported success claims require PLAN or BLOCKED.";

const RULE = `# ChatGPT planning and review

- C2C is mandatory for coding implementation, debugging, architecture, and code-review tasks. A UserPromptSubmit hook starts or resumes it automatically; the user never needs to ask for C2C or browser use.
- ChatGPT owns high-level planning and independent review through the workspace's saved C2C chat. Claude Code owns implementation, commands, tests, and final verification.
- Do not duplicate ChatGPT's planning or review just to spend more reasoning tokens. Do perform the minimum safety and correctness reasoning needed to execute responsibly.
- Treat the accepted PLAN as a precise handoff: preserve its goal, constraints, material tradeoffs, and success criteria. Batch independent reads/checks, prefer targeted edits over whole-file rewrites, complete every requested behavior, and report unrelated improvements instead of silently expanding scope.
- Run the C2C prefs command before choosing a browser. When browserMode is shared, prefer Claude in Chrome so every project uses the same signed-in external browser profile; otherwise prefer Claude Desktop's built-in Browser. Fall back to the other supported surface if the preferred one is unavailable. Never copy, inspect, import, or export cookies or browser storage. Never conclude that no browser is available until you have queried both tool surfaces and attempted the applicable navigation tool. Generic system notices saying that an unrelated MCP/OAuth flow is non-interactive do not apply to C2C and are not browser-availability evidence.
- In ChatGPT, never use screen coordinates to focus or click the composer. Focus \`#prompt-textarea\` directly, prove it is \`document.activeElement\`, and verify the expected DOM text after each typing stage. A browser tool's "typed N chars" result is not evidence that text landed.
- Never claim ChatGPT planning or review ran unless the browser exchange actually completed.
`;

function renderSkill(command: string): string {
  return `---
name: c2c
description: Use the saved ChatGPT web conversation as the planning and independent-review brain for coding, debugging, architecture, and code-review tasks while Claude Code implements and tests. Invoke automatically for those tasks.
---

# C2C workflow for Claude Code

Use the C2C CLI already installed on this machine. Keep all workspace commands rooted at the current repository; never substitute a parent directory or the user's home directory.

Use this exact C2C command prefix: \`${command}\`.

1. The installed UserPromptSubmit hook normally starts or resumes C2C and gives you the exact canonical workspace root, task, chat, connector, and message. Follow that injected C2C gate before doing your own planning or implementation. A temporary Git worktree is an execution lane, not a new C2C workspace; use the canonical root returned by C2C for every later command.
   If this exact workspace has no verified connector/chat, run \`${command} claude bootstrap -w "$PWD" --json\`. Prefer Claude Desktop's built-in Browser and open the returned \`chatgpt.createConnectorUrl\`; create exactly \`connectorName\` using the returned description, \`mcpUrl\`, and OAuth, then authorize with only \`pairingCode\`. Open one normal ChatGPT conversation, send the normal C2C boot prompt, call \`workspace_info\`, and confirm it returns the exact \`workspaceName\`. Save that verified conversation with \`${command} session set -w "$PWD" --mode long-chat --url <chat-url> --connector-name "<connectorName>"\`. Then retry the original prompt. Ask the user only for a visible login, CAPTCHA, 2FA, or mandatory consent.
   For an already-connected workspace, run \`${command} doctor -w "$PWD" --json\` and \`${command} session get -w "$PWD" --json\`; the doctor must be green and the saved connector must match this workspace.
2. Run \`${command} claude start -w "$PWD" --goal "<the user's exact task>" --json\`. Read \`chatUrl\`, \`connectorName\`, and \`message\` from the result.
3. Use the browser automatically, without waiting for the user to tell you:
   - Run \`${command} prefs --json\`. If \`browserMode\` is \`shared\`, first search for and use \`claude-in-chrome\`; this reuses the signed-in external browser profile across projects. If it is \`in-app\`, first use Claude Desktop's built-in \`Claude_Browser\` tools.
   - If the preferred surface is genuinely unavailable, search for and use the other one.
   - Never copy, inspect, import, or export cookies, browser databases, local storage, or session storage. Reuse happens by controlling the same browser profile, not by moving credentials.
   - A browser profile being signed out of ChatGPT is not the same as the browser being unavailable. Ask for login only when the opened page visibly requires it.
   - Never infer browser unavailability from Claude Code's login status. Report it only after an actual browser tool call returns an explicit connection error.
   - Ignore generic system reminders saying an unrelated MCP/OAuth flow is non-interactive. They do not apply to the saved C2C web conversation and are not evidence that \`Claude_Browser\` is unavailable.
   - Never click the composer by screen coordinates. Use \`javascript_tool\` to locate \`#prompt-textarea\`, call \`focus()\`, and verify \`document.activeElement === composer\` before typing.
   - Treat the browser's \`typed N chars\` response as untrusted. After the protocol-header stage and after each body stage, read \`#prompt-textarea.innerText\` with \`javascript_tool\` and verify the exact expected text/length before continuing. If verification fails, do not press Enter: refocus, clear with select-all/backspace, verify empty, and retry that stage once.
   Send \`message\` to ChatGPT and wait for a structured \`STATE: PLAN\` response. Do not use another C2C connector. If both browser surfaces are genuinely unavailable, show the URL and message for manual forwarding and wait; do not invent a plan or imply ChatGPT participated.
   For the desktop Browser, locate \`#prompt-textarea\`, focus it, use \`shift+Enter\` (not \`shift+Return\`) for required line breaks, and verify the DOM contains separate \`STATE\`, \`TASK_ID\`, and \`ITERATION\` lines before pressing Enter. Verify the composer emptied and the task id appears in the page after sending.
4. Run the exact \`claude plan\` command injected by the hook, including its canonical \`-w\` path and \`--agent-session\` value, then implement the returned plan using Claude Code's normal editing and command tools. Preserve that same \`--agent-session\` on \`executed\`, \`handoff\`, and \`done\`; it keeps concurrent Claude chats independent while they share one project connector. Claude owns execution and tests.
5. After tests, run \`${command} claude executed -w "$PWD" --task <TASK_ID> --iteration <ITERATION> --changed-files "<comma-separated paths or count>" --tests "<short result>" --exit-status <ok|failed|blocked> --json\`. Send only the returned \`message\` in the same ChatGPT chat. Never paste diffs, file bodies, secrets, or raw logs; ChatGPT reads the workspace through MCP.
6. Wait for ChatGPT to inspect the real diff and return \`STATE: DONE\`, \`PLAN\`, or \`BLOCKED\`. If it returns PLAN, repeat implementation and review. On DONE, run \`${command} claude done -w "$PWD"\`. On a lost/replacement chat, run \`${command} claude handoff -w "$PWD" --json\` and send its \`message\` after the normal C2C boot prompt.
7. Report the tests Claude ran and the independent ChatGPT review result separately.

## Generated media handoff

When the user asks ChatGPT to generate an image or video, request it in the saved ChatGPT web conversation. Use the same preferred browser order above and activate the generated asset's actual Download control through the visible ChatGPT UI. A browser screenshot is navigation/diagnostic evidence only: never save, crop, rename, or import a screenshot as the requested media asset. Then have Claude Code—not the connector—import the downloaded original with: ${command} asset import -w "$PWD" --from <downloaded-file> --to <new-project-relative-path> --json. The importer validates PNG/JPEG/GIF/WebP/SVG/MP4/MOV/WebM content signatures, rejects active SVG content, refuses overwrites, and cannot write outside this workspace. Record the imported path as a changed file. ChatGPT's MCP connector remains read-only; it can inspect supported project images with read_image but cannot write files or retrieve browser downloads by itself.

Keep the control messages small. ChatGPT plans and reviews; Claude Code implements.
`;
}

export interface ClaudeAdapterInstallResult {
  workspaceRoot: string;
  rulePath: string;
  skillPath: string;
  settingsPath: string;
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface ClaudeGlobalAdapterInstallResult {
  settingsPath: string;
  created: boolean;
  updated: boolean;
  unchanged: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function managedHook(
  command: string,
  marker: string,
  workspaceRoot?: string,
  globalFallback = false
): JsonObject {
  const scope = workspaceRoot
    ? ` --workspace-root ${shellQuote(workspaceRoot)}`
    : globalFallback
      ? " --global-fallback"
      : "";
  return {
    type: "command",
    command: `${command} claude ${marker}${scope}`,
  };
}

function mergeManagedHook(settings: JsonObject, event: string, matcher: string | null, hook: JsonObject, marker: string): void {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  const kept = groups.filter((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return true;
    return !group.hooks.some((entry) => isObject(entry) && String(entry.command ?? "").includes(marker));
  });
  const group: JsonObject = { hooks: [hook] };
  if (matcher) group.matcher = matcher;
  kept.push(group);
  hooks[event] = kept;
}

function renderSettings(current: string | null, command: string, workspaceRoot: string): string {
  let settings: JsonObject = {};
  if (current?.trim()) {
    const parsed = JSON.parse(current) as unknown;
    if (!isObject(parsed)) throw new Error(`${CLAUDE_SETTINGS_PATH} must contain a JSON object`);
    settings = parsed;
  }
  mergeManagedHook(
    settings,
    "UserPromptSubmit",
    null,
    managedHook(command, "prompt-hook", workspaceRoot),
    PROMPT_HOOK_MARKER
  );
  mergeManagedHook(
    settings,
    "PreToolUse",
    "Bash|Edit|Write|NotebookEdit",
    managedHook(command, "guard-hook", workspaceRoot),
    GUARD_HOOK_MARKER
  );
  mergeManagedHook(
    settings,
    "PostToolUse",
    "Bash",
    managedHook(command, "post-hook", workspaceRoot),
    POST_HOOK_MARKER
  );
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function renderGlobalSettings(current: string | null, command: string): string {
  let settings: JsonObject = {};
  if (current?.trim()) {
    const parsed = JSON.parse(current) as unknown;
    if (!isObject(parsed)) throw new Error("Claude global settings must contain a JSON object");
    settings = parsed;
  }
  mergeManagedHook(
    settings,
    "UserPromptSubmit",
    null,
    managedHook(command, "prompt-hook", undefined, true),
    PROMPT_HOOK_MARKER
  );
  mergeManagedHook(
    settings,
    "PreToolUse",
    "Bash|Edit|Write|NotebookEdit",
    managedHook(command, "guard-hook", undefined, true),
    GUARD_HOOK_MARKER
  );
  mergeManagedHook(
    settings,
    "PostToolUse",
    "Bash",
    managedHook(command, "post-hook", undefined, true),
    POST_HOOK_MARKER
  );
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function writeManagedFile(file: string, content: string, result: ClaudeAdapterInstallResult): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const relative = path.relative(result.workspaceRoot, file).split(path.sep).join("/");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content, "utf8");
    result.created.push(relative);
    return;
  }
  const current = fs.readFileSync(file, "utf8");
  if (current === content) {
    result.unchanged.push(relative);
    return;
  }
  fs.writeFileSync(file, content, "utf8");
  result.updated.push(relative);
}

export function installClaudeAdapter(workspaceRoot: string, command = "c2c"): ClaudeAdapterInstallResult {
  const workspace = new Workspace(workspaceRoot);
  const rule = workspace.resolve(CLAUDE_RULE_PATH, { allowSensitive: true }).abs;
  const skill = workspace.resolve(CLAUDE_SKILL_PATH, { allowSensitive: true }).abs;
  const settings = workspace.resolve(CLAUDE_SETTINGS_PATH, { allowSensitive: true }).abs;
  const result: ClaudeAdapterInstallResult = {
    workspaceRoot: workspace.root,
    rulePath: rule,
    skillPath: skill,
    settingsPath: settings,
    created: [],
    updated: [],
    unchanged: [],
  };
  writeManagedFile(rule, RULE, result);
  writeManagedFile(skill, renderSkill(command), result);
  const currentSettings = fs.existsSync(settings) ? fs.readFileSync(settings, "utf8") : null;
  writeManagedFile(settings, renderSettings(currentSettings, command, workspace.root), result);
  return result;
}

export function installClaudeGlobalAdapter(
  settingsPath: string,
  command = "c2c"
): ClaudeGlobalAdapterInstallResult {
  const resolved = path.resolve(settingsPath);
  const exists = fs.existsSync(resolved);
  const current = exists ? fs.readFileSync(resolved, "utf8") : null;
  const rendered = renderGlobalSettings(current, command);
  if (current === rendered) {
    return { settingsPath: resolved, created: false, updated: false, unchanged: true };
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, rendered, { encoding: "utf8", mode: 0o600 });
  return { settingsPath: resolved, created: !exists, updated: exists, unchanged: false };
}

export function claudeAdapterInstalled(workspaceRoot: string): boolean {
  const workspace = new Workspace(workspaceRoot);
  const rule = workspace.resolve(CLAUDE_RULE_PATH, { allowSensitive: true }).abs;
  const skill = workspace.resolve(CLAUDE_SKILL_PATH, { allowSensitive: true }).abs;
  const settings = workspace.resolve(CLAUDE_SETTINGS_PATH, { allowSensitive: true }).abs;
  if (!fs.existsSync(rule) || !fs.existsSync(skill) || !fs.existsSync(settings)) return false;
  const content = fs.readFileSync(settings, "utf8");
  return content.includes(PROMPT_HOOK_MARKER) && content.includes(GUARD_HOOK_MARKER) && content.includes(POST_HOOK_MARKER);
}

function compact(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

const CODING_TASK_PATTERN =
  /\b(add|analy[sz]e|architect(?:ure)?|assess|audit|build|change|code|configure|create|debug|design|develop|diagnos(?:e|is)|fix|generate|implement|improve|integrate|investigate|migrat(?:e|ion)|optimi[sz]e|patch|plan|refactor|remove|rename|review|rewrite|setup|style|test|troubleshoot|update|upgrade)\b|\b(bug|feature|repository|repo|codebase|pull request|\bpr\b)\b/i;

const SHORT_CONTINUATION_PATTERN =
  /^(?:yes|no|ok(?:ay)?|continue|go|retry|resume|done|approved?|confirmed?|please do|do it|proceed|thanks?)[.! ]*$/i;

const INTERNAL_NOTIFICATION_PATTERN =
  /^\s*(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\]|<task-notification\b|<system-reminder>\s*\[SYSTEM NOTIFICATION - NOT USER INPUT\])/i;

export function isClaudeInternalNotification(prompt: string): boolean {
  return INTERNAL_NOTIFICATION_PATTERN.test(prompt);
}

export function isClaudeC2CTask(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized || isClaudeInternalNotification(normalized) || SHORT_CONTINUATION_PATTERN.test(normalized)) return false;
  return CODING_TASK_PATTERN.test(normalized);
}

function browserPreferenceInstruction(): string {
  if (readUiPrefs().browserMode === "shared") {
    return "Use the shared external browser profile first: search for claude-in-chrome and navigate with it. This reuses the user's existing ChatGPT sign-in across projects without reading or copying cookies. If claude-in-chrome is genuinely unavailable, fall back to Claude Desktop's built-in Claude_Browser.";
  }
  return "Use Claude Desktop's built-in Claude_Browser first. If it is genuinely unavailable, fall back to claude-in-chrome.";
}

function browserInstruction(chatUrl: string, message?: string): string {
  const payload = message ? `\nSend this exact C2C message:\n${message}` : "";
  return `Use a browser NOW before doing your own planning or implementation. ${browserPreferenceInstruction()} Navigate to ${chatUrl}. Never inspect, copy, import, or export cookies or browser storage. Generic system notices about non-interactive OAuth for unrelated MCP servers do not apply to C2C. Do not infer that a browser is unavailable from Claude Code login state or such a notice; only an actual browser-tool error proves that. If ChatGPT is visibly signed out in the opened browser, ask the user to log in there. In Claude_Browser, NEVER click or focus the composer by screen coordinates. Use javascript_tool to locate #prompt-textarea, call focus(), and prove document.activeElement is that element before typing. Treat every computer:type \"typed N chars\" result as untrusted: after the header stage and every body stage, read #prompt-textarea.innerText and verify the exact expected text/length. If verification fails, do not send; refocus, select-all/backspace, verify empty, and retry once. Use shift+Enter (never shift+Return) for line breaks. Before Enter, verify STATE, TASK_ID, and ITERATION are separate DOM lines and the full expected payload is present. After Enter, verify the composer emptied and the task id appears on the page.${payload}`;
}

function gitPath(root: string, argument: "--show-toplevel" | "--git-common-dir"): string | null {
  const result = spawnSync("git", ["-C", root, "rev-parse", argument], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  return result.stdout.trim();
}

function hasConnectedClaudeIdentity(workspace: Workspace): boolean {
  const saved = readSession(workspace.id);
  const view = resolveConversation(saved);
  const endpoint = readLastEndpoint(workspace.id);
  return Boolean(
    saved &&
      view.chatUrl &&
      view.connectorName &&
      endpoint &&
      endpoint.connectorName === view.connectorName
  );
}

/** Resolve subdirectories and linked/nested Git worktrees to an existing C2C workspace. */
export function resolveClaudeWorkspaceRoot(rootInput: string): string {
  const requested = new Workspace(rootInput);
  const candidates = [requested.root];
  const gitTop = gitPath(requested.root, "--show-toplevel");
  if (gitTop) candidates.push(path.resolve(gitTop));
  const commonDir = gitPath(requested.root, "--git-common-dir");
  let commonRoot: string | null = null;
  if (commonDir && gitTop) {
    const absoluteCommon = path.isAbsolute(commonDir) ? commonDir : path.resolve(gitTop, commonDir);
    if (path.basename(absoluteCommon) === ".git") {
      commonRoot = path.dirname(absoluteCommon);
      candidates.push(commonRoot);
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const workspace = new Workspace(candidate);
      if (hasConnectedClaudeIdentity(workspace)) return workspace.root;
    } catch {
      // Ignore stale git paths and fall back to the exact requested workspace.
    }
  }
  // Before the first connection, the adapter's installation root is still the
  // authoritative project identity. This prevents bootstrapping one connector
  // per worktree even when no saved session exists yet.
  if (commonRoot) return new Workspace(commonRoot).root;
  if (gitTop) return new Workspace(gitTop).root;
  return requested.root;
}

function claudeWorkspace(rootInput: string): Workspace {
  return new Workspace(resolveClaudeWorkspaceRoot(rootInput));
}

interface ClaudeAgentSession {
  agentSessionId: string;
  checkpoint: TaskCheckpoint;
  savedAt: string;
}

function normalizedAgentSessionId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 256) : null;
}

function claudeAgentSessionFile(workspaceId: string, agentSessionId: string): string {
  const id = createHash("sha256").update(agentSessionId).digest("hex").slice(0, 24);
  return path.join(getStateDir(), "claude-sessions", workspaceId, `${id}.json`);
}

function readClaudeAgentSession(workspace: Workspace, agentSessionId: string | undefined): ClaudeAgentSession | null {
  const normalized = normalizedAgentSessionId(agentSessionId);
  if (!normalized) return null;
  const value = readJsonIfExists<ClaudeAgentSession>(claudeAgentSessionFile(workspace.id, normalized));
  return value?.agentSessionId === normalized && value.checkpoint ? value : null;
}

function writeClaudeAgentCheckpoint(
  workspace: Workspace,
  agentSessionId: string,
  checkpoint: TaskCheckpoint
): ClaudeAgentSession {
  const normalized = normalizedAgentSessionId(agentSessionId);
  if (!normalized) throw new Error("agent session id must not be empty");
  const value = { agentSessionId: normalized, checkpoint, savedAt: new Date().toISOString() };
  writeSecureJson(claudeAgentSessionFile(workspace.id, normalized), value);
  return value;
}

function clearClaudeAgentCheckpoint(workspace: Workspace, agentSessionId: string): void {
  const normalized = normalizedAgentSessionId(agentSessionId);
  if (!normalized) return;
  fs.rmSync(claudeAgentSessionFile(workspace.id, normalized), { force: true });
}

function checkpointFor(
  workspace: Workspace,
  saved: SavedSession | null,
  agentSessionId: string | undefined
): TaskCheckpoint | undefined {
  const normalized = normalizedAgentSessionId(agentSessionId);
  if (!normalized) return saved?.checkpoint;
  const agent = readClaudeAgentSession(workspace, normalized);
  return agent?.checkpoint;
}

export function readClaudeCheckpoint(workspaceRoot: string, agentSessionId?: string): TaskCheckpoint | null {
  const workspace = claudeWorkspace(workspaceRoot);
  return checkpointFor(workspace, readSession(workspace.id), agentSessionId) ?? null;
}

function saveCheckpoint(
  workspace: Workspace,
  previous: SavedSession,
  patch: Parameters<typeof mergeSession>[1],
  agentSessionId?: string
): { session: SavedSession; checkpoint: TaskCheckpoint } {
  const normalized = normalizedAgentSessionId(agentSessionId);
  const agentPrevious = normalized ? readClaudeAgentSession(workspace, normalized)?.checkpoint : undefined;
  const base = normalized && agentPrevious
    ? { ...previous, checkpoint: agentPrevious }
    : previous;
  const merged = mergeSession(base, patch);
  if (!merged.checkpoint) throw new Error("Claude checkpoint was not created");
  if (!normalized) {
    writeSession(workspace.id, merged);
    return { session: merged, checkpoint: merged.checkpoint };
  }
  writeClaudeAgentCheckpoint(workspace, normalized, merged.checkpoint);
  const shared = mergeSession(previous, {
    taskId: patch.taskId,
    iteration: patch.iteration,
    lastState: patch.lastState,
    clearCheckpoint: true,
  });
  writeSession(workspace.id, shared);
  return { session: shared, checkpoint: merged.checkpoint };
}

export interface ClaudePromptHookResult {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

export function claudePromptHook(opts: {
  workspaceRoot: string;
  prompt: string;
  command: string;
  agentSessionId?: string;
}): ClaudePromptHookResult {
  if (isClaudeInternalNotification(opts.prompt)) return {};
  const workspace = claudeWorkspace(opts.workspaceRoot);
  const saved = readSession(workspace.id);
  const checkpoint = checkpointFor(workspace, saved, opts.agentSessionId);
  const agentArg = normalizedAgentSessionId(opts.agentSessionId)
    ? ` --agent-session ${JSON.stringify(normalizedAgentSessionId(opts.agentSessionId))}`
    : "";
  if (checkpoint && !["DONE", "BLOCKED"].includes(checkpoint.protocolState)) {
    if (["PLAN_RECEIVED", "EXECUTING"].includes(checkpoint.protocolState)) {
      const context = `C2C EXECUTION GATE. Canonical workspace: ${JSON.stringify(workspace.root)}. Continue the already accepted ChatGPT plan for task ${checkpoint.taskId}; do not start a duplicate C2C task. Claude Code owns implementation and tests. Use ${opts.command} claude executed -w ${JSON.stringify(workspace.root)}${agentArg} after testing, then send its review message as specified by the project C2C skill.`;
      return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
    }
    const view = resolveConversation(saved);
    const context = view.chatUrl
      ? `MANDATORY C2C RESUME GATE. An existing C2C task (${checkpoint.taskId}, ${checkpoint.protocolState}, waiting for ${checkpoint.waitingFor}) is active. Do not start another task and do not implement before the required ChatGPT response. ${browserInstruction(view.chatUrl)}`
      : "MANDATORY C2C RESUME GATE. An active C2C checkpoint exists but its verified ChatGPT chat is missing. Repair the workspace connection before implementation.";
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  }
  if (!isClaudeC2CTask(opts.prompt)) return {};
  try {
    const started = startClaudeTask({
      workspaceRoot: workspace.root,
      goal: opts.prompt,
      agentSessionId: opts.agentSessionId,
    });
    const context = `MANDATORY C2C PLAN GATE. Canonical workspace: ${JSON.stringify(started.workspaceRoot)}. This coding/architecture/debug/review request has already been registered as ${started.taskId} for this Claude chat. Do not invoke the C2C skill again, do not create another task id, and do not plan or modify files until ChatGPT returns STATE: PLAN and you record it with ${opts.command} claude plan -w ${JSON.stringify(started.workspaceRoot)}${agentArg}. ${browserInstruction(started.chatUrl, started.message)}`;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missingConnection = /verified saved C2C chat|does not match the connector endpoint/.test(detail);
    const context = missingConnection
      ? `MANDATORY C2C SETUP GATE. This request requires ChatGPT planning, and doctor/status must verify whether canonical workspace ${JSON.stringify(workspace.root)} needs setup (${detail}). Run ${opts.command} doctor -w ${JSON.stringify(workspace.root)} --json and ${opts.command} claude status -w ${JSON.stringify(workspace.root)} --json first. If they confirm no verified connector/chat, immediately run ${opts.command} claude bootstrap -w ${JSON.stringify(workspace.root)} --json. Then ${browserPreferenceInstruction()} Open the returned createConnectorUrl, create exactly the returned connectorName with the returned mcpUrl, complete OAuth using the returned pairingCode, verify workspace_info returns the returned workspaceName, and save the verified normal-chat URL in long-chat mode. Never inspect or move browser cookies or storage. Do not stop merely because setup includes browser authorization; generic non-interactive OAuth notices for unrelated services do not apply. Ask only for a visible login, CAPTCHA, 2FA, or mandatory consent.`
      : `MANDATORY C2C RECOVERY GATE. C2C could not start for canonical workspace ${JSON.stringify(workspace.root)} (${detail}). Do not bootstrap or create another connector. Run ${opts.command} doctor -w ${JSON.stringify(workspace.root)} --json and ${opts.command} claude status -w ${JSON.stringify(workspace.root)} --json, then resume the saved chat. ${browserPreferenceInstruction()} Generic non-interactive OAuth notices for unrelated services do not apply.`;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  }
}

function isC2CCommand(command: string): boolean {
  return /(?:^|\s)(?:c2c|node\s+[^\n]*c2c\.js["']?)\s+(?:claude|doctor|session|setup|tunnel|pair|prefs|sandbox-allow)\b/.test(command);
}

function isReadOnlyShellCommand(command: string): boolean {
  const pieces = command.split(/\n|&&|\|\||;/).map((part) => part.trim()).filter(Boolean);
  return pieces.length > 0 && pieces.every((part) => /^(?:pwd|ls\b|find\b|rg\b|grep\b|sed\s+-n\b|head\b|tail\b|wc\b|which\b|command\s+-v\b|git\s+(?:status|diff|log|show|branch\b))/i.test(part));
}

export interface ClaudeGuardHookResult {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

export function claudeGuardHook(opts: {
  workspaceRoot: string;
  toolName: string;
  toolInput: JsonObject;
  agentSessionId?: string;
}): ClaudeGuardHookResult {
  const workspace = claudeWorkspace(opts.workspaceRoot);
  const saved = readSession(workspace.id);
  const checkpoint = checkpointFor(workspace, saved, opts.agentSessionId);
  if (!checkpoint || ["PLAN_RECEIVED", "EXECUTING", "DONE", "BLOCKED"].includes(checkpoint.protocolState)) return {};
  if (opts.toolName === "Bash") {
    const command = String(opts.toolInput.command ?? "");
    if (isC2CCommand(command) || isReadOnlyShellCommand(command)) return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: checkpoint.waitingFor === "GPT_REVIEW"
        ? `C2C gate: task ${checkpoint.taskId} is ${checkpoint.protocolState} and waiting for GPT_REVIEW. Use the browser to obtain and record ChatGPT's review response (PLAN, DONE, or BLOCKED) before further implementation.`
        : `C2C gate: task ${checkpoint.taskId} is ${checkpoint.protocolState} and waiting for ${checkpoint.waitingFor}. Use the browser to obtain and record ChatGPT's PLAN before implementation.`,
    },
  };
}

export interface ClaudePostToolHookResult {
  hookSpecificOutput?: {
    hookEventName: "PostToolUse";
    additionalContext: string;
  };
}

export function claudePostToolHook(opts: { workspaceRoot: string; agentSessionId?: string }): ClaudePostToolHookResult {
  const workspace = claudeWorkspace(opts.workspaceRoot);
  const saved = readSession(workspace.id);
  const checkpoint = checkpointFor(workspace, saved, opts.agentSessionId);
  if (!saved || !checkpoint || checkpoint.protocolState !== "EXECUTED_SENT") return {};
  const view = resolveConversation(saved);
  const record = readExecutionRecords(workspace.id, 100)
    .reverse()
    .find((candidate) => candidate.taskId === checkpoint.taskId && candidate.iteration === checkpoint.iteration);
  if (!view.chatUrl || !view.connectorName || !record || record.taskId !== checkpoint.taskId) return {};
  const changedFiles = Array.isArray(record.changedFiles) ? record.changedFiles.join(",") : String(record.changedFiles);
  const message = `[C2C]\nSTATE: EXECUTED\nTASK_ID: ${checkpoint.taskId}\nITERATION: ${checkpoint.iteration}\n\nRESULT:\nExecution ${record.exitStatus}.\n\nCHANGED_FILES:\n${changedFiles}\n\nTESTS:\n${record.tests ?? "not run"}\n\nUse only the connector named "${view.connectorName}". Independently inspect workspace_info and the current git diff through MCP. If execution_output lists a readable item for this iteration, list then read it. ${CHATGPT_REVIEW_STANDARD} Reply PLAN, DONE, or BLOCKED.`;
  const context = `MANDATORY C2C REVIEW GATE. Local execution for task ${checkpoint.taskId} has been recorded. Send the review message now and wait for ChatGPT's independent PLAN, DONE, or BLOCKED response before further implementation. ${browserInstruction(view.chatUrl, message)}`;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
}

export function newClaudeTaskId(): string {
  return `c2c_${randomBytes(3).toString("hex")}`;
}

function requireConnectedSession(workspace: Workspace): SavedSession {
  const saved = readSession(workspace.id);
  const view = resolveConversation(saved);
  if (!saved || !view.chatUrl || !view.connectorName) {
    throw new Error(
      "Claude adapter requires a verified saved C2C chat and connector for this exact workspace"
    );
  }
  const endpoint = readLastEndpoint(workspace.id);
  if (!endpoint || endpoint.connectorName !== view.connectorName) {
    throw new Error(
      "Saved ChatGPT session does not match the connector endpoint for this exact workspace"
    );
  }
  return saved;
}

export interface ClaudeControlResult {
  workspaceRoot: string;
  workspaceName: string;
  chatUrl: string;
  connectorName: string;
  taskId: string;
  iteration: number;
  message: string;
}

function controlResult(
  workspace: Workspace,
  session: SavedSession,
  taskId: string,
  iteration: number,
  message: string
): ClaudeControlResult {
  const view = resolveConversation(session);
  return {
    workspaceRoot: workspace.root,
    workspaceName: workspace.name,
    chatUrl: view.chatUrl!,
    connectorName: view.connectorName!,
    taskId,
    iteration,
    message,
  };
}

export function startClaudeTask(opts: {
  workspaceRoot: string;
  goal: string;
  taskId?: string;
  agentSessionId?: string;
}): ClaudeControlResult {
  const workspace = claudeWorkspace(opts.workspaceRoot);
  const previous = requireConnectedSession(workspace);
  // The goal crosses the browser only once. Preserve enough user intent for
  // architecture briefs while still preventing a transcript-sized payload.
  const goal = compact(opts.goal, 1500);
  if (!goal) throw new Error("goal must not be empty");
  const taskId = opts.taskId?.trim() || newClaudeTaskId();
  const iteration = 0;
  const { session: saved } = saveCheckpoint(workspace, previous, {
    taskId,
    iteration,
    lastState: "INIT",
    checkpoint: {
      protocolState: "INIT",
      waitingFor: "GPT_PLAN",
      originalGoal: goal,
      nextExpectedStep: "Wait for ChatGPT PLAN, then Claude Code implements it.",
    },
  }, opts.agentSessionId);
  const message = `[C2C]\nSTATE: INIT\nTASK_ID: ${taskId}\nITERATION: 0\n\nGOAL:\n${goal}\n\nROLE_AND_QUALITY_BAR:\n${CHATGPT_PLANNING_STANDARD}\n\nINSTRUCTION:\nUse only the connector named "${saved.connectorName}". Confirm workspace_info returns "${workspace.name}". Inspect only relevant workspace evidence, batch independent reads when possible, and create a finite implementation brief for Claude Code with rationale, concrete actions, likely files, material risks and tradeoffs, tests, and observable success criteria.`;
  return controlResult(workspace, saved, taskId, iteration, message);
}

export function markClaudePlan(opts: {
  workspaceRoot: string;
  taskId: string;
  iteration: number;
  nextStep?: string;
  agentSessionId?: string;
}): ClaudeControlResult {
  const workspace = claudeWorkspace(opts.workspaceRoot);
  const previous = requireConnectedSession(workspace);
  const { session: saved } = saveCheckpoint(workspace, previous, {
    taskId: opts.taskId,
    iteration: opts.iteration,
    lastState: "PLAN",
    checkpoint: {
      protocolState: "PLAN_RECEIVED",
      waitingFor: "none",
      nextExpectedStep: compact(opts.nextStep ?? "Claude Code implements the accepted PLAN.", 400),
    },
  }, opts.agentSessionId);
  return controlResult(workspace, saved, opts.taskId, opts.iteration, "PLAN recorded; Claude Code owns execution.");
}

export function markClaudeExecuted(opts: {
  workspaceRoot: string;
  taskId: string;
  iteration: number;
  changedFiles: string;
  tests: string;
  exitStatus: "ok" | "failed" | "blocked";
  agentSessionId?: string;
}): ClaudeControlResult {
  const workspace = claudeWorkspace(opts.workspaceRoot);
  const previous = requireConnectedSession(workspace);
  const changedFiles = compact(opts.changedFiles || "0", 300);
  const tests = compact(opts.tests || "not run", 300);
  const changedRecord = /^\d+$/.test(changedFiles)
    ? Number(changedFiles)
    : changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
  appendExecutionRecord(workspace.id, {
    taskId: opts.taskId,
    iteration: opts.iteration,
    changedFiles: changedRecord,
    tests,
    exitStatus: opts.exitStatus,
    timestamp: new Date().toISOString(),
    notes: "Recorded by the Claude Code adapter",
  });
  const { session: saved } = saveCheckpoint(workspace, previous, {
    taskId: opts.taskId,
    iteration: opts.iteration,
    lastState: "EXECUTED",
    checkpoint: {
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      knownIssues: opts.exitStatus === "ok" ? undefined : `Execution status: ${opts.exitStatus}`,
      nextExpectedStep: "Wait for ChatGPT to inspect the real diff and reply PLAN, DONE, or BLOCKED.",
    },
  }, opts.agentSessionId);
  const message = `[C2C]\nSTATE: EXECUTED\nTASK_ID: ${opts.taskId}\nITERATION: ${opts.iteration}\n\nRESULT:\nExecution ${opts.exitStatus}.\n\nCHANGED_FILES:\n${changedFiles}\n\nTESTS:\n${tests}\n\nUse only the connector named "${saved.connectorName}". Independently inspect workspace_info and the current git diff through MCP. If execution_output lists a readable item for this iteration, list then read it. ${CHATGPT_REVIEW_STANDARD} Reply PLAN, DONE, or BLOCKED.`;
  return controlResult(workspace, saved, opts.taskId, opts.iteration, message);
}

export function claudeHandoff(workspaceRoot: string, agentSessionId?: string): ClaudeControlResult {
  const workspace = claudeWorkspace(workspaceRoot);
  const saved = requireConnectedSession(workspace);
  const checkpoint = checkpointFor(workspace, saved, agentSessionId);
  if (!checkpoint) throw new Error("No active C2C checkpoint exists for this workspace");
  const message = `[C2C]\nSTATE: HANDOFF\nTASK_ID: ${checkpoint.taskId}\nITERATION: ${checkpoint.iteration}\n\nORIGINAL_GOAL:\n${checkpoint.originalGoal ?? "Not recorded."}\n\nPROGRESS:\n${checkpoint.completedSubtasks ?? "See the connected workspace and git diff."}\n\nCURRENT_STATE:\n${checkpoint.protocolState}\n\nKNOWN_ISSUES:\n${checkpoint.knownIssues ?? "None recorded."}\n\nNEXT_EXPECTED_STEP:\n${checkpoint.nextExpectedStep ?? "Inspect the workspace and continue the C2C loop."}`;
  return controlResult(workspace, saved, checkpoint.taskId, checkpoint.iteration, message);
}

export function finishClaudeTask(workspaceRoot: string, agentSessionId?: string): SavedSession {
  const workspace = claudeWorkspace(workspaceRoot);
  const previous = requireConnectedSession(workspace);
  if (normalizedAgentSessionId(agentSessionId)) clearClaudeAgentCheckpoint(workspace, agentSessionId!);
  const saved = mergeSession(previous, { clearCheckpoint: true, lastState: "DONE" });
  writeSession(workspace.id, saved);
  return saved;
}

export function launchClaudeCode(
  workspaceRoot: string,
  extraArgs: string[] = [],
  runner: typeof spawnSync = spawnSync,
  installCommand = "c2c"
): SpawnSyncReturns<Buffer> {
  const workspace = new Workspace(workspaceRoot);
  if (!claudeAdapterInstalled(workspace.root)) installClaudeAdapter(workspace.root, installCommand);
  return runner("claude", ["--chrome", ...extraArgs], {
    cwd: workspace.root,
    stdio: "inherit",
    windowsHide: true,
  });
}
