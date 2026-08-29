import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TaskSnapshot } from "../src/protocol/types.js";
import { TaskStore } from "../src/task/store.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach(cleanup));

function runCli(args: string[], input?: string): Record<string, any> {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", path.resolve("src/cli/index.ts"), ...args],
    { cwd: path.resolve("."), encoding: "utf8", input }
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout.trim()) as Record<string, any>;
}

describe("Plus GitHub workflow", () => {
  it("runs INIT through pending DONE and final remote DONE", () => {
    const root = makeTmpDir("plus-workflow");
    const bare = makeTmpDir("plus-workflow-bare");
    roots.push(root, bare);
    makeGitRepo(root);
    git(root, "config", "user.name", "c2c-test");
    git(root, "config", "user.email", "test@c2c.local");
    git(bare, "init", "--bare");
    git(root, "remote", "add", "origin", bare);

    const started = runCli([
      "task",
      "start",
      "Update the answer with a test",
      "--transport",
      "github",
      "--workspace",
      root,
      "--json",
    ]);
    const taskId = String(started.taskId);
    const branch = String(started.branch);
    expect(JSON.parse(git(bare, "show", `${branch}:.c2c/current.json`))).toMatchObject({ state: "INIT", taskId });

    const plan = `[C2C]
STATE: PLAN
TASK_ID: ${taskId}
ITERATION: 1
ACTIONS: Update src/index.ts.
TESTS: Run the focused test.
SUCCESS_CRITERIA: The test passes.
`;
    expect(runCli(["task", "import", "--workspace", root, "--json"], plan)).toMatchObject({
      state: "PLAN",
      iteration: 1,
    });

    write(root, "src/index.ts", "export const answer = 43;\n");
    const published = runCli([
      "task",
      "publish",
      "--workspace",
      root,
      "--changed-files",
      "src/index.ts",
      "--tests",
      "1 passed",
      "--test-command",
      "corepack pnpm test",
      "--review-focus",
      "Check the answer change.",
      "--json",
    ]);
    expect(published).toMatchObject({ ok: true, state: "EXECUTED", iteration: 1 });
    const executed = JSON.parse(git(bare, "show", `${branch}:.c2c/current.json`)) as TaskSnapshot;
    expect(executed).toMatchObject({ state: "EXECUTED", declaredChangedFiles: ["src/index.ts"] });
    expect(executed.codeHeadCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(git(root, "diff", "--name-only", executed.iterationBaseCommit!, executed.codeHeadCommit!, "--", "src/index.ts")).toContain(
      "src/index.ts"
    );

    const done = `[C2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: 1\nSUMMARY: Accepted.\n`;
    expect(runCli(["task", "import", "--workspace", root, "--json"], done)).toMatchObject({
      state: "EXECUTED",
      acceptedDecision: "DONE",
      requiresFinalValidation: true,
    });
    expect(new TaskStore(root).read()).toMatchObject({ state: "EXECUTED", pendingDecision: { state: "DONE" } });

    const finalized = runCli([
      "task",
      "publish",
      "--workspace",
      root,
      "--finalize",
      "passed",
      "--tests",
      "113 passed",
      "--test-command",
      "corepack pnpm test",
      "--json",
    ]);
    expect(finalized).toMatchObject({ ok: true, state: "DONE", iteration: 1 });
    expect(JSON.parse(git(bare, "show", `${branch}:.c2c/current.json`))).toMatchObject({
      state: "DONE",
      pendingDecision: null,
      tests: { status: "passed", summary: "113 passed" },
    });
  }, 30_000);
});
