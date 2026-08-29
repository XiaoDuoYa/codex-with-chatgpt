import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { executePlan } from "../executor/index.js";
import { resolveExecutorName } from "../executor/config.js";
import { appendExecutionRecord } from "./records.js";
import { isExecutionRelayEnabled } from "./relay-config.js";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import type { ProcessRunner } from "../executor/types.js";

export type ExecutionTaskStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export interface ExecutionTask {
  runId: string;
  taskId: string;
  iteration: number;
  executor: "agy" | "codex";
  status: ExecutionTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  changedFiles?: string[];
  tests?: string | null;
  error?: string;
  blockedReason?: string;
}

export interface StartTaskInput {
  taskId: string;
  iteration: number;
  plan: string;
  timeoutMs?: number;
}

export interface ExecutionTaskManagerOptions {
  logger?: Logger;
  runner?: ProcessRunner;
}

/**
 * Centralized extractor for test execution summaries from runner stdout/stderr or agent prose.
 *
 * Handles:
 * 1. Vitest / Jest structured summaries (e.g. 'Tests  2 failed | 123 passed (125)', 'Tests: 123 passed, 2 failed', 'Tests  123 passed (123)').
 * 2. Natural language summaries (e.g. '12 test files passed; 123 tests passed; 2 tests failed', '2 tests failed, 123 tests passed').
 * 3. Generic fallback matches (e.g. '123 passed, 2 failed', '12 passed (files), 123 passed').
 *
 * Always prefers actual test count over test file/suite counts.
 */
export function extractTestSummary(stdout: string | undefined): string | null {
  if (!stdout || typeof stdout !== "string") return null;

  const lines = stdout.split("\n");

  const parseCountsFromText = (text: string): { passed?: number; failed?: number } => {
    const passedMatch = text.match(/(\d+)\s+passed\b/i) || text.match(/\bpassed\s*[:=]?\s*(\d+)\b/i);
    const failedMatch = text.match(/(\d+)\s+failed\b/i) || text.match(/\bfailed\s*[:=]?\s*(\d+)\b/i);
    return {
      passed: passedMatch ? parseInt(passedMatch[1], 10) : undefined,
      failed: failedMatch ? parseInt(failedMatch[1], 10) : undefined,
    };
  };

  const formatSummary = (passed?: number, failed?: number): string | null => {
    if (passed !== undefined && failed !== undefined && failed > 0) {
      return `${passed} passed, ${failed} failed`;
    }
    if (passed !== undefined) {
      return `${passed} passed`;
    }
    if (failed !== undefined && failed > 0) {
      return `${failed} failed`;
    }
    return null;
  };

  // 1. Check for dedicated "Tests" summary line (Vitest / Jest / similar)
  // Match lines where "Tests" is the category header (not "Test Files" or "Test Suites")
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Tests\b/i.test(trimmed) || /^\bTests\s*:/i.test(trimmed)) {
      const counts = parseCountsFromText(trimmed);
      const res = formatSummary(counts.passed, counts.failed);
      if (res) return res;
    }
  }

  // 2. Natural-language phrase mentioning explicit test counts (e.g. "123 tests passed", "2 tests failed")
  // Exclude "test files" / "test suites" phrases
  for (const line of lines) {
    const trimmed = line.trim();
    const hasTestsPhrase = /\b\d+\s+tests?\s+passed\b/i.test(trimmed) || /\b\d+\s+tests?\s+failed\b/i.test(trimmed);
    if (hasTestsPhrase) {
      const passedMatch = trimmed.match(/(\d+)\s+tests?\s+passed\b/i);
      const failedMatch = trimmed.match(/(\d+)\s+tests?\s+failed\b/i) || trimmed.match(/\b(\d+)\s+failed\b/i);
      const passed = passedMatch ? parseInt(passedMatch[1], 10) : undefined;
      const failed = failedMatch ? parseInt(failedMatch[1], 10) : undefined;
      const res = formatSummary(passed, failed);
      if (res) return res;
    }
  }

  // 3. Directional regex fallback: 'Tests ... <N> passed'
  const testsPrefixMatch = stdout.match(/\bTests\b[^\n]*?(\d+\s+passed(?:[^\n]*?\b\d+\s+failed\b)?)/i);
  if (testsPrefixMatch) {
    return testsPrefixMatch[1].trim();
  }

  // 4. Generic '<N> passed' / '<M> failed' fallback:
  // When multiple passed counts appear (e.g. '12 passed (files), 123 passed (tests)'),
  // prefer the largest passed count (actual test count >= file count).
  const genericPassedMatches = Array.from(stdout.matchAll(/(\d+)\s+passed\b/gi));
  if (genericPassedMatches.length > 0) {
    let maxPassed = -1;
    let bestLine = "";

    for (const match of genericPassedMatches) {
      const count = parseInt(match[1], 10);
      if (count > maxPassed) {
        maxPassed = count;
        const matchIndex = match.index ?? 0;
        const lineStart = stdout.lastIndexOf("\n", matchIndex) + 1;
        let lineEnd = stdout.indexOf("\n", matchIndex);
        if (lineEnd === -1) lineEnd = stdout.length;
        bestLine = stdout.slice(lineStart, lineEnd);
      }
    }

    if (maxPassed >= 0) {
      const counts = parseCountsFromText(bestLine);
      return formatSummary(maxPassed, counts.failed);
    }
  }

  // 5. If only failed tests were reported (e.g. "5 failed")
  const genericFailedMatch = stdout.match(/(\d+)\s+failed\b/i);
  if (genericFailedMatch) {
    return `${genericFailedMatch[1]} failed`;
  }

  return null;
}

export class ExecutionTaskManager {
  private activeTask: ExecutionTask | null = null;
  private activeRunPromise: Promise<void> | null = null;
  private readonly tasks = new Map<string, ExecutionTask>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly emitter = new EventEmitter();
  private readonly logger: Logger;
  private readonly defaultRunner?: ProcessRunner;

  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    opts?: ExecutionTaskManagerOptions
  ) {
    this.logger = opts?.logger ?? nullLogger;
    this.defaultRunner = opts?.runner;
  }

  getActiveTask(): ExecutionTask | null {
    return this.activeTask ? { ...this.activeTask } : null;
  }

  async startTask(input: StartTaskInput, runner?: ProcessRunner): Promise<ExecutionTask> {
    if (!isExecutionRelayEnabled()) {
      const err = new Error(
        "EXECUTION_RELAY_DISABLED: Local execution relay is disabled. " +
          "Run 'c2c relay enable' on the host machine to allow ChatGPT execution."
      );
      (err as any).code = "EXECUTION_RELAY_DISABLED";
      throw err;
    }

    if (!input.taskId || typeof input.taskId !== "string" || input.taskId.trim().length === 0) {
      throw new Error("INVALID_ARGUMENT: 'task_id' must be a non-empty string.");
    }
    if (input.taskId.length > 128) {
      throw new Error("INVALID_ARGUMENT: 'task_id' must not exceed 128 characters.");
    }
    if (!Number.isInteger(input.iteration) || input.iteration < 1) {
      throw new Error("INVALID_ARGUMENT: 'iteration' must be an integer >= 1.");
    }
    if (!input.plan || typeof input.plan !== "string" || input.plan.trim().length === 0) {
      throw new Error("INVALID_ARGUMENT: 'plan' must be a non-empty string.");
    }
    if (input.plan.length > 256 * 1024) {
      throw new Error("INVALID_ARGUMENT: 'plan' exceeds maximum size limit of 256 KB.");
    }

    // Active lock remains strictly held until the child process exits
    if (this.activeTask) {
      const err = new Error(
        `EXECUTION_BUSY: Another execution is already running with runId: ${this.activeTask.runId}.`
      );
      (err as any).code = "EXECUTION_BUSY";
      (err as any).activeRunId = this.activeTask.runId;
      throw err;
    }

    const runId = randomUUID();
    const executor = resolveExecutorName();
    const abortController = new AbortController();

    const task: ExecutionTask = {
      runId,
      taskId: input.taskId.trim(),
      iteration: input.iteration,
      executor,
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };

    this.tasks.set(runId, task);
    this.activeTask = task;
    this.abortControllers.set(runId, abortController);

    this.logger.info(`Starting execution task runId=${runId} taskId=${task.taskId} iteration=${task.iteration}`);

    // Launch execution in background and track promise
    const effectiveRunner = runner ?? this.defaultRunner;
    const runPromise = this.runTask(task, input.plan, input.timeoutMs, abortController, effectiveRunner);
    this.activeRunPromise = runPromise;
    void runPromise;

    return { ...task };
  }

  private async runTask(
    task: ExecutionTask,
    plan: string,
    timeoutMs: number | undefined,
    abortController: AbortController,
    runner?: ProcessRunner
  ): Promise<void> {
    try {
      const execResult = await executePlan({
        workspace: this.workspaceRoot,
        plan,
        executorName: task.executor,
        taskId: task.taskId,
        iteration: task.iteration,
        timeoutMs,
        runner,
        signal: abortController.signal,
      });

      if (task.status === "cancelled" || abortController.signal.aborted || execResult.result.blockedReason === "CANCELLED") {
        task.status = "cancelled";
        task.error = "Execution cancelled by caller";
      } else if (execResult.result.ok) {
        task.status = "succeeded";
      } else if (execResult.result.blockedReason === "PERMISSION_DENIED") {
        task.status = "blocked";
        task.blockedReason = "PERMISSION_DENIED";
        task.error = execResult.result.error;
      } else {
        task.status = "failed";
        task.error = execResult.result.error || "Non-zero exit";
      }

      task.changedFiles = execResult.changedFiles;
      task.tests = extractTestSummary(execResult.result.stdout);
    } catch (error) {
      if (task.status === "cancelled" || abortController.signal.aborted) {
        task.status = "cancelled";
        task.error = "Execution cancelled by caller";
      } else {
        task.status = "failed";
        task.error = error instanceof Error ? error.message : String(error);
      }
      task.changedFiles = task.changedFiles ?? [];
    } finally {
      task.finishedAt = new Date().toISOString();

      // Exactly-once execution record across ALL terminal paths (including setup errors)
      const recordStatus =
        task.status === "succeeded"
          ? "ok"
          : task.status === "blocked" || task.status === "cancelled"
            ? "blocked"
            : "failed";

      try {
        appendExecutionRecord(this.workspaceId, {
          taskId: task.taskId,
          iteration: task.iteration,
          changedFiles: task.changedFiles ?? [],
          tests: task.tests ?? null,
          exitStatus: recordStatus,
          timestamp: new Date().toISOString(),
          notes:
            task.status === "cancelled"
              ? "Cancelled by control relay"
              : task.error
                ? `Execution ${task.status}: ${task.error}`
                : `Executed via ${task.executor}`,
        });
      } catch (recErr) {
        this.logger.error(`Failed to append execution record: ${recErr}`);
      }

      // Release active task lock only when child process execution is completely resolved
      if (this.activeTask?.runId === task.runId) {
        this.activeTask = null;
      }
      this.activeRunPromise = null;
      this.abortControllers.delete(task.runId);
      this.emitter.emit(`task:${task.runId}`, task);
      this.emitter.emit("task_finished", task);
    }
  }

  async getTask(runId: string, waitMs = 0): Promise<ExecutionTask | null> {
    const task = this.tasks.get(runId);
    if (!task) return null;

    if (task.status !== "running" || waitMs <= 0) {
      return { ...task };
    }

    const boundedWait = Math.min(Math.max(0, waitMs), 45000);

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onFinished = (updated: ExecutionTask) => {
        if (timer) clearTimeout(timer);
        this.emitter.removeListener(`task:${runId}`, onFinished);
        resolve({ ...updated });
      };

      this.emitter.once(`task:${runId}`, onFinished);

      timer = setTimeout(() => {
        this.emitter.removeListener(`task:${runId}`, onFinished);
        const current = this.tasks.get(runId);
        resolve(current ? { ...current } : null);
      }, boundedWait);
    });
  }

  cancelTask(runId: string): boolean {
    const task = this.tasks.get(runId);
    if (!task) return false;
    if (task.status !== "running") return false;

    task.status = "cancelled";
    const ctrl = this.abortControllers.get(runId);
    if (ctrl) {
      ctrl.abort();
    }
    // Notice: activeTask is NOT cleared here; it will be cleared when runTask() resolves in finally.
    this.emitter.emit(`task:${runId}`, task);
    return true;
  }

  async close(): Promise<void> {
    if (this.activeTask) {
      this.cancelTask(this.activeTask.runId);
    }
    if (this.activeRunPromise) {
      await Promise.race([
        this.activeRunPromise,
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    }
    this.emitter.removeAllListeners();
  }
}
