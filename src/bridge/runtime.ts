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

/**
 * Host-wide state: one bridge process serves every workspace on this machine.
 * This file is the authoritative adoption record — any session can use it to
 * find the host and register a new workspace, even when per-workspace runtime
 * files are stale.
 */
export interface HostState {
  service: string;
  version: string;
  /** Random per-process nonce; adopters verify it against /admin/info. */
  instance: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
  workspaces: string[];
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function hostFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "host.json");
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

export function writeHostState(state: HostState): void {
  writeSecureJson(hostFile(), state);
}

export function readHostState(): HostState | null {
  return readJsonIfExists<HostState>(hostFile());
}

export function clearHostState(): void {
  try {
    fs.rmSync(hostFile(), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  status: string;
}

/**
 * Probe a port and check whether a healthy c2c bridge answers. Deliberately
 * reveals nothing about workspaces: membership is an authenticated concern.
 */
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

/**
 * Live check for a recorded per-workspace runtime file. The admin call is
 * authenticated, so a stale record (wrong token for a reused port) or a
 * record for a workspace the bridge does not serve returns null.
 */
export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const state = readRuntimeState(workspaceId);
  if (!state) return null;
  const health = await probeBridge(state.port);
  if (!health) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`http://127.0.0.1:${state.port}/admin/info?workspace=${workspaceId}`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const info = (await response.json()) as { workspaceId?: string };
    if (info.workspaceId !== workspaceId) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Find a live multi-workspace host via its host-wide state file. The record
 * is validated against the responder itself: the admin API must accept the
 * recorded token AND report the recorded instance nonce. A well-formed but
 * stale record (wrong token or instance for a live port) therefore returns
 * null instead of blocking recovery or misdirecting adoption.
 */
export async function findLiveHost(): Promise<HostState | null> {
  const state = readHostState();
  if (!state) return null;
  const health = await probeBridge(state.port);
  if (!health) return null;
  if (state.pid !== process.pid && !pidAlive(state.pid)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(
      `http://127.0.0.1:${state.port}/admin/info?workspace=${state.workspaces[0] ?? ""}`,
      { headers: { Authorization: `Bearer ${state.adminToken}` }, signal: controller.signal }
    );
    clearTimeout(timer);
    if (!response.ok) return null;
    const info = (await response.json()) as { instance?: string };
    if (!info.instance || info.instance !== state.instance) return null;
    return state;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { SERVICE_NAME, VERSION };
