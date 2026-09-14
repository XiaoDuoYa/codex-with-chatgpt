import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

describe("machine-wide commands accept leftover -w", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.CODEX_HOME;
  });

  it("update-check --json -w does not fail with unknown option", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["update-check", "--json", "-w", "C:/Projects/aquant"], {
      C2C_STATE_DIR: process.env.C2C_STATE_DIR,
    });
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("prefs --json -w does not fail with unknown option", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["prefs", "--json", "-w", "C:/Projects/aquant"], {
      C2C_STATE_DIR: process.env.C2C_STATE_DIR,
    });
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("prefs set preserves browser-mode when -w is present", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["prefs", "set", "--browser-mode", "shared", "--json", "-w", "C:/Projects/aquant"], {
      C2C_STATE_DIR: process.env.C2C_STATE_DIR,
    });
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; browserMode: string };
    expect(payload).toMatchObject({ ok: true, browserMode: "shared" });
  });

  it("sandbox-allow --json -w does not fail with unknown option", () => {
    const stateDir = isolateStateDir();
    const codexHome = makeTmpDir("cli-w-codex-home");
    dirs.push(stateDir, codexHome);
    const result = runCli(["sandbox-allow", "--json", "-w", "C:/Projects/aquant"], {
      C2C_STATE_DIR: stateDir,
      CODEX_HOME: codexHome,
    });
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});
