import { describe, expect, it } from "vitest";
import { redact } from "../src/logger/index.js";
import {
  TurnCapabilityBroker,
  TurnCapabilityError,
  type TurnCapabilityBinding,
} from "../src/gateway/turn-capability.js";

function binding(overrides: Partial<TurnCapabilityBinding> = {}): TurnCapabilityBinding {
  return {
    workspaceId: "workspace-a",
    projectId: "project-a",
    registrationId: "registration-a",
    localSessionId: "session-a",
    taskId: "task-a",
    iteration: 2,
    phase: "EXECUTING",
    requestId: "request-a",
    scopes: ["workspace.read", "workspace.write"],
    modelId: "gpt-5",
    effort: "high",
    compactionEpoch: 1,
    generation: 4,
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

describe("turn capability broker", () => {
  it("renews only the exact live request and does not advance expiry on observation replay", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const broker = new TurnCapabilityBroker({ now: () => now });
    const grant = broker.issueReplacingSession({ ...binding(), ttlMs: 60_000 });
    const expected = { ...grant.binding, requestId: "request-a" };
    now += 30_000;
    for (const mismatch of [
      { workspaceId: "other" }, { projectId: "other" }, { registrationId: "other" },
      { localSessionId: "other" }, { requestId: "other" }, { taskId: "other" },
      { iteration: 99 }, { phase: "other" }, { generation: 99 },
    ]) expectCode(() => broker.keepAliveRequest({ ...expected, ...mismatch }, now), "TOKEN_NOT_FOUND");
    expect(broker.status(grant.token).expiresAt).toBe(grant.expiresAt);
    expectCode(() => broker.keepAliveRequest(expected, now - 60_001), "BINDING_MISMATCH");
    expectCode(() => broker.keepAliveRequest(expected, now + 5_001), "BINDING_MISMATCH");
    const observedAt = now;
    const renewed = broker.keepAliveRequest(expected, observedAt);
    expect(Date.parse(renewed)).toBe(now + 60_000);
    now += 20_000;
    expect(broker.keepAliveRequest(expected, observedAt)).toBe(renewed);
    expect(broker.status(grant.token).binding).toEqual(grant.binding);
    broker.revoke(grant.token);
    expectCode(() => broker.keepAliveRequest(expected, now), "TOKEN_NOT_FOUND");
    expect(broker.status(grant.token).status).toBe("revoked");
  });

  it("does not revive expired or replaced capabilities or extend an in-progress completion", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const broker = new TurnCapabilityBroker({ now: () => now });
    const first = broker.issueReplacingSession({ ...binding(), ttlMs: 1_000 });
    const expected = { ...first.binding, requestId: "request-a" };
    now += 1_000;
    expectCode(() => broker.keepAliveRequest(expected, now), "TOKEN_NOT_FOUND");
    expect(broker.status(first.token).status).toBe("expired");
    const next = broker.issueReplacingSession(binding({ requestId: "request-b", generation: 5 }));
    expectCode(() => broker.keepAliveRequest(expected, now), "TOKEN_NOT_FOUND");
    const nextExpected = { ...next.binding, requestId: "request-b" };
    const lease = broker.claim(next.token, next.binding);
    broker.release(next.token, lease.leaseId);
    const fence = broker.beginCompletion(next.token, next.binding);
    expectCode(() => broker.keepAliveRequest(nextExpected, now), "COMPLETION_ALREADY_STARTED");
    broker.complete(fence.fence);
    expectCode(() => broker.keepAliveRequest(nextExpected, now), "TOKEN_NOT_FOUND");
  });

  it("issues high-entropy capabilities while retaining only a digest", () => {
    const broker = new TurnCapabilityBroker();
    const grant = broker.issue({ ...binding(), ttlMs: 30_000 });

    expect(grant.token).toMatch(/^c2c_ctx_[A-Za-z0-9_-]{43}$/);
    expect(grant.token.length).toBeGreaterThan(40);
    expect(broker.assertLive(grant.token)).toEqual(grant.binding);
    expect(JSON.stringify(broker)).not.toContain(grant.token);
    expect(JSON.stringify(broker.status(grant.token))).not.toContain(grant.token);
    expect(broker.status("c2c_ctx_invalid")).toEqual({
      status: "unknown",
      activeLeaseCount: 0,
      completionReady: false,
    });
  });

  it("requires an exact route binding and granted scopes at claim time", () => {
    const broker = new TurnCapabilityBroker();
    const grant = broker.issue(binding());

    for (const mismatch of [
      { workspaceId: "workspace-b" },
      { projectId: "project-b" },
      { registrationId: "registration-b" },
      { localSessionId: "session-b" },
      { taskId: "other-task" },
      { requestId: "other-request" },
      { compactionEpoch: 2 },
      { generation: 5 },
    ]) {
      expectCode(() => broker.claim(grant.token, binding(mismatch)), "BINDING_MISMATCH");
    }
    expectCode(
      () => broker.claim(grant.token, binding(), { requiredScopes: ["process.exec"] }),
      "SCOPE_DENIED"
    );

    const lease = broker.claim(grant.token, binding(), { requiredScopes: ["workspace.write"] });
    expect(lease.binding).toEqual({ ...binding(), scopes: ["workspace.read", "workspace.write"] });
    expect(lease.leaseId).toMatch(/^c2c_lease_[A-Za-z0-9_-]{43}$/);
  });

  it("requires an exact mailbox request outside BOOT and forbids one during BOOT", () => {
    const broker = new TurnCapabilityBroker();

    expectCode(() => broker.issue(binding({ requestId: undefined })), "INVALID_BINDING");
    expectCode(
      () => broker.issue(binding({ phase: "BOOT", requestId: "request-a" })),
      "INVALID_BINDING"
    );
    expect(() => broker.issue(binding({ phase: "BOOT", requestId: undefined }))).not.toThrow();
  });

  it("accepts only frozen lease objects issued by the same broker instance", () => {
    const broker = new TurnCapabilityBroker();
    const grant = broker.issue(binding());
    const lease = broker.claim(grant.token, binding());

    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.binding)).toBe(true);
    expect(Object.isFrozen(lease.binding.scopes)).toBe(true);
    expect(broker.validateLease(lease)).toBe(lease);
    expectCode(() => broker.validateLease({ ...lease }), "LEASE_NOT_FOUND");
    expectCode(() => new TurnCapabilityBroker().validateLease(lease), "LEASE_NOT_FOUND");

    broker.release(grant.token, lease.leaseId);
    expectCode(() => broker.validateLease(lease), "LEASE_NOT_FOUND");
  });

  it("does not impose a default cross-session turn limit", () => {
    const broker = new TurnCapabilityBroker();
    const grants = Array.from({ length: 140 }, (_, index) => {
      const turnBinding = binding({
        localSessionId: `session-${index}`,
        taskId: `task-${index}`,
      });
      return { grant: broker.issue(turnBinding), turnBinding };
    });
    const leases = grants.map(({ grant, turnBinding }) => broker.claim(grant.token, turnBinding));
    const parallelLeases = Array.from({ length: 32 }, () =>
      broker.claim(grants[0].grant.token, grants[0].turnBinding)
    );

    expect(new Set(leases.map((lease) => lease.leaseId)).size).toBe(140);
    expect(new Set(parallelLeases.map((lease) => lease.leaseId)).size).toBe(32);
    expect(broker.stats().activeTurnCount).toBe(140);
    expect(broker.status(grants[0].grant.token).activeLeaseCount).toBe(33);

    broker.release(grants[0].grant.token, leases[0].leaseId);
    const sequentialLease = broker.claim(grants[0].grant.token, grants[0].turnBinding);
    expect(sequentialLease.leaseId).not.toBe(leases[0].leaseId);
    expect(broker.status(grants[0].grant.token).activeLeaseCount).toBe(33);
    for (const lease of parallelLeases) broker.release(grants[0].grant.token, lease.leaseId);
    broker.release(grants[0].grant.token, sequentialLease.leaseId);
    for (let index = 1; index < grants.length; index += 1) {
      broker.release(grants[index].grant.token, leases[index].leaseId);
    }
    for (const { grant } of grants) broker.cancel(grant.token);
    expect(broker.stats().activeTurnCount).toBe(0);
  });

  it("makes release idempotent and fences completion until the lease is gone", () => {
    const broker = new TurnCapabilityBroker();
    const grant = broker.issue(binding());
    const lease = broker.claim(grant.token, binding());
    const secondLease = broker.claim(grant.token, binding());
    const fence = broker.beginCompletion(grant.token, binding());

    expect(fence.ready).toBe(false);
    expect(fence.activeLeaseCount).toBe(2);
    expectCode(() => broker.claim(grant.token, binding()), "COMPLETION_ALREADY_STARTED");
    expectCode(() => broker.complete(fence.fence), "ACTIVE_LEASES_REMAIN");
    expect(broker.release(grant.token, lease.leaseId)).toEqual({ released: true });
    expectCode(() => broker.complete(fence.fence), "ACTIVE_LEASES_REMAIN");
    expect(broker.release(grant.token, secondLease.leaseId)).toEqual({ released: true });
    expect(broker.release(grant.token, lease.leaseId)).toEqual({ released: false });

    expect(broker.complete(fence.fence).status).toBe("completed");
    expectCode(() => broker.complete(fence.fence), "COMPLETION_FENCE_REPLAYED");
    expectCode(() => broker.claim(grant.token, binding()), "TOKEN_COMPLETED");
    expect(broker.status(grant.token).status).toBe("completed");
  });

  it("can abandon a failed external commit and retry with a fresh fence", () => {
    const broker = new TurnCapabilityBroker();
    const expected = binding({ taskId: "retry-commit" });
    const grant = broker.issue(expected);
    const lease = broker.claim(grant.token, expected);
    const firstFence = broker.beginCompletion(grant.token, expected);

    broker.release(grant.token, lease.leaseId);
    expect(broker.abortCompletion(firstFence.fence)).toEqual({ status: "active" });
    expectCode(() => broker.complete(firstFence.fence), "COMPLETION_FENCE_REPLAYED");

    const retryLease = broker.claim(grant.token, expected);
    const retryFence = broker.beginCompletion(grant.token, expected);
    broker.release(grant.token, retryLease.leaseId);
    expect(broker.complete(retryFence.fence)).toMatchObject({ status: "completed" });
  });

  it("allows an existing lease to renew while completion blocks new claims", () => {
    let now = 5_000;
    const broker = new TurnCapabilityBroker({ now: () => now });
    const grant = broker.issue({ ...binding(), ttlMs: 2_000 });
    const lease = broker.claim(grant.token, binding(), { leaseTtlMs: 200 });
    const fence = broker.beginCompletion(grant.token, binding());

    now += 150;
    broker.renew(grant.token, lease.leaseId, binding(), 500);
    now += 100;
    expectCode(() => broker.complete(fence.fence), "ACTIVE_LEASES_REMAIN");
    expect(broker.validateLease(lease)).toBe(lease);

    broker.release(grant.token, lease.leaseId);
    expect(broker.complete(fence.fence).status).toBe("completed");
  });

  it("expires leases and capabilities using absolute deadlines", () => {
    let now = 10_000;
    const broker = new TurnCapabilityBroker({ now: () => now });
    const grant = broker.issue({ ...binding(), ttlMs: 2_000 });
    const lease = broker.claim(grant.token, binding(), { leaseTtlMs: 500 });

    now += 501;
    expectCode(() => broker.renew(grant.token, lease.leaseId, binding()), "LEASE_EXPIRED");
    expect(broker.release(grant.token, lease.leaseId)).toEqual({ released: false });
    const fence = broker.beginCompletion(grant.token, binding());
    expect(fence.ready).toBe(true);

    now += 1_500;
    expectCode(() => broker.complete(fence.fence), "TOKEN_EXPIRED");
    expect(broker.status(grant.token).status).toBe("expired");
    expectCode(() => broker.cancel(grant.token), "TOKEN_EXPIRED");
  });

  it("releases the active slot in the same sweep when a capability and its lease expire", () => {
    let now = 20_000;
    const broker = new TurnCapabilityBroker({ now: () => now });
    const grant = broker.issue({ ...binding(), ttlMs: 1_000 });
    const lease = broker.claim(grant.token, binding(), { leaseTtlMs: 1_000 });

    now += 1_000;
    expectCode(() => broker.validateLease(lease), "LEASE_EXPIRED");
    expect(broker.stats()).toMatchObject({ activeTurnCount: 0 });
    expect(broker.status(grant.token)).toMatchObject({ status: "expired", activeLeaseCount: 0 });
  });

  it("cancels and revokes fail closed while retaining bounded tombstones", () => {
    const broker = new TurnCapabilityBroker({ maxTombstones: 2 });
    const cancelled = broker.issue(binding({ taskId: "cancelled" }));
    broker.cancel(cancelled.token);
    expect(broker.status(cancelled.token).status).toBe("cancelled");
    expectCode(() => broker.cancel(cancelled.token), "TOKEN_CANCELLED");
    expectCode(() => broker.claim(cancelled.token, binding({ taskId: "cancelled" })), "TOKEN_CANCELLED");

    const revoked = broker.issue(binding({ taskId: "revoked" }));
    broker.revoke(revoked.token);
    expect(broker.status(revoked.token).status).toBe("revoked");
    expectCode(() => broker.claim(revoked.token, binding({ taskId: "revoked" })), "TOKEN_REVOKED");

    const completed = broker.issue(binding({ taskId: "completed" }));
    const completedLease = broker.claim(completed.token, binding({ taskId: "completed" }));
    const fence = broker.beginCompletion(completed.token, binding({ taskId: "completed" }));
    broker.release(completed.token, completedLease.leaseId);
    broker.complete(fence.fence);
    const extra = broker.issue(binding({ taskId: "extra" }));
    broker.cancel(extra.token);

    expect(broker.stats().tombstoneCount).toBeLessThanOrEqual(2);
    expectCode(() => broker.claim(cancelled.token, binding({ taskId: "cancelled" })), "TOKEN_NOT_FOUND");
  });

  it("drains leases after cancellation without blocking another turn", () => {
    const broker = new TurnCapabilityBroker();
    const cancelled = broker.issue(binding({ taskId: "draining" }));
    const lease = broker.claim(cancelled.token, binding({ taskId: "draining" }));
    broker.cancel(cancelled.token);

    expect(broker.status(cancelled.token)).toMatchObject({ status: "cancelled", activeLeaseCount: 1 });
    expect(broker.stats().activeTurnCount).toBe(1);
    const waiting = broker.issue(binding({ taskId: "waiting" }));
    const waitingLease = broker.claim(waiting.token, binding({ taskId: "waiting" }));
    expect(broker.validateLease(lease)).toBe(lease);
    expect(broker.release(cancelled.token, lease.leaseId)).toEqual({ released: true });
    expectCode(() => broker.validateLease(lease), "LEASE_NOT_FOUND");
    expect(broker.status(cancelled.token)).toMatchObject({ status: "cancelled", activeLeaseCount: 0 });
    expect(broker.stats().activeTurnCount).toBe(1);
    broker.release(waiting.token, waitingLease.leaseId);
    broker.cancel(waiting.token);
    expect(broker.stats().activeTurnCount).toBe(0);
  });

  it("revokes all exact-binding capabilities without receiving a token", () => {
    const broker = new TurnCapabilityBroker();
    const first = broker.issue(binding({ taskId: "rotate" }));
    const second = broker.issue(binding({ taskId: "rotate" }));
    const unrelated = broker.issue(binding({ taskId: "other" }));
    const lease = broker.claim(first.token, binding({ taskId: "rotate" }));

    const revokedCount = broker.revokeBinding(binding({ taskId: "rotate" }));
    expect(revokedCount).toBe(2);
    expect(broker.status(first.token)).toMatchObject({ status: "revoked", activeLeaseCount: 1 });
    expect(broker.status(second.token).status).toBe("revoked");
    expect(broker.status(unrelated.token).status).toBe("issued");
    expect(broker.stats().activeTurnCount).toBe(1);

    expect(broker.revokeBinding(binding({ taskId: "rotate" }))).toBe(0);
    expect(broker.release(first.token, lease.leaseId)).toEqual({ released: true });
    expect(broker.stats().activeTurnCount).toBe(0);
  });

  it("revokes every live capability for an exact control request without a context id", () => {
    const broker = new TurnCapabilityBroker();
    const expected = binding({ taskId: "request", requestId: "request-a" });
    const first = broker.issue(expected);
    const second = broker.issue({
      ...expected,
      modelId: "gpt-5-mini",
      effort: "low",
      generation: 9,
    });
    const foreignRequest = broker.issue({ ...expected, requestId: "request-b" });
    const lease = broker.claim(first.token, expected);

    const revoked = broker.revokeRequest({
      workspaceId: expected.workspaceId,
      projectId: expected.projectId,
      localSessionId: expected.localSessionId,
      taskId: expected.taskId,
      iteration: expected.iteration,
      phase: expected.phase,
      requestId: expected.requestId!,
    });
    expect(revoked).toBe(2);
    expect(broker.status(first.token)).toMatchObject({ status: "revoked", activeLeaseCount: 1 });
    expect(broker.status(second.token).status).toBe("revoked");
    expect(broker.status(foreignRequest.token).status).toBe("issued");
    broker.release(first.token, lease.leaseId);
  });

  it("retires one local session without revoking independent sessions", () => {
    const broker = new TurnCapabilityBroker();
    const first = broker.issue(binding({ taskId: "first" }));
    const second = broker.issue(binding({ taskId: "second" }));
    const unrelated = broker.issue(
      binding({ localSessionId: "session-other", taskId: "unrelated" })
    );
    const draining = broker.claim(first.token, binding({ taskId: "first" }));

    expect(broker.revokeSession("workspace-a", "project-a", "session-a")).toBe(2);
    expect(broker.status(first.token)).toMatchObject({ status: "revoked", activeLeaseCount: 1 });
    expect(broker.status(second.token).status).toBe("revoked");
    expect(broker.status(unrelated.token).status).toBe("issued");
    expect(broker.revokeSession("workspace-a", "project-a", "session-a")).toBe(0);

    broker.release(first.token, draining.leaseId);
  });

  it("replaces every nonterminal capability for the exact session key", () => {
    const broker = new TurnCapabilityBroker();
    const old = broker.issue(binding({ taskId: "old", generation: 1, compactionEpoch: 1 }));
    const oldLease = broker.claim(old.token, binding({ taskId: "old", generation: 1, compactionEpoch: 1 }));
    const oldIssued = broker.issue(binding({ taskId: "old-issued", generation: 1, compactionEpoch: 1 }));
    const unrelatedSession = broker.issue(
      binding({ taskId: "other-session", localSessionId: "session-other", generation: 1 })
    );
    const replacementBinding = binding({
      taskId: "new-task",
      iteration: 8,
      phase: "REVIEW",
      scopes: ["workspace.read"],
      modelId: "gpt-5-mini",
      effort: "low",
      compactionEpoch: 7,
      generation: 9,
    });

    expectCode(
      () => broker.issueReplacingSession({ ...replacementBinding, ttlMs: 30_000 }),
      "ACTIVE_LEASES_REMAIN"
    );
    expect(broker.status(old.token)).toMatchObject({ status: "active", activeLeaseCount: 1 });
    expect(broker.status(oldIssued.token).status).toBe("issued");
    expect(broker.status(unrelatedSession.token).status).toBe("issued");
    expect(broker.stats().activeTurnCount).toBe(1);
    broker.release(old.token, oldLease.leaseId);

    const replacement = broker.issueReplacingSession({ ...replacementBinding, ttlMs: 30_000 });
    expect(broker.status(old.token).status).toBe("revoked");
    expect(broker.status(oldIssued.token).status).toBe("revoked");
    const replacementLease = broker.claim(replacement.token, replacementBinding);
    broker.release(replacement.token, replacementLease.leaseId);
    broker.cancel(replacement.token);
  });

  it("does not supersede a different local session", () => {
    const broker = new TurnCapabilityBroker();
    const existing = broker.issue(binding({ taskId: "existing" }));
    const replacement = broker.issueReplacingSession({
      ...binding({ localSessionId: "session-new", taskId: "new" }),
      ttlMs: 30_000,
    });

    expect(broker.status(existing.token).status).toBe("issued");
    expect(broker.status(replacement.token).status).toBe("issued");
  });

  it("rejects delayed page or compaction epochs without revoking the current session token", () => {
    const broker = new TurnCapabilityBroker();
    const current = broker.issueReplacingSession({
      ...binding({ taskId: "current", compactionEpoch: 4, generation: 7 }),
      ttlMs: 30_000,
    });

    expectCode(
      () =>
        broker.issueReplacingSession({
          ...binding({ taskId: "stale-page", compactionEpoch: 4, generation: 6 }),
          ttlMs: 30_000,
        }),
      "STALE_BINDING_EPOCH"
    );
    expectCode(
      () =>
        broker.issueReplacingSession({
          ...binding({ taskId: "stale-compaction", compactionEpoch: 3, generation: 7 }),
          ttlMs: 30_000,
        }),
      "STALE_BINDING_EPOCH"
    );
    expect(broker.status(current.token).status).toBe("issued");
  });

  it("revokes every session under one registration while preserving draining leases", () => {
    const broker = new TurnCapabilityBroker();
    const first = broker.issue(binding({ localSessionId: "session-one", taskId: "task-one" }));
    const second = broker.issue(binding({ localSessionId: "session-two", taskId: "task-two" }));
    const foreignRegistration = broker.issue(
      binding({ localSessionId: "session-three", taskId: "task-three", registrationId: "registration-other" })
    );
    const lease = broker.claim(first.token, binding({ localSessionId: "session-one", taskId: "task-one" }));

    expect(broker.revokeRegistration("workspace-a", "project-a", "registration-a")).toBe(2);
    expect(broker.status(first.token)).toMatchObject({ status: "revoked", activeLeaseCount: 1 });
    expect(broker.status(second.token).status).toBe("revoked");
    expect(broker.status(foreignRegistration.token).status).toBe("issued");
    expect(broker.stats().activeTurnCount).toBe(1);
    expect(broker.revokeRegistration("workspace-a", "project-a", "registration-a")).toBe(0);

    expect(broker.release(first.token, lease.leaseId)).toEqual({ released: true });
    expect(broker.stats().activeTurnCount).toBe(0);
  });

  it("validates registration identity before mutating any capability", () => {
    const broker = new TurnCapabilityBroker();
    const existing = broker.issue(binding());
    const lease = broker.claim(existing.token, binding());

    for (const ids of [
      ["", "project-a", "registration-a"],
      ["workspace-a", "project-a\n", "registration-a"],
      ["workspace-a", "project-a", ""],
    ]) {
      expectCode(() => broker.revokeRegistration(...ids), "INVALID_BINDING");
      expect(broker.status(existing.token)).toMatchObject({ status: "active", activeLeaseCount: 1 });
    }
    expect(broker.validateLease(lease)).toBe(lease);
  });

  it("preflights binding and TTL before supersession", () => {
    const broker = new TurnCapabilityBroker();
    const existing = broker.issue(binding({ taskId: "existing" }));

    expectCode(
      () => broker.issueReplacingSession({ ...binding({ taskId: "invalid-ttl" }), ttlMs: 0 }),
      "INVALID_TTL"
    );
    expect(broker.status(existing.token).status).toBe("issued");

    expectCode(
      () =>
        broker.issueReplacingSession({
          ...binding({ taskId: "invalid-binding", workspaceId: "" }),
          ttlMs: 30_000,
        }),
      "INVALID_BINDING"
    );
    expect(broker.status(existing.token).status).toBe("issued");

    const lease = broker.claim(existing.token, binding({ taskId: "existing" }));
    expectCode(
      () => broker.issueReplacingSession({ ...binding({ taskId: "replacement" }), ttlMs: 30_000 }),
      "ACTIVE_LEASES_REMAIN"
    );
    expect(broker.status(existing.token)).toMatchObject({ status: "active", activeLeaseCount: 1 });
    broker.release(existing.token, lease.leaseId);
  });

  it("reclaims a full same-session issued record during replacement", () => {
    const broker = new TurnCapabilityBroker();
    const existing = broker.issue(binding({ taskId: "old-issued" }));
    const replacement = broker.issueReplacingSession({
      ...binding({ taskId: "new-issued", generation: 5 }),
      ttlMs: 30_000,
    });

    expect(broker.status(existing.token).status).toBe("revoked");
    expect(broker.status(replacement.token).status).toBe("issued");
    expect(broker.stats().capabilityCount).toBe(2);
  });

  it("bounds retained tombstones while cancelled and revoked turns drain", () => {
    let now = 30_000;
    const broker = new TurnCapabilityBroker({
      now: () => now,
      maxTombstones: 0,
    });
    const cancelled = broker.issue(binding({ taskId: "cancelled-drain" }));
    const revoked = broker.issue(binding({ taskId: "revoked-drain" }));
    const cancelledLease = broker.claim(cancelled.token, binding({ taskId: "cancelled-drain" }), {
      leaseTtlMs: 200,
    });
    const revokedLease = broker.claim(revoked.token, binding({ taskId: "revoked-drain" }), {
      leaseTtlMs: 200,
    });
    broker.cancel(cancelled.token);
    broker.revoke(revoked.token);
    expect(broker.validateLease(cancelledLease)).toBe(cancelledLease);
    expect(broker.validateLease(revokedLease)).toBe(revokedLease);

    expect(broker.stats()).toMatchObject({
      capabilityCount: 2,
      activeTurnCount: 2,
      tombstoneCount: 2,
      drainingTurnCount: 2,
      maxTombstones: 0,
    });

    now += 201;
    expectCode(() => broker.validateLease(cancelledLease), "LEASE_NOT_FOUND");
    expectCode(() => broker.validateLease(revokedLease), "LEASE_NOT_FOUND");
    expect(broker.stats()).toMatchObject({
      capabilityCount: 0,
      activeTurnCount: 0,
      tombstoneCount: 0,
      drainingTurnCount: 0,
    });
  });

  it("does not impose a live capability cap and fences broker restarts by boot epoch", () => {
    const broker = new TurnCapabilityBroker();
    const first = broker.issue(binding({ taskId: "one" }));
    broker.issue(binding({ taskId: "two" }));
    broker.issue(binding({ taskId: "three" }));
    expect(broker.stats().capabilityCount).toBe(3);

    const restarted = new TurnCapabilityBroker();
    expect(restarted.bootEpoch).not.toBe(broker.bootEpoch);
    expect(restarted.status(first.token).status).toBe("unknown");
    expectCode(() => restarted.claim(first.token, binding({ taskId: "one" })), "TOKEN_NOT_FOUND");
  });

  it("retains only bounded tombstones while issuing new capabilities", () => {
    const broker = new TurnCapabilityBroker({ maxTombstones: 2 });

    for (let index = 0; index < 6; index += 1) {
      const grant = broker.issue(binding({ taskId: `cycle-${index}` }));
      const lease = broker.claim(grant.token, binding({ taskId: `cycle-${index}` }));
      const fence = broker.beginCompletion(grant.token, binding({ taskId: `cycle-${index}` }));
      broker.release(grant.token, lease.leaseId);
      broker.complete(fence.fence);
      expect(broker.stats().tombstoneCount).toBeLessThanOrEqual(2);
    }

    expect(broker.stats().tombstoneCount).toBeLessThanOrEqual(2);
  });

  it("redacts context, lease, and completion secrets from logs", () => {
    const broker = new TurnCapabilityBroker();
    const grant = broker.issue(binding());
    const lease = broker.claim(grant.token, binding());
    const fence = broker.beginCompletion(grant.token, binding());
    const line = redact(`ctx=${grant.token} lease=${lease.leaseId} fence=${fence.fence}`);

    expect(line).not.toContain(grant.token);
    expect(line).not.toContain(lease.leaseId);
    expect(line).not.toContain(fence.fence);
    expect(line).toContain("[REDACTED]");
  });
});
