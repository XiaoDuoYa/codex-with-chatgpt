import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeObservation, RuntimeState } from "../src/bridge/runtime.js";
import { findBridgeObservation } from "../src/bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../src/process/daemon.js";
import { ensureSandboxAllowlist } from "../src/config/sandbox-allow.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { chooseQuickTunnel, provisionNamedTunnel } from "../src/tunnel/named-provision.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

vi.mock("../src/bridge/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/bridge/runtime.js")>("../src/bridge/runtime.js");
  return { ...actual, findBridgeObservation: vi.fn() };
});

vi.mock("../src/process/daemon.js", async () => {
  const actual = await vi.importActual<typeof import("../src/process/daemon.js")>("../src/process/daemon.js");
  return {
    ...actual,
    adminFetch: vi.fn(),
    ensureBridge: vi.fn(),
    stopBridge: vi.fn(),
  };
});

vi.mock("../src/config/sandbox-allow.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/sandbox-allow.js")>(
    "../src/config/sandbox-allow.js"
  );
  return { ...actual, ensureSandboxAllowlist: vi.fn() };
});

vi.mock("../src/tunnel/named-provision.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tunnel/named-provision.js")>(
    "../src/tunnel/named-provision.js"
  );
  return { ...actual, chooseQuickTunnel: vi.fn(), provisionNamedTunnel: vi.fn() };
});

const { runCli } = await import("../src/cli/index.js");
const observeMock = vi.mocked(findBridgeObservation);
const adminFetchMock = vi.mocked(adminFetch);
const ensureBridgeMock = vi.mocked(ensureBridge);
const stopBridgeMock = vi.mocked(stopBridge);
const sandboxMock = vi.mocked(ensureSandboxAllowlist);
const chooseQuickTunnelMock = vi.mocked(chooseQuickTunnel);
const provisionNamedTunnelMock = vi.mocked(provisionNamedTunnel);
const temporaryDirs: string[] = [];

function runtimeFor(root: string): RuntimeState {
  return {
    service: "codex-bridge",
    version: "test",
    workspaceId: new Workspace(root).id,
    workspaceRoot: root,
    pid: process.pid,
    port: 48765,
    adminToken: "test-admin-token",
    publicUrl: null,
    startedAt: new Date(0).toISOString(),
  };
}

function healthy(root: string): BridgeObservation {
  const runtime = runtimeFor(root);
  return {
    state: "healthy",
    runtime,
    health: { service: runtime.service, version: runtime.version, workspaceId: runtime.workspaceId, status: "ok" },
  };
}

function stopped(): BridgeObservation {
  return { state: "stopped", runtime: null, reason: "runtime_missing" };
}

function unknown(reason: "probe_failed" | "runtime_unreadable" = "probe_failed"): BridgeObservation {
  return { state: "unknown", runtime: null, reason };
}

function track(name: string): string {
  const root = makeTmpDir(name);
  temporaryDirs.push(root);
  return root;
}

function captureOutput(): () => string {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  return () => output;
}

beforeEach(() => {
  isolateStateDir();
  process.exitCode = 0;
  sandboxMock.mockReturnValue({
    added: false,
    alreadyAllowed: true,
    stateDir: "/isolated/c2c-state",
    configPath: "/isolated/codex-config.toml",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = 0;
  while (temporaryDirs.length) cleanup(temporaryDirs.pop()!);
});

describe("CLI bridge observation safety", () => {
  it("reports status unknown instead of claiming the bridge is stopped", async () => {
    const root = track("cli-status-unknown");
    observeMock.mockResolvedValueOnce(unknown());
    const output = captureOutput();

    await runCli(["node", "c2c", "status", "--workspace", root, "--json"]);

    expect(JSON.parse(output())).toMatchObject({ ok: false, state: "unknown", running: null, reason: "probe_failed" });
    expect(adminFetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("preserves the stopped status result", async () => {
    const root = track("cli-status-stopped");
    observeMock.mockResolvedValueOnce(stopped());
    const output = captureOutput();

    await runCli(["node", "c2c", "status", "--workspace", root, "--json"]);

    expect(JSON.parse(output())).toEqual({ ok: false, running: false });
    expect(process.exitCode).toBe(0);
  });

  it("does not auto-repair or propose connector repair when doctor cannot observe the bridge", async () => {
    const root = track("cli-doctor-unknown");
    const workspace = new Workspace(root);
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: "https://old.example.com",
      mcpUrl: "https://old.example.com/mcp",
      connectorName: "Codex with ChatGPT · test",
    });
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date(0).toISOString(),
      tunnelName: "test-tunnel",
      hostname: "c2c-test.example.com",
    });
    observeMock.mockResolvedValueOnce(unknown("runtime_unreadable"));
    const output = captureOutput();

    await runCli(["node", "c2c", "doctor", "--workspace", root, "--json"]);

    const payload = JSON.parse(output());
    expect(payload.report.bridge).toMatchObject({ ok: false });
    expect(payload.report.bridge.detail).toContain("状态无法确认");
    expect(payload.report.tunnel).toMatchObject({ ok: false });
    expect(payload.chatgptRepair.needed).toBe(false);
    expect(payload.namedRepair.needed).toBe(false);
    expect(ensureBridgeMock).not.toHaveBeenCalled();
    expect(adminFetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses quick tunnel changes when bridge state is unknown", async () => {
    const root = track("cli-tunnel-quick-unknown");
    observeMock.mockResolvedValueOnce(unknown());
    const output = captureOutput();

    await runCli(["node", "c2c", "tunnel", "choose", "--mode", "quick", "--workspace", root, "--json"]);

    expect(JSON.parse(output())).toMatchObject({ ok: false });
    expect(chooseQuickTunnelMock).not.toHaveBeenCalled();
    expect(stopBridgeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses named tunnel provisioning when bridge state is unknown", async () => {
    const root = track("cli-tunnel-named-unknown");
    observeMock.mockResolvedValueOnce(unknown());
    const output = captureOutput();

    await runCli([
      "node",
      "c2c",
      "tunnel",
      "choose",
      "--mode",
      "named",
      "--zone",
      "example.com",
      "--workspace",
      root,
      "--json",
    ]);

    expect(JSON.parse(output())).toMatchObject({ ok: false });
    expect(provisionNamedTunnelMock).not.toHaveBeenCalled();
    expect(stopBridgeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("refuses unpair when bridge state is unknown", async () => {
    const root = track("cli-unpair-unknown");
    observeMock.mockResolvedValueOnce(unknown());

    await expect(runCli(["node", "c2c", "unpair", "--workspace", root])).rejects.toThrow(
      /Bridge state is unknown.*refusing to revoke access/
    );

    expect(adminFetchMock).not.toHaveBeenCalled();
  });

  it("keeps healthy status behavior and reads admin info only after a healthy observation", async () => {
    const root = track("cli-status-healthy");
    const observation = healthy(root);
    observeMock.mockResolvedValueOnce(observation);
    adminFetchMock.mockResolvedValueOnce({
      workspaceId: observation.runtime.workspaceId,
      workspaceName: "test-workspace",
      workspaceRoot: root,
      port: observation.runtime.port,
      publicUrl: null,
      tunnel: { running: false, url: null, provider: "none" },
      tokenCount: 1,
      pairingActive: false,
      pid: observation.runtime.pid,
      startedAt: observation.runtime.startedAt,
    });
    const output = captureOutput();

    await runCli(["node", "c2c", "status", "--workspace", root, "--json"]);

    expect(JSON.parse(output())).toMatchObject({ ok: true, running: true, workspaceName: "test-workspace" });
    expect(adminFetchMock).toHaveBeenCalledWith(observation.runtime, "GET", "/admin/info");
    expect(process.exitCode).toBe(0);
  });
});
