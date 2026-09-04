import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { ensureBridge, stopBridge, withBridgeStartLock } from "../src/process/daemon.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "c2c_admin_abcdefghijklmnop",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

function fakeChildProcess(): { child: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess;
  const kill = vi.fn(() => true);
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    pid: 123_456,
    unref: vi.fn(() => child),
    kill,
  });
  return { child, kill };
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats malformed runtime state as unknown and refuses a duplicate bridge", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const root = makeTmpDir("obs-invalid-runtime");
    dirs.push(root);
    const workspace = new Workspace(root);
    fs.writeFileSync(runtimeFile(workspace.id), "{");

    expect(() => readRuntimeState(workspace.id)).toThrow(/unreadable or malformed/);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation).toEqual({ state: "unknown", runtime: null, reason: "runtime_invalid" });
    await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
  });

  it("validates all persisted runtime fields", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const root = makeTmpDir("runtime-schema");
    dirs.push(root);
    const workspace = new Workspace(root);
    const valid = stubRuntime(workspace.id, workspace.root, process.pid, 48_765);
    writeRuntimeState(valid);
    const file = runtimeFile(workspace.id);
    const mutations: Array<(state: Record<string, unknown>) => void> = [
      (state) => { state.service = "other"; },
      (state) => { state.workspaceId = "../other"; },
      (state) => { state.workspaceRoot = "relative/path"; },
      (state) => { state.pid = 0; },
      (state) => { state.port = 65_536; },
      (state) => { state.adminToken = "weak"; },
      (state) => { state.publicUrl = "http://example.com"; },
      (state) => { state.startedAt = "today"; },
      (state) => { state.unexpected = true; },
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(valid) as unknown as Record<string, unknown>;
      mutate(invalid);
      fs.writeFileSync(file, JSON.stringify(invalid));
      expect(() => readRuntimeState(workspace.id)).toThrow();
    }
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
      await expect(stopBridge(root)).rejects.toThrow(/refusing to signal unverified PID/);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it("serializes asynchronous bridge startup work for the same workspace", async () => {
    dirs.push(isolateStateDir());
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withBridgeStartLock("serial-workspace", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await firstGate;
      active--;
      return "first";
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = withBridgeStartLock("serial-workspace", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      active--;
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxActive).toBe(1);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(maxActive).toBe(1);
  });

  it("fails immediately when the detached child emits a spawn error", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("spawn-error");
    dirs.push(root);
    const { child, kill } = fakeChildProcess();
    const spawnImpl = (() => {
      setImmediate(() => child.emit("error", new Error("spawn denied")));
      return child;
    }) as typeof spawn;

    await expect(
      ensureBridge(root, { spawnImpl, startTimeoutMs: 1_000, pollIntervalMs: 5 })
    ).rejects.toThrow(/failed to start: spawn denied/);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails when the detached child exits cleanly before health is ready", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("early-exit");
    dirs.push(root);
    const { child } = fakeChildProcess();
    const spawnImpl = (() => {
      setImmediate(() => {
        Object.assign(child, { exitCode: 0 });
        child.emit("exit", 0, null);
      });
      return child;
    }) as typeof spawn;

    await expect(
      ensureBridge(root, { spawnImpl, startTimeoutMs: 1_000, pollIntervalMs: 5 })
    ).rejects.toThrow(/exited with code 0 before becoming healthy/);
  });

  it("terminates the spawned child when bridge health times out", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("spawn-timeout");
    dirs.push(root);
    const { child, kill } = fakeChildProcess();
    const spawnImpl = (() => child) as typeof spawn;

    await expect(
      ensureBridge(root, { spawnImpl, startTimeoutMs: 20, pollIntervalMs: 5 })
    ).rejects.toThrow(/within 20ms/);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});
