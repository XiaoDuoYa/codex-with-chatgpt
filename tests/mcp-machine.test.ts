import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeControlResult,
  getControlResultStatus,
  openControlResultRequest,
} from "../src/control/mailbox.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { CONTROL_PHASES } from "../src/control/result-schema.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { nullLogger } from "../src/logger/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection, write } from "./helpers.js";

const cleanups: string[] = [];

function correlation() {
  return {
    localSessionId: "session-mcp",
    taskId: "task-mcp",
    iteration: 1,
    phase: "PLAN" as const,
  };
}

function planPayload() {
  return {
    goal: "Verify exact request binding",
    rationale: "The result must belong to the capability's mailbox request.",
    actions: [{ change: "Inspect the active request", why: "Prevent replay" }],
    tests: ["Run the replay regression"],
    successCriteria: ["Only the active request accepts the result"],
  };
}

async function connectedClient(
  gateway: MachineGateway,
  resultTransport: "computer_use" | "mailbox" = "computer_use",
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({ gateway, logger: nullLogger }, { resultTransport });
  const client = new Client({ name: "machine-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("machine MCP capability correlation", () => {
  it("hides mailbox callback tools while Computer Use is the active result transport", async () => {
    cleanups.push(isolateStateDir());
    const connection = await connectedClient(new MachineGateway());
    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
        "get_control_result_status",
        "report_control_progress",
        "submit_control_result",
      ]));
      expect(tools.some((tool) => tool.name === "workspace_info")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("delivers BOOT through the public MCP schema before committing the exact candidate", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-boot-receipt");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const identity = { ...registration, localSessionId: "session-mcp-boot" };
    const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
    const chatUrl = projectUrl.replace("/project", "/c/mcp-boot");
    const lease = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-mcp-boot",
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    const turn = { taskId: "boot-mcp", iteration: 0, phase: "BOOT" as const };
    const { request } = gateway.openControlResultRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["c2c.result.write"],
      compactionEpoch: 0,
      generation: lease.generation,
    });
    const connection = await connectedClient(gateway, "mailbox");
    try {
      const receipt = await connection.client.callTool({
        name: "submit_control_result",
        arguments: { context_id: grant.token, kind: "BOOT", payload: {} },
      });
      expect(receipt.isError, JSON.stringify(receipt)).not.toBe(true);
      expect(receipt.structuredContent).toMatchObject({
        accepted: true,
        requestId: request.requestId,
        kind: "BOOT",
      });
      expect(gateway.surfaceCommit(identity, lease, {
        bootRequestId: request.requestId,
        connectorName: "Codex with ChatGPT",
      })).toMatchObject({
        binding: { tabId: lease.tabId, lastGeneration: lease.generation, chatUrl },
      });
      expect(gateway.getControlResultStatus(identity, request.requestId, turn).status).toBe("acknowledged");
    } finally {
      await connection.close();
    }
  });

  it("commits an exact candidate after a verified Computer Use BOOT result", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("computer-use-boot");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-computer-use-boot" };
    const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
    const chatUrl = projectUrl.replace("/project", "/c/computer-use-boot");
    const lease = gateway.surfaceClaim(identity, {
      browserId: "iab", surfaceId: "chatgpt", tabId: "tab-computer-use-boot",
      projectUrl, chatUrl, projectSelection: projectSelection(projectUrl),
    });
    const turn = { taskId: "boot-computer-use", iteration: 0, phase: "BOOT" as const };
    const { request } = gateway.openControlResultRequest(identity, turn);
    const page = {
      tabId: lease.tabId,
      generation: lease.generation,
      observedUrl: chatUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 1, state: "send_attempted",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 2, state: "sent",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 3, state: "response_created", responseId: "response-computer-use-boot",
    });
    expect(gateway.observeControlPage(identity, request.requestId, turn, {
      ...page, observationSequence: 4, state: "final", responseId: "response-computer-use-boot",
      responseIsFinal: true, delivery: "computer_use", terminalResult: { kind: "BOOT", payload: {} },
    })).toMatchObject({
      status: "cancelled",
      hostObservedResult: { result: { kind: "BOOT" } },
    });
    expect(gateway.surfaceCommit(identity, lease, {
      bootRequestId: request.requestId,
      connectorName: "Codex with ChatGPT",
    })).toMatchObject({ binding: { tabId: lease.tabId, chatUrl } });
  });

  it("derives optional progress correlation from context and rejects legacy overrides", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-progress-binding");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const turn = correlation();
    const request = openControlResultRequest(registration.workspaceId, turn);
    const grant = gateway.issueTurn({
      ...registration, ...turn, requestId: request.requestId, scopes: ["c2c.result.write"],
      compactionEpoch: 0, generation: 1,
    });
    const connection = await connectedClient(gateway, "mailbox");
    try {
      const reported = await connection.client.callTool({
        name: "report_control_progress",
        arguments: { context_id: grant.token, status: "SEARCHING", message: "Inspecting the bounded inputs" },
      });
      expect(reported.isError).not.toBe(true);
      expect(getControlResultStatus(registration.workspaceId, request.requestId, turn.localSessionId, turn))
        .toMatchObject({ status: "pending", progress: { status: "SEARCHING", taskId: turn.taskId } });
      const rejected = await connection.client.callTool({
        name: "report_control_progress",
        arguments: { context_id: grant.token, taskId: "another-task", status: "READING_CODE" },
      });
      expect(rejected.isError).toBe(true);
      expect(getControlResultStatus(registration.workspaceId, request.requestId, turn.localSessionId, turn))
        .toMatchObject({ progress: { status: "SEARCHING" } });
    } finally { await connection.close(); }
  });

  it.each(CONTROL_PHASES)("delivers a %s refusal directly without progress or business reads", async (phase) => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-refusal");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const turn = { ...correlation(), phase };
    const request = openControlResultRequest(registration.workspaceId, turn);
    const grant = gateway.issueTurn({
      ...registration, ...turn, requestId: request.requestId, scopes: ["c2c.result.write"],
      compactionEpoch: 0, generation: 1,
    });
    const connection = await connectedClient(gateway, "mailbox");
    try {
      const receipt = await connection.client.callTool({
        name: "submit_control_result",
        arguments: {
          context_id: grant.token, kind: "BLOCKED",
          payload: { reason: "Cannot complete the requested business action", needs: ["Provide a permitted alternative"] },
        },
      });
      expect(receipt.isError).not.toBe(true);
      expect(receipt.structuredContent).toMatchObject({ accepted: true, kind: "BLOCKED" });
      expect(getControlResultStatus(registration.workspaceId, request.requestId, turn.localSessionId, turn))
        .toMatchObject({ status: "received", progress: null, result: { kind: "BLOCKED" } });
      expect(acknowledgeControlResult(registration.workspaceId, request.requestId, turn.localSessionId, turn).status).toBe("acknowledged");
    } finally { await connection.close(); }
  });

  it("does not use revoked authorization even to return BLOCKED", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-revoked-refusal");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlResultRequest(registration.workspaceId, correlation());
    const grant = gateway.issueTurn({
      ...registration, ...correlation(), requestId: request.requestId, scopes: ["c2c.result.write"],
      compactionEpoch: 0, generation: 1,
    });
    gateway.revokeTurn(grant.token);
    const connection = await connectedClient(gateway, "mailbox");
    try {
      const reply = await connection.client.callTool({
        name: "submit_control_result",
        arguments: {
          context_id: grant.token, kind: "BLOCKED",
          payload: { reason: "Authorization ended", needs: ["Stop the current attempt"] },
        },
      });
      expect(reply.isError).toBe(true);
      expect(JSON.stringify(reply)).toContain("TOKEN_REVOKED");
      expect(getControlResultStatus(registration.workspaceId, request.requestId, correlation().localSessionId, correlation()))
        .toMatchObject({ status: "pending", result: null });
    } finally { await connection.close(); }
  });

  it("keeps dormant mailbox callbacks testable without exposing them in production", async () => {
    cleanups.push(isolateStateDir());
    const gateway = new MachineGateway();
    const registrations = [0, 1].map((index) => {
      const root = makeTmpDir(`mcp-local-research-${index}`);
      cleanups.push(root);
      write(root, "fixture.txt", `marker-${index}\n17\n25\n`);
      return gateway.registerWorkspace(root);
    });
    const connection = await connectedClient(gateway, "mailbox");
    try {
      for (const iteration of [0, 1]) {
        const { tools } = await connection.client.listTools();
        const submitTool = tools.find((tool) => tool.name === "submit_control_result");
        expect(submitTool?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        const inputProperties = (name: string) => Object.keys(
          (tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
        );
        expect(inputProperties("submit_control_result")).toEqual(["context_id", "kind", "payload"]);
        expect(inputProperties("get_control_result_status")).toEqual(["context_id"]);
        expect(inputProperties("report_control_progress")).toEqual(["context_id", "status", "message"]);
        await Promise.all(registrations.map(async (registration, index) => {
          const turn = { localSessionId: `session-local-${index}`, taskId: "local-research", iteration, phase: "RESEARCH" as const };
          const request = openControlResultRequest(registration.workspaceId, { ...turn, ttlMs: 60_000 });
          const grant = gateway.issueTurn({
            ...registration, ...turn, requestId: request.requestId,
            scopes: ["workspace.read", "c2c.result.write"], compactionEpoch: 0, generation: 1, ttlMs: 60_000,
          });
          const read = await connection.client.callTool({ name: "read_file", arguments: { context_id: grant.token, path: "fixture.txt" } });
          expect(read.isError).not.toBe(true);
          expect(JSON.stringify(read.structuredContent)).toContain(`marker-${index}`);
          expect(JSON.stringify(read.structuredContent)).not.toContain(`marker-${1 - index}`);
          const payload = {
            question: "What is the fixture sum?", summary: "17 + 25 = 42",
            conclusions: [`fixture.txt:1-3 has marker-${index}, 17 and 25. The sum is 42.`],
            sources: [], openQuestions: [],
          };
          const receipt = await connection.client.callTool({
            name: "submit_control_result",
            arguments: { context_id: grant.token, kind: "RESEARCH", payload },
          });
          expect(receipt.isError).not.toBe(true);
          expect(receipt.structuredContent).toMatchObject({ accepted: true, requestId: request.requestId });
          expect(getControlResultStatus(registration.workspaceId, request.requestId, turn.localSessionId, turn))
            .toMatchObject({ status: "received", result: { payload } });
          acknowledgeControlResult(registration.workspaceId, request.requestId, turn.localSessionId, turn);
          expect(getControlResultStatus(registration.workspaceId, request.requestId, turn.localSessionId, turn).status)
            .toBe("acknowledged");
        }));
      }
      const { tools } = await connection.client.listTools();
      expect(tools.some((tool) => tool.name === "submit_control_result")).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("documents git_diff pagination with its output field names", async () => {
    cleanups.push(isolateStateDir());
    const gateway = new MachineGateway();
    const connection = await connectedClient(gateway, "mailbox");
    try {
      const { tools } = await connection.client.listTools();
      const description = tools.find((tool) => tool.name === "git_diff")?.description;
      expect(description).toContain("hasMore");
      expect(description).toContain("nextOffset");
      expect(description).not.toContain("has_more");
      expect(description).not.toContain("next_offset");
    } finally {
      await connection.close();
    }
  });

  it("returns a schema-valid execution summary for the exact session and task", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-execution-summary");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlResultRequest(registration.workspaceId, {
      ...correlation(),
      ttlMs: 60_000,
    });
    const grant = gateway.issueTurn({
      ...registration,
      ...correlation(),
      requestId: request.requestId,
      scopes: ["execution.read"],
      compactionEpoch: 0,
      generation: 1,
      ttlMs: 60_000,
    });
    appendExecutionRecord(registration.workspaceId, {
      localSessionId: correlation().localSessionId,
      taskId: correlation().taskId,
      iteration: correlation().iteration,
      changedFiles: ["src/index.ts"],
      tests: "436 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
      outputAvailable: false,
    });

    const connection = await connectedClient(gateway, "mailbox");
    try {
      const result = await connection.client.callTool({
        name: "execution_summary",
        arguments: {
          context_id: grant.token,
          local_session_id: correlation().localSessionId,
          task_id: correlation().taskId,
          limit: 1,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        records: [expect.objectContaining({
          workspaceId: registration.workspaceId,
          localSessionId: correlation().localSessionId,
          taskId: correlation().taskId,
          iteration: correlation().iteration,
          changedFiles: ["src/index.ts"],
          exitStatus: "ok",
        })],
      });
    } finally {
      await connection.close();
    }
  });

  it("rejects a historical request id even when every other correlation field matches", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-request-replay");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const firstRequest = openControlResultRequest(registration.workspaceId, {
      ...correlation(),
      ttlMs: 60_000,
    });
    const first = gateway.issueTurn({
      ...registration,
      ...correlation(),
      requestId: firstRequest.requestId,
      scopes: ["c2c.result.write"],
      compactionEpoch: 0,
      generation: 1,
      ttlMs: 60_000,
    });
    const connection = await connectedClient(gateway, "mailbox");
    try {
      const status = await connection.client.callTool({
        name: "get_control_result_status",
        arguments: { context_id: first.token },
      });
      expect(status.isError, JSON.stringify(status)).not.toBe(true);
      expect(JSON.stringify(status)).toContain('"status":"pending"');

      const accepted = await connection.client.callTool({
        name: "submit_control_result",
        arguments: {
          context_id: first.token,
          kind: "PLAN",
          payload: planPayload(),
        },
      });
      expect(accepted.isError).not.toBe(true);
      acknowledgeControlResult(
        registration.workspaceId,
        firstRequest.requestId,
        correlation().localSessionId,
        correlation(),
      );

      const secondRequest = openControlResultRequest(registration.workspaceId, {
        ...correlation(),
        ttlMs: 60_000,
      });
      const second = gateway.issueTurn({
        ...registration,
        ...correlation(),
        requestId: secondRequest.requestId,
        scopes: ["c2c.result.write"],
        compactionEpoch: 0,
        generation: 1,
        ttlMs: 60_000,
      });

      const replay = await connection.client.callTool({
        name: "submit_control_result",
        arguments: {
          context_id: second.token,
          requestId: firstRequest.requestId,
          kind: "PLAN",
          payload: planPayload(),
        },
      });
      expect(replay.isError).toBe(true);
      expect(JSON.stringify(replay)).toMatch(/invalid|unrecognized|requestId/i);
      expect(gateway.turnStatus(second.token).status).toBe("issued");
      expect(
        getControlResultStatus(
          registration.workspaceId,
          secondRequest.requestId,
          correlation().localSessionId,
          correlation(),
        ).status,
      ).toBe("pending");

      const acceptedSecond = await connection.client.callTool({
        name: "submit_control_result",
        arguments: { context_id: second.token, kind: "PLAN", payload: planPayload() },
      });
      expect(acceptedSecond.isError).not.toBe(true);
      expect(acceptedSecond.structuredContent).toMatchObject({
        accepted: true,
        requestId: secondRequest.requestId,
      });
    } finally {
      await connection.close();
    }
  });

  it("does not return an in-flight read after its capability is cancelled", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("mcp-cancel-inflight");
    cleanups.push(root);
    write(root, "marker.txt", "private workspace data\n");
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const request = openControlResultRequest(registration.workspaceId, {
      ...correlation(),
      ttlMs: 60_000,
    });
    const grant = gateway.issueTurn({
      ...registration,
      ...correlation(),
      requestId: request.requestId,
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: 1,
      ttlMs: 60_000,
    });
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const originalRead = Workspace.prototype.readFile;
    vi.spyOn(Workspace.prototype, "readFile").mockImplementation(async function (...args) {
      entered();
      await gate;
      return originalRead.apply(this, args);
    });
    const connection = await connectedClient(gateway);
    try {
      const pending = connection.client.callTool({
        name: "read_file",
        arguments: { context_id: grant.token, path: "marker.txt" },
      });
      await started;
      gateway.cancelTurn(grant.token, {
        workspaceId: registration.workspaceId,
        projectId: registration.projectId,
        ...correlation(),
        requestId: request.requestId,
      });
      resume();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("TOKEN_CANCELLED");
      expect(JSON.stringify(result)).not.toContain("private workspace data");
    } finally {
      resume();
      await connection.close();
    }
  });
});
