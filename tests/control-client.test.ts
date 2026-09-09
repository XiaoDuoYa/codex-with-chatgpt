import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminFetch,
  cancelTurn,
  issueTurn,
  registerWorkspace,
  revokeRequest,
  retireSurface,
  unregisterWorkspace,
  type MachineRegistrationIdentity,
} from "../src/gateway/control-client.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import type { MachineRuntimeState } from "../src/gateway/runtime.js";

function runtime(): MachineRuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    machineId: `machine-${"a".repeat(32)}`,
    associationId: `assoc-${"c".repeat(32)}`,
    associationNonce: "n".repeat(43),
    bootEpoch: "b".repeat(32),
    pid: 1234,
    port: 48_765,
    adminToken: `c2c_admin_${"x".repeat(32)}`,
    startedAt: new Date().toISOString(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("machine gateway control client", () => {
  it("sends authenticated JSON requests with an optional body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const machine = runtime();

    await adminFetch(machine, "POST", "/admin/test", { answer: 42 }, 1_000);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48765/admin/test",
      expect.objectContaining({
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${machine.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ answer: 42 }),
      })
    );

    await adminFetch(machine, "GET", "/admin/info", 1_000);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "GET",
      body: undefined,
    }));
    expect(JSON.stringify(fetchMock.mock.calls)).toContain(machine.adminToken);
  });

  it("provides typed registration, issue, cancel, and unregister helpers", async () => {
    const identity: MachineRegistrationIdentity = {
      workspaceId: "workspace-a",
      projectId: "project-a",
      registrationId: "registration-a",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...identity, workspaceName: "project" }))
      .mockResolvedValueOnce(jsonResponse({
        token: "c2c_ctx_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12",
        binding: { ...identity, localSessionId: "session-a" },
      }))
      .mockResolvedValueOnce(jsonResponse({ cancelled: true }))
      .mockResolvedValueOnce(jsonResponse({ unregistered: true }));
    vi.stubGlobal("fetch", fetchMock);
    const machine = runtime();
    const turn = {
      ...identity,
      localSessionId: "session-a",
      taskId: "task-a",
      iteration: 0,
      phase: "PLAN",
      requestId: "request-a",
      scopes: ["workspace.read"],
      compactionEpoch: 0,
      generation: 1,
    } as const;
    const cancellation = {
      workspaceId: turn.workspaceId,
      projectId: turn.projectId,
      localSessionId: turn.localSessionId,
      taskId: turn.taskId,
      iteration: turn.iteration,
      phase: turn.phase,
      requestId: turn.requestId,
    } as const;

    await expect(registerWorkspace(machine, "/workspace/project")).resolves.toMatchObject(identity);
    await expect(issueTurn(machine, turn)).resolves.toHaveProperty("token");
    await expect(cancelTurn(machine, "c2c_ctx_token", cancellation)).resolves.toEqual({ cancelled: true });
    await expect(unregisterWorkspace(machine, identity)).resolves.toEqual({ unregistered: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:48765/admin/workspaces/register",
      "http://127.0.0.1:48765/admin/turns/issue",
      "http://127.0.0.1:48765/admin/turns/cancel",
      "http://127.0.0.1:48765/admin/workspaces/unregister",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      contextId: "c2c_ctx_token",
      expected: cancellation,
    });
  });

  it("surfaces safe admin errors and validates request targets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "token_not_found", message: "not allowed" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    const machine = runtime();

    await expect(adminFetch(machine, "GET", "/admin/info")).rejects.toMatchObject({
      name: "MachineAdminError",
      status: 403,
      code: "token_not_found",
      message: "not allowed",
    });
    await expect(adminFetch(machine, "GET", "http://evil.example/")).rejects.toThrow(/target is invalid/);
    await expect(adminFetch(machine, "GET", "/admin/info", undefined, 0)).rejects.toThrow(/timeout/);
  });

  it("revokes a request by exact correlation without requiring a context id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ revoked: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const machine = runtime();
    const binding = {
      workspaceId: "workspace-a",
      projectId: "project-a",
      localSessionId: "session-a",
      taskId: "task-a",
      iteration: 1,
      phase: "REVIEW",
      requestId: "request-a",
    } as const;

    await expect(revokeRequest(machine, binding)).resolves.toEqual({ revoked: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48765/admin/turns/revoke-request",
      expect.objectContaining({ body: JSON.stringify(binding) }),
    );
  });

  it("provides a typed surface retirement helper", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      retired: true,
      revokedContexts: 2,
      removedLeases: 1,
      removedBindings: 1,
      removedSession: true,
      mailbox: {
        localSessionId: "session-a",
        pendingCancelled: 1,
        receivedAcknowledged: 0,
        activeRequestCleared: true,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const machine = runtime();
    const identity = {
      workspaceId: "workspace-a",
      projectId: "project-a",
      registrationId: "registration-a",
      localSessionId: "session-a",
    };

    await expect(retireSurface(machine, identity)).resolves.toMatchObject({
      retired: true,
      revokedContexts: 2,
      mailbox: { pendingCancelled: 1 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48765/admin/surfaces/retire",
      expect.objectContaining({ body: JSON.stringify(identity) }),
    );
  });
});
