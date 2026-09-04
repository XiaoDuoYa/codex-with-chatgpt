import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMachineRuntime,
  machineRuntimeFile,
  readMachineRuntime,
  writeMachineRuntime,
  type MachineRuntimeState,
} from "../src/gateway/runtime.js";
import {
  ensureMachineGateway,
  machineMcpCommand,
  restoreMachineGateway,
  stopMachineGateway,
  withMachineSetupLock,
  withMachineStartLock,
  type ManagedTunnelFunctions,
} from "../src/process/machine-daemon.js";
import { runtimeEntryPath } from "../src/config/runtime-install.js";
import { createOpenAiTunnelConfig, type OpenAiTunnelRuntimeStatus } from "../src/tunnel/openai-secure.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const cleanupDirs: string[] = [];
const READY: OpenAiTunnelRuntimeStatus = {
  ok: true,
  processRunning: true,
  healthy: true,
  ready: true,
  detail: "ready",
};
const STOPPED: OpenAiTunnelRuntimeStatus = {
  ok: false,
  processRunning: false,
  healthy: false,
  ready: false,
  detail: "stopped",
};
const ASSOCIATION_ID = `assoc-${"c".repeat(32)}`;
const ASSOCIATION_NONCE = "n".repeat(43);

function runtime(overrides: Partial<MachineRuntimeState> = {}): MachineRuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    machineId: `machine-${"a".repeat(32)}`,
    associationId: ASSOCIATION_ID,
    associationNonce: ASSOCIATION_NONCE,
    bootEpoch: "b".repeat(32),
    pid: process.pid,
    port: 48_765,
    adminToken: `c2c_admin_${"x".repeat(32)}`,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function healthFor(machine: MachineRuntimeState): Response {
  return new Response(
    JSON.stringify({
      service: machine.service,
      version: machine.version,
      machineId: machine.machineId,
      associationId: machine.associationId,
      bootEpoch: machine.bootEpoch,
      status: "ok",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function config() {
  return createOpenAiTunnelConfig({
    tunnelId: `tunnel_${"1".repeat(32)}`,
    stateRoot: process.env.C2C_STATE_DIR,
    associationId: ASSOCIATION_ID,
    associationNonce: ASSOCIATION_NONCE,
  });
}

function statusFor(configured: ReturnType<typeof config>, status: OpenAiTunnelRuntimeStatus): OpenAiTunnelRuntimeStatus {
  return {
    ...status,
    alias: status.alias ?? configured.alias,
    tunnelId: status.tunnelId ?? configured.tunnelId,
    processTunnelId: status.processTunnelId ?? configured.tunnelId,
    profilePath: status.profilePath ?? path.join(configured.profileDir, `${configured.profileName}.yaml`),
    processProfilePath: status.processProfilePath ?? path.join(configured.profileDir, `${configured.profileName}.yaml`),
    targetKind: status.targetKind ?? "command",
    targetValue: status.targetValue ?? machineMcpCommand(configured),
    pid: status.pid ?? process.pid,
  };
}

function functions(overrides: Partial<ManagedTunnelFunctions> = {}): ManagedTunnelFunctions {
  const status = overrides.status ?? vi.fn(() => STOPPED);
  const connect = overrides.connect ?? vi.fn(() => READY);
  return {
    status: vi.fn((configured, dependencies) => statusFor(configured, status(configured, dependencies))),
    connect: vi.fn((configured, command, dependencies) => statusFor(configured, connect(configured, command, dependencies))),
    stop: overrides.stop ?? vi.fn(() => ({ stopped: true, detail: "stopped" })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearMachineRuntime();
  for (const dir of cleanupDirs.splice(0)) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

describe("tunnel-owned machine gateway lifecycle", () => {
  it("uses the tunnel config state root for the supervised runtime command", () => {
    const configuredState = isolateStateDir();
    const ambientState = isolateStateDir();
    const command = machineMcpCommand(
      createOpenAiTunnelConfig({
        tunnelId: `tunnel_${"1".repeat(32)}`,
        stateRoot: configuredState,
        associationId: ASSOCIATION_ID,
        associationNonce: ASSOCIATION_NONCE,
      }),
    );

    expect(command).toContain(runtimeEntryPath(configuredState));
    expect(command).not.toContain(runtimeEntryPath(ambientState));
  });

  it("reuses a healthy gateway only when the official tunnel is ready", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const managed = functions({ status: vi.fn(() => READY) });

    await expect(ensureMachineGateway({ config: config(), tunnelFunctions: managed })).resolves.toMatchObject({
      runtime: machine,
      spawned: false,
      tunnel: READY,
    });
    expect(managed.connect).not.toHaveBeenCalled();
  });

  it("refuses a healthy standalone gateway instead of creating a split broker", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const managed = functions();

    await expect(ensureMachineGateway({ config: config(), tunnelFunctions: managed })).rejects.toThrow(
      /outside the configured OpenAI tunnel/
    );
    expect(managed.connect).not.toHaveBeenCalled();
  });

  it("starts only through tunnel-client with the stdio machine command", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    let running = false;
    const connect = vi.fn((_config, command: string) => {
      expect(command).toContain("serve-machine");
      expect(command).toContain("--stdio");
      writeMachineRuntime(machine);
      running = true;
      return READY;
    });
    const managed = functions({
      connect,
      status: vi.fn(() => (running ? READY : STOPPED)),
    });

    await expect(
      ensureMachineGateway({
        config: config(),
        tunnelFunctions: managed,
        pollIntervalMs: 1,
        startTimeoutMs: 500,
      })
    ).resolves.toMatchObject({ runtime: machine, spawned: true });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(machineMcpCommand(config())).toMatch(/serve-machine.*--stdio.*--port.*0/);
    expect(machineMcpCommand(config())).not.toContain(ASSOCIATION_NONCE);
    expect(machineMcpCommand(config())).not.toContain(ASSOCIATION_ID);
  });

  it("stops the supervisor rather than calling the child admin shutdown", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const stop = vi.fn(() => {
      clearMachineRuntime();
      return { stopped: true, detail: "stopped" };
    });
    const managed = functions({ status: vi.fn(() => READY), stop });

    await expect(
      stopMachineGateway({ config: config(), tunnelFunctions: managed, pollIntervalMs: 1, stopTimeoutMs: 500 })
    ).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops a degraded but exactly owned tunnel runtime", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const stop = vi.fn(() => {
      clearMachineRuntime();
      return { stopped: true, detail: "stopped" };
    });
    const managed = functions({
      status: vi.fn(() => ({
        ...READY,
        ok: false,
        healthy: false,
        ready: false,
        detail: "degraded",
      })),
      stop,
    });

    await expect(
      stopMachineGateway({ config: config(), tunnelFunctions: managed, pollIntervalMs: 1, stopTimeoutMs: 500 })
    ).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when the configured tunnel alias is already stopped", async () => {
    cleanupDirs.push(isolateStateDir());
    const stop = vi.fn(() => ({ stopped: true, detail: "unexpected" }));
    const managed = functions({ status: vi.fn(() => STOPPED), stop });

    await expect(stopMachineGateway({ config: config(), tunnelFunctions: managed })).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("clears only the exact stale runtime record when the tunnel alias is gone", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime({ pid: 999_999_999 });
    writeMachineRuntime(machine);
    const stop = vi.fn(() => ({ stopped: true, detail: "unexpected" }));
    const managed = functions({ status: vi.fn(() => STOPPED), stop });

    await expect(stopMachineGateway({ config: config(), tunnelFunctions: managed })).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(readMachineRuntime()).toBeNull();
  });

  it("refuses to stop a tunnel runtime with a mismatched identity", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const stop = vi.fn(() => ({ stopped: true, detail: "stopped" }));
    const managed = functions({
      status: vi.fn(() => ({ ...READY, targetValue: "\"/tmp/other-gateway\"" })),
      stop,
    });

    await expect(
      stopMachineGateway({ config: config(), tunnelFunctions: managed, pollIntervalMs: 1, stopTimeoutMs: 500 })
    ).rejects.toThrow(/refusing to stop/i);
    expect(stop).not.toHaveBeenCalled();
    expect(readMachineRuntime()).toEqual(machine);
  });

  it("refuses to stop a running alias when its gateway record is missing", async () => {
    cleanupDirs.push(isolateStateDir());
    const stop = vi.fn(() => ({ stopped: true, detail: "unexpected" }));
    const managed = functions({ status: vi.fn(() => READY), stop });

    await expect(
      stopMachineGateway({ config: config(), tunnelFunctions: managed, pollIntervalMs: 1, stopTimeoutMs: 500 }),
    ).rejects.toThrow(/ownership record is missing.*refusing to stop/i);
    expect(stop).not.toHaveBeenCalled();
  });

  it("serializes machine startup attempts with one machine-wide lock", async () => {
    cleanupDirs.push(isolateStateDir());
    let active = 0;
    let maximum = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withMachineStartLock(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return "first";
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = withMachineStartLock(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      active -= 1;
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maximum).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });

  it("serializes complete setup transactions with a machine-wide lock", async () => {
    cleanupDirs.push(isolateStateDir());
    let active = 0;
    let maximum = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withMachineSetupLock(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return "first";
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = withMachineSetupLock(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      active -= 1;
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maximum).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  });

  it("requires a fresh ownership epoch when replacing a tunnel", async () => {
    cleanupDirs.push(isolateStateDir());
    const previous = runtime({ bootEpoch: "1".repeat(32), pid: process.pid });
    const next = runtime({ bootEpoch: "2".repeat(32), pid: process.pid });
    vi.stubGlobal("fetch", vi.fn(async () => {
      const current = readMachineRuntime();
      return current ? healthFor(current) : new Response("stopped", { status: 503 });
    }));
    let running = false;
    const managed = functions({
      status: vi.fn(() => (running ? READY : STOPPED)),
      connect: vi.fn(() => {
        writeMachineRuntime(next);
        running = true;
        return READY;
      }),
    });

    await expect(ensureMachineGateway({
      config: config(),
      tunnelFunctions: managed,
      requireFreshRuntime: true,
      previousRuntime: previous,
      pollIntervalMs: 1,
      startTimeoutMs: 500,
    })).resolves.toMatchObject({ runtime: next, spawned: true });
  });

  it("rejects a replacement that reuses the previous ownership epoch", async () => {
    cleanupDirs.push(isolateStateDir());
    const previous = runtime({ bootEpoch: "1".repeat(32), pid: process.pid });
    vi.stubGlobal("fetch", vi.fn(async () => {
      const current = readMachineRuntime();
      return current ? healthFor(current) : new Response("stopped", { status: 503 });
    }));
    let running = false;
    const stop = vi.fn(() => {
      clearMachineRuntime();
      running = false;
      return { stopped: true, detail: "stopped" };
    });
    const managed = functions({
      status: vi.fn(() => (running ? READY : STOPPED)),
      connect: vi.fn(() => {
        writeMachineRuntime(previous);
        running = true;
        return READY;
      }),
      stop,
    });

    await expect(ensureMachineGateway({
      config: config(),
      tunnelFunctions: managed,
      requireFreshRuntime: true,
      previousRuntime: previous,
      pollIntervalMs: 1,
      startTimeoutMs: 500,
    })).rejects.toThrow(/ownership epoch did not change/);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(readMachineRuntime()).toBeNull();
  });

  it("stops a supervisor whose gateway never becomes healthy", async () => {
    cleanupDirs.push(isolateStateDir());
    let running = false;
    const stop = vi.fn(() => {
      running = false;
      return { stopped: true, detail: "stopped" };
    });
    const managed = functions({
      status: vi.fn(() => (running ? READY : STOPPED)),
      connect: vi.fn(() => {
        running = true;
        return READY;
      }),
      stop,
    });

    await expect(ensureMachineGateway({
      config: config(),
      tunnelFunctions: managed,
      pollIntervalMs: 1,
      startTimeoutMs: 10,
    })).rejects.toThrow(/did not become healthy/);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(running).toBe(false);
  });

  it("rechecks and stops a newly started exact runtime when connect throws after its side effect", async () => {
    cleanupDirs.push(isolateStateDir());
    let running = false;
    const connect = vi.fn(() => {
      running = true;
      throw new Error("connect failed after starting the runtime");
    });
    const stop = vi.fn(() => {
      running = false;
      return { stopped: true, detail: "stopped" };
    });
    const managed = functions({
      status: vi.fn(() => (running ? READY : STOPPED)),
      connect,
      stop,
    });

    await expect(ensureMachineGateway({
      config: config(),
      tunnelFunctions: managed,
      pollIntervalMs: 1,
      startTimeoutMs: 500,
    })).rejects.toThrow(/connect failed after starting/i);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(managed.status).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(running).toBe(false);
    expect(readMachineRuntime()).toBeNull();
  });

  it("does not stop a runtime created after connect throws when its target identity changed", async () => {
    cleanupDirs.push(isolateStateDir());
    let running = false;
    const connect = vi.fn(() => {
      running = true;
      throw new Error("connect failed after starting the runtime");
    });
    const stop = vi.fn(() => ({ stopped: true, detail: "unexpected" }));
    const managed = functions({
      status: vi.fn(() => running ? { ...READY, targetValue: '"/tmp/unmanaged"' } : STOPPED),
      connect,
      stop,
    });

    await expect(ensureMachineGateway({
      config: config(),
      tunnelFunctions: managed,
      pollIntervalMs: 1,
      startTimeoutMs: 500,
    })).rejects.toThrow(/startup cleanup failed/i);
    expect(stop).not.toHaveBeenCalled();
    expect(running).toBe(true);
  });

  it("refuses to replace a running alias when its gateway record is missing and identity mismatches", async () => {
    cleanupDirs.push(isolateStateDir());
    const connect = vi.fn(() => READY);
    const stop = vi.fn(() => ({ stopped: true, detail: "unexpected" }));
    const managed = functions({
      status: vi.fn(() => ({ ...READY, tunnelId: `tunnel_${"2".repeat(32)}` })),
      connect,
      stop,
    });

    await expect(ensureMachineGateway({ config: config(), tunnelFunctions: managed })).rejects.toThrow(
      /already running.*refusing to replace/i,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(readMachineRuntime()).toBeNull();
  });

  it("observes an already healthy previous gateway before restoring it", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const connect = vi.fn(() => READY);
    const managed = functions({ status: vi.fn(() => READY), connect });

    await expect(restoreMachineGateway({ config: config(), tunnelFunctions: managed })).resolves.toMatchObject({
      runtime: machine,
      spawned: false,
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("ensures a stopped previous gateway after rollback observation", async () => {
    cleanupDirs.push(isolateStateDir());
    let running = false;
    const machine = runtime({ bootEpoch: "e".repeat(32) });
    vi.stubGlobal("fetch", vi.fn(async () => {
      const current = readMachineRuntime();
      return current && running ? healthFor(current) : new Response("stopped", { status: 503 });
    }));
    const managed = functions({
      status: vi.fn(() => (running ? READY : STOPPED)),
      connect: vi.fn(() => {
        running = true;
        writeMachineRuntime(machine);
        return READY;
      }),
    });

    await expect(restoreMachineGateway({
      config: config(),
      tunnelFunctions: managed,
      pollIntervalMs: 1,
      startTimeoutMs: 500,
    })).resolves.toMatchObject({ runtime: machine, spawned: true });
    expect(managed.connect).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a healthy gateway with a different tunnel association", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime({ associationId: `assoc-${"d".repeat(32)}` });
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const managed = functions({ status: vi.fn(() => READY) });

    await expect(ensureMachineGateway({ config: config(), tunnelFunctions: managed })).rejects.toThrow(
      /not the exact child/
    );
    expect(managed.connect).not.toHaveBeenCalled();
  });

  it("does not reuse a healthy gateway with a different association nonce", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime({ associationNonce: "o".repeat(43) });
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const managed = functions({ status: vi.fn(() => READY) });

    await expect(ensureMachineGateway({ config: config(), tunnelFunctions: managed })).rejects.toThrow(
      /not the exact child/
    );
    expect(managed.connect).not.toHaveBeenCalled();
  });

  it("does not reuse a healthy gateway when tunnel status points at another stdio command", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    writeMachineRuntime(machine);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const managed = functions({
      status: vi.fn(() => ({ ...READY, targetValue: "\"/tmp/other-gateway\"" })),
    });

    await expect(ensureMachineGateway({ config: config(), tunnelFunctions: managed })).rejects.toThrow(
      /tunnel, profile, or stdio command does not match/
    );
    expect(managed.connect).not.toHaveBeenCalled();
  });

  it("does not accept a pre-association runtime record from an older release", async () => {
    cleanupDirs.push(isolateStateDir());
    const machine = runtime();
    const oldRuntime = { ...machine } as Record<string, unknown>;
    delete oldRuntime.associationId;
    delete oldRuntime.associationNonce;
    fs.writeFileSync(machineRuntimeFile(), JSON.stringify(oldRuntime));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthFor(machine)));
    const managed = functions({ status: vi.fn(() => READY) });

    await expect(ensureMachineGateway({ config: config(), tunnelFunctions: managed })).rejects.toThrow(
      /state is uncertain/
    );
    expect(managed.connect).not.toHaveBeenCalled();
  });
});
