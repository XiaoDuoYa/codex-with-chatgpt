import type {
  IssueTurnCapabilityInput,
  TurnCapabilityGrant,
} from "./turn-capability.js";
import type {
  MachineSurfaceIdentity,
  TurnCancellationBinding,
} from "./machine-gateway.js";
import type { MachineRuntimeState } from "./runtime.js";
import type {
  ClaimSurfaceOptions,
  CommitVerifiedSurfaceRouteOptions,
  SurfaceBinding,
  SurfaceLease,
  SurfaceLeaseRef,
  RetireSurfaceSessionResult,
  VerifiedSurfaceRouteCommit,
} from "../session/surface-ownership.js";
import type {
  ControlResultCorrelation,
} from "../control/result-schema.js";
import type {
  ControlStatus,
  OpenControlResultRequestStatus,
  RetireControlResultSessionSummary,
} from "../control/mailbox.js";
import {
  assertChatGPTSurfaceIdentity,
  CHATGPT_BROWSER_ID,
  CHATGPT_SURFACE_ID,
} from "../session/surface-ownership.js";

const DEFAULT_ADMIN_TIMEOUT_MS = 60_000;

export class MachineAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MachineAdminError";
  }
}

export interface MachineRegistrationIdentity {
  workspaceId: string;
  projectId: string;
  registrationId: string;
}

export interface RegisterWorkspaceResponse extends MachineRegistrationIdentity {
  workspaceName: string;
}

export interface UnregisterWorkspaceResponse {
  unregistered: boolean;
}

export interface CancelTurnResponse {
  cancelled: boolean;
}

export interface RevokeRequestResponse {
  revoked: number;
}

export interface SurfaceViewResponse {
  projectUrl: string | null;
  lease: SurfaceLease | null;
  binding: SurfaceBinding | null;
}

export type SurfaceRetireResponse = RetireSurfaceSessionResult & {
  revokedContexts: number;
  mailbox: RetireControlResultSessionSummary;
};

export interface SurfaceIdentity extends MachineSurfaceIdentity {}

export interface MailboxIdentity extends MachineSurfaceIdentity {}

export interface OpenMailboxRequestInput extends ControlResultCorrelation {
  ttlMs?: number;
}

export interface MailboxLookupInput extends ControlResultCorrelation {
  requestId: string;
}

function surfaceLeaseRef(lease: SurfaceLeaseRef): SurfaceLeaseRef {
  assertChatGPTSurfaceIdentity(lease.browserId, lease.surfaceId);
  return {
    projectId: lease.projectId,
    localSessionId: lease.localSessionId,
    browserId: lease.browserId,
    surfaceId: lease.surfaceId,
    tabId: lease.tabId,
    generation: lease.generation,
    ownerProcessEpoch: lease.ownerProcessEpoch,
  };
}

/**
 * Make an authenticated JSON request to the loopback machine gateway.
 * The admin token is read from the validated runtime record and is never
 * included in an error message or returned response.
 *
 * The fourth argument is the optional JSON body. For callers that only need a
 * custom timeout, a number may be passed there as a shorthand.
 */
export async function adminFetch<T = unknown>(
  runtime: MachineRuntimeState,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<T> {
  const requestBody = typeof body === "number" ? undefined : body;
  const requestTimeoutMs = typeof body === "number" ? body : timeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("machine admin timeout must be a positive integer");
  }
  if (
    !Number.isInteger(runtime.port) ||
    runtime.port < 1 ||
    runtime.port > 65_535 ||
    typeof route !== "string" ||
    !route.startsWith("/") ||
    /[\r\n]/.test(route)
  ) {
    throw new Error("machine admin request target is invalid");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${runtime.adminToken}`,
    };
    if (requestBody !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => undefined)) as
      | { error?: unknown; message?: unknown }
      | undefined;
    if (!response.ok) {
      const message = typeof parsed?.message === "string" ? parsed.message : `Admin request failed (${response.status})`;
      const code = typeof parsed?.error === "string" ? parsed.error : undefined;
      throw new MachineAdminError(message, response.status, code);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

export function registerWorkspace(
  runtime: MachineRuntimeState,
  root: string,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<RegisterWorkspaceResponse> {
  return adminFetch(runtime, "POST", "/admin/workspaces/register", { root }, timeoutMs);
}

export function issueTurn(
  runtime: MachineRuntimeState,
  input: IssueTurnCapabilityInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<TurnCapabilityGrant> {
  return adminFetch(runtime, "POST", "/admin/turns/issue", input, timeoutMs);
}

export function cancelTurn(
  runtime: MachineRuntimeState,
  contextId: string,
  expected?: TurnCancellationBinding,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<CancelTurnResponse> {
  return adminFetch(
    runtime,
    "POST",
    "/admin/turns/cancel",
    { contextId, ...(expected ? { expected } : {}) },
    timeoutMs,
  );
}

export function revokeRequest(
  runtime: MachineRuntimeState,
  binding: TurnCancellationBinding,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<RevokeRequestResponse> {
  return adminFetch(runtime, "POST", "/admin/turns/revoke-request", binding, timeoutMs);
}

export function unregisterWorkspace(
  runtime: MachineRuntimeState,
  identity: MachineRegistrationIdentity,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS
): Promise<UnregisterWorkspaceResponse> {
  return adminFetch(runtime, "POST", "/admin/workspaces/unregister", identity, timeoutMs);
}

export function getSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<SurfaceViewResponse> {
  return adminFetch(runtime, "POST", "/admin/surfaces/get", identity, timeoutMs);
}

export function claimSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  input: Omit<ClaimSurfaceOptions, "projectId" | "localSessionId" | "browserId" | "surfaceId">,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<{ lease: SurfaceLease }> {
  return adminFetch(runtime, "POST", "/admin/surfaces/claim", {
    ...identity,
    ...input,
    browserId: CHATGPT_BROWSER_ID,
    surfaceId: CHATGPT_SURFACE_ID,
    ...(input.replaces ? { replaces: surfaceLeaseRef(input.replaces) } : {}),
  }, timeoutMs);
}

export function commitSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  lease: SurfaceLeaseRef,
  options: Omit<CommitVerifiedSurfaceRouteOptions, "lease" | "workspaceId">,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<VerifiedSurfaceRouteCommit> {
  return adminFetch(runtime, "POST", "/admin/surfaces/commit", {
    ...identity,
    lease: surfaceLeaseRef(lease),
    ...options,
  }, timeoutMs);
}

export function renewSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  lease: SurfaceLeaseRef,
  leaseTtlMs?: number,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<{ lease: SurfaceLease }> {
  return adminFetch(
    runtime,
    "POST",
    "/admin/surfaces/renew",
    { ...identity, lease: surfaceLeaseRef(lease), ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }) },
    timeoutMs,
  );
}

export function releaseSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  lease: SurfaceLeaseRef,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<{ released: boolean }> {
  return adminFetch(runtime, "POST", "/admin/surfaces/release", {
    ...identity,
    lease: surfaceLeaseRef(lease),
  }, timeoutMs);
}

export function retireSurface(
  runtime: MachineRuntimeState,
  identity: SurfaceIdentity,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<SurfaceRetireResponse> {
  return adminFetch(runtime, "POST", "/admin/surfaces/retire", identity, timeoutMs);
}

function mailboxIdentityBody(identity: MailboxIdentity): MailboxIdentity {
  return {
    workspaceId: identity.workspaceId,
    projectId: identity.projectId,
    registrationId: identity.registrationId,
    localSessionId: identity.localSessionId,
  };
}

export function openMailboxRequest(
  runtime: MachineRuntimeState,
  identity: MailboxIdentity,
  input: OpenMailboxRequestInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<OpenControlResultRequestStatus> {
  return adminFetch(runtime, "POST", "/admin/mailbox/open", {
    ...mailboxIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function getMailboxStatus(
  runtime: MachineRuntimeState,
  identity: MailboxIdentity,
  input: MailboxLookupInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<ControlStatus> {
  return adminFetch(runtime, "POST", "/admin/mailbox/status", {
    ...mailboxIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function waitMailboxResult(
  runtime: MachineRuntimeState,
  identity: MailboxIdentity,
  input: MailboxLookupInput & { timeoutMs: number },
  timeoutMs = Math.max(DEFAULT_ADMIN_TIMEOUT_MS, input.timeoutMs + 5_000),
): Promise<ControlStatus> {
  return adminFetch(runtime, "POST", "/admin/mailbox/wait", {
    ...mailboxIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function acknowledgeMailboxResult(
  runtime: MachineRuntimeState,
  identity: MailboxIdentity,
  input: MailboxLookupInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<ControlStatus> {
  return adminFetch(runtime, "POST", "/admin/mailbox/ack", {
    ...mailboxIdentityBody(identity),
    ...input,
  }, timeoutMs);
}

export function cancelMailboxRequest(
  runtime: MachineRuntimeState,
  identity: MailboxIdentity,
  input: MailboxLookupInput,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<ControlStatus> {
  return adminFetch(runtime, "POST", "/admin/mailbox/cancel", {
    ...mailboxIdentityBody(identity),
    ...input,
  }, timeoutMs);
}
