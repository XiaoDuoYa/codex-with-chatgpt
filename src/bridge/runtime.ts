import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import {
  removeWorkspaceStateFile,
  workspaceStateFile,
  writeWorkspaceStateJson,
} from "../workspace/local-state.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Credentials are deliberately kept out of this discoverable file.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  instanceId: string;
  pid: number;
  port: number;
  /** Legacy compatibility only. New runtime files never persist this value. */
  adminToken?: string;
  publicUrl: string | null;
  startedAt: string;
}

export function runtimeFile(workspaceRoot: string): string {
  return workspaceStateFile(workspaceRoot, "runtime.json");
}

export function writeRuntimeState(state: RuntimeState): void {
  const { adminToken: _legacySecret, ...safeState } = state;
  writeWorkspaceStateJson(state.workspaceRoot, "runtime.json", safeState);
  try {
    fs.rmSync(path.join(getStateDir(), "runtime", `${state.workspaceId}.json`), { force: true });
  } catch {
    // best effort cleanup of the exact legacy runtime file
  }
}

export function readRuntimeState(workspaceRoot: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceRoot));
}

export function clearRuntimeState(workspaceRoot: string): void {
  removeWorkspaceStateFile(workspaceRoot, "runtime.json");
}

export interface HealthPayload {
  service: string;
  version: string;
  instanceId?: string;
  /** Legacy bridge compatibility only. */
  workspaceId?: string;
  status: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export async function findLiveBridge(workspaceRoot: string, workspaceId: string): Promise<RuntimeState | null> {
  const state = readRuntimeState(workspaceRoot);
  if (!state) return null;
  if (state.workspaceId !== workspaceId || state.workspaceRoot !== workspaceRoot) return null;
  const health = await probeBridge(state.port);
  if (
    health &&
    (state.instanceId
      ? health.instanceId === state.instanceId
      : health.workspaceId === workspaceId)
  ) return state;
  return null;
}

export { SERVICE_NAME, VERSION };
