import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MachineGateway } from "../src/gateway/machine-gateway.js";
import {
  TurnCapabilityBroker,
  TurnCapabilityError,
  type TurnCapabilityBinding,
} from "../src/gateway/turn-capability.js";
import { WorkspaceRegistryError } from "../src/gateway/workspace-registry.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

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
  it("routes two registered workspaces through their live leases", async () => {
    const rootA = makeTmpDir("gateway-route-a");
    const rootB = makeTmpDir("gateway-route-b");
    try {
      write(rootA, "marker.txt", "workspace-a\n");
      write(rootB, "marker.txt", "workspace-b\n");
      const gateway = new MachineGateway({
        broker: new TurnCapabilityBroker({ maxActiveTurns: 2 }),
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
        broker: new TurnCapabilityBroker({ maxActiveTurns: 2 }),
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

  it("unregisters an exact workspace, frees capacity, and retires its context", () => {
    const parent = makeTmpDir("gateway-unregister");
    const rootA = path.join(parent, "workspace-a");
    const rootB = path.join(parent, "workspace-b");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    try {
      const broker = new TurnCapabilityBroker({ maxCapabilities: 1 });
      const gateway = new MachineGateway({ broker, maxWorkspaces: 1 });
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
      expectCode(() => gateway.claimTurn(contextA.token, ["workspace.read"]), "TOKEN_NOT_FOUND");
      const claimedB = gateway.claimTurn(contextB.token, ["workspace.read"]);
      gateway.releaseTurn(contextB.token, claimedB.lease);
      gateway.revokeTurn(contextB.token);
      expect(gateway.stats().activeTurnCount).toBe(0);
    } finally {
      cleanup(parent);
    }
  });

  it("drains a live lease after unregister before another turn becomes active", () => {
    const parent = makeTmpDir("gateway-unregister-drain");
    const rootA = path.join(parent, "workspace-a");
    const rootB = path.join(parent, "workspace-b");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    try {
      const broker = new TurnCapabilityBroker({ maxActiveTurns: 1, maxCapabilities: 2 });
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
      expectCode(
        () => gateway.claimTurn(contextB.token, ["workspace.read"]),
        "ACTIVE_TURN_LIMIT"
      );
      expect(gateway.releaseTurn(contextA.token, claimedA.lease)).toEqual({ released: true });
      const claimedB = gateway.claimTurn(contextB.token, ["workspace.read"]);
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
});
