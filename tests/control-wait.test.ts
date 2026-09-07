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
  advanceControlPageObservation,
  CONTROL_PAGE_CHECK_INTERVAL_MS,
  controlWaitPolicy, parseControlPageObservation, type ControlHostFailure,
} from "../src/control/wait-policy.js";
import {
  canonicalJson, MAX_CONTROL_RESULT_BYTES, type ControlResultSubmission,
} from "../src/control/result-schema.js";
import { MachineGateway, requireCurrentTurnSurface } from "../src/gateway/machine-gateway.js";
import { createMcpServer } from "../src/mcp/server.js";
import { nullLogger } from "../src/logger/index.js";
import { readSession, updateSession } from "../src/session/state.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection, receiveBootResult } from "./helpers.js";

const cleanups: string[] = [];
const correlation = { taskId: "terminal-test", iteration: 0, phase: "RESEARCH" as const };
const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";

function fixture(
  session = "session-a",
  gateway = new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }),
  turnCorrelation = correlation,
  createResponse = true,
) {
  const root = makeTmpDir("control-wait");
  cleanups.push(root);
  const identity = { ...gateway.registerWorkspace(root), localSessionId: session };
  const url = projectUrl.replace("/project", `/c/${session}`);
  const page = gateway.surfaceClaim(identity, {
    browserId: "iab", surfaceId: "chatgpt", tabId: `tab-${session}`, projectUrl,
    projectSelection: projectSelection(projectUrl), chatUrl: url,
  });
  gateway.surfaceCommit(identity, page, { bootRequestId: receiveBootResult(gateway, identity, page) });
  const { request } = gateway.openControlResultRequest(identity, turnCorrelation);
  const grant = gateway.issueTurn({
    ...identity, ...turnCorrelation, requestId: request.requestId, generation: page.generation,
    scopes: ["c2c.result.write"], compactionEpoch: 0,
  });
  const pageIdentity = {
    tabId: page.tabId,
    generation: page.generation,
    observedUrl: url,
    observedAt: new Date().toISOString(),
    responseToRequestId: request.requestId,
  };
  gateway.observeControlPage(identity, request.requestId, turnCorrelation, {
    ...pageIdentity, observationSequence: 1, state: "send_attempted",
  });
  gateway.observeControlPage(identity, request.requestId, turnCorrelation, {
    ...pageIdentity, observationSequence: 2, state: "sent",
  });
  if (createResponse) {
    gateway.observeControlPage(identity, request.requestId, turnCorrelation, {
      ...pageIdentity, observationSequence: 3, responseId: `response-${request.requestId}`,
      state: "response_created",
    });
  }
  const observation: ControlHostFailure = {
    ...pageIdentity, observationSequence: createResponse ? 4 : 3, responseId: `response-${request.requestId}`,
    state: "final", responseIsFinal: true, reason: "platform_blocked",
    source: "model_reported", tool: "report_control_progress", errorCode: "SAFETY_CHECK_BLOCKED",
  };
  return { gateway, identity, request, grant, observation, page };
}

function planSubmissionAtBytes(targetBytes: number): ControlResultSubmission {
  const submission = {
    kind: "PLAN" as const,
    payload: {
      goal: "g",
      rationale: "r",
      actions: Array.from({ length: 12 }, () => ({
        change: "c",
        why: "w",
        risks: ["r", "r", "r", "r"],
      })),
      tests: Array.from({ length: 12 }, () => "t"),
      successCriteria: Array.from({ length: 8 }, () => "s"),
    },
  };
  const slots: Array<{ get: () => string; set: (value: string) => void; max: number }> = [
    { get: () => submission.payload.goal, set: (value) => { submission.payload.goal = value; }, max: 600 },
    { get: () => submission.payload.rationale, set: (value) => { submission.payload.rationale = value; }, max: 2_000 },
  ];
  for (const action of submission.payload.actions) {
    slots.push(
      { get: () => action.change, set: (value) => { action.change = value; }, max: 600 },
      { get: () => action.why, set: (value) => { action.why = value; }, max: 600 },
    );
    action.risks.forEach((_, index) => slots.push({
      get: () => action.risks[index]!,
      set: (value) => { action.risks[index] = value; },
      max: 300,
    }));
  }
  submission.payload.tests.forEach((_, index) => slots.push({
    get: () => submission.payload.tests[index]!,
    set: (value) => { submission.payload.tests[index] = value; },
    max: 300,
  }));
  submission.payload.successCriteria.forEach((_, index) => slots.push({
    get: () => submission.payload.successCriteria[index]!,
    set: (value) => { submission.payload.successCriteria[index] = value; },
    max: 300,
  }));

  let remaining = targetBytes - Buffer.byteLength(canonicalJson(submission), "utf8");
  for (const slot of slots) {
    if (remaining <= 0) break;
    const added = Math.min(remaining, slot.max - slot.get().length);
    slot.set(`${slot.get()}${"x".repeat(added)}`);
    remaining -= added;
  }
  if (remaining !== 0) throw new Error(`unable to build a ${targetBytes}-byte PLAN result`);
  return submission;
}

function generatingObservation(f: ReturnType<typeof fixture>) {
  const { tabId, generation, observedUrl, responseToRequestId } = f.observation;
  const sequence = (f.gateway.getControlResultStatus(
    f.identity,
    f.request.requestId,
    { taskId: f.request.taskId, iteration: f.request.iteration, phase: f.request.phase },
  ).pageObservation?.latest.observationSequence ?? 0) + 1;
  return {
    tabId, generation, observedUrl, responseToRequestId,
    observedAt: new Date().toISOString(), observationSequence: sequence,
    responseId: `response-${f.request.requestId}`, state: "generating" as const,
  };
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
      nextAction: "mark_send_attempted",
    });
    vi.setSystemTime(Date.parse(request.createdAt) + 6 * 60_000);
    const nextWait = waitForControlResult("workspace-a", request.requestId, 600_000, "session-a", correlation);
    await vi.advanceTimersByTimeAsync(CONTROL_PAGE_CHECK_INTERVAL_MS);
    const status = await nextWait;
    expect(status).toMatchObject({ status: "pending", result: null });
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "pending", nextAction: "mark_send_attempted", elapsedMs: 6 * 60_000 + CONTROL_PAGE_CHECK_INTERVAL_MS });
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

    const server = createMcpServer(
      { gateway: f.gateway, logger: nullLogger },
      { resultTransport: "mailbox" },
    );
    const client = new Client({ name: "long-task-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const receipt = await client.callTool({ name: "submit_control_result", arguments: {
        context_id: f.grant.token, kind: "BLOCKED",
        payload: { reason: "Unable to complete the research", needs: ["End this attempt and preserve completed work"] },
      } });
      expect(receipt.isError, JSON.stringify(receipt)).not.toBe(true);
      expect(receipt.structuredContent).toMatchObject({ accepted: true, requestId: f.request.requestId, kind: "BLOCKED" });
      const received = f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation);
      expect(controlWaitPolicy(received)).toMatchObject({ outcome: "blocked", nextAction: "persist_then_ack" });
      expect(f.gateway.acknowledgeControlResult(f.identity, f.request.requestId, correlation).status).toBe("acknowledged");
    } finally { await client.close(); await server.close(); }
  }, 120_000);

  it("does not extend authorization for unknown state or revive an expired request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 60_000);
    const { responseId: _responseId, ...unknownObservation } = generatingObservation(f);
    const unknown = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...unknownObservation,
      state: "unknown",
    });
    expect(unknown.request?.expiresAt).toBe(f.request.expiresAt);
    expect(f.gateway.turnStatus(f.grant.token).expiresAt).toBe(f.grant.expiresAt);
    vi.setSystemTime(Date.parse(f.request.createdAt) + 31 * 60_000);
    const expired = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generatingObservation(f));
    expect(expired.status).toBe("expired");
    expect(controlWaitPolicy(expired).nextAction).toBe("stop");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("expired");
  });

  it("uses the last definitive phase after an unknown observation", () => {
    const request = openControlResultRequest("workspace-a", {
      localSessionId: "session-unknown-stage",
      ...correlation,
    });
    const status = getControlResultStatus(
      "workspace-a",
      request.requestId,
      "session-unknown-stage",
      correlation,
    );
    const base = {
      tabId: "tab-unknown-stage",
      generation: 1,
      observedUrl: "https://chatgpt.com/g/g-p-example/c/chat-example",
      observedAt: new Date().toISOString(),
      responseToRequestId: request.requestId,
    };
    const initialUnknown = advanceControlPageObservation(null, {
      ...base,
      observationSequence: 1,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: initialUnknown }).nextAction)
      .toBe("mark_send_attempted");

    const sendAttempted = advanceControlPageObservation(null, {
      ...base,
      observationSequence: 1,
      state: "send_attempted",
    }).state;
    const unknownAfterAttempt = advanceControlPageObservation(sendAttempted, {
      ...base,
      observationSequence: 2,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: unknownAfterAttempt }).nextAction)
      .toBe("confirm_send");

    const sent = advanceControlPageObservation(unknownAfterAttempt, {
      ...base,
      observationSequence: 3,
      state: "sent",
    }).state;
    const unknownAfterSent = advanceControlPageObservation(sent, {
      ...base,
      observationSequence: 4,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: unknownAfterSent }).nextAction)
      .toBe("inspect_response_start");

    const responseCreated = advanceControlPageObservation(unknownAfterSent, {
      ...base,
      observationSequence: 5,
      responseId: "response-unknown-stage",
      state: "response_created",
    }).state;
    const unknownAfterResponse = advanceControlPageObservation(responseCreated, {
      ...base,
      observationSequence: 6,
      state: "unknown",
    }).state;
    expect(controlWaitPolicy({ ...status, pageObservation: unknownAfterResponse }).nextAction)
      .toBe("inspect_exact_response");
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
    const observationPath = path.join(root, "observations", `${f.request.requestId}.json`);
    expect(fs.existsSync(renewalPath)).toBe(true);
    expect(fs.existsSync(observationPath)).toBe(true);
    vi.setSystemTime(Date.parse(f.request.createdAt) + 8 * 24 * 60 * 60_000);
    expect(pruneControlMailbox(f.identity.workspaceId)).toBe(2);
    expect(fs.existsSync(renewalPath)).toBe(false);
    expect(fs.existsSync(observationPath)).toBe(false);
  });

  it("rejects replay conflicts, out-of-order events, and replacement response identities", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    vi.setSystemTime(Date.parse(f.request.createdAt) + 1_000);
    const generating = generatingObservation(f);
    const first = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generating);
    const firstExpiry = first.request?.expiresAt;

    const replay = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, generating);
    expect(replay.pageObservation?.latest).toEqual(generating);
    expect(replay.request?.expiresAt).toBe(firstExpiry);

    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...generating,
      state: "final",
      responseIsFinal: true,
      reason: "callback_missing",
      source: "host_observed",
    })).toThrow(/sequence conflicts/);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...generating,
      observationSequence: generating.observationSequence - 1,
    })).toThrow(/stale or out of order/);
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...generating,
      observationSequence: generating.observationSequence + 1,
      responseId: "response-replacement",
    })).toThrow(/replacement or older response/);
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation))
      .toMatchObject({ status: "pending", request: { expiresAt: firstExpiry } });
  });

  it("detects stored observation tampering", () => {
    const f = fixture();
    const observationPath = path.join(
      getControlMailboxDir(f.identity.workspaceId),
      "observations",
      `${f.request.requestId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(observationPath, "utf8")) as {
      latest: { observedAt: string };
      lastDefinitive: { observedAt: string };
    };
    const changedAt = new Date(Date.parse(stored.latest.observedAt) + 1).toISOString();
    stored.latest.observedAt = changedAt;
    stored.lastDefinitive.observedAt = changedAt;
    fs.writeFileSync(observationPath, JSON.stringify(stored));
    expect(() => f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation))
      .toThrow(/observation integrity hash/);
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
  it("keeps a sent request pending until an explicit response-start failure is observed", () => {
    const f = fixture("session-no-response", new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }), correlation, false);
    const otherIdentity = { ...f.identity, localSessionId: "session-no-response-other" };
    const other = f.gateway.openControlResultRequest(otherIdentity, correlation);
    const { tabId, generation, observedUrl, responseToRequestId } = f.observation;
    expect(controlWaitPolicy(
      f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation),
    ).nextAction).toBe("inspect_response_start");
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      tabId,
      generation,
      observedUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId,
      observationSequence: 3,
      state: "response_start_failed",
      reason: "response_start_failed",
      source: "host_observed",
      evidence: "explicit_response_error",
    });
    expect(status).toMatchObject({
      status: "cancelled",
      result: null,
      hostFailure: {
        state: "response_start_failed",
        reason: "response_start_failed",
        evidence: "explicit_response_error",
      },
    });
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "terminal", nextAction: "stop" });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
    expect(f.gateway.getControlResultStatus(otherIdentity, other.request.requestId, correlation).status).toBe("pending");
  });

  it.each(["page_lost", "authority_invalid"] as const)("automatically ends only the affected session for %s", (state) => {
    const f = fixture(`session-${state}`);
    const otherIdentity = { ...f.identity, localSessionId: `session-${state}-other` };
    const other = f.gateway.openControlResultRequest(otherIdentity, correlation);
    expect(f.gateway.surfaceRelease(f.identity, f.page)).toBe(true);
    if (state === "authority_invalid") f.gateway.revokeTurn(f.grant.token);
    const { tabId, generation, responseToRequestId } = f.observation;
    const terminal = state === "page_lost"
      ? {
          tabId,
          generation,
          observedAt: new Date().toISOString(),
          responseToRequestId,
          observationSequence: 4,
          state,
          reason: "page_lost" as const,
          source: "host_observed" as const,
        }
      : {
          tabId,
          generation,
          observedUrl: f.observation.observedUrl,
          observedAt: new Date().toISOString(),
          responseToRequestId,
          observationSequence: 4,
          state,
          reason: "capability_invalid" as const,
          source: "host_observed" as const,
          errorCode: "TOKEN_REVOKED" as const,
        };
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, terminal);
    expect(status).toMatchObject({ status: "cancelled", result: null, hostFailure: { state } });
    expect(controlWaitPolicy(status)).toMatchObject({ outcome: "terminal", nextAction: "stop" });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
    expect(f.gateway.getControlResultStatus(otherIdentity, other.request.requestId, correlation).status).toBe("pending");
  });

  it("rejects authority-invalid evidence while the exact request still has live authority", () => {
    const f = fixture("session-authority-still-live");
    const { tabId, generation, observedUrl, responseToRequestId } = f.observation;
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      tabId,
      generation,
      observedUrl,
      observedAt: new Date().toISOString(),
      responseToRequestId,
      observationSequence: 4,
      state: "authority_invalid",
      reason: "capability_invalid",
      source: "host_observed",
      errorCode: "TOKEN_REVOKED",
    })).toThrow(/conflicts with a live capability/);
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation).status)
      .toBe("pending");
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("issued");
  });

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

  it.each(["final", "generating"] as const)("preserves a receipt racing a %s observation", (state) => {
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
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, state === "final" ? f.observation : generatingObservation(f));
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
      terminalResult: {
        kind: "BLOCKED",
        payload: { reason: "The final callback was unavailable", needs: ["End this attempt"] },
      },
    });
    expect(status).toMatchObject({
      status: "cancelled",
      result: null,
      hostFailure: { reason: "callback_missing", source: "host_observed" },
      hostObservedResult: {
        provenance: "host_observed",
        result: { kind: "BLOCKED", payload: { reason: "The final callback was unavailable" } },
      },
    });
    expect(controlWaitPolicy(status)).toMatchObject({ nextAction: "stop", delivery: "computer_use" });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
  });

  it("accepts a verified Computer Use result as the active delivery path", () => {
    const planCorrelation = { taskId: "computer-use-plan", iteration: 0, phase: "PLAN" as const };
    const f = fixture(
      "session-computer-use",
      new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }),
      planCorrelation,
    );
    const { reason: _reason, source: _source, tool: _tool, errorCode: _errorCode, ...response } = f.observation;
    const status = f.gateway.observeControlPage(f.identity, f.request.requestId, planCorrelation, {
      ...response,
      delivery: "computer_use",
      terminalResult: {
        kind: "PLAN",
        payload: {
          goal: "Compare Computer Use delivery",
          rationale: "The exact owned response contains a schema-valid result marker.",
          actions: [{ change: "Observe the bound response", why: "Avoid the MCP callback" }],
          tests: ["Verify exact response correlation"],
          successCriteria: ["The host reports Computer Use delivery"],
        },
      },
    });
    expect(status).toMatchObject({
      status: "cancelled",
      result: null,
      hostObservedResult: { provenance: "host_observed", result: { kind: "PLAN" } },
    });
    expect(status.hostFailure).toBeUndefined();
    expect(controlWaitPolicy(status)).toMatchObject({
      outcome: "delivered",
      delivery: "computer_use",
      nextAction: "stop",
    });
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("revoked");
  });

  it("accepts a host-observed result at the aggregate byte boundary", () => {
    const planCorrelation = { taskId: "terminal-size-test", iteration: 0, phase: "PLAN" as const };
    const boundary = fixture("session-boundary", new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }), planCorrelation);
    const accepted = planSubmissionAtBytes(MAX_CONTROL_RESULT_BYTES);
    expect(Buffer.byteLength(canonicalJson(accepted), "utf8")).toBe(MAX_CONTROL_RESULT_BYTES);
    expect(boundary.gateway.observeControlPage(
      boundary.identity,
      boundary.request.requestId,
      planCorrelation,
      { ...boundary.observation, terminalResult: accepted },
    )).toMatchObject({
      status: "cancelled",
      result: null,
      hostObservedResult: { result: { kind: "PLAN" } },
    });
  });

  it("rejects oversized host observations before changing request state", () => {
    const planCorrelation = { taskId: "terminal-size-test", iteration: 0, phase: "PLAN" as const };
    const f = fixture("session-oversized", new MachineGateway({ surfaceValidator: requireCurrentTurnSurface }), planCorrelation);
    const oversized = planSubmissionAtBytes(MAX_CONTROL_RESULT_BYTES + 1);
    const oversizedObservation = { ...f.observation, terminalResult: oversized };
    expect(Buffer.byteLength(canonicalJson(oversized), "utf8")).toBe(MAX_CONTROL_RESULT_BYTES + 1);
    expect(() => parseControlPageObservation(oversizedObservation)).toThrow(/exceeds 16384 bytes/);
    expect(() => recordControlHostFailure(
      f.identity.workspaceId,
      f.request.requestId,
      f.identity.localSessionId,
      planCorrelation,
      oversizedObservation,
    )).toThrow(/exceeds 16384 bytes/);

    const multibyte = planSubmissionAtBytes(MAX_CONTROL_RESULT_BYTES);
    if (multibyte.kind !== "PLAN") throw new Error("expected PLAN fixture");
    multibyte.payload.goal = `${multibyte.payload.goal.slice(0, -1)}界`;
    expect(Buffer.byteLength(canonicalJson(multibyte), "utf8")).toBe(MAX_CONTROL_RESULT_BYTES + 2);
    expect(() => parseControlPageObservation({ ...f.observation, terminalResult: multibyte }))
      .toThrow(/exceeds 16384 bytes/);

    const pending = f.gateway.getControlResultStatus(f.identity, f.request.requestId, planCorrelation);
    expect(pending).toMatchObject({ status: "pending", result: null });
    expect(pending.hostObservedResult).toBeUndefined();
    expect(getActiveControlResultStatus(f.identity.workspaceId, f.identity.localSessionId)?.requestId)
      .toBe(f.request.requestId);
    expect(f.gateway.turnStatus(f.grant.token).status).toBe("issued");

    const lease = f.gateway.claimTurn(f.grant.token, ["c2c.result.write"]);
    const fence = f.gateway.beginCompletion(f.grant.token);
    f.gateway.releaseTurn(f.grant.token, lease.lease);
    f.gateway.completeControlResult(f.grant.token, fence, {
      kind: "PLAN",
      payload: {
        goal: "Complete after rejecting oversized host evidence",
        rationale: "The request and capability remained live",
        actions: [{ change: "Continue the original turn", why: "No lifecycle state was mutated" }],
        tests: ["Read the authoritative mailbox"],
        successCriteria: ["The real completion is received"],
      },
    });
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, planCorrelation))
      .toMatchObject({ status: "received", result: { kind: "PLAN" } });
  });

  it("rejects a host-observed kind that the request phase does not allow", () => {
    const f = fixture();
    expect(() => f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...f.observation,
      terminalResult: {
        kind: "PLAN",
        payload: {
          goal: "Wrong phase", rationale: "RESEARCH cannot accept PLAN",
          actions: [{ change: "Do nothing", why: "The phase is wrong" }], tests: [],
          successCriteria: ["The observation is rejected"],
        },
      },
    })).toThrow(/not allowed/i);
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation))
      .toMatchObject({ status: "pending", result: null });
  });

  it("lets an already-started MCP completion settle before a host terminal fallback", () => {
    const f = fixture();
    const lease = f.gateway.claimTurn(f.grant.token, ["c2c.result.write"]);
    const fence = f.gateway.beginCompletion(f.grant.token);
    f.gateway.releaseTurn(f.grant.token, lease.lease);
    const observed = f.gateway.observeControlPage(f.identity, f.request.requestId, correlation, {
      ...f.observation,
      terminalResult: {
        kind: "BLOCKED",
        payload: { reason: "The page did not see the receipt", needs: ["Reconcile the mailbox"] },
      },
    });
    expect(observed).toMatchObject({ status: "pending", result: null });
    expect(observed.hostObservedResult).toBeUndefined();
    f.gateway.completeControlResult(f.grant.token, fence, {
      kind: "BLOCKED",
      payload: { reason: "The business task was refused", needs: ["End this attempt"] },
    });
    expect(f.gateway.getControlResultStatus(f.identity, f.request.requestId, correlation))
      .toMatchObject({ status: "received", result: { kind: "BLOCKED" } });
  });

  it.each(["generating", "unknown"] as const)("does not infer refusal from %s or a quotation of historical BLOCKED text", (state) => {
    const f = fixture();
    const generated = generatingObservation(f);
    const { responseId, ...withoutResponse } = generated;
    const observation = state === "generating"
      ? generated
      : { ...withoutResponse, state: "unknown" as const };
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
