import { spawnSync } from "node:child_process";
import { runGit } from "./git.js";

export interface RepositoryTarget { host: string; owner: string; name: string; }

/** Return only a repository coordinate, never URL credentials or query strings. */
export function parseRepositoryTarget(remote: string, resolveSshHost: (host: string) => string | null = () => null): RepositoryTarget | null {
  let host: string;
  let pathname: string;
  let ssh = false;
  try {
    if (remote.includes("://")) {
      const url = new URL(remote);
      if (!["https:", "ssh:"].includes(url.protocol) || url.search || url.hash) return null;
      host = url.hostname;
      pathname = url.pathname;
      ssh = url.protocol === "ssh:";
    } else {
      const match = /^(?:[^@\s/:]+@)?([^\s/:]+):([^\s]+)$/.exec(remote);
      if (!match) return null;
      [, host, pathname] = match;
      ssh = true;
    }
    if (ssh) host = resolveSshHost(host) ?? host;
    const parts = pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || parts.length !== 2 ||
        !parts.every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..")) return null;
    return { host: host.toLowerCase(), owner: parts[0], name: parts[1] };
  } catch { return null; }
}

function output(command: string, args: string[], root: string): string | null {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function inspectRepositoryIdentity(root: string, requestedRemote?: string) {
  const git = (args: string[]) => {
    const result = runGit(root, args);
    return result.ok ? result.stdout.trim() : null;
  };
  const branch = git(["symbolic-ref", "--short", "HEAD"]);
  const remote = requestedRemote ?? (branch ? git(["config", "--get", `branch.${branch}.pushRemote`]) : null) ??
    git(["config", "--get", "remote.pushDefault"]) ??
    (branch ? git(["config", "--get", `branch.${branch}.remote`]) : null) ?? "origin";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) throw new Error("Select an explicit named Git remote.");
  const resolveHost = (host: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) return null;
    return output("ssh", ["-G", host], root)?.split("\n").find((line) => line.startsWith("hostname "))?.slice(9) ?? null;
  };
  const targets = (push: boolean) => (git(["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote]) ?? "")
    .split("\n").filter(Boolean).map((url) => parseRepositoryTarget(url, resolveHost));
  const fetchTargets = targets(false);
  const pushTargets = targets(true);
  const target = pushTargets.length === 1 ? pushTargets[0] : null;
  // gh and Git's SSH/HTTPS transport can use different credentials. Never conflate them.
  const profile = target?.host === "github.com" ? output("gh", ["api", "--hostname", target.host, "user", "--jq", "{login,id}"], root) : null;
  let ghActor: { login: string; id: string } | null = null;
  try {
    const value = JSON.parse(profile ?? "null");
    if (value && /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value.login) && Number.isSafeInteger(value.id) && value.id > 0) {
      ghActor = { login: value.login, id: String(value.id) };
    }
  } catch { /* Unavailable authentication remains unknown. */ }
  let accountStatus: "matched" | "mismatch" | "unknown" = "unknown";
  if (ghActor && target) {
    if (ghActor.login.toLowerCase() === target.owner.toLowerCase()) accountStatus = "matched";
    else {
      const metadata = output("gh", ["api", "--hostname", target.host, `repos/${target.owner}/${target.name}`, "--jq", "{ownerType:.owner.type,canRead:.permissions.pull}"], root);
      try {
        const repo = JSON.parse(metadata ?? "null");
        if (repo?.ownerType === "Organization" && repo.canRead === true) accountStatus = "matched";
        else if (repo?.ownerType === "User") accountStatus = "mismatch";
      } catch { /* Unknown owner type cannot approve a different account. */ }
    }
  }
  const identity = (kind: string) => {
    const value = git(["var", kind]);
    const match = value && /^(.+) <([^<>\r\n]+)> \d+ [+-]\d{4}$/.exec(value);
    return match ? { name: match[1], email: match[2] } : null;
  };
  return {
    remote, fetchTargets, pushTargets, target, ghActor, accountStatus,
    author: identity("GIT_AUTHOR_IDENT"), committer: identity("GIT_COMMITTER_IDENT"),
    gitTransportActor: "unknown" as const,
  };
}
