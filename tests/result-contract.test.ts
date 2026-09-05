import { describe, expect, it } from "vitest";
import { controlResultContract } from "../src/control/result-contract.js";
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
});
