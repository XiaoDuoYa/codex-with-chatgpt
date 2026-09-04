import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { redact } from "../logger/index.js";

export const CONTROL_PHASES = ["RESEARCH", "PLAN", "REVIEW"] as const;
export const CONTROL_RESULT_KINDS = ["RESEARCH", "PLAN", "REVIEW", "DONE", "BLOCKED"] as const;
export const CONTROL_PROGRESS_STATES = ["SEARCHING", "READING_CODE", "SYNTHESIZING"] as const;
export const MAX_CONTROL_RESULT_BYTES = 32 * 1024;
export const MAX_C2C_ITERATION = 10_000;
export const C2C_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type ControlPhase = (typeof CONTROL_PHASES)[number];
export type ControlResultKind = (typeof CONTROL_RESULT_KINDS)[number];
export type ControlProgressState = (typeof CONTROL_PROGRESS_STATES)[number];

export const RESEARCH_ALLOWED_KINDS = ["RESEARCH", "BLOCKED"] as const;
export const PLAN_ALLOWED_KINDS = ["PLAN", "BLOCKED"] as const;
export const REVIEW_ALLOWED_KINDS = ["REVIEW", "DONE", "BLOCKED"] as const;

export type ControlMailboxErrorCode =
  | "AUTH_REQUIRED"
  | "MAILBOX_REQUEST_NOT_FOUND"
  | "MAILBOX_REQUEST_EXPIRED"
  | "MAILBOX_REQUEST_CANCELLED"
  | "MAILBOX_SESSION_MISMATCH"
  | "MAILBOX_CORRELATION_MISMATCH"
  | "MAILBOX_TURN_IN_PROGRESS"
  | "MAILBOX_INTEGRITY_ERROR"
  | "MAILBOX_KIND_NOT_ALLOWED"
  | "MAILBOX_RESULT_NOT_READY"
  | "MAILBOX_REQUEST_NOT_PENDING"
  | "MAILBOX_PROGRESS_NOT_ALLOWED"
  | "MAILBOX_PROGRESS_OUT_OF_ORDER"
  | "RESULT_ALREADY_SUBMITTED"
  | "MAILBOX_QUOTA_EXCEEDED"
  | "INVALID_RESULT";

export class ControlMailboxError extends Error {
  constructor(
    readonly code: ControlMailboxErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ControlMailboxError";
  }
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_PATH_CONTROL = /[\u0000-\u001f\u007f]/;

function boundedText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .transform((value, ctx) => {
      const normalized = value.replace(/\r\n?/g, "\n").trim();
      if (!normalized) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "empty text" });
        return z.NEVER;
      }
      if (PRIVATE_KEY_BLOCK.test(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "private key blocks are not allowed" });
        return z.NEVER;
      }
      if (UNSAFE_CONTROL.test(normalized)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unsafe control characters are not allowed" });
        return z.NEVER;
      }
      if (redact(normalized) !== normalized) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suspected credentials are not allowed" });
        return z.NEVER;
      }
      return normalized;
    });
}

const relativeFileHintSchema = z
  .string()
  .min(1)
  .max(240)
  .transform((value, ctx) => {
    const normalized = value.replace(/\\/g, "/").trim();
    if (
      !normalized ||
      UNSAFE_PATH_CONTROL.test(normalized) ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      path.isAbsolute(normalized) ||
      normalized.split("/").some((part) => part === "..")
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "file hints must stay workspace-relative" });
      return z.NEVER;
    }
    return normalized;
  });

export const c2cIdSchema = z.string().regex(C2C_ID_PATTERN);

const actionSchema = z
  .object({
    file: relativeFileHintSchema.optional(),
    change: boundedText(1000),
    why: boundedText(1000),
    risks: z.array(boundedText(400)).max(6).optional(),
  })
  .strict();

const testAdviceSchema = boundedText(500);
const successCriterionSchema = boundedText(500);

const researchSourceUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    const normalized = value.trim();
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "research source URL is invalid" });
      return z.NEVER;
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      redact(normalized) !== normalized
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "research source URL is unsafe" });
      return z.NEVER;
    }
    return parsed.toString();
  });

const publishedDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "publishedDate must use YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "publishedDate must be a real calendar date")
  .nullable();

const researchSourceSchema = z
  .object({
    title: boundedText(300),
    url: researchSourceUrlSchema,
    publishedDate: publishedDateSchema,
    keyEvidence: boundedText(1200),
  })
  .strict();

export const researchPayloadSchema = z
  .object({
    question: boundedText(1200),
    summary: boundedText(4000),
    conclusions: z.array(boundedText(1200)).min(1).max(20),
    sources: z.array(researchSourceSchema).min(1).max(20),
    openQuestions: z.array(boundedText(600)).max(12).default([]),
  })
  .strict()
  .describe("RESEARCH payload");

const findingSchema = z
  .object({
    severity: z.enum(["low", "medium", "high"]),
    file: relativeFileHintSchema.optional(),
    location: boundedText(160).optional(),
    issue: boundedText(1000),
    recommendation: boundedText(1000),
  })
  .strict();

export const planPayloadSchema = z
  .object({
    goal: boundedText(1200),
    rationale: boundedText(4000),
    actions: z.array(actionSchema).min(1).max(20),
    tests: z.array(testAdviceSchema).max(20).default([]),
    successCriteria: z.array(successCriterionSchema).min(1).max(12),
  })
  .strict()
  .describe("PLAN payload");

export const reviewPayloadSchema = z
  .object({
    summary: boundedText(2000),
    findings: z.array(findingSchema).min(1).max(20),
    actions: z.array(actionSchema).min(1).max(20),
    tests: z.array(testAdviceSchema).max(20).default([]),
    successCriteria: z.array(successCriterionSchema).min(1).max(12),
  })
  .strict()
  .describe("REVIEW payload");

export const donePayloadSchema = z
  .object({
    summary: boundedText(2000),
    verification: z.array(boundedText(500)).min(1).max(20),
    remainingRisks: z.array(boundedText(500)).max(12).optional(),
  })
  .strict()
  .describe("DONE payload");

export const blockedPayloadSchema = z
  .object({
    reason: boundedText(2000),
    needs: z.array(boundedText(500)).min(1).max(12),
  })
  .strict()
  .describe("BLOCKED payload");

export const submitControlResultInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      requestId: c2cIdSchema,
      localSessionId: c2cIdSchema,
      taskId: c2cIdSchema,
      iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
      phase: z.literal("RESEARCH"),
      kind: z.literal("RESEARCH"),
      payload: researchPayloadSchema,
    })
    .strict(),
  z
    .object({
      requestId: c2cIdSchema,
      localSessionId: c2cIdSchema,
      taskId: c2cIdSchema,
      iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
      phase: z.literal("PLAN"),
      kind: z.literal("PLAN"),
      payload: planPayloadSchema,
    })
    .strict(),
  z
    .object({
      requestId: c2cIdSchema,
      localSessionId: c2cIdSchema,
      taskId: c2cIdSchema,
      iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
      phase: z.literal("REVIEW"),
      kind: z.literal("REVIEW"),
      payload: reviewPayloadSchema,
    })
    .strict(),
  z
    .object({
      requestId: c2cIdSchema,
      localSessionId: c2cIdSchema,
      taskId: c2cIdSchema,
      iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
      phase: z.literal("REVIEW"),
      kind: z.literal("DONE"),
      payload: donePayloadSchema,
    })
    .strict(),
  z
    .object({
      requestId: c2cIdSchema,
      localSessionId: c2cIdSchema,
      taskId: c2cIdSchema,
      iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
      phase: z.enum(CONTROL_PHASES),
      kind: z.literal("BLOCKED"),
      payload: blockedPayloadSchema,
    })
    .strict(),
]);

export type SubmitControlResultInput = z.infer<typeof submitControlResultInputSchema>;

export const reportControlProgressInputSchema = z
  .object({
    requestId: c2cIdSchema,
    localSessionId: c2cIdSchema,
    taskId: c2cIdSchema,
    iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
    phase: z.enum(CONTROL_PHASES),
    status: z.enum(CONTROL_PROGRESS_STATES),
    message: boundedText(500).optional(),
  })
  .strict();

export type ReportControlProgressInput = z.infer<typeof reportControlProgressInputSchema>;

export interface ControlResultCorrelation {
  taskId: string;
  iteration: number;
  phase: ControlPhase;
}

export interface ControlResultRequest {
  schemaVersion: 1;
  requestId: string;
  workspaceId: string;
  localSessionId: string;
  taskId: string;
  iteration: number;
  phase: ControlPhase;
  allowedKinds: ControlResultKind[];
  createdAt: string;
  expiresAt: string;
}

export interface ControlResultEnvelope {
  schemaVersion: 1;
  requestId: string;
  workspaceId: string;
  localSessionId: string;
  taskId: string;
  iteration: number;
  phase: ControlPhase;
  kind: ControlResultKind;
  payload: SubmitControlResultInput["payload"];
  receivedAt: string;
  payloadHash: string;
  resultId: string;
}

export interface ControlResultReceipt {
  accepted: true;
  requestId: string;
  localSessionId: string;
  resultId: string;
  phase: ControlPhase;
  kind: ControlResultKind;
  receivedAt: string;
  idempotentReplay: boolean;
}

export interface ControlProgressEnvelope {
  schemaVersion: 1;
  requestId: string;
  workspaceId: string;
  localSessionId: string;
  taskId: string;
  iteration: number;
  phase: ControlPhase;
  status: ControlProgressState;
  message: string | null;
  reportedAt: string;
  progressHash: string;
  progressId: string;
}

export interface ControlProgressReceipt {
  accepted: true;
  requestId: string;
  localSessionId: string;
  progressId: string;
  phase: ControlPhase;
  status: ControlProgressState;
  reportedAt: string;
  idempotentReplay: boolean;
}

export function allowedKindsForPhase(phase: ControlPhase): ControlResultKind[] {
  if (phase === "RESEARCH") return [...RESEARCH_ALLOWED_KINDS];
  return phase === "PLAN" ? [...PLAN_ALLOWED_KINDS] : [...REVIEW_ALLOWED_KINDS];
}

export function parseSubmitControlResultInput(input: unknown): SubmitControlResultInput {
  const parsed = submitControlResultInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ControlMailboxError("INVALID_RESULT", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  assertCanonicalSize(parsed.data);
  return parsed.data;
}

export function parseReportControlProgressInput(input: unknown): ReportControlProgressInput {
  const parsed = reportControlProgressInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ControlMailboxError("INVALID_RESULT", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  assertCanonicalSize(parsed.data);
  return parsed.data;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertCanonicalSize(value: unknown): void {
  const size = Buffer.byteLength(canonicalJson(value), "utf8");
  if (size > MAX_CONTROL_RESULT_BYTES) {
    throw new ControlMailboxError("INVALID_RESULT", `control result exceeds ${MAX_CONTROL_RESULT_BYTES} bytes`);
  }
}

export function validateControlId(value: string, label = "id"): string {
  const normalized = value.trim();
  if (!C2C_ID_PATTERN.test(normalized)) {
    throw new ControlMailboxError("INVALID_RESULT", `${label} must be a safe identifier`);
  }
  return normalized;
}

export function validateLocalSessionId(value: string): string {
  return validateControlId(value, "local session id");
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortForCanonicalJson(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortForCanonicalJson((value as Record<string, unknown>)[key]);
  }
  return out;
}
