import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportControlProgress, submitControlResult } from "../src/control/mailbox.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

let stateDir: string;
let workspace: string;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runJson(args: string[]): { command: CliResult; body: Record<string, unknown> } {
  const command = runCli([...args, "--json"]);
  const lines = command.stdout.trim().split("\n").filter(Boolean);
  return { command, body: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

function planResult(requestId: string) {
  return {
    requestId,
    localSessionId: "session-a",
    taskId: "c2c_0123456789abcdef",
    iteration: 0,
    phase: "PLAN",
    kind: "PLAN",
    payload: {
      goal: "Keep one local question matched to one ChatGPT answer",
      rationale: "Exact correlation prevents another turn or local session from consuming this answer.",
      actions: [{ change: "read only the correlated result", why: "avoid cross-turn confusion" }],
      tests: ["run CLI correlation smoke tests"],
      successCriteria: ["only the owning session can acknowledge the answer"],
    },
  } as const;
}

beforeEach(() => {
  stateDir = isolateStateDir();
  workspace = makeTmpDir("cli-control-workspace");
});

afterEach(() => {
  cleanup(workspace);
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

describe("control CLI correlation", () => {
  it("opens RESEARCH requests and exposes their current progress", () => {
    const opened = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-research",
      "--task",
      "c2c_research1",
      "--iteration",
      "0",
      "--phase",
      "RESEARCH",
    ]);
    expect(opened.command.status).toBe(0);
    const request = opened.body.request as {
      requestId: string;
      workspaceId: string;
      allowedKinds: string[];
    };
    expect(request.allowedKinds).toEqual(["RESEARCH", "BLOCKED"]);

    reportControlProgress(request.workspaceId, {
      requestId: request.requestId,
      localSessionId: "session-research",
      taskId: "c2c_research1",
      iteration: 0,
      phase: "RESEARCH",
      status: "SEARCHING",
      message: "Checking current sources.",
    });
    const status = runJson([
      "control",
      "status",
      "-w",
      workspace,
      "--local-session",
      "session-research",
      "--request",
      request.requestId,
      "--task",
      "c2c_research1",
      "--iteration",
      "0",
      "--phase",
      "RESEARCH",
    ]);
    expect(status.command.status).toBe(0);
    expect(status.body.status).toBe("pending");
    expect(status.body.progress).toMatchObject({ status: "SEARCHING" });
  });

  it("keeps one question and answer bound through open, wait, and acknowledge", () => {
    const opened = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(opened.command.status).toBe(0);
    const request = opened.body.request as { requestId: string; workspaceId: string };

    const overlapping = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "1",
      "--phase",
      "REVIEW",
    ]);
    expect(overlapping.command.status).toBe(1);
    expect(overlapping.body.code).toBe("MAILBOX_TURN_IN_PROGRESS");

    const wrongSession = runJson([
      "control",
      "wait",
      "-w",
      workspace,
      "--local-session",
      "session-b",
      "--request",
      request.requestId,
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--timeout-ms",
      "0",
    ]);
    expect(wrongSession.command.status).toBe(1);
    expect(wrongSession.body.code).toBe("MAILBOX_SESSION_MISMATCH");

    for (const mismatch of [
      { task: "c2c_fedcba9876543210", iteration: "0", phase: "PLAN" },
      { task: "c2c_0123456789abcdef", iteration: "1", phase: "PLAN" },
      { task: "c2c_0123456789abcdef", iteration: "0", phase: "REVIEW" },
    ]) {
      const result = runJson([
        "control",
        "status",
        "-w",
        workspace,
        "--local-session",
        "session-a",
        "--request",
        request.requestId,
        "--task",
        mismatch.task,
        "--iteration",
        mismatch.iteration,
        "--phase",
        mismatch.phase,
      ]);
      expect(result.command.status).toBe(1);
      expect(result.body.code).toBe("MAILBOX_CORRELATION_MISMATCH");
    }

    submitControlResult(request.workspaceId, planResult(request.requestId));
    const waited = runJson([
      "control",
      "wait",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--request",
      request.requestId,
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--timeout-ms",
      "0",
    ]);
    expect(waited.command.status).toBe(0);
    expect(waited.body.status).toBe("received");
    expect((waited.body.result as { requestId: string }).requestId).toBe(request.requestId);

    const acknowledged = runJson([
      "control",
      "ack",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--request",
      request.requestId,
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(acknowledged.command.status).toBe(0);
    expect(acknowledged.body.status).toBe("acknowledged");

    const next = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "1",
      "--phase",
      "REVIEW",
    ]);
    expect(next.command.status).toBe(0);
    expect((next.body.request as { requestId: string }).requestId).not.toBe(request.requestId);
  }, 60_000);

  it("rejects partially numeric timing and command exit-code options", () => {
    const ttl = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--ttl-ms",
      "1000junk",
    ]);
    expect(ttl.command.status).toBe(1);
    expect(ttl.body.error).toMatch(/ttl-ms must be an integer/);

    const outputFile = write(workspace, "command-output.txt", "tests failed\n");
    const record = runCli([
      "record",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "1",
      "--command",
      "pnpm test",
      "--output-file",
      outputFile,
      "--exit-code",
      "1junk",
    ]);
    expect(record.status).toBe(1);
    expect(`${record.stdout}\n${record.stderr}`).toMatch(/exit-code must be an integer/);
    expect(fs.existsSync(path.join(stateDir, "executions"))).toBe(false);
  });
});
