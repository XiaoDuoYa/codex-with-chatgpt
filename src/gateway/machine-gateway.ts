import { assessPluginPreflight } from "../session/turn-preflight.js";
import {
  TurnCapabilityBroker,
  TurnCapabilityError,
  type IssueTurnCapabilityInput,
  type TurnCapabilityBinding,
  type TurnCapabilityGrant,
  type TurnCapabilityStats,
  type TurnCapabilityStatus,
  type TurnRequestBinding,
  type TurnCompletionAbortReceipt,
  type TurnCompletionFence,
  type TurnCompletionReceipt,
  type TurnLease,
  type TurnReleaseReceipt,
} from "./turn-capability.js";
import {
  WorkspaceRegistry,
  type WorkspaceRegistration,
} from "./workspace-registry.js";
import type { Workspace } from "../workspace/manager.js";
import {
  acknowledgeControlResult,
  cancelControlResultRequest,
  getActiveControlResultStatus,
  getControlResultStatus,
  openControlResultRequestWithStatus,
  observeControlResultRequest,
  reportControlProgress,
  requireBootControlResult,
  retireControlResultSession,
  submitControlResult,
  waitForControlResult,
  type ControlStatus,
  type OpenControlResultRequestInput,
  type OpenControlResultRequestStatus,
  type RetireControlResultSessionSummary,
} from "../control/mailbox.js";
import {
  parseControlProgressUpdate,
  parseControlResultSubmission,
  parseReportControlProgressInput,
  parseSubmitControlResultInput,
  type ControlPhase,
  type ControlProgressReceipt,
  type ControlResultCorrelation,
  type ControlResultReceipt,
} from "../control/result-schema.js";
import {
  claimSurface,
  assertChatGPTSurfaceIdentity,
  commitVerifiedSurfaceRoute,
  currentSurfaceBinding,
  currentSurfaceLease,
  currentOwnerProcessEpoch,
  reconcileSurfaceSessionRoute,
  requireSurfaceGeneration,
  releaseSurface,
  renewSurface,
  retireSurfaceSession,
  unregisterSurfaceOwnership,
  currentProjectUrl,
  type ClaimSurfaceOptions,
  type CommitVerifiedSurfaceRouteOptions,
  type SurfaceLease,
  type SurfaceLeaseRef,
  type SurfaceBinding,
  type RetireSurfaceSessionResult,
  type VerifiedSurfaceRouteCommit,
  SurfaceOwnershipError,
} from "../session/surface-ownership.js";
import {
  normalizeChatUrl,
  normalizeProjectUrl,
  projectIdFromChatUrl,
  projectIdFromUrl,
} from "../session/state.js";
import { parseControlPageObservation, type ControlPageObservation } from "../control/wait-policy.js";

export type SurfaceGenerationValidator = (binding: TurnCapabilityBinding) => void;

/**
 * Validate the page generation that a turn is allowed to use.
 *
 * BOOT may run against a newly claimed candidate lease. All later phases
 * require the durable surface binding as well, so a candidate page cannot be
 * used for workspace access before it has been committed.
 */
export function requireCurrentTurnSurface(binding: TurnCapabilityBinding): void {
  try {
    const lease = requireSurfaceGeneration(
      binding.projectId,
      binding.localSessionId,
      binding.generation,
    );
    if (binding.phase === "BOOT") return;
    const committed = currentSurfaceBinding(binding.projectId, binding.localSessionId);
    if (!committed || committed.lastGeneration !== lease.generation) {
      throw new Error("surface generation has not been committed for this turn");
    }
  } catch {
    throw new TurnCapabilityError(
      "STALE_BINDING_EPOCH",
      "turn capability no longer belongs to the current ChatGPT page",
    );
  }
}

export interface MachineGatewayOptions {
  readonly broker?: TurnCapabilityBroker;
  /** Surface ownership check supplied by the machine server composition. */
  readonly surfaceValidator?: SurfaceGenerationValidator;
  /** Machine-owned checkout membership index; omitted for isolated in-memory use. */
  readonly workspaceMembershipFile?: string;
}

export interface MachineGatewayStats extends TurnCapabilityStats {
  readonly workspaceCount: number;
}

/**
 * The lease and workspace returned by a successful data-plane claim.
 *
 * The context id is intentionally not included. Callers retain the raw
 * capability separately and pass it explicitly to lifecycle methods; the
 * gateway never stores or embeds it in a returned data-plane context.
 */
export interface MachineTurnContext {
  readonly lease: TurnLease;
  readonly workspace: Workspace;
}

export type LeaseInput = TurnLease | string;
export type RequiredScopes = readonly [string, ...string[]];
export type TurnCancellationBinding = TurnRequestBinding;

export interface MachineSurfaceIdentity {
  workspaceId: string;
  projectId: string;
  registrationId: string;
  localSessionId: string;
}

export interface MachineSurfaceView {
  /** Durable local-project to ChatGPT Project association, if configured. */
  projectUrl: string | null;
  lease: SurfaceLease | null;
  binding: SurfaceBinding | null;
  control: ControlStatus | null;
}

export type MachineSurfaceCommitOptions = Omit<
  CommitVerifiedSurfaceRouteOptions,
  "lease" | "workspaceId"
> & {
  /** Exact structured BOOT request whose verified result authorizes this route. */
  bootRequestId: string;
};

export interface MachineSurfaceRetireResult extends RetireSurfaceSessionResult {
  /** Number of live turn capabilities revoked before ownership cleanup. */
  revokedContexts: number;
  mailbox: RetireControlResultSessionSummary;
}

function bindingForStatus(
  broker: TurnCapabilityBroker,
  contextId: string
): TurnCapabilityBinding {
  return broker.assertLive(contextId);
}

function cancellationMatches(
  binding: TurnCapabilityBinding,
  expected: TurnCancellationBinding,
): boolean {
  return (
    binding.workspaceId === expected.workspaceId &&
    binding.projectId === expected.projectId &&
    binding.localSessionId === expected.localSessionId &&
    binding.taskId === expected.taskId &&
    binding.iteration === expected.iteration &&
    binding.phase === expected.phase &&
    binding.requestId === expected.requestId
  );
}

function validateRequiredScopes(requiredScopes: RequiredScopes): readonly string[] {
  if (!Array.isArray(requiredScopes) || requiredScopes.length === 0) {
    throw new TurnCapabilityError("INVALID_BINDING", "requiredScopes must not be empty");
  }
  return requiredScopes;
}

function fenceOf(input: string | Pick<TurnCompletionFence, "fence">): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object" && typeof input.fence === "string") {
    return input.fence;
  }
  throw new TurnCapabilityError("COMPLETION_FENCE_INVALID", "completion fence is invalid");
}

/**
 * Machine-local control/data-plane composition for registered workspaces.
 *
 * The gateway deliberately has no capability, lease, or completion-fence
 * cache. Raw values exist only in the caller's returned handle or in the
 * immediate broker call; the broker stores hashes and object provenance.
 */
export class MachineGateway {
  private readonly broker: TurnCapabilityBroker;
  private readonly registry: WorkspaceRegistry;
  private readonly surfaceValidator?: SurfaceGenerationValidator;
  /** Synchronous per-session critical sections for final surface validation and mailbox publication. */
  private readonly controlSubmissionSessions = new Set<string>();
  private readonly controlCompletionFences = new Map<string, string>();

  constructor(options: MachineGatewayOptions = {}) {
    const { broker, surfaceValidator, workspaceMembershipFile } = options;
    this.broker = broker ?? new TurnCapabilityBroker();
    this.registry = new WorkspaceRegistry(
      this.broker,
      (projectId, hasRemainingProjectCheckout) => {
        if (!hasRemainingProjectCheckout) unregisterSurfaceOwnership(projectId);
      },
      workspaceMembershipFile,
    );
    this.surfaceValidator = surfaceValidator;
  }

  /** Trusted owner-only registration entry point. */
  registerWorkspace(root: string): WorkspaceRegistration {
    return this.registry.register(root);
  }

  surfaceGet(identity: MachineSurfaceIdentity): MachineSurfaceView {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    // The machine index is authoritative. Repair a checkout route left
    // behind by a failed commit/retire before returning the surface view.
    reconcileSurfaceSessionRoute({
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      localSessionId: identity.localSessionId,
    });
    return {
      projectUrl: currentProjectUrl(identity.projectId),
      lease: currentSurfaceLease(identity.projectId, identity.localSessionId),
      binding: currentSurfaceBinding(identity.projectId, identity.localSessionId),
      control: getActiveControlResultStatus(identity.workspaceId, identity.localSessionId),
    };
  }

  surfaceClaim(
    identity: MachineSurfaceIdentity,
    input: Omit<ClaimSurfaceOptions, "projectId" | "localSessionId">,
  ): SurfaceLease {
    assertChatGPTSurfaceIdentity(input.browserId, input.surfaceId);
    this.assertSurfaceMutationAllowed(identity.projectId, identity.localSessionId);
    const registration = this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    const previous = currentSurfaceLease(identity.projectId, identity.localSessionId);
    const idempotent = previous && previous.tabId === input.tabId &&
      previous.ownerProcessEpoch === (input.ownerProcessEpoch ?? currentOwnerProcessEpoch()) &&
      previous.projectUrl === normalizeProjectUrl(input.projectUrl) &&
      previous.chatUrl === (input.chatUrl === undefined ? undefined : normalizeChatUrl(input.chatUrl));
    if (!idempotent) {
      const control = getActiveControlResultStatus(identity.workspaceId, identity.localSessionId);
      if (control?.status === "pending" || control?.status === "received") {
        throw new SurfaceOwnershipError(
          "SURFACE_CONTROL_UNRESOLVED",
          "Resolve the active mailbox request before replacing this page: cancel pending work or consume and acknowledge a received result.",
        );
      }
    }
    const claimed = claimSurface({
      ...input,
      workspaceName: registration.workspace.name,
      projectId: identity.projectId,
      localSessionId: identity.localSessionId,
    });
    if (previous?.generation !== claimed.generation) {
      this.broker.revokeSession(identity.workspaceId, identity.projectId, identity.localSessionId);
    }
    return claimed;
  }

  surfaceCommit(
    identity: MachineSurfaceIdentity,
    lease: SurfaceLeaseRef,
    options: MachineSurfaceCommitOptions,
  ): VerifiedSurfaceRouteCommit {
    assertChatGPTSurfaceIdentity(lease.browserId, lease.surfaceId);
    this.assertSurfaceMutationAllowed(identity.projectId, identity.localSessionId);
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    if (lease.projectId !== identity.projectId || lease.localSessionId !== identity.localSessionId) {
      throw new Error("surface lease does not belong to the registered local session");
    }
    const { bootRequestId, ...routeOptions } = options;
    const boot = requireBootControlResult(
      identity.workspaceId,
      bootRequestId,
      identity.localSessionId,
      lease.generation,
      lease.tabId,
    );
    const committed = commitVerifiedSurfaceRoute({
      lease,
      workspaceId: identity.workspaceId,
      ...routeOptions,
      requireProjectSelection: true,
    });
    if (boot.status === "received" || boot.status === "acknowledged") {
      acknowledgeControlResult(identity.workspaceId, bootRequestId, identity.localSessionId, {
        taskId: boot.request!.taskId,
        iteration: boot.request!.iteration,
        phase: "BOOT",
      });
    }
    this.broker.revokeRequest({
      ...identity,
      taskId: boot.request!.taskId,
      iteration: boot.request!.iteration,
      phase: "BOOT",
      requestId: bootRequestId,
    });
    return committed;
  }

  surfaceRenew(identity: MachineSurfaceIdentity, lease: SurfaceLeaseRef, leaseTtlMs?: number): SurfaceLease {
    assertChatGPTSurfaceIdentity(lease.browserId, lease.surfaceId);
    this.assertSurfaceMutationAllowed(identity.projectId, identity.localSessionId);
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    if (lease.projectId !== identity.projectId || lease.localSessionId !== identity.localSessionId) {
      throw new Error("surface lease does not belong to the registered local session");
    }
    return renewSurface({ lease, leaseTtlMs });
  }

  surfaceRelease(identity: MachineSurfaceIdentity, lease: SurfaceLeaseRef): boolean {
    assertChatGPTSurfaceIdentity(lease.browserId, lease.surfaceId);
    this.assertSurfaceMutationAllowed(identity.projectId, identity.localSessionId);
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    if (lease.projectId !== identity.projectId || lease.localSessionId !== identity.localSessionId) {
      throw new Error("surface lease does not belong to the registered local session");
    }
    return releaseSurface(lease);
  }

  /**
   * Permanently retire one local session's ChatGPT surface and every live
   * capability issued for it. Registration is checked before any mutation so
   * an untrusted caller cannot use retirement as a cross-workspace primitive.
   */
  surfaceRetire(identity: MachineSurfaceIdentity): MachineSurfaceRetireResult {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    this.assertSurfaceMutationAllowed(identity.projectId, identity.localSessionId);
    const revokedContexts = this.broker.revokeSession(
      identity.workspaceId,
      identity.projectId,
      identity.localSessionId,
    );
    const mailbox = retireControlResultSession(identity.workspaceId, identity.localSessionId);
    const retired = retireSurfaceSession({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      localSessionId: identity.localSessionId,
    });
    return { ...retired, revokedContexts, mailbox };
  }

  /**
   * Issue one context capability after checking the exact live registration.
   * Issuing for an existing local session atomically revokes every older
   * generation for that session before the replacement becomes available.
   */
  issueTurn(input: IssueTurnCapabilityInput): TurnCapabilityGrant {
    this.registry.lookup(input.workspaceId, input.projectId, input.registrationId);
    if ((["BOOT", "RESEARCH", "PLAN", "REVIEW"] as const).includes(input.phase as ControlPhase)) {
      const control = getControlResultStatus(
        input.workspaceId,
        input.requestId,
        input.localSessionId,
        { taskId: input.taskId, iteration: input.iteration, phase: input.phase as ControlPhase },
      );
      if (
        control.status !== "pending" ||
        (control.request?.surfaceGeneration !== null &&
          control.request?.surfaceGeneration !== input.generation)
      ) {
        throw new TurnCapabilityError(
          "BINDING_MISMATCH",
          "turn capability must bind the exact pending mailbox request and current surface generation",
        );
      }
    }
    if (input.plugins?.length) requireCurrentTurnSurface(input);
    assessPluginPreflight(input, input.plugins?.length
      ? currentSurfaceLease(input.projectId, input.localSessionId) : null, this.broker.bootEpoch);
    return this.broker.issueReplacingSession(input);
  }

  unregisterWorkspace(workspaceId: string, projectId: string, registrationId: string): boolean {
    this.assertSurfaceMutationAllowed(projectId);
    this.registry.lookup(workspaceId, projectId, registrationId);
    return this.registry.unregister(workspaceId, projectId, registrationId);
  }

  /**
   * Claim a live capability and resolve its workspace only through the
   * broker-issued lease. A failed registry resolution releases the lease so a
   * stale checkout cannot leave an active turn behind.
   */
  claimTurn(
    contextId: string,
    requiredScopes: RequiredScopes
  ): MachineTurnContext {
    const scopes = validateRequiredScopes(requiredScopes);
    const binding = bindingForStatus(this.broker, contextId);
    this.validateSurface(contextId, binding);
    const lease = this.broker.claim(contextId, binding, { requiredScopes: scopes });
    try {
      this.validateSurface(contextId, lease.binding);
      const workspace = this.registry.resolve(lease);
      return Object.freeze({ lease, workspace });
    } catch (error) {
      this.releaseFailedClaim(contextId, lease.leaseId);
      throw error;
    }
  }

  releaseTurn(
    contextId: string,
    leaseInput: LeaseInput
  ): TurnReleaseReceipt {
    const leaseId = typeof leaseInput === "string" ? leaseInput : leaseInput.leaseId;
    if (typeof leaseInput !== "string") {
      try {
        this.broker.validateLease(leaseInput);
      } catch (error) {
        if (
          error instanceof TurnCapabilityError &&
          (error.code === "LEASE_NOT_FOUND" || error.code === "LEASE_EXPIRED")
        ) {
          return { released: false };
        }
        throw error;
      }
    }
    return this.broker.release(contextId, leaseId);
  }

  renewTurn(contextId: string, lease: TurnLease, leaseTtlMs?: number): string {
    const verified = this.broker.validateLease(lease);
    this.validateSurface(contextId, verified.binding);
    const renewed = this.broker.renew(
      contextId,
      verified.leaseId,
      verified.binding,
      leaseTtlMs
    );
    this.validateSurface(contextId, verified.binding);
    return renewed;
  }

  beginCompletion(contextId: string): TurnCompletionFence {
    const binding = bindingForStatus(this.broker, contextId);
    const sessionKey = this.controlSessionKey(binding.projectId, binding.localSessionId);
    if (this.controlSubmissionSessions.has(sessionKey)) {
      throw new TurnCapabilityError("COMPLETION_ALREADY_STARTED", "another control result is being committed");
    }
    const fence = this.broker.beginCompletion(contextId, binding);
    this.controlSubmissionSessions.add(sessionKey);
    this.controlCompletionFences.set(fence.fence, sessionKey);
    return fence;
  }

  /** Open a machine-owned mailbox request for a registered workspace/session. */
  openControlResultRequest(
    identity: MachineSurfaceIdentity,
    input: Omit<OpenControlResultRequestInput, "localSessionId"> & { localSessionId?: never },
  ): OpenControlResultRequestStatus {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    const surface = currentSurfaceLease(
      identity.projectId,
      identity.localSessionId,
    );
    return openControlResultRequestWithStatus(identity.workspaceId, {
      ...input,
      localSessionId: identity.localSessionId,
      surfaceGeneration: surface?.generation,
      surfaceTabId: surface?.tabId,
    });
  }

  getControlResultStatus(
    identity: MachineSurfaceIdentity,
    requestId: string,
    expected: ControlResultCorrelation,
  ): ControlStatus {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    return getControlResultStatus(identity.workspaceId, requestId, identity.localSessionId, expected);
  }

  waitForControlResult(
    identity: MachineSurfaceIdentity,
    requestId: string,
    timeoutMs: number,
    expected: ControlResultCorrelation,
    signal?: AbortSignal,
  ): Promise<ControlStatus> {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    return waitForControlResult(
      identity.workspaceId,
      requestId,
      timeoutMs,
      identity.localSessionId,
      expected,
      signal,
    );
  }

  acknowledgeControlResult(
    identity: MachineSurfaceIdentity,
    requestId: string,
    expected: ControlResultCorrelation,
  ): ControlStatus {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    return acknowledgeControlResult(identity.workspaceId, requestId, identity.localSessionId, expected);
  }

  cancelControlResultRequest(
    identity: MachineSurfaceIdentity,
    requestId: string,
    expected: ControlResultCorrelation,
  ): ControlStatus {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    try {
      const status = cancelControlResultRequest(
        identity.workspaceId,
        requestId,
        identity.localSessionId,
        expected,
      );
      if (status.status === "cancelled") {
        this.broker.revokeRequest({ ...identity, ...expected, requestId });
      }
      return status;
    } catch (error) {
      try {
        const latest = this.getControlResultStatus(identity, requestId, expected);
        if (latest.status === "cancelled") {
          this.broker.revokeRequest({ ...identity, ...expected, requestId });
        }
      } finally {
        throw error;
      }
    }
  }

  observeControlPage(
    identity: MachineSurfaceIdentity,
    requestId: string,
    expected: ControlResultCorrelation,
    input: ControlPageObservation,
  ): ControlStatus {
    this.registry.lookup(identity.workspaceId, identity.projectId, identity.registrationId);
    const observation = parseControlPageObservation(input);
    const status = this.getControlResultStatus(identity, requestId, expected);
    if (status.status !== "pending" && status.status !== "cancelled") return status;
    if (status.status === "cancelled" && status.hostFailure !== undefined) {
      try {
        return observeControlResultRequest(
          identity.workspaceId,
          requestId,
          identity.localSessionId,
          expected,
          observation,
        );
      } finally {
        this.broker.revokeRequest({ ...identity, ...expected, requestId });
      }
    }
    if (
      status.status === "pending" &&
      observation.state === "authority_invalid" &&
      this.broker.hasLiveRequest({ ...identity, ...expected, requestId })
    ) {
      throw new TurnCapabilityError(
        "BINDING_MISMATCH",
        "authority-invalid observation conflicts with a live capability for this request",
      );
    }
    const lease = currentSurfaceLease(identity.projectId, identity.localSessionId);
    const binding = currentSurfaceBinding(identity.projectId, identity.localSessionId);
    const observedAt = Date.parse(observation.observedAt);
    const observedUrl = "observedUrl" in observation && observation.observedUrl
      ? new URL(observation.observedUrl)
      : null;
    const canonicalChatUrl = observedUrl ? normalizeChatUrl(observedUrl.toString()) : null;
    const canonicalProjectUrl = observedUrl ? normalizeProjectUrl(observedUrl.toString()) : null;
    const now = Date.now();
    const requestSurfaceMatches = Boolean(
      status.request &&
      status.request.surfaceGeneration === observation.generation &&
      (
        status.request.surfaceTabId === observation.tabId ||
        (
          status.request.surfaceTabId === null &&
          binding?.lastGeneration === observation.generation &&
          binding.tabId === observation.tabId
        )
      ),
    );
    const liveLeaseMatches = Boolean(
      lease &&
      lease.tabId === observation.tabId &&
      lease.generation === observation.generation,
    );
    const mayCloseWithoutLiveLease =
      observation.state === "page_lost" ||
      observation.state === "authority_invalid" ||
      (status.status === "cancelled" && status.hostFailure !== undefined);
    const bootProjectUrl = status.request?.phase === "BOOT"
      ? lease?.projectUrl ?? currentProjectUrl(identity.projectId)
      : null;
    const candidateBootRoute = Boolean(
      bootProjectUrl &&
      (
        canonicalProjectUrl === bootProjectUrl ||
        (canonicalChatUrl && projectIdFromChatUrl(canonicalChatUrl) === projectIdFromUrl(bootProjectUrl))
      ),
    );
    const committedRoute = Boolean(
      binding &&
      binding.lastGeneration === observation.generation &&
      binding.chatUrl &&
      canonicalChatUrl === binding.chatUrl,
    );
    if (
      !status.request || observation.responseToRequestId !== requestId ||
      !requestSurfaceMatches || (!liveLeaseMatches && !mayCloseWithoutLiveLease) ||
      (observedUrl !== null && (
        observedUrl.username || observedUrl.password || observedUrl.search || observedUrl.hash ||
        (!candidateBootRoute && !committedRoute)
      )) ||
      observedAt < Date.parse(status.request.createdAt) || observedAt < now - 60_000 || observedAt > now + 5_000
    ) {
      throw new TurnCapabilityError("BINDING_MISMATCH", "page observation does not match this request's current response and owned page");
    }
    if (this.controlSubmissionSessions.has(this.controlSessionKey(identity.projectId, identity.localSessionId))) {
      return status;
    }
    this.assertSurfaceMutationAllowed(identity.projectId, identity.localSessionId);
    try {
      const resolved = observeControlResultRequest(
        identity.workspaceId,
        requestId,
        identity.localSessionId,
        expected,
        observation,
        observation.state === "generating" ? () => {
          if (!lease || !liveLeaseMatches) {
            throw new TurnCapabilityError("LEASE_NOT_FOUND", "generating observation requires the exact live surface lease");
          }
          const expiresAt = this.broker.keepAliveRequest({
            ...identity, ...expected, requestId, generation: observation.generation,
          }, observedAt);
          this.surfaceRenew(identity, lease, Math.max(1_000, Date.parse(lease.leaseExpiresAt) - Date.parse(lease.updatedAt)));
          return expiresAt;
        } : undefined,
      );
      if (resolved.status === "cancelled") {
        this.broker.revokeRequest({ ...identity, ...expected, requestId });
      }
      return resolved;
    } catch (error) {
      const latest = this.getControlResultStatus(identity, requestId, expected);
      if (latest.status === "cancelled") {
        this.broker.revokeRequest({ ...identity, ...expected, requestId });
      }
      throw error;
    }
  }

  /**
   * Read mailbox state through the live capability. This prevents MCP callers
   * from selecting another registered workspace by changing only request ids.
   */
  controlResultStatusForTurn(
    contextId: string,
  ): ControlStatus {
    const binding = this.controlBindingForTurn(contextId);
    return getControlResultStatus(
      binding.workspaceId,
      binding.requestId,
      binding.localSessionId,
      { taskId: binding.taskId, iteration: binding.iteration, phase: binding.phase },
    );
  }

  controlProgressForTurn(contextId: string, input: unknown): ControlProgressReceipt {
    const binding = this.controlBindingForTurn(contextId);
    const update = parseControlProgressUpdate(input);
    const reported = parseReportControlProgressInput({
      requestId: binding.requestId,
      localSessionId: binding.localSessionId,
      taskId: binding.taskId,
      iteration: binding.iteration,
      phase: binding.phase,
      ...update,
    });
    return reportControlProgress(binding.workspaceId, reported);
  }

  /**
   * Publish one result and consume its completion fence in one synchronous
   * machine transaction. Surface mutations are rejected while this section is
   * active, so the final generation check cannot be separated from publication.
   */
  completeControlResult(
    contextId: string,
    fenceInput: string | Pick<TurnCompletionFence, "fence">,
    input: unknown,
  ): ControlResultReceipt {
    const binding = bindingForStatus(this.broker, contextId);
    const sessionKey = this.controlSessionKey(binding.projectId, binding.localSessionId);
    const fence = fenceOf(fenceInput);
    if (this.controlCompletionFences.get(fence) !== sessionKey) {
      throw new TurnCapabilityError("COMPLETION_FENCE_INVALID", "completion fence does not belong to this control session");
    }
    try {
      // The fence is a second bearer secret, so bind it to the context before
      // parsing or publishing the result. Otherwise context B could consume
      // context A's fence after submitting B's mailbox result.
      this.broker.assertCompletionFence(contextId, binding, fence);
      const submission = parseControlResultSubmission(input);
      const controlBinding = this.controlBindingForTurn(contextId);
      const parsed = parseSubmitControlResultInput({
        requestId: controlBinding.requestId,
        localSessionId: controlBinding.localSessionId,
        taskId: controlBinding.taskId,
        iteration: controlBinding.iteration,
        phase: controlBinding.phase,
        ...submission,
      });
      const status = this.broker.status(contextId);
      if (status.status !== "completing") {
        throw new TurnCapabilityError("COMPLETION_FENCE_INVALID", "turn is no longer completing");
      }
      this.validateSurface(contextId, binding);
      const receipt = submitControlResult(binding.workspaceId, parsed);
      this.broker.complete(fence);
      return receipt;
    } finally {
      this.controlSubmissionSessions.delete(sessionKey);
      this.controlCompletionFences.delete(fence);
    }
  }

  completeTurn(
    fenceInput: string | Pick<TurnCompletionFence, "fence">
  ): TurnCompletionReceipt {
    const fence = fenceOf(fenceInput);
    const receipt = this.broker.complete(fence);
    this.releaseCompletionFence(fence);
    return receipt;
  }

  abortTurnCompletion(
    fenceInput: string | Pick<TurnCompletionFence, "fence">
  ): TurnCompletionAbortReceipt {
    const fence = fenceOf(fenceInput);
    try {
      return this.broker.abortCompletion(fence);
    } finally {
      this.releaseCompletionFence(fence);
    }
  }

  turnStatus(contextId: string): TurnCapabilityStatus {
    return this.broker.status(contextId);
  }

  /** Re-check the persisted browser surface at an operation boundary. */
  assertTurnSurface(contextId: string): void {
    this.validateSurface(contextId, bindingForStatus(this.broker, contextId));
  }

  cancelTurn(contextId: string, expected?: TurnCancellationBinding): void {
    const status = this.broker.status(contextId);
    if (!status.binding) {
      this.broker.cancel(contextId);
      return;
    }
    if (expected && !cancellationMatches(status.binding, expected)) {
      throw new TurnCapabilityError(
        "BINDING_MISMATCH",
        "turn capability does not match the control request being cancelled",
      );
    }
    if (
      status.status === "completed" ||
      status.status === "cancelled" ||
      status.status === "revoked" ||
      status.status === "expired"
    ) {
      return;
    }
    this.broker.cancel(contextId);
  }

  revokeTurn(contextId: string): void {
    this.broker.revoke(contextId);
  }

  revokeRequest(binding: TurnCancellationBinding): number {
    return this.broker.revokeRequest(binding);
  }

  stats(): MachineGatewayStats {
    return Object.freeze({
      ...this.broker.stats(),
      workspaceCount: this.registry.size,
    });
  }

  private validateSurface(contextId: string, binding: TurnCapabilityBinding): void {
    if (!this.surfaceValidator) return;
    try {
      this.surfaceValidator(binding);
    } catch (error) {
      this.revokeStaleContext(contextId, error);
    }
  }

  private controlSessionKey(projectId: string, localSessionId: string): string {
    return `${projectId}\u0000${localSessionId}`;
  }

  private assertSurfaceMutationAllowed(projectId?: string, localSessionId?: string): void {
    const active = projectId !== undefined && localSessionId !== undefined
      ? this.controlSubmissionSessions.has(this.controlSessionKey(projectId, localSessionId))
      : projectId !== undefined && [...this.controlSubmissionSessions].some((key) => key.startsWith(`${projectId}\u0000`));
    if (active) {
      throw new TurnCapabilityError(
        "COMPLETION_ALREADY_STARTED",
        "surface ownership cannot change while a control result is being committed",
      );
    }
  }

  private controlBindingForTurn(
    contextId: string,
  ): TurnCapabilityBinding & { requestId: string; phase: ControlPhase } {
    const binding = bindingForStatus(this.broker, contextId);
    if (
      binding.requestId === undefined ||
      (binding.phase !== "BOOT" && binding.phase !== "RESEARCH" && binding.phase !== "PLAN" && binding.phase !== "REVIEW")
    ) {
      throw new TurnCapabilityError("BINDING_MISMATCH", "turn capability is not bound to a control result request");
    }
    this.validateSurface(contextId, binding);
    return binding as TurnCapabilityBinding & { requestId: string; phase: ControlPhase };
  }

  private releaseCompletionFence(fence: string): void {
    const sessionKey = this.controlCompletionFences.get(fence);
    if (!sessionKey) return;
    this.controlCompletionFences.delete(fence);
    this.controlSubmissionSessions.delete(sessionKey);
  }

  private revokeStaleContext(contextId: string, error: unknown): never {
    try {
      this.broker.revoke(contextId);
    } catch (revokeError) {
      if (
        revokeError instanceof TurnCapabilityError &&
        revokeError.code !== "TOKEN_REVOKED"
      ) {
        throw revokeError;
      }
    }
    if (error instanceof TurnCapabilityError) throw error;
    throw new TurnCapabilityError(
      "STALE_BINDING_EPOCH",
      "turn capability no longer belongs to the current ChatGPT page",
    );
  }

  private releaseFailedClaim(contextId: string, leaseId: string): void {
    try {
      this.broker.release(contextId, leaseId);
    } catch {
      // The stale-surface path may have already turned the record terminal.
    }
    const status = this.broker.status(contextId).status;
    if (status === "issued" || status === "active" || status === "completing") {
      try {
        this.broker.revoke(contextId);
      } catch {
        // Preserve the original claim failure.
      }
    }
  }

  /** Keep serialization observably free of broker and workspace internals. */
  toJSON(): { stats: MachineGatewayStats } {
    return { stats: this.stats() };
  }
}
