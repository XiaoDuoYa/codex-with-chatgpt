import { z } from "zod";
import type { ControlStatus } from "./mailbox.js";
import { ControlMailboxError, c2cIdSchema } from "./result-schema.js";

export const CONTROL_PAGE_CHECK_INTERVAL_MS = 30_000;

const observationIdentity = z.object({
  tabId: c2cIdSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedUrl: z.string().url().max(4_096),
  observedAt: z.string().datetime(),
  responseToRequestId: c2cIdSchema,
}).strict();

// No free-form page excerpts: these diagnostics must not persist credentials or business data.
export const controlHostFailureSchema = observationIdentity.extend({
  state: z.literal("blocked"),
  responseIsFinal: z.literal(true),
  reason: z.enum(["model_refusal", "tool_unavailable", "platform_blocked", "capability_invalid", "callback_missing"]),
  source: z.enum(["model_reported", "platform_error", "mcp_error", "host_observed"]),
  tool: z.enum(["report_control_progress", "submit_control_result", "get_control_result_status", "business_tool"]).optional(),
  errorCode: z.enum(["TOKEN_REVOKED", "TOKEN_EXPIRED", "STALE_BINDING_EPOCH", "TOOL_UNAVAILABLE", "SAFETY_CHECK_BLOCKED", "APPROVAL_REQUIRED", "UNKNOWN"]).optional(),
}).strict();

export const controlPageObservationSchema = z.discriminatedUnion("state", [
  controlHostFailureSchema,
  observationIdentity.extend({ state: z.enum(["generating", "unknown"]) }).strict(),
]);

export type ControlHostFailure = z.infer<typeof controlHostFailureSchema>;
export type ControlPageObservation = z.infer<typeof controlPageObservationSchema>;

export function parseControlPageObservation(value: unknown): ControlPageObservation {
  const parsed = controlPageObservationSchema.safeParse(value);
  if (!parsed.success) throw new ControlMailboxError("INVALID_RESULT", "invalid control page observation; raw page text and unlisted diagnostic fields are not accepted");
  return parsed.data;
}

export function controlWaitPolicy(status: ControlStatus, now = Date.now()) {
  const remainingMs = status.request ? Math.max(0, Date.parse(status.request.expiresAt) - now) : 0;
  const received = status.status === "received" || status.status === "acknowledged";
  const outcome = received
    ? status.result?.kind === "BLOCKED" ? "blocked" : "delivered"
    : status.status !== "pending" ? "terminal" : "pending";
  return {
    outcome,
    nextAction: received
      ? status.status === "received" ? "persist_then_ack" : "stop"
      : outcome === "pending" ? "inspect_exact_response" : "stop",
    leaseExpiresAt: status.request?.expiresAt ?? null,
    leaseRemainingMs: remainingMs,
    elapsedMs: status.request ? Math.max(0, now - Date.parse(status.request.createdAt)) : 0,
    checkPageAfterMs: outcome === "pending" && remainingMs > 0
      ? Math.min(CONTROL_PAGE_CHECK_INTERVAL_MS, Math.max(1, Math.floor(remainingMs / 2))) : 0,
  };
}
