import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { GitHubRepository, GitHubRepositoryError } from "../github/repository.js";
import { validatePublishSet, type PublishChange, type PublishChangeStatus } from "../github/security.js";
import { buildPlanInstruction, buildReviewInstruction } from "../protocol/instructions.js";
import { TaskSnapshotSchema, type TaskSnapshot } from "../protocol/types.js";
import { TaskStore } from "../task/store.js";
import { gitStatus } from "../workspace/git.js";
import type {
  C2CTransport,
  DoctorResult,
  PrepareTransportInput,
  PublishTransportInput,
  TransportDoctorInput,
  TransportReceipt,
  TransportStatus,
  TransportStatusInput,
} from "./types.js";

export interface GitHubTransportReceipt extends TransportReceipt {
  taskId?: string;
  branch?: string;
  code?: string;
  instruction?: string;
  codeHeadCommit?: string;
  stateCommit?: string;
}

export function generateTaskId(): string {
  return `c2c_${randomBytes(4).toString("hex")}`;
}

export function buildTaskBranch(taskId: string, goal: string): string {
  const id = taskId.replace(/_/g, "-");
  const slug = goal
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `c2c/${id}-${slug || "task"}`;
}

export class GitHubTransport implements C2CTransport {
  readonly kind = "github" as const;

  async prepare(input: PrepareTransportInput): Promise<GitHubTransportReceipt> {
    if (!input.snapshot) throw new Error("GitHubTransport.prepare requires a validated task snapshot.");
    const initial = TaskSnapshotSchema.parse(input.snapshot);
    const repository = new GitHubRepository(input.workspaceRoot);
    const remote = initial.repository?.remote ?? "origin";
    const status = gitStatus(input.workspaceRoot);
    if (hasAnyChanges(status)) {
      return { ok: false, kind: this.kind, code: "WORKTREE_NOT_CLEAN" };
    }

    const inspection = repository.inspect(remote);
    const baseCommit = inspection.head;
    const branch = buildTaskBranch(initial.taskId, initial.goal);
    repository.createTaskBranch(branch, baseCommit);
    const github = inspection.github ?? {
      owner: initial.repository?.owner ?? "local",
      name: initial.repository?.name ?? path.basename(inspection.root),
    };
    const snapshot: TaskSnapshot = {
      ...initial,
      repository: { provider: "github", owner: github.owner, name: github.name, remote, branch },
      taskBaseCommit: baseCommit,
      iterationBaseCommit: baseCommit,
      codeHeadCommit: baseCommit,
      updatedAt: new Date().toISOString(),
      publicationKey: publicationKey(initial.taskId, "INIT", 0, baseCommit),
    };
    const store = new TaskStore(input.workspaceRoot);
    const persisted = store.write(snapshot);
    repository.stagePaths(metadataPaths(persisted.taskId));
    const stateCommit = repository.commit(`c2c: publish INIT ${persisted.taskId}`);
    try {
      repository.push(remote, branch, true);
    } catch (error) {
      return publishFailure(error, persisted, stateCommit);
    }
    return {
      ok: true,
      kind: this.kind,
      taskId: persisted.taskId,
      branch,
      stateCommit,
      locator: { repository: `${github.owner}/${github.name}`, branch },
      instruction: buildPlanInstruction(persisted, descriptor(persisted)),
    };
  }

  async publish(input: PublishTransportInput): Promise<GitHubTransportReceipt> {
    if (!input.snapshot) throw new Error("GitHubTransport.publish requires a validated task snapshot.");
    const snapshot = TaskSnapshotSchema.parse(input.snapshot);
    if (!snapshot.repository) throw new Error("GitHub task snapshot is missing repository metadata.");
    const repository = new GitHubRepository(input.workspaceRoot);
    const inspection = repository.inspect(snapshot.repository.remote);
    const store = new TaskStore(input.workspaceRoot);

    const retryKey = snapshot.codeHeadCommit
      ? publicationKey(snapshot.taskId, snapshot.state, snapshot.iteration, snapshot.codeHeadCommit)
      : null;
    if (retryKey && snapshot.publicationKey === retryKey) {
      try {
        repository.push(snapshot.repository.remote, snapshot.repository.branch, false);
      } catch (error) {
        return publishFailure(error, snapshot, repository.fullHead());
      }
      return successReceipt(snapshot, repository.fullHead());
    }

    const changes = collectPublishChanges(input.workspaceRoot).filter((change) => !change.path.startsWith(".c2c/"));
    const validation = validatePublishSet(input.workspaceRoot, changes, {
      declaredPaths: snapshot.declaredChangedFiles,
      branch: inspection.branch,
    });
    if (!validation.ok) {
      return { ok: false, kind: this.kind, code: validation.code, paths: validation.paths };
    }

    repository.stagePaths(validation.paths);
    const codeHeadCommit = repository.commit(`c2c: execute ${snapshot.taskId} iteration ${snapshot.iteration}`);
    const next: TaskSnapshot = {
      ...snapshot,
      codeHeadCommit,
      updatedAt: new Date().toISOString(),
      publicationKey: publicationKey(snapshot.taskId, snapshot.state, snapshot.iteration, codeHeadCommit),
    };
    const persisted = store.write(next);
    repository.stagePaths(metadataPaths(persisted.taskId));
    const stateCommit = repository.commit(`c2c: publish ${persisted.state} ${persisted.taskId} iteration ${persisted.iteration}`);
    try {
      repository.push(persisted.repository!.remote, persisted.repository!.branch, false);
    } catch (error) {
      return publishFailure(error, persisted, stateCommit);
    }
    return successReceipt(persisted, stateCommit);
  }

  async status(input: TransportStatusInput): Promise<TransportStatus> {
    try {
      const store = new TaskStore(input.workspaceRoot);
      const snapshot = store.read();
      return {
        ok: true,
        kind: this.kind,
        available: Boolean(snapshot?.repository),
        snapshot,
      };
    } catch (error) {
      return { ok: false, kind: this.kind, available: false, detail: (error as Error).message };
    }
  }

  async doctor(input: TransportDoctorInput): Promise<DoctorResult> {
    const status = await this.status(input);
    return {
      ok: status.available,
      kind: this.kind,
      checks: { taskSnapshot: { ok: status.available, detail: status.detail } },
    };
  }
}

function descriptor(snapshot: TaskSnapshot) {
  return {
    kind: "github" as const,
    locator: {
      repository: `${snapshot.repository!.owner}/${snapshot.repository!.name}`,
      branch: snapshot.repository!.branch,
    },
    capabilities: { directRead: true, requiresManualRelay: true },
  };
}

function successReceipt(snapshot: TaskSnapshot, stateCommit: string): GitHubTransportReceipt {
  return {
    ok: true,
    kind: "github",
    taskId: snapshot.taskId,
    branch: snapshot.repository!.branch,
    codeHeadCommit: snapshot.codeHeadCommit ?? undefined,
    stateCommit,
    locator: descriptor(snapshot).locator,
    instruction: snapshot.state === "INIT"
      ? buildPlanInstruction(snapshot, descriptor(snapshot))
      : buildReviewInstruction(snapshot, descriptor(snapshot)),
  };
}

function publishFailure(error: unknown, snapshot: TaskSnapshot, stateCommit: string): GitHubTransportReceipt {
  const code = error instanceof GitHubRepositoryError ? error.code : "PUBLISH_FAILED";
  return {
    ok: false,
    kind: "github",
    code,
    taskId: snapshot.taskId,
    branch: snapshot.repository?.branch,
    codeHeadCommit: snapshot.codeHeadCommit ?? undefined,
    stateCommit,
  };
}

function metadataPaths(taskId: string): string[] {
  return [".c2c/current.json", ".c2c/current.md", `.c2c/tasks/${taskId}.json`];
}

function publicationKey(taskId: string, state: string, iteration: number, codeHeadCommit: string): string {
  return createHash("sha256").update(`${taskId}:${state}:${iteration}:${codeHeadCommit}`).digest("hex");
}

function hasAnyChanges(status: ReturnType<typeof gitStatus>): boolean {
  return status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length > 0;
}

function collectPublishChanges(workspaceRoot: string): PublishChange[] {
  const status = gitStatus(workspaceRoot);
  const changes: PublishChange[] = [];
  for (const item of [...status.staged, ...status.unstaged]) {
    changes.push({ path: item.path, status: mapStatus(item.change) });
  }
  for (const path of status.untracked) changes.push({ path, status: "untracked" });
  for (const path of status.conflicted) changes.push({ path, status: "conflicted" });
  return dedupeChanges(changes);
}

function mapStatus(change: string): PublishChangeStatus {
  if (change === "A") return "added";
  if (change === "D") return "deleted";
  if (change === "R") return "renamed";
  return "modified";
}

function dedupeChanges(changes: PublishChange[]): PublishChange[] {
  const byPath = new Map<string, PublishChange>();
  for (const change of changes) byPath.set(change.path, change);
  return [...byPath.values()];
}
