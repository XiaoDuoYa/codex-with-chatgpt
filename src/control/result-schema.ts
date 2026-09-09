import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { redact } from "../logger/index.js";
import { isBrowserTabId } from "../session/browser-tab-id.js";

export const CONTROL_PHASES = ["BOOT", "RESEARCH", "PLAN", "REVIEW"] as const;
export const CONTROL_RESULT_KINDS = ["BOOT", "RESEARCH", "PLAN", "REVIEW", "DONE", "BLOCKED"] as const;
export const CONTROL_PROGRESS_STATES = ["SEARCHING", "READING_CODE", "SYNTHESIZING"] as const;
export const MAX_CONTROL_RESULT_BYTES = 16 * 1024;
export const MAX_STORED_CONTROL_RESULT_BYTES = 32 * 1024;
export const MAX_C2C_ITERATION = 10_000;
export const C2C_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type ControlPhase = (typeof CONTROL_PHASES)[number];
export type ControlResultKind = (typeof CONTROL_RESULT_KINDS)[number];
export type ControlProgressState = (typeof CONTROL_PROGRESS_STATES)[number];

export const BOOT_ALLOWED_KINDS = ["BOOT", "BLOCKED"] as const;
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

interface ControlPayloadLimits {
  actionText: number;
  actionRisks: number;
  riskText: number;
  testText: number;
  criterionText: number;
  sourceTitle: number;
  sourceEvidence: number;
  question: number;
  summary: number;
  terminalSummary: number;
  conclusionText: number;
  conclusions: number;
  sources: number;
  openQuestionText: number;
  openQuestions: number;
  findingLocation: number;
  findingText: number;
  findings: number;
  goal: number;
  rationale: number;
  actions: number;
  tests: number;
  criteria: number;
  verification: number;
  remainingRisks: number;
  blockedReason: number;
  needText: number;
  needs: number;
}

const CURRENT_PAYLOAD_LIMITS: ControlPayloadLimits = {
  actionText: 600, actionRisks: 4, riskText: 300, testText: 300, criterionText: 300,
  sourceTitle: 200, sourceEvidence: 600, question: 600, summary: 2_000, terminalSummary: 1_200,
  conclusionText: 600, conclusions: 12, sources: 12, openQuestionText: 300,
  openQuestions: 6, findingLocation: 120, findingText: 600, findings: 12,
  goal: 600, rationale: 2_000, actions: 12, tests: 12, criteria: 8,
  verification: 12, remainingRisks: 6, blockedReason: 600, needText: 240, needs: 5,
};

const STORED_PAYLOAD_LIMITS: ControlPayloadLimits = {
  actionText: 1_000, actionRisks: 6, riskText: 400, testText: 500, criterionText: 500,
  sourceTitle: 300, sourceEvidence: 1_200, question: 1_200, summary: 4_000, terminalSummary: 2_000,
  conclusionText: 1_200, conclusions: 20, sources: 20, openQuestionText: 600,
  openQuestions: 12, findingLocation: 160, findingText: 1_000, findings: 20,
  goal: 1_200, rationale: 4_000, actions: 20, tests: 20, criteria: 12,
  verification: 20, remainingRisks: 12, blockedReason: 2_000, needText: 500, needs: 12,
};

function createControlPayloadSchemas(limits: ControlPayloadLimits) {
  const action = z.object({
    file: relativeFileHintSchema.optional(),
    change: boundedText(limits.actionText),
    why: boundedText(limits.actionText),
    risks: z.array(boundedText(limits.riskText)).max(limits.actionRisks).optional(),
  }).strict();
  const researchSource = z.object({
    title: boundedText(limits.sourceTitle),
    url: researchSourceUrlSchema.describe("Real external HTTP(S) source URL without credentials; never workspace:/ or file://"),
    publishedDate: publishedDateSchema.describe("YYYY-MM-DD when known, otherwise null"),
    keyEvidence: boundedText(limits.sourceEvidence),
  }).strict();
  const finding = z.object({
    severity: z.enum(["low", "medium", "high"]),
    file: relativeFileHintSchema.optional(),
    location: boundedText(limits.findingLocation).optional(),
    issue: boundedText(limits.findingText),
    recommendation: boundedText(limits.findingText),
  }).strict();
  return {
    boot: z.object({}).strict().describe("BOOT payload; verified identity is derived from the bound capability"),
    research: z.object({
      question: boundedText(limits.question),
      summary: boundedText(limits.summary),
      conclusions: z.array(boundedText(limits.conclusionText)).min(1).max(limits.conclusions)
        .describe("Evidence-backed conclusions. Cite workspace-relative files and line numbers here for local reads."),
      sources: z.array(researchSource).max(limits.sources)
        .describe("External sources actually consulted. Use [] for local-only research; never invent a URL to cite a local file."),
      openQuestions: z.array(boundedText(limits.openQuestionText)).max(limits.openQuestions).default([]),
    }).strict().describe("RESEARCH payload"),
    plan: z.object({
      goal: boundedText(limits.goal),
      rationale: boundedText(limits.rationale),
      actions: z.array(action).min(1).max(limits.actions),
      tests: z.array(boundedText(limits.testText)).max(limits.tests).default([]),
      successCriteria: z.array(boundedText(limits.criterionText)).min(1).max(limits.criteria),
    }).strict().describe("PLAN payload"),
    review: z.object({
      summary: boundedText(limits.terminalSummary),
      findings: z.array(finding).min(1).max(limits.findings),
      actions: z.array(action).min(1).max(limits.actions),
      tests: z.array(boundedText(limits.testText)).max(limits.tests).default([]),
      successCriteria: z.array(boundedText(limits.criterionText)).min(1).max(limits.criteria),
    }).strict().describe("REVIEW payload"),
    done: z.object({
      summary: boundedText(limits.terminalSummary),
      verification: z.array(boundedText(limits.testText)).min(1).max(limits.verification),
      remainingRisks: z.array(boundedText(limits.testText)).max(limits.remainingRisks).optional(),
    }).strict().describe("DONE payload"),
    blocked: z.object({
      reason: boundedText(limits.blockedReason),
      needs: z.array(boundedText(limits.needText)).min(1).max(limits.needs),
    }).strict().describe("BLOCKED payload"),
  };
}

const currentPayloadSchemas = createControlPayloadSchemas(CURRENT_PAYLOAD_LIMITS);
const storedPayloadSchemas = createControlPayloadSchemas(STORED_PAYLOAD_LIMITS);
export const bootPayloadSchema = currentPayloadSchemas.boot;
export const researchPayloadSchema = currentPayloadSchemas.research;
export const planPayloadSchema = currentPayloadSchemas.plan;
export const reviewPayloadSchema = currentPayloadSchemas.review;
export const donePayloadSchema = currentPayloadSchemas.done;
export const blockedPayloadSchema = currentPayloadSchemas.blocked;

function createControlResultSubmissionSchema(payloads: ReturnType<typeof createControlPayloadSchemas>) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("BOOT"), payload: payloads.boot }).strict(),
    z.object({ kind: z.literal("RESEARCH"), payload: payloads.research }).strict(),
    z.object({ kind: z.literal("PLAN"), payload: payloads.plan }).strict(),
    z.object({ kind: z.literal("REVIEW"), payload: payloads.review }).strict(),
    z.object({ kind: z.literal("DONE"), payload: payloads.done }).strict(),
    z.object({ kind: z.literal("BLOCKED"), payload: payloads.blocked }).strict(),
  ]);
}

function createSubmitControlResultInputSchema(payloads: ReturnType<typeof createControlPayloadSchemas>) {
  const correlation = {
    requestId: c2cIdSchema,
    localSessionId: c2cIdSchema,
    taskId: c2cIdSchema,
    iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
  };
  return z.discriminatedUnion("kind", [
    z.object({ ...correlation, phase: z.literal("BOOT"), kind: z.literal("BOOT"), payload: payloads.boot }).strict(),
    z.object({ ...correlation, phase: z.literal("RESEARCH"), kind: z.literal("RESEARCH"), payload: payloads.research }).strict(),
    z.object({ ...correlation, phase: z.literal("PLAN"), kind: z.literal("PLAN"), payload: payloads.plan }).strict(),
    z.object({ ...correlation, phase: z.literal("REVIEW"), kind: z.literal("REVIEW"), payload: payloads.review }).strict(),
    z.object({ ...correlation, phase: z.literal("REVIEW"), kind: z.literal("DONE"), payload: payloads.done }).strict(),
    z.object({ ...correlation, phase: z.enum(CONTROL_PHASES), kind: z.literal("BLOCKED"), payload: payloads.blocked }).strict(),
  ]);
}

export const controlResultSubmissionSchema = createControlResultSubmissionSchema(currentPayloadSchemas);
const storedSubmitControlResultInputSchema = createSubmitControlResultInputSchema(storedPayloadSchemas);
export const submitControlResultInputSchema = createSubmitControlResultInputSchema(currentPayloadSchemas);

export type ControlResultSubmission = z.infer<typeof controlResultSubmissionSchema>;

export type SubmitControlResultInput = z.infer<typeof submitControlResultInputSchema>;

export const controlProgressUpdateSchema = z
  .object({
    status: z.enum(CONTROL_PROGRESS_STATES),
    message: boundedText(500).optional(),
  })
  .strict();

export type ControlProgressUpdate = z.infer<typeof controlProgressUpdateSchema>;

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
  schemaVersion: 2;
  requestId: string;
  workspaceId: string;
  localSessionId: string;
  taskId: string;
  iteration: number;
  phase: ControlPhase;
  allowedKinds: ControlResultKind[];
  /** Surface generation that authorized this request, or null for isolated mailbox use. */
  surfaceGeneration: number | null;
  /** Exact browser tab that authorized this request, paired with surfaceGeneration. */
  surfaceTabId: string | null;
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
  if (phase === "BOOT") return [...BOOT_ALLOWED_KINDS];
  if (phase === "RESEARCH") return [...RESEARCH_ALLOWED_KINDS];
  return phase === "PLAN" ? [...PLAN_ALLOWED_KINDS] : [...REVIEW_ALLOWED_KINDS];
}

export function parseSubmitControlResultInput(input: unknown): SubmitControlResultInput {
  const parsed = submitControlResultInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ControlMailboxError("INVALID_RESULT", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  assertCanonicalSize({ kind: parsed.data.kind, payload: parsed.data.payload });
  return parsed.data;
}

export function parseControlResultSubmission(input: unknown): ControlResultSubmission {
  const parsed = controlResultSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ControlMailboxError("INVALID_RESULT", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  assertCanonicalSize(parsed.data);
  return parsed.data;
}

/** Validate immutable mailbox data accepted before the tighter admission contract. */
export function parseStoredSubmitControlResultInput(input: unknown): SubmitControlResultInput {
  const parsed = storedSubmitControlResultInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ControlMailboxError("INVALID_RESULT", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  assertCanonicalSize({ kind: parsed.data.kind, payload: parsed.data.payload }, MAX_STORED_CONTROL_RESULT_BYTES);
  return parsed.data as SubmitControlResultInput;
}

export function parseReportControlProgressInput(input: unknown): ReportControlProgressInput {
  const parsed = reportControlProgressInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ControlMailboxError("INVALID_RESULT", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  assertCanonicalSize(parsed.data);
  return parsed.data;
}

export function parseControlProgressUpdate(input: unknown): ControlProgressUpdate {
  const parsed = controlProgressUpdateSchema.safeParse(input);
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

export function assertCanonicalSize(value: unknown, maximumBytes = MAX_CONTROL_RESULT_BYTES): void {
  const size = Buffer.byteLength(canonicalJson(value), "utf8");
  if (size > maximumBytes) {
    throw new ControlMailboxError("INVALID_RESULT", `control result exceeds ${maximumBytes} bytes`);
  }
}

export function validateControlId(value: string, label = "id"): string {
  const normalized = value.trim();
  if (!C2C_ID_PATTERN.test(normalized)) {
    throw new ControlMailboxError("INVALID_RESULT", `${label} must be a safe identifier`);
  }
  return normalized;
}

export function validateBrowserTabId(value: string, label = "tab id"): string {
  if (!isBrowserTabId(value)) {
    throw new ControlMailboxError("INVALID_RESULT", `${label} must be a valid browser locator`);
  }
  return value;
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
