import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cleanup, makeTmpDir, write } from "./helpers.js";

describe("V0.1 CLI compatibility", () => {
  it("keeps workspace JSON keys stable", () => {
    const root = makeTmpDir("cli-compat");
    try {
      write(root, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
      const result = spawnSync(
        process.execPath,
        [path.resolve("bin/c2c.js"), "workspace", "-w", root, "--json"],
        { cwd: path.resolve("."), encoding: "utf8" }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        name: path.basename(root),
        root,
        projectType: "node",
        scripts: { test: "vitest run" },
      });
    } finally {
      cleanup(root);
    }
  });
});
