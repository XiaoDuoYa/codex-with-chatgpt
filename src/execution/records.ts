import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getWorkspaceDataDir, withFileLock } from "../config/paths.js";
import { C2C_ID_PATTERN, MAX_C2C_ITERATION } from "../control/result-schema.js";

export const EXECUTION_EXIT_STATUSES = ["ok", "failed", "blocked"] as const;
export type ExecutionExitStatus = (typeof EXECUTION_EXIT_STATUSES)[number];

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  workspaceId: string;
  localSessionId: string;
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: ExecutionExitStatus;
  timestamp: string;
  notes?: string;
  /** Present when Codex recorded a sanitized command output for this iteration. */
  outputId?: number;
  outputAvailable?: boolean;
}

export interface ExecutionRecordFilter {
  localSessionId?: string;
  taskId?: string;
  iteration?: number;
}

export type ExecutionRecordInput = Omit<ExecutionRecord, "workspaceId">;

const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const safeIdSchema = z.string().regex(C2C_ID_PATTERN);
const canonicalTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  "timestamp must be canonical ISO-8601"
);
const boundedTextSchema = (max: number) =>
  z.string().max(max).refine((value) => !UNSAFE_TEXT.test(value), "text contains unsafe control characters");
const changedFileSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.trim() === value, "changed file path is not canonical")
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.replace(/\\/g, "/").split("/").some((part) => part === "..") &&
      !UNSAFE_TEXT.test(value),
    "changed file path must be workspace-relative"
  );
const executionRecordSchema = z
  .object({
    workspaceId: safeIdSchema,
    localSessionId: safeIdSchema,
    taskId: safeIdSchema,
    iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
    changedFiles: z.union([
      z.array(changedFileSchema).max(1_000).refine((files) => new Set(files).size === files.length, "changed files must be unique"),
      z.number().int().min(0).max(1_000_000),
    ]),
    tests: boundedTextSchema(1_000).nullable(),
    exitStatus: z.enum(EXECUTION_EXIT_STATUSES),
    timestamp: canonicalTimestampSchema,
    notes: boundedTextSchema(400).optional(),
    outputId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    outputAvailable: z.boolean().optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.outputAvailable === true && record.outputId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "available output requires an output id" });
    }
    if (record.outputId !== undefined && record.outputAvailable === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "output id requires availability metadata" });
    }
  });

function validatedWorkspaceId(workspaceId: string): string {
  const parsed = safeIdSchema.safeParse(workspaceId);
  if (!parsed.success || parsed.data !== workspaceId) throw new Error("execution record workspace id is invalid");
  return parsed.data;
}

export function parseExecutionExitStatus(value: string): ExecutionExitStatus {
  const parsed = z.enum(EXECUTION_EXIT_STATUSES).safeParse(value);
  if (!parsed.success) throw new Error(`exit-status must be one of ${EXECUTION_EXIT_STATUSES.join(", ")}`);
  return parsed.data;
}

export function validateExecutionRecordInput(
  workspaceId: string,
  record: ExecutionRecordInput
): ExecutionRecordInput {
  const parsed = executionRecordSchema.parse({ ...record, workspaceId: validatedWorkspaceId(workspaceId) });
  const { workspaceId: _workspaceId, ...validated } = parsed;
  return validated;
}

function recordsFile(workspaceId: string): string {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const dir = ensureDir(path.join(getWorkspaceDataDir(resolvedWorkspaceId), "executions"));
  return path.join(dir, "records.jsonl");
}

function repairInterruptedTail(file: string, workspaceId: string): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8");
  if (content === "" || content.endsWith("\n")) return;
  const lastNewline = content.lastIndexOf("\n");
  const tail = content.slice(lastNewline + 1);
  try {
    parseExecutionRecord(JSON.parse(tail), workspaceId);
    fs.appendFileSync(file, "\n", { mode: 0o600 });
  } catch {
    fs.truncateSync(file, lastNewline + 1);
  }
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecordInput): void {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const validated = validateExecutionRecordInput(resolvedWorkspaceId, record);
  const file = recordsFile(workspaceId);
  withFileLock(`${file}.lock`, () => {
    repairInterruptedTail(file, resolvedWorkspaceId);
    fs.appendFileSync(file, JSON.stringify({ ...validated, workspaceId: resolvedWorkspaceId } satisfies ExecutionRecord) + "\n", {
      mode: 0o600,
    });
  });
}

function matchesFilter(record: ExecutionRecord, filter: ExecutionRecordFilter): boolean {
  return (
    (filter.localSessionId === undefined || record.localSessionId === filter.localSessionId) &&
    (filter.taskId === undefined || record.taskId === filter.taskId) &&
    (filter.iteration === undefined || record.iteration === filter.iteration)
  );
}

function parseExecutionRecord(value: unknown, workspaceId: string): ExecutionRecord {
  const parsed = executionRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.workspaceId !== workspaceId) {
    throw new Error("execution record does not match its workspace or schema");
  }
  return parsed.data;
}

export function readExecutionRecords(
  workspaceId: string,
  limit = 10,
  filter: ExecutionRecordFilter = {}
): ExecutionRecord[] {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("execution record limit must be an integer between 1 and 50");
  }
  const parsedFilter = z
    .object({
      localSessionId: safeIdSchema.optional(),
      taskId: safeIdSchema.optional(),
      iteration: z.number().int().min(0).max(MAX_C2C_ITERATION).optional(),
    })
    .strict()
    .parse(filter);
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf8");
  const hasInterruptedTail = content !== "" && !content.endsWith("\n");
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records: ExecutionRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    const isInterruptedTail = hasInterruptedTail && index === lines.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isInterruptedTail) break;
      throw new Error("execution record log is unreadable or malformed");
    }
    let record: ExecutionRecord;
    try {
      record = parseExecutionRecord(parsed, resolvedWorkspaceId);
    } catch (error) {
      if (isInterruptedTail) break;
      throw error;
    }
    if (matchesFilter(record, parsedFilter)) records.push(record);
  }
  return records.slice(-limit);
}

export function latestExecutionRecord(
  workspaceId: string,
  filter: ExecutionRecordFilter = {}
): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1, filter);
  return records[records.length - 1] ?? null;
}
