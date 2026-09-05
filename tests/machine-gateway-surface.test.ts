import { afterEach, describe, expect, it } from "vitest";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { TurnCapabilityError, type TurnCapabilityBinding } from "../src/gateway/turn-capability.js";
import { acknowledgeControlResult, getControlResultStatus, openControlResultRequest, submitControlResult } from "../src/control/mailbox.js";
import { readSession, updateSession } from "../src/session/state.js";
import {
  claimSurface,
  reapExpiredSurfaceLeases,
  releaseSurface,
} from "../src/session/surface-ownership.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const PROJECT_URL = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const START = new Date();
const cleanups: string[] = [];

function expectCode(action: () => unknown, code: TurnCapabilityError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TurnCapabilityError);
    expect((error as TurnCapabilityError).code).toBe(code);
  }
}

function chatUrl(chatId: string): string {
  return `${PROJECT_URL.replace("/project", "")}/c/${chatId}`;
}

function surface(projectId: string, localSessionId: string, tabId: string, overrides: Record<string, unknown> = {}) {
  return claimSurface({
    projectId,
    localSessionId,
    browserId: "iab",
    surfaceId: "chatgpt",
    tabId,
    projectUrl: PROJECT_URL,
    chatUrl: chatUrl(`chat-${localSessionId}`),
    ownerProcessEpoch: `owner-${localSessionId}`,
    now: START,
    leaseTtlMs: 60_000,
    ...overrides,
  });
}

function turn(
  registration: ReturnType<MachineGateway["registerWorkspace"]>,
  localSessionId: string,
  generation: number,
  taskId: string,
): TurnCapabilityBinding {
  return {
    workspaceId: registration.workspaceId,
    projectId: registration.projectId,
    registrationId: registration.registrationId,
    localSessionId,
    taskId,
    iteration: 0,
    phase: "BOOT",
    scopes: ["workspace.read"],
    compactionEpoch: 0,
    generation,
  };
}

describe("machine gateway surface invalidation", () => {
  it("requires resolving the exact mailbox before rotating and preserves checkpoint and other sessions", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const identity = { ...registration, localSessionId: "session-recover" };
    const first = gateway.surfaceClaim(identity, {
      browserId: "iab", surfaceId: "chatgpt", tabId: "tab-old", projectUrl: PROJECT_URL,
      chatUrl: chatUrl("old"), ownerProcessEpoch: "owner-recover", leaseTtlMs: 60000,
    });
    gateway.surfaceCommit(identity, first, {});
    updateSession(registration.workspaceId, identity.localSessionId, {
      taskId: "keep-task", iteration: 2,
      checkpoint: { protocolState: "EXECUTED_LOCAL", originalGoal: "Keep completed work", completedSubtasks: "Tests ran" },
    });
    const other = surface(registration.projectId, "session-other", "tab-other");
    const otherContext = gateway.issueTurn(turn(registration, "session-other", other.generation, "other-task"));
    const request = gateway.openControlResultRequest(identity, { taskId: "keep-task", iteration: 2, phase: "PLAN" });
    const context = gateway.issueTurn({
      ...turn(registration, identity.localSessionId, first.generation, "keep-task"), iteration: 2,
    });
    const replacement = {
      browserId: "iab", surfaceId: "chatgpt", tabId: "tab-new", projectUrl: PROJECT_URL,
      ownerProcessEpoch: "owner-recover", replaces: first, leaseTtlMs: 60000,
    };
    expect(gateway.surfaceGet(identity).control).toMatchObject({ status: "pending", requestId: request.request.requestId });
    expect(() => gateway.surfaceClaim(identity, replacement)).toThrow(/Resolve the active mailbox/);
    // An exact reclaim while generation is busy remains idempotent.
    expect(gateway.surfaceClaim(identity, { ...replacement, tabId: first.tabId, chatUrl: first.chatUrl }).generation).toBe(first.generation);
    expect(gateway.turnStatus(context.token).status).not.toBe("revoked");
    submitControlResult(registration.workspaceId, {
      requestId: request.request.requestId, localSessionId: identity.localSessionId,
      taskId: "keep-task", iteration: 2, phase: "PLAN", kind: "BLOCKED",
      payload: { reason: "Fixture result", needs: ["Consume this result before recovery"] },
    });
    expect(gateway.surfaceGet(identity).control?.status).toBe("received");
    expect(() => gateway.surfaceClaim(identity, replacement)).toThrow(/consume and acknowledge/);
    acknowledgeControlResult(registration.workspaceId, request.request.requestId, identity.localSessionId, {
      taskId: "keep-task", iteration: 2, phase: "PLAN",
    });
    const candidate = gateway.surfaceClaim(identity, replacement);
    expect(candidate.generation).toBeGreaterThan(first.generation);
    expect(candidate.chatUrl).toBeUndefined();
    expect(gateway.turnStatus(context.token).status).toBe("revoked");
    expect(() => gateway.surfaceClaim(identity, { ...replacement, tabId: "stale-retry" })).toThrow();
    gateway.surfaceCommit(identity, candidate, { chatUrl: chatUrl("new") });
    expect(readSession(registration.workspaceId, identity.localSessionId)).toMatchObject({
      taskId: "keep-task", iteration: 2, url: chatUrl("new"),
      checkpoint: { originalGoal: "Keep completed work", completedSubtasks: "Tests ran" },
    });
    const otherClaim = gateway.claimTurn(otherContext.token, ["workspace.read"]);
    gateway.releaseTurn(otherContext.token, otherClaim.lease);
    expect(gateway.surfaceGet({ ...identity, localSessionId: "session-other" }).lease?.tabId).toBe("tab-other");
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanup(cleanups.pop()!);
    delete process.env.C2C_STATE_DIR;
  });

  it("rejects non-ChatGPT surface identities at the gateway boundary", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-identity");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const identity = {
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      registrationId: registration.registrationId,
      localSessionId: "session-invalid-surface",
    };
    const input = {
      tabId: "tab-invalid-surface",
      projectUrl: PROJECT_URL,
      chatUrl: chatUrl("chat-invalid-surface"),
      ownerProcessEpoch: "owner-invalid-surface",
    };

    expect(() => gateway.surfaceClaim(identity, {
      ...input,
      browserId: "chrome",
      surfaceId: "chatgpt",
    })).toThrow(/browserId 'iab'.*surfaceId 'chatgpt'/);
    expect(() => gateway.surfaceClaim(identity, {
      ...input,
      browserId: "iab",
      surfaceId: "custom-surface",
    })).toThrow(/browserId 'iab'.*surfaceId 'chatgpt'/);
  });

  it("revokes a context when its surface rotates", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-rotation");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const first = surface(registration.projectId, "session-rotation", "tab-one");
    const context = gateway.issueTurn(turn(registration, "session-rotation", first.generation, "task-rotation"));

    const rotated = surface(registration.projectId, "session-rotation", "tab-two", {
      chatUrl: chatUrl("chat-session-rotation-next"),
      replaces: first,
      now: new Date(START.getTime() + 1_000),
    });
    expect(rotated.generation).toBe(first.generation + 1);

    expectCode(() => gateway.claimTurn(context.token, ["workspace.read"]), "STALE_BINDING_EPOCH");
    expect(gateway.turnStatus(context.token).status).toBe("revoked");
  });

  it("allows BOOT on a Project-only candidate but gates later phases until commit", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-candidate");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const candidate = surface(registration.projectId, "session-candidate", "tab-candidate", {
      chatUrl: undefined,
    });

    const boot = gateway.issueTurn(turn(registration, "session-candidate", candidate.generation, "task-boot"));
    const claimedBoot = gateway.claimTurn(boot.token, ["workspace.read"]);
    expect(claimedBoot.workspace.id).toBe(registration.workspaceId);
    gateway.releaseTurn(boot.token, claimedBoot.lease);

    const later = gateway.issueTurn({
      ...turn(registration, "session-candidate", candidate.generation, "task-later"),
      phase: "RESEARCH",
      requestId: "request-later",
    });
    expectCode(() => gateway.claimTurn(later.token, ["workspace.read"]), "STALE_BINDING_EPOCH");
  });

  it("revokes a context when its surface is released", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-release");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const owned = surface(registration.projectId, "session-release", "tab-release");
    const context = gateway.issueTurn(turn(registration, "session-release", owned.generation, "task-release"));

    expect(releaseSurface(owned, new Date(START.getTime() + 1_000))).toBe(true);
    expectCode(() => gateway.claimTurn(context.token, ["workspace.read"]), "STALE_BINDING_EPOCH");
    expect(gateway.turnStatus(context.token).status).toBe("revoked");
  });

  it("revokes a context when its surface lease expires", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-expiry");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const owned = surface(registration.projectId, "session-expiry", "tab-expiry", { leaseTtlMs: 1_000 });
    const context = gateway.issueTurn(turn(registration, "session-expiry", owned.generation, "task-expiry"));

    expect(reapExpiredSurfaceLeases(registration.projectId, new Date(START.getTime() + 1_001))).toBe(1);
    expectCode(() => gateway.claimTurn(context.token, ["workspace.read"]), "STALE_BINDING_EPOCH");
    expect(gateway.turnStatus(context.token).status).toBe("revoked");
  });

  it("rejects lease renewal after the owning surface is released", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-renew");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const owned = surface(registration.projectId, "session-renew", "tab-renew");
    const context = gateway.issueTurn(turn(registration, "session-renew", owned.generation, "task-renew"));
    const claimed = gateway.claimTurn(context.token, ["workspace.read"]);

    expect(releaseSurface(owned, new Date(START.getTime() + 1_000))).toBe(true);
    expectCode(() => gateway.renewTurn(context.token, claimed.lease), "STALE_BINDING_EPOCH");
    expect(gateway.turnStatus(context.token).status).toBe("revoked");
  });

  it("retires the session surface, contexts, and mailbox together", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("gateway-surface-retire");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const registration = gateway.registerWorkspace(root);
    const identity = {
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      registrationId: registration.registrationId,
      localSessionId: "session-retire-gateway",
    };
    const owned = surface(registration.projectId, identity.localSessionId, "tab-retire-gateway");
    gateway.surfaceCommit(identity, owned, {
      chatUrl: chatUrl(`chat-${identity.localSessionId}`),
      connectorName: "Codex with ChatGPT",
    });
    expect(gateway.surfaceGet(identity).projectUrl).toBe(PROJECT_URL);
    const context = gateway.issueTurn(turn(registration, identity.localSessionId, owned.generation, "task-retire-gateway"));
    const request = gateway.openControlResultRequest(identity, {
      taskId: "task-retire-gateway",
      iteration: 0,
      phase: "PLAN",
    });

    const retired = gateway.surfaceRetire(identity);
    expect(retired).toMatchObject({
      retired: true,
      revokedContexts: 1,
      removedLeases: 1,
      mailbox: {
        pendingCancelled: 1,
        receivedAcknowledged: 0,
        activeRequestCleared: true,
      },
    });
    expect(gateway.turnStatus(context.token).status).toBe("revoked");
    expect(gateway.surfaceGet(identity).projectUrl).toBe(PROJECT_URL);
    expect(getControlResultStatus(registration.workspaceId, request.request.requestId, identity.localSessionId, {
      taskId: "task-retire-gateway", iteration: 0, phase: "PLAN",
    }).status).toBe("cancelled");

    const replacement = surface(registration.projectId, identity.localSessionId, "tab-retire-gateway-new", {
      now: new Date(START.getTime() + 1_000),
    });
    expect(replacement.generation).toBe(owned.generation + 1);
  });
});
