import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ensureDir,
  getStateDir,
  readJsonIfExists,
  withFileLock,
  writeSecureJson,
  writeSecureJsonExclusive,
} from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

export interface MachineRuntimeState {
  service: string;
  version: string;
  machineId: string;
  associationId: string;
  associationNonce: string;
  bootEpoch: string;
  pid: number;
  port: number;
  adminToken: string;
  startedAt: string;
}

export const machineRuntimeSchema = z
  .object({
    service: z.literal(SERVICE_NAME),
    version: z.string().min(1).max(64),
    machineId: z.string().regex(/^machine-[a-f0-9]{32}$/),
    associationId: z.string().regex(/^assoc-[a-f0-9]{32}$/),
    associationNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    bootEpoch: z.string().regex(/^[a-f0-9]{32}$/),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    port: z.number().int().min(1).max(65_535),
    adminToken: z.string().regex(/^c2c_admin_[A-Za-z0-9_-]{32}$/),
    startedAt: z.string().datetime(),
  })
  .strict();

const lifetimeSchema = z
  .object({
    schemaVersion: z.literal(1),
    machineId: z.string().regex(/^machine-[a-f0-9]{32}$/),
    bootEpoch: z.string().regex(/^[a-f0-9]{32}$/),
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startedAt: z.string().datetime(),
  })
  .strict();

export type MachineLifetimeState = z.infer<typeof lifetimeSchema>;

export function machineRuntimeFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "machine.json");
}

export function machineLifetimeFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "machine-owner.json");
}

function machineLifetimeRecoveryLockFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "locks")), "machine-owner-recovery.lock");
}

function readMachineLifetime(): MachineLifetimeState | null {
  const file = machineLifetimeFile();
  const value = readJsonIfExists<unknown>(file);
  if (value === null) {
    if (fs.existsSync(file)) throw new Error("machine gateway ownership state is unreadable or malformed");
    return null;
  }
  const parsed = lifetimeSchema.safeParse(value);
  if (!parsed.success) throw new Error("machine gateway ownership state failed validation");
  return parsed.data;
}

function processExists(pid: number): "present" | "missing" | "unknown" {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

function sameLifetime(left: MachineLifetimeState, right: MachineLifetimeState): boolean {
  return (
    left.machineId === right.machineId &&
    left.bootEpoch === right.bootEpoch &&
    left.pid === right.pid &&
    left.startedAt === right.startedAt
  );
}

/**
 * Claim the one machine gateway process slot. The JSON owner record survives a
 * crash, so a later process may remove it only after the recorded PID is gone.
 */
export function acquireMachineLifetime(
  input: Omit<MachineLifetimeState, "schemaVersion">
): () => void {
  const claim = lifetimeSchema.parse({ schemaVersion: 1, ...input });
  const file = machineLifetimeFile();
  withFileLock(machineLifetimeRecoveryLockFile(), () => {
    const existing = readMachineLifetime();
    if (existing) {
      const state = processExists(existing.pid);
      if (state !== "missing") {
        throw new Error(
          state === "present"
            ? `machine gateway is already owned by PID ${existing.pid}`
            : `machine gateway owner PID ${existing.pid} cannot be verified`
        );
      }
      fs.rmSync(file, { force: true });
    }
    writeSecureJsonExclusive(file, claim);
  });

  let released = false;
  return () => {
    if (released) return;
    withFileLock(machineLifetimeRecoveryLockFile(), () => {
      const current = readMachineLifetime();
      if (current && sameLifetime(current, claim)) fs.rmSync(file, { force: true });
    });
    released = true;
  };
}

export function writeMachineRuntime(state: MachineRuntimeState): void {
  writeSecureJson(machineRuntimeFile(), machineRuntimeSchema.parse(state));
}

export function readMachineRuntime(): MachineRuntimeState | null {
  const file = machineRuntimeFile();
  const value = readJsonIfExists<unknown>(file);
  if (value === null) {
    if (fs.existsSync(file)) throw new Error("machine runtime is unreadable or malformed");
    return null;
  }
  const parsed = machineRuntimeSchema.safeParse(value);
  if (!parsed.success) throw new Error("machine runtime failed validation");
  return parsed.data;
}

export function clearMachineRuntime(): void {
  try {
    fs.rmSync(machineRuntimeFile(), { force: true });
  } catch {
    // Best effort during shutdown and stale-process recovery.
  }
}

export interface MachineHealthPayload {
  service: string;
  version: string;
  machineId: string;
  associationId: string;
  bootEpoch: string;
  status: "ok";
}

export async function probeMachineRuntime(
  runtime: MachineRuntimeState,
  timeoutMs = 2_000
): Promise<MachineHealthPayload | null> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = z
      .object({
        service: z.literal(SERVICE_NAME),
        version: z.string(),
        machineId: z.literal(runtime.machineId),
        associationId: z.literal(runtime.associationId),
        bootEpoch: z.literal(runtime.bootEpoch),
        status: z.literal("ok"),
      })
      .strict()
      .safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type MachineRuntimeObservation =
  | { state: "healthy"; runtime: MachineRuntimeState }
  | { state: "stopped"; runtime: MachineRuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | { state: "unknown"; runtime: MachineRuntimeState | null; reason: "runtime_invalid" | "probe_failed" | "pid_unknown" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

export async function observeMachineRuntime(): Promise<MachineRuntimeObservation> {
  let runtime: MachineRuntimeState | null;
  try {
    runtime = readMachineRuntime();
  } catch {
    return { state: "unknown", runtime: null, reason: "runtime_invalid" };
  }
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };
  if (await probeMachineRuntime(runtime)) return { state: "healthy", runtime };
  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}
