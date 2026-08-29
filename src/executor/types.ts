export type ExecutorName = "agy" | "codex";

export const SUPPORTED_EXECUTORS: readonly ExecutorName[] = ["agy", "codex"] as const;

export function isSupportedExecutor(name: string): name is ExecutorName {
  return SUPPORTED_EXECUTORS.includes(name as ExecutorName);
}

export interface DetectionResult {
  available: boolean;
  binary: string;
  path?: string;
  version?: string;
  error?: string;
}

export interface ExecutorOptions {
  workspace: string;
  prompt: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ExecutorResult {
  ok: boolean;
  executor: ExecutorName;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  blockedReason?: "PERMISSION_DENIED" | "TIMEOUT" | "ERROR" | "CANCELLED";
}

export type ProcessRunner = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdinData?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }
) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}>;

export interface ExecutorAdapter {
  readonly name: ExecutorName;
  detect(): Promise<DetectionResult>;
  execute(opts: ExecutorOptions, runner?: ProcessRunner): Promise<ExecutorResult>;
}

export interface ExecutorConfig {
  executor: ExecutorName;
}
