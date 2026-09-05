import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  acknowledgeControlResult, getActiveControlResultStatus, getControlResultStatus, getControlMailboxDir,
  pruneControlMailbox,
  openControlResultRequest, recordControlHostFailure, reportControlProgress,
  submitControlResult, waitForControlResult,
} from "../src/control/mailbox.js";
import {
  CONTROL_PAGE_CHECK_INTERVAL_MS,
  controlWaitPolicy, parseControlPageObservation, type ControlHostFailure,
} from "../src/control/wait-policy.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { createMcpServer } from "../src/mcp/server.js";
import { nullLogger } from "../src/logger/index.js";
import { readSession, updateSession } from "../src/session/state.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection } from "./helpers.js";

const cleanups: string[] = [];
const correlation = { taskId: "terminal-test", iteration: 0, phase: "RESEARCH" as const };
const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

function fixture(session = "session-a", gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface })) {
  const root = makeTmpDir("control-wait");
  cleanups.push(root);
  const identity = { ...gateway.registerWorkspace(root), localSessionId: session };
  const url = projectUrl.replace("/project", `/c/${session}`);
  const page = gateway.surfaceClaim(identity, {
    browserId: "iab", surfaceId: "chatgpt", tabId: `tab-${session}`, projectUrl,
    projectSelection: projectSelection(projectUrl), chatUrl: url,
  });
  gateway.surfaceCommit(identity, page, {});
  const { request } = gateway.openControlResultRequest(identity, correlation);
  const grant = gateway.issueTurn({
    ...identity, ...correlation, requestId: request.requestId, generation: page.generation,
    scopes: ["c2c.result.write"], compactionEpoch: 0,
  });
  const observation: ControlHostFailure = {
    tabId: page.tabId, generation: page.generation, observedUrl: url,
    observedAt: new Date().toISOString(), responseToRequestId: request.requestId,
    state: "blocked", responseIsFinal: true, reason: "platform_blocked",
    source: "model_reported", tool: "report_control_progress", errorCode: "SAFETY_CHECK_BLOCKED",
  };
  return { gateway, identity, request, grant, observation };
}

function generatingObservation(f: ReturnType<typeof fixture>) {
  const { tabId, generation, observedUrl, responseToRequestId } = f.observation;
  return { tabId, generation, observedUrl, responseToRequestId, observedAt: new Date().toISOString(), state: "generating" as const };
}

beforeEach(() => { cleanups.push(isolateStateDir()); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanups.length) cleanup(cleanups.pop()!);
  delete process.env.C2C_STATE_DIR;
});

describe("state-driven mailbox waiting", () => {
  it("returns before a short activity lease expires so the host can renew automatically", async () => {
    vi.useFakeTimers();
    const request = openControlResultRequest("workspace-a", { localSessionId: "session-a", ...correlation, ttlMs: 2_000 });
    const wait = waitForControlResult("workspace-a", request.requestId, 30_000, "session-a", correlation);
    await vi.advanceTimersByTimeAsync(1_000);
    const status = await wait;
    expect(status.status).toBe("pending");
    expect(controlWaitPolicy(status)).toMatchObject({ leaseRemainingMs: 1_000, checkPageAfterMs: 500 });
  });

  it("bounds each wait slice without imposing a five-minute task deadline", async () => {
    vi.useFakeTimers();
    const request = openControlResultRequest("workspace-a", { localSessionId: "session-a", ...correlation });
    const read = () => getControlResultStatus("workspace-a", request.requestId, "session-a", correlation);
    const first = controlWaitPolicy(read());
    const wait = waitForControlResult("workspace-a", request.requestId, 600_000, "session-a", correlation);
    await vi.advanceTimersByTimeAsync(CONTROL_PAGE_CHECK_INTERVAL_MS);
    expect((await wait).status).toBe("pending");
    expect(controlWaitPolicy(read())).toMatchObject({
      leaseExpiresAt: first.leaseExpiresAt, leaseRemainingMs: 30 * 60_000 - CONTROL_PAGE_CHECK_INTERVAL_MS,
      nextAction: "inspect_exact_response",
    });
    vi.setSystemTime(Date.parse(request.createdAt) + 6 * 60_000);
    const nextWait = waitForControlResult("workspace-a", request.requestId, 600_000, "session-a", correlation);
    await vi.advanceTimersByTimeAsync(CONTROL_PAGE_CHECK_INTERVAL_MS);
    const status = await nextWait;
    expect(status).toMatchObject({ status: "pending", result: null });
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "pending", nextAction: "inspect_exact_response", elapsedMs: 6 * 60_000 + CONTROL_PAGE_CHECK_INTERVAL_MS });
    expect(getActiveControlResultStatus("workspace-a", "session-a")?.requestId).toBe(request.requestId);
  });

  it("consumes a real refusal after more than five minutes", async () => {
    vi.useFakeTimers();
    const request = openControlResultRequest("workspace-a", { localSessionId: "session-a", ...correlation });
    vi.setSystemTime(Date.parse(request.createdAt) + 6 * 60_000);
    submitControlResult("workspace-a", {
      requestId: request.requestId, localSessionId: "session-a", ...correlation, kind: "BLOCKED",
      payload: { reason: "Cannot complete this request", needs: ["Clarify the permitted task"] },
    });
    const status = await waitForControlResult("workspace-a", request.requestId, 0, "session-a", correlation);
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "blocked", nextAction: "persist_then_ack" });
    expect(acknowledgeControlResult("workspace-a", request.requestId, "session-a", correlation).status).toBe("acknowledged");
  });

  it("keeps the same request, token and page alive for 90 minutes and receives the real MCP callback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const otherIdentity = { ...f.identity, localSessionId: "session-b" };
    const other = f.gateway.openControlResultRequest(otherIdentity, correlation);
    const start = Date.parse(f.request.createdAt);
    for (let minute = 1; minute <= 90; minute++) {
      vi.setSystemTime(start + minute * 60_000);
      const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
      expect(status).toMatchObject({ status: "pending", requestId: f.request.requestId, request: { createdAt: f.request.createdAt }, progress: null });
      expect(controlWaitPolicy(status)).toMatchObject({ outcome: "pending", nextAction: "inspect_exact_response" });
    }
    expect(f.gateway.turnStatus(f.grant.token).binding).toEqual(f.grant.binding);
    expect(() => requireCurrentTurnSurface(f.grant.binding)).not.toThrow();
    expect(f.gateway.openControlResultRequest(f.identity, correlation)).toMatchObject({ created: false, request: { requestId: f.request.requestId } });
    expect(f.gateway.getControlResultStatus(otherIdentity, other.request.requestId, correlation))
      .toMatchObject({ status: "expired", request: { expiresAt: other.request.expiresAt } });

    const server = createMcpServer({ gateway: f.gateway, logger: nullLogger });
    const client = new Client({ name: "long-task-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const receipt = await client.callTool({ name: "submit_control_result", arguments: {
        context_id: f.grant.token, requestId: f.request.requestId, localSessionId: f.identity.localSessionId,
        ...correlation, kind: "BLOCKED", payload: { reason: "Unable to complete the research", needs: ["End this attempt and preserve completed work"] },
      } });
      expect(receipt.isError, JSON.stringify(receipt)).not.toBe(true);
      expect(receipt.structuredContent).toMatchObject({ accepted: true, requestId: f.request.requestId, kind: "BLOCKED" });
      const received = f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation);
      expect(controlWaitPolicy(received)).toMatchObject({ outcome: "blocked", nextAction: "persist_then_ack" });
      expect(f.gateway.acknowledgeControlResult(f.identity, f.request.requestId, correlation).status).toBe("acknowledged");
    } finally { await client.close(); await server.close(); }
  }, 20_000);

  it("does not extend authorization for unknown state or revive an expired request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 60_000);
    const unknown = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, { ...generatingObservation(f), state: "unknown" });
    expect(unknown.request?.expiresAt).toBe(f.request.expiresAt);
    expect(f.gateway.turnStatus(f.grant.token).expiresAt).toBe(f.grant.expiresAt);
    vi.setSystemTime(Date.parse(f.request.createdAt) + 31 * 60_000);
    const expired = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
    expect(expired.status).toBe("expired");
    expect(controlWaitPolicy(expired).nextAction).toBe("stop");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("expired");
  });

  it("does not renew a revoked capability even when the page still generates", () => {
    const f = fixture();
    f.gateway.revokeTurn(f.grant.token);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f))).toThrow(/no unique live capability/);
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation).request?.expiresAt).toBe(f.request.expiresAt);
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
  });

  it("retains immutable request identity through renewal and prunes its sidecar with the request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const root = getControlMailboxDir(f.identity.workspaceId);
    const original = fs.readFileSync(path.join(root, "requests", `${f.request.requestId}.json`), "utf8");
    vi.setSystemTime(Date.parse(f.request.createdAt) + 60_000);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
    expect(fs.readFileSync(path.join(root, "requests", `${f.request.requestId}.json`), "utf8")).toBe(original);
    const renewalPath = path.join(root, "renewals", `${f.request.requestId}.json`);
    expect(fs.existsSync(renewalPath)).toBe(true);
    vi.setSystemTime(Date.parse(f.request.createdAt) + 8 * 24 * 60 * 60_000);
    expect(pruneControlMailbox(f.identity.workspaceId)).toBe(1);
    expect(fs.existsSync(renewalPath)).toBe(false);
  });

  it("does not let a renewal mask tampering with the original request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 60_000);
    f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
    const originalPath = path.join(getControlMailboxDir(f.identity.workspaceId), "requests", `${f.request.requestId}.json`);
    fs.writeFileSync(originalPath, JSON.stringify({ ...f.request, expiresAt: new Date(Date.parse(f.request.expiresAt) - 1_000).toISOString() }));
    expect(() => f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation)).toThrow(/renewal does not match/);
  });
});

describe("exact response terminal observations", () => {
  it("ends a pending request after accepted progress without inventing a result, preserving other sessions and checkpoints", async () => {
    const f = fixture();
    const otherIdentity = { ...f.identity, localSessionId: "session-b" };
    const other = f.gateway.openControlResultRequest(otherIdentity, correlation);
    updateSession(f.identity.workspaceId, f.identity.localSessionId, {
      taskId: correlation.taskId, iteration: 0,
      checkpoint: { protocolState: "EXECUTED_LOCAL", completedSubtasks: "Keep completed work" },
    });
    reportControlProgress(f.identity.workspaceId, {
      requestId: f.request.requestId, localSessionId: f.identity.localSessionId, ...correlation, status: "SEARCHING",
    });
    const waiter = f.gateway.waitForControlResult(f.identity, f.request.requestId, 1_000, correlation);
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, f.observation);
    expect(status).toMatchObject({ status: "cancelled", result: null, progress: { status: "SEARCHING" }, hostFailure: { source: "model_reported", reason: "platform_blocked" } });
    expect((await waiter).status).toBe("cancelled");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
    expect(() => acknowledgeControlResult(f.identity.workspaceId, f.request.requestId, f.identity.localSessionId, correlation)).toThrow(/before receipt/);
    expect(f.gateway.getControlResultStatus(otherIdentity, other.request.requestId, correlation).status).toBe("pending");
    expect(readSession(f.identity.workspaceId, f.identity.localSessionId)?.checkpoint?.completedSubtasks).toBe("Keep completed work");
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation).hostFailure).toEqual(f.observation);
  });

  it.each(["blocked", "generating"] as const)("preserves a receipt racing a %s observation", (state) => {
    const f = fixture();
    const read = f.gateway.getControlResultStatus.bind(f.gateway);
    vi.spyOn(f.gateway, "getControlResultStatus").mockImplementationOnce((...args) => {
      const pending = read(...args);
      expect(pending.status).toBe("pending");
      submitControlResult(f.identity.workspaceId, {
        requestId: f.request.requestId, localSessionId: f.identity.localSessionId, ...correlation, kind: "BLOCKED",
        payload: { reason: "Business request refused", needs: ["Change the request"] },
      });
      return pending;
    });
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, state === "blocked" ? f.observation : generatingObservation(f));
    expect(status).toMatchObject({ status: "received", result: { kind: "BLOCKED" } });
    expect(status.hostFailure).toBeUndefined();
    expect(recordControlHostFailure(f.identity.workspaceId, f.request.requestId, f.identity.localSessionId, correlation, f.observation).status).toBe("received");
    expect(f.gateway.acknowledgeControlResult(f.identity, f.request.requestId, correlation).status).toBe("acknowledged");
    expect(f.gateway.acknowledgeControlResult(f.identity, f.request.requestId, correlation).status).toBe("acknowledged");
  });

  it("automatically resolves a finished response with no callback without manufacturing a receipt", () => {
    const f = fixture();
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...f.observation, reason: "callback_missing", source: "host_observed", tool: "submit_control_result", errorCode: "UNKNOWN",
    });
    expect(status).toMatchObject({ status: "cancelled", result: null, hostFailure: { reason: "callback_missing", source: "host_observed" } });
    expect(controlWaitPolicy(status).nextAction).toBe("stop");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
  });

  it.each(["generating", "unknown"] as const)("does not infer refusal from %s or a quotation of historical BLOCKED text", (state) => {
    const f = fixture();
    const { responseIsFinal, reason, source, tool, errorCode, ...identity } = f.observation;
    const observation = { ...identity, state };
    expect(f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, observation).status).toBe("pending");
    expect(() => parseControlPageObservation({ ...observation, excerpt: "The previous answer said BLOCKED" })).toThrow(/raw page text/);
  });

  it.each([
    { tabId: "another-tab" }, { generation: 99 }, { responseToRequestId: "old-request" },
    { observedUrl: projectUrl.replace("/project", "/c/another-chat") },
    { observedAt: "2000-01-01T00:00:00.000Z" }, { observedAt: "2099-01-01T00:00:00.000Z" },
  ])("rejects stale or unrelated evidence %j", (change) => {
    const f = fixture();
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, { ...f.observation, ...change })).toThrow(/observation does not match/);
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation).status).toBe("pending");
  });

  it("does not accept unfinished response evidence or leak arbitrary diagnostic text", () => {
    const f = fixture();
    for (const change of [
      { responseIsFinal: false }, { errorCode: "sk-secret-fixture" }, { excerpt: "c2c_ctx_secret_fixture" },
    ]) {
      try { parseControlPageObservation({ ...f.observation, ...change }); throw new Error("expected rejection"); }
      catch (error) {
        expect(String(error)).toContain("invalid control page observation");
        expect(String(error)).not.toMatch(/sk-secret|c2c_ctx_secret/);
      }
    }
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...f.observation, observedUrl: `${f.observation.observedUrl}?token=sk-secret-fixture`,
    })).toThrow(/observation does not match/);
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation).hostFailure).toBeUndefined();
  });
});
