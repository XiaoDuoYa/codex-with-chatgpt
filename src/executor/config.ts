import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { isSupportedExecutor, SUPPORTED_EXECUTORS, type ExecutorConfig, type ExecutorName } from "./types.js";

export const DEFAULT_EXECUTOR: ExecutorName = "agy";

export function getExecutorConfigFile(): string {
  return path.join(getStateDir(), "executor.json");
}

export function getStoredExecutor(): ExecutorName | null {
  const file = getExecutorConfigFile();
  const data = readJsonIfExists<ExecutorConfig>(file);
  if (data && typeof data.executor === "string" && isSupportedExecutor(data.executor)) {
    return data.executor;
  }
  return null;
}

export function setStoredExecutor(name: string): ExecutorName {
  if (!isSupportedExecutor(name)) {
    throw new Error(
      `Invalid executor: "${name}". Supported executors are: ${SUPPORTED_EXECUTORS.join(", ")}`
    );
  }
  const file = getExecutorConfigFile();
  writeSecureJson(file, { executor: name } satisfies ExecutorConfig);
  return name;
}

export function resolveExecutorName(override?: string): ExecutorName {
  if (override !== undefined && override !== null && override !== "") {
    if (!isSupportedExecutor(override)) {
      throw new Error(
        `Invalid executor override: "${override}". Supported executors are: ${SUPPORTED_EXECUTORS.join(", ")}`
      );
    }
    return override;
  }
  return getStoredExecutor() ?? DEFAULT_EXECUTOR;
}
