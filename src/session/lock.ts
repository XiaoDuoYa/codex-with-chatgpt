import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type WorkspaceLockKind = "session" | "bridge-start";

export interface WorkspaceLockInfo {
  kind: WorkspaceLockKind;
  workspaceId: string;
  ownerId: string;
  taskId: string | null;
  pid: number;
  acquiredAt: string;
  refreshedAt: string;
  expiresAt: number;
}

interface PersistedWorkspaceLock extends WorkspaceLockInfo {
  tokenHash: string;
}

export interface WorkspaceLockHandle {
  kind: WorkspaceLockKind;
  workspaceId: string;
  token: string;
  leaseMs: number;
  info: WorkspaceLockInfo;
}

export interface AcquireWorkspaceLockOptions {
  taskId?: string;
  leaseMs?: number;
  waitMs?: number;
  pollMs?: number;
  pid?: number;
}

export type AcquireWorkspaceLockResult =
  | { acquired: true; handle: WorkspaceLockHandle; recovered: boolean }
  | { acquired: false; reason: "busy"; info: WorkspaceLockInfo | null; expired: boolean };

export interface WorkspaceLockStatus {
  held: boolean;
  expired?: boolean;
  ownerAlive?: boolean | null;
  info?: WorkspaceLockInfo | null;
}

function ownerAlive(lock: PersistedWorkspaceLock | null): boolean | null {
  if (!lock) return null;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function canRecoverLock(lock: PersistedWorkspaceLock, options: Required<Pick<AcquireWorkspaceLockOptions, "taskId" | "leaseMs" | "pid">>): boolean {
  const taskId = options.taskId || null;
  return taskId !== null && lock.pid === options.pid && lock.taskId === taskId;
}

export const DEFAULT_SESSION_LOCK_LEASE_MS = 30 * 60_000;
const DEFAULT_BRIDGE_LIFECYCLE_LOCK_LEASE_MS = 5 * 60_000;
const DEFAULT_WAIT_MS = 0;
const DEFAULT_POLL_MS = 100;
const MAX_LEASE_MS = 24 * 60 * 60_000;
const OWNER_FILE = "owner.json";
const MUTATION_GUARD_LEASE_MS = 60_000;
const MUTATION_GUARD_WAIT_MS = 5_000;
const MUTATION_GUARD_POLL_MS = 10;

interface MutationGuardInfo {
  ownerId: string;
  acquiredAt: string;
  expiresAt: number;
}

interface MutationGuardHandle {
  path: string;
  ownerId: string;
}

function mutationGuardDirectory(workspaceId: string): string {
  return path.join(getStateDir(), "locks", `mutation-${workspaceId}.lock`);
}


function lockDirectory(kind: WorkspaceLockKind, workspaceId: string): string {
  return path.join(getStateDir(), "locks", `${kind}-${workspaceId}.lock`);
}

export function sessionLockPath(workspaceId: string): string {
  return lockDirectory("session", workspaceId);
}

function ownerPath(lockDir: string): string {
  return path.join(lockDir, OWNER_FILE);
}

function defaultLeaseMs(kind: WorkspaceLockKind): number {
 return kind === "session" ? DEFAULT_SESSION_LOCK_LEASE_MS : DEFAULT_BRIDGE_LIFECYCLE_LOCK_LEASE_MS;
}

function validateDuration(name: string, value: number, fallback: number): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_LEASE_MS) {
    throw new Error(`${name} must be between 1 and ${MAX_LEASE_MS} milliseconds`);
  }
  return Math.floor(duration);
}

function validateWaitMs(value: number | undefined): number {
  const duration = value ?? DEFAULT_WAIT_MS;
  if (!Number.isFinite(duration) || duration < 0 || duration > MAX_LEASE_MS) {
    throw new Error(`waitMs must be between 0 and ${MAX_LEASE_MS} milliseconds`);
  }
  return Math.floor(duration);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(expectedHash: string, token: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createLockToken(): string {
  // CLIのオプション値が`-`で始まると、Commanderが別のオプションとして解釈する。
  return `${randomBytes(1).toString("hex")}${randomBytes(32).toString("base64url")}`;
}


function toInfo(lock: PersistedWorkspaceLock): WorkspaceLockInfo {
  const { tokenHash: _tokenHash, ...info } = lock;
  return info;
}

function validPersistedLock(value: PersistedWorkspaceLock | null, kind: WorkspaceLockKind, workspaceId: string): value is PersistedWorkspaceLock {
  return Boolean(
    value &&
      value.kind === kind &&
      value.workspaceId === workspaceId &&
      typeof value.ownerId === "string" &&
      typeof value.tokenHash === "string" &&
      typeof value.pid === "number" &&
      typeof value.acquiredAt === "string" &&
      typeof value.refreshedAt === "string" &&
      typeof value.expiresAt === "number" &&
      (value.taskId === null || typeof value.taskId === "string")
  );
}

function readPersistedLock(kind: WorkspaceLockKind, workspaceId: string, lockDir = lockDirectory(kind, workspaceId)): PersistedWorkspaceLock | null {
  const value = readJsonIfExists<PersistedWorkspaceLock>(ownerPath(lockDir));
  return validPersistedLock(value, kind, workspaceId) ? value : null;
}

function lockExpired(
  kind: WorkspaceLockKind,
  lockDir: string,
  lock: PersistedWorkspaceLock | null,
  now = Date.now()
): boolean {
  if (lock) return lock.expiresAt <= now;
  try {
    return fs.statSync(lockDir).mtimeMs + defaultLeaseMs(kind) <= now;
  } catch {
    return true;
  }
}

function removePath(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    try {
      fs.unlinkSync(target);
    } catch {
      // 既に消えていれば後始末は不要。
    }
    return;
  }
  for (const entry of fs.readdirSync(target)) {
    const child = path.join(target, entry);
    try {
      fs.unlinkSync(child);
    } catch {
      // 予期しない入れ子は別の処理主体の所有物として残す。
    }
  }
  try {
    fs.rmdirSync(target);
  } catch {
    // 競合または既に消えた場合は再試行側に任せる。
  }
}

function readMutationGuard(lockDir: string): MutationGuardInfo | null {
  const value = readJsonIfExists<MutationGuardInfo>(ownerPath(lockDir));
  return value &&
    typeof value.ownerId === "string" &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(value.expiresAt)
    ? value
    : null;
}

function mutationGuardExpired(lockDir: string, guard: MutationGuardInfo | null, now = Date.now()): boolean {
  if (guard) return guard.expiresAt <= now;
  try {
    return fs.statSync(lockDir).mtimeMs + MUTATION_GUARD_LEASE_MS <= now;
  } catch {
    return true;
  }
}

const mutationWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSynchronously(ms: number): void {
  if (ms > 0) Atomics.wait(mutationWaitBuffer, 0, 0, ms);
}

function acquireMutationGuard(workspaceId: string, waitMs: number): MutationGuardHandle | null {
 const lockDir = mutationGuardDirectory(workspaceId);
 ensureDir(path.dirname(lockDir));
 const deadline = Date.now() + Math.max(0, waitMs);

 for (;;) {
  const ownerId = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const now = Date.now();
  const candidateDir = `${lockDir}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
   fs.mkdirSync(candidateDir, { mode: 0o700 });
   writeSecureJson(ownerPath(candidateDir), {
    ownerId,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: now + MUTATION_GUARD_LEASE_MS,
   } satisfies MutationGuardInfo);
   try {
    // 所有者情報を初期化してから公開ディレクトリへ原子的に移す。
    fs.renameSync(candidateDir, lockDir);
   } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    removePath(candidateDir);
    const current = readMutationGuard(lockDir);
    if (mutationGuardExpired(lockDir, current)) {
     if (reclaimLock(lockDir)) continue;
     continue;
    }
    if (Date.now() >= deadline) return null;
    sleepSynchronously(Math.min(MUTATION_GUARD_POLL_MS, Math.max(1, deadline - Date.now())));
    continue;
   }
   return { path: lockDir, ownerId };
  } catch (error) {
   removePath(candidateDir);
   throw error;
  }
 }
}

function releaseMutationGuard(guard: MutationGuardHandle): void {
  const current = readMutationGuard(guard.path);
  if (!current || current.ownerId !== guard.ownerId) return;
  removePath(guard.path);
}

function withMutationGuard<T>(workspaceId: string, action: () => T): T {
  const guard = acquireMutationGuard(workspaceId, MUTATION_GUARD_WAIT_MS);
  if (!guard) {
    throw new Error("C2C_LOCK_TRANSITION_BUSY: another process is changing workspace lock state");
  }
  try {
    return action();
  } finally {
    releaseMutationGuard(guard);
  }
}


function reclaimLock(lockDir: string): boolean {
  const staleDir = `${lockDir}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    // rename は同時回収者のうち一つだけを成功させる。
    fs.renameSync(lockDir, staleDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
  removePath(staleDir);
  return true;
}

function tryAcquireWorkspaceLockUnserialized(
  kind: WorkspaceLockKind,
  workspaceId: string,
  options: Required<Pick<AcquireWorkspaceLockOptions, "taskId" | "leaseMs" | "pid">>
): AcquireWorkspaceLockResult {
  const lockDir = lockDirectory(kind, workspaceId);
  ensureDir(path.dirname(lockDir));

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      // mkdir は同一workspaceの同時取得を原子的に一つへ絞る。
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readPersistedLock(kind, workspaceId, lockDir);
      const alive = ownerAlive(current);
      const expired = lockExpired(kind, lockDir, current);
      if (current && alive && !expired && canRecoverLock(current, options)) {
        const token = createLockToken();
        const now = Date.now();
        const recovered: PersistedWorkspaceLock = {
          ...current,
          refreshedAt: new Date(now).toISOString(),
          expiresAt: now + options.leaseMs,
        };
        writeSecureJson(ownerPath(lockDir), {
          ...recovered,
          tokenHash: hashToken(token),
        } satisfies PersistedWorkspaceLock);
        return {
          acquired: true,
          recovered: true,
          handle: { kind, workspaceId, token, leaseMs: options.leaseMs, info: toInfo(recovered) },
        };
      }
      if (alive !== false && !expired) {
        return { acquired: false, reason: "busy", info: current ? toInfo(current) : null, expired: false };
      }
      if ((alive === false || expired) && reclaimLock(lockDir)) continue;
      continue;
    }

    const token = createLockToken();
    const now = Date.now();
    const info: WorkspaceLockInfo = {
      kind,
      workspaceId,
      ownerId: `${options.pid}-${randomBytes(6).toString("hex")}`,
      taskId: options.taskId || null,
      pid: options.pid,
      acquiredAt: new Date(now).toISOString(),
      refreshedAt: new Date(now).toISOString(),
      expiresAt: now + options.leaseMs,
    };
    try {
      writeSecureJson(ownerPath(lockDir), { ...info, tokenHash: hashToken(token) } satisfies PersistedWorkspaceLock);
    } catch (error) {
      removePath(lockDir);
      throw error;
    }
    return {
      acquired: true,
      recovered: false,
      handle: { kind, workspaceId, token, leaseMs: options.leaseMs, info },
    };
  }

  const current = readPersistedLock(kind, workspaceId, lockDir);
  return { acquired: false, reason: "busy", info: current ? toInfo(current) : null, expired: false };
}

function tryAcquireWorkspaceLock(
  kind: WorkspaceLockKind,
  workspaceId: string,
  options: Required<Pick<AcquireWorkspaceLockOptions, "taskId" | "leaseMs" | "pid">>,
  mutationWaitMs: number
): AcquireWorkspaceLockResult | null {
  const guard = acquireMutationGuard(workspaceId, mutationWaitMs);
  if (!guard) return null;
  try {
    return tryAcquireWorkspaceLockUnserialized(kind, workspaceId, options);
  } finally {
    releaseMutationGuard(guard);
  }
}


export async function acquireWorkspaceLock(
  kind: WorkspaceLockKind,
  workspaceId: string,
  options: AcquireWorkspaceLockOptions = {}
): Promise<AcquireWorkspaceLockResult> {
  const leaseMs = validateDuration("leaseMs", options.leaseMs ?? defaultLeaseMs(kind), defaultLeaseMs(kind));
  const waitMs = validateWaitMs(options.waitMs);
  const pollMs = validateDuration("pollMs", options.pollMs ?? DEFAULT_POLL_MS, DEFAULT_POLL_MS);
  const deadline = Date.now() + Math.max(0, waitMs);
  const required = {
    taskId: options.taskId?.trim() || "",
    leaseMs,
    pid: options.pid ?? process.pid,
  };
  for (;;) {
    const result = tryAcquireWorkspaceLock(
      kind,
      workspaceId,
      required,
      Math.max(0, deadline - Date.now())
    );
    if (result !== null) {
      if (result.acquired || Date.now() >= deadline) return result;
    } else if (Date.now() >= deadline) {
      const lockDir = lockDirectory(kind, workspaceId);
      const current = readPersistedLock(kind, workspaceId, lockDir);
      return {
        acquired: false,
        reason: "busy",
        info: current ? toInfo(current) : null,
        expired: current ? lockExpired(kind, lockDir, current) : false,
      };
    }
    let resolveWait!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    setTimeout(resolveWait, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    await promise;
  }
}

export async function acquireSessionLock(
  workspaceId: string,
  options: AcquireWorkspaceLockOptions = {}
): Promise<AcquireWorkspaceLockResult> {
  return acquireWorkspaceLock("session", workspaceId, options);
}

export async function acquireBridgeLifecycleLock(
 workspaceId: string,
 options: AcquireWorkspaceLockOptions = {}
): Promise<AcquireWorkspaceLockResult> {
 return acquireWorkspaceLock("bridge-start", workspaceId, options);
}

function currentOwnerOrThrow(kind: WorkspaceLockKind, workspaceId: string, token: string): PersistedWorkspaceLock {
  if (!token || !token.trim()) throw new Error("C2C_SESSION_LOCK_REQUIRED: acquire the workspace session lock first");
  const lockDir = lockDirectory(kind, workspaceId);
  const current = readPersistedLock(kind, workspaceId, lockDir);
  if (!current) throw new Error("C2C_SESSION_LOCK_MISSING: the workspace session lock is not held");
  if (lockExpired(kind, lockDir, current)) throw new Error("C2C_SESSION_LOCK_EXPIRED: reacquire the workspace session lock");
  if (!tokenMatches(current.tokenHash, token.trim())) {
    throw new Error(`C2C_SESSION_LOCK_NOT_OWNER: held by task ${current.taskId ?? "unknown"}`);
  }
  return current;
}

export function assertSessionLock(workspaceId: string, token: string): WorkspaceLockInfo {
  return toInfo(currentOwnerOrThrow("session", workspaceId, token));
}

export function refreshSessionLock(workspaceId: string, token: string, leaseMs = DEFAULT_SESSION_LOCK_LEASE_MS): WorkspaceLockInfo {
  const duration = validateDuration("leaseMs", leaseMs, DEFAULT_SESSION_LOCK_LEASE_MS);
  return withMutationGuard(workspaceId, () => {
    const current = currentOwnerOrThrow("session", workspaceId, token);
    const now = Date.now();
    const refreshed: PersistedWorkspaceLock = {
      ...current,
      refreshedAt: new Date(now).toISOString(),
      expiresAt: now + duration,
    };
    writeSecureJson(ownerPath(sessionLockPath(workspaceId)), refreshed);
    return toInfo(refreshed);
  });
}

export function releaseSessionLock(workspaceId: string, token: string): void {
  withMutationGuard(workspaceId, () => {
    currentOwnerOrThrow("session", workspaceId, token);
    const lockDir = sessionLockPath(workspaceId);
    const owner = ownerPath(lockDir);
    try {
      fs.unlinkSync(owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    try {
      fs.rmdirSync(lockDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  });
}

export function readSessionLock(workspaceId: string): WorkspaceLockStatus {
  const lockDir = sessionLockPath(workspaceId);
  if (!fs.existsSync(lockDir)) return { held: false, ownerAlive: false };
  const current = readPersistedLock("session", workspaceId, lockDir);
  return {
    held: true,
    expired: lockExpired("session", lockDir, current),
    ownerAlive: ownerAlive(current),
    info: current ? toInfo(current) : null,
  };
}

export async function withBridgeLifecycleLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
 const result = await acquireWorkspaceLock("bridge-start", workspaceId, {
  taskId: `bridge-lifecycle:${process.pid}`,
  leaseMs: DEFAULT_BRIDGE_LIFECYCLE_LOCK_LEASE_MS,
  waitMs: 25_000,
  pollMs: 100,
 });
 if (!result.acquired) {
  throw new Error("C2C_BRIDGE_LIFECYCLE_BUSY: another session is changing the workspace bridge");
 }
 try {
  return await action();
 } finally {
  withMutationGuard(workspaceId, () => {
   const lockDir = lockDirectory("bridge-start", workspaceId);
   const current = readPersistedLock("bridge-start", workspaceId, lockDir);
   if (current && tokenMatches(current.tokenHash, result.handle.token)) removePath(lockDir);
  });
 }
}

export function sessionLockBusyMessage(status: WorkspaceLockStatus | Extract<AcquireWorkspaceLockResult, { acquired: false }>): string {
  const info = "info" in status ? status.info : undefined;
  if (!info) return "C2C_SESSION_LOCK_BUSY: another session owns the workspace conversation";
  const expires = new Date(info.expiresAt).toISOString();
  return `C2C_SESSION_LOCK_BUSY: task ${info.taskId ?? "unknown"} owns the workspace conversation until ${expires}`;
}