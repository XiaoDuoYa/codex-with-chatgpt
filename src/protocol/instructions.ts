import { TaskSnapshotSchema, type TaskSnapshot } from "./types.js";
import type { TransportDescriptor } from "../transport/types.js";

export function buildPlanInstruction(input: TaskSnapshot, transport: TransportDescriptor): string {
  const snapshot = TaskSnapshotSchema.parse(input);
  const location = formatLocator(transport);
  return [
    `Read task ${snapshot.taskId} from ${location}.`,
    `Goal: ${snapshot.goal}`,
    "Return one structured C2C response beginning with:",
    "STATE: PLAN",
    `TASK_ID: ${snapshot.taskId}`,
    `ITERATION: ${snapshot.iteration + 1}`,
    "Include ACTIONS, TESTS, and SUCCESS_CRITERIA sections.",
  ].join("\n");
}

export function buildReviewInstruction(input: TaskSnapshot, transport: TransportDescriptor): string {
  const snapshot = TaskSnapshotSchema.parse(input);
  const changedFiles = snapshot.declaredChangedFiles.map((file) => `- ${file}`).join("\n") || "- (none)";
  return [
    `Review task ${snapshot.taskId} from ${formatLocator(transport)}.`,
    `Task base commit: ${snapshot.taskBaseCommit ?? "unavailable"}`,
    `Iteration base commit: ${snapshot.iterationBaseCommit ?? "unavailable"}`,
    `Code head commit: ${snapshot.codeHeadCommit ?? "unavailable"}`,
    "Review only these declared files:",
    changedFiles,
    "Explicitly exclude .c2c/** from the code review range.",
    `Review focus: ${snapshot.reviewFocus}`,
    `Return PLAN for iteration ${snapshot.iteration + 1}, DONE for iteration ${snapshot.iteration}, or BLOCKED for iteration ${snapshot.iteration}.`,
  ].join("\n");
}

function formatLocator(transport: TransportDescriptor): string {
  const entries = Object.entries(transport.locator).map(([key, value]) => `${key}=${value}`);
  return `${transport.kind}${entries.length > 0 ? ` (${entries.join(", ")})` : ""}`;
}
