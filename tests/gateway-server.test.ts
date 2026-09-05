import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { startMachineGatewayServer, type MachineGatewayServer } from "../src/gateway/server.js";
import {
  clearMachineRuntime,
  machineLifetimeFile,
  readMachineRuntime,
  writeMachineRuntime,
} from "../src/gateway/runtime.js";
import { claimSurface, commitVerifiedSurfaceRoute } from "../src/session/surface-ownership.js";
import { cleanup, isolateStateDir, makeTmpDir, write, projectSelection } from "./helpers.js";

async function admin<T>(
  server: MachineGatewayServer,
  route: string,
  body: unknown,
  token = server.runtime.adminToken
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.localBaseUrl()}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
}

async function adminInfo<T>(server: MachineGatewayServer): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.localBaseUrl()}/admin/info`, {
    headers: { authorization: `Bearer ${server.runtime.adminToken}` },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function freeLoopbackPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe("machine gateway control server", () => {
  const cleanups: string[] = [];
  let server: MachineGatewayServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    for (const target of cleanups.splice(0)) cleanup(target);
    delete process.env.C2C_STATE_DIR;
  });

  it("persists one owner-only machine runtime and registers multiple workspaces", async () => {
    cleanups.push(isolateStateDir());
    const rootA = makeTmpDir("machine-server-a");
    const rootB = makeTmpDir("machine-server-b");
    cleanups.push(rootA, rootB);
    write(rootA, "marker.txt", "a\n");
    write(rootB, "marker.txt", "b\n");
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });

    expect(readMachineRuntime()).toEqual(server.runtime);
    const mode = fs.statSync(path.join(process.env.C2C_STATE_DIR!, "runtime", "machine.json")).mode & 0o777;
    const ownerMode = fs.statSync(machineLifetimeFile()).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    if (process.platform !== "win32") expect(ownerMode).toBe(0o600);
    const info = await adminInfo<{ port: number; machineId: string; bootEpoch: string }>(server);
    expect(info).toMatchObject({
      status: 200,
      body: {
        port: server.port,
        machineId: server.runtime.machineId,
        bootEpoch: server.runtime.bootEpoch,
      },
    });

    const unauthorized = await admin(server, "/admin/workspaces/register", { root: rootA }, "wrong");
    expect(unauthorized.status).toBe(404);

    const registeredA = await admin<{
      workspaceId: string;
      projectId: string;
      registrationId: string;
      workspaceName: string;
    }>(server, "/admin/workspaces/register", { root: rootA });
    const registeredB = await admin<typeof registeredA.body>(
      server,
      "/admin/workspaces/register",
      { root: rootB }
    );
    expect(registeredA.status).toBe(200);
    expect(registeredB.status).toBe(200);
    expect(registeredA.body.workspaceId).not.toBe(registeredB.body.workspaceId);
    expect(server.gateway.stats().workspaceCount).toBe(2);

    const registrationAgain = await admin<typeof registeredA.body>(
      server,
      "/admin/workspaces/register",
      { root: rootA }
    );
    expect(registrationAgain.body).toEqual(registeredA.body);
  });

  it("routes the complete surface lifecycle through authenticated admin endpoints", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-server-surface");
    cleanups.push(root);
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });
    const registered = await admin<{
      workspaceId: string;
      projectId: string;
      registrationId: string;
    }>(server, "/admin/workspaces/register", { root });
    const identity = {
      workspaceId: registered.body.workspaceId,
      projectId: registered.body.projectId,
      registrationId: registered.body.registrationId,
      localSessionId: "session-admin-surface",
    };
    const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
    const chatUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-admin-surface";
    const unproven = await admin(server, "/admin/surfaces/claim", {
      ...identity, browserId: "iab", surfaceId: "chatgpt", tabId: "tab-unproven", projectUrl,
    });
    expect(unproven.status).not.toBe(200);
    const claimed = await admin<{ lease: Record<string, unknown> }>(server, "/admin/surfaces/claim", {
      ...identity,
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-admin-surface",
      projectUrl,
      projectSelection: projectSelection(projectUrl),
      chatUrl,
      ownerProcessEpoch: "owner-admin-surface",
      leaseTtlMs: 60_000,
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.lease).toMatchObject({ tabId: "tab-admin-surface", generation: 1 });

    const current = await admin<{ lease: Record<string, unknown>; binding: unknown }>(
      server,
      "/admin/surfaces/get",
      identity,
    );
    expect(current.status).toBe(200);
    expect(current.body.lease).toMatchObject({ tabId: "tab-admin-surface", generation: 1 });
    expect(current.body.binding).toBeNull();

    const leaseRef = {
      projectId: registered.body.projectId,
      localSessionId: identity.localSessionId,
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-admin-surface",
      generation: 1,
      ownerProcessEpoch: "owner-admin-surface",
    };
    const committed = await admin<{ binding: Record<string, unknown> }>(server, "/admin/surfaces/commit", {
      ...identity,
      lease: leaseRef,
      chatUrl,
      connectorName: "Codex with ChatGPT",
    });
    expect(committed.status).toBe(200);
    expect(committed.body.binding).toMatchObject({ chatUrl, lastGeneration: 1 });

    const renewed = await admin<{ lease: Record<string, unknown> }>(server, "/admin/surfaces/renew", {
      ...identity,
      lease: leaseRef,
      leaseTtlMs: 60_000,
    });
    expect(renewed.status).toBe(200);
    expect(renewed.body.lease).toMatchObject({ generation: 1, tabId: "tab-admin-surface" });

    const released = await admin<{ released: boolean }>(server, "/admin/surfaces/release", {
      ...identity,
      lease: leaseRef,
    });
    expect(released).toEqual({ status: 200, body: { released: true } });

    const retired = await admin<{
      retired: boolean;
      revokedContexts: number;
      removedBindings: number;
      mailbox: { pendingCancelled: number; receivedAcknowledged: number };
    }>(server, "/admin/surfaces/retire", identity);
    expect(retired).toMatchObject({
      status: 200,
      body: {
        retired: true,
        revokedContexts: 0,
        removedBindings: 1,
        mailbox: { pendingCancelled: 0, receivedAcknowledged: 0 },
      },
    });
  });

  it("enforces the machine session capacity while keeping existing claims idempotent", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-server-surface-capacity");
    cleanups.push(root);
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });
    const registered = await admin<{
      workspaceId: string;
      projectId: string;
      registrationId: string;
    }>(server, "/admin/workspaces/register", { root });
    expect(registered.status).toBe(200);

    const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
    const claims = Array.from({ length: 100 }, (_, index) => {
      const suffix = String(index + 1).padStart(3, "0");
      return {
        workspaceId: registered.body.workspaceId,
        projectId: registered.body.projectId,
        registrationId: registered.body.registrationId,
        localSessionId: `session-capacity-${suffix}`,
        browserId: "iab",
        surfaceId: "chatgpt",
        tabId: `tab-capacity-${suffix}`,
        projectUrl,
        projectSelection: projectSelection(projectUrl),
        chatUrl: `https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-capacity-${suffix}`,
        ownerProcessEpoch: `owner-capacity-${suffix}`,
      };
    });

    const claimed = await Promise.all(
      claims.map((request) => admin<{ lease: Record<string, unknown> }>(server, "/admin/surfaces/claim", request)),
    );
    expect(claimed.every((response) => response.status === 200)).toBe(true);
    expect(server.gateway.stats().workspaceCount).toBe(1);

    const overCapacity = await admin<{ error: string }>(server, "/admin/surfaces/claim", {
      ...claims[100 - 1],
      localSessionId: "session-capacity-101",
      tabId: "tab-capacity-101",
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-capacity-101",
      ownerProcessEpoch: "owner-capacity-101",
    });
    expect(overCapacity).toMatchObject({
      status: 429,
      body: { error: "session_capacity_reached" },
    });

    const idempotent = await admin<{ lease: Record<string, unknown> }>(
      server,
      "/admin/surfaces/claim",
      claims[0],
    );
    expect(idempotent.status).toBe(200);
    expect(idempotent.body.lease).toEqual(claimed[0].body.lease);
  });

  it("rejects non-ChatGPT browser and surface identities at the HTTP boundary", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-server-surface-identity");
    cleanups.push(root);
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });
    const registered = await admin<{
      workspaceId: string;
      projectId: string;
      registrationId: string;
    }>(server, "/admin/workspaces/register", { root });
    const identity = {
      workspaceId: registered.body.workspaceId,
      projectId: registered.body.projectId,
      registrationId: registered.body.registrationId,
      localSessionId: "session-invalid-http-surface",
    };
    const base = {
      ...identity,
      tabId: "tab-invalid-http-surface",
      projectUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-invalid-http-surface",
      ownerProcessEpoch: "owner-invalid-http-surface",
    };

    const invalidBrowser = await admin(server, "/admin/surfaces/claim", {
      ...base,
      browserId: "chrome",
      surfaceId: "chatgpt",
    });
    expect(invalidBrowser.status).toBe(400);

    const invalidSurface = await admin(server, "/admin/surfaces/claim", {
      ...base,
      browserId: "iab",
      surfaceId: "custom-surface",
    });
    expect(invalidSurface.status).toBe(400);
  });

  it("aborts an active mailbox wait when the gateway closes", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-server-mailbox-close");
    cleanups.push(root);
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });
    const registered = await admin<{
      workspaceId: string;
      projectId: string;
      registrationId: string;
    }>(server, "/admin/workspaces/register", { root });
    const identity = {
      workspaceId: registered.body.workspaceId,
      projectId: registered.body.projectId,
      registrationId: registered.body.registrationId,
      localSessionId: "session-mailbox-close",
    };
    const opened = await admin<{ request: { requestId: string } }>(server, "/admin/mailbox/open", {
      ...identity,
      taskId: "task-mailbox-close",
      iteration: 0,
      phase: "PLAN",
    });
    expect(opened.status).toBe(200);

    const waiting = fetch(`${server.localBaseUrl()}/admin/mailbox/wait`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.runtime.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...identity,
        requestId: opened.body.request.requestId,
        taskId: "task-mailbox-close",
        iteration: 0,
        phase: "PLAN",
        timeoutMs: 86_400_000,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const startedAt = Date.now();
    await server.close();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(waiting).rejects.toThrow();
    server = null;
  });

  it("issues exact turn capabilities without accepting unknown scopes or registrations", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-server-turn");
    cleanups.push(root);
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });
    const registration = await admin<{
      workspaceId: string;
      projectId: string;
      registrationId: string;
    }>(server, "/admin/workspaces/register", { root });
    const surface = claimSurface({
      projectId: registration.body.projectId,
      localSessionId: "session-control",
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-control",
      projectUrl: "https://chatgpt.com/g/g-p-11111111111111111111111111111111/project",
      chatUrl: "https://chatgpt.com/g/g-p-11111111111111111111111111111111/c/chat-control",
      ownerProcessEpoch: "session-session-control",
      leaseTtlMs: 60_000,
    });
    commitVerifiedSurfaceRoute({
      lease: surface,
      workspaceId: registration.body.workspaceId,
      connectorName: "Codex with ChatGPT",
    });
    const turn = {
      workspaceId: registration.body.workspaceId,
      projectId: registration.body.projectId,
      registrationId: registration.body.registrationId,
      localSessionId: "session-control",
      taskId: "task-control",
      iteration: 2,
      phase: "PLAN",
      requestId: "request-control",
      scopes: ["workspace.read", "c2c.result.write"],
      compactionEpoch: 0,
      generation: 1,
    };

    const issued = await admin<{ token: string }>(server, "/admin/turns/issue", turn);
    expect(issued.status).toBe(200);
    expect(issued.body.token).toMatch(/^c2c_ctx_/);
    const claimed = server.gateway.claimTurn(issued.body.token, ["workspace.read"]);
    expect(claimed.workspace.root).toBe(fs.realpathSync.native(root));
    server.gateway.releaseTurn(issued.body.token, claimed.lease);

    const expectedCancellation = {
      workspaceId: turn.workspaceId,
      projectId: turn.projectId,
      localSessionId: turn.localSessionId,
      taskId: turn.taskId,
      iteration: turn.iteration,
      phase: turn.phase,
      requestId: turn.requestId,
    };
    const wrongCancel = await admin(server, "/admin/turns/cancel", {
      contextId: issued.body.token,
      expected: { ...expectedCancellation, requestId: "request-other" },
    });
    expect(wrongCancel.status).toBe(409);
    expect(server.gateway.turnStatus(issued.body.token).status).toBe("active");

    const wrongRequestRevoke = await admin(server, "/admin/turns/revoke-request", {
      ...expectedCancellation,
      requestId: "request-other",
    });
    expect(wrongRequestRevoke.status).toBe(200);
    expect(wrongRequestRevoke.body).toEqual({ revoked: 0 });
    expect(server.gateway.turnStatus(issued.body.token).status).toBe("active");

    const requestRevoke = await admin(server, "/admin/turns/revoke-request", expectedCancellation);
    expect(requestRevoke.status).toBe(200);
    expect(requestRevoke.body).toEqual({ revoked: 1 });
    expect(server.gateway.turnStatus(issued.body.token).status).toBe("revoked");

    const cancelled = await admin(server, "/admin/turns/cancel", {
      contextId: issued.body.token,
      expected: expectedCancellation,
    });
    expect(cancelled.status).toBe(200);
    const cancelledAgain = await admin(server, "/admin/turns/cancel", {
      contextId: issued.body.token,
      expected: expectedCancellation,
    });
    expect(cancelledAgain.status).toBe(200);

    const badScope = await admin(server, "/admin/turns/issue", {
      ...turn,
      scopes: ["process.exec"],
    });
    expect(badScope.status).toBe(400);
    const wrongRegistration = await admin(server, "/admin/turns/issue", {
      ...turn,
      registrationId: "registration-wrong",
    });
    expect(wrongRegistration.status).toBe(409);
  });

  it("issues a plugin turn only for fresh matching observations without revoking a valid turn on rejection", async () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("machine-server-plugin");
    cleanups.push(root);
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });
    const registration = server.gateway.registerWorkspace(root);
    const identity = { ...registration, localSessionId: "session-plugin" };
    const projectUrl = "https://chatgpt.com/g/g-p-11111111111111111111111111111111/project";
    const chatUrl = projectUrl.replace("/project", "/c/plugin-chat");
    const surface = server.gateway.surfaceClaim(identity, {
      browserId: "iab", surfaceId: "chatgpt", tabId: "tab-plugin",
      projectUrl, chatUrl, projectSelection: projectSelection(projectUrl),
    });
    server.gateway.surfaceCommit(identity, surface, { chatUrl });
    const turn = {
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      registrationId: registration.registrationId,
      localSessionId: identity.localSessionId,
      taskId: "task-plugin", iteration: 0, phase: "PLAN",
      generation: surface.generation, compactionEpoch: 0,
      scopes: ["workspace.read", "c2c.result.write"], plugins: ["GitHub"],
      requestId: "request-plugin",
    };
    const proof = {
      workspaceId: turn.workspaceId, localSessionId: turn.localSessionId,
      taskId: turn.taskId, iteration: turn.iteration, phase: turn.phase,
      tabId: surface.tabId, generation: surface.generation, chatUrl,
      bootEpoch: server.runtime.bootEpoch, observedAt: new Date().toISOString(),
      chatgptAccount: "fixture-account",
      requestedOperations: [{ plugin: "GitHub", tool: "read_repository" }],
      plugins: [{ id: "GitHub", availability: "available", usesGitHub: true,
        tools: [{ tool: "read_repository", availability: "available", effect: "read" }],
        githubActor: { login: "fixture-user", id: "123", source: "authenticated-profile" } }],
      github: { repository: { host: "github.com", owner: "fixture-user", name: "fixture-repo" },
        expectedActor: { login: "fixture-user", id: "123" } },
    };
    const discovery = {
      ...turn, phase: "RESEARCH", taskId: "task-profile", requestId: "request-profile",
      pluginIntent: "identity-discovery", scopes: ["c2c.result.write"],
      pluginPreflight: {
        ...proof, phase: "RESEARCH", taskId: "task-profile", github: undefined, requestedOperations: undefined,
        plugins: [{ id: "GitHub", availability: "available", usesGitHub: true, authenticatedProfileTool: "get_authenticated_user" }],
      },
    };
    const profileTurn = await admin<{ token: string }>(server, "/admin/turns/issue", discovery);
    expect(profileTurn.status).toBe(200);
    const profileLease = server.gateway.claimTurn(profileTurn.body.token, ["c2c.result.write"]);
    server.gateway.releaseTurn(profileTurn.body.token, profileLease.lease);
    expect(() => server!.gateway.claimTurn(profileTurn.body.token, ["workspace.read"])).toThrow();
    const unauthorizedBusiness = await admin(server, "/admin/turns/issue", { ...discovery, pluginIntent: "task" });
    expect(unauthorizedBusiness.status).not.toBe(200);
    const excessiveScopes = await admin(server, "/admin/turns/issue", { ...discovery, scopes: ["git.read"] });
    expect(excessiveScopes.status).not.toBe(200);
    expect(server.gateway.turnStatus(profileTurn.body.token).status).toBe("active");
    expect((await admin(server, "/admin/turns/cancel", { contextId: profileTurn.body.token })).status).toBe(200);

    // A separately correlated business turn still needs the actual matching actor.
    const issued = await admin<{ token: string }>(server, "/admin/turns/issue", { ...turn, pluginPreflight: proof });
    expect(issued.status).toBe(200);
    const claimed = server.gateway.claimTurn(issued.body.token, ["workspace.read"]);
    expect(claimed.workspace.root).toBe(fs.realpathSync.native(root));
    server.gateway.releaseTurn(issued.body.token, claimed.lease);

    for (const pluginPreflight of [
      undefined,
      { ...proof, tabId: "another-tab" },
      { ...proof, bootEpoch: "another-epoch" },
      { ...proof, requestedOperations: undefined },
      { ...proof, plugins: [{ ...proof.plugins[0], tools: [{ tool: "read_repository", availability: "available", effect: "write" }] }] },
      { ...proof, plugins: [{ ...proof.plugins[0], githubActor: { login: "wrong-user", id: "456", source: "authenticated-profile" } }] },
    ]) {
      const rejected = await admin(server, "/admin/turns/issue", { ...turn, pluginPreflight });
      expect(rejected.status).not.toBe(200);
      expect(server.gateway.turnStatus(issued.body.token).status).toBe("active");
    }
  });

  it("rejects a second machine gateway even when it could choose another port", async () => {
    cleanups.push(isolateStateDir());
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });

    await expect(startMachineGatewayServer({ port: 0, connectStdio: false })).rejects.toThrow(
      /already owned/
    );
  });

  it("rejects an invalid association before returning a server", async () => {
    cleanups.push(isolateStateDir());

    await expect(
      startMachineGatewayServer({
        port: 0,
        connectStdio: false,
        persistRuntime: false,
        associationId: "invalid-association",
      })
    ).rejects.toThrow(/validation/i);
  });

  it("does not clear a replacement runtime when an older server closes", async () => {
    cleanups.push(isolateStateDir());
    server = await startMachineGatewayServer({ port: 0, connectStdio: false });
    const replacement = { ...server.runtime, pid: server.runtime.pid + 1, port: server.runtime.port + 1 };
    writeMachineRuntime(replacement);

    await server.close();
    expect(readMachineRuntime()).toEqual(replacement);
    clearMachineRuntime();
  });

  it("closes the listener and releases machine ownership when runtime persistence fails", async () => {
    cleanups.push(isolateStateDir());
    const port = await freeLoopbackPort();
    const runtimePath = path.join(process.env.C2C_STATE_DIR!, "runtime", "machine.json");
    fs.mkdirSync(runtimePath, { recursive: true });

    await expect(
      startMachineGatewayServer({ host: "127.0.0.1", port, connectStdio: false })
    ).rejects.toThrow();

    fs.rmSync(runtimePath, { recursive: true, force: true });
    server = await startMachineGatewayServer({ host: "127.0.0.1", port, connectStdio: false });
    expect(server.port).toBe(port);
  });

  it("closes the control listener when the tunnel-owned stdio input reaches EOF", async () => {
    cleanups.push(isolateStateDir());
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    server = await startMachineGatewayServer({
      port: 0,
      connectStdio: true,
      stdioInput: stdin,
      stdioOutput: stdout,
    });
    const baseUrl = server.localBaseUrl();
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    stdin.end();
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    await server.close();
    server = null;
  });

  it("closes the control listener when the injected transport closes", async () => {
    cleanups.push(isolateStateDir());
    const transport = {
      onclose: undefined as (() => void) | undefined,
      onerror: undefined,
      onmessage: undefined,
      async start(): Promise<void> {},
      async send(): Promise<void> {},
      async close(): Promise<void> {
        this.onclose?.();
      },
    };
    server = await startMachineGatewayServer({ port: 0, connectStdio: true, stdioTransport: transport });
    const baseUrl = server.localBaseUrl();
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    transport.onclose?.();
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    await server.close();
    server = null;
  });
});
