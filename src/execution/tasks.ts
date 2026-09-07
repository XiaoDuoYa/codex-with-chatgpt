import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { appendExecutionRecord, readExecutionRecords } from "./records.js";
import { saveExecutionOutput } from "./output.js";
import { gitStatus } from "../workspace/git.js";
import type { Workspace } from "../workspace/manager.js";
import type { Logger } from "../logger/index.js";
import { VERSION } from "../version.js";

export type TaskStatus = "CREATED" | "QUEUED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface TaskLog { timestamp: string; message: string }
export interface SubmittedTask {
  taskId: string; iteration: number; workspace: string; name: string; plan: string;
  status: TaskStatus; progress: number; currentStep: string; logs: TaskLog[];
  createdAt: string; startedAt?: string; completedAt?: string; processId?: number;
  threadId?: string; turnId?: string; changedFiles: string[]; testStatus?: string;
  summary?: string; executionRecordId?: string; outputId?: number; error?: string; cancelReason?: string;
}
export type TaskEventType = "TASK_CREATED_EVENT" | "TASK_PROGRESS_EVENT" | "TASK_COMPLETED_EVENT" | "TASK_FAILED_EVENT" | "TASK_CANCELLED_EVENT";
export interface TaskEvent {
  eventId: number; type: TaskEventType; taskId: string; iteration: number; timestamp: string;
  status: TaskStatus; progress: number; currentStep: string; summary?: string; executionRecordId?: string;
}
export interface TaskRunResult { exitCode: number; output: string; summary?: string; testStatus?: string; changedFiles?: string[] }
export interface TaskRunHooks {
  onReady(processId: number, threadId: string, turnId: string): void;
  onProgress(progress: number, currentStep: string): void;
  onPaused(currentStep: string): void;
  onLog(message: string): void;
}
export interface TaskRunController { result: Promise<TaskRunResult>; cancel(): Promise<void> }
export type TaskRunner = (root: string, name: string, prompt: string, hooks: TaskRunHooks) => Promise<TaskRunController>;

function codexExecutable(): string {
  if (process.platform !== "win32") return "codex";
  return execFileSync("where.exe", ["codex"], { encoding: "utf8" }).split(/\r?\n/)
    .map((v) => v.trim()).find((v) => v.toLowerCase().endsWith("codex.exe")) ?? "codex.cmd";
}

class RpcClient {
  private nextId = 1; private buffer = "";
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  readonly events = new EventEmitter();
  constructor(readonly child: ChildProcessWithoutNullStreams, log: (message: string) => void) {
    child.stdout.on("data", (b: Buffer) => this.consume(b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => { const s = b.toString("utf8").trim(); if (s) log(s); });
    child.once("error", (e) => this.rejectAll(e));
    child.once("close", (code) => this.rejectAll(new Error(`Codex App Server exited (${code ?? "unknown"}).`)));
  }
  notify(method: string, params?: unknown): void { this.write(params === undefined ? { method } : { method, params }); }
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ method, id, params }); });
  }
  private write(v: unknown): void { this.child.stdin.write(`${JSON.stringify(v)}\n`, "utf8"); }
  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n"); if (at < 0) return;
      const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1); if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number") { const p = this.pending.get(m.id); if (!p) continue; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
        else if (m.method) this.events.emit(m.method, m.params);
      } catch { /* non-protocol diagnostic */ }
    }
  }
  private rejectAll(e: Error): void { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); }
}

function itemText(item: any): string {
  if (typeof item?.text === "string") return item.text;
  return Array.isArray(item?.content) ? item.content.map((p: any) => typeof p?.text === "string" ? p.text : "").join("") : "";
}
function itemProgress(item: any): [number, string] {
  const type = String(item?.type ?? ""), command = String(item?.command ?? "").toLowerCase();
  if (/test|vitest|jest|pytest|dotnet test|npm test|pnpm test/.test(command)) return [80, "Running tests"];
  if (/build|publish|pack/.test(command)) return [90, "Building or publishing"];
  if (/filechange|applypatch/i.test(type)) return [55, "Modifying files"];
  if (/command/i.test(type)) return [45, "Running workspace command"];
  if (/reasoning|plan/i.test(type)) return [35, "Planning implementation"];
  return [25, "Reading workspace"];
}

export const runCodexTask: TaskRunner = async (root, name, prompt, hooks) => {
  const child = spawn(codexExecutable(), ["app-server", "--stdio"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new RpcClient(child, hooks.onLog); let threadId = "", turnId = "", summary = "", settled = false;
  const changedFiles = new Set<string>();
  const result = new Promise<TaskRunResult>((resolve, reject) => {
    const finish = (v: TaskRunResult) => { if (settled) return; settled = true; resolve(v); child.stdin.end(); };
    rpc.events.on("item/started", (p: any) => { const [n, s] = itemProgress(p?.item); hooks.onProgress(n, s); });
    rpc.events.on("item/approval/requested", () => hooks.onPaused("Waiting for approval"));
    rpc.events.on("item/input/requested", () => hooks.onPaused("Waiting for user input"));
    rpc.events.on("item/completed", (p: any) => { const s = itemText(p?.item).trim(); if (s && p?.item?.type !== "userMessage") { summary = s; hooks.onLog(s); } });
    rpc.events.on("item/commandExecution/outputDelta", (p: any) => { if (typeof p?.delta === "string" && p.delta.trim()) hooks.onLog(p.delta); });
    rpc.events.on("turn/plan/updated", () => hooks.onProgress(35, "Planning implementation"));
    rpc.events.on("turn/diff/updated", (p: any) => { hooks.onProgress(60, "Reviewing file changes"); for (const match of String(p?.diff ?? "").matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) changedFiles.add(match[2]); });
    rpc.events.on("turn/completed", (p: any) => {
      const status = String(p?.turn?.status ?? "failed");
      if (status === "completed") finish({ exitCode: 0, output: summary || "Codex task completed.", summary, changedFiles: [...changedFiles] });
      else if (status === "interrupted") finish({ exitCode: 130, output: "Codex task was cancelled.", summary, changedFiles: [...changedFiles] });
      else finish({ exitCode: 1, output: String(p?.turn?.error?.message ?? "Codex task failed."), summary, changedFiles: [...changedFiles] });
    });
    child.once("error", reject); child.once("close", (code) => { if (!settled) reject(new Error(`Codex App Server exited before completion (${code ?? "unknown"}).`)); });
  });
  await rpc.request("initialize", { clientInfo: { name: "codex-with-chatgpt", title: "Codex with ChatGPT", version: VERSION }, capabilities: null });
  rpc.notify("initialized");
  const started = await rpc.request("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false, threadSource: "c2c" });
  threadId = String(started?.thread?.id ?? ""); if (!threadId) throw new Error("No Codex thread id returned.");
  await rpc.request("thread/name/set", { threadId, name }); hooks.onProgress(15, "Codex UI task created");
  const turn = await rpc.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], cwd: root, approvalPolicy: "never" });
  turnId = String(turn?.turn?.id ?? ""); if (!turnId) throw new Error("No Codex turn id returned.");
  hooks.onReady(child.pid ?? 0, threadId, turnId); hooks.onProgress(20, "Reading workspace");
  return { result, cancel: async () => { if (!settled) await rpc.request("turn/interrupt", { threadId, turnId }); } };
};

interface TaskStore { tasks: SubmittedTask[]; events: TaskEvent[]; nextEventId: number }
export class TaskManager {
  private readonly file: string; private chain = Promise.resolve();
  private controllers = new Map<string, TaskRunController>(); private active = new Set<string>(); private emitter = new EventEmitter();
  constructor(private workspace: Workspace, private logger: Logger, private runner: TaskRunner = runCodexTask) {
    this.file = path.join(ensureDir(path.join(getStateDir(), "submitted-tasks")), `${workspace.id}.json`); this.reconcile();
  }
  submit(input: { workspaceName: string; taskId?: string | null; iteration?: number | null; prompt: string }): SubmittedTask {
    if (input.workspaceName !== this.workspace.name) throw new Error("WORKSPACE_MISMATCH");
    const taskId = input.taskId?.trim() || `c2c_${randomBytes(4).toString("hex")}`;
    if (!/^c2c_[a-z0-9_-]{4,64}$/i.test(taskId)) throw new Error("INVALID_TASK_ID");
    const plan = input.prompt.trim(); if (!plan || plan.length > 100000) throw new Error("INVALID_PROMPT");
    const store = this.read(), used = store.tasks.filter((t) => t.taskId === taskId).map((t) => t.iteration)
      .concat(readExecutionRecords(this.workspace.id, 1000).filter((r) => r.taskId === taskId).map((r) => r.iteration));
    const iteration = input.iteration ?? Math.max(0, ...used) + 1;
    if (!Number.isInteger(iteration) || iteration < 1) throw new Error("INVALID_ITERATION");
    const duplicate = store.tasks.find((t) => t.taskId === taskId && t.iteration === iteration);
    if (duplicate) { if (duplicate.plan !== plan) throw new Error("TASK_CONFLICT"); return this.copy(duplicate); }
    const task: SubmittedTask = { taskId, iteration, workspace: this.workspace.name, name: taskId, plan, status: "CREATED", progress: 0, currentStep: "Task created", logs: [], createdAt: new Date().toISOString(), changedFiles: [] };
    store.tasks.push(task); this.addEvent(store, task, "TASK_CREATED_EVENT");
    task.status = "QUEUED"; task.progress = 5; task.currentStep = "Waiting for Codex"; this.addEvent(store, task, "TASK_PROGRESS_EVENT"); this.write(store);
    this.active.add(`${taskId}:${iteration}`);
    this.chain = this.chain.then(() => this.execute(taskId, iteration)).catch((e) => this.logger.error("Task queue failed", e));
    return this.copy(task);
  }
  progress(taskId: string): SubmittedTask | null { this.reconcile(); const t = this.latest(taskId); return t ? this.copy(t) : null; }
  async cancel(taskId: string, reason = "Cancelled by user or ChatGPT"): Promise<SubmittedTask | null> {
    const t = this.latest(taskId); if (!t) return null; if (["COMPLETED", "FAILED", "CANCELLED"].includes(t.status)) return this.copy(t);
    const controller = this.controllers.get(this.key(t));
    if (controller) {
      try { await controller.cancel(); }
      catch (error) { if (!/no active turn/i.test(error instanceof Error ? error.message : String(error))) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const current = this.latest(taskId); if (current && ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return this.copy(current);
    } else if (t.processId && processExists(t.processId)) process.kill(t.processId);
    this.finishCancelled(t.taskId, t.iteration, reason); return this.progress(taskId);
  }
  async events(after = 0, limit = 50, waitMs = 0): Promise<{ events: TaskEvent[]; nextEventId: number }> {
    const select = () => this.read().events.filter((e) => e.eventId > after).slice(0, limit); let events = select();
    if (!events.length && waitMs > 0) { await new Promise<void>((resolve) => { const timer = setTimeout(resolve, Math.min(25000, waitMs)); this.emitter.once("event", () => { clearTimeout(timer); resolve(); }); }); events = select(); }
    return { events, nextEventId: events.at(-1)?.eventId ?? after };
  }
  private async execute(taskId: string, iteration: number): Promise<void> {
    this.active.add(`${taskId}:${iteration}`);
    this.patch(taskId, iteration, { status: "RUNNING", progress: 10, currentStep: "Starting Codex", startedAt: new Date().toISOString() }, true);
    const prompt = `Task: ${taskId}\nIteration: ${iteration}\n\nChatGPT plan:\n${this.task(taskId, iteration).plan}`;
    try {
      const c = await this.runner(this.workspace.root, taskId, prompt, { onReady: (processId, threadId, turnId) => this.patch(taskId, iteration, { processId, threadId, turnId }, false), onProgress: (progress, currentStep) => this.updateProgress(taskId, iteration, progress, currentStep), onPaused: (currentStep) => this.pause(taskId, iteration, currentStep), onLog: (m) => this.log(taskId, iteration, m) });
      this.controllers.set(`${taskId}:${iteration}`, c); const result = await c.result; this.controllers.delete(`${taskId}:${iteration}`); this.active.delete(`${taskId}:${iteration}`);
      if (this.task(taskId, iteration).status === "CANCELLED") return;
      if (result.exitCode === 130) { this.finishCancelled(taskId, iteration, "Codex turn was interrupted."); return; }
      const changedFiles = result.changedFiles ?? this.changedFiles(), output = saveExecutionOutput(this.workspace.id, { command: "codex app-server", raw: result.output, exitCode: result.exitCode, taskId, iteration });
      appendExecutionRecord(this.workspace.id, { taskId, iteration, changedFiles, tests: result.testStatus ?? "See execution output", exitStatus: result.exitCode === 0 ? "ok" : "failed", timestamp: new Date().toISOString(), notes: result.summary?.slice(0, 300), outputId: output.id, outputAvailable: output.allowed });
      const status: TaskStatus = result.exitCode === 0 ? "COMPLETED" : "FAILED";
      const t = this.patch(taskId, iteration, { status, progress: status === "COMPLETED" ? 100 : this.task(taskId, iteration).progress, currentStep: status === "COMPLETED" ? "Completed" : "Failed", completedAt: new Date().toISOString(), changedFiles, testStatus: result.testStatus ?? "See execution output", summary: result.summary || result.output.slice(0, 2000), executionRecordId: `${taskId}:${iteration}`, outputId: output.id, error: result.exitCode ? result.output.slice(0, 300) : undefined }, false);
      this.terminal(t, status === "COMPLETED" ? "TASK_COMPLETED_EVENT" : "TASK_FAILED_EVENT");
    } catch (e) {
      this.controllers.delete(`${taskId}:${iteration}`); this.active.delete(`${taskId}:${iteration}`); if (this.task(taskId, iteration).status === "CANCELLED") return;
      const message = e instanceof Error ? e.message : String(e), changedFiles = this.changedFiles();
      appendExecutionRecord(this.workspace.id, { taskId, iteration, changedFiles, tests: null, exitStatus: "failed", timestamp: new Date().toISOString(), notes: message.slice(0, 300) });
      this.terminal(this.patch(taskId, iteration, { status: "FAILED", currentStep: "Failed", completedAt: new Date().toISOString(), changedFiles, error: message.slice(0, 300), executionRecordId: `${taskId}:${iteration}` }, false), "TASK_FAILED_EVENT");
    }
  }
  private finishCancelled(taskId: string, iteration: number, reason: string): void {
    const t = this.patch(taskId, iteration, { status: "CANCELLED", currentStep: "Cancelled", completedAt: new Date().toISOString(), changedFiles: this.changedFiles(), cancelReason: reason, executionRecordId: `${taskId}:${iteration}` }, false);
    appendExecutionRecord(this.workspace.id, { taskId, iteration, changedFiles: t.changedFiles, tests: null, exitStatus: "cancelled", timestamp: t.completedAt!, notes: reason.slice(0, 300) }); this.terminal(t, "TASK_CANCELLED_EVENT");
  }
  private reconcile(): void {
    const store = this.read(); let changed = false;
    for (const t of store.tasks) if (t.status === "RUNNING" || t.status === "PAUSED" || t.status === "QUEUED") {
      if (this.active.has(this.key(t))) continue;
      const r = readExecutionRecords(this.workspace.id, 1000).filter((x) => x.taskId === t.taskId && x.iteration === t.iteration).at(-1);
      if (r) { t.status = /^(ok|success|executed|passed)$/i.test(r.exitStatus) ? "COMPLETED" : r.exitStatus === "cancelled" ? "CANCELLED" : "FAILED"; t.progress = t.status === "COMPLETED" ? 100 : t.progress; t.completedAt = r.timestamp; t.executionRecordId = `${t.taskId}:${t.iteration}`; t.outputId = r.outputId; t.currentStep = t.status === "COMPLETED" ? "Completed" : t.status === "CANCELLED" ? "Cancelled" : "Failed"; }
      else if (t.processId && processExists(t.processId)) { t.status = "RUNNING"; t.currentStep = "Reconnected to running Codex task"; changed = true; continue; }
      else { t.status = "FAILED"; t.completedAt = new Date().toISOString(); t.currentStep = "Interrupted before completion"; t.error = "No running Codex process or completion record exists."; } changed = true;
    }
    if (changed) this.write(store);
  }
  private log(id: string, it: number, message: string): void { const clean = message.replace(/\s+/g, " ").trim().slice(0, 2000); if (!clean) return; const t = this.task(id, it); t.logs.push({ timestamp: new Date().toISOString(), message: clean }); t.logs = t.logs.slice(-200); this.save(t, false); }
  private pause(id: string, it: number, currentStep: string): void { this.patch(id, it, { status: "PAUSED", currentStep }, true); }
  private updateProgress(id: string, it: number, progress: number, currentStep: string): void { const t = this.task(id, it); if (progress < t.progress) return; this.patch(id, it, { status: t.status === "PAUSED" ? "RUNNING" : t.status, progress, currentStep }, true); }
  private patch(id: string, it: number, patch: Partial<SubmittedTask>, event: boolean): SubmittedTask { const t = this.task(id, it), changed = (patch.progress !== undefined && patch.progress !== t.progress) || (patch.currentStep !== undefined && patch.currentStep !== t.currentStep); Object.assign(t, patch); this.save(t, event && changed); return t; }
  private save(t: SubmittedTask, event: boolean): void { const s = this.read(), i = s.tasks.findIndex((x) => x.taskId === t.taskId && x.iteration === t.iteration); if (i < 0) throw new Error("TASK_NOT_FOUND"); s.tasks[i] = t; if (event) this.addEvent(s, t, "TASK_PROGRESS_EVENT"); this.write(s); }
  private terminal(t: SubmittedTask, type: TaskEventType): void { const s = this.read(); this.addEvent(s, t, type); this.write(s); }
  private addEvent(s: TaskStore, t: SubmittedTask, type: TaskEventType): void { const e: TaskEvent = { eventId: s.nextEventId++, type, taskId: t.taskId, iteration: t.iteration, timestamp: new Date().toISOString(), status: t.status, progress: t.progress, currentStep: t.currentStep, summary: t.summary, executionRecordId: t.executionRecordId }; s.events.push(e); s.events = s.events.slice(-1000); this.emitter.emit("event", e); }
  private latest(id: string): SubmittedTask | null { return this.read().tasks.filter((t) => t.taskId === id).sort((a, b) => b.iteration - a.iteration)[0] ?? null; }
  private key(t: SubmittedTask): string { return `${t.taskId}:${t.iteration}`; }
  private changedFiles(): string[] { const s = gitStatus(this.workspace.root); return [...s.staged, ...s.unstaged].map((e) => e.path).concat(s.conflicted, s.untracked); }
  private task(id: string, it: number): SubmittedTask { const t = this.read().tasks.find((x) => x.taskId === id && x.iteration === it); if (!t) throw new Error("TASK_NOT_FOUND"); return t; }
  private copy(t: SubmittedTask): SubmittedTask { return { ...t, logs: [...t.logs], changedFiles: [...t.changedFiles] }; }
  private read(): TaskStore { const s = readJsonIfExists<Partial<TaskStore>>(this.file); return { tasks: s?.tasks ?? [], events: s?.events ?? [], nextEventId: s?.nextEventId ?? 1 }; }
  private write(s: TaskStore): void { writeSecureJson(this.file, { tasks: s.tasks.slice(-100), events: s.events.slice(-1000), nextEventId: s.nextEventId }); }
}
function processExists(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
