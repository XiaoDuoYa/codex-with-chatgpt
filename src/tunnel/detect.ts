import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COMMON_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(process.env.HOME ?? "", ".local", "bin"),
  "C:\\Program Files\\cloudflared",
  "C:\\Program Files (x86)\\cloudflared",
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links"),
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "scoop", "shims"),
  "C:\\ProgramData\\chocolatey\\bin",
];

/** Locate a binary on PATH or in common install locations. */
export function findBinary(name: string): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  try {
    const probe = spawnSync(exe, ["--version"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0 || probe.status === 1) return exe; // on PATH
  } catch {
    // not on PATH
  }
  for (const dir of COMMON_DIRS) {
    const full = path.join(dir, exe);
    try {
      if (fs.existsSync(full)) {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      }
    } catch {
      // try next
    }
  }
  return null;
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
