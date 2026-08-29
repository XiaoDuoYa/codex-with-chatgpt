import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgyExecutor } from "./agy.js";
import { CodexExecutor } from "./codex.js";
import {
  DEFAULT_EXECUTOR,
  getExecutorConfigFile,
  getStoredExecutor,
  resolveExecutorName,
  setStoredExecutor,
} from "./config.js";
import {
  isSupportedExecutor,
  SUPPORTED_EXECUTORS,
  type DetectionResult,
  type ExecutorAdapter,
  type ExecutorName,
  type ExecutorOptions,
  type ExecutorResult,
  type ProcessRunner,
} from "./types.js";
import { gitStatus } from "../workspace/git.js";

export * from "./types.js";
export * from "./config.js";
export * from "./detect.js";
export * from "./runner.js";
export * from "./agy.js";
export * from "./codex.js";

const ADAPTERS: Record<ExecutorName, ExecutorAdapter> = {
  agy: new AgyExecutor(),
  codex: new CodexExecutor(),
};

export function getExecutor(name: ExecutorName): ExecutorAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`Unsupported executor: "${name}"`);
  }
  return adapter;
}

export async function detectAllExecutors(): Promise<Record<ExecutorName, DetectionResult>> {
  const results: Record<string, DetectionResult> = {};
  for (const name of SUPPORTED_EXECUTORS) {
    results[name] = await ADAPTERS[name].detect();
  }
  return results as Record<ExecutorName, DetectionResult>;
}

export function buildExecutionPrompt(plan: string, context?: { taskId?: string; iteration?: number }): string {
  const taskHeader = context?.taskId
    ? `Task: ${context.taskId}${context.iteration !== undefined ? ` (Iteration ${context.iteration})` : ""}\n`
    : "";

  return (
    `You are the execution agent.\n` +
    `${taskHeader}` +
    `Implement the following ChatGPT-reviewed C2C PLAN in the current workspace.\n` +
    `Use your own coding, shell, and test tools.\n` +
    `Do not redesign the task unless execution requires it.\n` +
    `Run appropriate tests.\n` +
    `When finished, provide a concise execution summary.\n\n` +
    `=== PLAN ===\n${plan.trim()}\n`
  );
}

interface FileSnapshot {
  hash: string;
}

function hashFile(fullPath: string): string {
  try {
    if (!fs.existsSync(fullPath)) return "";
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return "";
    const data = fs.readFileSync(fullPath);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return "";
  }
}

export function snapshotDirtyFiles(workspace: string): Map<string, FileSnapshot> {
  const map = new Map<string, FileSnapshot>();
  const status = gitStatus(workspace);
  if (!status.isRepo) return map;

  const dirtyRelPaths = new Set<string>();
  for (const s of status.staged) dirtyRelPaths.add(s.path);
  for (const u of status.unstaged) dirtyRelPaths.add(u.path);
  for (const t of status.untracked) dirtyRelPaths.add(t);

  for (const rel of dirtyRelPaths) {
    const full = path.join(workspace, rel);
    map.set(rel, { hash: hashFile(full) });
  }
  return map;
}

export function computeChangedFilesDelta(
  workspace: string,
  beforeSnap: Map<string, FileSnapshot>
): string[] {
  const status = gitStatus(workspace);
  if (!status.isRepo) return [];

  const afterRelPaths = new Set<string>();
  for (const s of status.staged) afterRelPaths.add(s.path);
  for (const u of status.unstaged) afterRelPaths.add(u.path);
  for (const t of status.untracked) afterRelPaths.add(t);

  const changed: string[] = [];

  for (const rel of afterRelPaths) {
    const before = beforeSnap.get(rel);
    if (!before) {
      // 1. Newly created/modified file in this iteration
      changed.push(rel);
    } else {
      // 2. Was already dirty before - check if its hash changed in this iteration
      const currentHash = hashFile(path.join(workspace, rel));
      if (currentHash !== before.hash) {
        changed.push(rel);
      }
    }
  }

  // 3. Any file that was dirty before and was deleted or reverted in this iteration
  for (const [rel] of beforeSnap) {
    if (!afterRelPaths.has(rel)) {
      changed.push(rel);
    }
  }

  return changed;
}

export interface ExecutePlanOptions {
  workspace: string;
  plan: string;
  executorName?: string;
  taskId?: string;
  iteration?: number;
  timeoutMs?: number;
  runner?: ProcessRunner;
  signal?: AbortSignal;
}

export interface ExecutePlanResult {
  result: ExecutorResult;
  changedFiles: string[];
}

export async function executePlan(opts: ExecutePlanOptions): Promise<ExecutePlanResult> {
  const executorName = resolveExecutorName(opts.executorName);
  const adapter = getExecutor(executorName);

  // 1. Detect binary availability (skip check if a custom test runner is passed)
  if (!opts.runner) {
    const detection = await adapter.detect();
    if (!detection.available) {
      const hint = executorName === "agy" ? "c2c executor set codex" : "c2c executor set agy";
      throw new Error(
        `AGENT_NOT_FOUND: ${executorName} is not available in PATH.\n` +
          `Details: ${detection.error || "binary not found"}\n` +
          `To switch executor, run: ${hint}`
      );
    }
  }

  // 2. Snapshot dirty files before execution
  const beforeSnap = snapshotDirtyFiles(opts.workspace);

  // 3. Construct prompt and execute
  const prompt = buildExecutionPrompt(opts.plan, { taskId: opts.taskId, iteration: opts.iteration });
  const result = await adapter.execute(
    {
      workspace: opts.workspace,
      prompt,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    },
    opts.runner
  );

  // 4. Compute delta of files actually touched during this iteration
  const changedFiles = computeChangedFilesDelta(opts.workspace, beforeSnap);

  return {
    result,
    changedFiles,
  };
}
