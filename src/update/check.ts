import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readSourceMetadata, type SourceMetadata } from "./source-metadata.js";

interface GitCommandResult {
  ok: boolean;
  stdout: string;
}

export interface GitUpdateCheck {
  localCommit: string;
  remoteCommit: string;
  updateAvailable: boolean;
}

function runGit(repoRoot: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

function remoteCommit(repository: string, ref: string): string | null {
  const remote = runGit(process.cwd(), ["ls-remote", repository, ref]);
  if (!remote.ok || !remote.stdout) return null;
  const commit = remote.stdout.split(/\s+/, 1)[0];
  return /^[a-f0-9]{40,64}$/i.test(commit) ? commit.toLowerCase() : null;
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function checkoutRoot(repoRoot: string): string | null {
  const topLevel = runGit(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok || !topLevel.stdout) return null;
  return canonicalPath(topLevel.stdout) === canonicalPath(repoRoot) ? topLevel.stdout : null;
}

function checkSourceMetadata(metadata: SourceMetadata): GitUpdateCheck | null {
  if (!metadata.revision || !metadata.repository || !metadata.ref) return null;
  const remote = remoteCommit(metadata.repository, metadata.ref);
  if (!remote) return null;
  const local = metadata.revision.toLowerCase();
  const baseline = metadata.baselineRemoteRevision?.toLowerCase() ?? null;
  return {
    localCommit: local,
    remoteCommit: remote,
    // A local checkout may have been installed before its remote branch caught
    // up. Treat the install-time remote tip as the baseline until it moves.
    updateAvailable: remote !== local && remote !== baseline,
  };
}

export function checkGitUpdate(repoRoot: string): GitUpdateCheck | null {
  const root = checkoutRoot(repoRoot);
  if (!root) {
    const metadata = readSourceMetadata(repoRoot);
    return metadata ? checkSourceMetadata(metadata) : null;
  }
  const local = runGit(root, ["rev-parse", "HEAD"]);
  const remote = runGit(root, ["ls-remote", "origin", "HEAD"]);
  if (!local.ok || !remote.ok || !remote.stdout) return null;

  const remoteCommit = remote.stdout.split(/\s/)[0];
  if (!remoteCommit) return null;

  const remoteIsIntegrated =
    remoteCommit === local.stdout ||
    runGit(repoRoot, ["merge-base", "--is-ancestor", remoteCommit, local.stdout]).ok;
  return {
    localCommit: local.stdout,
    remoteCommit,
    updateAvailable: !remoteIsIntegrated,
  };
}
