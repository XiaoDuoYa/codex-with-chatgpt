import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeMailboxResult,
  claimSurface,
  commitSurface,
  getMailboxStatus,
  issueTurn,
  openMailboxRequest,
  registerWorkspace,
  releaseSurface,
} from "../src/gateway/control-client.js";
import { startMachineGatewayServer, type MachineGatewayServer } from "../src/gateway/server.js";
import { nullLogger } from "../src/logger/index.js";
import { createMcpServer } from "../src/mcp/server.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const PROJECT_URL = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const SESSION_COUNT = 8;

type Registration = Awaited<ReturnType<typeof registerWorkspace>>;
type SessionIdentity = Pick<Registration, "workspaceId" | "projectId" | "registrationId"> & {
  localSessionId: string;
};
type Session = {
  localSessionId: string;
  tabId: string;
  chatUrl: string;
  identity: SessionIdentity;
};

async function connectedClient(gateway: MachineGatewayServer["gateway"]): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({ gateway, logger: nullLogger });
  const client = new Client({ name: "machine-concurrency-test", version: "1.0.0" });
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

function planPayload(localSessionId: string) {
  return {
    goal: `Verify independent session ${localSessionId}`,
    rationale: "Each local session must retain its own mailbox and ChatGPT page route.",
    actions: [{ change: "run the independent session flow", why: "prove concurrent routing" }],
    tests: ["machine-gateway-concurrency"],
    successCriteria: [`session ${localSessionId} completes without another session's lock`],
  };
}

describe("machine gateway unbounded session concurrency", () => {
  let server: MachineGatewayServer | null = null;
  const cleanups: string[] = [];

  afterEach(async () => {
    await server?.close();
    server = null;
    for (const target of cleanups.splice(0)) cleanup(target);
    delete process.env.C2C_STATE_DIR;
  });

  it("runs eight independent page and mailbox flows through one HTTP gateway", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-gateway-concurrency");
    cleanups.push(root);
    server = await startMachineGatewayServer({
      port: 0,
      connectStdio: false,
      persistRuntime: false,
    });

    const registration = await registerWorkspace(server.runtime, root);
    const sessions: Session[] = Array.from({ length: SESSION_COUNT }, (_, index) => {
      const localSessionId = `session-concurrent-${index}`;
      return {
        localSessionId,
        tabId: `tab-concurrent-${index}`,
        chatUrl: `${PROJECT_URL.replace("/project", "")}/c/chat-concurrent-${index}`,
        identity: {
          workspaceId: registration.workspaceId,
          projectId: registration.projectId,
          registrationId: registration.registrationId,
          localSessionId,
        },
      };
    });

    // All sessions share the same registered workspace, but each owns a
    // distinct browser page. Promise.all intentionally starts every claim at
    // the same time so a hidden capacity gate fails this test at session six.
    const claims = await Promise.all(
      sessions.map((session) =>
        claimSurface(server!.runtime, session.identity, {
          tabId: session.tabId,
          projectUrl: PROJECT_URL,
          chatUrl: session.chatUrl,
          ownerProcessEpoch: `owner-${session.localSessionId}`,
          leaseTtlMs: 60_000,
        }),
      ),
    );
    expect(claims).toHaveLength(SESSION_COUNT);
    expect(new Set(claims.map(({ lease }) => lease.localSessionId)).size).toBe(SESSION_COUNT);
    expect(new Set(claims.map(({ lease }) => lease.tabId)).size).toBe(SESSION_COUNT);
    expect(new Set(claims.map(({ lease }) => lease.generation)).size).toBe(SESSION_COUNT);

    await Promise.all(
      sessions.map((session, index) =>
        commitSurface(server!.runtime, session.identity, claims[index].lease, {
          chatUrl: session.chatUrl,
          connectorName: "Codex with ChatGPT",
        }),
      ),
    );

    const requests = await Promise.all(
      sessions.map((session) =>
        openMailboxRequest(server!.runtime, session.identity, {
          taskId: `task-${session.localSessionId}`,
          iteration: 0,
          phase: "PLAN",
          ttlMs: 60_000,
        }),
      ),
    );
    expect(requests.every(({ created }) => created)).toBe(true);
    expect(new Set(requests.map(({ request }) => request.requestId)).size).toBe(SESSION_COUNT);

    const grants = await Promise.all(
      sessions.map((session, index) =>
        issueTurn(server!.runtime, {
          ...session.identity,
          taskId: `task-${session.localSessionId}`,
          iteration: 0,
          phase: "PLAN",
          requestId: requests[index].request.requestId,
          scopes: ["c2c.result.write"],
          compactionEpoch: 0,
          generation: claims[index].lease.generation,
          ttlMs: 60_000,
        }),
      ),
    );
    expect(grants).toHaveLength(SESSION_COUNT);
    expect(new Set(grants.map(({ token }) => token)).size).toBe(SESSION_COUNT);

    const connections = await Promise.all(sessions.map(() => connectedClient(server!.gateway)));
    try {
      const results = await Promise.all(
        connections.map((connection, index) =>
          connection.client.callTool({
            name: "submit_control_result",
            arguments: {
              context_id: grants[index].token,
              requestId: requests[index].request.requestId,
              localSessionId: sessions[index].localSessionId,
              taskId: `task-${sessions[index].localSessionId}`,
              iteration: 0,
              phase: "PLAN",
              kind: "PLAN",
              payload: planPayload(sessions[index].localSessionId),
            },
          }),
        ),
      );

      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(grants.every(({ token }) => server!.gateway.turnStatus(token).status === "completed")).toBe(true);

      const statuses = await Promise.all(
        sessions.map((session, index) =>
          getMailboxStatus(server!.runtime, session.identity, {
            requestId: requests[index].request.requestId,
            taskId: `task-${session.localSessionId}`,
            iteration: 0,
            phase: "PLAN",
          }),
        ),
      );
      expect(statuses.every((status) => status.status === "received")).toBe(true);

      const acknowledgements = await Promise.all(
        sessions.map((session, index) =>
          acknowledgeMailboxResult(server!.runtime, session.identity, {
            requestId: requests[index].request.requestId,
            taskId: `task-${session.localSessionId}`,
            iteration: 0,
            phase: "PLAN",
          }),
        ),
      );
      expect(acknowledgements.every((status) => status.status === "acknowledged")).toBe(true);
    } finally {
      await Promise.all(connections.map((connection) => connection.close()));
    }

    const released = await Promise.all(
      sessions.map((session, index) =>
        releaseSurface(server!.runtime, session.identity, claims[index].lease),
      ),
    );
    expect(released.every(({ released: didRelease }) => didRelease)).toBe(true);
    expect(server.gateway.stats().activeTurnCount).toBe(0);
  });
});
