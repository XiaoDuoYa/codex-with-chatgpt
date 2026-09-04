import { describe, expect, it, vi } from "vitest";
import {
  runRollbackSteps,
  shouldRestorePreviousGateway,
} from "../src/config/setup-transaction.js";

describe("machine setup rollback", () => {
  it("keeps a previously stopped Gateway stopped when its running supervisor is stopped", () => {
    expect(shouldRestorePreviousGateway("stopped", true)).toBe(false);
    expect(shouldRestorePreviousGateway("unknown", true)).toBe(false);
  });

  it("restores a previously healthy Gateway only after a successful stop", () => {
    expect(shouldRestorePreviousGateway("healthy", true)).toBe(true);
    expect(shouldRestorePreviousGateway("healthy", false)).toBe(false);
  });

  it("runs every rollback step and aggregates failures in order", async () => {
    const calls: string[] = [];
    const finalStep = vi.fn(() => {
      calls.push("third");
    });

    const errors = await runRollbackSteps([
      {
        label: "first restore",
        run: () => {
          calls.push("first");
          throw new Error("first failed");
        },
      },
      {
        label: "second restore",
        run: async () => {
          calls.push("second");
          throw "second failed";
        },
      },
      { label: "third restore", run: finalStep },
    ]);

    expect(calls).toEqual(["first", "second", "third"]);
    expect(finalStep).toHaveBeenCalledOnce();
    expect(errors).toEqual([
      "first restore: first failed",
      "second restore: second failed",
    ]);
  });

  it("returns no errors after a complete rollback", async () => {
    await expect(runRollbackSteps([
      { label: "sync", run: () => undefined },
      { label: "async", run: async () => undefined },
    ])).resolves.toEqual([]);
  });
});
