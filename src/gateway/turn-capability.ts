import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "c2c_ctx_";
const LEASE_PREFIX = "c2c_lease_";
const FENCE_PREFIX = "c2c_fence_";
const TOKEN_BYTES = 32;
const DEFAULT_CAPABILITY_TTL_MS = 30 * 60_000;
const MIN_CAPABILITY_TTL_MS = 1_000;
const MAX_CAPABILITY_TTL_MS = 60 * 60_000;
const DEFAULT_LEASE_TTL_MS = 15_000;
const MIN_LEASE_TTL_MS = 100;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_TOMBSTONES = 128;

export type TurnCapabilityState =
  | "issued"
  | "active"
  | "completing"
  | "completed"
  | "cancelled"
  | "revoked"
  | "expired";

export type TurnCapabilityErrorCode =
  | "INVALID_BINDING"
  | "INVALID_TOKEN"
  | "TOKEN_NOT_FOUND"
  | "TOKEN_EXPIRED"
  | "TOKEN_CANCELLED"
  | "TOKEN_REVOKED"
  | "TOKEN_COMPLETED"
  | "BOOT_EPOCH_MISMATCH"
  | "BINDING_MISMATCH"
  | "SCOPE_DENIED"
  | "STALE_BINDING_EPOCH"
  | "INVALID_TTL"
  | "LEASE_NOT_FOUND"
  | "LEASE_EXPIRED"
  | "NOT_CLAIMED"
  | "COMPLETION_ALREADY_STARTED"
  | "ACTIVE_LEASES_REMAIN"
  | "COMPLETION_FENCE_INVALID"
  | "COMPLETION_FENCE_REPLAYED";

export class TurnCapabilityError extends Error {
  readonly code: TurnCapabilityErrorCode;

  constructor(code: TurnCapabilityErrorCode, message: string) {
    super(message);
    this.name = "TurnCapabilityError";
    this.code = code;
  }
}

export interface TurnCapabilityBinding {
  workspaceId: string;
  projectId: string;
  registrationId: string;
  localSessionId: string;
  taskId: string;
  iteration: number;
  phase: string;
  /** Exact mailbox request authorized by this control turn. BOOT has no mailbox request. */
  requestId?: string;
  scopes: readonly string[];
  modelId?: string;
  effort?: string;
  compactionEpoch: number;
  generation: number;
}

export type TurnRequestBinding = Pick<
  TurnCapabilityBinding,
  "workspaceId" | "projectId" | "localSessionId" | "taskId" | "iteration" | "phase"
> & {
  requestId: string;
};

export interface IssueTurnCapabilityInput extends TurnCapabilityBinding {
  ttlMs?: number;
}

export interface TurnCapabilityGrant {
  readonly token: string;
  readonly binding: TurnCapabilityBinding;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly bootEpoch: string;
}

export interface TurnClaimOptions {
  requiredScopes?: readonly string[];
  leaseTtlMs?: number;
}

export interface TurnLease {
  readonly leaseId: string;
  readonly binding: TurnCapabilityBinding;
  readonly leaseExpiresAt: string;
  readonly capabilityExpiresAt: string;
  readonly bootEpoch: string;
}

export interface TurnReleaseReceipt {
  readonly released: boolean;
}

export interface TurnCompletionFence {
  readonly fence: string;
  readonly ready: boolean;
  readonly activeLeaseCount: number;
  readonly capabilityExpiresAt: string;
  readonly bootEpoch: string;
}

export interface TurnCompletionReceipt {
  readonly status: "completed";
  readonly completedAt: string;
}

export interface TurnCompletionAbortReceipt {
  readonly status: "active";
}

export interface TurnCapabilityStatus {
  readonly status: TurnCapabilityState | "unknown";
  readonly bootEpoch?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly binding?: TurnCapabilityBinding;
  readonly activeLeaseCount: number;
  readonly completionReady: boolean;
}

export interface TurnCapabilityStats {
  readonly bootEpoch: string;
  readonly capabilityCount: number;
  readonly activeTurnCount: number;
  /** Includes terminal turns that are still draining live leases. */
  readonly tombstoneCount: number;
  /** Terminal turns that cannot yet be evicted because work is in flight. */
  readonly drainingTurnCount: number;
  readonly maxTombstones: number;
}

export interface TurnCapabilityBrokerOptions {
  /** Maximum terminal records retained after all activity leases drain. */
  maxTombstones?: number;
  now?: () => number;
}

interface CapabilityRecord {
  readonly tokenHash: string;
  readonly bootEpoch: string;
  readonly binding: TurnCapabilityBinding;
  readonly issuedAt: number;
  readonly expiresAt: number;
  state: TurnCapabilityState;
  claimedAt?: number;
  readonly leases: Map<string, number>;
  readonly expiredLeaseHashes: Set<string>;
  completionFenceHash?: string;
  terminalAt?: number;
}

interface LeaseProvenance {
  readonly tokenHash: string;
  readonly leaseHash: string;
}

interface SessionEpoch {
  readonly compactionEpoch: number;
  readonly generation: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function isValidSecret(value: string, prefix: string): boolean {
  return typeof value === "string" && new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(value);
}

function safeString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TurnCapabilityError("INVALID_BINDING", `${label} is invalid`);
  }
  return value;
}

function safeCounter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TurnCapabilityError("INVALID_BINDING", `${label} is invalid`);
  }
  return value as number;
}

function normalizeScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new TurnCapabilityError("INVALID_BINDING", "scopes are invalid");
  }
  const scopes = value.map((scope) => safeString(scope, "scope"));
  return Object.freeze([...new Set(scopes)].sort());
}

function normalizeBinding(input: TurnCapabilityBinding): TurnCapabilityBinding {
  if (!input || typeof input !== "object") {
    throw new TurnCapabilityError("INVALID_BINDING", "turn binding is invalid");
  }
  const phase = safeString(input.phase, "phase");
  const requestId = input.requestId === undefined
    ? undefined
    : safeString(input.requestId, "requestId");
  if (phase === "BOOT" ? requestId !== undefined : requestId === undefined) {
    throw new TurnCapabilityError(
      "INVALID_BINDING",
      phase === "BOOT"
        ? "BOOT turn capability must not bind a mailbox request"
        : "control turn capability must bind an exact mailbox request"
    );
  }
  return Object.freeze({
    workspaceId: safeString(input.workspaceId, "workspaceId"),
    projectId: safeString(input.projectId, "projectId"),
    registrationId: safeString(input.registrationId, "registrationId"),
    localSessionId: safeString(input.localSessionId, "localSessionId"),
    taskId: safeString(input.taskId, "taskId"),
    iteration: safeCounter(input.iteration, "iteration"),
    phase,
    requestId,
    scopes: normalizeScopes(input.scopes),
    modelId: input.modelId === undefined ? undefined : safeString(input.modelId, "modelId"),
    effort: input.effort === undefined ? undefined : safeString(input.effort, "effort"),
    compactionEpoch: safeCounter(input.compactionEpoch, "compactionEpoch"),
    generation: safeCounter(input.generation, "generation"),
  });
}

function sameBinding(left: TurnCapabilityBinding, right: TurnCapabilityBinding): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.registrationId === right.registrationId &&
    left.localSessionId === right.localSessionId &&
    left.taskId === right.taskId &&
    left.iteration === right.iteration &&
    left.phase === right.phase &&
    left.requestId === right.requestId &&
    left.modelId === right.modelId &&
    left.effort === right.effort &&
    left.compactionEpoch === right.compactionEpoch &&
    left.generation === right.generation &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index])
  );
}

function assertTtl(value: number, min: number, max: number, code: TurnCapabilityErrorCode): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TurnCapabilityError(code, "requested lifetime is outside the allowed range");
  }
  return value;
}

function cloneBinding(binding: TurnCapabilityBinding): TurnCapabilityBinding {
  return Object.freeze({ ...binding, scopes: Object.freeze([...binding.scopes]) });
}

function errorForTerminalState(state: TurnCapabilityState): TurnCapabilityError {
  switch (state) {
    case "expired":
      return new TurnCapabilityError("TOKEN_EXPIRED", "turn capability has expired");
    case "cancelled":
      return new TurnCapabilityError("TOKEN_CANCELLED", "turn capability was cancelled");
    case "revoked":
      return new TurnCapabilityError("TOKEN_REVOKED", "turn capability was revoked");
    case "completed":
      return new TurnCapabilityError("TOKEN_COMPLETED", "turn capability has completed");
    default:
      return new TurnCapabilityError("TOKEN_NOT_FOUND", "turn capability is not available");
  }
}

/**
 * In-memory security kernel for one machine gateway process. A broker restart
 * intentionally drops every record and creates a new boot epoch, invalidating
 * all tokens issued by the previous process.
 */
export class TurnCapabilityBroker {
  readonly bootEpoch: string;

  private readonly records = new Map<string, CapabilityRecord>();
  private readonly completionFences = new Map<string, string>();
  private readonly usedCompletionFences = new Set<string>();
  private readonly leaseProvenance = new WeakMap<object, LeaseProvenance>();
  private readonly sessionEpochs = new Map<string, SessionEpoch>();
  private readonly maxTombstones: number;
  private readonly now: () => number;

  constructor(options: TurnCapabilityBrokerOptions = {}) {
    this.bootEpoch = randomBytes(16).toString("hex");
    this.maxTombstones = this.nonNegativeLimit(options.maxTombstones, DEFAULT_MAX_TOMBSTONES, "maxTombstones");
    this.now = options.now ?? (() => Date.now());
  }

  issue(input: IssueTurnCapabilityInput): TurnCapabilityGrant {
    const { binding, ttlMs } = this.prepareIssue(input);
    const now = this.now();
    this.prune(now);
    return this.issueNormalized(binding, ttlMs, now);
  }

  /** Atomically supersede all live capabilities belonging to one local session. */
  issueReplacingSession(input: IssueTurnCapabilityInput): TurnCapabilityGrant {
    const { binding, ttlMs } = this.prepareIssue(input);
    const now = this.now();
    this.assertFreshSessionEpoch(binding);
    this.prune(now);
    this.assertNoActiveSessionLeases(binding);
    for (const record of this.records.values()) {
      if (this.isTombstone(record.state) || !this.sameSession(record.binding, binding)) continue;
      this.terminate(record, "revoked", now);
    }
    this.trimTombstones();
    const grant = this.issueNormalized(binding, ttlMs, now);
    this.sessionEpochs.set(this.sessionKey(binding), {
      compactionEpoch: binding.compactionEpoch,
      generation: binding.generation,
    });
    return grant;
  }

  private prepareIssue(input: IssueTurnCapabilityInput): { binding: TurnCapabilityBinding; ttlMs: number } {
    const binding = normalizeBinding(input);
    const ttlMs = assertTtl(
      input.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS,
      MIN_CAPABILITY_TTL_MS,
      MAX_CAPABILITY_TTL_MS,
      "INVALID_TTL"
    );
    return { binding, ttlMs };
  }

  private issueNormalized(binding: TurnCapabilityBinding, ttlMs: number, now: number): TurnCapabilityGrant {
    const token = randomSecret(TOKEN_PREFIX);
    const tokenHash = sha256(token);
    const expiresAt = now + ttlMs;
    this.records.set(tokenHash, {
      tokenHash,
      bootEpoch: this.bootEpoch,
      binding,
      issuedAt: now,
      expiresAt,
      state: "issued",
      leases: new Map(),
      expiredLeaseHashes: new Set(),
    });
    return {
      token,
      binding: cloneBinding(binding),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      bootEpoch: this.bootEpoch,
    };
  }

  claim(token: string, expectedBinding: TurnCapabilityBinding, options: TurnClaimOptions = {}): TurnLease {
    const record = this.resolveLiveToken(token);
    const expected = normalizeBinding(expectedBinding);
    this.assertBinding(record, expected);
    const requiredScopes = normalizeScopes(options.requiredScopes ?? []);
    if (!requiredScopes.every((scope) => record.binding.scopes.includes(scope))) {
      throw new TurnCapabilityError("SCOPE_DENIED", "requested scope is not granted by the turn capability");
    }
    if (record.state === "completing") {
      throw new TurnCapabilityError(
        "COMPLETION_ALREADY_STARTED",
        "completion has already started; new activity claims are closed"
      );
    }
    if (record.state !== "issued" && record.state !== "active") {
      throw errorForTerminalState(record.state);
    }
    const requestedLeaseTtl = assertTtl(
      options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      MIN_LEASE_TTL_MS,
      MAX_LEASE_TTL_MS,
      "INVALID_TTL"
    );
    const now = this.now();
    const leaseExpiresAt = Math.min(now + requestedLeaseTtl, record.expiresAt);
    if (leaseExpiresAt <= now) {
      this.expire(record, now);
      throw new TurnCapabilityError("TOKEN_EXPIRED", "turn capability has expired");
    }
    const leaseId = randomSecret(LEASE_PREFIX);
    const leaseHash = sha256(leaseId);
    record.state = "active";
    record.claimedAt ??= now;
    record.leases.set(leaseHash, leaseExpiresAt);
    const lease = Object.freeze({
      leaseId,
      binding: cloneBinding(record.binding),
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
      capabilityExpiresAt: new Date(record.expiresAt).toISOString(),
      bootEpoch: this.bootEpoch,
    });
    this.leaseProvenance.set(lease, { tokenHash: record.tokenHash, leaseHash });
    return lease;
  }

  renew(
    token: string,
    leaseId: string,
    expectedBinding: TurnCapabilityBinding,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS
  ): string {
    const record = this.resolveLiveToken(token);
    const expected = normalizeBinding(expectedBinding);
    this.assertBinding(record, expected);
    if (record.state !== "active" && record.state !== "completing") {
      throw errorForTerminalState(record.state);
    }
    const leaseHash = this.assertLease(record, leaseId);
    const ttl = assertTtl(leaseTtlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS, "INVALID_TTL");
    const now = this.now();
    const leaseExpiresAt = Math.min(now + ttl, record.expiresAt);
    if (leaseExpiresAt <= now) {
      this.expire(record, now);
      throw new TurnCapabilityError("TOKEN_EXPIRED", "turn capability has expired");
    }
    record.leases.set(leaseHash, leaseExpiresAt);
    return new Date(leaseExpiresAt).toISOString();
  }

  release(token: string, leaseId: string): TurnReleaseReceipt {
    const record = this.resolveLiveToken(token, true);
    this.clearExpiredLeases(record);
    if (!isValidSecret(leaseId, LEASE_PREFIX)) return { released: false };
    if (!record.leases.delete(sha256(leaseId))) return { released: false };
    this.trimTombstones();
    return { released: true };
  }

  beginCompletion(token: string, expectedBinding: TurnCapabilityBinding): TurnCompletionFence {
    const record = this.resolveLiveToken(token);
    const expected = normalizeBinding(expectedBinding);
    this.assertBinding(record, expected);
    if (record.state === "completing") {
      throw new TurnCapabilityError(
        "COMPLETION_ALREADY_STARTED",
        "completion has already started; the original fence is required"
      );
    }
    if (record.state !== "active") {
      if (record.state === "issued") {
        throw new TurnCapabilityError("NOT_CLAIMED", "turn capability must be claimed before completion");
      }
      throw errorForTerminalState(record.state);
    }
    this.clearExpiredLeases(record);
    const fence = randomSecret(FENCE_PREFIX);
    const fenceHash = sha256(fence);
    record.state = "completing";
    record.completionFenceHash = fenceHash;
    this.completionFences.set(fenceHash, record.tokenHash);
    return {
      fence,
      ready: record.leases.size === 0,
      activeLeaseCount: record.leases.size,
      capabilityExpiresAt: new Date(record.expiresAt).toISOString(),
      bootEpoch: this.bootEpoch,
    };
  }

  /**
   * Verify that a completion fence was issued for this exact turn. A fence is
   * intentionally opaque to callers, so completion APIs must establish its
   * ownership before publishing any external result.
   */
  assertCompletionFence(
    token: string,
    expectedBinding: TurnCapabilityBinding,
    fence: string,
  ): void {
    const record = this.resolveLiveToken(token);
    const expected = normalizeBinding(expectedBinding);
    this.assertBinding(record, expected);
    const fenceHash = this.resolveFenceHash(fence);
    if (
      record.state !== "completing" ||
      record.completionFenceHash !== fenceHash ||
      this.completionFences.get(fenceHash) !== record.tokenHash
    ) {
      throw new TurnCapabilityError(
        "COMPLETION_FENCE_INVALID",
        "completion fence does not belong to this turn",
      );
    }
  }

  complete(fence: string): TurnCompletionReceipt {
    const fenceHash = this.resolveFenceHash(fence);
    const tokenHash = this.completionFences.get(fenceHash);
    if (!tokenHash) {
      throw new TurnCapabilityError("COMPLETION_FENCE_INVALID", "completion fence is not valid");
    }
    const record = this.records.get(tokenHash);
    if (!record || record.bootEpoch !== this.bootEpoch) {
      throw new TurnCapabilityError("BOOT_EPOCH_MISMATCH", "completion fence belongs to another broker epoch");
    }
    this.prune(this.now());
    if (record.state !== "completing") throw errorForTerminalState(record.state);
    this.clearExpiredLeases(record);
    if (record.leases.size > 0) {
      throw new TurnCapabilityError("ACTIVE_LEASES_REMAIN", "active leases must be released before completion");
    }
    const now = this.now();
    this.completionFences.delete(fenceHash);
    this.usedCompletionFences.add(fenceHash);
    record.completionFenceHash = undefined;
    record.state = "completed";
    record.terminalAt = now;
    this.trimTombstones();
    return { status: "completed", completedAt: new Date(now).toISOString() };
  }

  /**
   * Re-open a completing turn when its external commit did not succeed.
   * The abandoned fence is consumed so it can never complete a later retry.
   */
  abortCompletion(fence: string): TurnCompletionAbortReceipt {
    const fenceHash = this.resolveFenceHash(fence);
    const tokenHash = this.completionFences.get(fenceHash);
    if (!tokenHash) {
      throw new TurnCapabilityError("COMPLETION_FENCE_INVALID", "completion fence is not valid");
    }
    const record = this.records.get(tokenHash);
    if (!record || record.bootEpoch !== this.bootEpoch) {
      throw new TurnCapabilityError("BOOT_EPOCH_MISMATCH", "completion fence belongs to another broker epoch");
    }
    this.prune(this.now());
    if (record.state !== "completing" || record.completionFenceHash !== fenceHash) {
      throw errorForTerminalState(record.state);
    }
    this.completionFences.delete(fenceHash);
    this.usedCompletionFences.add(fenceHash);
    record.completionFenceHash = undefined;
    record.state = "active";
    return { status: "active" };
  }

  cancel(token: string): void {
    const record = this.resolveLiveToken(token);
    if (record.state === "completed" || record.state === "cancelled" || record.state === "revoked" || record.state === "expired") {
      throw errorForTerminalState(record.state);
    }
    this.terminate(record, "cancelled", this.now());
    this.trimTombstones();
  }

  revoke(token: string): void {
    const record = this.resolveLiveToken(token);
    if (record.state === "completed" || record.state === "cancelled" || record.state === "revoked" || record.state === "expired") {
      throw errorForTerminalState(record.state);
    }
    this.terminate(record, "revoked", this.now());
    this.trimTombstones();
  }

  /** Revoke every live capability for one exact turn binding without a token. */
  revokeBinding(binding: TurnCapabilityBinding): number {
    const expected = normalizeBinding(binding);
    const now = this.now();
    this.prune(now);
    let revokedCount = 0;
    for (const record of this.records.values()) {
      if (this.isTombstone(record.state) || !sameBinding(record.binding, expected)) continue;
      this.terminate(record, "revoked", now);
      revokedCount += 1;
    }
    this.trimTombstones();
    return revokedCount;
  }

  /** Revoke all live capabilities for one exact control request without a token. */
  revokeRequest(binding: TurnRequestBinding): number {
    const expected = {
      workspaceId: safeString(binding.workspaceId, "workspaceId"),
      projectId: safeString(binding.projectId, "projectId"),
      localSessionId: safeString(binding.localSessionId, "localSessionId"),
      taskId: safeString(binding.taskId, "taskId"),
      iteration: safeCounter(binding.iteration, "iteration"),
      phase: safeString(binding.phase, "phase"),
      requestId: safeString(binding.requestId, "requestId"),
    };
    const now = this.now();
    this.prune(now);
    let revokedCount = 0;
    for (const record of this.records.values()) {
      if (
        this.isTombstone(record.state) ||
        record.binding.workspaceId !== expected.workspaceId ||
        record.binding.projectId !== expected.projectId ||
        record.binding.localSessionId !== expected.localSessionId ||
        record.binding.taskId !== expected.taskId ||
        record.binding.iteration !== expected.iteration ||
        record.binding.phase !== expected.phase ||
        record.binding.requestId !== expected.requestId
      ) {
        continue;
      }
      this.terminate(record, "revoked", now);
      revokedCount += 1;
    }
    this.trimTombstones();
    return revokedCount;
  }

  /** Revoke every live capability and epoch retained for one local session. */
  revokeSession(workspaceId: string, projectId: string, localSessionId: string): number {
    const expectedWorkspaceId = safeString(workspaceId, "workspaceId");
    const expectedProjectId = safeString(projectId, "projectId");
    const expectedLocalSessionId = safeString(localSessionId, "localSessionId");
    const now = this.now();
    this.prune(now);
    let revokedCount = 0;
    for (const record of this.records.values()) {
      if (
        this.isTombstone(record.state) ||
        record.binding.workspaceId !== expectedWorkspaceId ||
        record.binding.projectId !== expectedProjectId ||
        record.binding.localSessionId !== expectedLocalSessionId
      ) {
        continue;
      }
      this.terminate(record, "revoked", now);
      revokedCount += 1;
    }
    const epochPrefix = `${expectedWorkspaceId}\u0000${expectedProjectId}\u0000`;
    const epochSuffix = `\u0000${expectedLocalSessionId}`;
    for (const key of this.sessionEpochs.keys()) {
      if (key.startsWith(epochPrefix) && key.endsWith(epochSuffix)) {
        this.sessionEpochs.delete(key);
      }
    }
    this.trimTombstones();
    return revokedCount;
  }

  /** Revoke every live capability registered by one exact workspace identity. */
  revokeRegistration(workspaceId: string, projectId: string, registrationId: string): number {
    const expectedWorkspaceId = safeString(workspaceId, "workspaceId");
    const expectedProjectId = safeString(projectId, "projectId");
    const expectedRegistrationId = safeString(registrationId, "registrationId");
    const now = this.now();
    this.prune(now);
    let revokedCount = 0;
    for (const record of this.records.values()) {
      if (
        this.isTombstone(record.state) ||
        record.binding.workspaceId !== expectedWorkspaceId ||
        record.binding.projectId !== expectedProjectId ||
        record.binding.registrationId !== expectedRegistrationId
      ) {
        continue;
      }
      this.terminate(record, "revoked", now);
      revokedCount += 1;
    }
    this.trimTombstones();
    return revokedCount;
  }

  status(token: string): TurnCapabilityStatus {
    if (!isValidSecret(token, TOKEN_PREFIX)) return { status: "unknown", activeLeaseCount: 0, completionReady: false };
    const tokenHash = sha256(token);
    this.prune(this.now());
    const record = this.records.get(tokenHash);
    if (!record || record.bootEpoch !== this.bootEpoch) {
      return { status: "unknown", activeLeaseCount: 0, completionReady: false };
    }
    this.clearExpiredLeases(record);
    return {
      status: record.state,
      bootEpoch: record.bootEpoch,
      issuedAt: new Date(record.issuedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      binding: cloneBinding(record.binding),
      activeLeaseCount: record.leases.size,
      completionReady: record.state === "completing" && record.leases.size === 0,
    };
  }

  /** Return the exact binding only while the capability is nonterminal. */
  assertLive(token: string): TurnCapabilityBinding {
    return cloneBinding(this.resolveLiveToken(token).binding);
  }

  /**
   * Validate that a lease object was issued by this broker instance and is
   * still live. The object identity is intentionally part of the proof so a
   * structurally identical object cannot be substituted by data-plane input.
   */
  validateLease(lease: unknown): TurnLease {
    if (lease === null || typeof lease !== "object") {
      throw new TurnCapabilityError("LEASE_NOT_FOUND", "activity lease was not issued by this broker");
    }
    const provenance = this.leaseProvenance.get(lease);
    if (!provenance) {
      throw new TurnCapabilityError("LEASE_NOT_FOUND", "activity lease was not issued by this broker");
    }
    this.prune(this.now());
    const record = this.records.get(provenance.tokenHash);
    if (!record || record.bootEpoch !== this.bootEpoch) {
      throw new TurnCapabilityError("LEASE_NOT_FOUND", "activity lease is not active");
    }
    if (record.expiredLeaseHashes.has(provenance.leaseHash)) {
      throw new TurnCapabilityError("LEASE_EXPIRED", "activity lease has expired");
    }
    if (!record.leases.has(provenance.leaseHash)) {
      throw new TurnCapabilityError("LEASE_NOT_FOUND", "activity lease is not active");
    }
    return lease as TurnLease;
  }

  stats(): TurnCapabilityStats {
    this.prune(this.now());
    return {
      bootEpoch: this.bootEpoch,
      capabilityCount: this.records.size,
      activeTurnCount: this.activeTurnCount(),
      tombstoneCount: [...this.records.values()].filter((record) => this.isTombstone(record.state)).length,
      drainingTurnCount: [...this.records.values()].filter(
        (record) => this.isTombstone(record.state) && record.leases.size > 0
      ).length,
      maxTombstones: this.maxTombstones,
    };
  }

  private resolveLiveToken(token: string, allowTerminal = false): CapabilityRecord {
    if (!isValidSecret(token, TOKEN_PREFIX)) {
      throw new TurnCapabilityError("INVALID_TOKEN", "turn capability format is invalid");
    }
    const tokenHash = sha256(token);
    this.prune(this.now());
    const record = this.records.get(tokenHash);
    if (!record) throw new TurnCapabilityError("TOKEN_NOT_FOUND", "turn capability is not available");
    if (record.bootEpoch !== this.bootEpoch) {
      throw new TurnCapabilityError("BOOT_EPOCH_MISMATCH", "turn capability belongs to another broker epoch");
    }
    if (this.isTombstone(record.state) && !allowTerminal) throw errorForTerminalState(record.state);
    return record;
  }

  private resolveFenceHash(fence: string): string {
    if (!isValidSecret(fence, FENCE_PREFIX)) {
      throw new TurnCapabilityError("COMPLETION_FENCE_INVALID", "completion fence format is invalid");
    }
    const fenceHash = sha256(fence);
    if (this.usedCompletionFences.has(fenceHash)) {
      throw new TurnCapabilityError("COMPLETION_FENCE_REPLAYED", "completion fence was already consumed");
    }
    return fenceHash;
  }

  private assertBinding(record: CapabilityRecord, expected: TurnCapabilityBinding): void {
    if (!sameBinding(record.binding, expected)) {
      throw new TurnCapabilityError("BINDING_MISMATCH", "turn capability binding does not match");
    }
  }

  private assertLease(record: CapabilityRecord, leaseId: string): string {
    if (!isValidSecret(leaseId, LEASE_PREFIX)) {
      throw new TurnCapabilityError("LEASE_NOT_FOUND", "activity lease is not active");
    }
    const leaseHash = sha256(leaseId);
    if (record.expiredLeaseHashes.has(leaseHash)) {
      throw new TurnCapabilityError("LEASE_EXPIRED", "activity lease has expired");
    }
    const leaseExpiresAt = record.leases.get(leaseHash);
    if (leaseExpiresAt === undefined) {
      throw new TurnCapabilityError("LEASE_NOT_FOUND", "activity lease is not active");
    }
    if (leaseExpiresAt <= this.now()) {
      this.clearExpiredLeases(record);
      throw new TurnCapabilityError("LEASE_EXPIRED", "activity lease has expired");
    }
    return leaseHash;
  }

  private clearExpiredLeases(record: CapabilityRecord): void {
    const now = this.now();
    for (const [leaseHash, leaseExpiresAt] of record.leases) {
      if (leaseExpiresAt <= now) {
        record.leases.delete(leaseHash);
        record.expiredLeaseHashes.add(leaseHash);
      }
    }
  }

  private expire(record: CapabilityRecord, now: number): void {
    if (this.isTombstone(record.state)) return;
    this.terminate(record, "expired", now);
  }

  private terminate(record: CapabilityRecord, state: "cancelled" | "revoked" | "expired", now: number): void {
    if (record.completionFenceHash) {
      this.completionFences.delete(record.completionFenceHash);
      this.usedCompletionFences.add(record.completionFenceHash);
      record.completionFenceHash = undefined;
    }
    record.state = state;
    record.terminalAt = now;
  }

  private prune(now: number): void {
    for (const record of this.records.values()) {
      if (!this.isTombstone(record.state) && now >= record.expiresAt) this.expire(record, now);
      this.clearExpiredLeases(record);
    }
    this.trimTombstones();
  }

  private trimTombstones(): void {
    const tombstones = [...this.records.values()]
      .filter((record) => this.isTombstone(record.state) && record.leases.size === 0)
      .sort((left, right) => (left.terminalAt ?? 0) - (right.terminalAt ?? 0));
    while (tombstones.length > this.maxTombstones) {
      const oldest = tombstones.shift();
      if (!oldest) break;
      this.records.delete(oldest.tokenHash);
    }
    while (this.usedCompletionFences.size > this.maxTombstones) {
      const oldest = this.usedCompletionFences.values().next().value as string | undefined;
      if (!oldest) break;
      this.usedCompletionFences.delete(oldest);
    }
  }

  private assertNoActiveSessionLeases(binding: TurnCapabilityBinding): void {
    for (const record of this.records.values()) {
      if (this.sameSession(record.binding, binding) && record.leases.size > 0) {
        throw new TurnCapabilityError(
          "ACTIVE_LEASES_REMAIN",
          "active leases must be released before replacing a session turn"
        );
      }
    }
  }

  private sameSession(left: TurnCapabilityBinding, right: TurnCapabilityBinding): boolean {
    return (
      left.workspaceId === right.workspaceId &&
      left.projectId === right.projectId &&
      left.registrationId === right.registrationId &&
      left.localSessionId === right.localSessionId
    );
  }

  private sessionKey(binding: TurnCapabilityBinding): string {
    return [
      binding.workspaceId,
      binding.projectId,
      binding.registrationId,
      binding.localSessionId,
    ].join("\u0000");
  }

  private assertFreshSessionEpoch(binding: TurnCapabilityBinding): void {
    const current = this.sessionEpochs.get(this.sessionKey(binding));
    if (
      current &&
      (binding.compactionEpoch < current.compactionEpoch || binding.generation < current.generation)
    ) {
      throw new TurnCapabilityError(
        "STALE_BINDING_EPOCH",
        "turn capability belongs to an older session or page generation"
      );
    }
  }

  private isTombstone(state: TurnCapabilityState): boolean {
    return state === "completed" || state === "cancelled" || state === "revoked" || state === "expired";
  }

  private activeTurnCount(): number {
    return [...this.records.values()].filter(
      (record) =>
        record.state === "active" ||
        record.state === "completing" ||
        (this.isTombstone(record.state) && record.leases.size > 0)
    ).length;
  }

  private nonNegativeLimit(value: number | undefined, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 0) throw new TurnCapabilityError("INVALID_BINDING", `${label} is invalid`);
    return value;
  }
}
