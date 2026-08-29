import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TaskSnapshot } from "../src/protocol/types.js";
import { TaskStore } from "../src/task/store.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach(cleanup));

function repoFixture(): { root: string; bare: string } {
  const root = makeTmpDir("task-cli");
  const bare = makeTmpDir("task-cli-bare");
  roots.push(root, bare);
  makeGitRepo(root);
  git(root, "config", "user.name", "c2c-test");
  git(root, "config", "user.email", "test@c2c.local");
  git(bare, "init", "--bare");
  git(root, "remote", "add", "origin", bare);
  return { root, bare };
}

function runCli(args: string[], input?: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx/esm", path.resolve("src/cli/index.ts"), ...args],
    { cwd: path.resolve("."), encoding: "utf8", input }
  );
}

function json(result: ReturnType<typeof runCli>): Record<string, any> {
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout.trim()) as Record<string, any>;
}

function seedSnapshot(root: string, overrides: Partial<TaskSnapshot>): TaskSnapshot {
  const snapshot: TaskSnapshot = {
    protocolVersion: 1,
    taskId: "c2c_11111111",
    transport: "github",
    state: "INIT",
    iteration: 0,
    goal: "CLI task",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    repository: null,
    taskBaseCommit: null,
    iterationBaseCommit: null,
    codeHeadCommit: null,
    declaredChangedFiles: [],
    tests: { status: "not_run", summary: null, command: null },
    reviewFocus: "",
    lastImported: null,
    pendingDecision: null,
    blockedFrom: null,
    ...overrides,
  };
  new TaskStore(root).write(snapshot);
  return snapshot;
}

const planText = (taskId: string, iteration = 1): string => `[C2C]
PROTOCOL_VERSION: 1
STATE: PLAN
TASK_ID: ${taskId}
ITERATION: ${iteration}

ACTIONS:
Implement the endpoint.

TESTS:
Run tests.

SUCCESS_CRITERIA:
Tests pass.
`;

describe("task CLI", () => {
  it("starts a GitHub task without writing project config", () => {
    const { root } = repoFixture();
    const result = json(runCli(["task", "start", "Add health endpoint", "--transport", "github", "--workspace", root, "--json"]));
    expect(result).toMatchObject({ ok: true, state: "INIT", transport: "github" });
    expect(result.taskId).toMatch(/^c2c_[0-9a-f]{8}$/);
    expect(fs.existsSync(path.join(root, ".c2c.json"))).toBe(false);
    expect(new TaskStore(root).read()).toMatchObject({ taskId: result.taskId, state: "INIT" });
  });

  it("repairs stale Markdown when reporting status", () => {
    const root = makeTmpDir("task-cli-status");
    roots.push(root);
    seedSnapshot(root, { state: "PLAN", iteration: 1 });
    fs.writeFileSync(path.join(root, ".c2c", "current.md"), "stale");

    const result = json(runCli(["task", "status", "--workspace", root, "--json"]));
    expect(result).toMatchObject({ ok: true, state: "PLAN", iteration: 1 });
    expect(fs.readFileSync(path.join(root, ".c2c", "current.md"), "utf8")).toContain("ITERATION\n1");
  });

  it("imports PLAN from a file and stdin", () => {
    const fromFile = makeTmpDir("task-cli-import-file");
    const fromStdin = makeTmpDir("task-cli-import-stdin");
    roots.push(fromFile, fromStdin);
    const fileTask = seedSnapshot(fromFile, {});
    const stdinTask = seedSnapshot(fromStdin, {});
    const planFile = write(fromFile, "plan.txt", planText(fileTask.taskId));

    expect(json(runCli(["task", "import", "--workspace", fromFile, "--file", planFile, "--json"]))).toMatchObject({
      ok: true,
      state: "PLAN",
      iteration: 1,
    });
    expect(json(runCli(["task", "import", "--workspace", fromStdin, "--json"], planText(stdinTask.taskId)))).toMatchObject({
      ok: true,
      state: "PLAN",
      iteration: 1,
    });
  });

  it("keeps imported DONE pending final validation", () => {
    const root = makeTmpDir("task-cli-done");
    roots.push(root);
    const task = seedSnapshot(root, { state: "EXECUTED", iteration: 2 });
    const done = `[C2C]\nSTATE: DONE\nTASK_ID: ${task.taskId}\nITERATION: 2\nSUMMARY: Accepted.\n`;
    const result = json(runCli(["task", "import", "--workspace", root, "--json"], done));

    expect(result).toMatchObject({
      ok: true,
      state: "EXECUTED",
      acceptedDecision: "DONE",
      requiresFinalValidation: true,
    });
    expect(new TaskStore(root).read()?.pendingDecision?.state).toBe("DONE");
  });

  it("resumes the exact BLOCKED origin", () => {
    const root = makeTmpDir("task-cli-resume");
    roots.push(root);
    seedSnapshot(root, {
      state: "BLOCKED",
      iteration: 3,
      blockedFrom: { state: "EXECUTED", iteration: 3, code: "PUBLISH_FAILED", reason: "Remote unavailable." },
    });
    expect(json(runCli(["task", "resume", "--workspace", root, "--json"]))).toMatchObject({
      ok: true,
      state: "EXECUTED",
      iteration: 3,
    });
  });

  it("returns stable errors for malformed, wrong-task, and wrong-iteration input", () => {
    const root = makeTmpDir("task-cli-errors");
    roots.push(root);
    const task = seedSnapshot(root, {});
    const malformed = runCli(["task", "import", "--workspace", root, "--json"], "not a protocol message");
    expect(malformed.status).toBe(1);
    expect(JSON.parse(malformed.stdout)).toMatchObject({ ok: false, code: "STATE_MISSING" });

    const wrongTask = runCli(["task", "import", "--workspace", root, "--json"], planText("c2c_deadbeef"));
    expect(wrongTask.status).toBe(1);
    expect(JSON.parse(wrongTask.stdout)).toMatchObject({
      ok: false,
      code: "TASK_ID_MISMATCH",
      message: "The imported message belongs to another task.",
    });
    expect(JSON.parse(wrongTask.stdout).expectedTemplate).toContain(task.taskId);

    const wrongIteration = runCli(["task", "import", "--workspace", root, "--json"], planText(task.taskId, 2));
    expect(wrongIteration.status).toBe(1);
    expect(JSON.parse(wrongIteration.stdout)).toMatchObject({ ok: false, code: "ITERATION_MISMATCH" });
  });
});
