import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  DEFAULT_EXECUTOR,
  getStoredExecutor,
  setStoredExecutor,
  resolveExecutorName,
  getExecutorConfigFile,
  buildExecutionPrompt,
  getExecutor,
  detectBinary,
  executePlan,
  isSupportedExecutor,
  AgyExecutor,
  CodexExecutor,
  parseAgyStreamJson,
  type ProcessRunner,
} from "../src/executor/index.js";
import { makeGitRepo, makeTmpDir, write, git } from "./helpers.js";

describe("Executor abstraction and configuration", () => {
  let tmpStateDir: string;
  const originalEnv = process.env.C2C_STATE_DIR;

  beforeEach(() => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-executor-test-"));
    process.env.C2C_STATE_DIR = tmpStateDir;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.C2C_STATE_DIR = originalEnv;
    } else {
      delete process.env.C2C_STATE_DIR;
    }
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  });

  it("defaults to 'agy' when no local config exists", () => {
    expect(DEFAULT_EXECUTOR).toBe("agy");
    expect(getStoredExecutor()).toBeNull();
    expect(resolveExecutorName()).toBe("agy");
    expect(resolveExecutorName(undefined)).toBe("agy");
  });

  it("persists executor choice to local state directory", () => {
    expect(getStoredExecutor()).toBeNull();

    const saved = setStoredExecutor("codex");
    expect(saved).toBe("codex");
    expect(getStoredExecutor()).toBe("codex");
    expect(resolveExecutorName()).toBe("codex");

    const configFile = getExecutorConfigFile();
    expect(fs.existsSync(configFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(content.executor).toBe("codex");

    // Switch back to agy
    setStoredExecutor("agy");
    expect(getStoredExecutor()).toBe("agy");
    expect(resolveExecutorName()).toBe("agy");
  });

  it("respects resolution precedence: CLI override > local config > default agy", () => {
    // 1. No config -> default agy
    expect(resolveExecutorName()).toBe("agy");

    // 2. CLI override without config -> override
    expect(resolveExecutorName("codex")).toBe("codex");

    // 3. Stored config -> stored config
    setStoredExecutor("codex");
    expect(resolveExecutorName()).toBe("codex");

    // 4. CLI override beats stored config
    expect(resolveExecutorName("agy")).toBe("agy");
  });

  it("rejects invalid executor names", () => {
    expect(isSupportedExecutor("agy")).toBe(true);
    expect(isSupportedExecutor("codex")).toBe(true);
    expect(isSupportedExecutor("invalid_executor")).toBe(false);

    expect(() => setStoredExecutor("invalid_executor")).toThrow(/Invalid executor/);
    expect(() => resolveExecutorName("invalid_executor")).toThrow(/Invalid executor override/);
  });

  it("constructs standard execution prompts with plan and task metadata", () => {
    const prompt1 = buildExecutionPrompt("Fix bug #123");
    expect(prompt1).toContain("You are the execution agent.");
    expect(prompt1).toContain("Fix bug #123");

    const prompt2 = buildExecutionPrompt("Implement feature ABC", {
      taskId: "task_456",
      iteration: 2,
    });
    expect(prompt2).toContain("Task: task_456 (Iteration 2)");
    expect(prompt2).toContain("Implement feature ABC");
  });

  it("returns appropriate adapters", () => {
    const agy = getExecutor("agy");
    expect(agy.name).toBe("agy");

    const codex = getExecutor("codex");
    expect(codex.name).toBe("codex");

    expect(() => getExecutor("unknown" as any)).toThrow(/Unsupported executor/);
  });

  it("detects missing binaries and does not silently fallback", () => {
    const missing = detectBinary("non_existent_binary_xyz_12345");
    expect(missing.available).toBe(false);
    expect(missing.error).toBeTruthy();
  });
});

describe("Agy & Codex runner contracts and permission soft-denial detection", () => {
  it("detects permission soft-denials in structured events without false positives on model prose", () => {
    // 1. Official schema: Model prose mentioning permission denied in conversation MUST NOT trigger soft denial
    const proseOutput = [
      JSON.stringify({ event: "init", init: { cwd: "/repo" } }),
      JSON.stringify({ event: "step_update", step_update: { state: "DONE", step_type: "agent_response", text_delta: "I fixed the permission denied handling bug." } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "I fixed the permission denied handling bug." } }),
    ].join("\n");
    const proseParsed = parseAgyStreamJson(proseOutput, "", 0);
    expect(proseParsed.ok).toBe(true);
    expect(proseParsed.status).toBe("SUCCESS");
    expect(proseParsed.blockedReason).toBeUndefined();

    // 2. Official schema: Real structured tool failure with permission error
    const toolDeniedOutput = [
      JSON.stringify({ event: "init", init: { cwd: "/repo" } }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { error: { type: "PermissionDenied", message: "permission denied for command: npm test" } },
        },
      }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }),
    ].join("\n");
    const toolParsed = parseAgyStreamJson(toolDeniedOutput, "", 0);
    expect(toolParsed.ok).toBe(false);
    expect(toolParsed.blockedReason).toBe("PERMISSION_DENIED");
    expect(toolParsed.error).toContain("AGENT_PERMISSION_BLOCKED");

    // 3. Stderr CLI diagnostic with permission rejection
    const diagParsed = parseAgyStreamJson(
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }),
      "[diagnostic] Command 'npm test' permission denied by policy",
      0
    );
    expect(diagParsed.ok).toBe(false);
    expect(diagParsed.blockedReason).toBe("PERMISSION_DENIED");

    // 4. Protocol truncation: Missing terminal result event must be flagged as AGY_PROTOCOL_ERROR
    const truncatedOutput = [
      JSON.stringify({ event: "init", init: { cwd: "/repo" } }),
      JSON.stringify({ event: "step_update", step_update: { state: "DONE", step_type: "agent_response", text_delta: "working" } }),
    ].join("\n");
    const truncatedParsed = parseAgyStreamJson(truncatedOutput, "", 0);
    expect(truncatedParsed.ok).toBe(false);
    expect(truncatedParsed.blockedReason).toBe("ERROR");
    expect(truncatedParsed.error).toContain("AGY_PROTOCOL_ERROR");
  });

  it("AgyExecutor streams prompt via stream-json NDJSON and parses official success/failure", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedStdin = "";
    let capturedCwd = "";

    const mockRunner: ProcessRunner = async (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedStdin = opts.stdinData || "";
      capturedCwd = opts.cwd;
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ event: "init", init: { cwd: "/repo" } }),
          JSON.stringify({ event: "step_update", step_update: { state: "DONE", step_type: "agent_response", text_delta: "Working on plan..." } }),
          JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Done!" } }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
      };
    };

    const agy = new AgyExecutor();
    const result = await agy.execute(
      {
        workspace: "/test/workspace",
        prompt: 'Complex plan with "quotes" and \n```code blocks```\nUnicode: 🚀',
      },
      mockRunner
    );

    expect(capturedCmd).toBe("agy");
    expect(capturedArgs).toEqual(["--mode=accept-edits", "--input-format", "stream-json", "--output-format", "stream-json"]);
    const parsedStdin = JSON.parse(capturedStdin.trim());
    expect(parsedStdin.event).toBe("user");
    expect(parsedStdin.message.content).toBe('Complex plan with "quotes" and \n```code blocks```\nUnicode: 🚀');
    expect(capturedCwd).toBe("/test/workspace");
    expect(result.ok).toBe(true);
    expect(result.executor).toBe("agy");
  });

  it("AgyExecutor flags permission soft-denial from structured events even when exitCode is 0", async () => {
    const mockRunner: ProcessRunner = async () => ({
      exitCode: 0,
      stdout: [
        JSON.stringify({
          event: "step_update",
          step_update: {
            state: "DONE",
            step_type: "tool",
            tool_name: "shell",
            tool_info: { error: { type: "PermissionError", message: "tool execution permission denied" } },
          },
        }),
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }),
      ].join("\n"),
      stderr: "Warning: tools were denied due to missing permission",
      timedOut: false,
    });

    const agy = new AgyExecutor();
    const result = await agy.execute(
      { workspace: "/test", prompt: "Test plan" },
      mockRunner
    );

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("PERMISSION_DENIED");
    expect(result.error).toContain("AGENT_PERMISSION_BLOCKED");
  });

  it("CodexExecutor streams prompt via stdin with codex exec -", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedStdin = "";

    const mockRunner: ProcessRunner = async (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedStdin = opts.stdinData || "";
      return {
        exitCode: 0,
        stdout: "Codex finished",
        stderr: "",
        timedOut: false,
      };
    };

    const codex = new CodexExecutor();
    const result = await codex.execute(
      { workspace: "/test/codex", prompt: "Codex task" },
      mockRunner
    );

    expect(capturedCmd).toBe("codex");
    expect(capturedArgs).toEqual(["exec", "-"]);
    expect(capturedStdin).toBe("Codex task");
    expect(result.ok).toBe(true);
  });
});

describe("Changed files delta tracking", () => {
  it("only reports files modified in this iteration, ignoring pre-existing dirty files", async () => {
    const testWs = makeTmpDir("executor-delta-test");
    makeGitRepo(testWs);

    // 1. Create a pre-existing dirty file A before executor runs
    write(testWs, "src/pre-existing.ts", "const a = 1; // pre-existing dirty\n");
    git(testWs, "add", "src/pre-existing.ts");

    // 2. Mock executor that only creates B and leaves A untouched
    const mockRunner: ProcessRunner = async (_, __, opts) => {
      write(opts.cwd, "src/new-feature.ts", "export const b = 2;\n");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
        stderr: "",
        timedOut: false,
      };
    };

    const execResult = await executePlan({
      workspace: testWs,
      plan: "Add new feature",
      executorName: "agy",
      runner: mockRunner,
    });

    expect(execResult.result.ok).toBe(true);
    // Crucial check: only src/new-feature.ts is in changedFiles, NOT src/pre-existing.ts
    expect(execResult.changedFiles).toContain("src/new-feature.ts");
    expect(execResult.changedFiles).not.toContain("src/pre-existing.ts");
  });

  it("includes pre-existing dirty files when the executor actually modifies them", async () => {
    const testWs = makeTmpDir("executor-delta-test2");
    makeGitRepo(testWs);

    // 1. Create a pre-existing dirty file A
    write(testWs, "src/pre-existing.ts", "const a = 1; // pre-existing dirty\n");
    git(testWs, "add", "src/pre-existing.ts");

    // 2. Mock executor that modifies BOTH A and creates B
    const mockRunner: ProcessRunner = async (_, __, opts) => {
      write(opts.cwd, "src/pre-existing.ts", "const a = 999; // modified by agy\n");
      write(opts.cwd, "src/new-feature.ts", "export const b = 2;\n");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
        stderr: "",
        timedOut: false,
      };
    };

    const execResult = await executePlan({
      workspace: testWs,
      plan: "Update A and add B",
      executorName: "agy",
      runner: mockRunner,
    });

    expect(execResult.result.ok).toBe(true);
    expect(execResult.changedFiles).toContain("src/pre-existing.ts");
    expect(execResult.changedFiles).toContain("src/new-feature.ts");
  });
});

describe("CLI exec integration and exit code contracts", () => {
  it("executePlan returns correct blockedReason when permission blocked", async () => {
    const testWs = makeTmpDir("cli-test-1");
    makeGitRepo(testWs);

    const mockRunner: ProcessRunner = async () => ({
      exitCode: 0,
      stdout: [
        JSON.stringify({
          event: "step_update",
          step_update: {
            state: "DONE",
            step_type: "tool",
            tool_name: "run_command",
            tool_info: { error: { type: "PermissionDenied", message: "permission denied for command: npm test" } },
          },
        }),
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done" } }),
      ].join("\n"),
      stderr: "tools denied",
      timedOut: false,
    });

    const execResult = await executePlan({
      workspace: testWs,
      plan: "Run tests",
      executorName: "agy",
      runner: mockRunner,
    });

    expect(execResult.result.ok).toBe(false);
    expect(execResult.result.blockedReason).toBe("PERMISSION_DENIED");
    const exitStatus =
      execResult.result.blockedReason === "PERMISSION_DENIED"
        ? "blocked"
        : execResult.result.ok
          ? "ok"
          : "failed";
    expect(exitStatus).toBe("blocked");
  });

  it("executePlan returns failed exitStatus on execution error or timeout", async () => {
    const testWs = makeTmpDir("cli-test-2");
    makeGitRepo(testWs);

    const mockRunner: ProcessRunner = async () => ({
      exitCode: 1,
      stdout: [
        JSON.stringify({ event: "result", result: { status: "ERROR", error: "Fatal execution crash" } }),
      ].join("\n"),
      stderr: "Fatal error",
      timedOut: false,
    });

    const execResult = await executePlan({
      workspace: testWs,
      plan: "Crash test",
      executorName: "agy",
      runner: mockRunner,
    });

    expect(execResult.result.ok).toBe(false);
    expect(execResult.result.blockedReason).toBe("ERROR");
  });

  it("detects real AGY stderr permission notices without prefixes", () => {
    const stderrNotice = 'Tool "run_command" requires approval. Add "command(npm test)" to permissions.allow to allow it.';
    const parsed = parseAgyStreamJson(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "I could not run the tests because approval was needed." },
      }),
      stderrNotice,
      0
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.blockedReason).toBe("PERMISSION_DENIED");
    expect(parsed.error).toContain("AGENT_PERMISSION_BLOCKED");
  });

  it("spawned c2c exec CLI exits non-zero on error or missing binary", () => {
    const binPath = path.resolve(__dirname, "../bin/c2c.js");
    const testWs = makeTmpDir("spawned-cli-test");
    makeGitRepo(testWs);

    // Call CLI with invalid executor to verify non-zero process exit code
    const res = spawnSync(
      process.execPath,
      [binPath, "exec", "-w", testWs, "--executor", "invalid_exec_xyz", "--plan", "test", "--json"],
      { encoding: "utf8" }
    );

    expect(res.status).not.toBe(0);
    const parsedJson = JSON.parse(res.stdout || res.stderr);
    expect(parsedJson.ok).toBe(false);
  });
});


