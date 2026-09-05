import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportControlProgress, submitControlResult } from "../src/control/mailbox.js";
import { readMachineRuntime } from "../src/gateway/runtime.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  cleanup,
  isolateStateDir,
  makeTmpDir,
  startManagedMachineFixture,
  type ManagedMachineFixture,
  write,
  projectSelection,
} from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

let stateDir: string;
let workspace: string;
let machine: ManagedMachineFixture;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd = workspace): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...machine.environment, C2C_STATE_DIR: stateDir },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runJson(
  args: string[],
  cwd = workspace,
): { command: CliResult; body: Record<string, unknown> } {
  const command = runCli([...args, "--json"], cwd);
  const lines = command.stdout.trim().split("\n").filter(Boolean);
  return { command, body: JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

function planResult(requestId: string) {
  return {
    requestId,
    localSessionId: "session-a",
    taskId: "c2c_0123456789abcdef",
    iteration: 0,
    phase: "PLAN",
    kind: "PLAN",
    payload: {
      goal: "Keep one local question matched to one ChatGPT answer",
      rationale: "Exact correlation prevents another turn or local session from consuming this answer.",
      actions: [{ change: "read only the correlated result", why: "avoid cross-turn confusion" }],
      tests: ["run CLI correlation smoke tests"],
      successCriteria: ["only the owning session can acknowledge the answer"],
    },
  } as const;
}

beforeEach(async () => {
  stateDir = isolateStateDir();
  workspace = makeTmpDir("cli-control-workspace");
  machine = await startManagedMachineFixture(stateDir);
});

afterEach(async () => {
  await machine.close();
  cleanup(workspace);
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

function claimSurface(localSessionId: string, tabId = `tab-${localSessionId}`): void {
  const claimed = runJson([
    "surface",
    "claim",
    "--project-selection", JSON.stringify(projectSelection("https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project")),
    "-w",
    workspace,
    "--local-session",
    localSessionId,
    "--tab-id",
    tabId,
    "--project-url",
    "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
    "--chat-url",
    `https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/${localSessionId}`,
  ]);
  expect(claimed.command.status).toBe(0);
  const lease = claimed.body.lease as { generation: number; tabId: string };
  const committed = runJson([
    "surface",
    "commit",
    "-w",
    workspace,
    "--local-session",
    localSessionId,
    "--generation",
    String(lease.generation),
    "--tab-id",
    lease.tabId,
    "--chat-url",
    `https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/${localSessionId}`,
  ]);
  expect(committed.command.status).toBe(0);
}

describe("control CLI correlation", () => {
  it("reuses one page across tasks and grants only selected observed app reads", () => {
    const localSessionId = "session-app-reads";
    claimSurface(localSessionId);
    const current = runJson(["surface", "get", "--local-session", localSessionId]);
    const page = current.body.lease as { tabId: string; chatUrl: string; generation: number };
    for (const taskId of ["research-docs", "review-docs"]) {
      const proof = {
        workspaceId: new Workspace(workspace).id, localSessionId, taskId, iteration: 0, phase: "RESEARCH",
        tabId: page.tabId, chatUrl: page.chatUrl, generation: page.generation,
        bootEpoch: readMachineRuntime()!.bootEpoch,
        observedAt: new Date().toISOString(), chatgptAccount: "fixture-account",
        requestedOperations: [{ plugin: "Docs", tool: "search_docs" }],
        plugins: [{ id: "Docs", availability: "available", usesGitHub: false, tools: [
          { tool: "search_docs", availability: "available", effect: "read" },
          { tool: "publish_doc", availability: "available", effect: "write" },
        ] }],
      };
      const args = ["control", "open", "--local-session", localSessionId, "--task", taskId, "--iteration", "0", "--phase", "RESEARCH", "--plugins", "Docs"];
      const unsafe = runJson([...args, "--plugin-preflight", JSON.stringify({ ...proof, requestedOperations: [{ plugin: "Docs", tool: "publish_doc" }] })]);
      expect(unsafe.command.status).toBe(1);
      expect(runJson(["surface", "get", "--local-session", localSessionId]).body.control).toBeNull();
      const opened = runJson([...args, "--plugin-preflight", JSON.stringify(proof)]);
      expect(opened.command.status).toBe(0);
      expect(opened.body.surface).toEqual({ tabId: page.tabId, chatUrl: page.chatUrl, generation: page.generation });
      expect(opened.body.pluginPolicy).toEqual({ allowedPlugins: ["Docs"], access: "read-only", allowedOperations: [{ plugin: "Docs", tool: "search_docs" }] });
      const request = opened.body.request as { requestId: string };
      expect(runJson(["control", "cancel", "--local-session", localSessionId, "--task", taskId, "--iteration", "0", "--phase", "RESEARCH", "--request", request.requestId]).command.status).toBe(0);
    }
  }, 90_000);

  it("opens a profile-only bootstrap with an unknown actor and excludes repository scopes", () => {
    const localSessionId = "session-profile-discovery";
    claimSurface(localSessionId);
    const current = runJson(["surface", "get", "--local-session", localSessionId]);
    const page = current.body.lease as { tabId: string; chatUrl: string; generation: number };
    const proof = {
      workspaceId: new Workspace(workspace).id, localSessionId,
      taskId: "task-profile", iteration: 0, phase: "RESEARCH",
      tabId: page.tabId, chatUrl: page.chatUrl, generation: page.generation,
      bootEpoch: readMachineRuntime()!.bootEpoch,
      observedAt: new Date().toISOString(), chatgptAccount: "fixture-account",
      plugins: [{ id: "GitHub", availability: "available", usesGitHub: true, authenticatedProfileTool: "get_authenticated_user" }],
    };
    const args = ["control", "open", "--local-session", localSessionId, "--task", "task-profile", "--iteration", "0", "--phase", "RESEARCH", "--plugins", "GitHub", "--plugin-intent", "identity-discovery", "--plugin-preflight", JSON.stringify(proof)];
    const unsafe = runJson([...args, "--scopes", "git.read"]);
    expect(unsafe.command.status).toBe(1);
    expect(runJson(["surface", "get", "--local-session", localSessionId]).body.control).toBeNull();
    const opened = runJson(args);
    expect(opened.command.status).toBe(0);
    expect(opened.body.pluginPolicy).toEqual({ allowedPlugins: ["GitHub"], access: "authenticated-profile-only", repositoryAccess: "none", allowedOperations: [{ plugin: "GitHub", tool: "get_authenticated_user" }] });
    const request = opened.body.request as { requestId: string };
    const cancelled = runJson(["control", "cancel", "--local-session", localSessionId, "--task", "task-profile", "--iteration", "0", "--phase", "RESEARCH", "--request", request.requestId]);
    expect(cancelled.command.status).toBe(0);
  });

  it("rejects plugin dispatch without fresh observations before opening a mailbox", () => {
    claimSurface("session-plugin-gate");
    const failed = runJson(["control", "open", "--local-session", "session-plugin-gate", "--task", "plugin-task", "--iteration", "0", "--phase", "PLAN", "--plugins", "GitHub"]);
    expect(failed.command.status).toBe(1);
    const current = runJson(["surface", "get", "--local-session", "session-plugin-gate"]);
    expect(current.command.status).toBe(0);
    expect(current.body.control).toBeNull();
  });

  it("supports a Project-only candidate until the first chat URL is observed", () => {
    const claimed = runJson([
      "surface",
      "claim",
      "--project-selection", JSON.stringify(projectSelection("https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project")),
      "-w",
      workspace,
      "--local-session",
      "session-project-candidate",
      "--tab-id",
      "tab-project-candidate",
      "--project-url",
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
    ]);
    expect(claimed.command.status).toBe(0);
    expect((claimed.body.lease as Record<string, unknown>).chatUrl).toBeUndefined();

    const generation = (claimed.body.lease as { generation: number }).generation;
    const committed = runJson([
      "surface",
      "commit",
      "-w",
      workspace,
      "--local-session",
      "session-project-candidate",
      "--generation",
      String(generation),
      "--tab-id",
      "tab-project-candidate",
      "--chat-url",
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/project-first-chat",
    ]);
    expect(committed.command.status).toBe(0);
    expect(committed.body.binding).toMatchObject({
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/project-first-chat",
      lastGeneration: generation,
    });
    expect((committed.body.session as Record<string, unknown>).url).toBe(
      "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/project-first-chat",
    );
  });

  it("binds control cancellation to the capability's exact correlation", () => {
    claimSurface("session-cancel-binding");
    const opened = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-binding",
      "--task",
      "c2c_cancel_binding",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(opened.command.status).toBe(0);
    const requestId = String((opened.body.request as { requestId: string }).requestId);

    const wrong = runJson([
      "control",
      "cancel",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-binding",
      "--request",
      requestId,
      "--task",
      "c2c_wrong_cancel_binding",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(wrong.command.status).toBe(1);
    expect(wrong.body.error).toMatch(/match|binding|correlation/i);
    const stillPending = runJson([
      "control",
      "status",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-binding",
      "--request",
      requestId,
      "--task",
      "c2c_cancel_binding",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(stillPending.body.status).toBe("pending");

    const cancelled = runJson([
      "control",
      "cancel",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-binding",
      "--request",
      requestId,
      "--task",
      "c2c_cancel_binding",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(cancelled.command.status).toBe(0);
    const cancelledStatus = runJson([
      "control",
      "status",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-binding",
      "--request",
      requestId,
      "--task",
      "c2c_cancel_binding",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(cancelledStatus.body.status).toBe("cancelled");
  }, 60_000);

  it("opens RESEARCH requests and exposes their current progress", () => {
    claimSurface("session-research");
    const opened = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-research",
      "--task",
      "c2c_research1",
      "--iteration",
      "0",
      "--phase",
      "RESEARCH",
    ]);
    expect(opened.command.status, JSON.stringify(opened)).toBe(0);
    expect(opened.body.contextId).toMatch(/^c2c_ctx_[A-Za-z0-9_-]{43}$/);
    expect(opened.body.surface).toMatchObject({
      tabId: "tab-session-research",
      generation: 1,
    });
    expect(opened.body.contextExpiresAt).toEqual(expect.any(String));
    const request = opened.body.request as {
      requestId: string;
      workspaceId: string;
      allowedKinds: string[];
    };
    const pending = runJson([
      "control",
      "status",
      "-w",
      workspace,
      "--local-session",
      "session-research",
      "--request",
      request.requestId,
      "--task",
      "c2c_research1",
      "--iteration",
      "0",
      "--phase",
      "RESEARCH",
    ]);
    expect(pending.body.status).toBe("pending");
    expect(request.allowedKinds).toEqual(["RESEARCH", "BLOCKED"]);

    reportControlProgress(request.workspaceId, {
      requestId: request.requestId,
      localSessionId: "session-research",
      taskId: "c2c_research1",
      iteration: 0,
      phase: "RESEARCH",
      status: "SEARCHING",
      message: "Checking current sources.",
    });
    const status = runJson([
      "control",
      "status",
      "-w",
      workspace,
      "--local-session",
      "session-research",
      "--request",
      request.requestId,
      "--task",
      "c2c_research1",
      "--iteration",
      "0",
      "--phase",
      "RESEARCH",
    ]);
    expect(status.command.status).toBe(0);
    expect(status.body.progress).toMatchObject({ status: "SEARCHING" });
  });

  it("keeps one question and answer bound through open, wait, and acknowledge", () => {
    claimSurface("session-a");
    const opened = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(opened.command.status, JSON.stringify(opened)).toBe(0);
    const request = opened.body.request as { requestId: string; workspaceId: string };

    const overlapping = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "1",
      "--phase",
      "REVIEW",
    ]);
    expect(overlapping.command.status).toBe(1);
    expect(overlapping.body.code).toBe("MAILBOX_TURN_IN_PROGRESS");

    const wrongSession = runJson([
      "control",
      "wait",
      "-w",
      workspace,
      "--local-session",
      "session-b",
      "--request",
      request.requestId,
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--timeout-ms",
      "0",
    ]);
    expect(wrongSession.command.status).toBe(1);
    expect(wrongSession.body.code).toBe("MAILBOX_SESSION_MISMATCH");

    for (const mismatch of [
      { task: "c2c_fedcba9876543210", iteration: "0", phase: "PLAN" },
      { task: "c2c_0123456789abcdef", iteration: "1", phase: "PLAN" },
      { task: "c2c_0123456789abcdef", iteration: "0", phase: "REVIEW" },
    ]) {
      const result = runJson([
        "control",
        "status",
        "-w",
        workspace,
        "--local-session",
        "session-a",
        "--request",
        request.requestId,
        "--task",
        mismatch.task,
        "--iteration",
        mismatch.iteration,
        "--phase",
        mismatch.phase,
      ]);
      expect(result.command.status).toBe(1);
      expect(result.body.code).toBe("MAILBOX_CORRELATION_MISMATCH");
    }

    submitControlResult(request.workspaceId, planResult(request.requestId));
    const waited = runJson([
      "control",
      "wait",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--request",
      request.requestId,
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--timeout-ms",
      "0",
    ]);
    expect(waited.command.status).toBe(0);
    expect(waited.body.status).toBe("received");
    expect((waited.body.result as { requestId: string }).requestId).toBe(request.requestId);

    const acknowledged = runJson([
      "control",
      "ack",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--request",
      request.requestId,
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(acknowledged.command.status).toBe(0);
    expect(acknowledged.body.status).toBe("acknowledged");

    const next = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "1",
      "--phase",
      "REVIEW",
    ]);
    expect(next.command.status).toBe(0);
    expect((next.body.request as { requestId: string }).requestId).not.toBe(request.requestId);
  }, 60_000);

  it("cancels the exact mailbox request after a gateway restart invalidates its context", async () => {
    claimSurface("session-cancel");
    const opened = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-cancel",
      "--task",
      "c2c_cancel1",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(opened.command.status, JSON.stringify(opened)).toBe(0);
    const request = opened.body.request as { requestId: string };

    await machine.close();
    machine = await startManagedMachineFixture(stateDir);
    const recovered = runJson([
      "control",
      "cancel",
      "-w",
      workspace,
      "--local-session",
      "session-cancel",
      "--request",
      request.requestId,
      "--task",
      "c2c_cancel1",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(recovered.command.status).toBe(0);
    expect(recovered.body.contextCancelled).toBe(false);
    expect(recovered.body.contextInvalidated).toBe(true);

    const status = runJson([
      "control",
      "status",
      "-w",
      workspace,
      "--local-session",
      "session-cancel",
      "--request",
      request.requestId,
      "--task",
      "c2c_cancel1",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(status.command.status).toBe(0);
    expect(status.body.status).toBe("cancelled");
  });

  it("does not cancel the mailbox while gateway ownership is uncertain", () => {
    claimSurface("session-cancel-uncertain");
    const opened = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-uncertain",
      "--task",
      "c2c_cancel_uncertain",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(opened.command.status).toBe(0);
    const request = opened.body.request as { requestId: string };
    write(stateDir, "runtime/machine.json", "{broken runtime");

    const cancelled = runJson([
      "control",
      "cancel",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-uncertain",
      "--request",
      request.requestId,
      "--task",
      "c2c_cancel_uncertain",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(cancelled.command.status).toBe(1);
    expect(cancelled.body.error).toMatch(/uncertain/i);

    const status = runJson([
      "control",
      "status",
      "-w",
      workspace,
      "--local-session",
      "session-cancel-uncertain",
      "--request",
      request.requestId,
      "--task",
      "c2c_cancel_uncertain",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
    ]);
    expect(status.command.status).toBe(1);
    expect(status.body.error).toMatch(/runtime|gateway|machine/i);
  });

  it("rejects partially numeric timing and command exit-code options", () => {
    const ttl = runJson([
      "control",
      "open",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "0",
      "--phase",
      "PLAN",
      "--ttl-ms",
      "1000junk",
    ]);
    expect(ttl.command.status).toBe(1);
    expect(ttl.body.error).toMatch(/ttl-ms must be an integer/);

    const outputFile = write(workspace, "command-output.txt", "tests failed\n");
    const record = runCli([
      "record",
      "-w",
      workspace,
      "--local-session",
      "session-a",
      "--task",
      "c2c_0123456789abcdef",
      "--iteration",
      "1",
      "--command",
      "pnpm test",
      "--output-file",
      outputFile,
      "--exit-code",
      "1junk",
    ]);
    expect(record.status).toBe(1);
    expect(`${record.stdout}\n${record.stderr}`).toMatch(/exit-code must be an integer/);
    expect(fs.existsSync(path.join(stateDir, "workspace-data", "executions"))).toBe(false);
  });

  it("keeps Project/chat routing behind surface commit", () => {
    const otherWorkspace = makeTmpDir("cli-route-lockdown-other");
    try {
      const routeOptions = [
        [
          "--project-url",
          "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
        ],
        [
          "--url",
          "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/route-bypass",
        ],
        ["--connector-name", "route-bypass"],
        ["--mode", "project"],
      ];
      for (const root of [workspace, otherWorkspace]) {
        for (const options of routeOptions) {
          const result = runCli([
            "session",
            "set",
            "-w",
            root,
            "--local-session",
            "route-lockdown",
            ...options,
            "--json",
          ], root);
          expect(result.status).toBe(1);
          expect(`${result.stdout}\n${result.stderr}`).toMatch(/unknown option|unknown command/);
        }
        const saved = runJson(["session", "get", "-w", root, "--local-session", "route-lockdown"], root);
        expect(saved.command.status).toBe(0);
        expect(saved.body.session).toBeNull();
      }

      claimSurface("route-lockdown");
      const before = runJson(["session", "get", "-w", workspace, "--local-session", "route-lockdown"]);
      const updated = runJson([
        "session",
        "set",
        "-w",
        workspace,
        "--local-session",
        "route-lockdown",
        "--task",
        "c2c_route_lockdown",
        "--iteration",
        "0",
        "--protocol-state",
        "PLAN_RECEIVED",
        "--waiting-for",
        "GPT_REVIEW",
      ]);
      expect(updated.command.status).toBe(0);
      expect(updated.body.session).toMatchObject({
        projectUrl: before.body.session.projectUrl,
        url: before.body.session.url,
        checkpoint: { protocolState: "PLAN_RECEIVED" },
      });
    } finally {
      cleanup(otherWorkspace);
    }
  }, 90_000);
});
