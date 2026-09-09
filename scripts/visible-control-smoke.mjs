import path from "node:path";
import process from "node:process";
import { TaskManager } from "../dist/execution/tasks.js";
import { nullLogger } from "../dist/logger/index.js";
import { Workspace } from "../dist/workspace/manager.js";

const root = path.resolve(process.argv[2] ?? process.cwd());
process.env.C2C_STATE_DIR = path.join(root, ".tooling", "visible-control-smoke");
const workspace = new Workspace(root);
const manager = new TaskManager(workspace, nullLogger);
const initialEventId = (await manager.events(0, 1000)).nextEventId;

async function waitFor(taskId, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = manager.progress(taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${taskId}`);
}

const suffix = Date.now().toString(36);
const completeId = `c2c_visible_${suffix}`;
manager.submit({ workspaceName: workspace.name, taskId: completeId, prompt: "Visibility acceptance test only. Do not modify files. Return exactly VISIBLE_CONTROL_SMOKE_OK." });
const completed = await waitFor(completeId, (task) => task.status === "COMPLETED" || task.status === "FAILED");
if (completed.status !== "COMPLETED" || !completed.threadId) throw new Error(`Completion task failed: ${completed.error ?? completed.status}`);

const cancelId = `c2c_cancel_${suffix}`;
manager.submit({ workspaceName: workspace.name, taskId: cancelId, prompt: "Cancellation acceptance test. Run a harmless 30-second wait command, then reply. Do not modify files." });
await waitFor(cancelId, (task) => task.status === "RUNNING" && task.progress >= 45);
await manager.cancel(cancelId, "visible control acceptance test");
const cancelled = await waitFor(cancelId, (task) => task.status === "CANCELLED");
const events = await manager.events(initialEventId, 100);
if (!events.events.some((event) => event.taskId === completeId && event.type === "TASK_COMPLETED_EVENT")) throw new Error("Completion event missing.");
if (!events.events.some((event) => event.taskId === cancelId && event.type === "TASK_CANCELLED_EVENT")) throw new Error("Cancellation event missing.");
const reconnected = new TaskManager(workspace, nullLogger);
const recoveredCompleted = reconnected.progress(completeId);
const recoveredCancelled = reconnected.progress(cancelId);
if (recoveredCompleted?.status !== "COMPLETED" || recoveredCancelled?.status !== "CANCELLED") throw new Error("Persisted task status did not survive reconnect.");

const failedId = `c2c_failed_${suffix}`;
const failingRunner = async (_root, _name, _prompt, hooks) => {
  hooks.onReady(process.pid, "failure-smoke-thread", "failure-smoke-turn");
  hooks.onProgress(45, "Running failure acceptance");
  return { result: Promise.resolve({ exitCode: 1, output: "intentional lifecycle failure", summary: "intentional lifecycle failure", testStatus: "FAIL (expected)" }), cancel: async () => undefined };
};
const failureManager = new TaskManager(workspace, nullLogger, failingRunner);
failureManager.submit({ workspaceName: workspace.name, taskId: failedId, prompt: "Exercise FAILED lifecycle only." });
let failed;
for (let i = 0; i < 100; i++) {
  failed = failureManager.progress(failedId);
  if (failed?.status === "FAILED") break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (failed?.status !== "FAILED") throw new Error("FAILED lifecycle did not complete.");
const failedEvents = await failureManager.events(initialEventId, 200);
if (!failedEvents.events.some((event) => event.taskId === failedId && event.type === "TASK_FAILED_EVENT")) throw new Error("Failure event missing.");
if (new TaskManager(workspace, nullLogger).progress(failedId)?.status !== "FAILED") throw new Error("FAILED status did not survive reconnect.");

console.log(JSON.stringify({
  completed: { taskId: completeId, status: completed.status, progress: completed.progress, threadId: completed.threadId, record: completed.executionRecordId },
  cancelled: { taskId: cancelId, status: cancelled.status, threadId: cancelled.threadId, reason: cancelled.cancelReason },
  completionEvent: events.events.some((event) => event.taskId === completeId && event.type === "TASK_COMPLETED_EVENT"),
  cancellationEvent: events.events.some((event) => event.taskId === cancelId && event.type === "TASK_CANCELLED_EVENT"),
  failed: { taskId: failed.taskId, status: failed.status, failureEvent: true, reconnect: "FAILED" },
  reconnect: { completed: recoveredCompleted.status, cancelled: recoveredCancelled.status },
}, null, 2));
