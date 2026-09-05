import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const PLAN = `FILES_USED:\n- PROJECT.md\n\nASSUMPTIONS:\n- None\n\nPLAN:\n- Make the safe change.\n\nOPEN_QUESTIONS:\n- None\n`;

let stateDir: string;
let root: string;
let bridge: Bridge;
let readClient: Client;
let writeClient: Client;
let digest: string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function clientFor(scopes: string[]): Promise<Client> {
  const token = bridge.authStore.issueTokens({ clientId: `client-${scopes.join("-")}`, scopes }).accessToken;
  const client = new Client({ name: "plan-integration-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: "Bearer " + token } },
    })
  );
  return client;
}

function toolJson(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("plan-mcp");
  const project = "sample-project";
  const data = "# Sample\n";
  const payload = {
    schema: 2,
    project,
    classification: "synthetic",
    files: [{ path: "PROJECT.md", bytes: Buffer.byteLength(data), sha256: sha256(data) }],
    limits: { max_file_bytes: 1_000_000, max_total_bytes: 10_000_000 },
  };
  digest = sha256(canonical(payload) + "\n");
  write(root, `${project}/PROJECT.md`, data);
  write(root, `${project}/CONTEXT-MANIFEST.json`, JSON.stringify({ ...payload, approval_digest: digest }));
  fs.chmodSync(root, 0o700);
  fs.chmodSync(path.join(root, project), 0o700);
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("plan-auth"), "store.json"),
  });
  readClient = await clientFor(["workspace.read"]);
  writeClient = await clientFor(["workspace.read", "plan.write"]);
});

afterAll(async () => {
  await readClient.close();
  await writeClient.close();
  await bridge.close();
  cleanup(root);
});

describe("submit_plan MCP action", () => {
  it("returns bounded JSON errors for malformed and oversized admin requests", async () => {
    const headers = { authorization: "Bearer " + bridge.adminToken, "content-type": "application/json" };
    const malformed = await fetch(`${bridge.localBaseUrl()}/admin/plan-authorizations`, {
      method: "POST", headers, body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "INVALID_JSON" });

    const oversized = await fetch(`${bridge.localBaseUrl()}/admin/plan-authorizations`, {
      method: "POST", headers, body: JSON.stringify({ project: "x".repeat(5_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "BODY_TOO_LARGE" });

    const invalidTtl = await fetch(`${bridge.localBaseUrl()}/admin/plan-authorizations`, {
      method: "POST", headers,
      body: JSON.stringify({ project: "sample-project", staged_digest: digest, ttl_ms: 0 }),
    });
    expect(invalidTtl.status).toBe(400);
    expect(await invalidTtl.json()).toMatchObject({ error: "INVALID_TTL" });
  });

  it("hides the admin route from bad tokens and forwarded requests", async () => {
    const cases: Record<string, string>[] = [
      { authorization: "Bearer wrong", "content-type": "application/json" },
      { authorization: "Bearer " + bridge.adminToken, "content-type": "application/json", "x-forwarded-for": "203.0.113.1" },
    ];
    for (const headers of cases) {
      const response = await fetch(`${bridge.localBaseUrl()}/admin/plan-authorizations`, {
        method: "POST", headers, body: "{}",
      });
      expect(response.status).toBe(404);
    }
  });
  it("is declared as a non-destructive, non-idempotent write action", async () => {
    const tool = (await writeClient.listTools()).tools.find((item) => item.name === "submit_plan");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("requires plan.write and a one-time loopback authorization", async () => {
    const denied = await readClient.callTool({
      name: "submit_plan",
      arguments: { project: "sample-project", staged_digest: digest, authorization: "not-valid", content: PLAN },
    });
    expect(denied.isError).toBe(true);
    expect(toolJson(denied).error).toBe("INSUFFICIENT_SCOPE");

    const authorizationResponse = await fetch(`${bridge.localBaseUrl()}/admin/plan-authorizations`, {
      method: "POST",
      headers: { authorization: "Bearer " + bridge.adminToken, "content-type": "application/json" },
      body: JSON.stringify({ project: "sample-project", staged_digest: digest }),
    });
    expect(authorizationResponse.status).toBe(201);
    const authorization = (await authorizationResponse.json()) as { token: string; expiresAt: number };
    expect(authorization.token).toMatch(/^c2c_plan_[A-Za-z0-9_-]{43}$/);

    const result = await writeClient.callTool({
      name: "submit_plan",
      arguments: {
        project: "sample-project",
        staged_digest: digest,
        authorization: authorization.token,
        content: PLAN,
      },
    });
    expect(result.isError).not.toBe(true);
    const receipt = toolJson(result) as {
      path: string;
      sha256: string;
      bytes: number;
      project: string;
      stagedDigest: string;
    };
    expect(receipt.path.startsWith(`plan-inbox:/${bridge.workspace.id}/sample-project/`)).toBe(true);
    const savedFile = path.join(stateDir, ...receipt.path.replace("plan-inbox:/", "plan-inbox/").split("/"));
    expect(savedFile.startsWith(root)).toBe(false);
    expect(receipt.sha256).toBe(sha256(PLAN));
    expect(receipt.bytes).toBe(Buffer.byteLength(PLAN));
    expect(receipt.project).toBe("sample-project");
    expect(receipt.stagedDigest).toBe(digest);
    expect(fs.readFileSync(savedFile, "utf8")).toBe(PLAN);
  });
});
