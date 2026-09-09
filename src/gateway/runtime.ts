import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

export const GATEWAY_ID = "gateway";

export interface GatewayRuntimeState {
  service: string;
  version: string;
  gatewayId: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

export function gatewayRuntimeFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${GATEWAY_ID}.json`);
}

export function writeGatewayRuntimeState(state: GatewayRuntimeState): void {
  writeSecureJson(gatewayRuntimeFile(), state);
}

export function readGatewayRuntimeState(): GatewayRuntimeState | null {
  return readJsonIfExists<GatewayRuntimeState>(gatewayRuntimeFile());
}

export function clearGatewayRuntimeState(): void {
  try {
    fs.rmSync(gatewayRuntimeFile(), { force: true });
  } catch {
    // ignore
  }
}

export interface GatewayHealthPayload {
  service: string;
  version: string;
  gatewayId: string;
  workspaceId: string | null;
  status: string;
}

export async function probeGateway(port: number, timeoutMs = 2000): Promise<GatewayHealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as GatewayHealthPayload;
    if (body.service !== SERVICE_NAME || body.gatewayId !== GATEWAY_ID || body.version !== VERSION) return null;
    return body;
  } catch {
    return null;
  }
}

export async function findLiveGateway(): Promise<GatewayRuntimeState | null> {
  const runtime = readGatewayRuntimeState();
  if (!runtime) return null;
  const health = await probeGateway(runtime.port);
  return health ? runtime : null;
}
