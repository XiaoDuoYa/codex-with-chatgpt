import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { TaskSnapshot } from "../src/protocol/types.js";
import { TaskStore } from "../src/task/store.js";
import { buildTaskBranch, generateTaskId, GitHubTransport } from "../src/transport/github.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];

function fixture(): { root: string; bare: string } {
  const root = makeTmpDir("github-transport");
  const bare = makeTmpDir("github-transport-bare");
  roots.push(root, bare);
  makeGitRepo(root);
  git(root, "config", "user.name", "c2c-test");
  git(root, "config", "user.email", "test@c2c.local");
  git(bare, "init", "--bare");
  git(root, "remote", "add", "origin", bare);
  return { root, bare };
}

afterEach(() => roots.splice(0).forEach(cleanup));

function initialSnapshot(taskId = "c2c_a1b2c3d4"): TaskSnapshot {
  return {
    protocolVersion: 1,
    taskId,
    transport: "github",
    state: "INIT",
    iteration: 0,
    goal: "Add a tested health endpoint",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    repository: { provider: "github", owner: "local", name: "fixture", remote: "origin", branch: "pending" },
    taskBaseCommit: null,
    iterationBaseCommit: null,
    codeHeadCommit: null,
    declaredChangedFiles: [],
    tests: { status: "not_run", summary: null, command: null },
    reviewFocus: "",
    lastImported: null,
    pendingDecision: null,
    blockedFrom: null,
  };
}

describe("GitHubTransport", () => {
  it("generates eight-hex task IDs and safe task branches", () => {
    expect(generateTaskId()).toMatch(/^c2c_[0-9a-f]{8}$/);
    expect(buildTaskBranch("c2c_a1b2c3d4", "Add a tested health endpoint")).toBe(
      "c2c/c2c-a1b2c3d4-add-a-tested-health-endpoint"
    );
  });

  it("publishes INIT with original base commits and task projections", async () => {
    const { root, bare } = fixture();
    const base = git(root, "rev-parse", "HEAD").trim();
    const snapshot = initialSnapshot();
    const transport = new GitHubTransport();
    const receipt = await transport.prepare({ workspaceRoot: root, snapshot });

    expect(receipt).toMatchObject({ ok: true, kind: "github", taskId: snapshot.taskId });
    const branch = buildTaskBranch(snapshot.taskId, snapshot.goal);
    const remoteSnapshot = JSON.parse(git(bare, "show", `${branch}:.c2c/current.json`)) as TaskSnapshot;
    expect(remoteSnapshot).toMatchObject({
      state: "INIT",
      taskBaseCommit: base,
      iterationBaseCommit: base,
      codeHeadCommit: base,
      repository: { branch },
    });
    expect(git(bare, "show", `${branch}:.c2c/current.md`)).toContain(snapshot.taskId);
    expect(git(bare, "show", `${branch}:.c2c/tasks/${snapshot.taskId}.json`)).toContain('"state": "INIT"');
  });

  it("publishes explicit code and metadata as two commits with an auditable review range", async () => {
    const { root, bare } = fixture();
    const transport = new GitHubTransport();
    const start = await transport.prepare({ workspaceRoot: root, snapshot: initialSnapshot() });
    expect(start.ok).toBe(true);
    const store = new TaskStore(root);
    const current = store.read()!;
    const iterationBase = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/index.ts", "export const answer = 43;\n");
    store.write({
      ...current,
      state: "EXECUTED",
      iteration: 1,
      iterationBaseCommit: iterationBase,
      declaredChangedFiles: ["src/index.ts"],
      tests: { status: "passed", summary: "1 passed", command: "pnpm test" },
      reviewFocus: "Check the health endpoint.",
    });
    const before = Number(git(root, "rev-list", "--count", "HEAD").trim());

    const receipt = await transport.publish({
      workspaceRoot: root,
      snapshot: store.read()!,
      taskId: current.taskId,
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "1 passed",
      exitStatus: "ok",
    });

    expect(receipt.ok).toBe(true);
    expect(Number(git(root, "rev-list", "--count", "HEAD").trim())).toBe(before + 2);
    const persisted = store.read()!;
    expect(persisted.codeHeadCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(git(root, "show", "--name-only", "--format=", persisted.codeHeadCommit!)).toContain("src/index.ts");
    expect(git(root, "show", "--name-only", "--format=", "HEAD")).toContain(".c2c/current.json");
    expect(receipt.instruction).toContain(persisted.taskBaseCommit!);
    expect(receipt.instruction).toContain(iterationBase);
    expect(receipt.instruction).toContain(persisted.codeHeadCommit!);
    expect(receipt.instruction).toContain("src/index.ts");
    expect(receipt.instruction).toContain("exclude .c2c/**");
    expect(git(bare, "show", `${persisted.repository!.branch}:.c2c/current.json`)).toContain(persisted.codeHeadCommit!);
  });

  it("retries a failed push without duplicate code or state commits", async () => {
    const { root, bare } = fixture();
    const transport = new GitHubTransport();
    await transport.prepare({ workspaceRoot: root, snapshot: initialSnapshot("c2c_deadbeef") });
    const store = new TaskStore(root);
    const current = store.read()!;
    write(root, "src/index.ts", "export const answer = 44;\n");
    store.write({
      ...current,
      state: "EXECUTED",
      iteration: 1,
      iterationBaseCommit: git(root, "rev-parse", "HEAD").trim(),
      declaredChangedFiles: ["src/index.ts"],
      tests: { status: "passed", summary: "1 passed", command: "pnpm test" },
    });
    git(root, "remote", "set-url", "origin", path.join(root, "missing.git"));

    const first = await transport.publish({
      workspaceRoot: root,
      snapshot: store.read()!,
      taskId: current.taskId,
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "1 passed",
      exitStatus: "ok",
    });
    expect(first).toMatchObject({ ok: false, code: "PUBLISH_FAILED" });
    const countAfterFailure = git(root, "rev-list", "--count", "HEAD").trim();

    git(root, "remote", "set-url", "origin", bare);
    const second = await transport.publish({
      workspaceRoot: root,
      snapshot: store.read()!,
      taskId: current.taskId,
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "1 passed",
      exitStatus: "ok",
    });
    expect(second.ok).toBe(true);
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe(countAfterFailure);
  });
});
