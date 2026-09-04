import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { C2C_ID_PATTERN } from "../control/result-schema.js";
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

const safeIdSchema = z.string().regex(C2C_ID_PATTERN);
const canonicalTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  "timestamp must be canonical ISO-8601"
);
const publicUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  }, "public URL must be HTTPS")
  .nullable();
const runtimeStateSchema = z
  .object({
    service: z.literal(SERVICE_NAME),
    version: z.string().min(1).max(64),
    workspaceId: safeIdSchema,
    workspaceRoot: z.string().min(1).max(4_096).refine((value) => path.isAbsolute(value), "workspace root must be absolute"),
    pid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    port: z.number().int().min(1).max(65_535),
    adminToken: z.string().regex(/^c2c_admin_[A-Za-z0-9_-]{16,128}$/),
    publicUrl: publicUrlSchema,
    startedAt: canonicalTimestampSchema,
  })
  .strict();

function validatedWorkspaceId(workspaceId: string): string {
  const parsed = safeIdSchema.safeParse(workspaceId);
  if (!parsed.success || parsed.data !== workspaceId) throw new Error("runtime workspace id is invalid");
  return parsed.data;
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${validatedWorkspaceId(workspaceId)}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  const parsed = runtimeStateSchema.parse(state);
  writeSecureJson(runtimeFile(parsed.workspaceId), parsed);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const file = runtimeFile(resolvedWorkspaceId);
  const value = readJsonIfExists<unknown>(file);
  if (value === null) {
    if (fs.existsSync(file)) throw new Error("runtime state is unreadable or malformed");
    return null;
  }
  const parsed = runtimeStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.workspaceId !== resolvedWorkspaceId) {
    throw new Error("runtime state does not match its workspace or schema");
  }
  return parsed.data;
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

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      (body as Partial<HealthPayload>).service !== SERVICE_NAME ||
      typeof (body as Partial<HealthPayload>).version !== "string" ||
      typeof (body as Partial<HealthPayload>).workspaceId !== "string" ||
      !C2C_ID_PATTERN.test((body as Partial<HealthPayload>).workspaceId!) ||
      (body as Partial<HealthPayload>).status !== "ok"
    ) {
      return null;
    }
    return body as HealthPayload;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | {
      state: "unknown";
      runtime: RuntimeState | null;
      reason: "runtime_invalid" | "probe_failed" | "pid_unknown" | "workspace_mismatch";
    };

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */
export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  let runtime: RuntimeState | null;
  try {
    runtime = readRuntimeState(workspaceId);
  } catch {
    return { state: "unknown", runtime: null, reason: "runtime_invalid" };
  }
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };

  const health = await probeBridge(runtime.port);
  if (health && health.workspaceId === workspaceId) {
    return { state: "healthy", runtime };
  }
  if (health) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
