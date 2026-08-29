import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { latestExecutionRecord } from "../src/execution/records.js";
import { McpTransport } from "../src/transport/mcp.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let root: string;
let bridge: Bridge;

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("mcp-transport");
  makeGitRepo(root);
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("mcp-auth"), "store.json"),
  });
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

describe("McpTransport", () => {
  it("preserves setup and pairing semantics through the compatibility facade", async () => {
    const transport = new McpTransport({
      ensureBridge: async () => ({
        runtime: {
          service: "codex-with-chatgpt",
          version: "0.1.0",
          workspaceId: bridge.workspace.id,
          workspaceRoot: bridge.workspace.root,
          pid: process.pid,
          port: bridge.port,
          adminToken: bridge.adminToken,
          publicUrl: null,
          startedAt: "2026-08-29T00:00:00.000Z",
        },
        spawned: false,
      }),
    });

    const receipt = await transport.prepare({ workspaceRoot: root, tunnel: false, pairing: true });
    expect(receipt).toMatchObject({
      ok: true,
      kind: "mcp",
      workspaceId: bridge.workspace.id,
      workspaceName: bridge.workspace.name,
      mcpUrl: `http://127.0.0.1:${bridge.port}/mcp`,
      local: true,
    });
    expect(receipt.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(receipt.pairingExpiresAt).toBeGreaterThan(Date.now());
  });

  it("publishes execution records readable by existing MCP tools", async () => {
    const transport = new McpTransport();
    const receipt = await transport.publish({
      workspaceRoot: root,
      workspaceId: bridge.workspace.id,
      taskId: "c2c_11111111",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "1 passed",
      exitStatus: "ok",
    });

    expect(receipt).toMatchObject({ ok: true, kind: "mcp" });
    expect(latestExecutionRecord(bridge.workspace.id)).toMatchObject({
      taskId: "c2c_11111111",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "1 passed",
      exitStatus: "ok",
    });
  });
});
