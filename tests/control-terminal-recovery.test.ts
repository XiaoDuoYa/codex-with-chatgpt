import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const observationWriteFault = vi.hoisted(() => ({ failOnce: false }));

vi.mock("../src/config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/paths.js")>();
  return {
    ...actual,
    writeSecureJson(file: string, data: unknown): void {
      if (
        observationWriteFault.failOnce &&
        file.includes(`${path.sep}control-mailbox${path.sep}`) &&
        file.includes(`${path.sep}observations${path.sep}`)
      ) {
        observationWriteFault.failOnce = false;
        throw new Error("injected observation write failure");
      }
      actual.writeSecureJson(file, data);
    },
  };
});

import { getActiveControlResultStatus } from "../src/control/mailbox.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection, receiveBootResult } from "./helpers.js";

const cleanups: string[] = [];
const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

afterEach(() => {
  vi.restoreAllMocks();
  observationWriteFault.failOnce = false;
  while (cleanups.length > 0) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("terminal observation recovery", () => {
  it("revokes authority immediately and repairs cleanup after partial terminal writes", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("terminal-observation-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-terminal-recovery" };
    const chatUrl = projectUrl.replace("/project", "/c/terminal-recovery");
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-terminal-recovery",
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    gateway.surfaceCommit(identity, page, {
      bootRequestId: receiveBootResult(gateway, identity, page),
      connectorName: "Codex with ChatGPT",
    });

    const turn = { taskId: "terminal-recovery", iteration: 0, phase: "REVIEW" as const };
    const { request } = gateway.openControlResultRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["workspace.read", "c2c.result.write"],
      compactionEpoch: 0,
      generation: page.generation,
    });
    const base = {
      tabId: page.tabId,
      generation: page.generation,
      observedUrl: chatUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...base,
      observationSequence: 1,
      state: "send_attempted",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...base,
      observationSequence: 2,
      state: "sent",
    });
    gateway.observeControlPage(identity, request.requestId, turn, {
      ...base,
      observationSequence: 3,
      responseId: "response-terminal-recovery",
      state: "response_created",
    });
    const terminal = {
      ...base,
      observationSequence: 4,
      responseId: "response-terminal-recovery",
      state: "final" as const,
      responseIsFinal: true as const,
      reason: "callback_missing" as const,
      source: "host_observed" as const,
    };

    observationWriteFault.failOnce = true;
    expect(() => gateway.observeControlPage(identity, request.requestId, turn, terminal))
      .toThrow(/injected observation write failure/);
    expect(gateway.turnStatus(grant.token).status).toBe("revoked");
    expect(() => gateway.claimTurn(grant.token, ["workspace.read"])).toThrow(/revoked/i);
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "cancelled", requestId: request.requestId });

    const delayedNow = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    const restartedGateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const restartedIdentity = {
      ...restartedGateway.registerWorkspace(root),
      localSessionId: identity.localSessionId,
    };
    expect(restartedGateway.observeControlPage(restartedIdentity, request.requestId, turn, terminal))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: terminal } });
    delayedNow.mockRestore();
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId)).toBeNull();

    expect(restartedGateway.observeControlPage(restartedIdentity, request.requestId, turn, terminal))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: terminal } });

    const nextTurn = { ...turn, iteration: 1 };
    const { request: nextRequest } = gateway.openControlResultRequest(identity, nextTurn);
    const nextGrant = gateway.issueTurn({
      ...identity,
      ...nextTurn,
      requestId: nextRequest.requestId,
      scopes: ["workspace.read", "c2c.result.write"],
      compactionEpoch: 0,
      generation: page.generation,
    });
    const nextBase = {
      ...base,
      observedAt: new Date().toISOString(),
      responseToRequestId: nextRequest.requestId,
    };
    gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, {
      ...nextBase,
      observationSequence: 1,
      state: "send_attempted",
    });
    gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, {
      ...nextBase,
      observationSequence: 2,
      state: "sent",
    });
    gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, {
      ...nextBase,
      observationSequence: 3,
      responseId: "response-terminal-active-cleanup",
      state: "response_created",
    });
    const nextTerminal = {
      ...nextBase,
      observationSequence: 4,
      responseId: "response-terminal-active-cleanup",
      state: "final" as const,
      responseIsFinal: true as const,
      reason: "callback_missing" as const,
      source: "host_observed" as const,
    };

    const originalRemove = fs.rmSync.bind(fs);
    let failActiveRemoval = true;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(((...args: any[]) => {
      const target = String(args[0]);
      if (
        failActiveRemoval &&
        target.includes(`${path.sep}control-mailbox${path.sep}`) &&
        target.includes(`${path.sep}active${path.sep}`)
      ) {
        failActiveRemoval = false;
        throw new Error("injected active pointer cleanup failure");
      }
      return originalRemove(...args);
    }) as typeof fs.rmSync);
    expect(() => gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, nextTerminal))
      .toThrow(/injected active pointer cleanup failure/);
    removeSpy.mockRestore();

    expect(gateway.turnStatus(nextGrant.token).status).toBe("revoked");
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "cancelled", requestId: nextRequest.requestId });
    expect(gateway.observeControlPage(identity, nextRequest.requestId, nextTurn, nextTerminal))
      .toMatchObject({ status: "cancelled", pageObservation: { latest: nextTerminal } });
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
  });

  it("revokes a cancelled request when active pointer cleanup fails", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("cancel-active-cleanup-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-cancel-cleanup" };
    const chatUrl = projectUrl.replace("/project", "/c/cancel-cleanup");
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-cancel-cleanup",
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    gateway.surfaceCommit(identity, page, {
      bootRequestId: receiveBootResult(gateway, identity, page),
      connectorName: "Codex with ChatGPT",
    });

    const turn = { taskId: "cancel-cleanup", iteration: 0, phase: "PLAN" as const };
    const { request } = gateway.openControlResultRequest(identity, turn);
    const grant = gateway.issueTurn({
      ...identity,
      ...turn,
      requestId: request.requestId,
      scopes: ["workspace.read", "c2c.result.write"],
      compactionEpoch: 0,
      generation: page.generation,
    });

    const originalRemove = fs.rmSync.bind(fs);
    let failActiveRemoval = true;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(((...args: any[]) => {
      const target = String(args[0]);
      if (
        failActiveRemoval &&
        target.includes(`${path.sep}control-mailbox${path.sep}`) &&
        target.includes(`${path.sep}active${path.sep}`)
      ) {
        failActiveRemoval = false;
        throw new Error("injected cancel active pointer cleanup failure");
      }
      return originalRemove(...args);
    }) as typeof fs.rmSync);
    expect(() => gateway.cancelControlResultRequest(identity, request.requestId, turn))
      .toThrow(/injected cancel active pointer cleanup failure/);
    removeSpy.mockRestore();

    expect(gateway.turnStatus(grant.token).status).toBe("revoked");
    expect(() => gateway.claimTurn(grant.token, ["workspace.read"])).toThrow(/revoked/i);
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "cancelled", requestId: request.requestId });
    expect(gateway.cancelControlResultRequest(identity, request.requestId, turn))
      .toMatchObject({ status: "cancelled" });
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
  });

  it("repairs BOOT active cleanup when surface commit is replayed after acknowledgement", () => {
    cleanups.push(isolateStateDir());
    const root = makeTmpDir("boot-ack-cleanup-recovery");
    cleanups.push(root);
    const gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface });
    const identity = { ...gateway.registerWorkspace(root), localSessionId: "session-boot-cleanup" };
    const chatUrl = projectUrl.replace("/project", "/c/boot-cleanup");
    const page = gateway.surfaceClaim(identity, {
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-boot-cleanup",
      projectUrl,
      chatUrl,
      projectSelection: projectSelection(projectUrl),
    });
    const bootRequestId = receiveBootResult(gateway, identity, page);

    const originalRemove = fs.rmSync.bind(fs);
    let failActiveRemoval = true;
    const removeSpy = vi.spyOn(fs, "rmSync").mockImplementation(((...args: any[]) => {
      const target = String(args[0]);
      if (
        failActiveRemoval &&
        target.includes(`${path.sep}control-mailbox${path.sep}`) &&
        target.includes(`${path.sep}active${path.sep}`)
      ) {
        failActiveRemoval = false;
        throw new Error("injected BOOT active pointer cleanup failure");
      }
      return originalRemove(...args);
    }) as typeof fs.rmSync);
    expect(() => gateway.surfaceCommit(identity, page, {
      bootRequestId,
      connectorName: "Codex with ChatGPT",
    })).toThrow(/injected BOOT active pointer cleanup failure/);
    removeSpy.mockRestore();

    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId))
      .toMatchObject({ status: "acknowledged", requestId: bootRequestId });
    expect(gateway.surfaceCommit(identity, page, {
      bootRequestId,
      connectorName: "Codex with ChatGPT",
    })).toMatchObject({ binding: { chatUrl } });
    expect(getActiveControlResultStatus(identity.workspaceId, identity.localSessionId)).toBeNull();
  });
});
