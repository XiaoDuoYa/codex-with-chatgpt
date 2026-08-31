import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
}

export type BridgeProbeFailureReason =
  | "probe_failed"
  | "timeout"
  | "http_error"
  | "invalid_response"
  | "wrong_service";

export type BridgeProbeResult =
  | { state: "healthy"; health: HealthPayload }
  | { state: "unknown"; reason: BridgeProbeFailureReason };

function isHealthPayload(value: unknown): value is HealthPayload {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.service === "string" &&
    typeof body.version === "string" &&
    typeof body.workspaceId === "string" &&
    typeof body.status === "string"
  );
}

function probeFailureReason(error: unknown): BridgeProbeFailureReason {
  return error instanceof Error && error.name === "AbortError" ? "timeout" : "probe_failed";
}

/** Probe a port without collapsing an inconclusive result into "stopped". */
export async function probeBridgeState(
  port: number,
  timeoutMs = 2000
): Promise<BridgeProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return { state: "unknown", reason: "http_error" };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { state: "unknown", reason: "invalid_response" };
    }
    if (!isHealthPayload(body)) return { state: "unknown", reason: "invalid_response" };
    if (body.service !== SERVICE_NAME) return { state: "unknown", reason: "wrong_service" };
    return { state: "healthy", health: body };
  } catch (error) {
    return { state: "unknown", reason: probeFailureReason(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compatibility wrapper for callers that have not migrated to the tri-state
 * API yet. Mutation-sensitive callers must use findBridgeObservation instead.
 */
export async function probeBridge(port: number, timeoutMs = 2000): Promise<HealthPayload | null> {
  const result = await probeBridgeState(port, timeoutMs);
  return result.state === "healthy" ? result.health : null;
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState; health: HealthPayload }
  | {
      state: "stopped";
      runtime: RuntimeState | null;
      reason: "runtime_missing" | "pid_missing";
    }
  | {
      state: "unknown";
      runtime: RuntimeState | null;
      reason: BridgeProbeFailureReason | "runtime_unreadable" | "workspace_mismatch";
    };

type RuntimeReadResult =
  | { state: "missing" }
  | { state: "present"; runtime: RuntimeState }
  | { state: "unreadable" };

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.service === "string" &&
    typeof state.version === "string" &&
    typeof state.workspaceId === "string" &&
    typeof state.workspaceRoot === "string" &&
    Number.isInteger(state.pid) &&
    Number.isInteger(state.port) &&
    typeof state.adminToken === "string" &&
    (typeof state.publicUrl === "string" || state.publicUrl === null) &&
    typeof state.startedAt === "string"
  );
}

function readRuntimeStateForObservation(workspaceId: string): RuntimeReadResult {
  const file = path.join(getStateDir(), "runtime", `${workspaceId}.json`);
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unreadable" };
  }

  try {
    const runtime = JSON.parse(contents) as unknown;
    return isRuntimeState(runtime) && runtime.workspaceId === workspaceId
      ? { state: "present", runtime }
      : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

type PidObservation = "present" | "missing" | "unknown";

function observePid(pid: number): PidObservation {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

/**
 * Observe the bridge with enough context to distinguish stopped from unknown.
 * Observation is read-only: it never clears runtime state or changes a process.
 */
export async function findBridgeObservation(workspaceId: string, timeoutMs = 2000): Promise<BridgeObservation> {
  const stored = readRuntimeStateForObservation(workspaceId);
  if (stored.state === "missing") {
    return { state: "stopped", runtime: null, reason: "runtime_missing" };
  }
  if (stored.state === "unreadable") {
    return { state: "unknown", runtime: null, reason: "runtime_unreadable" };
  }

  const probe = await probeBridgeState(stored.runtime.port, timeoutMs);
  if (probe.state === "healthy") {
    if (probe.health.workspaceId !== workspaceId) {
      return { state: "unknown", runtime: stored.runtime, reason: "workspace_mismatch" };
    }
    return { state: "healthy", runtime: stored.runtime, health: probe.health };
  }

  return observePid(stored.runtime.pid) === "missing"
    ? { state: "stopped", runtime: stored.runtime, reason: "pid_missing" }
    : { state: "unknown", runtime: stored.runtime, reason: probe.reason };
}

/** Short alias for callers that prefer an observation-oriented name. */
export const observeBridge = findBridgeObservation;

/**
 * Compatibility wrapper for the pre-tri-state lifecycle API. It is retained
 * only while mutation-sensitive callers migrate to findBridgeObservation.
 */
export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const result = await findBridgeObservation(workspaceId);
  return result.state === "healthy" ? result.runtime : null;
}

export { SERVICE_NAME, VERSION };
