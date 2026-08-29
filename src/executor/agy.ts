import { detectBinary } from "./detect.js";
import { defaultProcessRunner } from "./runner.js";
import type { DetectionResult, ExecutorAdapter, ExecutorOptions, ExecutorResult, ProcessRunner } from "./types.js";

export interface AgyParseResult {
  ok: boolean;
  status?: string;
  error?: string;
  blockedReason?: "PERMISSION_DENIED" | "TIMEOUT" | "ERROR";
  agentResponseText?: string;
}

const PERMISSION_ERROR_PATTERNS = [
  /permission(?:_|\s+)denied/i,
  /permission\s+blocked/i,
  /approval\s+required/i,
  /requires\s+approval/i,
  /tool(?:s)?\s+(?:were\s+|was\s+)?denied/i,
  /auto-approve\s+failed/i,
  /action\s+rejected/i,
];

/**
 * Parses NDJSON output produced by `agy --output-format stream-json`.
 * Follows the official nested AGY event schema:
 * - { "event": "init", "init": { ... } }
 * - { "event": "step_update", "step_update": { "state": "DONE", "step_type": "tool", "tool_info": { "error": { "message": "..." } } } }
 * - { "event": "result", "result": { "status": "SUCCESS" | "ERROR" | ..., "response": "...", "error": "..." } }
 */
export function parseAgyStreamJson(stdout: string, stderr: string, exitCode: number | null): AgyParseResult {
  let terminalStatus: string | null = null;
  let terminalError: string | undefined;
  let responseText = "";
  let hasPermissionBlock = false;
  let foundTerminalResult = false;

  const lines = stdout.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (!event || typeof event !== "object") continue;

      // 1. Official terminal result event: { "event": "result", "result": { "status": "...", "response": "...", "error": "..." } }
      if (event.event === "result" && event.result && typeof event.result === "object") {
        foundTerminalResult = true;
        terminalStatus = event.result.status || null;
        if (event.result.error) {
          terminalError = String(event.result.error);
        }
        if (event.result.response && typeof event.result.response === "string") {
          responseText = event.result.response;
        }
      }

      // 2. Official step update event: { "event": "step_update", "step_update": { "step_type": "tool", "tool_info": { "error": ... } } }
      if (event.event === "step_update" && event.step_update && typeof event.step_update === "object") {
        const step = event.step_update;
        if (step.step_type === "tool" && step.tool_info) {
          const toolError = step.tool_info.error;
          if (toolError) {
            const errStr = typeof toolError === "string" ? toolError : `${toolError.type || ""} ${toolError.message || ""}`;
            if (PERMISSION_ERROR_PATTERNS.some((p) => p.test(errStr))) {
              hasPermissionBlock = true;
            }
          }
        }
      }
    } catch {
      // not a JSON line
    }
  }

  // 3. Stderr CLI diagnostic / notice check for permission denial in headless runs
  const STDERR_PERMISSION_PATTERNS = [
    /permission(?:_|\s+)denied/i,
    /permission\s+blocked/i,
    /approval\s+required/i,
    /requires\s+approval/i,
    /needs?\s+approval/i,
    /soft-denied/i,
    /tool(?:s)?\s+(?:were\s+|was\s+)?denied/i,
    /auto-approve\s+failed/i,
    /permissions\.allow/i,
    /allow[- ]rule/i,
    /action\s+rejected/i,
  ];
  for (const pattern of STDERR_PERMISSION_PATTERNS) {
    if (pattern.test(stderr)) {
      hasPermissionBlock = true;
      break;
    }
  }

  // If any tool was blocked due to missing permissions
  if (hasPermissionBlock || terminalStatus === "PERMISSION_DENIED" || terminalStatus === "BLOCKED") {
    return {
      ok: false,
      status: terminalStatus || "BLOCKED",
      blockedReason: "PERMISSION_DENIED",
      error:
        terminalError ||
        "AGENT_PERMISSION_BLOCKED: Tool execution or shell commands were blocked by permission policy.",
      agentResponseText: responseText.trim() || undefined,
    };
  }

  // If stream-json protocol truncated without a terminal result event, treat as protocol failure
  if (!foundTerminalResult) {
    return {
      ok: false,
      status: "PROTOCOL_ERROR",
      blockedReason: "ERROR",
      error: "AGY_PROTOCOL_ERROR: Stream ended without a terminal result event.",
      agentResponseText: responseText.trim() || undefined,
    };
  }

  if (terminalStatus === "SUCCESS") {
    return {
      ok: true,
      status: "SUCCESS",
      agentResponseText: responseText.trim() || undefined,
    };
  }

  // Non-success terminal status (ERROR, CANCELED, INTERRUPTED, etc.)
  return {
    ok: false,
    status: terminalStatus || "ERROR",
    blockedReason: "ERROR",
    error: terminalError || `Agent completed with status: ${terminalStatus || "ERROR"}`,
    agentResponseText: responseText.trim() || undefined,
  };
}

export class AgyExecutor implements ExecutorAdapter {
  readonly name = "agy" as const;

  async detect(): Promise<DetectionResult> {
    return detectBinary("agy");
  }

  async execute(opts: ExecutorOptions, runner: ProcessRunner = defaultProcessRunner): Promise<ExecutorResult> {
    const startTime = Date.now();
    // Official programmatic stream-json invocation
    const args = ["--mode=accept-edits", "--input-format", "stream-json", "--output-format", "stream-json"];
    const stdinPayload = JSON.stringify({
      event: "user",
      message: {
        content: opts.prompt,
      },
    }) + "\n";

    const execRes = await runner("agy", args, {
      cwd: opts.workspace,
      stdinData: stdinPayload,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });

    const durationMs = Date.now() - startTime;

    if (execRes.error === "ABORTED" || opts.signal?.aborted) {
      return {
        ok: false,
        executor: "agy",
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
        executor: "agy",
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
        executor: "agy",
        exitCode: null,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        durationMs,
        error: execRes.error,
        blockedReason: "ERROR",
      };
    }

    const parsed = parseAgyStreamJson(execRes.stdout, execRes.stderr, execRes.exitCode);

    return {
      ok: parsed.ok,
      executor: "agy",
      exitCode: execRes.exitCode,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      durationMs,
      error: parsed.error,
      blockedReason: parsed.blockedReason,
    };
  }
}
