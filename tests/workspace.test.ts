import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Workspace, WorkspaceError } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write, git, makeGitRepo } from "./helpers.js";
import { getProjectDataDir, getWorkspaceDataDir } from "../src/config/paths.js";
import { projectDataDirectory, projectIdMetadataPath } from "../src/workspace/identity.js";
import { openControlResultRequest } from "../src/control/mailbox.js";
import { saveExecutionOutput, listExecutionOutputs } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { commitSessionRoute, readSession } from "../src/session/state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveProjectIdInChild(
  root: string,
  extraEnv: Record<string, string> = {}
): Promise<string> {
  const identityUrl = pathToFileURL(path.join(projectRoot, "src", "workspace", "identity.ts")).href;
  const script = `import { resolveProjectId } from ${JSON.stringify(identityUrl)}; process.stdout.write(resolveProjectId(process.env.C2C_PROJECT_ROOT));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv, C2C_PROJECT_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`project identity child exited ${code}: ${error}`));
    });
  });
}

let root: string;
let outside: string;
let ws: Workspace;
let symlinksReady: boolean;

beforeAll(() => {
  root = makeTmpDir("ws");
  outside = makeTmpDir("outside");
  write(root, "hello.txt", "hello world\n");
  write(root, "src/app.ts", "const x = 1;\n");
  write(root, ".env", "SECRET=topsecret\n");
  write(root, ".env.production", "SECRET=prod\n");
  write(root, ".env.example", "SECRET=changeme\n");
  write(root, "certs/server.pem", "PRIVATE KEY\n");
  write(root, "keys/id_rsa", "PRIVATE KEY\n");
  write(root, "nested/.ssh/config", "Host *\n");
  write(outside, "secret.txt", "outside data\n");
  write(root, ".c2cignore", "private-notes/\n");
  write(root, "private-notes/todo.md", "secret notes\n");
  // symlink pointing outside the workspace (needs symlink privileges, e.g.
  // absent for unprivileged Windows runners — the escape tests then skip)
  symlinksReady = true;
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
    fs.symlinkSync(outside, path.join(root, "dir-out"));
  } catch {
    symlinksReady = false;
  }
  ws = new Workspace(root);
});

afterAll(() => {
  cleanup(root);
  cleanup(outside);
});

describe("path containment", () => {
  it("reads a normal relative path", async () => {
    const result = await ws.readFile("hello.txt");
    expect(result.content).toContain("hello world");
  });

  it("rejects ../ traversal", () => {
    expect(() => ws.resolve("../outside-file")).toThrowError(WorkspaceError);
    expect(() => ws.resolve("../../etc/passwd")).toThrow(/PATH_OUTSIDE|outside/i);
    try {
      ws.resolve("a/../../b");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => ws.resolve("/etc/passwd")).toThrowError(WorkspaceError);
    expect(() => ws.resolve(outside)).toThrowError(WorkspaceError);
  });

  it("allows absolute paths inside the workspace", () => {
    const resolved = ws.resolve(path.join(root, "hello.txt"));
    expect(resolved.rel).toBe("hello.txt");
  });

  it("rejects windows-style traversal", () => {
    expect(() => ws.resolve("..\\..\\etc\\passwd")).toThrowError(WorkspaceError);
  });

  it("rejects null bytes", () => {
    expect(() => ws.resolve("hello.txt\0.png")).toThrowError(WorkspaceError);
  });

  it("rejects symlinked file escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("link-out.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects paths through a symlinked directory escaping the workspace", () => {
    if (!symlinksReady) return; // symlink privilege unavailable
    try {
      ws.resolve("dir-out/secret.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });
});

describe("sensitive files", () => {
  const expectDenied = (p: string): void => {
    try {
      ws.resolve(p);
      expect.unreachable(`expected ${p} to be denied`);
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    }
  };

  it("denies .env and variants", () => {
    expectDenied(".env");
    expectDenied(".env.production");
  });

  it("allows .env.example", () => {
    expect(ws.resolve(".env.example").rel).toBe(".env.example");
  });

  it("denies keys and certificates", () => {
    expectDenied("certs/server.pem");
    expectDenied("keys/id_rsa");
  });

  it("denies .ssh directories anywhere", () => {
    expectDenied("nested/.ssh/config");
  });

  it("honors .c2cignore custom rules", () => {
    expectDenied("private-notes/todo.md");
  });

  it("hides sensitive files from directory listing", async () => {
    const listing = await ws.listDirectory(".", { limit: 500, depth: 2 });
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.includes("private-notes"))).toBe(false);
  });
});

describe("read_file pagination", () => {
  it("caps unbounded reads at 400 lines and reports the remainder", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    write(root, "big.txt", big);
    const result = await ws.readFile("big.txt");
    expect(result.totalLines).toBe(1000);
    expect(result.endLine).toBe(400);
    expect(result.truncated).toBe(true);
    expect(result.remainingLines).toBe(600);
    expect(result.nextStartLine).toBe(401);
  });

  it("returns an explicit range", async () => {
    const result = await ws.readFile("big.txt", { startLine: 500, endLine: 502 });
    expect(result.content).toBe("line 500\nline 501\nline 502");
    expect(result.startLine).toBe(500);
    expect(result.endLine).toBe(502);
  });

  it("denies binary files", async () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await expect(ws.readFile("blob.bin")).rejects.toMatchObject({ code: "BINARY_FILE" });
  });

  it("reports FILE_NOT_FOUND for missing files", async () => {
    await expect(ws.readFile("nope.txt")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

describe("workspace identity", () => {
  it("has a stable id and name", () => {
    const again = new Workspace(root);
    expect(again.id).toBe(ws.id);
    expect(ws.id).toMatch(/^[a-f0-9]{12}$/);
    expect(ws.name).toBe(path.basename(root));
  });

  it("persists a high-entropy project id in the git common dir", () => {
    const repo = makeTmpDir("project-id");
    try {
      makeGitRepo(repo);
      const first = new Workspace(repo);
      const second = new Workspace(repo);
      expect(first.projectId).toBe(second.projectId);
      expect(first.projectId).toMatch(/^git-[a-f0-9]{32}$/);
      const metadata = projectIdMetadataPath(repo);
      expect(metadata).not.toBeNull();
      expect(fs.statSync(metadata!).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(metadata!).isFile()).toBe(true);
      expect(getProjectDataDir(first.projectId)).toBe(projectDataDirectory(repo));
      expect(getWorkspaceDataDir(first.id)).toBe(
        path.join(projectDataDirectory(repo), "workspaces", first.id),
      );
      expect(getWorkspaceDataDir(first.id)).not.toBe(getProjectDataDir(first.projectId));
      expect(projectDataDirectory(repo)).toBe(path.join(path.dirname(metadata!), "codex-with-chatgpt"));
    } finally {
      cleanup(repo);
    }
  });

  it("does not derive project ids from a shared remote URL", () => {
    const firstRepo = makeTmpDir("project-clone-a");
    const secondRepo = makeTmpDir("project-clone-b");
    try {
      makeGitRepo(firstRepo);
      makeGitRepo(secondRepo);
      const remote = "https://github.com/example/shared.git";
      git(firstRepo, "remote", "add", "origin", remote);
      git(secondRepo, "remote", "add", "origin", remote);
      const first = new Workspace(firstRepo);
      const second = new Workspace(secondRepo);
      expect(first.projectId).not.toBe(second.projectId);
    } finally {
      cleanup(firstRepo);
      cleanup(secondRepo);
    }
  });

  it("ignores inherited Git repository selectors when resolving identity", async () => {
    const target = makeTmpDir("project-env-target");
    const decoy = makeTmpDir("project-env-decoy");
    try {
      makeGitRepo(target);
      makeGitRepo(decoy);
      const decoyId = new Workspace(decoy).projectId;
      const targetId = await resolveProjectIdInChild(target, {
        GIT_DIR: path.join(decoy, ".git"),
        GIT_COMMON_DIR: path.join(decoy, ".git"),
        GIT_WORK_TREE: decoy,
      });

      expect(targetId).toMatch(/^git-[a-f0-9]{32}$/);
      expect(targetId).not.toBe(decoyId);
      expect(fs.existsSync(projectIdMetadataPath(target)!)).toBe(true);
    } finally {
      cleanup(target);
      cleanup(decoy);
    }
  });

  it("fails closed to path identity when Git metadata is malformed", () => {
    const repo = makeTmpDir("project-malformed");
    try {
      makeGitRepo(repo);
      const metadata = projectIdMetadataPath(repo);
      expect(metadata).not.toBeNull();
      fs.writeFileSync(metadata!, "not-json", { mode: 0o600 });

      expect(new Workspace(repo).projectId).toMatch(/^path-[a-f0-9]{32}$/);
      expect(fs.readFileSync(metadata!, "utf8")).toBe("not-json");
    } finally {
      cleanup(repo);
    }
  });

  it("degrades to path identity when atomic Git metadata publication is unavailable", () => {
    const repo = makeTmpDir("project-no-hardlink");
    try {
      makeGitRepo(repo);
      const link = vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" });
      });
      try {
        expect(new Workspace(repo).projectId).toMatch(/^path-[a-f0-9]{32}$/);
      } finally {
        link.mockRestore();
      }
      expect(fs.existsSync(projectIdMetadataPath(repo)!)).toBe(false);
    } finally {
      cleanup(repo);
    }
  });

  it("atomically initializes one project id across concurrent processes", async () => {
    const repo = makeTmpDir("project-concurrent");
    try {
      makeGitRepo(repo);
      const ids = await Promise.all(Array.from({ length: 8 }, () => resolveProjectIdInChild(repo)));
      expect(new Set(ids)).toHaveLength(1);
      expect(ids[0]).toMatch(/^git-[a-f0-9]{32}$/);
    } finally {
      cleanup(repo);
    }
  });

  it("keeps the project id across a directory move", () => {
    const original = makeTmpDir("project-move");
    const moved = `${original}-renamed`;
    try {
      makeGitRepo(original);
      const before = new Workspace(original);
      fs.renameSync(original, moved);
      const after = new Workspace(moved);
      expect(after.id).not.toBe(before.id);
      expect(after.projectId).toBe(before.projectId);
    } finally {
      cleanup(original);
      cleanup(moved);
    }
  });

  it("shares the project id across linked worktrees", () => {
    const repo = makeTmpDir("project-worktree");
    const linked = `${repo}-linked`;
    try {
      makeGitRepo(repo);
      git(repo, "worktree", "add", "-b", "linked", linked);
      expect(new Workspace(linked).projectId).toBe(new Workspace(repo).projectId);
    } finally {
      try {
        git(repo, "worktree", "remove", "--force", linked);
      } catch {
        // Cleanup below is sufficient if git worktree bookkeeping is unavailable.
      }
      cleanup(repo);
      cleanup(linked);
    }
  });

  it("isolates checkout state for linked worktrees under the shared project root", () => {
    const repo = makeTmpDir("project-worktree-state");
    const linked = `${repo}-linked`;
    try {
      makeGitRepo(repo);
      git(repo, "worktree", "add", "-b", "linked-state", linked);
      const primary = new Workspace(repo);
      const linkedWorkspace = new Workspace(linked);

      expect(linkedWorkspace.projectId).toBe(primary.projectId);
      expect(linkedWorkspace.id).not.toBe(primary.id);
      expect(getProjectDataDir(primary.projectId)).toBe(projectDataDirectory(repo));
      expect(getWorkspaceDataDir(primary.id)).toBe(
        path.join(projectDataDirectory(repo), "workspaces", primary.id),
      );
      expect(getWorkspaceDataDir(linkedWorkspace.id)).toBe(
        path.join(projectDataDirectory(repo), "workspaces", linkedWorkspace.id),
      );
      expect(getWorkspaceDataDir(primary.id)).not.toBe(getWorkspaceDataDir(linkedWorkspace.id));

      appendExecutionRecord(primary.id, {
        localSessionId: "session-shared",
        taskId: "task-primary",
        iteration: 0,
        changedFiles: ["src/primary.ts"],
        tests: "primary",
        exitStatus: "ok",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      appendExecutionRecord(linkedWorkspace.id, {
        localSessionId: "session-shared",
        taskId: "task-linked",
        iteration: 0,
        changedFiles: ["src/linked.ts"],
        tests: "linked",
        exitStatus: "ok",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      expect(readExecutionRecords(primary.id).map((record) => record.tests)).toEqual(["primary"]);
      expect(readExecutionRecords(linkedWorkspace.id).map((record) => record.tests)).toEqual(["linked"]);

      expect(saveExecutionOutput(primary.id, {
        command: "pnpm test",
        raw: "primary output",
        localSessionId: "session-shared",
        taskId: "task-primary",
        iteration: 0,
      }).id).toBe(1);
      expect(saveExecutionOutput(linkedWorkspace.id, {
        command: "pnpm test",
        raw: "linked output",
        localSessionId: "session-shared",
        taskId: "task-linked",
        iteration: 0,
      }).id).toBe(1);
      expect(listExecutionOutputs(primary.id).map((item) => item.taskId)).toEqual(["task-primary"]);
      expect(listExecutionOutputs(linkedWorkspace.id).map((item) => item.taskId)).toEqual(["task-linked"]);

      const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
      commitSessionRoute(primary.id, "session-shared", {
        projectUrl,
        chatUrl: `${projectUrl.slice(0, -"project".length)}c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      });
      commitSessionRoute(linkedWorkspace.id, "session-shared", {
        projectUrl,
        chatUrl: `${projectUrl.slice(0, -"project".length)}c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff`,
      });
      expect(readSession(primary.id, "session-shared")?.url).toContain("aaaaaaaa");
      expect(readSession(linkedWorkspace.id, "session-shared")?.url).toContain("bbbbbbbb");

      const primaryRequest = openControlResultRequest(primary.id, {
        localSessionId: "session-shared",
        taskId: "task-primary",
        iteration: 0,
        phase: "PLAN",
      });
      const linkedRequest = openControlResultRequest(linkedWorkspace.id, {
        localSessionId: "session-shared",
        taskId: "task-linked",
        iteration: 0,
        phase: "PLAN",
      });
      expect(linkedRequest.requestId).not.toBe(primaryRequest.requestId);
    } finally {
      try {
        git(repo, "worktree", "remove", "--force", linked);
      } catch {
        // Cleanup below is sufficient if git worktree bookkeeping is unavailable.
      }
      cleanup(repo);
      cleanup(linked);
    }
  });

  it("uses a path fallback for non-Git workspaces", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-project-fallback-"));
    try {
      const plainWorkspace = new Workspace(plain);
      expect(plainWorkspace.projectId).toMatch(/^path-[a-f0-9]{32}$/);
      expect(getProjectDataDir(plainWorkspace.projectId)).toBe(
        path.join(fs.realpathSync.native(plain), ".codex-with-chatgpt"),
      );
      expect(() => plainWorkspace.resolve(".codex-with-chatgpt/state.json")).toThrowError(
        expect.objectContaining<Partial<WorkspaceError>>({ code: "ACCESS_DENIED_SENSITIVE_FILE" }),
      );
    } finally {
      cleanup(plain);
    }
  });

  it("rejects a symlinked non-Git workspace data directory", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-project-state-symlink-"));
    const outsideState = makeTmpDir("project-state-outside");
    try {
      fs.symlinkSync(outsideState, path.join(plain, ".codex-with-chatgpt"), "dir");
      expect(() => new Workspace(plain)).toThrow(/workspace data directory must be a real directory/);
    } finally {
      cleanup(plain);
      cleanup(outsideState);
    }
  });

  it("reads .c2c.json project name", () => {
    const named = makeTmpDir("named");
    write(
      named,
      ".c2c.json",
      JSON.stringify({
        name: "Remi",
        maxIterations: 12,
      })
    );
    const namedWs = new Workspace(named);
    expect(namedWs.name).toBe("Remi");
    expect(namedWs.projectConfig.maxIterations).toBe(12);
    cleanup(named);
  });
});
