import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { writeLastEndpoint, readLastEndpoint } from "../src/config/endpoint.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { acquireSessionLock, releaseSessionLock } from "../src/session/lock.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

class LoopbackTunnel implements TunnelProvider {
  readonly name = "loopback";
  private url: string | null = null;

  async start(localPort: number): Promise<string> {
    this.url = `http://127.0.0.1:${localPort}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.url = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return { running: this.url !== null, url: this.url, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "/loopback",
      running: this.url !== null,
      url: this.url,
      problems: [],
    };
  }
}

function runCli(entry: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", entry, ...args], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("doctor and setup pairing lifecycle", () => {
  let stateDir: string;
  let root: string;
  let bridge: Bridge | undefined;
  let previousStateDir: string | undefined;

  afterEach(async () => {
    if (bridge) {
      await bridge.close();
      bridge = undefined;
    }
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  });

  it("does not issue a pairing code when a reclaimed address is detected", async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    stateDir = isolateStateDir();
    root = makeTmpDir("doctor-read-only");
    bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      tunnelProvider: new LoopbackTunnel(),
      authStoreFile: path.join(stateDir, "auth", "store.json"),
    });

    const tunnelResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(tunnelResponse.status).toBe(200);

    writeLastEndpoint({
      workspaceId: bridge.workspace.id,
      port: bridge.port,
      publicUrl: "https://old.example.test",
      mcpUrl: "https://old.example.test/mcp",
      connectorName: "Codex with ChatGPT · test",
    });

    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
    const result = await runCli(entry, ["doctor", "-w", root, "--no-fix", "--json"], {
      ...process.env,
      C2C_STATE_DIR: stateDir,
      CODEX_HOME: path.join(stateDir, "codex-home"),
    });

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      status: string;
      exitCode: number;
      report: { oauth?: { ok: boolean } };
      chatgptRepair: { needed: boolean; status: string; pairingCode?: string };
    };
    expect(report.ok).toBe(false);
    expect(report.status).toBe("pending");
    expect(report.exitCode).toBe(0);
    expect(report.report.oauth?.ok).toBe(true);
    expect(report.chatgptRepair.needed).toBe(true);
    expect(report.chatgptRepair.status).toBe("pending");
    expect(report.chatgptRepair.pairingCode).toBeUndefined();
    expect(bridge.pairing.hasActiveSession()).toBe(false);
    expect(readLastEndpoint(bridge.workspace.id)?.observed.mcpUrl).toBe("https://old.example.test/mcp");
  });
  it("returns exit 1 in fix mode while connector repair is still pending", async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    stateDir = isolateStateDir();
    root = makeTmpDir("doctor-fix-pending");
    bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      tunnelProvider: new LoopbackTunnel(),
      authStoreFile: path.join(stateDir, "auth", "store.json"),
    });

    const tunnelResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(tunnelResponse.status).toBe(200);
    writeLastEndpoint({
      workspaceId: bridge.workspace.id,
      port: bridge.port,
      publicUrl: "https://old.example.test",
      mcpUrl: "https://old.example.test/mcp",
      connectorName: "Codex with ChatGPT · test",
    });

    const lock = await acquireSessionLock(bridge.workspace.id, { taskId: "doctor-fix", leaseMs: 60_000 });
    if (!lock.acquired) throw new Error("test fixture could not acquire session lock");
    const lockToken = lock.handle.token;
    try {
      const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
      const result = await runCli(entry, ["doctor", "-w", root, "--json", "--lock-token", lockToken], {
        ...process.env,
        C2C_STATE_DIR: stateDir,
        CODEX_HOME: path.join(stateDir, "codex-home"),
      });
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(result.stdout.trim()) as {
        status: string;
        exitCode: number;
        chatgptRepair: {
          needed: boolean;
          status: string;
          pairingCode?: string;
          pairingExpiresAt?: number;
          pairingReused: boolean;
        };
      };
      expect(report.status).toBe("pending");
      expect(report.exitCode).toBe(1);
      expect(report.chatgptRepair.needed).toBe(true);
      expect(report.chatgptRepair.status).toBe("pending");
      expect(report.chatgptRepair.pairingCode).toBeTruthy();
      expect(readLastEndpoint(bridge.workspace.id)?.pendingRepair?.generation).toBe(2);
      expect(report.chatgptRepair.pairingReused).toBe(false);

      const repeatedResult = await runCli(entry, ["doctor", "-w", root, "--json", "--lock-token", lockToken], {
        ...process.env,
        C2C_STATE_DIR: stateDir,
        CODEX_HOME: path.join(stateDir, "codex-home"),
      });
      expect(repeatedResult.status, repeatedResult.stderr).toBe(1);
      const repeatedReport = JSON.parse(repeatedResult.stdout.trim()) as {
        status: string;
        exitCode: number;
        chatgptRepair: {
          needed: boolean;
          status: string;
          pairingCode?: string;
          pairingExpiresAt?: number;
          pairingReused: boolean;
        };
      };
      expect(repeatedReport.status).toBe("pending");
      expect(repeatedReport.exitCode).toBe(1);
      expect(repeatedReport.chatgptRepair.needed).toBe(true);
      expect(repeatedReport.chatgptRepair.status).toBe("pending");
      expect(repeatedReport.chatgptRepair.pairingCode).toBe(report.chatgptRepair.pairingCode);
      expect(repeatedReport.chatgptRepair.pairingExpiresAt).toBe(report.chatgptRepair.pairingExpiresAt);
      expect(repeatedReport.chatgptRepair.pairingReused).toBe(true);
    } finally {
      releaseSessionLock(bridge.workspace.id, lockToken);
    }
  });
  it("returns the same active pairing code from repeated setup calls", async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    stateDir = isolateStateDir();
    root = makeTmpDir("setup-pairing-replay");
    bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      tunnelProvider: new LoopbackTunnel(),
      authStoreFile: path.join(stateDir, "auth", "store.json"),
    });

    const tunnelResponse = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(tunnelResponse.status).toBe(200);

    const lock = await acquireSessionLock(bridge.workspace.id, { taskId: "setup-pairing-replay", leaseMs: 60_000 });
    if (!lock.acquired) throw new Error("test fixture could not acquire session lock");
    const lockToken = lock.handle.token;
    try {
      const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
      const args = ["setup", "-w", root, "--no-tunnel", "--json", "--lock-token", lockToken];
      const firstResult = await runCli(entry, args, {
        ...process.env,
        C2C_STATE_DIR: stateDir,
        CODEX_HOME: path.join(stateDir, "codex-home"),
      });
      expect(firstResult.status, firstResult.stderr).toBe(0);
      const first = JSON.parse(firstResult.stdout.trim()) as {
        pairingCode: string;
        pairingExpiresAt: number;
        pairingReused: boolean;
      };

      const repeatedResult = await runCli(entry, args, {
        ...process.env,
        C2C_STATE_DIR: stateDir,
        CODEX_HOME: path.join(stateDir, "codex-home"),
      });
      expect(repeatedResult.status, repeatedResult.stderr).toBe(0);
      const repeated = JSON.parse(repeatedResult.stdout.trim()) as {
        pairingCode: string;
        pairingExpiresAt: number;
        pairingReused: boolean;
      };

      expect(first.pairingCode).toBeTruthy();
      expect(first.pairingReused).toBe(false);
      expect(repeated.pairingCode).toBe(first.pairingCode);
      expect(repeated.pairingExpiresAt).toBe(first.pairingExpiresAt);
      expect(repeated.pairingReused).toBe(true);
    } finally {
      releaseSessionLock(bridge.workspace.id, lockToken);
    }
  });
});
