export interface RollbackStep {
  label: string;
  run: () => void | Promise<void>;
}

export interface MachineSetupOptions {
  tunnelId?: string;
  runtimeKeyFile?: string;
  reuseExisting: boolean;
}

export interface ExistingMachineSetup {
  tunnelId: string;
}

export interface ResolvedMachineSetupOptions {
  tunnelId: string;
  runtimeKeySourceFile: string | null;
  reuseExisting: boolean;
}

/** Require either complete first-time credentials or an explicit existing-install reuse. */
export function resolveMachineSetupOptions(
  options: MachineSetupOptions,
  existing: ExistingMachineSetup | null,
): ResolvedMachineSetupOptions {
  const hasTunnelId = Boolean(options.tunnelId?.trim());
  const hasRuntimeKeyFile = Boolean(options.runtimeKeyFile?.trim());

  if (options.reuseExisting) {
    if (hasTunnelId || hasRuntimeKeyFile) {
      throw new Error("--reuse-existing cannot be combined with --tunnel-id or --runtime-key-file");
    }
    if (!existing) {
      throw new Error(
        "No existing OpenAI Secure MCP Tunnel configuration is available; provide both --tunnel-id and --runtime-key-file",
      );
    }
    return {
      tunnelId: existing.tunnelId,
      runtimeKeySourceFile: null,
      reuseExisting: true,
    };
  }

  if (!hasTunnelId || !hasRuntimeKeyFile) {
    throw new Error(
      "Provide both --tunnel-id and --runtime-key-file for first-time setup, or use --reuse-existing",
    );
  }
  return {
    tunnelId: options.tunnelId!,
    runtimeKeySourceFile: options.runtimeKeyFile!,
    reuseExisting: false,
  };
}

/** Restore a previous Gateway only when setup observed it running and stopped it. */
export function shouldRestorePreviousGateway(
  previousGatewayState: "healthy" | "stopped" | "unknown",
  supervisorStopped: boolean,
): boolean {
  return previousGatewayState === "healthy" && supervisorStopped;
}

/** Run every rollback step and retain all failures in execution order. */
export async function runRollbackSteps(steps: readonly RollbackStep[]): Promise<string[]> {
  const errors: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${step.label}: ${detail}`);
    }
  }
  return errors;
}
