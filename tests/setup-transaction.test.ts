import { describe, expect, it, vi } from "vitest";
import {
  resolveMachineSetupOptions,
  runRollbackSteps,
  shouldRestorePreviousGateway,
} from "../src/config/setup-transaction.js";

describe("machine setup rollback", () => {
  it("requires complete first-time credentials", () => {
    expect(() => resolveMachineSetupOptions({ reuseExisting: false }, null)).toThrow(
      /provide both --tunnel-id and --runtime-key-file/i,
    );
    expect(() => resolveMachineSetupOptions({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      reuseExisting: false,
    }, null)).toThrow(/provide both/i);
    expect(resolveMachineSetupOptions({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: "/private/runtime.key",
      reuseExisting: false,
    }, null)).toEqual({
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeySourceFile: "/private/runtime.key",
      reuseExisting: false,
    });
  });

  it("reuses an existing tunnel only when explicitly requested", () => {
    const existing = { tunnelId: "tunnel_0123456789abcdef0123456789abcdef" };
    expect(resolveMachineSetupOptions({ reuseExisting: true }, existing)).toEqual({
      tunnelId: existing.tunnelId,
      runtimeKeySourceFile: null,
      reuseExisting: true,
    });
    expect(() => resolveMachineSetupOptions({ reuseExisting: true }, null)).toThrow(
      /no existing OpenAI Secure MCP Tunnel configuration/i,
    );
    expect(() => resolveMachineSetupOptions({
      reuseExisting: true,
      tunnelId: existing.tunnelId,
    }, existing)).toThrow(/cannot be combined/i);
  });

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
