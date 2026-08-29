import { spawnSync } from "node:child_process";
import path from "node:path";

export interface GitHubRemote {
  owner: string;
  name: string;
}

export interface RepositoryInspection {
  root: string;
  branch: string;
  head: string;
  remote: string;
  remoteUrl: string;
  github: GitHubRemote | null;
}

export type GitHubRepositoryErrorCode =
  | "NOT_A_GIT_REPOSITORY"
  | "DETACHED_HEAD"
  | "REMOTE_NOT_FOUND"
  | "BRANCH_CREATE_FAILED"
  | "STAGE_FAILED"
  | "COMMIT_FAILED"
  | "PUBLISH_FAILED"
  | "GIT_COMMAND_FAILED";

export class GitHubRepositoryError extends Error {
  constructor(
    public readonly code: GitHubRepositoryErrorCode,
    message: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "GitHubRepositoryError";
  }
}

export function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
  const trimmed = remoteUrl.trim();
  let pathname: string | null = null;
  if (/^git@github\.com:/i.test(trimmed)) {
    pathname = trimmed.replace(/^git@github\.com:/i, "");
  } else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.toLowerCase() !== "github.com") return null;
      pathname = parsed.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }
  const match = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(pathname);
  return match ? { owner: match[1], name: match[2] } : null;
}

export class GitHubRepository {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.resolve(workspaceRoot);
  }

  inspect(remote: string): RepositoryInspection {
    const topLevel = this.command(["rev-parse", "--show-toplevel"], "NOT_A_GIT_REPOSITORY").stdout.trim();
    const branchResult = this.commandOptional(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branchResult.ok || !branchResult.stdout.trim()) {
      throw new GitHubRepositoryError("DETACHED_HEAD", "GitHub transport requires a named local branch.");
    }
    const remoteResult = this.commandOptional(["remote", "get-url", remote]);
    if (!remoteResult.ok || !remoteResult.stdout.trim()) {
      throw new GitHubRepositoryError("REMOTE_NOT_FOUND", `Git remote '${remote}' does not exist.`, remoteResult.stderr);
    }
    return {
      root: topLevel,
      branch: branchResult.stdout.trim(),
      head: this.fullHead(),
      remote,
      remoteUrl: remoteResult.stdout.trim(),
      github: parseGitHubRemote(remoteResult.stdout),
    };
  }

  createTaskBranch(branch: string, baseCommit: string): void {
    if (!branch.startsWith("c2c/") || branch.includes("..")) {
      throw new GitHubRepositoryError("BRANCH_CREATE_FAILED", `Unsafe task branch name: ${branch}`);
    }
    this.command(["switch", "-c", branch, baseCommit], "BRANCH_CREATE_FAILED");
  }

  stagePaths(paths: string[]): void {
    const explicit = [...new Set(paths.map(normalizePath))];
    if (explicit.length === 0 || explicit.some((item) => item === "." || item === "-A" || item === "--all")) {
      throw new GitHubRepositoryError("STAGE_FAILED", "Git staging requires one or more explicit file paths.");
    }
    this.command(["add", "--", ...explicit], "STAGE_FAILED");
  }

  commit(message: string): string {
    if (!message.trim()) throw new GitHubRepositoryError("COMMIT_FAILED", "Commit message cannot be empty.");
    this.command(["commit", "-m", message], "COMMIT_FAILED");
    return this.fullHead();
  }

  push(remote: string, branch: string, setUpstream: boolean): void {
    const args = ["push"];
    if (setUpstream) args.push("--set-upstream");
    args.push(remote, `HEAD:refs/heads/${branch}`);
    this.command(args, "PUBLISH_FAILED");
  }

  fullHead(): string {
    return this.command(["rev-parse", "HEAD"], "GIT_COMMAND_FAILED").stdout.trim();
  }

  private command(args: string[], code: GitHubRepositoryErrorCode): { stdout: string; stderr: string } {
    const result = this.commandOptional(args);
    if (!result.ok) {
      throw new GitHubRepositoryError(code, `git ${args[0]} failed.`, result.stderr.trim());
    }
    return result;
  }

  private commandOptional(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const result = spawnSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr || result.error?.message || "",
    };
  }
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}
