import { TaskSnapshotSchema, type TaskSnapshot } from "../protocol/types.js";

export function renderCurrentTask(input: TaskSnapshot): string {
  const snapshot = TaskSnapshotSchema.parse(input);
  const files = snapshot.declaredChangedFiles.length
    ? snapshot.declaredChangedFiles.map((file) => `- ${file}`).join("\n")
    : "- None";
  return [
    `# C2C Task ${snapshot.taskId}`,
    "",
    "## STATE",
    snapshot.state,
    "",
    "## ITERATION",
    String(snapshot.iteration),
    "",
    "## GOAL",
    snapshot.goal,
    "",
    "## COMMITS",
    `- Task base: ${snapshot.taskBaseCommit ?? "unavailable"}`,
    `- Iteration base: ${snapshot.iterationBaseCommit ?? "unavailable"}`,
    `- Code head: ${snapshot.codeHeadCommit ?? "unavailable"}`,
    "",
    "## DECLARED CHANGED FILES",
    files,
    "",
    "## TESTS",
    `- Status: ${snapshot.tests.status}`,
    `- Command: ${snapshot.tests.command ?? "not recorded"}`,
    `- Summary: ${snapshot.tests.summary ?? "not recorded"}`,
    "",
    "## REVIEW FOCUS",
    snapshot.reviewFocus || "Not specified.",
    "",
    "> Machine state is defined only by `.c2c/current.json`; this file is a rebuildable projection.",
    "",
  ].join("\n");
}
