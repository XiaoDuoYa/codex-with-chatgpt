import {
  TurnCapabilityBroker,
  TurnCapabilityError,
  type IssueTurnCapabilityInput,
  type TurnCapabilityBinding,
  type TurnCapabilityGrant,
  type TurnCapabilityStats,
  type TurnCompletionFence,
  type TurnCompletionReceipt,
  type TurnLease,
  type TurnReleaseReceipt,
} from "./turn-capability.js";
import {
  WorkspaceRegistry,
  type WorkspaceRegistryOptions,
  type WorkspaceRegistration,
} from "./workspace-registry.js";
import type { Workspace } from "../workspace/manager.js";

export interface MachineGatewayOptions extends WorkspaceRegistryOptions {
  readonly broker?: TurnCapabilityBroker;
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

function bindingForStatus(
  broker: TurnCapabilityBroker,
  contextId: string
): TurnCapabilityBinding {
  const status = broker.status(contextId);
  if (status.binding) return status.binding;

  // Let the broker produce its canonical invalid/unknown-token error. This
  // also avoids manufacturing a binding for untrusted data.
  broker.claim(contextId, undefined as never);
  throw new TurnCapabilityError("TOKEN_NOT_FOUND", "turn capability is not available");
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

  constructor(options: MachineGatewayOptions = {}) {
    const { broker, ...registryOptions } = options;
    this.broker = broker ?? new TurnCapabilityBroker();
    this.registry = new WorkspaceRegistry(this.broker, registryOptions);
  }

  /** Trusted owner-only registration entry point. */
  registerWorkspace(root: string): WorkspaceRegistration {
    return this.registry.register(root);
  }

  /**
   * Issue one context capability after checking the exact live registration.
   * Issuing for an existing local session atomically revokes every older
   * generation for that session before the replacement becomes available.
   */
  issueTurn(input: IssueTurnCapabilityInput): TurnCapabilityGrant {
    this.registry.lookup(input.workspaceId, input.projectId, input.registrationId);
    return this.broker.issueReplacingSession(input);
  }

  unregisterWorkspace(workspaceId: string, projectId: string, registrationId: string): boolean {
    const removed = this.registry.unregister(workspaceId, projectId, registrationId);
    if (removed) this.broker.revokeRegistration(workspaceId, projectId, registrationId);
    return removed;
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
    const lease = this.broker.claim(contextId, binding, { requiredScopes: scopes });
    try {
      const workspace = this.registry.resolve(lease);
      return Object.freeze({ lease, workspace });
    } catch (error) {
      this.broker.release(contextId, lease.leaseId);
      this.broker.revoke(contextId);
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

  beginCompletion(contextId: string): TurnCompletionFence {
    return this.broker.beginCompletion(contextId, bindingForStatus(this.broker, contextId));
  }

  completeTurn(
    fenceInput: string | Pick<TurnCompletionFence, "fence">
  ): TurnCompletionReceipt {
    return this.broker.complete(fenceOf(fenceInput));
  }

  cancelTurn(contextId: string): void {
    this.broker.cancel(contextId);
  }

  revokeTurn(contextId: string): void {
    this.broker.revoke(contextId);
  }

  stats(): MachineGatewayStats {
    return Object.freeze({
      ...this.broker.stats(),
      workspaceCount: this.registry.size,
    });
  }

  /** Keep serialization observably free of broker and workspace internals. */
  toJSON(): { stats: MachineGatewayStats } {
    return { stats: this.stats() };
  }
}
