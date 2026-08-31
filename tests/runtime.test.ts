import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findBridgeObservation,
  SERVICE_NAME,
  VERSION,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const stateDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (stateDirs.length) cleanup(stateDirs.pop()!);
});

function runtime(workspaceId: string, pid = process.pid): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot: "/tmp/c2c-runtime-test",
    pid,
    port: 48765,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date(0).toISOString(),
  };
}

describe("tri-state bridge observation", () => {
  it("reports a missing runtime record as stopped", async () => {
    stateDirs.push(isolateStateDir());

    await expect(findBridgeObservation("missing-workspace")).resolves.toEqual({
      state: "stopped",
      runtime: null,
      reason: "runtime_missing",
    });
  });

  it("reports a failed probe as unknown when the recorded process still exists", async () => {
    stateDirs.push(isolateStateDir());
    writeRuntimeState(runtime("probe-failed"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("loopback denied"));

    await expect(findBridgeObservation("probe-failed")).resolves.toMatchObject({
      state: "unknown",
      reason: "probe_failed",
    });
  });

  it("keeps PID inspection failures unknown", async () => {
    stateDirs.push(isolateStateDir());
    writeRuntimeState(runtime("pid-inaccessible"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("probe failed"));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    await expect(findBridgeObservation("pid-inaccessible")).resolves.toMatchObject({
      state: "unknown",
      reason: "probe_failed",
    });
  });

  it("reports a positively absent recorded process as stopped", async () => {
    stateDirs.push(isolateStateDir());
    writeRuntimeState(runtime("stale-runtime", 999_999_999));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("probe failed"));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    await expect(findBridgeObservation("stale-runtime")).resolves.toMatchObject({
      state: "stopped",
      reason: "pid_missing",
    });
  });
});
