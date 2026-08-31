import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { findBridgeObservation, SERVICE_NAME, VERSION, type BridgeObservation, type RuntimeState } from "../src/bridge/runtime.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../src/bridge/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/bridge/runtime.js")>("../src/bridge/runtime.js");
  return { ...actual, findBridgeObservation: vi.fn() };
});

const spawnMock = vi.mocked(spawn);
const observeMock = vi.mocked(findBridgeObservation);
const temporaryDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  while (temporaryDirs.length) cleanup(temporaryDirs.pop()!);
});

function runtimeFor(root: string): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
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
    health: { service: SERVICE_NAME, version: VERSION, workspaceId: runtime.workspaceId, status: "ok" },
  };
}

function stopped(): BridgeObservation {
  return { state: "stopped", runtime: null, reason: "runtime_missing" };
}

function unknown(): BridgeObservation {
  return { state: "unknown", runtime: null, reason: "runtime_unreadable" };
}

function makeChild(): ChildProcess {
  return { exitCode: null, unref: vi.fn() } as unknown as ChildProcess;
}

describe("daemon lifecycle safety", () => {
  it("reuses an observed healthy bridge without spawning", async () => {
    const root = makeTmpDir("daemon-healthy");
    temporaryDirs.push(root);
    const observation = healthy(root);
    observeMock.mockResolvedValueOnce(observation);

    await expect(ensureBridge(root)).resolves.toEqual({ runtime: observation.runtime, spawned: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses to spawn when bridge state is unknown", async () => {
    const root = makeTmpDir("daemon-unknown");
    temporaryDirs.push(root);
    observeMock.mockResolvedValueOnce(unknown());

    await expect(ensureBridge(root)).rejects.toThrow(/state is unknown.*refusing to start/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns once after a definite stopped observation", async () => {
    const root = makeTmpDir("daemon-stopped");
    temporaryDirs.push(root);
    const observation = healthy(root);
    observeMock.mockResolvedValueOnce(stopped()).mockResolvedValueOnce(observation);
    spawnMock.mockReturnValue(makeChild());

    await expect(ensureBridge(root)).resolves.toEqual({ runtime: observation.runtime, spawned: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not signal a bridge that is definitely stopped", async () => {
    const root = makeTmpDir("stop-stopped");
    temporaryDirs.push(root);
    observeMock.mockResolvedValueOnce(stopped());
    const kill = vi.spyOn(process, "kill");
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(stopBridge(root)).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses to stop a bridge when state is unknown", async () => {
    const root = makeTmpDir("stop-unknown");
    temporaryDirs.push(root);
    observeMock.mockResolvedValueOnce(unknown());
    const kill = vi.spyOn(process, "kill");
    const fetch = vi.spyOn(globalThis, "fetch");

    await expect(stopBridge(root)).rejects.toThrow(/state is unknown.*refusing to stop/i);
    expect(kill).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses authenticated shutdown for an observed healthy bridge", async () => {
    const root = makeTmpDir("stop-healthy");
    temporaryDirs.push(root);
    observeMock.mockResolvedValueOnce(healthy(root));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const kill = vi.spyOn(process, "kill");

    await expect(stopBridge(root)).resolves.toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("only falls back to SIGTERM after a healthy observation", async () => {
    const root = makeTmpDir("stop-fallback");
    temporaryDirs.push(root);
    const observation = healthy(root);
    observeMock.mockResolvedValueOnce(observation);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("shutdown unavailable"));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(stopBridge(root)).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(observation.runtime.pid, "SIGTERM");
  });
});
