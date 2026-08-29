import type { C2CMessage, TaskSnapshot } from "../protocol/types.js";
import { validateImportedMessage, type ImportValidationResult } from "../protocol/validator.js";
import { TaskStore } from "./store.js";

export class TaskLifecycleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TaskLifecycleError";
  }
}

export class TaskLifecycle {
  constructor(
    private readonly store: TaskStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  importMessage(message: C2CMessage): {
    snapshot: TaskSnapshot;
    validation: Extract<ImportValidationResult, { ok: true }>;
  } {
    const current = this.current();
    const validation = validateImportedMessage(message, {
      taskId: current.taskId,
      currentState: current.state,
      currentIteration: current.iteration,
    });
    if (!validation.ok) throw new TaskLifecycleError(validation.code, validation.message);

    const receivedAt = this.now();
    let next: TaskSnapshot;
    if (message.state === "DONE") {
      next = {
        ...current,
        updatedAt: receivedAt,
        lastImported: { state: "DONE", receivedAt },
        pendingDecision: {
          state: "DONE",
          taskId: message.taskId,
          iteration: message.iteration,
          acceptedAt: receivedAt,
        },
      };
    } else if (message.state === "BLOCKED") {
      next = {
        ...current,
        state: "BLOCKED",
        iteration: validation.nextIteration,
        updatedAt: receivedAt,
        lastImported: { state: "BLOCKED", receivedAt },
        pendingDecision: null,
        blockedFrom: {
          state: current.state,
          iteration: current.iteration,
          code: "CHATGPT_BLOCKED",
          reason: message.sections.REASON,
        },
      };
    } else {
      next = {
        ...current,
        state: "PLAN",
        iteration: validation.nextIteration,
        updatedAt: receivedAt,
        lastImported: { state: "PLAN", receivedAt },
        pendingDecision: null,
        blockedFrom: null,
      };
    }
    return { snapshot: this.store.write(next), validation };
  }

  startExecution(): TaskSnapshot {
    const current = this.requireState("PLAN");
    return this.store.write({ ...current, state: "EXECUTING", updatedAt: this.now() });
  }

  completeExecution(input: {
    declaredChangedFiles: string[];
    tests: TaskSnapshot["tests"];
    reviewFocus: string;
    codeHeadCommit?: string | null;
  }): TaskSnapshot {
    const current = this.requireState("EXECUTING");
    return this.store.write({
      ...current,
      state: "EXECUTED",
      updatedAt: this.now(),
      declaredChangedFiles: [...input.declaredChangedFiles],
      tests: input.tests,
      reviewFocus: input.reviewFocus,
      codeHeadCommit: input.codeHeadCommit ?? current.codeHeadCommit,
      pendingDecision: null,
    });
  }

  finalizeDone(input: { passed: boolean; summary: string; command?: string | null }): TaskSnapshot {
    const current = this.requireState("EXECUTED");
    if (!current.pendingDecision || current.pendingDecision.state !== "DONE") {
      throw new TaskLifecycleError("DONE_DECISION_MISSING", "A validated DONE decision is required before finalization.");
    }
    return this.store.write({
      ...current,
      state: input.passed ? "DONE" : "EXECUTED",
      updatedAt: this.now(),
      pendingDecision: null,
      tests: {
        status: input.passed ? "passed" : "failed",
        summary: input.summary,
        command: input.command ?? current.tests.command,
      },
    });
  }

  resume(): TaskSnapshot {
    const current = this.requireState("BLOCKED");
    if (!current.blockedFrom) {
      throw new TaskLifecycleError("BLOCKED_CONTEXT_MISSING", "Cannot resume because the BLOCKED origin is missing.");
    }
    return this.store.write({
      ...current,
      state: current.blockedFrom.state,
      iteration: current.blockedFrom.iteration,
      updatedAt: this.now(),
      blockedFrom: null,
    });
  }

  private current(): TaskSnapshot {
    const snapshot = this.store.read();
    if (!snapshot) throw new TaskLifecycleError("TASK_NOT_FOUND", "No active C2C task exists.");
    return snapshot;
  }

  private requireState(expected: TaskSnapshot["state"]): TaskSnapshot {
    const current = this.current();
    if (current.state !== expected) {
      throw new TaskLifecycleError("STATE_NOT_ALLOWED", `Expected task state ${expected}, found ${current.state}.`);
    }
    return current;
  }
}
