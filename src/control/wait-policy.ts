import { z } from "zod";
import type { ControlStatus } from "./mailbox.js";
import {
  ControlMailboxError,
  c2cIdSchema,
  parseControlResultSubmission,
  controlResultSubmissionSchema,
} from "./result-schema.js";

export const CONTROL_PAGE_CHECK_INTERVAL_MS = 30_000;

const observationBase = {
  tabId: c2cIdSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedAt: z.string().datetime(),
  responseToRequestId: c2cIdSchema,
  observationSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

const observedPageIdentity = z.object({
  ...observationBase,
  observedUrl: z.string().url().max(4_096),
}).strict();

const responseIdentity = observedPageIdentity.extend({
  responseId: c2cIdSchema,
}).strict();

const failureReasonSchema = z.enum([
  "model_refusal",
  "tool_unavailable",
  "platform_blocked",
  "capability_invalid",
  "callback_missing",
  "response_start_failed",
  "page_lost",
]);
const failureSourceSchema = z.enum([
  "model_reported",
  "platform_error",
  "mcp_error",
  "host_observed",
]);
const failureToolSchema = z.enum([
  "report_control_progress",
  "submit_control_result",
  "get_control_result_status",
  "business_tool",
]).optional();
const failureCodeSchema = z.enum([
  "TOKEN_REVOKED",
  "TOKEN_EXPIRED",
  "STALE_BINDING_EPOCH",
  "TOOL_UNAVAILABLE",
  "SAFETY_CHECK_BLOCKED",
  "APPROVAL_REQUIRED",
  "UNKNOWN",
]).optional();

const finalHostFailureSchema = responseIdentity.extend({
  state: z.literal("final"),
  responseIsFinal: z.literal(true),
  reason: failureReasonSchema.exclude(["response_start_failed", "page_lost"]),
  source: failureSourceSchema,
  tool: failureToolSchema,
  errorCode: failureCodeSchema,
}).strict();

const finalComputerUseResultSchema = responseIdentity.extend({
  state: z.literal("final"),
  responseIsFinal: z.literal(true),
  delivery: z.literal("computer_use"),
  terminalResult: controlResultSubmissionSchema,
}).strict();

const responseStartFailureSchema = observedPageIdentity.extend({
  state: z.literal("response_start_failed"),
  reason: z.literal("response_start_failed"),
  source: z.literal("host_observed"),
  evidence: z.enum(["explicit_send_error", "explicit_response_error"]),
}).strict();

const pageLostHostFailureSchema = z.object({
  ...observationBase,
  state: z.literal("page_lost"),
  reason: z.literal("page_lost"),
  source: z.literal("host_observed"),
}).strict();

const authorityInvalidHostFailureSchema = z.object({
  ...observationBase,
  observedUrl: z.string().url().max(4_096).optional(),
  state: z.literal("authority_invalid"),
  reason: z.literal("capability_invalid"),
  source: z.enum(["mcp_error", "host_observed"]),
  errorCode: z.enum(["TOKEN_REVOKED", "TOKEN_EXPIRED", "STALE_BINDING_EPOCH"]),
}).strict();

// No free-form page excerpts: these diagnostics must not persist credentials or business data.
export const controlHostFailureSchema = z.discriminatedUnion("state", [
  finalHostFailureSchema,
  responseStartFailureSchema,
  pageLostHostFailureSchema,
  authorityInvalidHostFailureSchema,
]);

export const controlHostObservedResultSchema = z.object({
  provenance: z.literal("host_observed"),
  observedAt: z.string().datetime(),
  result: controlResultSubmissionSchema,
}).strict();

const finalFailedObservationSchema = finalHostFailureSchema.extend({
  terminalResult: controlResultSubmissionSchema.optional(),
}).strict();

export const controlTerminalObservationSchema = z.union([
  finalComputerUseResultSchema,
  finalFailedObservationSchema,
  responseStartFailureSchema,
  pageLostHostFailureSchema,
  authorityInvalidHostFailureSchema,
]);

export const controlPageObservationSchema = z.union([
  observedPageIdentity.extend({ state: z.literal("send_attempted") }).strict(),
  observedPageIdentity.extend({ state: z.literal("sent") }).strict(),
  observedPageIdentity.extend({ state: z.literal("unknown") }).strict(),
  responseIdentity.extend({ state: z.literal("response_created") }).strict(),
  responseIdentity.extend({ state: z.literal("generating") }).strict(),
  finalComputerUseResultSchema,
  finalFailedObservationSchema,
  responseStartFailureSchema,
  pageLostHostFailureSchema,
  authorityInvalidHostFailureSchema,
]);

export type ControlHostFailure = z.infer<typeof controlHostFailureSchema>;
export type ControlHostObservedResult = z.infer<typeof controlHostObservedResultSchema>;
export type ControlTerminalObservation = z.infer<typeof controlTerminalObservationSchema>;
export type ControlPageObservation = z.infer<typeof controlPageObservationSchema>;
export type DefinitiveControlPageObservation = Exclude<ControlPageObservation, { state: "unknown" }>;

export interface ControlPageObservationState {
  latest: ControlPageObservation;
  lastDefinitive: DefinitiveControlPageObservation | null;
}

export function parseControlPageObservation(value: unknown): ControlPageObservation {
  const parsed = controlPageObservationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ControlMailboxError(
      "INVALID_RESULT",
      "invalid control page observation; raw page text and unlisted diagnostic fields are not accepted",
    );
  }
  if (parsed.data.state !== "final" || !parsed.data.terminalResult) return parsed.data;
  return {
    ...parsed.data,
    terminalResult: parseControlResultSubmission(parsed.data.terminalResult),
  };
}

function isTerminalObservation(
  observation: ControlPageObservation,
): observation is ControlTerminalObservation {
  return (
    observation.state === "final" ||
    observation.state === "response_start_failed" ||
    observation.state === "page_lost" ||
    observation.state === "authority_invalid"
  );
}

/** Validate one exact, monotonically ordered page event without trusting page text. */
export function advanceControlPageObservation(
  previous: ControlPageObservationState | null,
  input: ControlPageObservation,
): { state: ControlPageObservationState; idempotentReplay: boolean; terminal: ControlTerminalObservation | null } {
  const observation = parseControlPageObservation(input);
  if (previous && observation.observationSequence === previous.latest.observationSequence) {
    if (JSON.stringify(observation) === JSON.stringify(previous.latest)) {
      return {
        state: previous,
        idempotentReplay: true,
        terminal: isTerminalObservation(previous.latest) ? previous.latest : null,
      };
    }
    throw new ControlMailboxError("MAILBOX_PROGRESS_OUT_OF_ORDER", "page observation sequence conflicts with an existing event");
  }
  if (previous && observation.observationSequence < previous.latest.observationSequence) {
    throw new ControlMailboxError("MAILBOX_PROGRESS_OUT_OF_ORDER", "page observation is stale or out of order");
  }
  const prior = previous?.lastDefinitive ?? null;
  if (observation.state === "unknown") {
    return {
      state: { latest: observation, lastDefinitive: prior },
      idempotentReplay: false,
      terminal: null,
    };
  }

  const transitionAllowed =
    (observation.state === "send_attempted" && prior === null) ||
    (observation.state === "sent" && prior?.state === "send_attempted") ||
    (observation.state === "response_start_failed" &&
      (prior?.state === "send_attempted" || prior?.state === "sent")) ||
    (observation.state === "response_created" && prior?.state === "sent") ||
    (observation.state === "generating" && (prior?.state === "response_created" || prior?.state === "generating")) ||
    (observation.state === "final" && (prior?.state === "response_created" || prior?.state === "generating")) ||
    observation.state === "page_lost" ||
    observation.state === "authority_invalid";
  if (!transitionAllowed) {
    throw new ControlMailboxError("MAILBOX_PROGRESS_OUT_OF_ORDER", "page observation does not follow the exact response lifecycle");
  }

  if (
    "responseId" in observation &&
    prior && "responseId" in prior &&
    observation.responseId !== prior.responseId
  ) {
    throw new ControlMailboxError("MAILBOX_CORRELATION_MISMATCH", "page observation belongs to a replacement or older response");
  }

  const state = { latest: observation, lastDefinitive: observation };
  return {
    state,
    idempotentReplay: false,
    terminal: isTerminalObservation(observation) ? observation : null,
  };
}

export function controlWaitPolicy(status: ControlStatus, now = Date.now()) {
  const remainingMs = status.request ? Math.max(0, Date.parse(status.request.expiresAt) - now) : 0;
  const received = status.status === "received" || status.status === "acknowledged";
  const hostObserved = status.status === "cancelled" && status.hostObservedResult !== undefined;
  const outcome = received
    ? status.result?.kind === "BLOCKED" ? "blocked" : "delivered"
    : hostObserved ? status.hostObservedResult?.result.kind === "BLOCKED" ? "blocked" : "delivered"
    : status.status !== "pending" ? "terminal" : "pending";
  const observedState = status.pageObservation?.lastDefinitive?.state;
  const pendingAction = observedState === undefined
    ? "mark_send_attempted"
    : observedState === "send_attempted"
      ? "confirm_send"
      : observedState === "sent"
        ? "inspect_response_start"
        : "inspect_exact_response";
  return {
    outcome,
    delivery: received ? "mcp" : hostObserved ? "computer_use" : "none",
    nextAction: received
      ? status.status === "received" ? "persist_then_ack" : "stop"
      : outcome === "pending" ? pendingAction : "stop",
    leaseExpiresAt: status.request?.expiresAt ?? null,
    leaseRemainingMs: remainingMs,
    elapsedMs: status.request ? Math.max(0, now - Date.parse(status.request.createdAt)) : 0,
    checkPageAfterMs: outcome === "pending" && remainingMs > 0
      ? Math.min(CONTROL_PAGE_CHECK_INTERVAL_MS, Math.max(1, Math.floor(remainingMs / 2))) : 0,
  };
}
