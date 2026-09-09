import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bindMachineConnector, machineConnectorFile, machineConnectorStatus, requireMachineConnector } from "../src/gateway/connector-binding.js";
import { controlDeliveryPrompt, controlResultContract } from "../src/control/result-contract.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const machineA = { machineId: `machine-${"a".repeat(32)}`, tunnelId: `tunnel_${"a".repeat(32)}`, associationId: `assoc-${"a".repeat(32)}` };
const machineB = { machineId: `machine-${"b".repeat(32)}`, tunnelId: `tunnel_${"b".repeat(32)}`, associationId: `assoc-${"b".repeat(32)}` };
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(cleanup); delete process.env.C2C_STATE_DIR; });

describe("per-device ChatGPT connector binding", () => {
  it("requires an explicit mapping without guessing or writing one", () => {
    dirs.push(isolateStateDir());
    expect(machineConnectorStatus(machineA)).toEqual({ status: "unconfigured", binding: null });
    expect(() => requireMachineConnector(machineA)).toThrow(/unconfigured/);
    expect(fs.existsSync(machineConnectorFile())).toBe(false);
  });
  it("persists the same global binding across reads and preserves app identity on rename", () => {
    dirs.push(isolateStateDir());
    const pluginUrl = "https://chatgpt.com/plugins/plugin_asdk_app_test";
    bindMachineConnector(machineA, { name: "Codex with ChatGPT", pluginUrl });
    expect(requireMachineConnector(machineA)).toEqual({ ...machineA, name: "Codex with ChatGPT", pluginUrl });
    bindMachineConnector(machineA, { name: "Codex with ChatGPT - renamed" });
    expect(requireMachineConnector(machineA).pluginUrl).toBe(pluginUrl);
    if (process.platform !== "win32") expect(fs.statSync(machineConnectorFile()).mode & 0o777).toBe(0o600);
  });
  it.each(["machineId", "tunnelId", "associationId"] as const)("invalidates copied or changed %s without deleting the old mapping", key => {
    dirs.push(isolateStateDir());
    bindMachineConnector(machineA, { name: "Codex with ChatGPT", pluginUrl: "https://chatgpt.com/plugins/plugin_device_a" });
    const changed = { ...machineA, [key]: machineB[key] };
    expect(machineConnectorStatus(changed).status).toBe("stale");
    expect(() => requireMachineConnector(changed)).toThrow(/stale/);
    bindMachineConnector(changed, { name: "Codex with ChatGPT - Gala Mac" });
    expect(requireMachineConnector(changed).pluginUrl).toBeUndefined();
    expect(() => requireMachineConnector(machineA)).toThrow(/stale/);
  });
  it.each(["https://evil.example/plugins/plugin_a", "https://chatgpt.com/plugins/plugin_a?token=secret", "https://chatgpt.com/plugins/plugin_a\n"])("rejects an invalid stable app URL %j", pluginUrl => {
    dirs.push(isolateStateDir());
    expect(() => bindMachineConnector(machineA, { name: "C2C", pluginUrl })).toThrow();
    expect(fs.existsSync(machineConnectorFile())).toBe(false);
  });
  it("keeps two devices' prompts and identity expectations separate", () => {
    const a = isolateStateDir(); dirs.push(a);
    bindMachineConnector(machineA, { name: "Codex with ChatGPT" });
    const targetA = requireMachineConnector(machineA);
    dirs.push(isolateStateDir());
    bindMachineConnector(machineB, { name: "Codex with ChatGPT - Gala Mac", pluginUrl: "https://chatgpt.com/plugins/plugin_device_b" });
    const targetB = requireMachineConnector(machineB);
    const request = { schemaVersion: 2 as const, requestId: "request-test", workspaceId: "workspace-test", localSessionId: "session-test", taskId: "task-test", iteration: 0, phase: "BOOT" as const, allowedKinds: ["BOOT" as const, "BLOCKED" as const], surfaceGeneration: 1, surfaceTabId: "tab-test", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() };
    for (const [target, other] of [[targetA, targetB], [targetB, targetA]]) {
      const prompt = controlDeliveryPrompt(request, "test-context", target);
      expect(controlResultContract("BOOT", target).connector).toEqual(target);
      expect(prompt).toContain(JSON.stringify(target));
      expect(prompt).not.toContain(other.machineId);
    }
    expect(controlResultContract("RESEARCH", targetB, false).requiredTools).toEqual([]);
    expect(controlResultContract("RESEARCH", targetB, true).requiredTools).toEqual(["workspace_info"]);
    process.env.C2C_STATE_DIR = a;
    expect(requireMachineConnector(machineA)).toEqual(targetA);
  });
});
