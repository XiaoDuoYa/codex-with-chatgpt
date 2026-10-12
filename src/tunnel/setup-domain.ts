import fs from "node:fs";
import { findBridgeObservation } from "../bridge/runtime.js";
import { stopBridgeAndWait } from "../process/daemon.js";
import { SERVICE_NAME } from "../version.js";
import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";
import { provisionNamedTunnel } from "./named-provision.js";
import { isNamedTunnelReady, readTunnelState, tunnelStateFile, writeTunnelState, type TunnelState } from "./state.js";
import { ensureDir } from "../config/paths.js";
import path from "node:path";

/** A connected cloudflared process alone does not prove DNS routes to this workspace. */
export async function verifyNamedEndpoint(hostname: string, workspaceId: string, fetchImpl = fetch, attempts = 8): Promise<void> {
  let detail = "no response";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(`https://${hostname}/health`, {
        signal: AbortSignal.timeout(4000), redirect: "error",
      });
      if (response.ok) {
        const body = await response.json() as { service?: string; status?: string; workspaceId?: string };
        if (body.service !== SERVICE_NAME || body.status !== "ok" || body.workspaceId !== workspaceId) {
          throw new Error("PUBLIC_ENDPOINT_MISMATCH: 域名未连接到当前工作区");
        }
        return;
      }
      detail = `HTTP ${response.status}`;
    } catch (error) {
      detail = (error as Error).message;
      if (detail.startsWith("PUBLIC_ENDPOINT_MISMATCH")) throw error;
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`PUBLIC_ENDPOINT_UNREACHABLE: https://${hostname}/health (${detail})`);
}

const defaults = {
  provision: provisionNamedTunnel,
  observe: findBridgeObservation,
  stop: stopBridgeAndWait,
  verify: verifyNamedEndpoint,
};

/** Prepare remotely, run an uncommitted candidate, then commit only a verified endpoint. */
export async function setupNamedDomain<T extends { mcpUrl: string | null }>(
  workspace: { id: string; name: string; root: string },
  domain: string,
  connect: (candidate?: TunnelState) => Promise<T>,
  dependencies: Partial<typeof defaults> = {}
): Promise<T> {
  const hostname = normalizeNamedTunnelHostname(domain);
  const deps = { ...defaults, ...dependencies };
  const file = tunnelStateFile(workspace.id);
  ensureDir(path.dirname(file));
  const lock = `${file}.setup.lock`;
  // A concurrent setup must not commit another process's candidate or rollback.
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    const previous = readTunnelState(workspace.id);
    const observation = await deps.observe(workspace.id);
    if (observation.state === "unknown") throw new Error(`Bridge state is uncertain (${observation.reason})`);
    if (isNamedTunnelReady(previous) && previous.tunnelId && previous.hostname === hostname) {
      // Repeated setup must not depend on Cloudflare's management API. The
      // saved UUID, credentials and DNS route were provisioned previously;
      // connect() still reconciles a stale quick Bridge before returning.
      const connection = await connect(previous);
      if (connection.mcpUrl !== `https://${hostname}/mcp`) throw new Error("PUBLIC_ENDPOINT_MISMATCH: Bridge 返回了其他域名");
      await deps.verify(hostname, workspace.id);
      return connection;
    }
    const result = await deps.provision({
      workspaceId: workspace.id, workspaceName: workspace.name,
      hostname, strict: true, persist: false,
    });
    // Stop before connecting: ensureBridge otherwise reuses a healthy quick process.
    if (observation.state === "healthy") await deps.stop(workspace.root);
    try {
      const connection = await connect(result.state);
      if (connection.mcpUrl !== `https://${hostname}/mcp`) throw new Error("PUBLIC_ENDPOINT_MISMATCH: Bridge 返回了其他域名");
      await deps.verify(hostname, workspace.id);
      writeTunnelState(result.state);
      return connection;
    } catch (error) {
      const failures: string[] = [];
      try { await deps.stop(workspace.root); } catch (stopError) { failures.push(`停止候选 Bridge 失败：${(stopError as Error).message}`); }
      // Persistent state/endpoint were never changed. Restore the previous live
      // process where possible; remote DNS changes cannot be rolled back locally.
      if (observation.state === "healthy" && failures.length === 0) {
        try { await connect(previous); } catch (restoreError) { failures.push(`恢复原 Bridge 失败：${(restoreError as Error).message}`); }
      }
      throw new Error(`${(error as Error).message}${failures.length ? `；${failures.join("；")}` : ""}`);
    }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}
