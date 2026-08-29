import { describe, expect, it } from "vitest";
import { parseC2CMessage } from "../src/protocol/parser.js";
import type { C2CMessage, TaskSnapshot } from "../src/protocol/types.js";
import { buildPlanInstruction, buildReviewInstruction } from "../src/protocol/instructions.js";
import { serializeC2CMessage } from "../src/protocol/serializer.js";
import { validateImportedMessage, validateTransition } from "../src/protocol/validator.js";

const plan = (taskId: string, iteration: number): C2CMessage => ({
  protocolVersion: 1,
  taskId,
  iteration,
  state: "PLAN",
  sections: { ACTIONS: "Change parser.", TESTS: "Run tests.", SUCCESS_CRITERIA: "Tests pass." },
});

const done = (taskId: string, iteration: number): C2CMessage => ({
  protocolVersion: 1,
  taskId,
  iteration,
  state: "DONE",
  sections: { SUMMARY: "Accepted." },
});

const blocked = (taskId: string, iteration: number): C2CMessage => ({
  protocolVersion: 1,
  taskId,
  iteration,
  state: "BLOCKED",
  sections: { REASON: "Missing access." },
});

describe("protocol semantic validation", () => {
  it("rejects a PLAN for another task", () => {
    const result = validateImportedMessage(plan("c2c_11111111", 1), {
      taskId: "c2c_22222222",
      currentState: "INIT",
      currentIteration: 0,
    });
    expect(result).toMatchObject({ ok: false, code: "TASK_ID_MISMATCH" });
  });

  it("rejects an explicitly wrong PLAN iteration", () => {
    const result = validateImportedMessage(plan("c2c_11111111", 2), {
      taskId: "c2c_11111111",
      currentState: "INIT",
      currentIteration: 0,
    });
    expect(result).toMatchObject({ ok: false, code: "ITERATION_MISMATCH" });
  });

  it("requires actionable PLAN sections", () => {
    const message = plan("c2c_11111111", 1);
    message.sections.TESTS = "";
    const result = validateImportedMessage(message, {
      taskId: "c2c_11111111",
      currentState: "INIT",
      currentIteration: 0,
    });
    expect(result).toMatchObject({ ok: false, code: "SECTION_MISSING" });
  });

  it("accepts DONE as a pending decision without transitioning", () => {
    const result = validateImportedMessage(done("c2c_11111111", 2), {
      taskId: "c2c_11111111",
      currentState: "EXECUTED",
      currentIteration: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      acceptedDecision: "DONE",
      requiresFinalValidation: true,
      nextState: "EXECUTED",
      nextIteration: 2,
    });
  });

  it("accepts BLOCKED from INIT and requires REASON", () => {
    expect(
      validateImportedMessage(blocked("c2c_11111111", 0), {
        taskId: "c2c_11111111",
        currentState: "INIT",
        currentIteration: 0,
      })
    ).toMatchObject({ ok: true, nextState: "BLOCKED", nextIteration: 0 });

    const invalid = blocked("c2c_11111111", 0);
    invalid.sections.REASON = " ";
    expect(
      validateImportedMessage(invalid, {
        taskId: "c2c_11111111",
        currentState: "INIT",
        currentIteration: 0,
      })
    ).toMatchObject({ ok: false, code: "SECTION_MISSING" });
  });

  it("rejects incoming execution states and terminal transitions", () => {
    expect(validateTransition("INIT", "EXECUTING")).toMatchObject({ ok: false, code: "STATE_NOT_ALLOWED" });
    expect(validateTransition("DONE", "PLAN")).toMatchObject({ ok: false, code: "STATE_NOT_ALLOWED" });
  });
});

describe("protocol serialization and instructions", () => {
  it("round trips deterministically", () => {
    const text = serializeC2CMessage(plan("c2c_11111111", 1));
    const parsed = parseC2CMessage(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeC2CMessage(parsed.message)).toBe(text);
  });

  it("builds transport-aware PLAN and REVIEW instructions", () => {
    const snapshot: TaskSnapshot = {
      protocolVersion: 1,
      taskId: "c2c_11111111",
      transport: "github",
      state: "EXECUTED",
      iteration: 2,
      goal: "Fix protocol validation",
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T01:00:00.000Z",
      repository: { provider: "github", owner: "acme", name: "widget", remote: "origin", branch: "c2c/task" },
      taskBaseCommit: "a".repeat(40),
      iterationBaseCommit: "b".repeat(40),
      codeHeadCommit: "c".repeat(40),
      declaredChangedFiles: ["src/protocol/parser.ts", "tests/protocol-parser.test.ts"],
      tests: { status: "passed", summary: "7 passed", command: "pnpm test" },
      reviewFocus: "Check protocol compatibility.",
      lastImported: { state: "PLAN", receivedAt: "2026-08-29T00:30:00.000Z" },
      pendingDecision: null,
      blockedFrom: null,
    };
    const transport = {
      kind: "github" as const,
      locator: { repository: "acme/widget", branch: "c2c/task" },
      capabilities: { directRead: true, requiresManualRelay: true },
    };

    expect(buildPlanInstruction({ ...snapshot, state: "INIT", iteration: 0 }, transport)).toContain("STATE: PLAN");
    const review = buildReviewInstruction(snapshot, transport);
    expect(review).toContain(snapshot.taskBaseCommit!);
    expect(review).toContain(snapshot.iterationBaseCommit!);
    expect(review).toContain(snapshot.codeHeadCommit!);
    expect(review).toContain("src/protocol/parser.ts");
    expect(review).toContain(".c2c/**");
    expect(review).toContain("exclude");
  });
});
