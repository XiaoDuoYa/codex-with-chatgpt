import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "codex-with-chatgpt");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

const projectDataDirs = new Map<string, string>();
const workspaceDataDirs = new Map<string, string>();
const WORKSPACE_STORAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;

/** Legacy machine-wide workspace-data root, retained only so setup can remove
 * older overly broad sandbox grants. New workspace data never lives here. */
export function getLegacyWorkspaceDataRoot(): string {
  return path.join(getStateDir(), "workspace-data");
}

function registerDataDir(
  registry: Map<string, string>,
  id: string,
  dir: string,
  label: "project" | "workspace",
): void {
  if (!WORKSPACE_STORAGE_ID.test(id)) throw new Error(`${label} storage id is invalid`);
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("workspace data directory must be a real directory");
  }
  const canonical = fs.realpathSync.native(resolved);
  if (canonical !== resolved) {
    throw new Error("workspace data directory must not traverse symbolic links");
  }
  const existing = registry.get(id);
  if (existing && existing !== canonical) {
    if (fs.existsSync(path.dirname(existing))) {
      throw new Error(`${label} storage id is already bound to another directory`);
    }
  }
  registry.set(id, canonical);
}

/**
 * Bind a stable project identity to its shared repository-local data directory.
 * A project may have multiple linked checkouts, so this directory must not be
 * reused as a workspace state directory.
 */
export function registerProjectDataDir(projectId: string, dir: string): void {
  registerDataDir(projectDataDirs, projectId, dir, "project");
}

/** Bind a checkout identity to its isolated repository-local data directory. */
export function registerWorkspaceDataDir(workspaceId: string, dir: string): void {
  registerDataDir(workspaceDataDirs, workspaceId, dir, "workspace");
}

function getRegisteredDataDir(
  registry: Map<string, string>,
  id: string,
  label: "project" | "workspace",
): string {
  const registered = registry.get(id);
  if (!registered) throw new Error(`${label} data directory is not registered for this process`);
  const stat = fs.lstatSync(registered, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(registered) !== registered) {
    throw new Error(`${label} data directory ownership has changed`);
  }
  return registered;
}

/** Resolve shared state owned by one stable project identity. */
export function getProjectDataDir(projectId: string): string {
  if (!WORKSPACE_STORAGE_ID.test(projectId)) throw new Error("project storage id is invalid");
  const isolatedStateRoot = process.env.C2C_STATE_DIR?.trim();
  if (isolatedStateRoot) {
    return path.join(path.resolve(isolatedStateRoot), "project-data", projectId);
  }
  return getRegisteredDataDir(projectDataDirs, projectId, "project");
}

/**
 * Resolve state owned by one checkout. Production callers must first create a
 * Workspace, which registers its checkout directory. Tests use C2C_STATE_DIR
 * and receive the same per-id isolation without a checkout.
 */
export function getWorkspaceDataDir(workspaceId: string): string {
  if (!WORKSPACE_STORAGE_ID.test(workspaceId)) throw new Error("workspace storage id is invalid");
  const isolatedStateRoot = process.env.C2C_STATE_DIR?.trim();
  if (isolatedStateRoot) {
    return path.join(path.resolve(isolatedStateRoot), "workspace-data", workspaceId);
  }
  return getRegisteredDataDir(workspaceDataDirs, workspaceId, "workspace");
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Atomically replace a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  const dir = ensureDir(path.dirname(file));
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Atomically create a JSON file without replacing an existing entry. */
export function writeSecureJsonExclusive(file: string, data: unknown): void {
  const dir = ensureDir(path.dirname(file));
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      fd = null;
    }
    // A hard link publishes the complete temporary inode and fails with
    // EEXIST when another process won the one-shot write.
    fs.linkSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // preserve the original write error
      }
    }
    fs.rmSync(temporary, { force: true });
  }
}

const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

function lockOwnerIsAlive(fd: number): boolean {
  try {
    const [rawPid] = fs.readFileSync(fd, "utf8").split(/\r?\n/);
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function reaperMarkerPrefix(file: string): string {
  return `${path.basename(file)}.reap-`;
}

function reaperMarkerFile(file: string): string {
  return path.join(
    path.dirname(file),
    `${reaperMarkerPrefix(file)}${process.pid}-${randomBytes(8).toString("hex")}`
  );
}

function activeReaperExists(file: string, staleMs: number): boolean {
  const directory = path.dirname(file);
  const prefix = reaperMarkerPrefix(file);
  let active = false;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const marker = path.join(directory, entry);
    let fd: number | null = null;
    try {
      fd = fs.openSync(marker, "r");
      const observed = fs.fstatSync(fd);
      if (Date.now() - observed.mtimeMs > staleMs && !lockOwnerIsAlive(fd)) {
        const current = fs.statSync(marker);
        if (observed.dev === current.dev && observed.ino === current.ino) {
          fs.rmSync(marker, { force: true });
          continue;
        }
      }
      active = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return active;
}

function removeAbandonedLock(file: string, staleMs: number): boolean {
  const marker = reaperMarkerFile(file);
  let markerFd: number | null = null;
  let lockFd: number | null = null;
  try {
    // The marker closes the stat/unlink race: a contender that creates a new
    // lock during recovery must observe this marker before entering its action.
    markerFd = createOwnedLock(marker, false);
    lockFd = fs.openSync(file, "r");
    const observed = fs.fstatSync(lockFd);
    if (Date.now() - observed.mtimeMs <= staleMs || lockOwnerIsAlive(lockFd)) return false;

    const current = fs.statSync(file);
    if (observed.dev !== current.dev || observed.ino !== current.ino) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally {
    if (lockFd !== null) fs.closeSync(lockFd);
    if (markerFd !== null) releaseOwnedLock(marker, markerFd);
  }
}

function releaseOwnedLock(file: string, fd: number): void {
  try {
    const owned = fs.fstatSync(fd);
    const current = fs.statSync(file);
    if (owned.dev === current.dev && owned.ino === current.ino) fs.rmSync(file, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function ownedLockIsPublished(file: string, fd: number): boolean {
  try {
    const owned = fs.fstatSync(fd);
    const current = fs.statSync(file);
    return owned.dev === current.dev && owned.ino === current.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function createOwnedLock(file: string, durable: boolean): number {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    if (durable) fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    try {
      releaseOwnedLock(file, fd);
    } catch {
      // Preserve the acquisition error; a later stale-lock pass can recover.
    }
    throw error;
  }
}

/** Serialize short cross-process state mutations and recover abandoned locks. */
export function withFileLock<T>(
  file: string,
  action: () => T,
  opts: FileLockOptions = {}
): T {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const staleMs = opts.staleMs ?? 30_000;
  const startedAt = Date.now();
  ensureDir(path.dirname(file));
  let fd: number | null = null;

  while (fd === null) {
    if (activeReaperExists(file, staleMs)) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for state lock: ${path.basename(file)}`);
      }
      Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 10);
      continue;
    }
    try {
      const candidate = createOwnedLock(file, false);
      if (activeReaperExists(file, staleMs) || !ownedLockIsPublished(file, candidate)) {
        releaseOwnedLock(file, candidate);
      } else {
        fd = candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (removeAbandonedLock(file, staleMs)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for state lock: ${path.basename(file)}`);
      }
      Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 10);
    }
  }

  try {
    return action();
  } finally {
    releaseOwnedLock(file, fd);
  }
}

/** Serialize an async cross-process mutation without blocking the event loop. */
export async function withFileLockAsync<T>(
  file: string,
  action: () => Promise<T>,
  opts: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const staleMs = opts.staleMs ?? 30_000;
  const startedAt = Date.now();
  ensureDir(path.dirname(file));
  let fd: number | null = null;

  while (fd === null) {
    if (activeReaperExists(file, staleMs)) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for state lock: ${path.basename(file)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    try {
      const candidate = createOwnedLock(file, true);
      if (activeReaperExists(file, staleMs) || !ownedLockIsPublished(file, candidate)) {
        releaseOwnedLock(file, candidate);
      } else {
        fd = candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (removeAbandonedLock(file, staleMs)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for state lock: ${path.basename(file)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await action();
  } finally {
    releaseOwnedLock(file, fd);
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
