import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, ensureDir, getStateDir, readJsonIfExists } from "../config/paths.js";
import {
  clearHostState,
  clearRuntimeState,
  findLiveBridge,
  findLiveHost,
  probeBridge,
  readRuntimeState,
  writeRuntimeState,
  writeHostState,
  pidAlive,
  SERVICE_NAME,
  type RuntimeState,
  type HostState,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HostLock {
  /** Random per-acquisition identity; release() only deletes its own generation. */
  identity: string;
  release(): void;
}

function lockPath(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "host.lock");
}

const LOCK_MISSING = "missing";
const LOCK_UNREADABLE = "unreadable";

function readLockHolder(): { status: "ok"; holder: { pid?: number; identity?: string } } | { status: typeof LOCK_MISSING } | { status: typeof LOCK_UNREADABLE } {
  try {
    return {
      status: "ok",
      holder: JSON.parse(fs.readFileSync(lockPath(), "utf8")) as {
        pid?: number;
        identity?: string;
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: LOCK_MISSING };
    return { status: LOCK_UNREADABLE }; // empty/partial write: state unknown
  }
}

/**
 * Exclusive marker for the machine-wide bridge host process. The holder is
 * the only process allowed to bind the host; everyone else adopts it. The
 * file carries a random identity so release() only ever deletes the
 * generation its own process owns.
 *
 * Fully fail-closed: an existing lock file is NEVER removed automatically —
 * not for a live holder (join instead), not for a dead PID, not for an
 * unreadable/partial file. Any conditional deletion would reopen a TOCTOU
 * race between two recovering starters. A genuinely stale lock blocks
 * startup with a remediation message instead (one manual file deletion).
 */
export function acquireHostLock(): HostLock | null {
  const identity = randomBytes(12).toString("hex");
  let fd: number;
  try {
    fd = fs.openSync(lockPath(), "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity, startedAt: new Date().toISOString() }));
  } catch (writeError) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    throw writeError;
  }
  return {
    identity,
    release: (): void => {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      // Generation-safe delete: if a recovery replaced our lock, the file
      // is someone else's now and must survive.
      const read = readLockHolder();
      if (read.status !== "ok" || read.holder.identity !== identity) return;
      try {
        fs.rmSync(lockPath(), { force: true });
      } catch {
        // ignore
      }
    },
  };
}

/** Build a per-workspace runtime view of a running host (fresh token/port). */
export function hostRuntime(host: HostState, workspace: Workspace): RuntimeState {
  return {
    service: host.service,
    version: host.version,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: host.pid,
    port: host.port,
    adminToken: host.adminToken,
    publicUrl: host.publicUrl,
    startedAt: host.startedAt,
  };
}

async function registerWithHost(runtime: RuntimeState, workspaceRoot: string): Promise<void> {
  await adminFetch(runtime, "POST", "/admin/workspaces/register", 30_000, {
    workspaceRoot,
  });
}

/**
 * Adopt the running host for this workspace: idempotent registration followed
 * by an authenticated info check. Returns null when the host has disappeared
 * or rejected the recorded token; returns a stale-host marker when the record
 * names a different live instance and must be discarded.
 */
async function adoptHost(
  hostState: HostState,
  workspace: Workspace
): Promise<{ runtime: RuntimeState } | { staleHostRecord: true } | null> {
  const bootstrap = hostRuntime(hostState, workspace);
  let info: AdminInfo;
  try {
    await registerWithHost(bootstrap, workspace.root);
    info = await adminFetch<AdminInfo>(bootstrap, "GET", `/admin/info?workspace=${workspace.id}`, 10_000);
  } catch {
    return null; // host disappeared or rejected the recorded token
  }
  if (hostState.instance && info.instance && info.instance !== hostState.instance) {
    return { staleHostRecord: true };
  }
  const runtime: RuntimeState = { ...bootstrap, publicUrl: info.publicUrl ?? null };
  writeRuntimeState(runtime);
  return { runtime };
}

/**
 * Legacy single-workspace bridges answer /health with a workspaceId; the
 * multi-workspace host deliberately does not. That field difference is the
 * positive protocol identity used below.
 */
async function fetchRawHealth(port: number, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function runtimeRecordsOnPort(port: number): RuntimeState[] {
  const dir = path.join(getStateDir(), "runtime");
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== "host.json")
      .map((name) => readJsonIfExists<RuntimeState>(path.join(dir, name)))
      .filter((record): record is RuntimeState => record?.port === port);
  } catch {
    return [];
  }
}

/**
 * Decide what to do when the preferred port is held by a c2c bridge but no
 * validating host.json exists:
 * - current-version host with a lost/corrupt host record → RECONSTRUCT the
 *   record from its authenticated /admin/info (never kill a shared host);
 * - positively-identified pre-upgrade single-workspace bridge → stop it, so
 *   the shared host can take its port instead of splitting the fixed domain;
 * - anything unidentifiable → fail safely rather than risk a second host.
 */
async function migrateLegacyBridgeOnPort(port: number): Promise<void> {
  const health = await fetchRawHealth(port);
  if (!health || health.service !== SERVICE_NAME) return; // free or foreign
  if (await findLiveHost()) return; // a validating host already owns it

  const records = runtimeRecordsOnPort(port);

  if (health.workspaceId === undefined) {
    // Current-protocol host: rebuild its host record and adopt it.
    for (const record of records) {
      try {
        const info = await adminFetch<AdminInfo>(record, "GET", `/admin/info?workspace=${record.workspaceId}`, 5_000);
        if (!info.instance) continue;
        writeHostState({
          service: SERVICE_NAME,
          version: String(health.version ?? ""),
          instance: info.instance,
          pid: info.pid ?? record.pid,
          port,
          adminToken: record.adminToken,
          publicUrl: info.publicUrl ?? null,
          startedAt: info.startedAt ?? new Date().toISOString(),
          workspaces: info.workspaces ?? [info.workspaceId],
        });
        return;
      } catch {
        // try the next record
      }
    }
    throw new Error(
      "The preferred port is held by a c2c bridge whose host record is missing or invalid, " +
        "and it could not be verified. Refusing to start a second host. " +
        "Run `c2c stop` for the workspace that owns it (or remove the stale runtime record), then retry."
    );
  }

  // Positively a pre-upgrade single-workspace bridge: stop it gracefully,
  // then escalate to SIGTERM — it cannot host multiple workspaces, and
  // leaving it in place would re-split the fixed public address. This path
  // is fail-closed: either the port is confirmed free afterwards, or we
  // throw instead of spawning a second host onto an ephemeral port.
  if (records.length === 0) {
    throw new Error(
      "The preferred port is held by a pre-upgrade single-workspace c2c bridge with no " +
        "usable runtime record, so it cannot be stopped safely. Refusing to start a second host. " +
        "Stop that bridge (its workspace session or its process), then retry."
    );
  }
  for (const record of records) {
    try {
      await adminFetch(record, "POST", "/admin/shutdown", 5_000);
      if (await waitForPortFree(port, 10_000)) return;
      break;
    } catch {
      // try the next record, then escalate
    }
  }
  for (const record of records) {
    try {
      process.kill(record.pid, "SIGTERM");
      if (await waitForPortFree(port, 10_000)) return;
      break;
    } catch {
      // ignore
    }
  }
  throw new Error(
    "A pre-upgrade single-workspace c2c bridge still occupies the preferred port and could " +
      "not be stopped. Refusing to start a second host on a fallback port, because that would " +
      "split the fixed public address across processes. Stop it manually, then retry."
  );
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeBridge(port, 500))) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Ensure the workspace is served by the machine-wide bridge host. Joins the
 * running host when one exists (this is how parallel sessions coexist without
 * fighting over the port or the tunnel); otherwise spawns one daemon.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);

  // 1. Adopt the running host (host state is the authoritative record).
  const hostState = await findLiveHost();
  if (hostState) {
    const adopted = await adoptHost(hostState, workspace);
    if (adopted && "runtime" in adopted) return { ...adopted, spawned: false };
    if (adopted && "staleHostRecord" in adopted) clearHostState();
  }

  // 2. Legacy/standalone live bridge recorded for this workspace (safe to
  //    reuse while it is the only bridge for it on this machine).
  const live = await findLiveBridge(workspace.id);
  if (live) return { runtime: live, spawned: false };

  // 3. A pre-upgrade bridge on the preferred port would push the new host onto
  //    an ephemeral port and re-split the public address — migrate it first.
  await migrateLegacyBridgeOnPort(opts.port ?? DEFAULT_PORT);

  // 3b. Migration may have reconstructed a valid host record (a current
  //     host that had lost its host.json) — adopt it instead of spawning a
  //     competitor.
  const revived = await findLiveHost();
  if (revived) {
    const adopted = await adoptHost(revived, workspace);
    if (adopted && "runtime" in adopted) return { ...adopted, spawned: false };
  }

  // 4. Spawn a detached daemon; whichever process wins the host lock serves,
  //    the losers exit and every session registers with the winner here.
  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root, ...(opts.port ? ["--port", String(opts.port)] : [])],
    {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: { ...process.env },
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  let childError: Error | null = null;
  while (Date.now() < deadline) {
    await sleep(300);
    // Adoption first: our serve may legitimately exit non-zero (e.g. it lost
    // the host lock to a concurrent starter) while the winner comes up.
    const host = await findLiveHost();
    if (host) {
      const adopted = await adoptHost(host, workspace);
      if (adopted && "runtime" in adopted) {
        // If our spawned serve lost the lock race it is still sitting in its
        // wait loop; stop it, otherwise it could acquire the freed lock much
        // later and resurrect an unwanted host after every workspace stopped.
        if (child.pid && child.pid !== host.pid && child.exitCode === null) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // ignore
          }
        }
        return { ...adopted, spawned: true };
      }
    }
    if (child.exitCode !== null && child.exitCode !== 0 && !childError) {
      childError = new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw childError ?? new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000,
  body?: unknown
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.adminToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((parsed as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export interface AdminInfo {
  service?: string;
  version?: string;
  instance?: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  workspaces?: string[];
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);

  // Preferred: unregister from a running host via its host record (fresh
  // token). Other workspaces keep serving; the host exits when this was the
  // last workspace.
  const hostState = await findLiveHost();
  if (hostState && hostState.workspaces.includes(workspace.id)) {
    const bootstrap = hostRuntime(hostState, workspace);
    try {
      await adminFetch(bootstrap, "POST", "/admin/workspaces/unregister", 5_000, {
        workspaceId: workspace.id,
      });
      clearRuntimeState(workspace.id);
      return true;
    } catch {
      // fall through to the per-workspace record path
    }
  }

  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  if (!(await probeBridge(runtime.port))) return false;
  try {
    const info = await adminFetch<AdminInfo>(runtime, "GET", `/admin/info?workspace=${workspace.id}`, 5_000);
    const hostedCount = info.workspaces?.length ?? 1;
    if (hostedCount > 1) {
      // A shared host must never be taken down from a per-workspace record.
      await adminFetch(runtime, "POST", "/admin/workspaces/unregister", 5_000, {
        workspaceId: workspace.id,
      });
      clearRuntimeState(workspace.id);
      return true;
    }
    if (info.workspaceId !== workspace.id) return false;
    // Single-workspace bridge: stopping it is exactly what was asked for.
    await adminFetch(runtime, "POST", "/admin/shutdown", 5_000);
    clearRuntimeState(workspace.id);
    return true;
  } catch {
    // We could not authenticate against the responder. It may be a shared
    // host serving other workspaces — never SIGTERM on a guess.
    return false;
  }
}
