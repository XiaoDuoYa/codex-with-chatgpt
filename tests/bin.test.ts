import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("c2c bin wrapper", () => {
  it("runs the CLI exported by a built installation", () => {
    const root = makeTmpDir("bin-wrapper");

    try {
      mkdirSync(path.join(root, "bin"), { recursive: true });
      mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
      copyFileSync(path.resolve("bin/c2c.js"), path.join(root, "bin", "c2c.js"));
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(
        path.join(root, "dist", "cli", "index.js"),
        'export async function runCli() { process.stdout.write("CLI_RAN\\n"); }\n'
      );

      const result = spawnSync(process.execPath, [path.join(root, "bin", "c2c.js")], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("CLI_RAN\n");
    } finally {
      cleanup(root);
    }
  });
});
