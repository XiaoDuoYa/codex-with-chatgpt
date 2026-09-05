import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MachineGateway } from "../src/gateway/machine-gateway.js";
import { openControlResultRequest } from "../src/control/mailbox.js";
import {
  TurnCapabilityBroker,
  TurnCapabilityError,
  type TurnCapabilityBinding,
} from "../src/gateway/turn-capability.js";
import {
  machineWorkspaceMembershipFile,
  WorkspaceRegistryError,
} from "../src/gateway/workspace-registry.js";
import {
  claimSurface,
  commitVerifiedSurfaceRoute,
  currentProjectUrl,
  currentSurfaceLease,
} from "../src/session/surface-ownership.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write, projectSelection } from "./helpers.js";

function binding(
  registration: ReturnType<MachineGateway["registerWorkspace"]>,
  taskId: string,
  overrides: Partial<TurnCapabilityBinding> = {}
): TurnCapabilityBinding {
  return {
    workspaceId: registration.workspaceId,
    projectId: registration.projectId,
    registrationId: registration.registrationId,
    localSessionId: `session-${taskId}`,
    taskId,
    iteration: 1,
    phase: "EXECUTING",
    requestId: `request-${taskId}`,
    scopes: ["workspace.read", "workspace.write"],
    compactionEpoch: 0,
    generation: 1,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: TurnCapabilityError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TurnCapabilityError);
    expect((error as TurnCapabilityError).code).toBe(code);
  }
}

describe("machine gateway", () => {
  let machineStateDir: string;

  beforeEach(() => {
    // Even tests without a live server can unregister machine-owned surfaces.
    machineStateDir = isolateStateDir();
  });

  afterEach(() => {
    cleanup(machineStateDir);
    delete process.env.C2C_STATE_DIR;
  });

  it("routes two registered workspaces through their live leases", async () => {
    const rootA = makeTmpDir("gateway-route-a");
    const rootB = makeTmpDir("gateway-route-b");
    try {
      write(rootA, "marker.txt", "workspace-a\n");
      write(rootB, "marker.txt", "workspace-b\n");
      const gateway = new MachineGateway({
        broker: new TurnCapabilityBroker(),
      });
      const registrationA = gateway.registerWorkspace(rootA);
      const registrationB = gateway.registerWorkspace(rootB);
      const contextA = gateway.issueTurn(binding(registrationA, "task-a"));
      const contextB = gateway.issueTurn(binding(registrationB, "task-b"));
      const claimedA = gateway.claimTurn(contextA.token, ["workspace.read"]);
      const claimedB = gateway.claimTurn(contextB.token, ["workspace.read"]);

      expect(Object.isFrozen(claimedA)).toBe(true);
      expect((await claimedA.workspace.readFile("marker.txt")).content).toBe("workspace-a");
      expect((await claimedB.workspace.readFile("marker.txt")).content).toBe("workspace-b");
      expect(claimedA.workspace.root).not.toBe(claimedB.workspace.root);

      gateway.releaseTurn(contextA.token, claimedA.lease);
      gateway.releaseTurn(contextB.token, claimedB.lease);
    } finally {
      cleanup(rootA);
      cleanup(rootB);
    }
  });

  it("rejects missing or wrong scopes without creating an activity lease", () => {
    const root = makeTmpDir("gateway-scopes");
    try {
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const contextId = gateway.issueTurn(binding(registration, "scope"));

      expectCode(() => gateway.claimTurn(contextId.token, ["process.exec"]), "SCOPE_DENIED");
      expect(gateway.stats().activeTurnCount).toBe(0);
      expectCode(
        () => gateway.claimTurn(`c2c_ctx_${"a".repeat(43)}`, ["workspace.read"]),
        "TOKEN_NOT_FOUND"
      );
    } finally {
      cleanup(root);
    }
  });

  it("cancels only a capability matching the exact control request", () => {
    const root = makeTmpDir("gateway-cancel-binding");
    try {
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const expected = binding(registration, "cancel-exact");
      const grant = gateway.issueTurn(expected);

      expectCode(
        () => gateway.cancelTurn(grant.token, { ...expected, requestId: "request-other" }),
        "BINDING_MISMATCH"
      );
      expect(gateway.turnStatus(grant.token).status).toBe("issued");

      gateway.cancelTurn(grant.token, expected);
      expect(gateway.turnStatus(grant.token).status).toBe("cancelled");
      expect(() => gateway.cancelTurn(grant.token, expected)).not.toThrow();
      expectCode(() => gateway.assertTurnSurface(grant.token), "TOKEN_CANCELLED");
    } finally {
      cleanup(root);
    }
  });

  it("revokes a request by exact correlation without receiving a context id", () => {
    const root = makeTmpDir("gateway-revoke-request");
    try {
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const expected = binding(registration, "revoke-request");
      const grant = gateway.issueTurn(expected);

      expect(gateway.revokeRequest({
        workspaceId: expected.workspaceId,
        projectId: expected.projectId,
        localSessionId: expected.localSessionId,
        taskId: expected.taskId,
        iteration: expected.iteration,
        phase: expected.phase,
        requestId: expected.requestId!,
      })).toBe(1);
      expect(gateway.turnStatus(grant.token).status).toBe("revoked");
      expect(gateway.revokeRequest({
        workspaceId: expected.workspaceId,
        projectId: expected.projectId,
        localSessionId: expected.localSessionId,
        taskId: expected.taskId,
        iteration: expected.iteration,
        phase: expected.phase,
        requestId: expected.requestId!,
      })).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("rejects an empty required-scopes tuple at runtime", () => {
    const root = makeTmpDir("gateway-empty-scopes");
    try {
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const context = gateway.issueTurn(binding(registration, "empty-scopes"));

      expectCode(
        () => gateway.claimTurn(context.token, [] as never),
        "INVALID_BINDING"
      );
    } finally {
      cleanup(root);
    }
  });

  it("rotates one local session without revoking another session", () => {
    const root = makeTmpDir("gateway-rotation");
    try {
      const gateway = new MachineGateway({
        broker: new TurnCapabilityBroker(),
      });
      const registration = gateway.registerWorkspace(root);
      const firstBinding = binding(registration, "rotate");
      const unrelatedBinding = binding(registration, "unrelated");
      const first = gateway.issueTurn(firstBinding);
      const unrelated = gateway.issueTurn(unrelatedBinding);
      const replacement = gateway.issueTurn(firstBinding);

      expectCode(() => gateway.claimTurn(first.token, ["workspace.read"]), "TOKEN_REVOKED");
      const activeUnrelated = gateway.claimTurn(unrelated.token, ["workspace.read"]);
      expect(activeUnrelated.workspace.root).toBe(root);
      const activeReplacement = gateway.claimTurn(replacement.token, ["workspace.read"]);
      gateway.releaseTurn(unrelated.token, activeUnrelated.lease);
      gateway.releaseTurn(replacement.token, activeReplacement.lease);
    } finally {
      cleanup(root);
    }
  });

  it("invalidates an older generation for the same local session", () => {
    const root = makeTmpDir("gateway-generation");
    try {
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const first = gateway.issueTurn(
        binding(registration, "generation-one", {
          localSessionId: "session-shared",
          generation: 1,
        })
      );
      const replacement = gateway.issueTurn(
        binding(registration, "generation-two", {
          localSessionId: "session-shared",
          generation: 2,
        })
      );

      expectCode(
        () => gateway.claimTurn(first.token, ["workspace.read"]),
        "TOKEN_REVOKED"
      );
      const claimed = gateway.claimTurn(replacement.token, ["workspace.read"]);
      gateway.releaseTurn(replacement.token, claimed.lease);
    } finally {
      cleanup(root);
    }
  });

  it("fails closed when the registered checkout becomes stale", () => {
    const parent = makeTmpDir("gateway-stale");
    const root = path.join(parent, "workspace");
    const retired = path.join(parent, "retired");
    fs.mkdirSync(root);
    try {
      write(root, "marker.txt", "old\n");
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const contextId = gateway.issueTurn(binding(registration, "stale"));

      fs.renameSync(root, retired);
      expect(() => gateway.claimTurn(contextId.token, ["workspace.read"])).toThrow(WorkspaceRegistryError);
      expect(gateway.stats().activeTurnCount).toBe(0);
    } finally {
      cleanup(parent);
    }
  });

  it("unregisters an exact workspace and retires its context", () => {
    const parent = makeTmpDir("gateway-unregister");
    const rootA = path.join(parent, "workspace-a");
    const rootB = path.join(parent, "workspace-b");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    try {
      const broker = new TurnCapabilityBroker();
      const gateway = new MachineGateway({ broker });
      const registrationA = gateway.registerWorkspace(rootA);
      const contextA = gateway.issueTurn(binding(registrationA, "unregistered"));

      expect(
        gateway.unregisterWorkspace(
          registrationA.workspaceId,
          registrationA.projectId,
          registrationA.registrationId
        )
      ).toBe(true);
      expect(gateway.stats().workspaceCount).toBe(0);
      expect(broker.status(contextA.token).status).toBe("revoked");
      const registrationB = gateway.registerWorkspace(rootB);
      expect(registrationB.workspaceId).not.toBe(registrationA.workspaceId);
      const contextB = gateway.issueTurn(binding(registrationB, "replacement"));
      expectCode(() => gateway.claimTurn(contextA.token, ["workspace.read"]), "TOKEN_REVOKED");
      const claimedB = gateway.claimTurn(contextB.token, ["workspace.read"]);
      gateway.releaseTurn(contextB.token, claimedB.lease);
      gateway.revokeTurn(contextB.token);
      expect(gateway.stats().activeTurnCount).toBe(0);
    } finally {
      cleanup(parent);
    }
  });

  it("keeps machine surface ownership until the last linked checkout unregisters", () => {
    const stateDir = isolateStateDir();
    const parent = makeTmpDir("gateway-linked-worktrees");
    const repository = path.join(parent, "repository");
    const worktreeA = path.join(parent, "worktree-a");
    const worktreeB = path.join(parent, "worktree-b");
    fs.mkdirSync(repository);
    makeGitRepo(repository);
    try {
      git(repository, "worktree", "add", worktreeA, "-b", "linked-a");
      git(repository, "worktree", "add", worktreeB, "-b", "linked-b");
      const gateway = new MachineGateway();
      const registrationA = gateway.registerWorkspace(worktreeA);
      const registrationB = gateway.registerWorkspace(worktreeB);
      expect(registrationA.projectId).toBe(registrationB.projectId);
      const lease = claimSurface({
        projectId: registrationA.projectId,
        localSessionId: "session-linked",
        browserId: "iab",
        surfaceId: "chatgpt",
        tabId: "tab-linked",
        projectUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
        chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-linked",
        ownerProcessEpoch: "owner-linked-worktree",
      });

      expect(gateway.unregisterWorkspace(
        registrationB.workspaceId,
        registrationB.projectId,
        registrationB.registrationId,
      )).toBe(true);
      expect(currentSurfaceLease(registrationA.projectId, "session-linked")).toMatchObject({
        tabId: lease.tabId,
        generation: lease.generation,
      });

      expect(gateway.unregisterWorkspace(
        registrationA.workspaceId,
        registrationA.projectId,
        registrationA.registrationId,
      )).toBe(true);
      expect(currentSurfaceLease(registrationA.projectId, "session-linked")).toBeNull();
    } finally {
      cleanup(parent);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("keeps another linked checkout authoritative across a gateway restart", () => {
    const stateDir = isolateStateDir();
    const parent = makeTmpDir("gateway-linked-worktrees-restart");
    const repository = path.join(parent, "repository");
    const worktreeA = path.join(parent, "worktree-a");
    const worktreeB = path.join(parent, "worktree-b");
    fs.mkdirSync(repository);
    makeGitRepo(repository);
    try {
      git(repository, "worktree", "add", worktreeA, "-b", "restart-linked-a");
      git(repository, "worktree", "add", worktreeB, "-b", "restart-linked-b");
      const membershipFile = machineWorkspaceMembershipFile();
      const beforeRestart = new MachineGateway({ workspaceMembershipFile: membershipFile });
      const beforeA = beforeRestart.registerWorkspace(worktreeA);
      const beforeB = beforeRestart.registerWorkspace(worktreeB);
      expect(beforeA.projectId).toBe(beforeB.projectId);
      const lease = claimSurface({
        projectId: beforeA.projectId,
        localSessionId: "session-linked-restart",
        browserId: "iab",
        surfaceId: "chatgpt",
        tabId: "tab-linked-restart",
        projectUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
        chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-linked-restart",
        ownerProcessEpoch: "owner-linked-worktree-restart",
      });

      const afterRestart = new MachineGateway({ workspaceMembershipFile: membershipFile });
      const afterA = afterRestart.registerWorkspace(worktreeA);
      expect(afterA.registrationId).not.toBe(beforeA.registrationId);
      expect(afterRestart.unregisterWorkspace(
        afterA.workspaceId,
        afterA.projectId,
        afterA.registrationId,
      )).toBe(true);
      expect(currentSurfaceLease(afterA.projectId, "session-linked-restart")).toMatchObject({
        tabId: lease.tabId,
        generation: lease.generation,
      });

      const afterB = afterRestart.registerWorkspace(worktreeB);
      expect(afterB.registrationId).not.toBe(beforeB.registrationId);
      expect(afterRestart.unregisterWorkspace(
        afterB.workspaceId,
        afterB.projectId,
        afterB.registrationId,
      )).toBe(true);
      expect(currentSurfaceLease(afterB.projectId, "session-linked-restart")).toBeNull();
    } finally {
      cleanup(parent);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("moves the only Git checkout without clearing its stable Project ownership", () => {
    const stateDir = isolateStateDir();
    const parent = makeTmpDir("gateway-checkout-move");
    const original = path.join(parent, "original");
    const moved = path.join(parent, "moved");
    fs.mkdirSync(original);
    makeGitRepo(original);
    try {
      const gateway = new MachineGateway({
        workspaceMembershipFile: machineWorkspaceMembershipFile(),
      });
      const before = gateway.registerWorkspace(original);
      const localSessionId = "session-checkout-move";
      const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
      const chatUrl = `${projectUrl.replace("/project", "")}/c/chat-checkout-move`;
      const lease = claimSurface({
        projectId: before.projectId,
        localSessionId,
        browserId: "iab",
        surfaceId: "chatgpt",
        tabId: "tab-checkout-move",
        projectUrl,
        chatUrl,
        ownerProcessEpoch: "owner-checkout-move",
      });
      commitVerifiedSurfaceRoute({
        lease,
        workspaceId: before.workspaceId,
        chatUrl,
        connectorName: "Codex with ChatGPT",
      });

      fs.renameSync(original, moved);
      const after = gateway.registerWorkspace(moved);
      expect(after.projectId).toBe(before.projectId);
      expect(after.workspaceId).not.toBe(before.workspaceId);
      expect(currentProjectUrl(after.projectId)).toBe(projectUrl);
      expect(currentSurfaceLease(after.projectId, localSessionId)).toMatchObject({
        tabId: lease.tabId,
        generation: lease.generation,
      });
    } finally {
      cleanup(parent);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("drains a live lease after unregister before another turn becomes active", () => {
    const parent = makeTmpDir("gateway-unregister-drain");
    const rootA = path.join(parent, "workspace-a");
    const rootB = path.join(parent, "workspace-b");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    try {
      const broker = new TurnCapabilityBroker();
      const gateway = new MachineGateway({ broker });
      const registrationA = gateway.registerWorkspace(rootA);
      const contextA = gateway.issueTurn(binding(registrationA, "draining"));
      const claimedA = gateway.claimTurn(contextA.token, ["workspace.read"]);

      expect(
        gateway.unregisterWorkspace(
          registrationA.workspaceId,
          registrationA.projectId,
          registrationA.registrationId
        )
      ).toBe(true);
      expect(broker.status(contextA.token)).toMatchObject({
        status: "revoked",
        activeLeaseCount: 1,
      });

      const registrationB = gateway.registerWorkspace(rootB);
      const contextB = gateway.issueTurn(binding(registrationB, "waiting"));
      const claimedB = gateway.claimTurn(contextB.token, ["workspace.read"]);
      expect(gateway.releaseTurn(contextA.token, claimedA.lease)).toEqual({ released: true });
      gateway.releaseTurn(contextB.token, claimedB.lease);
    } finally {
      cleanup(parent);
    }
  });

  it("waits for release before completing a turn", () => {
    const root = makeTmpDir("gateway-completion");
    try {
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const contextId = gateway.issueTurn(binding(registration, "complete"));
      const claimed = gateway.claimTurn(contextId.token, ["workspace.read"]);
      const fence = gateway.beginCompletion(contextId.token);

      expect(fence.ready).toBe(false);
      expectCode(() => gateway.completeTurn(fence), "ACTIVE_LEASES_REMAIN");
      expect(gateway.releaseTurn(contextId.token, claimed.lease)).toEqual({ released: true });
      expect(gateway.completeTurn(fence)).toMatchObject({ status: "completed" });
      expectCode(() => gateway.claimTurn(contextId.token, ["workspace.read"]), "TOKEN_COMPLETED");
    } finally {
      cleanup(root);
    }
  });

  it("rejects a completion fence from another context before publishing a result", () => {
    const rootA = makeTmpDir("gateway-fence-context-a");
    const rootB = makeTmpDir("gateway-fence-context-b");
    try {
      const gateway = new MachineGateway();
      const registrationA = gateway.registerWorkspace(rootA);
      const registrationB = gateway.registerWorkspace(rootB);
      const identityA = {
        workspaceId: registrationA.workspaceId,
        projectId: registrationA.projectId,
        registrationId: registrationA.registrationId,
        localSessionId: "session-fence-a",
      };
      const identityB = {
        workspaceId: registrationB.workspaceId,
        projectId: registrationB.projectId,
        registrationId: registrationB.registrationId,
        localSessionId: "session-fence-b",
      };
      const requestA = gateway.openControlResultRequest(identityA, {
        taskId: "task-fence-a",
        iteration: 0,
        phase: "PLAN",
      });
      const requestB = gateway.openControlResultRequest(identityB, {
        taskId: "task-fence-b",
        iteration: 0,
        phase: "PLAN",
      });
      const grantA = gateway.issueTurn(binding(registrationA, "fence-a", {
        ...identityA,
        taskId: "task-fence-a",
        iteration: 0,
        phase: "PLAN",
        requestId: requestA.request.requestId,
        scopes: ["c2c.result.write"],
      }));
      const grantB = gateway.issueTurn(binding(registrationB, "fence-b", {
        ...identityB,
        taskId: "task-fence-b",
        iteration: 0,
        phase: "PLAN",
        requestId: requestB.request.requestId,
        scopes: ["c2c.result.write"],
      }));
      const leaseA = gateway.claimTurn(grantA.token, ["c2c.result.write"]);
      const leaseB = gateway.claimTurn(grantB.token, ["c2c.result.write"]);
      const fenceA = gateway.beginCompletion(grantA.token);
      const fenceB = gateway.beginCompletion(grantB.token);
      gateway.releaseTurn(grantA.token, leaseA.lease);
      gateway.releaseTurn(grantB.token, leaseB.lease);

      const resultB = {
        requestId: requestB.request.requestId,
        localSessionId: identityB.localSessionId,
        taskId: "task-fence-b",
        iteration: 0,
        phase: "PLAN",
        kind: "PLAN",
        payload: {
          goal: "fence ownership",
          rationale: "a context must own its completion fence",
          actions: [{ change: "validate the fence owner", why: "prevent cross-context completion" }],
          tests: ["cross-context fence"],
          successCriteria: ["the foreign fence is rejected"],
        },
      };
      expect(() => gateway.completeControlResult(grantB.token, fenceA, resultB)).toThrowError(
        expect.objectContaining<Partial<TurnCapabilityError>>({ code: "COMPLETION_FENCE_INVALID" }),
      );
      expect(gateway.turnStatus(grantA.token).status).toBe("completing");
      expect(gateway.turnStatus(grantB.token).status).toBe("completing");
      expect(gateway.getControlResultStatus(identityB, requestB.request.requestId, {
        taskId: "task-fence-b",
        iteration: 0,
        phase: "PLAN",
      }).status).toBe("pending");

      const resultA = {
        requestId: requestA.request.requestId,
        localSessionId: identityA.localSessionId,
        taskId: "task-fence-a",
        iteration: 0,
        phase: "PLAN",
        kind: "PLAN",
        payload: {
          goal: "fence ownership",
          rationale: "the matching context owns the fence",
          actions: [{ change: "complete the matching turn", why: "publish one exact result" }],
          tests: ["matching fence"],
          successCriteria: ["the result is accepted"],
        },
      };
      expect(gateway.completeControlResult(grantA.token, fenceA, resultA).accepted).toBe(true);
      expect(gateway.completeControlResult(grantB.token, fenceB, resultB).accepted).toBe(true);
    } finally {
      cleanup(rootA);
      cleanup(rootB);
    }
  });

  it("does not serialize raw gateway secrets", () => {
    const root = makeTmpDir("gateway-redaction");
    try {
      const gateway = new MachineGateway();
      const registration = gateway.registerWorkspace(root);
      const contextId = gateway.issueTurn(binding(registration, "redact"));
      const claimed = gateway.claimTurn(contextId.token, ["workspace.read"]);
      const fence = gateway.beginCompletion(contextId.token);
      const serialized = JSON.stringify(gateway);

      expect(serialized).not.toContain(contextId.token);
      expect(serialized).not.toContain(claimed.lease.leaseId);
      expect(serialized).not.toContain(fence.fence);
      gateway.releaseTurn(contextId.token, claimed.lease);
      gateway.completeTurn(fence);
    } finally {
      cleanup(root);
    }
  });

  it("keeps final surface validation and mailbox publication atomic per session", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("gateway-mailbox-transaction");
    let gateway!: MachineGateway;
    let sameSessionRotation: TurnCapabilityError | null = null;
    let otherSessionRotation: unknown = null;
    let checked = false;
    try {
      gateway = new MachineGateway({
        surfaceValidator: (current) => {
          if (!checked || current.localSessionId !== "session-a") return;
          try {
            gateway.surfaceClaim({ ...registered, localSessionId: "session-a" }, {
              browserId: "iab",
              surfaceId: "chatgpt",
              tabId: "tab-a-rotated",
              projectUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
              chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/a-rotated",
              ownerProcessEpoch: "owner-a-rotated",
            });
          } catch (error) {
            sameSessionRotation = error as TurnCapabilityError;
          }
          try {
            gateway.surfaceClaim({ ...registered, localSessionId: "session-b" }, {
              browserId: "iab",
              surfaceId: "chatgpt",
              tabId: "tab-b",
              projectUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project",
              projectSelection: projectSelection("https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project"),
              chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/b",
              ownerProcessEpoch: "owner-b-session",
            });
          } catch (error) {
            otherSessionRotation = error;
          }
        },
      });
      const registered = gateway.registerWorkspace(root);
      const identity = {
        workspaceId: registered.workspaceId,
        projectId: registered.projectId,
        registrationId: registered.registrationId,
        localSessionId: "session-a",
      };
      const otherIdentity = { ...identity, localSessionId: "session-b" };
      const request = openControlResultRequest(registered.workspaceId, {
        localSessionId: identity.localSessionId,
        taskId: "c2c_mailbox_atomic",
        iteration: 0,
        phase: "PLAN",
      });
      const grant = gateway.issueTurn({
        ...registered,
        ...identity,
        taskId: "c2c_mailbox_atomic",
        iteration: 0,
        phase: "PLAN",
        requestId: request.requestId,
        scopes: ["c2c.result.write"],
        compactionEpoch: 0,
        generation: 1,
      });
      const lease = gateway.claimTurn(grant.token, ["c2c.result.write"]);
      const fence = gateway.beginCompletion(grant.token);
      gateway.releaseTurn(grant.token, lease.lease);
      checked = true;
      const receipt = gateway.completeControlResult(grant.token, fence, {
        requestId: request.requestId,
        localSessionId: identity.localSessionId,
        taskId: "c2c_mailbox_atomic",
        iteration: 0,
        phase: "PLAN",
        kind: "PLAN",
        payload: {
          goal: "atomic mailbox publication",
          rationale: "surface generation and result publication share one gateway section",
          actions: [{ change: "publish through the gateway", why: "prevent rotation races" }],
          tests: ["transaction race"],
          successCriteria: ["only the current surface can complete"],
        },
      });
      expect(receipt.accepted).toBe(true);
      expect(sameSessionRotation?.code).toBe("COMPLETION_ALREADY_STARTED");
      expect(otherSessionRotation).toBeNull();
      expect(currentSurfaceLease(identity.projectId, otherIdentity.localSessionId)).toMatchObject({
        tabId: "tab-b",
      });
    } finally {
      cleanup(root);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });
});
