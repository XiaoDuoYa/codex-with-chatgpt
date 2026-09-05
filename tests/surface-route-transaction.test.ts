import path from "node:path";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const surfaceWriteFault = vi.hoisted(() => ({ enabled: false }));
const routeWriteFault = vi.hoisted(() => ({ enabled: false }));

vi.mock("../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/paths.js")>();
  return {
    ...actual,
    writeSecureJson(file: string, data: unknown): void {
      if (
        surfaceWriteFault.enabled &&
        file.includes(`${path.sep}surface-ownership${path.sep}`)
      ) {
        throw new Error("injected surface state write failure");
      }
      if (routeWriteFault.enabled && file.includes(`${path.sep}sessions${path.sep}`)) {
        throw new Error("injected session route write failure");
      }
      actual.writeSecureJson(file, data);
    },
  };
});

import { MachineGateway } from "../src/gateway/machine-gateway.js";
import { readSession, threadSessionFile, updateSession } from "../src/session/state.js";
import {
  claimSurface,
  commitVerifiedSurfaceRoute,
  currentSurfaceBinding,
  currentProjectUrl,
} from "../src/session/surface-ownership.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection } from "./helpers.js";

const PROJECT_URL = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const CHAT_URL = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-retry";

describe("coordinated surface route commit", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    surfaceWriteFault.enabled = false;
    routeWriteFault.enabled = false;
    while (cleanups.length > 0) cleanup(cleanups.pop()!);
    delete process.env.C2C_STATE_DIR;
  });

  it("fails closed after a surface write error and recovers by replaying the same lease", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("surface-route-transaction");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const localSessionId = "session-route-retry";
    const lease = claimSurface({
      projectId: registration.projectId,
      localSessionId,
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-route-retry",
      projectUrl: PROJECT_URL,
      ownerProcessEpoch: "owner-route-retry",
      leaseTtlMs: 60_000,
    });

    surfaceWriteFault.enabled = true;
    expect(() => commitVerifiedSurfaceRoute({
      lease,
      workspaceId: registration.workspaceId,
      chatUrl: CHAT_URL,
      connectorName: "Codex with ChatGPT",
    })).toThrow(/injected surface state write failure/);
    surfaceWriteFault.enabled = false;
    expect(currentSurfaceBinding(registration.projectId, localSessionId)).toMatchObject({
      tabId: lease.tabId,
      lastGeneration: lease.generation,
      chatUrl: CHAT_URL,
    });
    expect(readSession(registration.workspaceId, localSessionId)).toMatchObject({
      url: CHAT_URL,
      surfaceGeneration: lease.generation,
      surfaceTabId: lease.tabId,
    });
  });

  it("repairs a route when machine commit succeeds before the route write fails", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("surface-route-reconcile");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const localSessionId = "session-route-reconcile";
    const lease = claimSurface({
      projectId: registration.projectId,
      localSessionId,
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-route-reconcile",
      projectUrl: PROJECT_URL,
      projectSelection: projectSelection(PROJECT_URL),
      workspaceName: registration.workspaceName,
      ownerProcessEpoch: "owner-route-reconcile",
      leaseTtlMs: 60_000,
    });

    routeWriteFault.enabled = true;
    expect(() => gateway.surfaceCommit(
      {
        workspaceId: registration.workspaceId,
        projectId: registration.projectId,
        registrationId: registration.registrationId,
        localSessionId,
      },
      lease,
      { chatUrl: CHAT_URL, connectorName: "Codex with ChatGPT" },
    )).toThrow(/injected session route write failure/);
    routeWriteFault.enabled = false;

    expect(readSession(registration.workspaceId, localSessionId)?.url).toBeUndefined();
    const recovered = gateway.surfaceGet({
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      registrationId: registration.registrationId,
      localSessionId,
    });
    expect(recovered.binding).toMatchObject({
      tabId: lease.tabId,
      lastGeneration: lease.generation,
      chatUrl: CHAT_URL,
    });
    expect(readSession(registration.workspaceId, localSessionId)).toMatchObject({
      url: CHAT_URL,
      surfaceGeneration: lease.generation,
      surfaceTabId: lease.tabId,
    });
  });

  it("clears a stale route after machine retirement when route removal fails", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("surface-retire-reconcile");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const localSessionId = "session-retire-reconcile";
    const identity = {
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      registrationId: registration.registrationId,
      localSessionId,
    };
    const lease = claimSurface({
      projectId: registration.projectId,
      localSessionId,
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-retire-reconcile",
      projectUrl: PROJECT_URL,
      projectSelection: projectSelection(PROJECT_URL),
      workspaceName: registration.workspaceName,
      chatUrl: CHAT_URL,
      ownerProcessEpoch: "owner-retire-reconcile",
      leaseTtlMs: 60_000,
    });
    gateway.surfaceCommit(identity, lease, { connectorName: "Codex with ChatGPT" });
    updateSession(registration.workspaceId, localSessionId, {
      taskId: "task-retire-reconcile",
      iteration: 1,
      lastState: "EXECUTING",
      checkpoint: {
        protocolState: "EXECUTING",
        waitingFor: "none",
      },
    });

    const originalRemove = fs.rmSync.bind(fs);
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(((...args: any[]) => {
      const target = args[0];
      if (target === threadSessionFile(registration.workspaceId, localSessionId)) {
        throw new Error("injected session route retire failure");
      }
      return originalRemove(...args);
    }) as typeof fs.rmSync);
    expect(() => gateway.surfaceRetire(identity)).toThrow(/injected session route retire failure/);
    removeSpy.mockRestore();

    expect(gateway.surfaceGet(identity).binding).toBeNull();
    expect(readSession(registration.workspaceId, localSessionId)).toMatchObject({
      projectUrl: PROJECT_URL,
      taskId: "task-retire-reconcile",
      iteration: 1,
      lastState: "EXECUTING",
      url: undefined,
      title: undefined,
      surfaceGeneration: undefined,
      surfaceTabId: undefined,
      checkpoint: {
        protocolState: "EXECUTING",
        waitingFor: "none",
        chatUrl: undefined,
        projectUrl: PROJECT_URL,
      },
    });
  });

  it("does not revive a checkout route after its Project is unregistered", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("surface-project-unregister");
    cleanups.push(root);
    const gateway = new MachineGateway();
    const registered = gateway.registerWorkspace(root);
    const localSessionId = "session-project-unregister";
    const identity = {
      workspaceId: registered.workspaceId,
      projectId: registered.projectId,
      registrationId: registered.registrationId,
      localSessionId,
    };
    const lease = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-project-unregister",
      projectUrl: PROJECT_URL,
      projectSelection: projectSelection(PROJECT_URL),
      chatUrl: CHAT_URL,
      ownerProcessEpoch: "owner-project-unregister",
      leaseTtlMs: 60_000,
    });
    gateway.surfaceCommit(identity, lease, { connectorName: "Codex with ChatGPT" });
    updateSession(registered.workspaceId, localSessionId, {
      taskId: "task-project-unregister",
      iteration: 1,
      lastState: "EXECUTING",
      checkpoint: {
        protocolState: "EXECUTING",
        waitingFor: "none",
      },
    });

    expect(gateway.unregisterWorkspace(
      registered.workspaceId,
      registered.projectId,
      registered.registrationId,
    )).toBe(true);
    expect(currentProjectUrl(registered.projectId)).toBeNull();

    const replacement = gateway.registerWorkspace(root);
    const reconciled = gateway.surfaceGet({
      workspaceId: replacement.workspaceId,
      projectId: replacement.projectId,
      registrationId: replacement.registrationId,
      localSessionId,
    });
    expect(reconciled.projectUrl).toBeNull();
    expect(reconciled.binding).toBeNull();
    expect(readSession(replacement.workspaceId, localSessionId)).toMatchObject({
      taskId: "task-project-unregister",
      url: undefined,
      projectUrl: undefined,
      surfaceGeneration: undefined,
      surfaceTabId: undefined,
      checkpoint: {
        chatUrl: undefined,
        projectUrl: undefined,
      },
    });
  });
});
