import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { isExecutionRelayEnabled, setExecutionRelayEnabled } from "../src/execution/relay-config.js";
import { extractTestSummary } from "../src/execution/task-manager.js";
import type { ProcessRunner } from "../src/executor/types.js";
import { makeTmpDir, cleanup, write, makeGitRepo, isolateStateDir } from "./helpers.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
let mockRunnerOverride: ProcessRunner | undefined;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

const dispatchingRunner: ProcessRunner = async (cmd, args, opts) => {
  if (mockRunnerOverride) {
    return mockRunnerOverride(cmd, args, opts);
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    stderr: "",
    timedOut: false,
  };
};

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("relay-test-ws");
  makeGitRepo(root);
  write(root, "src/index.ts", "export const v = 1;\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
    executionRunner: dispatchingRunner,
  });

  const tokens = bridge.authStore.issueTokens({
    clientId: "relay-test-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "relay-test-mcp", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
});

beforeEach(() => {
  setExecutionRelayEnabled(false);
  mockRunnerOverride = undefined;
});

describe("Execution Relay Configuration and MCP Control Tools", () => {
  it("defaults to disabled and can be toggled", () => {
    expect(isExecutionRelayEnabled()).toBe(false);
    setExecutionRelayEnabled(true);
    expect(isExecutionRelayEnabled()).toBe(true);
    setExecutionRelayEnabled(false);
    expect(isExecutionRelayEnabled()).toBe(false);
  });

  it("rejects execution_submit with EXECUTION_RELAY_DISABLED when relay is disabled", async () => {
    const res = await client.callTool({
      name: "execution_submit",
      arguments: {
        task_id: "task_disabled",
        iteration: 1,
        plan: "Do something",
      },
    });

    expect(res.isError).toBe(true);
    const parsed = jsonOf<{ error: string; message: string }>(res);
    expect(parsed.error).toBe("EXECUTION_RELAY_DISABLED");
  });

  it("pure MCP E2E: accepts execution_submit, executes via injected runner, reports status and git_diff", async () => {
    setExecutionRelayEnabled(true);

    mockRunnerOverride = async (_, __, opts) => {
      write(opts.cwd, "src/index.ts", "export const v = 999; // updated via true MCP\n");
      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ event: "init", init: { cwd: opts.cwd } }),
          JSON.stringify({
            event: "result",
            result: {
              status: "SUCCESS",
              response: "Updated src/index.ts\n Test Files  12 passed (12)\n      Tests  123 passed (123)",
            },
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
      };
    };

    // 1. Submit via MCP tool directly
    const submitRes = await client.callTool({
      name: "execution_submit",
      arguments: {
        task_id: "task_pure_e2e",
        iteration: 1,
        plan: "Update src/index.ts via MCP",
      },
    });

    expect(submitRes.isError).toBeFalsy();
    const submitData = jsonOf<{ accepted: boolean; runId: string; status: string }>(submitRes);
    expect(submitData.accepted).toBe(true);
    expect(submitData.status).toBe("running");
    const runId = submitData.runId;

    // 2. Poll status via MCP tool execution_status with bounded wait
    const statusRes = await client.callTool({
      name: "execution_status",
      arguments: {
        run_id: runId,
        wait_ms: 5000,
      },
    });

    expect(statusRes.isError).toBeFalsy();
    const statusData = jsonOf<{ status: string; changedFiles: string[]; tests: string }>(statusRes);
    expect(statusData.status).toBe("succeeded");
    expect(statusData.changedFiles).toContain("src/index.ts");
    expect(statusData.tests).toBe("123 passed");
    expect(statusData.tests).not.toBe("12 passed");

    // 3. Verify git_diff sees the change over MCP
    const diffRes = await client.callTool({ name: "git_diff", arguments: {} });
    expect(diffRes.isError).toBeFalsy();
    expect(textOf(diffRes)).toContain("updated via true MCP");

    // 4. Verify execution_summary sees the record over MCP
    const summaryRes = await client.callTool({ name: "execution_summary", arguments: {} });
    expect(summaryRes.isError).toBeFalsy();
    const summaryData = jsonOf<{ records: { taskId: string; exitStatus: string }[] }>(summaryRes);
    expect(summaryData.records.some((r) => r.taskId === "task_pure_e2e" && r.exitStatus === "ok")).toBe(true);
  });

  it("extracts test count from live AGY natural language summary with test files and tests passed", async () => {
    setExecutionRelayEnabled(true);

    mockRunnerOverride = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Execution finished: 12 test files passed; 123 tests passed",
        },
      }),
      stderr: "",
      timedOut: false,
    });

    const submitRes = await client.callTool({
      name: "execution_submit",
      arguments: { task_id: "task_live_agy", iteration: 1, plan: "Live AGY plan" },
    });
    const runId = jsonOf<{ runId: string }>(submitRes).runId;

    const statusRes = await client.callTool({
      name: "execution_status",
      arguments: { run_id: runId, wait_ms: 2000 },
    });
    const statusData = jsonOf<{ status: string; tests: string }>(statusRes);
    expect(statusData.status).toBe("succeeded");
    expect(statusData.tests).toBe("123 passed");
    expect(statusData.tests).not.toBe("12 passed");
  });

  it("extracts generic test summary when no explicit Tests line exists", async () => {
    setExecutionRelayEnabled(true);

    mockRunnerOverride = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "Done\n123 passed" },
      }),
      stderr: "",
      timedOut: false,
    });

    const submitRes = await client.callTool({
      name: "execution_submit",
      arguments: { task_id: "task_fallback", iteration: 1, plan: "Fallback plan" },
    });
    const runId = jsonOf<{ runId: string }>(submitRes).runId;

    const statusRes = await client.callTool({
      name: "execution_status",
      arguments: { run_id: runId, wait_ms: 2000 },
    });
    const statusData = jsonOf<{ status: string; tests: string }>(statusRes);
    expect(statusData.status).toBe("succeeded");
    expect(statusData.tests).toBe("123 passed");
  });

  it("extracts largest test count from multiple generic passed matches fallback", async () => {
    setExecutionRelayEnabled(true);

    mockRunnerOverride = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "Summary: 12 passed (files), 123 passed" },
      }),
      stderr: "",
      timedOut: false,
    });

    const submitRes = await client.callTool({
      name: "execution_submit",
      arguments: { task_id: "task_generic_multi", iteration: 1, plan: "Multi generic plan" },
    });
    const runId = jsonOf<{ runId: string }>(submitRes).runId;

    const statusRes = await client.callTool({
      name: "execution_status",
      arguments: { run_id: runId, wait_ms: 2000 },
    });
    const statusData = jsonOf<{ status: string; tests: string }>(statusRes);
    expect(statusData.status).toBe("succeeded");
    expect(statusData.tests).toBe("123 passed");
  });

  it("extractTestSummary unit checks for various test runner summary patterns", () => {
    // Vitest formats
    expect(extractTestSummary("Test Files  12 passed (12)\n      Tests  123 passed (123)")).toBe("123 passed");
    expect(extractTestSummary("Test Files  1 failed | 11 passed (12)\n      Tests  2 failed | 123 passed (125)")).toBe("123 passed, 2 failed");
    expect(extractTestSummary("Test Files  1 failed | 11 passed (12)\n      Tests  123 passed | 2 failed (125)")).toBe("123 passed, 2 failed");

    // Jest formats
    expect(extractTestSummary("Test Suites: 1 failed, 11 passed, 12 total\nTests:       2 failed, 123 passed, 125 total")).toBe("123 passed, 2 failed");
    expect(extractTestSummary("Test Suites: 12 passed, 12 total\nTests:       123 passed, 123 total")).toBe("123 passed");

    // Natural-language formats
    expect(extractTestSummary("12 test files passed; 123 tests passed")).toBe("123 passed");
    expect(extractTestSummary("12 test files passed, 123 tests passed, 2 failed")).toBe("123 passed, 2 failed");
    expect(extractTestSummary("12 test files passed; 123 tests passed; 2 tests failed")).toBe("123 passed, 2 failed");
    expect(extractTestSummary("2 tests failed, 123 tests passed")).toBe("123 passed, 2 failed");
    expect(extractTestSummary("1 test passed")).toBe("1 passed");

    // Generic and multi-match fallbacks
    expect(extractTestSummary("12 passed, 123 passed")).toBe("123 passed");
    expect(extractTestSummary("123 passed, 1 failed")).toBe("123 passed, 1 failed");
    expect(extractTestSummary("2 failed, 123 passed")).toBe("123 passed, 2 failed");
    expect(extractTestSummary("123 passed")).toBe("123 passed");
    expect(extractTestSummary("=== 123 passed, 2 failed in 2.34s ===")).toBe("123 passed, 2 failed");

    // Only failure or null/empty
    expect(extractTestSummary("Tests: 5 failed")).toBe("5 failed");
    expect(extractTestSummary("5 failed")).toBe("5 failed");
    expect(extractTestSummary("No tests executed")).toBeNull();
    expect(extractTestSummary(undefined)).toBeNull();
    expect(extractTestSummary("")).toBeNull();
  });

  it("cancel regression: keeps lock held until child process actually exits, rejecting concurrent submit with EXECUTION_BUSY", async () => {
    setExecutionRelayEnabled(true);

    let abortReceived = false;
    let runnerFinished = false;

    mockRunnerOverride = async (_, __, opts) => {
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          abortReceived = true;
        });
      }
      // Wait for abort, then delay 300ms before finally resolving
      while (!opts.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 300));
      runnerFinished = true;
      return {
        exitCode: null,
        stdout: "",
        stderr: "Aborted",
        timedOut: false,
        error: "ABORTED",
      };
    };

    // 1. Submit Task A
    const submitARes = await client.callTool({
      name: "execution_submit",
      arguments: { task_id: "task_A", iteration: 1, plan: "Task A" },
    });
    const runAId = jsonOf<{ runId: string }>(submitARes).runId;

    // 2. Request cancel on Task A
    const cancelRes = await client.callTool({
      name: "execution_cancel",
      arguments: { run_id: runAId },
    });
    expect(jsonOf<{ cancelled: boolean }>(cancelRes).cancelled).toBe(true);
    expect(abortReceived).toBe(true);
    expect(runnerFinished).toBe(false);

    // 3. Immediately submit Task B while Task A child is still in grace period -> MUST return EXECUTION_BUSY!
    const submitBRes = await client.callTool({
      name: "execution_submit",
      arguments: { task_id: "task_B", iteration: 1, plan: "Task B" },
    });
    expect(submitBRes.isError).toBe(true);
    const errData = jsonOf<{ error: string; activeRunId: string }>(submitBRes);
    expect(errData.error).toBe("EXECUTION_BUSY");
    expect(errData.activeRunId).toBe(runAId);

    // 4. Wait for Task A to completely resolve
    await new Promise((r) => setTimeout(r, 400));
    expect(runnerFinished).toBe(true);

    // 5. Now submit Task B -> MUST be accepted!
    mockRunnerOverride = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
      stderr: "",
      timedOut: false,
    });

    const submitBRetryRes = await client.callTool({
      name: "execution_submit",
      arguments: { task_id: "task_B", iteration: 1, plan: "Task B" },
    });
    expect(submitBRetryRes.isError).toBeFalsy();
    expect(jsonOf<{ accepted: boolean }>(submitBRetryRes).accepted).toBe(true);
  });

  it("shutdown regression: bridge.close() awaits running executor termination", async () => {
    setExecutionRelayEnabled(true);
    const tempWs = makeTmpDir("shutdown-test-ws");
    makeGitRepo(tempWs);

    let runnerCompletedOnAbort = false;
    const slowRunner: ProcessRunner = async (_, __, opts) => {
      while (!opts.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 150));
      runnerCompletedOnAbort = true;
      return {
        exitCode: null,
        stdout: "",
        stderr: "Aborted",
        timedOut: false,
        error: "ABORTED",
      };
    };

    const tempBridge = await startBridge({
      workspaceRoot: tempWs,
      port: 0,
      persistRuntime: false,
      executionRunner: slowRunner,
    });

    await tempBridge.executionManager.startTask({
      taskId: "task_shutdown",
      iteration: 1,
      plan: "Do something",
    });

    // Close the bridge
    await tempBridge.close();

    // Verify the runner was cleanly awaited and finished before close resolved
    expect(runnerCompletedOnAbort).toBe(true);
    cleanup(tempWs);
  });

  it("setup exception regression: writes failure execution record", async () => {
    setExecutionRelayEnabled(true);

    mockRunnerOverride = async () => {
      throw new Error("Fatal setup exception");
    };

    const submitRes = await client.callTool({
      name: "execution_submit",
      arguments: { task_id: "task_setup_fail", iteration: 1, plan: "Fail plan" },
    });
    const runId = jsonOf<{ runId: string }>(submitRes).runId;

    const statusRes = await client.callTool({
      name: "execution_status",
      arguments: { run_id: runId, wait_ms: 2000 },
    });
    const statusData = jsonOf<{ status: string; error: string }>(statusRes);
    expect(statusData.status).toBe("failed");
    expect(statusData.error).toContain("Fatal setup exception");

    // Verify execution_summary captured the failure
    const summaryRes = await client.callTool({ name: "execution_summary", arguments: {} });
    const summaryData = jsonOf<{ records: { taskId: string; exitStatus: string }[] }>(summaryRes);
    expect(summaryData.records.some((r) => r.taskId === "task_setup_fail" && r.exitStatus === "failed")).toBe(true);
  });
});
