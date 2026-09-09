import { createHash } from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliEntry, ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("c2c authorize-plan", () => {
  it("returns a digest-bound, one-time authorization from the live local bridge", async () => {
    isolateStateDir();
    const root = makeTmpDir("authorize-plan-cli");
    const project = "sample-project";
    const content = "# Sample\n";
    const payload = {
      schema: 2,
      project,
      classification: "synthetic",
      files: [{ path: "PROJECT.md", bytes: Buffer.byteLength(content), sha256: sha256(content) }],
      limits: { max_file_bytes: 1_000_000, max_total_bytes: 10_000_000 },
    };
    const digest = sha256(canonical(payload) + "\n");
    write(root, `${project}/PROJECT.md`, content);
    write(root, `${project}/CONTEXT-MANIFEST.json`, JSON.stringify({ ...payload, approval_digest: digest }));
    fs.chmodSync(root, 0o700);
    fs.chmodSync(path.join(root, project), 0o700);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true });
    try {
      const result = await runCli([
        "authorize-plan",
        "--workspace",
        root,
        "--project",
        project,
        "--digest",
        digest,
        "--ttl-seconds",
        "60",
        "--json",
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toMatchObject({ ok: true, project, stagedDigest: digest });
      expect(output.authorization).toMatch(/^c2c_plan_[A-Za-z0-9_-]{43}$/);
      expect(Number(output.expiresAt)).toBeGreaterThan(Date.now());
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });
});
