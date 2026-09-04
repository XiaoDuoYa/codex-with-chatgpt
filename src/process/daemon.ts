import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir, withFileLockAsync } from "../config/paths.js";
import {
  clearRuntimeState,
  findBridgeObservation,
  findLiveBridge,
  readRuntimeState,
  type RuntimeState,
} from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

export interface EnsureBridgeOptions {
  port?: number;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnImpl?: typeof spawn;
}

const BRIDGE_START_LOCK_TIMEOUT_MS = 25_000;
const BRIDGE_START_LOCK_STALE_MS = 60_000;

export function withBridgeStartLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
  const lockFile = path.join(ensureDir(path.join(getStateDir(), "locks")), `bridge-${workspaceId}.lock`);
  return withFileLockAsync(lockFile, action, {
    timeoutMs: BRIDGE_START_LOCK_TIMEOUT_MS,
    staleMs: BRIDGE_START_LOCK_STALE_MS,
  });
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(
  workspaceRoot: string,
  opts: EnsureBridgeOptions = {}
): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const initial = await findBridgeObservation(workspace.id);
  if (initial.state === "healthy") return { runtime: initial.runtime, spawned: false };

  return withBridgeStartLock(workspace.id, async () => {
    // Another CLI may have completed startup while this caller waited for the lock.
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
    if (observation.state === "unknown") {
      throw new Error(
        `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
      );
    }

    const startTimeoutMs = opts.startTimeoutMs ?? 20_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 300;
    if (!Number.isInteger(startTimeoutMs) || startTimeoutMs < 1) {
      throw new Error("bridge start timeout must be a positive integer");
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error("bridge poll interval must be a positive integer");
    }

    const logDir = ensureDir(path.join(getStateDir(), "logs"));
    const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
    const out = fs.openSync(logFile, "a", 0o600);
    let child: ChildProcess;
    const launchState: { error: Error | null } = { error: null };
    try {
      // Existing files may have been created with a permissive umask. Keep the
      // daemon's inherited stdout/stderr log owner-readable only.
      try {
        fs.chmodSync(logFile, 0o600);
      } catch {
        // Windows / filesystems without chmod semantics
      }
      const { cmd, args } = cliEntry();
      child = (opts.spawnImpl ?? spawn)(
        cmd,
        [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
        {
          detached: true,
          stdio: ["ignore", out, out],
          env: { ...process.env },
          windowsHide: true,
        }
      );
      child.once("error", (error) => {
        launchState.error = error;
      });
      child.unref();
    } finally {
      fs.closeSync(out);
    }

    const launchFailure = (): Error | null => {
      if (launchState.error) {
        return new Error(`Bridge process failed to start: ${launchState.error.message}. See ${logFile}`);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const outcome = child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
        return new Error(`Bridge process exited with ${outcome} before becoming healthy. See ${logFile}`);
      }
      return null;
    };

    try {
      const deadline = Date.now() + startTimeoutMs;
      while (Date.now() < deadline) {
        const failure = launchFailure();
        if (failure) throw failure;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        const runtime = await findLiveBridge(workspace.id);
        if (runtime) return { runtime, spawned: true };
        const delayedFailure = launchFailure();
        if (delayedFailure) throw delayedFailure;
      }
      throw new Error(`Bridge did not become healthy within ${startTimeoutMs}ms. See ${logFile}`);
    } catch (error) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may have exited after the final observation.
      }
      throw error;
    }
  });
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "stopped") {
    clearRuntimeState(workspace.id);
    return false;
  }

  try {
    const info = await adminFetch<{ workspaceId: string; pid: number }>(runtime, "GET", "/admin/info", 5000);
    if (info.workspaceId !== workspace.id || info.pid !== runtime.pid) {
      throw new Error("authenticated bridge identity does not match runtime state");
    }
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Bridge shutdown could not be authenticated (${detail}); refusing to signal unverified PID ${runtime.pid}`
    );
  }
}
