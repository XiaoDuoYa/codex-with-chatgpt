import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { TaskSnapshot } from "../src/protocol/types.js";
import { TaskStore, TaskStoreError } from "../src/task/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const roots: string[] = [];
const makeRoot = (): string => {
  const root = makeTmpDir("task-store");
  roots.push(root);
  return root;
};

afterEach(() => roots.splice(0).forEach(cleanup));

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    protocolVersion: 1,
    taskId: "c2c_11111111",
    transport: "github",
    state: "INIT",
    iteration: 0,
    goal: "Implement the task runtime",
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
}

describe("TaskStore", () => {
  it("atomically replaces current JSON and removes the temporary file", () => {
    const root = makeRoot();
    const store = new TaskStore(root);
    store.write(snapshot());
    store.write(snapshot({ state: "PLAN", iteration: 1 }));

    expect(store.read()).toMatchObject({ state: "PLAN", iteration: 1 });
    expect(fs.existsSync(path.join(root, ".c2c", "current.json.tmp"))).toBe(false);
  });

  it("treats current JSON as truth and rebuilds projections", () => {
    const root = makeRoot();
    const store = new TaskStore(root);
    store.write(snapshot({ state: "EXECUTED", iteration: 2 }));
    fs.writeFileSync(path.join(root, ".c2c", "current.md"), "stale");
    fs.writeFileSync(path.join(root, ".c2c", "tasks", "c2c_11111111.json"), "stale");

    store.repairProjections();

    expect(fs.readFileSync(path.join(root, ".c2c", "current.md"), "utf8")).toContain("ITERATION\n2");
    expect(JSON.parse(fs.readFileSync(path.join(root, ".c2c", "tasks", "c2c_11111111.json"), "utf8"))).toMatchObject({
      state: "EXECUTED",
      iteration: 2,
    });
    expect(store.read()?.iteration).toBe(2);
  });

  it("refuses corrupted current JSON without reading Markdown", () => {
    const root = makeRoot();
    const store = new TaskStore(root);
    store.write(snapshot());
    fs.writeFileSync(path.join(root, ".c2c", "current.json"), "{broken");
    fs.writeFileSync(path.join(root, ".c2c", "current.md"), "STATE\nDONE");

    expect(() => store.read()).toThrowError(TaskStoreError);
    try {
      store.read();
    } catch (error) {
      expect((error as TaskStoreError).code).toBe("INVALID_TASK_SNAPSHOT");
    }
  });
});
