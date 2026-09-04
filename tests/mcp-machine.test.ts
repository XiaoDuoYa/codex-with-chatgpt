import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeControlResult,
  getControlResultStatus,
  openControlResultRequest,
} from "../src/control/mailbox.js";
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
