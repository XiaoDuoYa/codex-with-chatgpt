import { spawnSync } from "node:child_process";

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

export function checkGitUpdate(repoRoot: string): GitUpdateCheck | null {
  const local = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const remote = runGit(repoRoot, ["ls-remote", "origin", "HEAD"]);
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
