import { afterEach, describe, expect, it } from "vitest";
import type { C2CMessage, TaskSnapshot } from "../src/protocol/types.js";
import { TaskLifecycle, TaskLifecycleError } from "../src/task/lifecycle.js";
import { TaskStore } from "../src/task/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach(cleanup));

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    protocolVersion: 1,
    taskId: "c2c_11111111",
    transport: "github",
    state: "INIT",
    iteration: 0,
    goal: "Implement lifecycle",
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

function message(state: "PLAN" | "DONE" | "BLOCKED", iteration: number): C2CMessage {
  const sections =
    state === "PLAN"
      ? { ACTIONS: "Implement.", TESTS: "Run tests.", SUCCESS_CRITERIA: "Pass." }
      : state === "BLOCKED"
        ? { REASON: "Missing access." }
        : { SUMMARY: "Accepted." };
  return { protocolVersion: 1, taskId: "c2c_11111111", iteration, state, sections };
}

function lifecycle(seed: TaskSnapshot): TaskLifecycle {
  const root = makeTmpDir("task-lifecycle");
  roots.push(root);
  const store = new TaskStore(root);
  store.write(seed);
  return new TaskLifecycle(store, () => "2026-08-29T02:00:00.000Z");
}

describe("TaskLifecycle", () => {
  it("moves INIT through PLAN, EXECUTING, and EXECUTED", () => {
    const subject = lifecycle(snapshot());
    expect(subject.importMessage(message("PLAN", 1)).snapshot.state).toBe("PLAN");
    expect(subject.startExecution().state).toBe("EXECUTING");
    expect(
      subject.completeExecution({
        declaredChangedFiles: ["src/task/lifecycle.ts"],
        tests: { status: "passed", summary: "1 passed", command: "pnpm test" },
        reviewFocus: "Review transitions.",
      }).state
    ).toBe("EXECUTED");
  });

  it("does not enter DONE until final validation passes", () => {
    const subject = lifecycle(snapshot({ state: "EXECUTED", iteration: 2 }));
    const imported = subject.importMessage(message("DONE", 2));
    expect(imported.snapshot.state).toBe("EXECUTED");
    expect(imported.snapshot.pendingDecision?.state).toBe("DONE");

    const finalized = subject.finalizeDone({ passed: true, summary: "83 passed", command: "pnpm test" });
    expect(finalized.state).toBe("DONE");
    expect(finalized.pendingDecision).toBeNull();
  });

  it("clears pending DONE and remains EXECUTED when final validation fails", () => {
    const subject = lifecycle(snapshot({ state: "EXECUTED", iteration: 2 }));
    subject.importMessage(message("DONE", 2));
    const finalized = subject.finalizeDone({ passed: false, summary: "1 failed", command: "pnpm test" });
    expect(finalized).toMatchObject({ state: "EXECUTED", pendingDecision: null, tests: { status: "failed" } });
  });

  it("persists BLOCKED origin and resumes it explicitly", () => {
    const subject = lifecycle(snapshot({ state: "EXECUTED", iteration: 3, codeHeadCommit: "a".repeat(40) }));
    const blocked = subject.importMessage(message("BLOCKED", 3)).snapshot;
    expect(blocked).toMatchObject({
      state: "BLOCKED",
      blockedFrom: { state: "EXECUTED", iteration: 3, code: "CHATGPT_BLOCKED", reason: "Missing access." },
    });
    expect(subject.resume()).toMatchObject({ state: "EXECUTED", iteration: 3, blockedFrom: null });
  });

  it("refuses actions from the wrong state or without BLOCKED context", () => {
    const subject = lifecycle(snapshot());
    expect(() => subject.startExecution()).toThrowError(TaskLifecycleError);

    const invalidBlocked = lifecycle(snapshot({ state: "BLOCKED", blockedFrom: null }));
    try {
      invalidBlocked.resume();
      expect.unreachable("resume should fail");
    } catch (error) {
      expect((error as TaskLifecycleError).code).toBe("BLOCKED_CONTEXT_MISSING");
    }
  });
});
