import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nullLogger } from "../src/logger/index.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { TaskManager, type TaskRunner } from "../src/execution/tasks.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let stateDir: string; const roots: string[] = [];
function workspace(name: string): Workspace { const root = makeTmpDir(name); roots.push(root); makeGitRepo(root); return new Workspace(root); }
function immediate(exitCode = 0, output = "done"): TaskRunner { return async (_root, _name, _prompt, hooks) => { hooks.onReady(process.pid, "thread-test", "turn-test"); hooks.onProgress(80, "Running tests"); hooks.onLog("test log"); return { result: Promise.resolve({ exitCode, output, summary: output, testStatus: exitCode ? "FAIL" : "PASS" }), cancel: async () => undefined }; }; }
async function waitFor(manager: TaskManager, id: string, status: string): Promise<void> { for (let i = 0; i < 100; i++) { if (manager.progress(id)?.status === status) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error(`${id} did not reach ${status}`); }

beforeAll(() => { stateDir = isolateStateDir(); });
afterAll(() => { for (const root of roots) cleanup(root); cleanup(stateDir); });

describe("task lifecycle", () => {
  it("persists progress, logs, completion event and execution record", async () => {
    const ws = workspace("task-complete"), manager = new TaskManager(ws, nullLogger, immediate());
    manager.submit({ workspaceName: ws.name, taskId: "c2c_complete", iteration: 1, prompt: "Read only" });
    await waitFor(manager, "c2c_complete", "COMPLETED");
    expect(manager.progress("c2c_complete")).toMatchObject({ status: "COMPLETED", progress: 100, threadId: "thread-test", testStatus: "PASS" });
    expect((await manager.events()).events).toContainEqual(expect.objectContaining({ type: "TASK_COMPLETED_EVENT", executionRecordId: "c2c_complete:1" }));
    expect(readExecutionRecords(ws.id, 10)).toContainEqual(expect.objectContaining({ taskId: "c2c_complete", exitStatus: "ok" }));
  });

  it("cancels a running task and records changed files and reason", async () => {
    const ws = workspace("task-cancel"); let cancelCalled = false;
    const runner: TaskRunner = async (_root, _name, _prompt, hooks) => { hooks.onReady(process.pid, "thread-cancel", "turn-cancel"); return { result: new Promise(() => undefined), cancel: async () => { cancelCalled = true; } }; };
    const manager = new TaskManager(ws, nullLogger, runner);
    manager.submit({ workspaceName: ws.name, taskId: "c2c_cancel", iteration: 1, prompt: "Wait" }); await waitFor(manager, "c2c_cancel", "RUNNING");
    await manager.cancel("c2c_cancel", "acceptance cancellation");
    expect(cancelCalled).toBe(true); expect(manager.progress("c2c_cancel")).toMatchObject({ status: "CANCELLED", cancelReason: "acceptance cancellation" });
    expect((await manager.events()).events).toContainEqual(expect.objectContaining({ type: "TASK_CANCELLED_EVENT" }));
  });

  it("persists PAUSED while Codex waits and resumes on progress", async () => {
    const ws = workspace("task-paused"); let release!: () => void;
    const runner: TaskRunner = async (_root, _name, _prompt, hooks) => {
      hooks.onReady(process.pid, "thread-paused", "turn-paused");
      hooks.onPaused("Waiting for user input");
      return { result: new Promise((resolve) => { release = () => { hooks.onProgress(45, "Running workspace command"); resolve({ exitCode: 0, output: "done" }); }; }), cancel: async () => undefined };
    };
    const manager = new TaskManager(ws, nullLogger, runner);
    manager.submit({ workspaceName: ws.name, taskId: "c2c_paused", prompt: "Wait" }); await waitFor(manager, "c2c_paused", "PAUSED");
    expect(manager.progress("c2c_paused")?.currentStep).toBe("Waiting for user input");
    release(); await waitFor(manager, "c2c_paused", "COMPLETED");
  });

  it("persists FAILED, failure event and reconnect recovery", async () => {
    const ws = workspace("task-failed"), manager = new TaskManager(ws, nullLogger, immediate(1, "intentional failure"));
    manager.submit({ workspaceName: ws.name, taskId: "c2c_failed", prompt: "Fail" }); await waitFor(manager, "c2c_failed", "FAILED");
    expect((await manager.events()).events).toContainEqual(expect.objectContaining({ type: "TASK_FAILED_EVENT", status: "FAILED" }));
    expect(new TaskManager(ws, nullLogger).progress("c2c_failed")).toMatchObject({ status: "FAILED", error: "intentional failure" });
  });

  it("recovers a running task while its process exists", async () => {
    const ws = workspace("task-reconnect");
    const runner: TaskRunner = async (_root, _name, _prompt, hooks) => { hooks.onReady(process.pid, "thread-live", "turn-live"); return { result: new Promise(() => undefined), cancel: async () => undefined }; };
    const manager = new TaskManager(ws, nullLogger, runner);
    manager.submit({ workspaceName: ws.name, taskId: "c2c_reconnect", iteration: 1, prompt: "Wait" }); await waitFor(manager, "c2c_reconnect", "RUNNING");
    expect(new TaskManager(ws, nullLogger).progress("c2c_reconnect")).toMatchObject({ status: "RUNNING", currentStep: "Reconnected to running Codex task" });
  });

  it("recovers terminal state from an execution record", async () => {
    const ws = workspace("task-record-recovery");
    const runner: TaskRunner = async (_root, _name, _prompt, hooks) => { hooks.onReady(process.pid, "thread-stale", "turn-stale"); return { result: new Promise(() => undefined), cancel: async () => undefined }; };
    const manager = new TaskManager(ws, nullLogger, runner);
    manager.submit({ workspaceName: ws.name, taskId: "c2c_recovered", iteration: 1, prompt: "Wait" }); await waitFor(manager, "c2c_recovered", "RUNNING");
    appendExecutionRecord(ws.id, { taskId: "c2c_recovered", iteration: 1, changedFiles: 0, tests: "PASS", exitStatus: "ok", timestamp: new Date().toISOString() });
    expect(new TaskManager(ws, nullLogger).progress("c2c_recovered")).toMatchObject({ status: "COMPLETED", progress: 100 });
  });

  it("is idempotent for the same task id and iteration", async () => {
    const ws = workspace("task-idempotent"); let runs = 0;
    const runner: TaskRunner = async (...args) => { runs++; return immediate()(...args); };
    const manager = new TaskManager(ws, nullLogger, runner), input = { workspaceName: ws.name, taskId: "c2c_repeat", iteration: 1, prompt: "Read only" };
    manager.submit(input); manager.submit(input); await waitFor(manager, "c2c_repeat", "COMPLETED"); expect(runs).toBe(1);
  });
});
