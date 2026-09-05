import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restorePrivateFile, snapshotPrivateFile } from "../src/config/private-file.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) cleanup(dirs.pop()!);
});

describe("private setup file rollback", () => {
  it("snapshots bytes and exact mode for a regular file", () => {
    const root = makeTmpDir("private-file-snapshot");
    dirs.push(root);
    const file = path.join(root, "config.json");
    fs.writeFileSync(file, "previous\n", { mode: 0o640 });
    fs.chmodSync(file, 0o640);

    expect(snapshotPrivateFile(file)).toEqual({
      bytes: Buffer.from("previous\n"),
      mode: 0o640,
    });
  });

  it("rejects symlink and directory targets before reading or deleting", () => {
    const root = makeTmpDir("private-file-invalid");
    const outside = makeTmpDir("private-file-outside");
    dirs.push(root, outside);
    const outsideFile = path.join(outside, "secret");
    fs.writeFileSync(outsideFile, "must remain unchanged");
    const symlink = path.join(root, "config.json");
    fs.symlinkSync(outsideFile, symlink);

    expect(() => snapshotPrivateFile(symlink)).toThrow(/symbolic link/);
    expect(() => restorePrivateFile(symlink, null)).toThrow(/symbolic link/);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("must remain unchanged");

    const directory = path.join(root, "directory");
    fs.mkdirSync(directory);
    expect(() => snapshotPrivateFile(directory)).toThrow(/regular file/);
    expect(() => restorePrivateFile(directory, null)).toThrow(/regular file/);
  });

  it("restores through a same-directory atomic rename and preserves mode", () => {
    const root = makeTmpDir("private-file-atomic");
    dirs.push(root);
    const file = path.join(root, "runtime.key");
    fs.writeFileSync(file, "old", { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    const snapshot = { bytes: Buffer.from("new"), mode: 0o600 };
    const rename = vi.spyOn(fs, "renameSync");

    restorePrivateFile(file, snapshot);

    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(path.dirname(rename.mock.calls[0][0] as string)).toBe(root);
    expect(path.dirname(rename.mock.calls[0][1] as string)).toBe(root);
  });

  it("keeps the original file when publication fails", () => {
    const root = makeTmpDir("private-file-atomic-failure");
    dirs.push(root);
    const file = path.join(root, "config.json");
    fs.writeFileSync(file, "old", { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated publication failure");
    });

    expect(() => restorePrivateFile(file, { bytes: Buffer.from("new"), mode: 0o600 })).toThrow(
      /simulated publication failure/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(root)).toEqual(["config.json"]);
  });
});
