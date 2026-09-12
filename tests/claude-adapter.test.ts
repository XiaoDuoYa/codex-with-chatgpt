import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_RULE_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SKILL_PATH,
  claudeAdapterInstalled,
  claudeGuardHook,
  claudePostToolHook,
  claudeHandoff,
  claudePromptHook,
  finishClaudeTask,
  installClaudeAdapter,
  installClaudeGlobalAdapter,
  isClaudeC2CTask,
  isClaudeInternalNotification,
  launchClaudeCode,
  markClaudeExecuted,
  markClaudePlan,
  readClaudeCheckpoint,
  resolveClaudeWorkspaceRoot,
  startClaudeTask,
} from "../src/adapters/claude-code.js";
import { readSession, writeSession } from "../src/session/state.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { mergeUiPrefs } from "../src/config/ui-prefs.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

describe("Claude Code adapter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function project(): { root: string; workspace: Workspace } {
    const root = makeTmpDir("claude-adapter");
    dirs.push(root);
    makeGitRepo(root);
    const state = isolateStateDir();
    dirs.push(state);
    const workspace = new Workspace(root);
    writeSession(workspace.id, {
      conversationMode: "long-chat",
      url: "https://chatgpt.com/c/verified-chat",
      connectorName: `Codex 2 ChatGPT · ${workspace.name}`,
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: "https://c2c-project.example.com",
      mcpUrl: "https://c2c-project.example.com/mcp",
      connectorName: `Codex 2 ChatGPT · ${workspace.name}`,
    });
    return { root, workspace };
  }

  it("installs project-local rules and an auto-invoked skill without touching CLAUDE.md", () => {
    const { root } = project();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "keep me\n");
    const first = installClaudeAdapter(root);
    expect(first.created).toEqual([CLAUDE_RULE_PATH, CLAUDE_SKILL_PATH, CLAUDE_SETTINGS_PATH]);
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(path.join(root, CLAUDE_SKILL_PATH), "utf8")).toContain("Claude_Browser");
    expect(fs.readFileSync(path.join(root, CLAUDE_SKILL_PATH), "utf8")).toContain("never save, crop, rename, or import a screenshot");
    expect(fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), "utf8")).toContain("claude prompt-hook");
    expect(fs.readFileSync(path.join(root, CLAUDE_SETTINGS_PATH), "utf8")).toContain(`--workspace-root '${root}'`);
    expect(claudeAdapterInstalled(root)).toBe(true);
    expect(installClaudeAdapter(root).unchanged).toEqual([CLAUDE_RULE_PATH, CLAUDE_SKILL_PATH, CLAUDE_SETTINGS_PATH]);
  });

  it("preserves existing Claude settings while installing deterministic hooks", () => {
    const { root } = project();
    const settingsPath = path.join(root, CLAUDE_SETTINGS_PATH);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(pnpm test *)"] }, enabledMcpjsonServers: ["portbay"] }));
    installClaudeAdapter(root, 'node "/opt/c2c/bin/c2c.js"');
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(pnpm test *)"]);
    expect(settings.enabledMcpjsonServers).toEqual(["portbay"]);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("claude prompt-hook");
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Bash|Edit|Write|NotebookEdit");
    expect(settings.hooks.PostToolUse[0].matcher).toBe("Bash");
    installClaudeAdapter(root, 'node "/opt/c2c/bin/c2c.js"');
    expect(settings.hooks?.UserPromptSubmit?.length ?? 1).toBe(1);
    const reread = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(reread.hooks.UserPromptSubmit).toHaveLength(1);
    expect(reread.hooks.PreToolUse).toHaveLength(1);
    expect(reread.hooks.PostToolUse).toHaveLength(1);
  });

  it("installs idempotent global fallback hooks without replacing existing Claude hooks", () => {
    const root = makeTmpDir("claude-global-adapter");
    dirs.push(root);
    const settingsPath = path.join(root, "settings.json");
    const existing = {
      permissions: { allow: ["Bash(pnpm test *)"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/existing-context-hook" }] }],
      },
    };
    fs.writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);

    const first = installClaudeGlobalAdapter(settingsPath, 'node "/opt/c2c/bin/c2c.js"');
    expect(first).toMatchObject({ created: false, updated: true, unchanged: false });
    const installed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(installed.permissions).toEqual(existing.permissions);
    expect(installed.hooks.UserPromptSubmit[0]).toEqual(existing.hooks.UserPromptSubmit[0]);
    expect(installed.hooks.UserPromptSubmit[1].hooks[0].command).toContain("claude prompt-hook --global-fallback");
    expect(installed.hooks.PreToolUse.at(-1).hooks[0].command).toContain("claude guard-hook --global-fallback");
    expect(installed.hooks.PostToolUse.at(-1).hooks[0].command).toContain("claude post-hook --global-fallback");

    const second = installClaudeGlobalAdapter(settingsPath, 'node "/opt/c2c/bin/c2c.js"');
    expect(second).toMatchObject({ created: false, updated: false, unchanged: true });
    const reread = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(reread.hooks.UserPromptSubmit.filter((group: any) =>
      group.hooks?.some((hook: any) => hook.command?.includes("claude prompt-hook"))
    )).toHaveLength(1);
  });

  it("starts C2C from the prompt hook and blocks implementation until PLAN", () => {
    const { root } = project();
    expect(isClaudeC2CTask("Please design the architecture and implement it")).toBe(true);
    expect(isClaudeC2CTask("Make the button blue and generate a PNG")).toBe(true);
    expect(isClaudeC2CTask("yes")).toBe(false);
    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: "Please design the architecture and implement it",
      command: 'node "/opt/c2c/bin/c2c.js"',
    });
    const context = hook.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("MANDATORY C2C PLAN GATE");
    expect(context).toContain("Claude_Browser");
    expect(context).toContain("shift+Enter");
    expect(context).toContain("non-interactive OAuth");
    expect(context).toContain("NEVER click or focus the composer by screen coordinates");
    expect(context).toContain('"typed N chars" result as untrusted');

    const blocked = claudeGuardHook({ workspaceRoot: root, toolName: "Edit", toolInput: {} });
    expect(blocked.hookSpecificOutput?.permissionDecision).toBe("deny");
    const allowedC2C = claudeGuardHook({
      workspaceRoot: root,
      toolName: "Bash",
      toolInput: { command: 'node "/opt/c2c/bin/c2c.js" claude plan -w . --task c2c_test --iteration 0' },
    });
    expect(allowedC2C).toEqual({});

    markClaudePlan({ workspaceRoot: root, taskId: context.match(/c2c_[a-f0-9]+/)?.[0] ?? "missing", iteration: 0 });
    const continuation = claudePromptHook({
      workspaceRoot: root,
      prompt: "Continue implementing the plan",
      command: 'node "/opt/c2c/bin/c2c.js"',
    });
    expect(continuation.hookSpecificOutput?.additionalContext).toContain("C2C EXECUTION GATE");
    expect(continuation.hookSpecificOutput?.additionalContext).not.toContain("Use a browser NOW");
  });

  it("ignores Claude background notifications without creating or gating a task", () => {
    const { root } = project();
    const notification = `<task-notification>
<task-id>bfvg039sk</task-id>
<status>completed</status>
<summary>Background command "Re-run tests after the fix" completed</summary>
</task-notification>`;
    expect(isClaudeInternalNotification(notification)).toBe(true);
    expect(isClaudeC2CTask(notification)).toBe(false);
    expect(isClaudeC2CTask(`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${notification}`)).toBe(false);

    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: notification,
      command: 'node "/opt/c2c/bin/c2c.js"',
      agentSessionId: "notification-session",
    });
    expect(hook).toEqual({});
    expect(readClaudeCheckpoint(root, "notification-session")).toBeNull();
  });

  it("treats a linked worktree as an execution lane for the connected project", () => {
    const { root, workspace } = project();
    const lane = path.join(root, ".portbay", "worktrees", "integrate-verify");
    git(root, "worktree", "add", "-b", "test/integrate-verify", lane);

    expect(resolveClaudeWorkspaceRoot(lane)).toBe(root);
    const hook = claudePromptHook({
      workspaceRoot: lane,
      prompt: "Review and implement the accepted architecture plan",
      command: 'node "/opt/c2c/bin/c2c.js"',
    });
    const context = hook.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("MANDATORY C2C PLAN GATE");
    expect(context).toContain(`Canonical workspace: ${JSON.stringify(root)}`);
    expect(context).toContain(`workspace_info returns "${workspace.name}"`);
    expect(context).not.toContain('workspace_info returns "integrate-verify"');
    expect(context).not.toContain("C2C SETUP GATE");
  });

  it("maps an unconnected worktree to its canonical repository before first-time setup", () => {
    const root = makeTmpDir("claude-unconnected-worktree");
    dirs.push(root);
    makeGitRepo(root);
    const state = isolateStateDir();
    dirs.push(state);
    const lane = path.join(root, "worktrees", "first-setup");
    git(root, "worktree", "add", "-b", "test/first-setup", lane);

    expect(resolveClaudeWorkspaceRoot(lane)).toBe(root);
  });

  it("isolates concurrent Claude chat checkpoints while sharing one connector", () => {
    const { root, workspace } = project();
    const command = 'node "/opt/c2c/bin/c2c.js"';
    const first = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement the first feature",
      command,
      agentSessionId: "claude-chat-a",
    });
    const second = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement the second feature",
      command,
      agentSessionId: "claude-chat-b",
    });
    const firstContext = first.hookSpecificOutput?.additionalContext ?? "";
    const secondContext = second.hookSpecificOutput?.additionalContext ?? "";
    const firstTask = firstContext.match(/c2c_[a-f0-9]+/)?.[0] ?? "";
    const secondTask = secondContext.match(/c2c_[a-f0-9]+/)?.[0] ?? "";

    expect(firstTask).not.toBe("");
    expect(secondTask).not.toBe("");
    expect(firstTask).not.toBe(secondTask);
    expect(firstContext).toContain('--agent-session "claude-chat-a"');
    expect(secondContext).toContain('--agent-session "claude-chat-b"');
    expect(readSession(workspace.id)?.checkpoint).toBeUndefined();

    markClaudePlan({
      workspaceRoot: root,
      taskId: firstTask,
      iteration: 0,
      agentSessionId: "claude-chat-a",
    });
    expect(claudeGuardHook({
      workspaceRoot: root,
      toolName: "Edit",
      toolInput: {},
      agentSessionId: "claude-chat-a",
    })).toEqual({});
    expect(claudeGuardHook({
      workspaceRoot: root,
      toolName: "Edit",
      toolInput: {},
      agentSessionId: "claude-chat-b",
    }).hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("does not claim a legacy workspace checkpoint for a new Claude session", () => {
    const { root } = project();
    const legacy = startClaudeTask({ workspaceRoot: root, goal: "Old unfinished task", taskId: "c2c_legacy" });
    expect(legacy.taskId).toBe("c2c_legacy");

    const fresh = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement a separate new feature",
      command: 'node "/opt/c2c/bin/c2c.js"',
      agentSessionId: "brand-new-claude-session",
    });
    const context = fresh.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("MANDATORY C2C PLAN GATE");
    expect(context).not.toContain("MANDATORY C2C RESUME GATE");
    expect(context).not.toContain("c2c_legacy");
    expect(readClaudeCheckpoint(root, "brand-new-claude-session")?.taskId).not.toBe("c2c_legacy");
  });

  it("uses the shared external browser preference without copying cookies", () => {
    const { root } = project();
    mergeUiPrefs({ browserMode: "shared" });
    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement dark mode",
      command: 'node "/opt/c2c/bin/c2c.js"',
      agentSessionId: "shared-browser-session",
    });
    const context = hook.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("shared external browser profile first");
    expect(context).toContain("claude-in-chrome");
    expect(context).toContain("without reading or copying cookies");
  });

  it("creates compact INIT, EXECUTED, and HANDOFF messages while checkpointing the session", () => {
    const { root, workspace } = project();
    const init = startClaudeTask({ workspaceRoot: root, goal: "Implement dark mode", taskId: "c2c_test01" });
    expect(init.chatUrl).toBe("https://chatgpt.com/c/verified-chat");
    expect(init.message).toContain("STATE: INIT");
    expect(init.message).toContain("ROLE_AND_QUALITY_BAR");
    expect(init.message).toContain("critical principal-level");
    expect(init.message).toContain("Do not rubber-stamp");
    expect(init.message).toContain("observable success criteria");
    expect(init.message).toContain(`workspace_info returns "${workspace.name}"`);

    const plan = markClaudePlan({
      workspaceRoot: root,
      taskId: init.taskId,
      iteration: 1,
      nextStep: "Implement the accepted plan",
    });
    expect(plan.iteration).toBe(1);

    const executed = markClaudeExecuted({
      workspaceRoot: root,
      taskId: init.taskId,
      iteration: 1,
      changedFiles: "src/theme.ts,tests/theme.test.ts",
      tests: "12 passed",
      exitStatus: "ok",
    });
    expect(executed.message).toContain("STATE: EXECUTED");
    expect(executed.message).toContain("12 passed");
    expect(executed.message).toContain("Return DONE only when");
    expect(executed.message).not.toContain("diff --git");

    const reviewGuard = claudeGuardHook({ workspaceRoot: root, toolName: "Edit", toolInput: {} });
    expect(reviewGuard.hookSpecificOutput?.permissionDecisionReason).toContain("review response (PLAN, DONE, or BLOCKED)");
    expect(reviewGuard.hookSpecificOutput?.permissionDecisionReason).not.toContain("PLAN before implementation");

    const reviewHook = claudePostToolHook({ workspaceRoot: root });
    expect(reviewHook.hookSpecificOutput?.additionalContext).toContain("MANDATORY C2C REVIEW GATE");
    expect(reviewHook.hookSpecificOutput?.additionalContext).toContain("Claude_Browser");
    expect(reviewHook.hookSpecificOutput?.additionalContext).toContain("STATE: EXECUTED");

    const handoff = claudeHandoff(root);
    expect(handoff.message).toContain("STATE: HANDOFF");
    expect(handoff.message).toContain("EXECUTED_SENT");
    expect(finishClaudeTask(root).checkpoint).toBeUndefined();
  });

  it("keeps the maximum complex-task INIT within the documented browser budget", () => {
    const { root } = project();
    const init = startClaudeTask({ workspaceRoot: root, goal: "x".repeat(2000), taskId: "c2c_budget" });
    expect(Buffer.byteLength(init.message, "utf8")).toBeLessThanOrEqual(3 * 1024);
    expect(init.message).toContain(`${"x".repeat(1499)}…`);
  });

  it("preserves a complex goal up to the 1500-character task budget", () => {
    const { root } = project();
    const goal = `Architecture brief: ${"important constraint ".repeat(50)}`;
    expect(goal.length).toBeGreaterThan(500);
    expect(goal.length).toBeLessThan(1500);
    const init = startClaudeTask({ workspaceRoot: root, goal, taskId: "c2c_complex" });
    expect(init.message).toContain(goal.trim());
  });

  it("refuses orchestration without a workspace-specific saved chat", () => {
    const root = makeTmpDir("claude-no-session");
    dirs.push(root);
    makeGitRepo(root);
    const state = isolateStateDir();
    dirs.push(state);
    expect(() => startClaudeTask({ workspaceRoot: root, goal: "task" })).toThrow(/verified saved C2C chat/);
  });

  it("gives an unconnected project a complete automatic bootstrap handoff", () => {
    const root = makeTmpDir("claude-global-setup");
    dirs.push(root);
    makeGitRepo(root);
    const state = isolateStateDir();
    dirs.push(state);

    const hook = claudePromptHook({
      workspaceRoot: root,
      prompt: "Implement a production feature",
      command: 'node "/opt/c2c/bin/c2c.js"',
      agentSessionId: "new-project",
    });
    const context = hook.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("MANDATORY C2C SETUP GATE");
    expect(context).toContain("claude bootstrap");
    expect(context).toContain("createConnectorUrl");
    expect(context).toContain("workspace_info");
    expect(context).toContain("long-chat mode");
    expect(context).toContain("Do not stop merely because setup includes browser authorization");
  });

  it("launches Claude in the exact workspace with official Chrome integration", () => {
    const { root } = project();
    installClaudeAdapter(root);
    const runner = vi.fn(() => ({ status: 0, signal: null, output: [], pid: 1, stdout: null, stderr: null })) as any;
    launchClaudeCode(root, ["test prompt"], runner);
    expect(runner).toHaveBeenCalledWith(
      "claude",
      ["--chrome", "test prompt"],
      expect.objectContaining({ cwd: root, stdio: "inherit", windowsHide: true })
    );
  });
});
