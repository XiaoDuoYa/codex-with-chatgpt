import { C2CMessageSchema, type C2CMessage, type C2CState } from "./types.js";

export interface ImportExpectation {
  taskId: string;
  currentState: C2CState;
  currentIteration: number;
}

export type ImportValidationResult =
  | {
      ok: true;
      message: C2CMessage;
      nextState: C2CState;
      nextIteration: number;
      acceptedDecision?: "DONE";
      requiresFinalValidation?: true;
    }
  | { ok: false; code: string; message: string; expectedTemplate: string };

export type TransitionValidationResult =
  | { ok: true }
  | { ok: false; code: "STATE_NOT_ALLOWED"; message: string };

export function validateTransition(currentState: C2CState, incomingState: C2CState): TransitionValidationResult {
  const allowed: Partial<Record<C2CState, C2CState[]>> = {
    INIT: ["PLAN", "BLOCKED"],
    EXECUTED: ["PLAN", "DONE", "BLOCKED"],
    BLOCKED: ["PLAN"],
  };
  if (allowed[currentState]?.includes(incomingState)) return { ok: true };
  return {
    ok: false,
    code: "STATE_NOT_ALLOWED",
    message: `Cannot import ${incomingState} while the task is ${currentState}.`,
  };
}

export function validateImportedMessage(
  input: C2CMessage,
  expected: ImportExpectation
): ImportValidationResult {
  const parsed = C2CMessageSchema.safeParse(input);
  if (!parsed.success) {
    return failure("MESSAGE_INVALID", parsed.error.issues.map((issue) => issue.message).join("; "), expected);
  }
  const message = parsed.data;

  if (message.taskId !== expected.taskId) {
    return failure("TASK_ID_MISMATCH", "The imported message belongs to another task.", expected);
  }

  const transition = validateTransition(expected.currentState, message.state);
  if (!transition.ok) return failure(transition.code, transition.message, expected);

  const expectedIteration = message.state === "PLAN" ? expected.currentIteration + 1 : expected.currentIteration;
  if (message.iteration !== expectedIteration) {
    return failure(
      "ITERATION_MISMATCH",
      `Expected iteration ${expectedIteration}, received ${message.iteration}.`,
      expected
    );
  }

  if (message.state === "PLAN") {
    const missing = ["ACTIONS", "TESTS", "SUCCESS_CRITERIA"].filter(
      (name) => !message.sections[name]?.trim()
    );
    if (missing.length > 0) {
      return failure("SECTION_MISSING", `PLAN is missing required sections: ${missing.join(", ")}.`, expected);
    }
    return { ok: true, message, nextState: "PLAN", nextIteration: message.iteration };
  }

  if (message.state === "BLOCKED") {
    if (!message.sections.REASON?.trim()) {
      return failure("SECTION_MISSING", "BLOCKED is missing the required REASON section.", expected);
    }
    return { ok: true, message, nextState: "BLOCKED", nextIteration: message.iteration };
  }

  return {
    ok: true,
    message,
    nextState: "EXECUTED",
    nextIteration: message.iteration,
    acceptedDecision: "DONE",
    requiresFinalValidation: true,
  };
}

function failure(
  code: string,
  message: string,
  expected: ImportExpectation
): Extract<ImportValidationResult, { ok: false }> {
  return { ok: false, code, message, expectedTemplate: templateFor(expected) };
}

function templateFor(expected: ImportExpectation): string {
  const state = expected.currentState === "EXECUTED" ? "DONE" : "PLAN";
  const iteration = state === "PLAN" ? expected.currentIteration + 1 : expected.currentIteration;
  return `[C2C]\nPROTOCOL_VERSION: 1\nSTATE: ${state}\nTASK_ID: ${expected.taskId}\nITERATION: ${iteration}`;
}
