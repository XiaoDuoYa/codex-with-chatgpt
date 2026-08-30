import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { findTrustedExecutable } from "../src/process/executable.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function fakeExecutable(dir: string, name: string): string {
  const filename = process.platform === "win32" ? `${name}.exe` : name;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, "test marker");
  if (process.platform !== "win32") fs.chmodSync(file, 0o700);
  return fs.realpathSync.native(file);
}

describe("trusted executable resolution", () => {
  it("skips a workspace-local executable even when PATH lists it first", () => {
    const workspace = makeTmpDir("exe-workspace");
    const trustedDir = makeTmpDir("exe-trusted");
    dirs.push(workspace, trustedDir);
    fakeExecutable(workspace, "c2c-probe");
    const trusted = fakeExecutable(trustedDir, "c2c-probe");

    const found = findTrustedExecutable("c2c-probe", {
      forbiddenRoots: [workspace],
      pathValue: `${workspace}${path.delimiter}${trustedDir}`,
    });
    expect(found).toBe(trusted);
  });

  it("never returns a relative executable override", () => {
    expect(findTrustedExecutable("c2c-probe", { override: ".\\c2c-probe.exe", pathValue: "" })).toBeNull();
  });
});
