import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSessionLock,
  assertSessionLock,
  readSessionLock,
  refreshSessionLock,
  releaseSessionLock,
} from "../src/session/lock.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspaceId = "session-lock-test";
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
});

afterEach(() => {
  vi.useRealTimers();
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  cleanup(stateDir);
});

describe("workspace session lock", () => {
  it("serializes owners and only accepts the current token", async () => {
    const first = await acquireSessionLock(workspaceId, { taskId: "review-1", leaseMs: 5000 });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    expect(first.handle.token).toMatch(/^[A-Za-z0-9]/);

    const busy = await acquireSessionLock(workspaceId, { taskId: "review-2", waitMs: 0 });
    expect(busy).toMatchObject({ acquired: false, reason: "busy" });
    if (busy.acquired) return;

    expect(busy.info?.taskId).toBe("review-1");
    expect(() => assertSessionLock(workspaceId, "wrong-token")).toThrow("C2C_SESSION_LOCK_NOT_OWNER");
    expect(assertSessionLock(workspaceId, first.handle.token).taskId).toBe("review-1");

    const refreshed = refreshSessionLock(workspaceId, first.handle.token, 10_000);
    expect(refreshed.expiresAt).toBeGreaterThan(first.handle.info.expiresAt);
    expect(readSessionLock(workspaceId)).toMatchObject({ held: true, expired: false });

    releaseSessionLock(workspaceId, first.handle.token);
    expect(readSessionLock(workspaceId)).toEqual({ held: false, ownerAlive: false });
  });

  it("reclaims an expired lease without trusting the old token", async () => {
    vi.useFakeTimers();
    const first = await acquireSessionLock(workspaceId, { taskId: "stale-review", leaseMs: 10 });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    vi.advanceTimersByTime(25);
    expect(readSessionLock(workspaceId).expired).toBe(true);

    const replacement = await acquireSessionLock(workspaceId, { taskId: "fresh-review", waitMs: 100, pollMs: 5 });
    expect(replacement.acquired).toBe(true);
    if (!replacement.acquired) return;

    expect(replacement.handle.token).not.toBe(first.handle.token);
    expect(assertSessionLock(workspaceId, replacement.handle.token).taskId).toBe("fresh-review");
    expect(() => assertSessionLock(workspaceId, first.handle.token)).toThrow("C2C_SESSION_LOCK_NOT_OWNER");
    releaseSessionLock(workspaceId, replacement.handle.token);
  });

  it("reclaims a live lease immediately when its owner PID is dead", async () => {
    const deadPid = 2_000_000_000;
    const first = await acquireSessionLock(workspaceId, {
      taskId: "dead-owner",
      pid: deadPid,
      leaseMs: 60_000,
    });
    expect(first).toMatchObject({ acquired: true, recovered: false });
    if (!first.acquired) return;
    expect(readSessionLock(workspaceId)).toMatchObject({
      held: true,
      expired: false,
      ownerAlive: false,
    });

    const replacement = await acquireSessionLock(workspaceId, {
      taskId: "fresh-owner",
      waitMs: 0,
    });
    expect(replacement).toMatchObject({ acquired: true, recovered: false });
    if (!replacement.acquired) return;
    expect(replacement.handle.token).not.toBe(first.handle.token);
    expect(assertSessionLock(workspaceId, replacement.handle.token).taskId).toBe("fresh-owner");
    releaseSessionLock(workspaceId, replacement.handle.token);
  });

  it("reclaims immediately after the owner parent process exits", async () => {
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    if (owner.pid === undefined) throw new Error("failed to spawn lock owner");

    try {
      const first = await acquireSessionLock(workspaceId, {
        taskId: "child-owner",
        pid: owner.pid,
        leaseMs: 60_000,
      });
      expect(first).toMatchObject({ acquired: true, recovered: false });
      if (!first.acquired) return;
      expect(readSessionLock(workspaceId)).toMatchObject({
        held: true,
        expired: false,
        ownerAlive: true,
      });

      const exited = new Promise<void>((resolve, reject) => {
        owner.once("error", reject);
        owner.once("exit", () => resolve());
      });
      owner.kill();
      await exited;

      expect(readSessionLock(workspaceId)).toMatchObject({
        held: true,
        expired: false,
        ownerAlive: false,
      });
      const replacement = await acquireSessionLock(workspaceId, {
        taskId: "replacement-owner",
        waitMs: 0,
      });
      expect(replacement).toMatchObject({ acquired: true, recovered: false });
      if (!replacement.acquired) return;
      expect(replacement.handle.token).not.toBe(first.handle.token);
      releaseSessionLock(workspaceId, replacement.handle.token);
    } finally {
      if (owner.exitCode === null) owner.kill();
    }
  });

  it("rotates the token when the same owner and task reacquire", async () => {
    const first = await acquireSessionLock(workspaceId, {
      taskId: "same-task",
      pid: process.pid,
      leaseMs: 5_000,
    });
    expect(first).toMatchObject({ acquired: true, recovered: false });
    if (!first.acquired) return;

    const recovered = await acquireSessionLock(workspaceId, {
      taskId: "same-task",
      pid: process.pid,
      leaseMs: 10_000,
      waitMs: 0,
    });
    expect(recovered).toMatchObject({ acquired: true, recovered: true });
    if (!recovered.acquired) return;
    expect(recovered.handle.token).not.toBe(first.handle.token);
    expect(recovered.handle.info.expiresAt).toBeGreaterThan(first.handle.info.expiresAt);
    expect(readSessionLock(workspaceId).ownerAlive).toBe(true);
    expect(assertSessionLock(workspaceId, recovered.handle.token).taskId).toBe("same-task");
    expect(() => assertSessionLock(workspaceId, first.handle.token)).toThrow("C2C_SESSION_LOCK_NOT_OWNER");
    releaseSessionLock(workspaceId, recovered.handle.token);
  });

  it("keeps a live lock busy for a different task", async () => {
    const first = await acquireSessionLock(workspaceId, {
      taskId: "current-task",
      pid: process.pid,
      leaseMs: 60_000,
    });
    expect(first).toMatchObject({ acquired: true, recovered: false });
    if (!first.acquired) return;

    const busy = await acquireSessionLock(workspaceId, {
      taskId: "different-task",
      pid: process.pid,
      waitMs: 0,
    });
    expect(busy).toMatchObject({ acquired: false, reason: "busy", expired: false });
    if (!busy.acquired) expect(busy.info?.taskId).toBe("current-task");
    releaseSessionLock(workspaceId, first.handle.token);
  });

  it("does not mutate lock state while another transition owns the guard", async () => {
    const guardDir = path.join(stateDir, "locks", `mutation-${workspaceId}.lock`);
    fs.mkdirSync(guardDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(guardDir, "owner.json"),
      JSON.stringify({
        ownerId: "other-process",
        acquiredAt: new Date().toISOString(),
        expiresAt: Date.now() + 10_000,
      })
    );

    const result = await acquireSessionLock(workspaceId, { taskId: "blocked", waitMs: 0 });
    expect(result).toMatchObject({ acquired: false, reason: "busy" });
    expect(readSessionLock(workspaceId)).toEqual({ held: false, ownerAlive: false });
  });

  it("reclaims a stale transition guard before acquiring a lock", async () => {
    const guardDir = path.join(stateDir, "locks", `mutation-${workspaceId}.lock`);
    fs.mkdirSync(guardDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(guardDir, "owner.json"),
      JSON.stringify({
        ownerId: "crashed-process",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: Date.now() - 1,
      })
    );

    const result = await acquireSessionLock(workspaceId, { taskId: "recovered", waitMs: 0 });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    expect(assertSessionLock(workspaceId, result.handle.token).taskId).toBe("recovered");
    releaseSessionLock(workspaceId, result.handle.token);
  });
});
