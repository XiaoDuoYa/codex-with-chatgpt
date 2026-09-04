import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  machineWorkspaceMembershipFile,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  type WorkspaceRegistration,
} from "../src/gateway/workspace-registry.js";
import {
  TurnCapabilityBroker,
  TurnCapabilityError,
  type TurnCapabilityBinding,
  type TurnLease,
} from "../src/gateway/turn-capability.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

function expectRegistryCode(action: () => unknown, code: WorkspaceRegistryError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceRegistryError);
    expect((error as WorkspaceRegistryError).code).toBe(code);
  }
}

function expectCapabilityCode(action: () => unknown, code: TurnCapabilityError["code"]): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TurnCapabilityError);
    expect((error as TurnCapabilityError).code).toBe(code);
  }
}

function binding(
  registration: WorkspaceRegistration,
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
    scopes: ["workspace.read"],
    compactionEpoch: 0,
    generation: 1,
    ...overrides,
  };
}

function claim(broker: TurnCapabilityBroker, turn: TurnCapabilityBinding): {
  token: string;
  lease: TurnLease;
} {
  const grant = broker.issue(turn);
  return { token: grant.token, lease: broker.claim(grant.token, turn) };
}

describe("workspace registry", () => {
  it("routes two independent workspaces without crossing their markers", async () => {
    const rootA = makeTmpDir("registry-a");
    const rootB = makeTmpDir("registry-b");
    try {
      write(rootA, "marker.txt", "workspace-a\n");
      write(rootB, "marker.txt", "workspace-b\n");
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const registrationA = registry.register(rootA);
      const registrationB = registry.register(rootB);
      const turnA = binding(registrationA, "task-a");
      const turnB = binding(registrationB, "task-b");
      const claimedA = claim(broker, turnA);
      const claimedB = claim(broker, turnB);

      const resolvedA = registry.resolve(claimedA.lease);
      const resolvedB = registry.resolve(claimedB.lease);
      expect((await resolvedA.readFile("marker.txt")).content).toBe("workspace-a");
      expect((await resolvedB.readFile("marker.txt")).content).toBe("workspace-b");
      expect(resolvedA.root).not.toBe(resolvedB.root);

      broker.release(claimedA.token, claimedA.lease.leaseId);
      broker.release(claimedB.token, claimedB.lease.leaseId);
    } finally {
      cleanup(rootA);
      cleanup(rootB);
    }
  });

  it("keeps case-distinct roots isolated when the filesystem supports them", async () => {
    const parent = makeTmpDir("registry-case-sensitive");
    const upperRoot = path.join(parent, "Workspace");
    const lowerRoot = path.join(parent, "workspace");
    try {
      fs.mkdirSync(upperRoot);
      try {
        fs.mkdirSync(lowerRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        throw error;
      }
      const upperStat = fs.statSync(upperRoot, { bigint: true });
      const lowerStat = fs.statSync(lowerRoot, { bigint: true });
      if (upperStat.dev === lowerStat.dev && upperStat.ino === lowerStat.ino) return;

      write(upperRoot, "marker.txt", "upper\n");
      write(lowerRoot, "marker.txt", "lower\n");
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const upper = registry.register(upperRoot);
      const lower = registry.register(lowerRoot);
      expect(upper.workspaceId).not.toBe(lower.workspaceId);
      expect(upper.projectId).not.toBe(lower.projectId);
      expect(() => upper.workspace.resolve("../workspace/marker.txt")).toThrow(/outside/i);

      const upperClaim = claim(broker, binding(upper, "upper"));
      const lowerClaim = claim(broker, binding(lower, "lower"));
      expect((await registry.resolve(upperClaim.lease).readFile("marker.txt")).content).toBe("upper");
      expect((await registry.resolve(lowerClaim.lease).readFile("marker.txt")).content).toBe("lower");
      broker.release(upperClaim.token, upperClaim.lease.leaseId);
      broker.release(lowerClaim.token, lowerClaim.lease.leaseId);
    } finally {
      cleanup(parent);
    }
  });

  it("is idempotent for the same canonical checkout", () => {
    const root = makeTmpDir("registry-idempotent");
    try {
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const first = registry.register(root);
      const second = registry.register(root);
      expect(second).toBe(first);
      expect(Object.isFrozen(first.workspace)).toBe(true);
      expect(registry.size).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("fails closed when the persistent checkout membership is malformed", () => {
    const stateDir = isolateStateDir();
    try {
      const file = machineWorkspaceMembershipFile();
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checkouts: "invalid" }));
      expectRegistryCode(
        () => new WorkspaceRegistry(new TurnCapabilityBroker(), undefined, file),
        "INVALID_MEMBERSHIP_STATE",
      );
    } finally {
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("rejects persistent membership whose workspace id does not match its root", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("registry-membership-id");
    try {
      const registration = new WorkspaceRegistry(new TurnCapabilityBroker()).register(root);
      const stat = fs.statSync(root, { bigint: true });
      const file = machineWorkspaceMembershipFile();
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        checkouts: [{
          workspaceId: registration.workspaceId === "000000000000" ? "111111111111" : "000000000000",
          projectId: registration.projectId,
          root,
          projectMetadataFile: null,
          fingerprint: {
            device: stat.dev.toString(),
            inode: stat.ino.toString(),
            birthtimeNs: stat.birthtimeNs.toString(),
          },
        }],
      }));
      expectRegistryCode(
        () => new WorkspaceRegistry(new TurnCapabilityBroker(), undefined, file),
        "INVALID_MEMBERSHIP_STATE",
      );
    } finally {
      cleanup(root);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("looks up the exact frozen registration and rejects mismatched identities", () => {
    const root = makeTmpDir("registry-lookup");
    try {
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const registration = registry.register(root);
      const lookedUp = registry.lookup(
        registration.workspaceId,
        registration.projectId,
        registration.registrationId
      );

      expect(lookedUp).toBe(registration);
      expect(Object.isFrozen(lookedUp)).toBe(true);
      expect(Object.isFrozen(lookedUp.workspace)).toBe(true);
      expectRegistryCode(
        () => registry.lookup(registration.workspaceId, "wrong-project", registration.registrationId),
        "PROJECT_ID_MISMATCH"
      );
      expectRegistryCode(
        () => registry.lookup(registration.workspaceId, registration.projectId, "wrong-registration"),
        "REGISTRATION_ID_MISMATCH"
      );
      expectRegistryCode(
        () => registry.lookup(root, registration.projectId, registration.registrationId),
        "INVALID_WORKSPACE_ID"
      );
    } finally {
      cleanup(root);
    }
  });

  it("keeps project identity across repeated Git checkout moves and retires stale roots", () => {
    const parent = makeTmpDir("registry-move");
    const original = path.join(parent, "original");
    const moved = path.join(parent, "moved");
    const movedAgain = path.join(parent, "moved-again");
    fs.mkdirSync(original, { recursive: true });
    try {
      makeGitRepo(original);
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const before = registry.register(original);
      const oldTurn = binding(before, "before-move");
      const oldClaim = claim(broker, oldTurn);

      fs.renameSync(original, moved);
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "WORKSPACE_STALE");
      expect(registry.size).toBe(0);
      broker.release(oldClaim.token, oldClaim.lease.leaseId);

      const after = registry.register(moved);
      expect(after.projectId).toBe(before.projectId);
      expect(after.workspaceId).not.toBe(before.workspaceId);
      expect(after.registrationId).not.toBe(before.registrationId);
      expect(registry.size).toBe(1);

      fs.renameSync(moved, movedAgain);
      const final = registry.register(movedAgain);
      expect(final.projectId).toBe(before.projectId);
      expect(final.workspaceId).not.toBe(after.workspaceId);
      expect(registry.size).toBe(1);
    } finally {
      cleanup(parent);
    }
  });

  it("rejects forged leases and every mismatched registered identity", () => {
    const root = makeTmpDir("registry-reject");
    try {
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const registration = registry.register(root);
      const validTurn = binding(registration, "valid");
      const valid = claim(broker, validTurn);

      expectCapabilityCode(
        () => registry.resolve({ binding: validTurn } as never),
        "LEASE_NOT_FOUND"
      );
      expectCapabilityCode(
        () => registry.resolve({ ...valid.lease, binding: binding(registration, "forged") }),
        "LEASE_NOT_FOUND"
      );

      const wrongProjectTurn = binding(registration, "wrong-project", {
        projectId: "git-00000000000000000000000000000000",
      });
      const wrongProject = claim(broker, wrongProjectTurn);
      expectRegistryCode(() => registry.resolve(wrongProject.lease), "PROJECT_ID_MISMATCH");

      const wrongRegistrationTurn = binding(registration, "wrong-registration", {
        registrationId: "registration-wrong",
      });
      const wrongRegistration = claim(broker, wrongRegistrationTurn);
      expectRegistryCode(
        () => registry.resolve(wrongRegistration.lease),
        "REGISTRATION_ID_MISMATCH"
      );

      broker.release(valid.token, valid.lease.leaseId);
      broker.release(wrongProject.token, wrongProject.lease.leaseId);
      broker.release(wrongRegistration.token, wrongRegistration.lease.leaseId);
    } finally {
      cleanup(root);
    }
  });

  it("rejects a replaced root and prevents an old lease from entering its new incarnation", async () => {
    const parent = makeTmpDir("registry-replacement");
    const root = path.join(parent, "workspace");
    const retired = path.join(parent, "retired");
    fs.mkdirSync(root, { recursive: true });
    write(root, "marker.txt", "old\n");
    try {
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const before = registry.register(root);
      const oldTurn = binding(before, "old-incarnation");
      const oldClaim = claim(broker, oldTurn);

      fs.renameSync(root, retired);
      fs.mkdirSync(root, { recursive: true });
      write(root, "marker.txt", "new\n");
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "WORKSPACE_STALE");

      const after = registry.register(root);
      expectRegistryCode(
        () => registry.lookup(before.workspaceId, before.projectId, before.registrationId),
        "REGISTRATION_ID_MISMATCH"
      );
      expect(after.workspaceId).toBe(before.workspaceId);
      expect(after.projectId).toBe(before.projectId);
      expect(after.registrationId).not.toBe(before.registrationId);
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "REGISTRATION_ID_MISMATCH");

      const newTurn = binding(after, "new-incarnation");
      const newClaim = claim(broker, newTurn);
      expect((await registry.resolve(newClaim.lease).readFile("marker.txt")).content).toBe("new");

      broker.release(oldClaim.token, oldClaim.lease.leaseId);
      broker.release(newClaim.token, newClaim.lease.leaseId);
    } finally {
      cleanup(parent);
    }
  });

  it("rejects an old lease after a Git root is rebuilt at the same path", () => {
    const parent = makeTmpDir("registry-git-replacement");
    const root = path.join(parent, "workspace");
    const retired = path.join(parent, "retired");
    fs.mkdirSync(root, { recursive: true });
    try {
      makeGitRepo(root);
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const before = registry.register(root);
      const oldClaim = claim(broker, binding(before, "old-git-root"));

      fs.renameSync(root, retired);
      fs.mkdirSync(root, { recursive: true });
      makeGitRepo(root);
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "WORKSPACE_STALE");

      const after = registry.register(root);
      expect(after.workspaceId).toBe(before.workspaceId);
      expect(after.projectId).not.toBe(before.projectId);
      expect(after.registrationId).not.toBe(before.registrationId);
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "PROJECT_ID_MISMATCH");
      broker.release(oldClaim.token, oldClaim.lease.leaseId);
    } finally {
      cleanup(parent);
    }
  });

  it("retires a non-Git registration when the checkout becomes Git", () => {
    const root = makeTmpDir("registry-non-git-promoted");
    try {
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const before = registry.register(root);
      const oldClaim = claim(broker, binding(before, "non-git-promoted"));

      makeGitRepo(root);
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "WORKSPACE_STALE");
      expect(registry.size).toBe(0);
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "WORKSPACE_NOT_FOUND");
      broker.release(oldClaim.token, oldClaim.lease.leaseId);
    } finally {
      cleanup(root);
    }
  });

  it("retires a registration when the Git directory is retargeted", () => {
    const parent = makeTmpDir("registry-gitdir-retarget");
    const root = path.join(parent, "checkout");
    const retarget = path.join(parent, "retarget");
    fs.mkdirSync(root);
    try {
      makeGitRepo(root);
      fs.mkdirSync(retarget);
      makeGitRepo(retarget);
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const before = registry.register(root);
      const oldClaim = claim(broker, binding(before, "gitdir-retarget"));
      const originalGitDir = path.join(root, ".git");

      fs.renameSync(originalGitDir, path.join(root, ".git-original"));
      fs.writeFileSync(originalGitDir, `gitdir: ${path.join(retarget, ".git")}\n`);

      expectRegistryCode(() => registry.lookup(
        before.workspaceId,
        before.projectId,
        before.registrationId,
      ), "WORKSPACE_STALE");
      expect(registry.size).toBe(0);
      expectRegistryCode(() => registry.resolve(oldClaim.lease), "WORKSPACE_NOT_FOUND");
      broker.release(oldClaim.token, oldClaim.lease.leaseId);
    } finally {
      cleanup(parent);
    }
  });

  it("does not clean machine authority when membership persistence fails", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("registry-membership-commit-failure");
    const membershipFile = machineWorkspaceMembershipFile();
    try {
      const broker = new TurnCapabilityBroker();
      const removals: string[] = [];
      const registry = new WorkspaceRegistry(broker, (projectId) => {
        removals.push(projectId);
      }, membershipFile);
      const registration = registry.register(root);
      const originalRename = fs.renameSync.bind(fs);
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(((source, target, ...rest) => {
        if (target === membershipFile) throw new Error("injected membership commit failure");
        return originalRename(source, target, ...rest);
      }) as typeof fs.renameSync);

      expect(() => registry.unregister(
        registration.workspaceId,
        registration.projectId,
        registration.registrationId,
      )).toThrow(/injected membership commit failure/);
      renameSpy.mockRestore();

      expect(removals).toEqual([]);
      expect(registry.lookup(
        registration.workspaceId,
        registration.projectId,
        registration.registrationId,
      )).toBe(registration);
      expect(JSON.parse(fs.readFileSync(membershipFile, "utf8")).checkouts).toHaveLength(1);
    } finally {
      cleanup(root);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("replays a committed project cleanup intent after a registry restart", () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("registry-membership-cleanup-replay");
    const membershipFile = machineWorkspaceMembershipFile();
    try {
      const first = new WorkspaceRegistry(new TurnCapabilityBroker(), undefined, membershipFile);
      const registration = first.register(root);
      expect(first.unregister(
        registration.workspaceId,
        registration.projectId,
        registration.registrationId,
      )).toBe(true);
      expect(JSON.parse(fs.readFileSync(membershipFile, "utf8")).pendingProjectRemovals).toEqual([
        registration.projectId,
      ]);

      const removals: string[] = [];
      new WorkspaceRegistry(new TurnCapabilityBroker(), (projectId) => {
        removals.push(projectId);
      }, membershipFile);

      expect(removals).toEqual([registration.projectId]);
      expect(JSON.parse(fs.readFileSync(membershipFile, "utf8")).pendingProjectRemovals).toBeUndefined();
    } finally {
      cleanup(root);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("registers more than five independent workspaces without a capacity gate", () => {
    const parent = makeTmpDir("registry-unbounded");
    try {
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const registrations = Array.from({ length: 8 }, (_, index) => {
        const root = path.join(parent, `workspace-${index}`);
        fs.mkdirSync(root);
        return registry.register(root);
      });

      expect(registry.size).toBe(8);
      expect(new Set(registrations.map((entry) => entry.workspaceId)).size).toBe(8);
    } finally {
      cleanup(parent);
    }
  });

  it("unregisters only the exact checkout incarnation", () => {
    const root = makeTmpDir("registry-unregister");
    try {
      const broker = new TurnCapabilityBroker();
      const registry = new WorkspaceRegistry(broker);
      const registration = registry.register(root);
      const turn = binding(registration, "registered");
      const claimed = claim(broker, turn);

      expectRegistryCode(
        () => registry.unregister(registration.workspaceId, registration.projectId, "wrong-registration"),
        "REGISTRATION_ID_MISMATCH"
      );
      expect(
        registry.unregister(
          registration.workspaceId,
          registration.projectId,
          registration.registrationId
        )
      ).toBe(true);
      expect(
        registry.unregister(
          registration.workspaceId,
          registration.projectId,
          registration.registrationId
        )
      ).toBe(false);
      expectRegistryCode(() => registry.resolve(claimed.lease), "WORKSPACE_NOT_FOUND");
      broker.release(claimed.token, claimed.lease.leaseId);
    } finally {
      cleanup(root);
    }
  });

  it("revokes registration capabilities and invokes cleanup when stale lookup removes the last checkout", () => {
    const parent = makeTmpDir("registry-stale-cleanup");
    const root = path.join(parent, "workspace");
    fs.mkdirSync(root);
    try {
      const broker = new TurnCapabilityBroker();
      const removals: Array<[string, boolean]> = [];
      const registry = new WorkspaceRegistry(broker, (projectId, hasRemaining) => {
        removals.push([projectId, hasRemaining]);
      });
      const registration = registry.register(root);
      const grant = broker.issue(binding(registration, "stale-cleanup"));

      fs.renameSync(root, path.join(parent, "retired"));
      expectRegistryCode(
        () => registry.lookup(registration.workspaceId, registration.projectId, registration.registrationId),
        "WORKSPACE_STALE",
      );
      expect(broker.status(grant.token).status).toBe("revoked");
      expect(removals).toEqual([[registration.projectId, false]]);
    } finally {
      cleanup(parent);
    }
  });

  it("moves a stale checkout transactionally without clearing its stable Project", () => {
    const parent = makeTmpDir("registry-prune-cleanup");
    const original = path.join(parent, "original");
    const moved = path.join(parent, "moved");
    fs.mkdirSync(original);
    try {
      const broker = new TurnCapabilityBroker();
      const removals: Array<[string, boolean]> = [];
      const registry = new WorkspaceRegistry(broker, (projectId, hasRemaining) => {
        removals.push([projectId, hasRemaining]);
      });
      const before = registry.register(original);
      const grant = broker.issue(binding(before, "prune-cleanup"));

      fs.renameSync(original, moved);
      const after = registry.register(moved);
      expect(after.workspaceId).not.toBe(before.workspaceId);
      expect(broker.status(grant.token).status).toBe("revoked");
      expect(removals).toEqual([]);
    } finally {
      cleanup(parent);
    }
  });

  it("does not repeat cleanup when an already unregistered checkout is removed again", () => {
    const root = makeTmpDir("registry-explicit-cleanup");
    try {
      const broker = new TurnCapabilityBroker();
      const removals: Array<[string, boolean]> = [];
      const registry = new WorkspaceRegistry(broker, (projectId, hasRemaining) => {
        removals.push([projectId, hasRemaining]);
      });
      const registration = registry.register(root);
      const grant = broker.issue(binding(registration, "explicit-cleanup"));

      expect(registry.unregister(
        registration.workspaceId,
        registration.projectId,
        registration.registrationId,
      )).toBe(true);
      expect(registry.unregister(
        registration.workspaceId,
        registration.projectId,
        registration.registrationId,
      )).toBe(false);
      expect(broker.status(grant.token).status).toBe("revoked");
      expect(removals).toEqual([[registration.projectId, false]]);
    } finally {
      cleanup(root);
    }
  });
});
