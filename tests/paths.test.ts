import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonIfExists, writeSecureJson } from "../src/config/paths.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("writeSecureJson", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) cleanup(dirs.pop()!);
  });

  it("writes JSON and leaves no temporary file", () => {
    const dir = makeTmpDir("secure-json");
    dirs.push(dir);
    const file = path.join(dir, "state", "session.json");

    writeSecureJson(file, { ok: true, value: 42 });

    expect(readJsonIfExists(file)).toEqual({ ok: true, value: 42 });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["session.json"]);
  });

  it("replaces the previous state file without leaving temporary files", () => {
    const dir = makeTmpDir("secure-json-replace");
    dirs.push(dir);
    const file = path.join(dir, "state.json");

    writeSecureJson(file, { version: 1 });
    writeSecureJson(file, { version: 2 });

    expect(readJsonIfExists(file)).toEqual({ version: 2 });
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("keeps the previous file when serialization fails", () => {
    const dir = makeTmpDir("secure-json-failure");
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), { mode: 0o600 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => writeSecureJson(file, circular)).toThrow(TypeError);

    expect(readJsonIfExists(file)).toEqual({ version: 1 });
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("keeps the previous file and removes the temporary file when the rename swap fails", () => {
    const dir = makeTmpDir("secure-json-swap-failure");
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    writeSecureJson(file, { version: 1 });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated swap failure");
    });

    expect(() => writeSecureJson(file, { version: 2 })).toThrow(/simulated swap failure/);

    expect(readJsonIfExists(file)).toEqual({ version: 1 });
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
    rename.mockRestore();
  });

  it.skipIf(process.platform === "win32")("creates owner-only files on POSIX", () => {
    const dir = makeTmpDir("secure-json-mode");
    dirs.push(dir);
    const file = path.join(dir, "state.json");

    writeSecureJson(file, { ok: true });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
