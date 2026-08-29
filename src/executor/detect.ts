import { spawnSync } from "node:child_process";
import type { DetectionResult } from "./types.js";

export function detectBinary(binary: string): DetectionResult {
  const isWindows = process.platform === "win32";
  const probeCmd = isWindows ? "where.exe" : "which";
  
  try {
    const whichRes = spawnSync(probeCmd, [binary], {
      encoding: "utf8",
      shell: false,
      timeout: 3000,
    });

    if (whichRes.status !== 0 || !whichRes.stdout.trim()) {
      return {
        available: false,
        binary,
        error: `Binary "${binary}" not found in PATH.`,
      };
    }

    const binPath = whichRes.stdout.trim().split("\n")[0]?.trim() || "";

    // Optional version probe
    let version: string | undefined;
    try {
      const verRes = spawnSync(binary, ["--version"], {
        encoding: "utf8",
        shell: false,
        timeout: 3000,
      });
      if (verRes.status === 0 && verRes.stdout.trim()) {
        version = verRes.stdout.trim().split("\n")[0]?.trim();
      }
    } catch {
      // version check is best effort
    }

    return {
      available: true,
      binary,
      path: binPath,
      version,
    };
  } catch (error) {
    return {
      available: false,
      binary,
      error: (error as Error).message,
    };
  }
}
