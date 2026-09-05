import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { projectSelection } from "./helpers.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  isolateStateDir,
  makeTmpDir,
  startManagedMachineFixture,
  type ManagedMachineFixture,
} from "./helpers.js";
import { threadSessionFile } from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
let currentWorkspace: string | undefined;
let machine: ManagedMachineFixture;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(stateDir: string, args: string[]): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: currentWorkspace ?? projectRoot,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ...machine.environment, HOME: stateDir, C2C_STATE_DIR: stateDir },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runJson(stateDir: string, args: string[]): { command: CliResult; body: Record<string, any> } {
  const command = runCli(stateDir, [...args, "--json"]);
  const lines = command.stdout.trim().split("\n").filter(Boolean);
  return { command, body: JSON.parse(lines.at(-1) ?? "{}") as Record<string, any> };
}

describe("machine CLI lifecycle", () => {
  let stateDir: string;
  let workspace: string;

  beforeEach(async () => {
    stateDir = isolateStateDir();
    workspace = makeTmpDir("cli-machine-workspace");
    currentWorkspace = workspace;
    fs.writeFileSync(path.join(workspace, "marker.txt"), "machine\n");
    machine = await startManagedMachineFixture(stateDir);
  });

  afterEach(async () => {
    await machine.close();
    cleanup(workspace);
    cleanup(stateDir);
    currentWorkspace = undefined;
    delete process.env.C2C_STATE_DIR;
  });

  it("reuses one tunnel-owned machine gateway and routes an exact workspace turn", () => {
    const started = runJson(stateDir, ["machine", "start"]);
    expect(started.command.status, JSON.stringify(started)).toBe(0);
    expect(started.body).toMatchObject({ ok: true, started: false });
    expect(started.body.runtime).not.toHaveProperty("adminToken");
    expect(JSON.stringify(started.body)).not.toContain("associationNonce");
    expect((started.body.info as Record<string, unknown>).workspaceCount).toBe(0);

    const status = runJson(stateDir, ["machine", "status"]);
    expect(status.command.status).toBe(0);
    expect(status.body).toMatchObject({ ok: true, ready: true, gateway: { state: "healthy" } });
    expect(JSON.stringify(status.body)).not.toContain("adminToken");
    expect(JSON.stringify(status.body)).not.toContain("associationNonce");
    expect((status.body.gateway.info as Record<string, unknown>).machineId).toBe(
      (started.body.info as Record<string, unknown>).machineId
    );

    const doctor = runJson(stateDir, ["machine", "doctor", "--no-fix"]);
    expect(JSON.stringify(doctor.body)).not.toContain("adminToken");
    expect(JSON.stringify(doctor.body)).not.toContain("associationNonce");

    const registered = runJson(stateDir, ["machine", "workspace", "register", "-w", workspace]);
    expect(registered.command.status).toBe(0);
    const identity = registered.body.registration as {
      workspaceId: string;
      projectId: string;
      registrationId: string;
    };

    const claimed = runJson(stateDir, [
      "surface",
      "claim",
      "--project-selection", JSON.stringify(projectSelection("https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project")),
      "-w",
      workspace,
      "--local-session",
      "session-cli-machine",
      "--tab-id",
      "tab-cli-machine",
      "--project-url",
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
      "--chat-url",
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/session-cli-machine",
    ]);
    expect(claimed.command.status).toBe(0);
    const committed = runJson(stateDir, [
      "surface",
      "commit",
      "-w",
      workspace,
      "--local-session",
      "session-cli-machine",
      "--generation",
      String(claimed.body.lease.generation),
      "--tab-id",
      "tab-cli-machine",
      "--chat-url",
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/session-cli-machine",
    ]);
    expect(committed.command.status).toBe(0);

    const surface = runJson(stateDir, [
      "surface",
      "get",
      "-w",
      workspace,
      "--local-session",
      "session-cli-machine",
    ]);
    expect(surface.command.status).toBe(0);
    expect(surface.body.projectUrl).toBe(
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
    );
    const pageCheckArgs = [
      "surface", "check", "--local-session", "session-cli-machine", "--tab-id", "tab-cli-machine",
      "--generation", String(claimed.body.lease.generation),
      "--observed-url", committed.body.binding.chatUrl,
    ];
    const archived = runJson(stateDir, [...pageCheckArgs, "--page-state", "archived"]);
    expect(archived.command.status).toBe(0);
    expect(archived.body).toMatchObject({
      action: "create-project-chat", controlReady: false, targetUrl: surface.body.projectUrl, control: null,
    });
    const healthy = runJson(stateDir, [...pageCheckArgs, "--page-state", "ready"]);
    expect(healthy.body).toMatchObject({ action: "resume-chat", controlReady: true });
    const stale = runJson(stateDir, [...pageCheckArgs, "--page-state", "archived", "--generation", "999"]);
    expect(stale.command.status).toBe(1);
    expect(stale.body.error).toMatch(/tab and generation/);

    const missingRequest = runJson(stateDir, [
      "machine",
      "context",
      "issue",
      "--workspace-id",
      identity.workspaceId,
      "--project-id",
      identity.projectId,
      "--registration-id",
      identity.registrationId,
      "--local-session",
      "session-cli-machine",
      "--task",
      "task-cli-machine-missing-request",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--generation",
      "1",
    ]);
    expect(missingRequest.command.status).toBe(1);
    expect(missingRequest.body.error).toMatch(/request/);

    const issued = runJson(stateDir, [
      "machine",
      "context",
      "issue",
      "--workspace-id",
      identity.workspaceId,
      "--project-id",
      identity.projectId,
      "--registration-id",
      identity.registrationId,
      "--local-session",
      "session-cli-machine",
      "--task",
      "task-cli-machine",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--request",
      "request-cli-machine",
      "--compaction-epoch",
      "0",
      "--generation",
      "1",
      "--scopes",
      "workspace.read,c2c.result.write",
    ]);
    expect(issued.command.status).toBe(0);
    expect(issued.body.contextId).toMatch(/^c2c_ctx_[A-Za-z0-9_-]{43}$/);

    const cancelled = runJson(stateDir, ["machine", "context", "cancel", "--context-id", issued.body.contextId as string]);
    expect(cancelled.command.status).toBe(0);
    expect(cancelled.body.cancelled).toBe(true);

    const staleRelease = runJson(stateDir, [
      "surface",
      "release",
      "-w",
      workspace,
      "--local-session",
      "session-cli-machine",
      "--generation",
      "2",
      "--tab-id",
      "tab-cli-machine",
    ]);
    expect(staleRelease.command.status).toBe(1);
    expect(staleRelease.body.error).toMatch(/generation|tab-id/);

    const released = runJson(stateDir, [
      "surface",
      "release",
      "-w",
      workspace,
      "--local-session",
      "session-cli-machine",
      "--generation",
      "1",
      "--tab-id",
      "tab-cli-machine",
    ]);
    expect(released.command.status).toBe(0);
    expect(released.body.released).toBe(true);

    const retired = runJson(stateDir, [
      "surface",
      "retire",
      "-w",
      workspace,
      "--local-session",
      "session-cli-machine",
    ]);
    expect(retired.command.status).toBe(0);
    expect(retired.body).toMatchObject({
      ok: true,
      retired: true,
      revokedContexts: 0,
      mailbox: { activeRequestCleared: false },
    });

    const unregistered = runJson(stateDir, [
      "machine",
      "workspace",
      "unregister",
      "--workspace-id",
      identity.workspaceId,
      "--project-id",
      identity.projectId,
      "--registration-id",
      identity.registrationId,
    ]);
    expect(unregistered.command.status, JSON.stringify(unregistered)).toBe(0);
    expect(unregistered.body.unregistered).toBe(true);
  }, 90_000);

  it("rejects a workspace override outside the current working directory", () => {
    const otherWorkspace = makeTmpDir("cli-machine-other-workspace");
    try {
      const rejected = runJson(stateDir, [
        "machine",
        "workspace",
        "register",
        "-w",
        otherWorkspace,
      ]);
      expect(rejected.command.status).toBe(1);
      expect(rejected.body.error).toMatch(/current working directory|target workspace/i);

      const foreignUnregister = runJson(stateDir, [
        "machine",
        "workspace",
        "unregister",
        "--workspace-id",
        "foreign-workspace",
        "--project-id",
        "foreign-project",
        "--registration-id",
        "foreign-registration",
      ]);
      expect(foreignUnregister.command.status).toBe(1);
      expect(foreignUnregister.body.error).toMatch(/current working directory|workspace identity/i);

      const foreignContext = runJson(stateDir, [
        "machine",
        "context",
        "issue",
        "--workspace-id",
        "foreign-workspace",
        "--project-id",
        "foreign-project",
        "--registration-id",
        "foreign-registration",
        "--local-session",
        "foreign-session",
        "--task",
        "foreign-task",
        "--iteration",
        "0",
        "--phase",
        "BOOT",
        "--generation",
        "1",
      ]);
      expect(foreignContext.command.status).toBe(1);
      expect(foreignContext.body.error).toMatch(/current working directory|workspace identity/i);
    } finally {
      cleanup(otherWorkspace);
    }
  });

  it("reconciles the machine surface before reporting session get", () => {
    const registered = runJson(stateDir, ["machine", "workspace", "register", "-w", workspace]);
    expect(registered.command.status).toBe(0);
    const registration = registered.body.registration as { workspaceId: string };
    const localSessionId = "session-cli-reconcile";
    const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
    const chatUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/session-cli-reconcile";

    const claimed = runJson(stateDir, [
      "surface", "claim", "-w", workspace, "--local-session", localSessionId,
      "--project-selection", JSON.stringify(projectSelection(projectUrl)),
      "--tab-id", "tab-cli-reconcile", "--project-url", projectUrl, "--chat-url", chatUrl,
    ]);
    expect(claimed.command.status).toBe(0);
    const committed = runJson(stateDir, [
      "surface", "commit", "-w", workspace, "--local-session", localSessionId,
      "--generation", String(claimed.body.lease.generation), "--tab-id", "tab-cli-reconcile",
      "--chat-url", chatUrl,
    ]);
    expect(committed.command.status).toBe(0);

    const localWorkspace = new Workspace(workspace);
    expect(localWorkspace.id).toBe(registration.workspaceId);
    const threadFile = threadSessionFile(localWorkspace.id, localSessionId);
    const stale = JSON.parse(fs.readFileSync(threadFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(threadFile, JSON.stringify({
      ...stale,
      url: `${projectUrl.replace("/project", "")}/c/stale-session-route`,
      surfaceTabId: "stale-tab",
    }));

    const result = runJson(stateDir, [
      "session", "get", "-w", workspace, "--local-session", localSessionId,
    ]);
    expect(result.command.status).toBe(0);
    expect((result.body.session as Record<string, unknown>).url).toBe(chatUrl);
    expect((result.body.session as Record<string, unknown>).surfaceTabId).toBe("tab-cli-reconcile");
  });

  it("does not expose arbitrary browser or surface identity CLI options", () => {
    const help = runCli(stateDir, ["surface", "claim", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toContain("--browser-id");
    expect(help.stdout).not.toContain("--surface-id");
  });

  it("provides machine-wide autostart commands without workspace or secret fields", () => {
    const help = runCli(stateDir, ["autostart", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("enable");
    expect(help.stdout).toContain("status");
    expect(help.stdout).toContain("disable");
    expect(help.stdout).not.toContain("--workspace");

    const status = runJson(stateDir, ["autostart", "status"]);
    expect(status.command.status).toBe(0);
    expect(status.body).toMatchObject({
      ok: true,
      enabled: false,
      label: "dev.codex-with-chatgpt.machine",
      programArguments: [
        process.execPath,
        path.join(stateDir, "installation", "current", "bin", "c2c.js"),
        "autostart",
        "run",
        "--quiet",
      ],
    });
    expect([null, true, false]).toContain(status.body.loaded);
    expect(status.body).not.toHaveProperty("environment");
    expect(status.body).not.toHaveProperty("adminToken");
    expect(status.body).not.toHaveProperty("runtimeKey");
    expect(status.body).not.toHaveProperty("runtimeKeyFile");
  });

  it("uses ensureMachineGateway for the quiet autostart wake-up", () => {
    const wake = runCli(stateDir, ["autostart", "run", "--quiet"]);
    expect(wake.status).toBe(0);
    expect(wake.stdout).toBe("");
    expect(wake.stderr).toBe("");
  });

  it("keeps enable machine-scoped and returns no secret data on errors", () => {
    const enabled = runJson(stateDir, ["autostart", "enable", "--interval-seconds", "1"]);
    expect(enabled.command.status).toBe(1);
    expect(enabled.body.ok).toBe(false);
    expect(enabled.body.error).toMatch(/interval/);
    expect(enabled.body).not.toHaveProperty("environment");
    expect(enabled.body).not.toHaveProperty("adminToken");
    expect(enabled.body).not.toHaveProperty("runtimeKey");
    expect(enabled.body).not.toHaveProperty("runtimeKeyFile");
  });
});
