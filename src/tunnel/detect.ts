import { spawnSync } from "node:child_process";
import path from "node:path";
import { findTrustedExecutable } from "../process/executable.js";

const COMMON_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(process.env.HOME ?? "", ".local", "bin"),
  "C:\\Program Files\\cloudflared",
  "C:\\Program Files (x86)\\cloudflared",
];

/** Locate a binary on PATH or in common install locations. */
export function findBinary(name: string): string | null {
  const executable = findTrustedExecutable(name, {
    additionalDirectories: COMMON_DIRS,
    forbiddenRoots: [process.cwd()],
  });
  if (!executable) return null;
  try {
    const probe = spawnSync(executable, ["--version"], { stdio: "ignore", timeout: 5000 });
    return probe.status === 0 || probe.status === 1 ? executable : null;
  } catch {
    return null;
  }
}

export interface TunnelBinaries {
  cloudflared: string | null;
  wrangler: string | null;
}

export function detectTunnelBinaries(): TunnelBinaries {
  return {
    cloudflared: findBinary("cloudflared"),
    wrangler: findBinary("wrangler"),
  };
}
