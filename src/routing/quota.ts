import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

const windowSchema = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.number().nullable(),
});

const snapshotSchema = z.object({
  limitId: z.string().nullable().optional(),
  primary: windowSchema.nullable(),
  secondary: windowSchema.nullable(),
  rateLimitReachedType: z.string().nullable().optional(),
});

const responseSchema = z.object({
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
  rateLimits: z.unknown().optional(),
  rateLimitsByLimitId: z.record(z.unknown()).nullable().optional(),
});

export interface Quota {
  available: boolean;
  ordinaryUsageAllowed: boolean | null;
  windows: {
    durationMinutes: number | null;
    usedPercent: number;
    remainingPercent: number;
    resetsAt: number | null;
  }[];
  effectiveRemainingPercent: number | null;
  rateLimitReachedType: string | null;
  error?: string;
}

export function summarizeQuota(payload: unknown): Quota {
  const response = responseSchema.parse(payload);
  const snapshot = snapshotSchema.parse(response.rateLimitsByLimitId?.codex ?? response.rateLimits);
  if (snapshot.limitId != null && snapshot.limitId !== "codex") {
    throw new Error("Codex did not return the codex quota bucket.");
  }
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window) => window !== null)
    .map((window) => ({
      durationMinutes: window.windowDurationMins,
      usedPercent: window.usedPercent,
      remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      resetsAt: window.resetsAt,
    }));
  const rateLimitReachedType = snapshot.rateLimitReachedType ?? null;
  const ordinaryUsageAllowed = response.ordinaryUsageAllowed ?? null;
  if (response.ordinaryUsageAllowed === null && rateLimitReachedType === null) {
    throw new Error("Codex ordinary-usage permission is unavailable.");
  }
  if (windows.length === 0 && rateLimitReachedType === null && ordinaryUsageAllowed !== false) {
    throw new Error("Codex did not return any quota windows.");
  }
  return {
    available: true,
    ordinaryUsageAllowed,
    windows,
    effectiveRemainingPercent: windows.length ? Math.min(...windows.map((window) => window.remainingPercent)) : null,
    rateLimitReachedType,
  };
}

export async function readQuota(options: { executable?: string } = {}): Promise<Quota> {
  try {
    const payload = await new Promise<unknown>((resolve, reject) => {
      const child = spawn(options.executable ?? "codex", ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const lines = createInterface({ input: child.stdout });
      let finished = false;
      const finish = (error: Error | null, result?: unknown): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        lines.close();
        child.stdin.end();
        child.kill("SIGKILL");
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("Codex quota read timed out.")), 8_000);
      child.on("error", (error) => finish(error));
      child.stdin.on("error", (error) => finish(error));
      child.on("close", () => finish(new Error("Codex app-server exited before returning quota.")));
      lines.on("line", (line) => {
        if (finished) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("Codex app-server returned invalid JSON."));
          return;
        }
        if (message === null || typeof message !== "object") {
          finish(new Error("Codex app-server returned an invalid RPC message."));
          return;
        }
        if (message.id !== 1 && message.id !== 2) return;
        if (message.error) {
          finish(new Error(message.error.message));
        } else if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ id: 2, method: "account/rateLimits/read" }) + "\n");
        } else {
          finish(null, message.result);
        }
      });
      child.stdin.write(JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "codex_with_chatgpt_quota", version: "0.1.0" } },
      }) + "\n");
    });
    return summarizeQuota(payload);
  } catch (error) {
    return {
      available: false,
      ordinaryUsageAllowed: null,
      windows: [],
      effectiveRemainingPercent: null,
      rateLimitReachedType: null,
      error: error instanceof z.ZodError ? "Codex returned an invalid quota response." : (error as Error).message,
    };
  }
}
