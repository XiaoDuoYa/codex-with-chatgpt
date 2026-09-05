import { describe, expect, it } from "vitest";
import { controlDeliveryPrompt, controlResultContract } from "../src/control/result-contract.js";
import {
  CONTROL_PHASES,
  allowedKindsForPhase,
  parseSubmitControlResultInput,
  researchPayloadSchema,
} from "../src/control/result-schema.js";

describe("control result prompt contract", () => {
  it.each(CONTROL_PHASES)("supplies schema-valid examples for every allowed %s result", (phase) => {
    const contract = controlResultContract(phase);
    expect(contract.requiredTools).toEqual(["submit_control_result"]);
    expect(contract.examples.map((example) => example.kind)).toEqual(allowedKindsForPhase(phase));
    for (const example of contract.examples) {
      expect(parseSubmitControlResultInput({
        requestId: "request-test", localSessionId: "session-test", taskId: "task-test",
        iteration: 0, phase, ...example,
      })).toMatchObject(example);
    }
  });

  it("does not supply invented external evidence for local research", () => {
    const example = controlResultContract("RESEARCH").examples.find((item) => item.kind === "RESEARCH")!;
    expect(researchPayloadSchema.parse(example.payload).sources).toEqual([]);
    expect(researchPayloadSchema.safeParse({ ...example.payload, conclusions: [] }).success).toBe(false);
    expect(researchPayloadSchema.safeParse({ ...example.payload, sources: undefined }).success).toBe(false);
  });

  it.each(CONTROL_PHASES)("renders all %s delivery instructions with the exact runtime correlation", (phase) => {
    const request = {
      schemaVersion: 1 as const, requestId: "request-fixture", workspaceId: "workspace-fixture",
      localSessionId: "session-fixture", taskId: "task-fixture", iteration: 7, phase,
      allowedKinds: allowedKindsForPhase(phase),
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:30:00.000Z",
    };
    const contextId = "synthetic-context-for-test";
    const prompt = controlDeliveryPrompt(request, contextId);
    const fields = Object.fromEntries(prompt.split("\n").slice(1, 7).map((line) => line.split(": ")));
    expect(fields).toEqual({
      RESULT_REQUEST_ID: request.requestId, CONTEXT_ID: contextId, LOCAL_SESSION_ID: request.localSessionId,
      TASK_ID: request.taskId, ITERATION: "7", RESULT_PHASE: phase,
    });
    const contract = controlResultContract(phase);
    for (const instruction of contract.instructions) expect(prompt).toContain(instruction);
    expect(JSON.parse(prompt.split("\n").at(-1)!)).toEqual(contract.examples);
    expect(contract.examples.some((example) => example.kind === "BLOCKED")).toBe(true);
  });
});
