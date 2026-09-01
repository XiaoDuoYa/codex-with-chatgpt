import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acquireSessionLock, releaseSessionLock } from "../src/session/lock.js";
import { observeWorkspaceEndpoint, readLastEndpoint } from "../src/config/endpoint.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

type CliResult = { status: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const child = spawn(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: projectRoot,
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
  return promise;
}

interface PendingEndpointFixture {
  root: string;
  stateDir: string;
  workspace: Workspace;
  token: string;
  previousStateDir: string | undefined;
}

async function withPendingEndpoint(name: string): Promise<PendingEndpointFixture> {
  const previousStateDir = process.env.C2C_STATE_DIR;
  const stateDir = isolateStateDir();
  const root = makeTmpDir(name);
  const workspace = new Workspace(root);
  const pending = observeWorkspaceEndpoint({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    port: 1234,
    publicUrl: "https://old.example.test",
    mcpUrl: "https://old.example.test/mcp",
  });
  if (!pending.pendingRepair) throw new Error("test fixture did not create pending repair");
  const lock = await acquireSessionLock(workspace.id, { taskId: name, leaseMs: 60_000 });
  if (!lock.acquired) throw new Error("test fixture could not acquire session lock");
  return { root, stateDir, workspace, token: lock.handle.token, previousStateDir };
}

function finishFixture(fixture: PendingEndpointFixture): void {
  releaseSessionLock(fixture.workspace.id, fixture.token);
  cleanup(fixture.root);
  cleanup(fixture.stateDir);
  if (fixture.previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = fixture.previousStateDir;
}

function childEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: path.join(stateDir, "codex-home") };
}

describe.sequential("CLI connector and session lifecycle", () => {
  it("reports a pre-commit or prewritten session as unusable while repair is pending", async () => {
    const fixture = await withPendingEndpoint("cli-pending-session");
    try {
      const state = readLastEndpoint(fixture.workspace.id)!;
      const file = path.join(fixture.stateDir, "sessions", `${fixture.workspace.id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          url: "https://chatgpt.com/c/old",
          generation: state.pendingRepair!.generation,
          fingerprint: state.pendingRepair!.fingerprint,
          savedAt: new Date().toISOString(),
        })
      );
      const result = await runCli(["session", "get", "-w", fixture.root, "--json"], childEnv(fixture.stateDir));
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout.trim()) as { usable: boolean; reason: string };
      expect(output.usable).toBe(false);
      expect(output.reason).toBe("connector_unbound");
    } finally {
      finishFixture(fixture);
    }
  });

  it("makes the session usable only when URL-bearing connector commit succeeds", async () => {
    const fixture = await withPendingEndpoint("cli-commit-session");
    try {
      const state = readLastEndpoint(fixture.workspace.id)!;
      const pending = state.pendingRepair!;
      const commit = await runCli(
        [
          "connector",
          "commit",
          "-w",
          fixture.root,
          "--generation",
          String(pending.generation),
          "--fingerprint",
          pending.fingerprint,
          "--url",
          "https://chatgpt.com/c/new",
          "--title",
          "verified",
          "--lock-token",
          fixture.token,
          "--json",
        ],
        childEnv(fixture.stateDir)
      );
      expect(commit.status, commit.stderr).toBe(0);
      const commitOutput = JSON.parse(commit.stdout.trim()) as { ok: boolean; sessionUsable: boolean };
      expect(commitOutput.ok).toBe(true);
      expect(commitOutput.sessionUsable).toBe(true);

      const result = await runCli(["session", "get", "-w", fixture.root, "--json"], childEnv(fixture.stateDir));
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout.trim()) as {
        usable: boolean;
        session: { url: string; generation: number; fingerprint: string };
      };
      expect(output.usable).toBe(true);
      expect(output.session.url).toBe("https://chatgpt.com/c/new");
      expect(output.session.generation).toBe(pending.generation);
      expect(output.session.fingerprint).toBe(pending.fingerprint);
      expect(readLastEndpoint(fixture.workspace.id)?.pendingRepair).toBeNull();
    } finally {
      finishFixture(fixture);
    }
  });

  it("rejects generation or fingerprint mismatches without consuming pending repair", async () => {
    const fixture = await withPendingEndpoint("cli-commit-mismatch");
    try {
      const state = readLastEndpoint(fixture.workspace.id)!;
      const pending = state.pendingRepair!;
      const result = await runCli(
        [
          "connector",
          "commit",
          "-w",
          fixture.root,
          "--generation",
          String(pending.generation + 1),
          "--fingerprint",
          pending.fingerprint,
          "--url",
          "https://chatgpt.com/c/wrong",
          "--lock-token",
          fixture.token,
          "--json",
        ],
        childEnv(fixture.stateDir)
      );
      expect(result.status, result.stderr).toBe(1);
      const output = JSON.parse(result.stdout.trim()) as { ok: boolean; error: string };
      expect(output.ok).toBe(false);
      expect(output.error).toContain("C2C_CONNECTOR_BINDING_MISMATCH");
      const after = readLastEndpoint(fixture.workspace.id)!;
      expect(after.connectorBound).toBeNull();
      expect(after.pendingRepair?.generation).toBe(pending.generation);
      expect(fs.existsSync(path.join(fixture.stateDir, "sessions", `${fixture.workspace.id}.json`))).toBe(false);
    } finally {
      finishFixture(fixture);
    }
  });

  it("reports the caller PID and lock recovery state in JSON", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const root = makeTmpDir("cli-lock-contract");
    const workspace = new Workspace(root);
    const env = childEnv(stateDir);
    let token: string | undefined;

    try {
      const first = await runCli(
        [
          "session",
          "lock",
          "acquire",
          "-w",
          root,
          "--task",
          "cli-lock-contract",
          "--lease-ms",
          "60000",
          "--json",
        ],
        env
      );
      expect(first.status, first.stderr).toBe(0);
      const firstOutput = JSON.parse(first.stdout.trim()) as {
        ok: boolean;
        acquired: boolean;
        recovered: boolean;
        token: string;
        lock: { pid: number };
      };
      expect(firstOutput).toMatchObject({
        ok: true,
        acquired: true,
        recovered: false,
        lock: { pid: process.pid },
      });
      token = firstOutput.token;

      const status = await runCli(["session", "lock", "status", "-w", root, "--json"], env);
      expect(status.status, status.stderr).toBe(0);
      const statusOutput = JSON.parse(status.stdout.trim()) as {
        lock: { held: boolean; expired: boolean; ownerAlive: boolean; info: { pid: number } };
      };
      expect(statusOutput.lock).toMatchObject({
        held: true,
        expired: false,
        ownerAlive: true,
        info: { pid: process.pid },
      });

      const second = await runCli(
        [
          "session",
          "lock",
          "acquire",
          "-w",
          root,
          "--task",
          "cli-lock-contract",
          "--lease-ms",
          "60000",
          "--json",
        ],
        env
      );
      expect(second.status, second.stderr).toBe(0);
      const secondOutput = JSON.parse(second.stdout.trim()) as {
        ok: boolean;
        acquired: boolean;
        recovered: boolean;
        token: string;
        lock: { pid: number };
      };
      expect(secondOutput).toMatchObject({
        ok: true,
        acquired: true,
        recovered: true,
        lock: { pid: process.pid },
      });
      expect(secondOutput.token).not.toBe(token);
      token = secondOutput.token;
    } finally {
      if (token) {
        const released = await runCli(["session", "lock", "release", "-w", root, "--token", token, "--json"], env);
        expect(released.status, released.stderr).toBe(0);
      }
      cleanup(root);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });
});
