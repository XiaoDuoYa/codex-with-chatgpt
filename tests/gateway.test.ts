import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startGateway, type Gateway } from "../src/gateway/server.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

class NoopTunnel implements TunnelProvider {
  readonly name = "test";
  private url: string | null = null;
  async start(): Promise<string> {
    this.url = "https://gateway.test.example";
    return this.url;
  }
  async stop(): Promise<void> {
    this.url = null;
  }
  async restart(): Promise<string> {
    return this.start();
  }
  status() {
    return { running: this.url !== null, url: this.url, provider: this.name };
  }
  getPublicUrl(): string | null {
    return this.url;
  }
  async doctor() {
    return { provider: this.name, binaryFound: true, binaryPath: null, running: this.url !== null, url: this.url, problems: [] };
  }
}

describe("multi-workspace Gateway", () => {
  let gateway: Gateway;
  let rootA: string;
  let rootB: string;
  let client: Client;

  beforeAll(async () => {
    isolateStateDir();
    rootA = makeTmpDir("gateway-a");
    rootB = makeTmpDir("gateway-b");
    write(rootA, "a.txt", "workspace A\n");
    write(rootB, "b.txt", "workspace B\n");
    gateway = await startGateway({
      workspaceRoot: rootA,
      port: 0,
      persistRuntime: false,
      authStoreFile: `${makeTmpDir("gateway-auth")}/store.json`,
      registryFile: `${makeTmpDir("gateway-registry")}/workspaces.json`,
      tunnelProvider: new NoopTunnel(),
    });

    const attach = await fetch(`${gateway.localBaseUrl()}/admin/attach`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: rootB }),
    });
    expect(attach.status).toBe(200);

    const token = gateway.authStore.issueTokens({
      clientId: "gateway-test",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
      workspaceId: "*",
    });
    client = new Client({ name: "gateway-test-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${gateway.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
      })
    );
  });

  afterAll(async () => {
    await client.close();
    await gateway.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  it("attaches new workspaces without a static directory registration", async () => {
    expect(gateway.registry.list().map((entry) => entry.workspaceId)).toEqual(
      expect.arrayContaining([gateway.registry.active().id])
    );
    expect(gateway.registry.list()).toHaveLength(2);
  });

  it("routes the active and explicitly selected opaque workspace", async () => {
    const active = await client.callTool({ name: "workspace_info", arguments: {} });
    const activeInfo = JSON.parse((active.content as { text: string }[])[0].text) as { workspaceId: string; workspaceName: string };
    expect(activeInfo.workspaceId).toBe(gateway.registry.active().id);
    expect(activeInfo.workspaceName).toContain("gateway-b");

    const workspaceA = gateway.registry.list().find((entry) => entry.workspaceRoot === rootA)?.workspaceId;
    const activate = await fetch(`${gateway.localBaseUrl()}/admin/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspaceA }),
    });
    expect(activate.status).toBe(200);
    const other = await client.callTool({
      name: "workspace_info",
      arguments: { workspace_id: workspaceA },
    });
    const otherInfo = JSON.parse((other.content as { text: string }[])[0].text) as { workspaceId: string; workspaceName: string };
    expect(otherInfo.workspaceName).toContain("gateway-a");
  });

  it("never accepts a raw filesystem path as workspace context", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: { workspace_id: rootA } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/WORKSPACE_NOT_(ATTACHED|ACTIVE)/);
  });
});
