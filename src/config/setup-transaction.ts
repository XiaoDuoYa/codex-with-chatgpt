export interface RollbackStep {
  label: string;
  run: () => void | Promise<void>;
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
