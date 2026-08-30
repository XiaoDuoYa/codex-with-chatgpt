import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeSecureJson } from "../config/paths.js";

export const LOCAL_STATE_DIR = ".c2c-local";

function isInside(candidate: string, root: string): boolean {
  const insensitive = process.platform === "win32" || process.platform === "darwin";
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return insensitive ? resolved.toLowerCase() : resolved;
  };
  const child = normalize(candidate);
  const parent = normalize(root);
  return child === parent || child.startsWith(parent + path.sep);
}

/** Return a non-symlinked private state directory inside the selected workspace. */
export function workspaceStateDir(workspaceRoot: string): string {
  const root = fs.realpathSync.native(path.resolve(workspaceRoot));
  const dir = path.join(root, LOCAL_STATE_DIR);
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${LOCAL_STATE_DIR} must be a regular directory inside the workspace`);
    }
  } else {
    ensureDir(dir);
  }
  const real = fs.realpathSync.native(dir);
  if (!isInside(real, root)) throw new Error(`${LOCAL_STATE_DIR} resolves outside the workspace`);
  const ignoreFile = path.join(real, ".gitignore");
  if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, "*\n", { mode: 0o600 });
  return real;
}

export function workspaceStateFile(workspaceRoot: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error("Invalid workspace state filename");
  return path.join(workspaceStateDir(workspaceRoot), name);
}

export function writeWorkspaceStateJson(workspaceRoot: string, name: string, data: unknown): string {
  const file = workspaceStateFile(workspaceRoot, name);
  writeSecureJson(file, data);
  return file;
}

export function removeWorkspaceStateFile(workspaceRoot: string, name: string): void {
  try {
    fs.rmSync(workspaceStateFile(workspaceRoot, name), { force: true });
  } catch {
    // best effort cleanup of one exact private state file
  }
}

export function writeWorkspaceStateText(workspaceRoot: string, name: string, value: string): string {
  const file = workspaceStateFile(workspaceRoot, name);
  fs.writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without chmod semantics
  }
  return file;
}

export function acquireWorkspaceBridgeLock(workspaceRoot: string, instanceId: string): () => void {
  const file = workspaceStateFile(workspaceRoot, "bridge.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        instanceId,
        createdAt: new Date().toISOString(),
      }));
      fs.closeSync(fd);
      return () => {
        try {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; instanceId?: string };
        if (current.pid === process.pid && current.instanceId === instanceId) fs.rmSync(file, { force: true });
        } catch {
          // best effort cleanup of this process's exact lock file
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let liveDuringStartup = false;
      try {
        const current = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; createdAt?: string };
        if (typeof current.pid === "number") {
          process.kill(current.pid, 0);
          const age = Date.now() - Date.parse(current.createdAt ?? "");
          liveDuringStartup = Number.isFinite(age) && age >= 0 && age < 30_000;
        }
      } catch {
        liveDuringStartup = false;
      }
      if (liveDuringStartup) throw new Error("A C2C bridge is already starting for this workspace");
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error("Unable to acquire the workspace bridge lock");
}
