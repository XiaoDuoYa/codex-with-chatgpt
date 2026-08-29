import { spawn } from "node:child_process";
import type { ProcessRunner } from "./types.js";

export const defaultProcessRunner: ProcessRunner = (cmd, args, opts) => {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "Execution was aborted before starting.",
        timedOut: false,
        error: "ABORTED",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        shell: false,
        env: opts.env ?? process.env,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: (err as Error).message,
        timedOut: false,
        error: (err as Error).message,
      });
      return;
    }

    const terminateChild = () => {
      try {
        child.kill("SIGTERM");
        if (forceKillTimer) clearTimeout(forceKillTimer);
        forceKillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 3000);
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      terminateChild();
    };

    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (opts.stdinData !== undefined && child.stdin) {
      try {
        child.stdin.write(opts.stdinData, "utf8");
        child.stdin.end();
      } catch {
        // stream may already be closed
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };

    child.on("error", (err: Error) => {
      cleanup();
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr || err.message,
        timedOut: false,
        error: err.message,
      });
    });

    child.on("close", (code: number | null) => {
      cleanup();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        error: aborted ? "ABORTED" : undefined,
      });
    });
  });
};
