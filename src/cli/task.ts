import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { parseGitHubRemote } from "../github/repository.js";
import { buildPlanInstruction } from "../protocol/instructions.js";
import { parseC2CMessage } from "../protocol/parser.js";
import type { TaskSnapshot } from "../protocol/types.js";
import { validateImportedMessage } from "../protocol/validator.js";
import { TaskLifecycle, TaskLifecycleError } from "../task/lifecycle.js";
import { TaskStore, TaskStoreError } from "../task/store.js";
import { generateTaskId, GitHubTransport } from "../transport/github.js";
import { McpTransport } from "../transport/mcp.js";
import { selectTransport, TransportSelectionError, type TransportPreference } from "../transport/select.js";
import { runGit } from "../workspace/git.js";
import { Workspace } from "../workspace/manager.js";

export function registerTaskCommands(program: Command): void {
  registerTransportCommands(program);
  const task = program.command("task").description("Manage a transport-independent C2C task");

  task
    .command("start")
    .description("Start a C2C task")
    .argument("<goal>")
    .option("-w, --workspace <path>")
    .option("--transport <transport>", "auto | mcp | github")
    .option("--json", "machine-readable output", false)
    .action(async (goal: string, opts: { workspace?: string; transport?: string; json: boolean }) => {
      try {
        const root = resolveWorkspace(opts.workspace);
        const workspace = new Workspace(root);
        const remote = workspace.projectConfig.github?.remote ?? "origin";
        const remoteResult = runGit(root, ["remote", "get-url", remote]);
        const selected = selectTransport({
          projectDefault: workspace.projectConfig.transport ?? "auto",
          taskOverride: parsePreference(opts.transport),
          hasGitHubRemote: remoteResult.ok && Boolean(remoteResult.stdout.trim()),
        });
        const now = new Date().toISOString();
        const taskId = generateTaskId();
        const parsedRemote = remoteResult.ok ? parseGitHubRemote(remoteResult.stdout.trim()) : null;
        const snapshot: TaskSnapshot = {
          protocolVersion: 1,
          taskId,
          transport: selected,
          state: "INIT",
          iteration: 0,
          goal,
          createdAt: now,
          updatedAt: now,
          repository: selected === "github"
            ? {
                provider: "github",
                owner: parsedRemote?.owner ?? "local",
                name: parsedRemote?.name ?? path.basename(root),
                remote,
                branch: "pending",
              }
            : null,
          taskBaseCommit: null,
          iterationBaseCommit: null,
          codeHeadCommit: null,
          declaredChangedFiles: [],
          tests: { status: "not_run", summary: null, command: null },
          reviewFocus: "",
          lastImported: null,
          pendingDecision: null,
          blockedFrom: null,
        };

        if (selected === "github") {
          const receipt = await new GitHubTransport().prepare({ workspaceRoot: root, snapshot });
          if (!receipt.ok) return emitFailure(receipt.code ?? "TRANSPORT_PREPARE_FAILED", "Unable to publish INIT.", opts.json);
          const persisted = new TaskStore(root).read()!;
          return emitSuccess(
            {
              taskId,
              state: persisted.state,
              iteration: persisted.iteration,
              transport: selected,
              branch: persisted.repository?.branch,
              instruction: receipt.instruction,
            },
            opts.json
          );
        }

        const store = new TaskStore(root);
        const persisted = store.write(snapshot);
        const receipt = await new McpTransport().prepare({ workspaceRoot: root, tunnel: false, pairing: false });
        return emitSuccess(
          {
            taskId,
            state: persisted.state,
            iteration: persisted.iteration,
            transport: selected,
            instruction: buildPlanInstruction(persisted, {
              kind: "mcp",
              locator: { mcpUrl: String(receipt.mcpUrl ?? "") },
              capabilities: { directRead: true, requiresManualRelay: false },
            }),
          },
          opts.json
        );
      } catch (error) {
        emitCaught(error, opts.json);
      }
    });

  task
    .command("status")
    .description("Show and repair the active task projection")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      try {
        const snapshot = new TaskStore(resolveWorkspace(opts.workspace)).repairProjections();
        if (!snapshot) return emitFailure("TASK_NOT_FOUND", "No active C2C task exists.", opts.json);
        emitSuccess({ ...snapshot }, opts.json);
      } catch (error) {
        emitCaught(error, opts.json);
      }
    });

  task
    .command("import")
    .description("Import a PLAN, DONE, or BLOCKED C2C message")
    .option("-w, --workspace <path>")
    .option("--file <path>")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; file?: string; json: boolean }) => {
      try {
        const root = resolveWorkspace(opts.workspace);
        const text = opts.file ? fs.readFileSync(path.resolve(opts.file), "utf8") : fs.readFileSync(0, "utf8");
        const parsed = parseC2CMessage(text);
        if (!parsed.ok) {
          const diagnostic = parsed.diagnostics.find((item) => item.severity === "error") ?? parsed.diagnostics[0];
          return emitFailure(diagnostic?.code ?? "PROTOCOL_PARSE_FAILED", diagnostic?.message ?? "Invalid C2C message.", opts.json);
        }
        const store = new TaskStore(root);
        const current = store.read();
        if (!current) return emitFailure("TASK_NOT_FOUND", "No active C2C task exists.", opts.json);
        const validation = validateImportedMessage(parsed.message, {
          taskId: current.taskId,
          currentState: current.state,
          currentIteration: current.iteration,
        });
        if (!validation.ok) {
          return emitFailure(validation.code, validation.message, opts.json, validation.expectedTemplate);
        }
        const imported = new TaskLifecycle(store).importMessage(parsed.message);
        emitSuccess(
          {
            state: imported.snapshot.state,
            iteration: imported.snapshot.iteration,
            acceptedDecision: imported.validation.acceptedDecision,
            requiresFinalValidation: imported.validation.requiresFinalValidation,
            snapshot: imported.snapshot,
          },
          opts.json
        );
      } catch (error) {
        emitCaught(error, opts.json);
      }
    });

  task
    .command("resume")
    .description("Resume a BLOCKED task from its recorded origin")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      try {
        const snapshot = new TaskLifecycle(new TaskStore(resolveWorkspace(opts.workspace))).resume();
        emitSuccess({ state: snapshot.state, iteration: snapshot.iteration, snapshot }, opts.json);
      } catch (error) {
        emitCaught(error, opts.json);
      }
    });

  task
    .command("publish")
    .description("Publish an execution result or finalized DONE state")
    .option("-w, --workspace <path>")
    .option("--changed-files <paths>", "comma-separated explicit paths", "")
    .option("--tests <summary>")
    .option("--test-command <command>")
    .option("--review-focus <text>", "", "")
    .option("--exit-status <status>", "ok | failed | blocked", "ok")
    .option("--finalize <result>", "passed | failed")
    .option("--json", "machine-readable output", false)
    .action(async (opts: PublishOptions) => {
      try {
        const root = resolveWorkspace(opts.workspace);
        const store = new TaskStore(root);
        const lifecycle = new TaskLifecycle(store);
        let snapshot = store.read();
        if (!snapshot) return emitFailure("TASK_NOT_FOUND", "No active C2C task exists.", opts.json);
        const changedFiles = splitPaths(opts.changedFiles);
        if (opts.finalize) {
          snapshot = lifecycle.finalizeDone({
            passed: opts.finalize === "passed",
            summary: opts.tests ?? "Final validation completed.",
            command: opts.testCommand,
          });
        } else if (snapshot.state === "PLAN") {
          lifecycle.startExecution();
          snapshot = lifecycle.completeExecution({
            declaredChangedFiles: changedFiles,
            tests: {
              status: opts.exitStatus === "ok" ? "passed" : "failed",
              summary: opts.tests ?? null,
              command: opts.testCommand ?? null,
            },
            reviewFocus: opts.reviewFocus,
          });
        }
        const transport = snapshot.transport === "github" ? new GitHubTransport() : new McpTransport();
        const receipt = await transport.publish({
          workspaceRoot: root,
          workspaceId: new Workspace(root).id,
          snapshot,
          taskId: snapshot.taskId,
          iteration: snapshot.iteration,
          changedFiles,
          tests: opts.tests ?? null,
          exitStatus: opts.exitStatus,
        });
        if (!receipt.ok) return emitFailure(String(receipt.code ?? "PUBLISH_FAILED"), "Task publication failed.", opts.json);
        emitSuccess({ state: snapshot.state, iteration: snapshot.iteration, receipt }, opts.json);
      } catch (error) {
        emitCaught(error, opts.json);
      }
    });
}

interface PublishOptions {
  workspace?: string;
  changedFiles: string;
  tests?: string;
  testCommand?: string;
  reviewFocus: string;
  exitStatus: string;
  finalize?: "passed" | "failed";
  json: boolean;
}

function registerTransportCommands(program: Command): void {
  const transport = program.command("transport").description("Inspect or set the project transport default");
  transport
    .command("get")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      emitSuccess({ transport: workspace.projectConfig.transport ?? "auto" }, opts.json);
    });
  transport
    .command("set")
    .argument("<transport>")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action((value: string, opts: { workspace?: string; json: boolean }) => {
      try {
        const preference = parsePreference(value);
        if (!preference) throw new TransportSelectionError("TRANSPORT_CHOICE_REQUIRED", "Transport value is required.");
        const root = resolveWorkspace(opts.workspace);
        const configPath = path.join(root, ".c2c.json");
        const current = fs.existsSync(configPath) ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>) : {};
        fs.writeFileSync(configPath, `${JSON.stringify({ ...current, transport: preference }, null, 2)}\n`, "utf8");
        emitSuccess({ transport: preference }, opts.json);
      } catch (error) {
        emitCaught(error, opts.json);
      }
    });
}

function parsePreference(value: string | undefined): TransportPreference | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "mcp" || value === "github") return value;
  throw new Error(`Unknown transport: ${value}`);
}

function resolveWorkspace(value?: string): string {
  return path.resolve(value ?? process.cwd());
}

function splitPaths(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function emitSuccess(data: Record<string, unknown>, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, ...data })}\n`);
  else process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function emitFailure(code: string, message: string, json: boolean, expectedTemplate?: string): void {
  const output = { ok: false, code, message, ...(expectedTemplate ? { expectedTemplate } : {}) };
  if (json) process.stdout.write(`${JSON.stringify(output)}\n`);
  else process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
}

function emitCaught(error: unknown, json: boolean): void {
  if (error instanceof TaskLifecycleError || error instanceof TaskStoreError || error instanceof TransportSelectionError) {
    emitFailure(error.code, error.message, json);
    return;
  }
  emitFailure("C2C_COMMAND_FAILED", error instanceof Error ? error.message : String(error), json);
}
