import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

describe("doctor authorization gate", () => {
  let stateDir: string | null = null;
  let workspace: string | null = null;
  let bridge: Bridge | null = null;

  afterEach(async () => {
    await bridge?.close();
    if (workspace) cleanup(workspace);
    if (stateDir) cleanup(stateDir);
    bridge = null;
    workspace = null;
    stateDir = null;
    delete process.env.C2C_STATE_DIR;
  });

  async function doctor(): Promise<Record<string, unknown>> {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx/esm", cliEntry, "doctor", "-w", workspace!, "--no-fix", "--json"],
      {
        cwd: projectRoot,
        env: { ...process.env, C2C_STATE_DIR: stateDir! },
      }
    );
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  }

  it("requires the newest ChatGPT connector itself to hold result-write scope", async () => {
    stateDir = isolateStateDir();
    workspace = makeTmpDir("doctor-auth-workspace");
    write(workspace, "README.md", "doctor auth test\n");
    bridge = await startBridge({ workspaceRoot: workspace, port: 0, persistRuntime: true });

    bridge.authStore.issueTokens({
      clientId: "c2c_client_local_probe",
      scopes: ["workspace.read", "c2c.result.write", "offline_access"],
    });
    expect(await doctor()).toMatchObject({
      report: { oauth: { ok: false, detail: "ChatGPT 连接尚未注册" } },
    });

    const connector = bridge.authStore.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/current"],
    });
    expect(await doctor()).toMatchObject({
      report: { oauth: { ok: false, detail: "ChatGPT 连接尚未完成授权" } },
    });

    bridge.authStore.issueTokens({
      clientId: connector.clientId,
      scopes: ["workspace.read", "c2c.result.write", "offline_access"],
    });
    expect(await doctor()).toMatchObject({
      report: { oauth: { ok: true } },
    });
  }, 30_000);
});
