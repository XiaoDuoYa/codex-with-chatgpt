import { spawnSync } from "node:child_process";
import { Workspace } from "../src/workspace/manager.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

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

  it("doctor reports a missing named tunnel credential without attempting repair", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("doctor-named-credential");
    const credentialDir = makeTmpDir("doctor-named-credential-file");
    dirs.push(stateDir, root, credentialDir);
    makeGitRepo(root);
    const workspace = new Workspace(root);
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-test",
      tunnelId,
      hostname: "c2c-test.example.com",
    });
    const certPath = write(credentialDir, "cert.pem", "synthetic cert");
    const credentialPath = path.join(credentialDir, `${tunnelId}.json`);
    const result = runCli(["doctor", "--json", "--no-fix", "-w", root], {
      C2C_STATE_DIR: stateDir,
      TUNNEL_ORIGIN_CERT: certPath,
      TUNNEL_CRED_FILE: credentialPath,
      C2C_TUNNEL_PROTOCOL: undefined,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      report: { tunnel?: { ok: boolean; detail?: string } };
      namedRepair: { needed: boolean; userMessage?: string };
    };
    expect(payload.report.tunnel).toEqual({ ok: false, detail: "NAMED_TUNNEL_CREDENTIAL_MISSING_CREDENTIALS" });
    expect(payload.namedRepair.needed).toBe(true);
    expect(payload.namedRepair.userMessage).toContain("cloudflared tunnel token");
    expect(payload.namedRepair.userMessage).not.toContain("synthetic cert");
  });
});
