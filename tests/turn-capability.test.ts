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
  it("issues high-entropy capabilities while retaining only a digest", () => {
    const broker = new TurnCapabilityBroker();
    const grant = broker.issue({ ...binding(), ttlMs: 30_000 });

    expect(grant.token).toMatch(/^c2c_ctx_[A-Za-z0-9_-]{43}$/);
    expect(grant.token.length).toBeGreaterThan(40);
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

  it("enforces one active turn while allowing parallel and sequential leases", () => {
    const broker = new TurnCapabilityBroker({ maxCapabilities: 4, maxLeasesPerTurn: 2 });
    const first = broker.issue(binding({ taskId: "first" }));
    const second = broker.issue(binding({ taskId: "second" }));
    const firstLease = broker.claim(first.token, binding({ taskId: "first" }));
    const parallelLease = broker.claim(first.token, binding({ taskId: "first" }));

    expect(parallelLease.leaseId).not.toBe(firstLease.leaseId);
    expect(broker.status(first.token).activeLeaseCount).toBe(2);
    expectCode(() => broker.claim(second.token, binding({ taskId: "second" })), "ACTIVE_TURN_LIMIT");

    expect(broker.release(first.token, firstLease.leaseId)).toEqual({ released: true });
    const sequentialLease = broker.claim(first.token, binding({ taskId: "first" }));
    expect(sequentialLease.leaseId).not.toBe(firstLease.leaseId);
    expect(broker.status(first.token).activeLeaseCount).toBe(2);
    expectCode(() => broker.claim(first.token, binding({ taskId: "first" })), "LEASE_CAPACITY_EXCEEDED");

    broker.release(first.token, parallelLease.leaseId);
    broker.release(first.token, sequentialLease.leaseId);
    expect(broker.stats().activeTurnCount).toBe(1);
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
    const broker = new TurnCapabilityBroker({ maxTombstones: 2, maxCapabilities: 4 });
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

  it("drains leases after cancellation and keeps the active slot occupied", () => {
    const broker = new TurnCapabilityBroker({ maxCapabilities: 4 });
    const cancelled = broker.issue(binding({ taskId: "draining" }));
    const lease = broker.claim(cancelled.token, binding({ taskId: "draining" }));
    broker.cancel(cancelled.token);

    expect(broker.status(cancelled.token)).toMatchObject({ status: "cancelled", activeLeaseCount: 1 });
    expect(broker.stats().activeTurnCount).toBe(1);
    const waiting = broker.issue(binding({ taskId: "waiting" }));
    expectCode(() => broker.claim(waiting.token, binding({ taskId: "waiting" })), "ACTIVE_TURN_LIMIT");
    expect(broker.validateLease(lease)).toBe(lease);
    expect(broker.release(cancelled.token, lease.leaseId)).toEqual({ released: true });
    expectCode(() => broker.validateLease(lease), "LEASE_NOT_FOUND");
    expect(broker.status(cancelled.token)).toMatchObject({ status: "cancelled", activeLeaseCount: 0 });
    expect(broker.stats().activeTurnCount).toBe(0);
    expect(broker.claim(waiting.token, binding({ taskId: "waiting" }))).toBeTruthy();
  });

  it("bounds retained tombstones while cancelled and revoked turns drain", () => {
    let now = 30_000;
    const broker = new TurnCapabilityBroker({
      now: () => now,
      maxActiveTurns: 2,
      maxCapabilities: 3,
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

  it("bounds live capability storage and fences broker restarts by boot epoch", () => {
    const broker = new TurnCapabilityBroker({ maxCapabilities: 2 });
    const first = broker.issue(binding({ taskId: "one" }));
    broker.issue(binding({ taskId: "two" }));
    expectCode(() => broker.issue(binding({ taskId: "three" })), "CAPABILITY_CAPACITY_EXCEEDED");

    const restarted = new TurnCapabilityBroker();
    expect(restarted.bootEpoch).not.toBe(broker.bootEpoch);
    expect(restarted.status(first.token).status).toBe("unknown");
    expectCode(() => restarted.claim(first.token, binding({ taskId: "one" })), "TOKEN_NOT_FOUND");
  });

  it("reuses capacity by evicting only old tombstones", () => {
    const broker = new TurnCapabilityBroker({ maxCapabilities: 2, maxTombstones: 2 });

    for (let index = 0; index < 6; index += 1) {
      const grant = broker.issue(binding({ taskId: `cycle-${index}` }));
      const lease = broker.claim(grant.token, binding({ taskId: `cycle-${index}` }));
      const fence = broker.beginCompletion(grant.token, binding({ taskId: `cycle-${index}` }));
      broker.release(grant.token, lease.leaseId);
      broker.complete(fence.fence);
      expect(broker.stats().capabilityCount).toBeLessThanOrEqual(2);
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
