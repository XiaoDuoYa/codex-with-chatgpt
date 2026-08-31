import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { redact } from "../logger/index.js";

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary`, `test_status`, and `execution_diagnostics` MCP tools.
 */
export interface ExecutionRecord {
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  errorSummary?: string | null;
  diagnostics?: string | null;
  completedSubtasks?: string[];
  timestamp: string;
  notes?: string;
}

const MAX_DIAGNOSTICS_CHARS = 32 * 1024; // 32KB cap for error logs

export function sanitizeDiagnostics(input: string | undefined | null): string | null {
  if (!input || input.trim() === "") return null;
  const redacted = redact(input.trim());
  return redacted.length > MAX_DIAGNOSTICS_CHARS
    ? redacted.slice(0, MAX_DIAGNOSTICS_CHARS) + "\n...[truncated failure output]..."
    : redacted;
}

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  const sanitized: ExecutionRecord = {
    ...record,
    errorSummary: record.errorSummary ? redact(record.errorSummary.slice(0, 1000)) : null,
    diagnostics: sanitizeDiagnostics(record.diagnostics),
  };
  fs.appendFileSync(file, JSON.stringify(sanitized) + "\n", { mode: 0o600 });
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as ExecutionRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}

export function findExecutionRecord(
  workspaceId: string,
  filter?: { taskId?: string; iteration?: number }
): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 50);
  if (!filter || (!filter.taskId && filter.iteration === undefined)) {
    return records[records.length - 1] ?? null;
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (filter.taskId && r.taskId !== filter.taskId) continue;
    if (filter.iteration !== undefined && r.iteration !== filter.iteration) continue;
    return r;
  }
  return null;
}
