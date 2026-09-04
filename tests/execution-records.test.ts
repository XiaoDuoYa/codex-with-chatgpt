import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendExecutionRecord,
  latestExecutionRecord,
  parseExecutionExitStatus,
  readExecutionRecords,
} from "../src/execution/records.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("execution record store", () => {
  let stateDir: string | null = null;

  afterEach(() => {
    if (stateDir) cleanup(stateDir);
    stateDir = null;
    delete process.env.C2C_STATE_DIR;
  });

  it("filters records by local session, task, and iteration", () => {
    stateDir = isolateStateDir();
    appendExecutionRecord("ws1", {
      localSessionId: "session-a",
      taskId: "c2c_task_a",
      iteration: 1,
      changedFiles: ["src/a.ts"],
      tests: "1 passed",
      exitStatus: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    appendExecutionRecord("ws1", {
      localSessionId: "session-b",
      taskId: "c2c_task_b",
      iteration: 1,
      changedFiles: ["src/b.ts"],
      tests: "1 failed",
      exitStatus: "failed",
      timestamp: "2026-01-01T00:00:01.000Z",
    });

    expect(
      readExecutionRecords("ws1", 10, { localSessionId: "session-a", taskId: "c2c_task_a" }).map(
        (record) => record.tests
      )
    ).toEqual(["1 passed"]);
    expect(
      latestExecutionRecord("ws1", {
        localSessionId: "session-b",
        taskId: "c2c_task_b",
        iteration: 1,
      })?.tests
    ).toBe("1 failed");
  });

  it("rejects a record log copied from another workspace", () => {
    stateDir = isolateStateDir();
    appendExecutionRecord("ws1", {
      localSessionId: "session-a",
      taskId: "c2c_task_a",
      iteration: 1,
      changedFiles: 1,
      tests: null,
      exitStatus: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const executionsDir = path.join(stateDir, "executions");
    fs.copyFileSync(path.join(executionsDir, "ws1.jsonl"), path.join(executionsDir, "ws2.jsonl"));
    expect(() => readExecutionRecords("ws2")).toThrow(/does not match its workspace/);
  });

  it("rejects invalid exit statuses before they enter the log", () => {
    expect(parseExecutionExitStatus("ok")).toBe("ok");
    expect(() => parseExecutionExitStatus("success")).toThrow(/exit-status/);
  });

  it("validates every persisted field and rejects unknown metadata", () => {
    stateDir = isolateStateDir();
    appendExecutionRecord("ws1", {
      localSessionId: "session-a",
      taskId: "c2c_task_a",
      iteration: 1,
      changedFiles: ["src/a.ts"],
      tests: "1 passed",
      exitStatus: "ok",
      timestamp: "2026-01-01T00:00:00.000Z",
      notes: "verified",
      outputId: 1,
      outputAvailable: true,
    });
    const file = path.join(stateDir, "executions", "ws1.jsonl");
    const valid = JSON.parse(fs.readFileSync(file, "utf8").trim()) as Record<string, unknown>;
    const mutations: Array<(record: Record<string, unknown>) => void> = [
      (record) => { record.localSessionId = "../session"; },
      (record) => { record.taskId = "bad/task"; },
      (record) => { record.iteration = 10_001; },
      (record) => { record.changedFiles = ["../secret"]; },
      (record) => { record.changedFiles = ["src/a.ts", "src/a.ts"]; },
      (record) => { record.tests = { passed: 1 }; },
      (record) => { record.exitStatus = "success"; },
      (record) => { record.timestamp = "2026-01-01"; },
      (record) => { record.notes = "x".repeat(401); },
      (record) => { record.outputId = 0; },
      (record) => { delete record.outputId; record.outputAvailable = true; },
      (record) => { delete record.outputAvailable; },
      (record) => { record.unexpected = true; },
    ];

    for (const mutate of mutations) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      fs.writeFileSync(file, `${JSON.stringify(invalid)}\n`);
      expect(() => readExecutionRecords("ws1")).toThrow(/schema/);
    }
  });

  it("validates a record before creating its JSONL file", () => {
    stateDir = isolateStateDir();
    expect(() =>
      appendExecutionRecord("ws1", {
        localSessionId: "session-a",
        taskId: "c2c_task_a",
        iteration: 1,
        changedFiles: ["/Users/example/private.ts"],
        tests: null,
        exitStatus: "ok",
        timestamp: "2026-01-01T00:00:00.000Z",
      })
    ).toThrow();
    expect(fs.existsSync(path.join(stateDir, "executions", "ws1.jsonl"))).toBe(false);
  });

  it("ignores and repairs an interrupted trailing JSONL write", () => {
    stateDir = isolateStateDir();
    const first = {
      localSessionId: "session-a",
      taskId: "c2c_task_a",
      iteration: 1,
      changedFiles: ["src/a.ts"],
      tests: "1 passed",
      exitStatus: "ok" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    appendExecutionRecord("ws1", first);
    const file = path.join(stateDir, "executions", "ws1.jsonl");
    fs.appendFileSync(file, '{"workspaceId":"ws1","localSessionId":');

    expect(readExecutionRecords("ws1")).toMatchObject([first]);

    appendExecutionRecord("ws1", {
      ...first,
      iteration: 2,
      changedFiles: ["src/b.ts"],
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    expect(readExecutionRecords("ws1").map((record) => record.iteration)).toEqual([1, 2]);
    expect(fs.readFileSync(file, "utf8")).toMatch(/\n$/);
  });

  it("preserves a valid final record that is missing only its newline", () => {
    stateDir = isolateStateDir();
    const record = {
      localSessionId: "session-a",
      taskId: "c2c_task_a",
      iteration: 1,
      changedFiles: ["src/a.ts"],
      tests: "1 passed",
      exitStatus: "ok" as const,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    appendExecutionRecord("ws1", record);
    const file = path.join(stateDir, "executions", "ws1.jsonl");
    fs.truncateSync(file, fs.statSync(file).size - 1);

    appendExecutionRecord("ws1", {
      ...record,
      iteration: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    expect(readExecutionRecords("ws1").map((entry) => entry.iteration)).toEqual([1, 2]);
  });

  it("still rejects malformed newline-terminated records", () => {
    stateDir = isolateStateDir();
    const file = path.join(stateDir, "executions", "ws1.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not-json\n");
    expect(() => readExecutionRecords("ws1")).toThrow(/unreadable or malformed/);
  });
});
