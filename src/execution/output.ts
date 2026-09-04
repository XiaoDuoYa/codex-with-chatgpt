import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir, readJsonIfExists, withFileLock, writeSecureJson } from "../config/paths.js";
import { C2C_ID_PATTERN, MAX_C2C_ITERATION } from "../control/result-schema.js";
import { redact } from "../logger/index.js";
import { MAX_OUTPUT_BYTES, sanitizeExecutionOutput } from "./sanitize.js";

export const MAX_OUTPUT_RECORDS = 40;

export interface ExecutionOutputMeta {
  id: number;
  workspaceId: string;
  command: string;
  exitCode: number | null;
  timestamp: string;
  localSessionId: string;
  taskId: string;
  iteration: number;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  sizeBytes: number;
  contentHash: string;
}

interface OutputIndex {
  schemaVersion: 2;
  workspaceId: string;
  nextId: number;
  items: ExecutionOutputMeta[];
}

const safeIdSchema = z.string().regex(C2C_ID_PATTERN);
const safePositiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const canonicalTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  "timestamp must be canonical ISO-8601"
);

const executionOutputMetaSchema = z
  .object({
    id: safePositiveIntegerSchema,
    workspaceId: safeIdSchema,
    command: z.string().max(200),
    exitCode: z.number().int().min(0).max(255).nullable(),
    timestamp: canonicalTimestampSchema,
    localSessionId: safeIdSchema,
    taskId: safeIdSchema,
    iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
    allowed: z.boolean(),
    restrictedReason: z.string().min(1).max(100).optional(),
    truncated: z.boolean(),
    sizeBytes: z.number().int().min(0).max(MAX_OUTPUT_BYTES),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.allowed && item.restrictedReason !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "readable output cannot have a restriction reason" });
    }
    if (!item.allowed) {
      if (!item.restrictedReason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "restricted output requires a reason" });
      }
      if (item.truncated || item.sizeBytes !== 0 || item.contentHash !== contentHash("")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "restricted output metadata must describe an empty body" });
      }
    }
  });

const outputIndexSchema = z
  .object({
    schemaVersion: z.literal(2),
    workspaceId: safeIdSchema,
    nextId: safePositiveIntegerSchema,
    items: z.array(executionOutputMetaSchema).max(MAX_OUTPUT_RECORDS),
  })
  .strict()
  .superRefine((index, ctx) => {
    for (let i = 1; i < index.items.length; i++) {
      if (index.items[i]!.id <= index.items[i - 1]!.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "output ids must be unique and increasing" });
        break;
      }
    }
    const expectedNextId = index.items.length === 0 ? 1 : index.items[index.items.length - 1]!.id + 1;
    if (!Number.isSafeInteger(expectedNextId) || index.nextId !== expectedNextId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "next output id does not follow the stored items" });
    }
  });

const saveOutputInputSchema = z
  .object({
    command: z.string(),
    raw: z.string(),
    exitCode: z.number().int().min(0).max(255).nullable().optional(),
    localSessionId: safeIdSchema,
    taskId: safeIdSchema,
    iteration: z.number().int().min(0).max(MAX_C2C_ITERATION),
  })
  .strict();

function validatedWorkspaceId(workspaceId: string): string {
  const parsed = safeIdSchema.safeParse(workspaceId);
  if (!parsed.success || parsed.data !== workspaceId) throw new Error("execution output workspace id is invalid");
  return parsed.data;
}

function outputDir(workspaceId: string): string {
  return ensureDir(path.join(getStateDir(), "execution-outputs", validatedWorkspaceId(workspaceId)));
}

function indexFile(workspaceId: string): string {
  return path.join(outputDir(workspaceId), "index.json");
}

function bodyFile(workspaceId: string, id: number): string {
  return path.join(outputDir(workspaceId), "bodies", `${id}.txt`);
}

function readIndex(workspaceId: string): OutputIndex {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const file = indexFile(workspaceId);
  const value = readJsonIfExists<unknown>(file);
  if (!value) {
    if (fs.existsSync(file)) throw new Error("execution output index is unreadable or malformed");
    return { schemaVersion: 2, workspaceId: resolvedWorkspaceId, nextId: 1, items: [] };
  }
  const parsed = outputIndexSchema.safeParse(value);
  if (!parsed.success || parsed.data.workspaceId !== resolvedWorkspaceId) {
    throw new Error("execution output index does not match its workspace");
  }
  for (const item of parsed.data.items) {
    if (item.workspaceId !== resolvedWorkspaceId) {
      throw new Error("execution output metadata is invalid");
    }
  }
  return parsed.data;
}

function writeIndex(workspaceId: string, index: OutputIndex): void {
  writeSecureJson(indexFile(workspaceId), index);
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface SaveOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
  localSessionId: string;
  taskId: string;
  iteration: number;
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput): ExecutionOutputMeta {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const parsedInput = saveOutputInputSchema.parse(input);
  return withFileLock(path.join(outputDir(resolvedWorkspaceId), "index.lock"), () => {
    const sanitized = sanitizeExecutionOutput(parsedInput.raw);
    const index = readIndex(resolvedWorkspaceId);
    const id = index.nextId;
    if (id >= Number.MAX_SAFE_INTEGER) throw new Error("execution output id space is exhausted");
    const timestamp = new Date().toISOString();
    const allowed = sanitized.allowed;
    const text = allowed ? sanitized.text : "";
    const truncated = allowed ? sanitized.truncated : false;
    const meta: ExecutionOutputMeta = {
      id,
      workspaceId: resolvedWorkspaceId,
      command: redact(parsedInput.command).slice(0, 200),
      exitCode: parsedInput.exitCode ?? null,
      timestamp,
      localSessionId: parsedInput.localSessionId,
      taskId: parsedInput.taskId,
      iteration: parsedInput.iteration,
      allowed,
      restrictedReason: allowed ? undefined : sanitized.reason,
      truncated,
      sizeBytes: Buffer.byteLength(text, "utf8"),
      contentHash: contentHash(text),
    };
    executionOutputMetaSchema.parse(meta);
    if (allowed && text) {
      const file = bodyFile(resolvedWorkspaceId, id);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, text, { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* ignore */
      }
    }
    index.nextId = id + 1;
    index.items.push(meta);
    const droppedIds: number[] = [];
    while (index.items.length > MAX_OUTPUT_RECORDS) {
      const dropped = index.items.shift();
      if (dropped) droppedIds.push(dropped.id);
    }
    outputIndexSchema.parse(index);
    writeIndex(resolvedWorkspaceId, index);
    for (const droppedId of droppedIds) {
      fs.rmSync(bodyFile(resolvedWorkspaceId, droppedId), { force: true });
    }
    return meta;
  });
}

export function listExecutionOutputs(
  workspaceId: string,
  limit = 20,
  filter: { localSessionId?: string; taskId?: string; iteration?: number } = {}
): ExecutionOutputMeta[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("execution output limit must be an integer between 1 and 50");
  }
  const parsedFilter = z
    .object({
      localSessionId: safeIdSchema.optional(),
      taskId: safeIdSchema.optional(),
      iteration: z.number().int().min(0).max(MAX_C2C_ITERATION).optional(),
    })
    .strict()
    .parse(filter);
  const items = readIndex(workspaceId).items.filter(
    (item) =>
      (parsedFilter.localSessionId === undefined || item.localSessionId === parsedFilter.localSessionId) &&
      (parsedFilter.taskId === undefined || item.taskId === parsedFilter.taskId) &&
      (parsedFilter.iteration === undefined || item.iteration === parsedFilter.iteration)
  );
  return items.slice(-limit);
}

export function readExecutionOutput(
  workspaceId: string,
  id: number
):
  | { ok: true; meta: ExecutionOutputMeta; text: string }
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" | "OUTPUT_INTEGRITY_ERROR" } {
  if (!Number.isSafeInteger(id) || id < 1) return { ok: false, error: "NOT_FOUND" };
  const meta = readIndex(workspaceId).items.find((item) => item.id === id);
  if (!meta) return { ok: false, error: "NOT_FOUND" };
  if (!meta.allowed) return { ok: false, error: "OUTPUT_RESTRICTED" };
  const file = bodyFile(workspaceId, id);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (contentHash(text) !== meta.contentHash || Buffer.byteLength(text, "utf8") !== meta.sizeBytes) {
    return { ok: false, error: "OUTPUT_INTEGRITY_ERROR" };
  }
  return { ok: true, meta, text };
}
