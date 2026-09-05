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
import { MachineGateway } from "../src/gateway/machine-gateway.js";
import { nullLogger } from "../src/logger/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

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

async function connectedClient(gateway: MachineGateway): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({ gateway, logger: nullLogger });
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
    const connection = await connectedClient(gateway);
    try {
      const receipt = await connection.client.callTool({
        name: "submit_control_result",
        arguments: {
          context_id: grant.token, requestId: request.requestId, ...turn, kind: "BLOCKED",
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
    const connection = await connectedClient(gateway);
    try {
      const reply = await connection.client.callTool({
        name: "submit_control_result",
        arguments: {
          context_id: grant.token, requestId: request.requestId, ...correlation(), kind: "BLOCKED",
          payload: { reason: "Authorization ended", needs: ["Stop the current attempt"] },
        },
      });
      expect(reply.isError).toBe(true);
      expect(JSON.stringify(reply)).toContain("TOKEN_REVOKED");
      expect(getControlResultStatus(registration.workspaceId, request.requestId, correlation().localSessionId, correlation()))
        .toMatchObject({ status: "pending", result: null });
    } finally { await connection.close(); }
  });

  it("keeps result tools listed across consecutive local-only turns in two workspaces", async () => {
    cleanups.push(isolateStateDir());
    const gateway = new MachineGateway();
    const registrations = [0, 1].map((index) => {
      const root = makeTmpDir(`mcp-local-research-${index}`);
      cleanups.push(root);
      write(root, "fixture.txt", `marker-${index}\n17\n25\n`);
      return gateway.registerWorkspace(root);
    });
    const connection = await connectedClient(gateway);
    try {
      for (const iteration of [0, 1]) {
        const { tools } = await connection.client.listTools();
        expect(tools.find((tool) => tool.name === "submit_control_result")?.annotations)
          .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
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
            arguments: { context_id: grant.token, requestId: request.requestId, ...turn, kind: "RESEARCH", payload },
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
    const connection = await connectedClient(gateway);
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

    const connection = await connectedClient(gateway);
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
    const connection = await connectedClient(gateway);
    try {
      const status = await connection.client.callTool({
        name: "get_control_result_status",
        arguments: {
          context_id: first.token,
          requestId: firstRequest.requestId,
          ...correlation(),
        },
      });
      expect(status.isError).not.toBe(true);
      expect(JSON.stringify(status)).toContain('"status":"pending"');

      const accepted = await connection.client.callTool({
        name: "submit_control_result",
        arguments: {
          context_id: first.token,
          requestId: firstRequest.requestId,
          ...correlation(),
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
          ...correlation(),
          kind: "PLAN",
          payload: planPayload(),
        },
      });
      expect(replay.isError).toBe(true);
      expect(JSON.stringify(replay)).toContain("TURN_CORRELATION_MISMATCH");
      expect(gateway.turnStatus(second.token).status).toBe("active");
      expect(
        getControlResultStatus(
          registration.workspaceId,
          secondRequest.requestId,
          correlation().localSessionId,
          correlation(),
        ).status,
      ).toBe("pending");
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
