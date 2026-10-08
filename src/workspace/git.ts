import { spawnSync } from "node:child_process";
import { IgnoreRules } from "./ignore.js";
import { WorkspaceError, type ReadFileResult } from "./manager.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGit(root: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export function gitInfo(root: string): GitInfo {
  const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Pathspec confines the result to the workspace subtree even when the
  // workspace root sits inside a larger repository.
  const status = runGit(root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : false,
  };
}

export interface WorkspaceLike {
  root: string;
  ignoreRules?: IgnoreRules;
}

export type GitTarget = string | WorkspaceLike;

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
  /** Sensitive entries withheld. `conflicts` stays separate so a merge is not reported as clean. */
  hidden: { changes: number; conflicts: number };
}

export function gitStatus(target: GitTarget): GitStatusResult {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules ? target.ignoreRules : new IgnoreRules(root);
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    hidden: { changes: 0, conflicts: 0 },
  };
  const result = runGit(root, ["status", "--porcelain=v2", "--branch", "--", "."]);
  if (!result.ok) return empty;
  const out: GitStatusResult = { ...empty, hidden: { ...empty.hidden }, isRepo: true };
  const withheld = (paths: string[]): boolean => paths.some((p) => ignoreRules.isSensitive(p));

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "";
      const isRename = line.startsWith("2 ");
      const destination = isRename
        ? (line.split("\t")[0]?.split(" ").slice(9).join(" ") ?? "")
        : parts.slice(8).join(" ");
      const origin = isRename ? (line.split("\t")[1] ?? "") : null;
      const rawPaths = origin === null ? [destination] : [destination, origin];
      const filePath = origin === null ? destination : `${destination} -> ${origin}`;
      if (withheld(rawPaths)) {
        out.hidden.changes += (xy[0] !== "." ? 1 : 0) + (xy[1] !== "." ? 1 : 0);
        continue;
      }
      if (xy[0] !== ".") out.staged.push({ path: filePath, change: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: filePath, change: xy[1] });
    } else if (line.startsWith("? ")) {
      const filePath = line.slice(2);
      if (withheld([filePath])) out.hidden.changes += 1;
      else out.untracked.push(filePath);
    } else if (line.startsWith("u ")) {
      const filePath = line.split(" ").slice(10).join(" ");
      if (withheld([filePath])) out.hidden.conflicts += 1;
      else out.conflicted.push(filePath);
    }
  }
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head" | "revision";

export interface GitDiffOptions {
  mode?: DiffMode;
  /** Exact commits or branch names in the same repository, never another workspace path. */
  baseRef?: string;
  headRef?: string;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
  baseCommit?: string;
  headCommit?: string;
}

function getDiffModeArgs(mode: DiffMode): string[] {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

/** Resolve a review ref to an immutable commit before any pagination or file read. */
export function resolveReviewCommit(root: string, ref: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".")
  ) {
    throw new WorkspaceError("INVALID_REVISION", "Use a commit SHA or a simple branch name in this repository.");
  }
  const result = runGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (!result.ok || !/^[a-f0-9]{40,64}$/.test(sha)) {
    throw new WorkspaceError("INVALID_REVISION", `Revision is not a commit in this repository: ${ref}`);
  }
  // Do not expose dangling objects that happen to remain in Git's object store.
  // Candidate worktree branches share the same object store and pass this check.
  const refs = runGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    sha,
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const reachableFromHead = runGit(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
  if ((!refs.ok || !refs.stdout.trim()) && !reachableFromHead.ok) {
    throw new WorkspaceError("INVALID_REVISION", `Revision is not reachable from a current Git ref: ${ref}`);
  }
  return sha;
}

function readRevisionIgnore(root: string, commit: string): string | null {
  const prefix = runGit(root, ["rev-parse", "--show-prefix"]);
  if (!prefix.ok) throw new WorkspaceError("INVALID_REVISION", "Workspace is not a Git checkout.");
  const file = `${prefix.stdout.trim()}.c2cignore`;
  const size = runGit(root, ["cat-file", "-s", `${commit}:${file}`]);
  if (!size.ok) return null;
  if (Number(size.stdout.trim()) > 1024 * 1024) {
    throw new WorkspaceError("FILE_TOO_LARGE", "Revision .c2cignore is too large to review safely.");
  }
  const contents = runGit(root, ["cat-file", "-p", `${commit}:${file}`]);
  if (!contents.ok) throw new WorkspaceError("INVALID_REVISION", "Cannot read revision ignore rules.");
  return contents.stdout;
}

function revisionIgnoreRules(root: string, commits: string[]): IgnoreRules {
  const rules = new IgnoreRules(root);
  for (const commit of commits) {
    const contents = readRevisionIgnore(root, commit);
    if (contents !== null) rules.addConservativeIgnore(contents);
  }
  return rules;
}

function chunkSafePaths(paths: string[], maxCount = 50, maxBytes = 32 * 1024): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBytes = 0;

  for (const p of paths) {
    const pBytes = Buffer.byteLength(p, "utf8") + 12; // overhead for ":(literal)"
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxCount || currentBytes + pBytes > maxBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(p);
    currentBytes += pBytes;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

function isPathInScope(filePath: string, scope?: string): boolean {
  if (!scope || scope === ".") return true;
  return filePath === scope || filePath.startsWith(scope + "/");
}

export function gitDiff(
  target: GitTarget,
  opts: GitDiffOptions = {},
  relPath?: string
): GitDiffResult {
  const root = typeof target === "string" ? target : target.root;
  let ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  let baseCommit: string | undefined;
  let headCommit: string | undefined;
  let modeArgs = getDiffModeArgs(mode);
  if (mode === "revision") {
    if (!opts.baseRef || !opts.headRef) {
      throw new WorkspaceError("INVALID_REVISION", "Revision review requires both base_ref and head_ref.");
    }
    baseCommit = resolveReviewCommit(root, opts.baseRef);
    headCommit = resolveReviewCommit(root, opts.headRef);
    ignoreRules = revisionIgnoreRules(root, [baseCommit, headCommit]);
    modeArgs = [baseCommit, headCommit];
  } else if (opts.baseRef || opts.headRef) {
    throw new WorkspaceError("INVALID_REVISION", "base_ref and head_ref require mode='revision'.");
  }

  // 1. Full-workspace inventory using NUL separation and global rename detection
  const listArgs = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    ".",
  ];
  const listResult = runGit(root, listArgs);
  if (!listResult.ok) {
    return {
      isRepo: false,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
      baseCommit,
      headCommit,
    };
  }

  const tokens = listResult.stdout.split("\0");
  const safePaths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        // Layer 1: Security - EITHER side sensitive -> completely unsafe
        const isSafe = !ignoreRules.isSensitive(oldPath) && !ignoreRules.isSensitive(newPath);
        // Layer 2: Scope - EITHER side in scope -> relevant
        const isRelevant = isPathInScope(oldPath, relPath) || isPathInScope(newPath, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(oldPath, newPath);
        }
      }
    } else {
      const filePath = tokens[i++];
      if (filePath) {
        const isSafe = !ignoreRules.isSensitive(filePath);
        const isRelevant = isPathInScope(filePath, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(filePath);
        }
      }
    }
  }

  if (safePaths.length === 0) {
    return {
      isRepo: true,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
      baseCommit,
      headCommit,
    };
  }

  // 2. Fetch diffs for safe paths in bounded batches (path count + argv bytes)
  const batches = chunkSafePaths(safePaths);
  let combinedDiff = "";
  let totalAggregateBytes = 0;
  const MAX_AGGREGATE_DIFF_BYTES = 64 * 1024 * 1024;

  for (const batch of batches) {
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffArgs = [
      "diff",
      "--no-color",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const diffResult = runGit(root, diffArgs);
    if (!diffResult.ok) {
      // Fail closed on any batch error: never return partial silent success
      return {
        isRepo: false,
        mode,
        totalBytes: 0,
        offset: 0,
        returnedBytes: 0,
        hasMore: false,
        nextOffset: null,
        diff: "",
        baseCommit,
        headCommit,
      };
    }
    if (diffResult.stdout) {
      const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
      if (totalAggregateBytes + chunkBytes > MAX_AGGREGATE_DIFF_BYTES) {
        // Fail closed on aggregate cap: do not fake a partial successful diff
        return {
          isRepo: false,
          mode,
          totalBytes: 0,
          offset: 0,
          returnedBytes: 0,
          hasMore: false,
          nextOffset: null,
          diff: "",
          baseCommit,
          headCommit,
        };
      }
      combinedDiff += diffResult.stdout;
      totalAggregateBytes += chunkBytes;
    }
  }

  const full = Buffer.from(combinedDiff, "utf8");
  const slice = full.subarray(offset, offset + maxBytes);
  let text = slice.toString("utf8");
  let sliceLen = slice.length;
  // Avoid cutting mid-line when more content follows.
  if (offset + sliceLen < full.length) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > 0) {
      text = text.slice(0, lastNewline + 1);
      sliceLen = Buffer.byteLength(text, "utf8");
    }
  }
  const hasMore = offset + sliceLen < full.length;
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? offset + sliceLen : null,
    diff: text,
    baseCommit,
    headCommit,
  };
}

/** Read committed source, including a file absent from the current checkout. */
export function readFileAtRevision(
  target: WorkspaceLike & { resolve(path: string): { rel: string } },
  requested: string,
  revision: string,
  opts: { startLine?: number; endLine?: number } = {}
): ReadFileResult & { revision: string } {
  const rel = target.resolve(requested).rel;
  if (!rel) throw new WorkspaceError("NOT_A_FILE", "Choose a file, not the workspace root.");
  const commit = resolveReviewCommit(target.root, revision);
  const rules = revisionIgnoreRules(target.root, [commit]);
  if (rules.isSensitive(rel)) {
    throw new WorkspaceError("ACCESS_DENIED_SENSITIVE_FILE", `Sensitive file cannot be read: ${rel}`);
  }
  const prefix = runGit(target.root, ["rev-parse", "--show-prefix"]);
  if (!prefix.ok) throw new WorkspaceError("INVALID_REVISION", "Workspace is not a Git checkout.");
  const repoPath = `${prefix.stdout.trim()}${rel}`;
  const tree = runGit(target.root, ["ls-tree", "-z", commit, "--", `:(literal)${repoPath}`]);
  if (!tree.ok || !tree.stdout) throw new WorkspaceError("FILE_NOT_FOUND", `File not found at revision: ${rel}`);
  const entry = tree.stdout.split("\0")[0];
  if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) {
    throw new WorkspaceError("NOT_A_FILE", `Not a regular file at revision: ${rel}`);
  }
  const size = runGit(target.root, ["cat-file", "-s", `${commit}:${repoPath}`]);
  const sizeBytes = Number(size.stdout.trim());
  if (!size.ok || !Number.isSafeInteger(sizeBytes)) {
    throw new WorkspaceError("FILE_NOT_FOUND", `File not found at revision: ${rel}`);
  }
  if (sizeBytes > 8 * 1024 * 1024) {
    throw new WorkspaceError("FILE_TOO_LARGE", `Revision file exceeds the 8 MiB read limit: ${rel}`);
  }
  const blob = runGit(target.root, ["cat-file", "-p", `${commit}:${repoPath}`]);
  if (!blob.ok) throw new WorkspaceError("FILE_NOT_FOUND", `File not found at revision: ${rel}`);
  if (blob.stdout.includes("\0")) throw new WorkspaceError("BINARY_FILE", `Binary file at revision: ${rel}`);

  const lines = blob.stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  const start = Math.max(1, Math.floor(opts.startLine ?? 1));
  const endLimit = opts.endLine
    ? Math.min(Math.floor(opts.endLine), start + 1999)
    : start + 399;
  let collected = "";
  let actualEnd = start - 1;
  for (let line = start; line <= Math.min(endLimit, totalLines); line++) {
    const addition = `${collected ? "\n" : ""}${lines[line - 1]}`;
    if (Buffer.byteLength(collected + addition, "utf8") > 256 * 1024 && actualEnd >= start) break;
    collected += addition;
    actualEnd = line;
  }
  const remaining = Math.max(0, totalLines - actualEnd);
  return {
    path: rel,
    revision: commit,
    sizeBytes,
    totalLines,
    startLine: Math.min(start, Math.max(totalLines, 1)),
    endLine: actualEnd,
    truncated: remaining > 0,
    remainingLines: remaining,
    nextStartLine: remaining > 0 ? actualEnd + 1 : null,
    content: collected,
  };
}
