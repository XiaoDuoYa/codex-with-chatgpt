import fs from "node:fs";
import path from "node:path";
import { TaskSnapshotSchema, type TaskSnapshot } from "../protocol/types.js";
import { renderCurrentTask } from "./projection.js";

export class TaskStoreError extends Error {
  constructor(
    public readonly code: "INVALID_TASK_SNAPSHOT" | "TASK_NOT_FOUND" | "PROJECTION_WRITE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "TaskStoreError";
  }
}

export class TaskStore {
  readonly taskDir: string;
  readonly currentJsonPath: string;
  readonly currentMarkdownPath: string;

  constructor(readonly workspaceRoot: string) {
    this.taskDir = path.join(path.resolve(workspaceRoot), ".c2c");
    this.currentJsonPath = path.join(this.taskDir, "current.json");
    this.currentMarkdownPath = path.join(this.taskDir, "current.md");
  }

  write(input: TaskSnapshot): TaskSnapshot {
    const snapshot = TaskSnapshotSchema.parse(input);
    fs.mkdirSync(this.taskDir, { recursive: true });
    const temporary = `${this.currentJsonPath}.tmp`;
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const handle = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(handle, serialized, "utf8");
      try {
        fs.fsyncSync(handle);
      } catch {
        // Best effort on filesystems without fsync support.
      }
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, this.currentJsonPath);
    const persisted = this.readRequired();
    this.writeProjections(persisted);
    return persisted;
  }

  read(): TaskSnapshot | null {
    if (!fs.existsSync(this.currentJsonPath)) return null;
    return this.readRequired();
  }

  repairProjections(): TaskSnapshot | null {
    const snapshot = this.read();
    if (!snapshot) return null;
    this.writeProjections(snapshot);
    return snapshot;
  }

  private readRequired(): TaskSnapshot {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.currentJsonPath, "utf8"));
      return TaskSnapshotSchema.parse(raw);
    } catch (error) {
      throw new TaskStoreError(
        "INVALID_TASK_SNAPSHOT",
        `Unable to read a valid task snapshot from ${this.currentJsonPath}: ${(error as Error).message}`
      );
    }
  }

  private writeProjections(snapshot: TaskSnapshot): void {
    try {
      const tasksDir = path.join(this.taskDir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(this.currentMarkdownPath, renderCurrentTask(snapshot), "utf8");
      fs.writeFileSync(path.join(tasksDir, `${snapshot.taskId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new TaskStoreError("PROJECTION_WRITE_FAILED", `Unable to rebuild task projections: ${(error as Error).message}`);
    }
  }
}
