import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { getControlResultStatus, openControlResultRequest } from "../src/control/mailbox.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

function structuredJsonOf<T = Record<string, unknown>>(result: { content?: unknown; structuredContent?: unknown }): T {
  const parsed = jsonOf<T>(result);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function expectToolOutputSchema(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: string,
  properties: string[]
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(properties));
}

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "c2c.result.write"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists all read-only tools plus the bounded control write tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "execution_output",
      "execution_summary",
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "report_control_progress",
      "search_workspace",
      "submit_control_result",
      "test_status",
      "workspace_info",
    ]);
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "projectId", "workspaceName", "projectType", "git"]);
    expectToolOutputSchema(tools, "list_directory", ["path", "entries", "total", "hasMore"]);
    expectToolOutputSchema(tools, "read_file", ["path", "content", "startLine", "endLine", "nextStartLine"]);
    expectToolOutputSchema(tools, "search_workspace", ["matches", "matchCount", "truncated", "engine"]);
    expectToolOutputSchema(tools, "git_status", ["isRepo", "branch", "staged", "unstaged", "untracked"]);
    expectToolOutputSchema(tools, "git_diff", ["isRepo", "mode", "diff", "hasMore", "nextOffset"]);
    expectToolOutputSchema(tools, "test_status", [
      "available",
      "localSessionId",
      "taskId",
      "iteration",
      "tests",
      "outputAvailable",
      "outputId",
    ]);
    expectToolOutputSchema(tools, "execution_summary", ["records"]);
    expectToolOutputSchema(tools, "execution_output", [
      "action",
      "items",
      "localSessionId",
      "taskId",
      "iteration",
      "text",
    ]);
    expectToolOutputSchema(tools, "report_control_progress", [
      "accepted",
      "requestId",
      "localSessionId",
      "progressId",
      "phase",
      "status",
      "reportedAt",
      "idempotentReplay",
    ]);
    const progressInput = tools.find((tool) => tool.name === "report_control_progress")?.inputSchema;
    expect(JSON.stringify(progressInput)).toContain('"SEARCHING"');
    expect(JSON.stringify(progressInput)).toContain('"READING_CODE"');
    expect(JSON.stringify(progressInput)).toContain('"SYNTHESIZING"');
    expectToolOutputSchema(tools, "submit_control_result", [
      "accepted",
      "requestId",
      "localSessionId",
      "resultId",
      "phase",
      "kind",
      "receivedAt",
      "idempotentReplay",
    ]);
    const submitInput = tools.find((tool) => tool.name === "submit_control_result")?.inputSchema;
    expect(submitInput?.type).toBe("object");
    const serializedSubmitInput = JSON.stringify(submitInput);
    expect(serializedSubmitInput).toContain('"localSessionId"');
    for (const payloadField of [
      "question",
      "conclusions",
      "sources",
      "publishedDate",
      "keyEvidence",
      "goal",
      "rationale",
      "findings",
      "verification",
      "needs",
    ]) {
      expect(serializedSubmitInput).toContain(`\"${payloadField}\"`);
    }
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = structuredJsonOf<{
      workspaceId: string;
      projectId: string;
      projectType: string;
      frameworks: string[];
      git: { isRepo: boolean; branch: string };
    }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.projectId).toBe(bridge.workspace.projectId);
    expect(info.projectId).toMatch(/^git-[a-f0-9]{32}$/);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = structuredJsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = structuredJsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = structuredJsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = structuredJsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = structuredJsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = structuredJsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      localSessionId: "integration-session",
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    appendExecutionRecord(bridge.workspace.id, {
      localSessionId: "other-session",
      taskId: "c2c_other",
      iteration: 1,
      changedFiles: ["src/other.ts"],
      tests: "1 failed",
      exitStatus: "failed",
      timestamp: new Date().toISOString(),
    });
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(
      await client.callTool({
        name: "execution_summary",
        arguments: { local_session_id: "integration-session", task_id: "c2c_test1" },
      })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");
    expect(summary.records).toHaveLength(1);

    const status = structuredJsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null }>(
      await client.callTool({
        name: "test_status",
        arguments: { local_session_id: "integration-session", task_id: "c2c_test1", iteration: 1 },
      })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();

    const unrelated = structuredJsonOf<{ available: boolean; taskId: string }>(
      await client.callTool({
        name: "test_status",
        arguments: { local_session_id: "integration-session", task_id: "c2c_other", iteration: 1 },
      })
    );
    expect(unrelated.available).toBe(false);
    expect(unrelated.taskId).toBe("c2c_other");
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
      localSessionId: "integration-session",
      taskId: "c2c_output1",
      iteration: 2,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
      localSessionId: "integration-session",
      taskId: "c2c_output1",
      iteration: 2,
    });
    const listResult = await client.callTool({
      name: "execution_output",
      arguments: {
        action: "list",
        local_session_id: "integration-session",
        task_id: "c2c_output1",
        iteration: 2,
      },
    });
    const list = structuredJsonOf<{
      action: "list";
      items: { id: number; status: string; command: string; text?: string }[];
    }>(listResult);
    expect(list.action).toBe("list");
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const readResult = await client.callTool({
      name: "execution_output",
      arguments: {
        action: "read",
        id: readable.id,
        local_session_id: "integration-session",
        task_id: "c2c_output1",
        iteration: 2,
      },
    });
    const body = structuredJsonOf<{ action: "read"; text: string }>(readResult);
    expect(body.action).toBe("read");
    expect(body.text).toContain("AssertionError");

    const mismatched = await client.callTool({
      name: "execution_output",
      arguments: {
        action: "read",
        id: readable.id,
        local_session_id: "other-session",
        task_id: "c2c_output1",
        iteration: 2,
      },
    });
    expect(mismatched.isError).toBe(true);
    expect(textOf(mismatched)).toContain("EXECUTION_CORRELATION_MISMATCH");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: {
        action: "read",
        id: hidden.id,
        local_session_id: "integration-session",
        task_id: "c2c_output1",
        iteration: 2,
      },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: {
        action: "read",
        id: 999999,
        local_session_id: "integration-session",
        task_id: "c2c_output1",
        iteration: 2,
      },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list", local_session_id: "limited", task_id: "c2c_limited", iteration: 0 },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    const writeDenied = await limitedClient.callTool({
      name: "submit_control_result",
      arguments: {
        requestId: "missing",
        localSessionId: "limited",
        taskId: "c2c_test",
        iteration: 0,
        phase: "PLAN",
        kind: "PLAN",
        payload: {
          goal: "demo",
          rationale: "scope check",
          actions: [{ change: "inspect", why: "verify denial" }],
          tests: [],
          successCriteria: ["denied"],
        },
      },
    });
    expect(writeDenied.isError).toBe(true);
    expect(textOf(writeDenied)).toContain("INSUFFICIENT_SCOPE");
    const progressDenied = await limitedClient.callTool({
      name: "report_control_progress",
      arguments: {
        requestId: "missing",
        localSessionId: "limited",
        taskId: "c2c_test",
        iteration: 0,
        phase: "PLAN",
        status: "READING_CODE",
      },
    });
    expect(progressDenied.isError).toBe(true);
    expect(textOf(progressDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("submit_control_result writes one structured result to the local mailbox", async () => {
    const request = openControlResultRequest(bridge.workspace.id, {
      localSessionId: "integration-session",
      taskId: "c2c_plan1",
      iteration: 0,
      phase: "PLAN",
    });
    const progressResult = await client.callTool({
      name: "report_control_progress",
      arguments: {
        requestId: request.requestId,
        localSessionId: request.localSessionId,
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
        status: "READING_CODE",
        message: "Inspecting the mailbox implementation.",
      },
    });
    const progressReceipt = structuredJsonOf<{
      accepted: true;
      requestId: string;
      status: string;
    }>(progressResult);
    expect(progressReceipt).toMatchObject({
      accepted: true,
      requestId: request.requestId,
      status: "READING_CODE",
    });
    const result = await client.callTool({
      name: "submit_control_result",
      arguments: {
        requestId: request.requestId,
        localSessionId: request.localSessionId,
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
        kind: "PLAN",
        payload: {
          goal: "Add mailbox transport",
          rationale: "Avoid parsing browser-rendered results.",
          actions: [{ file: "src/control/mailbox.ts", change: "read mailbox result", why: "local handoff" }],
          tests: ["pnpm test"],
          successCriteria: ["Codex reads the PLAN locally"],
        },
      },
    });
    const receipt = structuredJsonOf<{
      accepted: true;
      requestId: string;
      localSessionId: string;
      phase: string;
      kind: string;
    }>(result);
    expect(receipt.accepted).toBe(true);
    expect(receipt.requestId).toBe(request.requestId);
    expect(receipt.localSessionId).toBe(request.localSessionId);
    expect(receipt.phase).toBe("PLAN");
    expect(receipt.kind).toBe("PLAN");

    const local = getControlResultStatus(bridge.workspace.id, request.requestId, "integration-session", {
      taskId: request.taskId,
      iteration: request.iteration,
      phase: request.phase,
    });
    expect(local.status).toBe("received");
    expect(local.result?.kind).toBe("PLAN");
    expect(local.result?.localSessionId).toBe("integration-session");
    expect(local.progress?.status).toBe("READING_CODE");
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});
