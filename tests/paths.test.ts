import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock, withFileLockAsync } from "../src/config/paths.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("state file locks", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length) cleanup(dirs.pop()!);
  });

  it.each([
    ["synchronous", async (file: string) => withFileLock(file, () => "ok")],
    ["asynchronous", (file: string) => withFileLockAsync(file, async () => "ok")],
  ])("cleans up a %s lock when owner metadata cannot be written", async (_name, acquire) => {
    const dir = makeTmpDir("state-lock-write-failure");
    dirs.push(dir);
    const lockFile = path.join(dir, "state.lock");
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      const error = new Error("simulated lock owner write failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    });

    await expect(acquire(lockFile)).rejects.toThrow(/simulated lock owner write failure/);
    expect(fs.existsSync(lockFile)).toBe(false);
    await expect(acquire(lockFile)).resolves.toBe("ok");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it.each([
    [
      "synchronous",
      async (file: string) =>
        withFileLock(file, () => "unexpected", { timeoutMs: 30, staleMs: 1_000 }),
    ],
    [
      "asynchronous",
      (file: string) =>
        withFileLockAsync(file, async () => "unexpected", { timeoutMs: 30, staleMs: 1_000 }),
    ],
  ])("does not remove a replacement %s lock while cleaning a stale inode", async (_name, acquire) => {
    const dir = makeTmpDir("state-lock-replaced");
    dirs.push(dir);
    const lockFile = path.join(dir, "state.lock");
    fs.writeFileSync(lockFile, "2147483647\n2000-01-01T00:00:00.000Z\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);

    const originalStatSync = fs.statSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "statSync").mockImplementation(
      ((target: fs.PathLike) => {
        if (!replaced && path.resolve(String(target)) === lockFile) {
          replaced = true;
          fs.rmSync(lockFile);
          fs.writeFileSync(lockFile, `${process.pid}\n${new Date().toISOString()}\n`);
        }
        return originalStatSync(target);
      }) as typeof fs.statSync
    );

    await expect(acquire(lockFile)).rejects.toThrow(/timed out waiting for state lock/);
    expect(replaced).toBe(true);
    expect(fs.readFileSync(lockFile, "utf8")).toMatch(new RegExp(`^${process.pid}\\n`));
  });

  it.each([
    [
      "synchronous",
      async (file: string, action: () => string) =>
        withFileLock(file, action, { timeoutMs: 30, staleMs: 1_000 }),
    ],
    [
      "asynchronous",
      (file: string, action: () => string) =>
        withFileLockAsync(file, async () => action(), { timeoutMs: 30, staleMs: 1_000 }),
    ],
  ])("does not enter a %s lock while stale recovery owns the reaper marker", async (_name, acquire) => {
    const dir = makeTmpDir("state-lock-reaper");
    dirs.push(dir);
    const lockFile = path.join(dir, "state.lock");
    const markerFile = `${lockFile}.reap-${process.pid}-active`;
    fs.writeFileSync(markerFile, `${process.pid}\n${new Date().toISOString()}\n`);
    let entered = false;

    await expect(
      acquire(lockFile, () => {
        entered = true;
        return "unexpected";
      })
    ).rejects.toThrow(/timed out waiting for state lock/);
    expect(entered).toBe(false);

    fs.rmSync(markerFile);
    await expect(acquire(lockFile, () => "ok")).resolves.toBe("ok");
  });

  it.each([
    ["synchronous", async (file: string, action: () => string) => withFileLock(file, action)],
    ["asynchronous", (file: string, action: () => string) => withFileLockAsync(file, async () => action())],
  ])("retries a %s lock when stale recovery unlinks its candidate", async (_name, acquire) => {
    const dir = makeTmpDir("state-lock-unlinked-candidate");
    dirs.push(dir);
    const lockFile = path.join(dir, "state.lock");
    const originalReaddirSync = fs.readdirSync.bind(fs);
    let lockDirectoryReads = 0;
    vi.spyOn(fs, "readdirSync").mockImplementation(
      ((target: fs.PathLike) => {
        if (path.resolve(String(target)) === dir && ++lockDirectoryReads === 2) {
          fs.rmSync(lockFile);
        }
        return originalReaddirSync(target);
      }) as typeof fs.readdirSync
    );

    let publishedDuringAction = false;
    await expect(
      acquire(lockFile, () => {
        publishedDuringAction = fs.existsSync(lockFile);
        return "ok";
      })
    ).resolves.toBe("ok");
    expect(lockDirectoryReads).toBeGreaterThanOrEqual(4);
    expect(publishedDuringAction).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});
