import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "c2c_ctx_";
const LEASE_PREFIX = "c2c_lease_";
const FENCE_PREFIX = "c2c_fence_";
const TOKEN_BYTES = 32;
const DEFAULT_CAPABILITY_TTL_MS = 5 * 60_000;
const MIN_CAPABILITY_TTL_MS = 1_000;
const MAX_CAPABILITY_TTL_MS = 60 * 60_000;
const DEFAULT_LEASE_TTL_MS = 15_000;
const MIN_LEASE_TTL_MS = 100;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ACTIVE_TURNS = 1;
const DEFAULT_MAX_CAPABILITIES = 128;
const DEFAULT_MAX_TOMBSTONES = 128;
const DEFAULT_MAX_LEASES_PER_TURN = 16;

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
  | "ACTIVE_TURN_LIMIT"
  | "CAPABILITY_CAPACITY_EXCEEDED"
  | "LEASE_CAPACITY_EXCEEDED"
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
  scopes: readonly string[];
  modelId?: string;
  effort?: string;
  compactionEpoch: number;
  generation: number;
}

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
  readonly maxActiveTurns: number;
  readonly maxCapabilities: number;
  readonly maxTombstones: number;
  readonly maxLeasesPerTurn: number;
}

export interface TurnCapabilityBrokerOptions {
  maxActiveTurns?: number;
  maxCapabilities?: number;
  /** Maximum terminal records retained after all activity leases drain. */
  maxTombstones?: number;
  maxLeasesPerTurn?: number;
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
  return Object.freeze({
    workspaceId: safeString(input.workspaceId, "workspaceId"),
    projectId: safeString(input.projectId, "projectId"),
    registrationId: safeString(input.registrationId, "registrationId"),
    localSessionId: safeString(input.localSessionId, "localSessionId"),
    taskId: safeString(input.taskId, "taskId"),
    iteration: safeCounter(input.iteration, "iteration"),
    phase: safeString(input.phase, "phase"),
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
  private readonly maxActiveTurns: number;
  private readonly maxCapabilities: number;
  private readonly maxTombstones: number;
  private readonly maxLeasesPerTurn: number;
  private readonly now: () => number;

  constructor(options: TurnCapabilityBrokerOptions = {}) {
    this.bootEpoch = randomBytes(16).toString("hex");
    this.maxActiveTurns = this.positiveLimit(options.maxActiveTurns, DEFAULT_MAX_ACTIVE_TURNS, "maxActiveTurns");
    this.maxCapabilities = this.positiveLimit(
      options.maxCapabilities,
      DEFAULT_MAX_CAPABILITIES,
      "maxCapabilities"
    );
    this.maxTombstones = this.nonNegativeLimit(options.maxTombstones, DEFAULT_MAX_TOMBSTONES, "maxTombstones");
    this.maxLeasesPerTurn = this.positiveLimit(
      options.maxLeasesPerTurn,
      DEFAULT_MAX_LEASES_PER_TURN,
      "maxLeasesPerTurn"
    );
    this.now = options.now ?? (() => Date.now());
  }

  issue(input: IssueTurnCapabilityInput): TurnCapabilityGrant {
    const { binding, ttlMs } = this.prepareIssue(input);
    const now = this.now();
    this.prune(now);
    return this.issueNormalized(binding, ttlMs, now);
  }

  /**
   * Atomically supersede all live capabilities belonging to one local
   * session, then issue the replacement capability. Validation and a pure
   * capacity preflight happen before any prior capability is revoked.
   */
  issueReplacingSession(input: IssueTurnCapabilityInput): TurnCapabilityGrant {
    const { binding, ttlMs } = this.prepareIssue(input);
    const now = this.now();
    if (!this.canIssueAfterReplacing(binding, now)) {
      throw new TurnCapabilityError(
        "CAPABILITY_CAPACITY_EXCEEDED",
        "turn capability capacity is exhausted"
      );
    }
    this.prune(now);
    for (const record of this.records.values()) {
      if (this.isTombstone(record.state) || !this.sameSession(record.binding, binding)) continue;
      this.terminate(record, "revoked", now);
    }
    this.trimTombstones();
    return this.issueNormalized(binding, ttlMs, now);
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
    this.makeCapacityForCapability();
    if (this.records.size >= this.maxCapabilities) {
      throw new TurnCapabilityError(
        "CAPABILITY_CAPACITY_EXCEEDED",
        "turn capability capacity is exhausted"
      );
    }

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
    if (record.leases.size >= this.maxLeasesPerTurn) {
      throw new TurnCapabilityError("LEASE_CAPACITY_EXCEEDED", "activity lease capacity is exhausted for this turn");
    }
    if (record.state === "issued" && this.activeTurnCount() >= this.maxActiveTurns) {
      throw new TurnCapabilityError("ACTIVE_TURN_LIMIT", "the active turn limit has been reached");
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
      maxActiveTurns: this.maxActiveTurns,
      maxCapabilities: this.maxCapabilities,
      maxTombstones: this.maxTombstones,
      maxLeasesPerTurn: this.maxLeasesPerTurn,
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
    while (record.expiredLeaseHashes.size > this.maxLeasesPerTurn) {
      const oldest = record.expiredLeaseHashes.values().next().value as string | undefined;
      if (!oldest) break;
      record.expiredLeaseHashes.delete(oldest);
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

  private makeCapacityForCapability(): void {
    this.trimTombstones();
    while (this.records.size >= this.maxCapabilities) {
      const oldest = [...this.records.values()]
        .filter((record) => this.isTombstone(record.state) && record.leases.size === 0)
        .sort((left, right) => (left.terminalAt ?? 0) - (right.terminalAt ?? 0))[0];
      if (!oldest) return;
      this.records.delete(oldest.tokenHash);
    }
  }

  private canIssueAfterReplacing(binding: TurnCapabilityBinding, now: number): boolean {
    if (this.records.size < this.maxCapabilities) return true;
    let reclaimable = 0;
    for (const record of this.records.values()) {
      const hasLiveLease = [...record.leases.values()].some((leaseExpiresAt) => leaseExpiresAt > now);
      if (!hasLiveLease && (this.isTombstone(record.state) || now >= record.expiresAt || this.sameSession(record.binding, binding))) {
        reclaimable += 1;
      }
    }
    return this.records.size - reclaimable < this.maxCapabilities;
  }

  private sameSession(left: TurnCapabilityBinding, right: TurnCapabilityBinding): boolean {
    return (
      left.workspaceId === right.workspaceId &&
      left.projectId === right.projectId &&
      left.registrationId === right.registrationId &&
      left.localSessionId === right.localSessionId
    );
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

  private positiveLimit(value: number | undefined, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new TurnCapabilityError("INVALID_BINDING", `${label} is invalid`);
    return value;
  }

  private nonNegativeLimit(value: number | undefined, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 0) throw new TurnCapabilityError("INVALID_BINDING", `${label} is invalid`);
    return value;
  }
}
