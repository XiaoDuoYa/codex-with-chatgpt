import { detectBinary } from "./detect.js";
import { defaultProcessRunner } from "./runner.js";
import type { DetectionResult, ExecutorAdapter, ExecutorOptions, ExecutorResult, ProcessRunner } from "./types.js";

export class CodexExecutor implements ExecutorAdapter {
  readonly name = "codex" as const;

  async detect(): Promise<DetectionResult> {
    return detectBinary("codex");
  }

  async execute(opts: ExecutorOptions, runner: ProcessRunner = defaultProcessRunner): Promise<ExecutorResult> {
    const startTime = Date.now();
    // Use codex exec - to stream the prompt via stdin
    const args = ["exec", "-"];

    const execRes = await runner("codex", args, {
      cwd: opts.workspace,
      stdinData: opts.prompt,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });

    const durationMs = Date.now() - startTime;

    if (execRes.error === "ABORTED" || opts.signal?.aborted) {
      return {
        ok: false,
        executor: "codex",
        exitCode: execRes.exitCode,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        durationMs,
        error: "Execution cancelled by caller",
        blockedReason: "CANCELLED",
      };
    }

    if (execRes.timedOut) {
      return {
        ok: false,
        executor: "codex",
        exitCode: execRes.exitCode,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        durationMs,
        error: `Execution timed out after ${opts.timeoutMs ?? 600000}ms`,
        blockedReason: "TIMEOUT",
      };
    }

    if (execRes.error && execRes.exitCode === null) {
      return {
        ok: false,
        executor: "codex",
        exitCode: null,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        durationMs,
        error: execRes.error,
        blockedReason: "ERROR",
      };
    }

    const isSuccess = execRes.exitCode === 0;

    return {
      ok: isSuccess,
      executor: "codex",
      exitCode: execRes.exitCode,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      durationMs,
      error: isSuccess ? undefined : `Process exited with code ${execRes.exitCode}`,
      blockedReason: isSuccess ? undefined : "ERROR",
    };
  }
}
