import path from "node:path";
import { ensureDir, getStateDir, withFileLockAsync } from "../config/paths.js";
import { runtimeEntryPath } from "../config/runtime-install.js";
import {
  clearMachineRuntime,
  observeMachineRuntime,
  readMachineRuntime,
  type MachineRuntimeObservation,
  type MachineRuntimeState,
} from "../gateway/runtime.js";
import {
  connectOpenAiTunnel,
  openAiTunnelIdentityMatchesConfig,
  openAiTunnelStatusMatchesConfig,
  readOpenAiTunnelConfig,
  statusOpenAiTunnel,
  stopOpenAiTunnel,
  type OpenAiTunnelConfig,
  type OpenAiTunnelDependencies,
  type OpenAiTunnelRuntimeStatus,
  type OpenAiTunnelStopResult,
} from "../tunnel/openai-secure.js";

const MACHINE_START_LOCK_TIMEOUT_MS = 25_000;
const MACHINE_START_LOCK_STALE_MS = 3 * 60_000;
const MACHINE_SETUP_LOCK_TIMEOUT_MS = 5 * 60_000;
const MACHINE_SETUP_LOCK_STALE_MS = 10 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MACHINE_OPERATION_LOCK_FILE = "machine-gateway.lock";

export interface ManagedTunnelFunctions {
  connect: (
    config: OpenAiTunnelConfig,
    mcpCommand: string,
    dependencies?: OpenAiTunnelDependencies
  ) => OpenAiTunnelRuntimeStatus;
  status: (
    config: OpenAiTunnelConfig,
    dependencies?: OpenAiTunnelDependencies
  ) => OpenAiTunnelRuntimeStatus;
  stop: (
    config: OpenAiTunnelConfig,
    dependencies?: OpenAiTunnelDependencies
  ) => OpenAiTunnelStopResult;
}

export interface EnsureMachineGatewayOptions {
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  config?: OpenAiTunnelConfig;
  tunnelDependencies?: OpenAiTunnelDependencies;
  tunnelFunctions?: Partial<ManagedTunnelFunctions>;
  /** Require connect() to produce a gateway with a new ownership epoch. */
  requireFreshRuntime?: boolean;
  previousRuntime?: MachineRuntimeState | null;
  /** Internal setup path: the caller already owns the machine operation lock. */
  machineLockHeld?: boolean;
}

export interface EnsureMachineGatewayResult {
  runtime: MachineRuntimeState;
  spawned: boolean;
  tunnel: OpenAiTunnelRuntimeStatus;
}

export interface StopMachineGatewayOptions {
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  config?: OpenAiTunnelConfig;
  tunnelDependencies?: OpenAiTunnelDependencies;
  tunnelFunctions?: Partial<ManagedTunnelFunctions>;
  /** Internal setup path: the caller already owns the machine operation lock. */
  machineLockHeld?: boolean;
}

export interface ManagedMachineObservation {
  config: OpenAiTunnelConfig | null;
  tunnel: OpenAiTunnelRuntimeStatus | null;
  gateway: MachineRuntimeObservation;
  ready: boolean;
}

/** One startup lock for the whole machine, independent of any workspace. */
export function withMachineStartLock<T>(action: () => Promise<T>): Promise<T> {
  const lockFile = path.join(ensureDir(path.join(getStateDir(), "locks")), MACHINE_OPERATION_LOCK_FILE);
  return withFileLockAsync(lockFile, action, {
    timeoutMs: MACHINE_START_LOCK_TIMEOUT_MS,
    staleMs: MACHINE_START_LOCK_STALE_MS,
  });
}

/** Serialize the complete machine setup transaction, including tunnel replacement. */
export function withMachineSetupLock<T>(action: () => Promise<T>): Promise<T> {
  const lockFile = path.join(ensureDir(path.join(getStateDir(), "locks")), MACHINE_OPERATION_LOCK_FILE);
  return withFileLockAsync(lockFile, action, {
    timeoutMs: MACHINE_SETUP_LOCK_TIMEOUT_MS,
    staleMs: MACHINE_SETUP_LOCK_STALE_MS,
  });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function requireConfig(config?: OpenAiTunnelConfig): OpenAiTunnelConfig {
  const resolved = config ?? readOpenAiTunnelConfig();
  if (!resolved) {
    throw new Error(
      "OpenAI Secure MCP Tunnel is not configured. Run `c2c machine setup --tunnel-id ... --runtime-key-file ...` first."
    );
  }
  return resolved;
}

function tunnelFunctions(overrides: Partial<ManagedTunnelFunctions> = {}): ManagedTunnelFunctions {
  return {
    connect: overrides.connect ?? connectOpenAiTunnel,
    status: overrides.status ?? statusOpenAiTunnel,
    stop: overrides.stop ?? stopOpenAiTunnel,
  };
}

function quoteCommandArgument(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) throw new Error("machine MCP command argument is invalid");
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Exact stdio command supervised by the official tunnel runtime. */
export function machineMcpCommand(config: OpenAiTunnelConfig): string {
  // The tunnel config is persisted under this state root. Do not resolve the
  // runtime through the caller's ambient C2C_STATE_DIR: setup may be invoked
  // by a process whose environment differs from the machine service.
  const stateRoot = path.dirname(path.dirname(path.resolve(config.profileDir)));
  return [
    process.execPath,
    runtimeEntryPath(stateRoot),
    "serve-machine",
    "--stdio",
    "--port",
    "0",
  ]
    .map(quoteCommandArgument)
    .join(" ");
}

function sameRuntimeIdentity(left: MachineRuntimeState, right: MachineRuntimeState): boolean {
  return left.machineId === right.machineId && left.bootEpoch === right.bootEpoch && left.pid === right.pid;
}

function clearRuntimeIfMatches(expected: MachineRuntimeState): void {
  try {
    const current = readMachineRuntime();
    if (current && sameRuntimeIdentity(current, expected)) clearMachineRuntime();
  } catch {
    // An unreadable or replaced runtime is never removed by this process.
  }
}

function uncertain(observation: Extract<MachineRuntimeObservation, { state: "unknown" }>): Error {
  return new Error(`Machine gateway state is uncertain (${observation.reason}); refusing to start another gateway.`);
}

function assertManagedPair(
  config: OpenAiTunnelConfig,
  tunnel: OpenAiTunnelRuntimeStatus,
  gateway: MachineRuntimeObservation
): MachineRuntimeState | null {
  if (tunnel.ok && gateway.state === "healthy") {
    if (
      gateway.runtime.associationId !== config.associationId ||
      gateway.runtime.associationNonce !== config.associationNonce
    ) {
      throw new Error(
        "The machine gateway is healthy, but it is not the exact child of the configured OpenAI tunnel runtime."
      );
    }
    if (!openAiTunnelStatusMatchesConfig(config, tunnel, machineMcpCommand(config), gateway.runtime.pid)) {
      throw new Error(
        "The OpenAI tunnel runtime is healthy, but its tunnel, profile, or stdio command does not match the configured machine gateway."
      );
    }
    return gateway.runtime;
  }
  if (gateway.state === "healthy" && !tunnel.ok) {
    throw new Error(
      "A machine gateway is running outside the configured OpenAI tunnel runtime; refusing to create a split broker."
    );
  }
  if (gateway.state === "unknown") throw uncertain(gateway);
  return null;
}

function assertManagedIdentity(
  config: OpenAiTunnelConfig,
  tunnel: OpenAiTunnelRuntimeStatus,
  gateway: MachineRuntimeObservation,
): void {
  const runtime = gateway.runtime;
  if (tunnel.processRunning && !runtime) {
    throw new Error(
      "The configured OpenAI tunnel alias is running, but the machine gateway ownership record is missing; refusing to stop it."
    );
  }
  const expectedPid = runtime?.pid;
  if (runtime && (
    runtime.associationId !== config.associationId ||
    runtime.associationNonce !== config.associationNonce
  )) {
    throw new Error(
      "The machine gateway is not the exact child of the configured OpenAI tunnel runtime."
    );
  }
  if (!openAiTunnelIdentityMatchesConfig(config, tunnel, machineMcpCommand(config), expectedPid)) {
    throw new Error(
      "The OpenAI tunnel runtime is not the exact configured machine gateway; refusing to stop it."
    );
  }
}

/**
 * A tunnel alias is mutable, so an already-running process must be proven to
 * be ours before connect() is allowed to operate on it. A missing gateway
 * record cannot prove the association that the tunnel-owned child inherited;
 * reject that case instead of replacing an unknown process by alias.
 */
function assertExistingTunnelIdentity(
  config: OpenAiTunnelConfig,
  tunnel: OpenAiTunnelRuntimeStatus,
  gateway: MachineRuntimeObservation,
): void {
  if (!tunnel.processRunning) return;
  if (!gateway.runtime) {
    throw new Error(
      "The configured OpenAI tunnel alias is already running, but its machine gateway ownership record is missing; refusing to replace it."
    );
  }
  if (
    gateway.runtime.associationId !== config.associationId ||
    gateway.runtime.associationNonce !== config.associationNonce
  ) {
    throw new Error(
      "The configured OpenAI tunnel alias is already running, but its machine gateway association does not match; refusing to replace it."
    );
  }
  const expectedPid = gateway.runtime.pid;
  if (!openAiTunnelIdentityMatchesConfig(config, tunnel, machineMcpCommand(config), expectedPid)) {
    throw new Error(
      "The configured OpenAI tunnel alias is already running, but its tunnel, profile, stdio command, or process identity does not match; refusing to replace it."
    );
  }
}

function gatewayAssociationMatchesConfig(
  config: OpenAiTunnelConfig,
  gateway: MachineRuntimeObservation,
): boolean {
  return gateway.runtime !== null &&
    gateway.runtime.associationId === config.associationId &&
    gateway.runtime.associationNonce === config.associationNonce;
}

export async function observeManagedMachine(
  options: Pick<EnsureMachineGatewayOptions, "config" | "tunnelDependencies" | "tunnelFunctions"> = {}
): Promise<ManagedMachineObservation> {
  const config = options.config ?? readOpenAiTunnelConfig();
  const gateway = await observeMachineRuntime();
  if (!config) return { config: null, tunnel: null, gateway, ready: false };
  const tunnel = tunnelFunctions(options.tunnelFunctions).status(config, options.tunnelDependencies);
  const ready = (() => {
    try {
      return assertManagedPair(config, tunnel, gateway) !== null;
    } catch {
      return false;
    }
  })();
  return { config, tunnel, gateway, ready };
}

/** Observe the restored configuration before starting anything in rollback. */
export async function restoreMachineGateway(
  options: EnsureMachineGatewayOptions = {},
): Promise<EnsureMachineGatewayResult> {
  const observation = await observeManagedMachine(options);
  if (observation.ready && observation.gateway.state === "healthy" && observation.tunnel) {
    return {
      runtime: observation.gateway.runtime,
      spawned: false,
      tunnel: observation.tunnel,
    };
  }
  return ensureMachineGateway(options);
}

/**
 * Reuse the tunnel-owned stdio gateway or ask tunnel-client to start it. This
 * function never spawns a standalone gateway process.
 */
export async function ensureMachineGateway(
  options: EnsureMachineGatewayOptions = {}
): Promise<EnsureMachineGatewayResult> {
  const config = requireConfig(options.config);
  const functions = tunnelFunctions(options.tunnelFunctions);
  const requireFreshRuntime = options.requireFreshRuntime === true;
  const startTimeoutMs = positiveInteger(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS, "machine start timeout");
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "machine poll interval");
  const initialTunnel = functions.status(config, options.tunnelDependencies);
  const initialGateway = await observeMachineRuntime();
  if (!requireFreshRuntime) {
    const existing = assertManagedPair(config, initialTunnel, initialGateway);
    if (existing) return { runtime: existing, spawned: false, tunnel: initialTunnel };
  }

  const start = async (): Promise<EnsureMachineGatewayResult> => {
    const currentTunnel = functions.status(config, options.tunnelDependencies);
    const currentGateway = await observeMachineRuntime();
    assertExistingTunnelIdentity(config, currentTunnel, currentGateway);
    if (requireFreshRuntime) {
      if (currentGateway.state === "healthy") {
        throw new Error("A gateway is already healthy; refusing to reuse it while replacing the tunnel.");
      }
      if (currentGateway.state === "unknown" && currentGateway.reason !== "probe_failed") {
        throw uncertain(currentGateway);
      }
    } else {
      const current = assertManagedPair(config, currentTunnel, currentGateway);
      if (current) return { runtime: current, spawned: false, tunnel: currentTunnel };
    }
    if (currentGateway.state === "stopped" && currentGateway.runtime) {
      if (gatewayAssociationMatchesConfig(config, currentGateway)) {
        clearRuntimeIfMatches(currentGateway.runtime);
      }
    }

    let connected: OpenAiTunnelRuntimeStatus | null = null;
    const tunnelWasRunning = currentTunnel.processRunning;
    let connectAttempted = false;
    try {
      connectAttempted = true;
      connected = functions.connect(
        config,
      machineMcpCommand(config),
        options.tunnelDependencies
      );
      const deadline = Date.now() + startTimeoutMs;
      for (;;) {
        const gateway = await observeMachineRuntime();
        if (gateway.state === "healthy") {
          const tunnel = functions.status(config, options.tunnelDependencies);
        const runtime = assertManagedPair(config, tunnel, gateway);
          if (runtime) {
            const previous = options.previousRuntime;
            if (requireFreshRuntime && previous && sameRuntimeIdentity(runtime, previous)) {
              throw new Error("OpenAI tunnel connected, but the machine gateway ownership epoch did not change.");
            }
            return { runtime, spawned: true, tunnel };
          }
        } else if (gateway.state === "unknown" && gateway.reason !== "probe_failed") {
          throw uncertain(gateway);
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      throw new Error(
        `OpenAI tunnel reported ready but its machine gateway did not become healthy within ${startTimeoutMs}ms (${connected.detail}).`
      );
    } catch (error) {
      let cleanupError: unknown;
      try {
        if (!connectAttempted || tunnelWasRunning) {
          throw new Error("startup cleanup skipped because this call did not establish a new tunnel runtime");
        }
        const cleanupTunnel = functions.status(config, options.tunnelDependencies);
        if (
          !cleanupTunnel.processRunning ||
          !openAiTunnelIdentityMatchesConfig(config, cleanupTunnel, machineMcpCommand(config))
        ) {
          throw new Error("startup cleanup skipped because the tunnel runtime was not observed as a new exact match");
        }
        const cleanupGatewayBefore = await observeMachineRuntime();
        if (
          cleanupGatewayBefore.runtime &&
          !gatewayAssociationMatchesConfig(config, cleanupGatewayBefore)
        ) {
          throw new Error("startup cleanup skipped because the machine gateway association is not an exact match");
        }
        functions.stop(config, options.tunnelDependencies);
        const cleanupDeadline = Date.now() + Math.min(DEFAULT_STOP_TIMEOUT_MS, startTimeoutMs);
        for (;;) {
          const gateway = await observeMachineRuntime();
          if (gateway.state === "stopped") {
            if (gateway.runtime && gatewayAssociationMatchesConfig(config, gateway)) {
              clearRuntimeIfMatches(gateway.runtime);
            }
            break;
          }
          if (Date.now() >= cleanupDeadline) {
            throw new Error("the partially started machine gateway did not stop before the cleanup deadline");
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError) {
        const original = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${original}; startup cleanup failed: ${cleanup}`, { cause: error });
      }
      throw error;
    }
  };
  return options.machineLockHeld ? start() : withMachineStartLock(start);
}

/** Stop the supervisor first; never ask its child to shut down and be restarted. */
export async function stopMachineGateway(options: StopMachineGatewayOptions = {}): Promise<boolean> {
  const stop = async (): Promise<boolean> => {
    const config = options.config ?? readOpenAiTunnelConfig();
    if (!config) {
      const gateway = await observeMachineRuntime();
      if (gateway.state === "stopped" && gateway.runtime) clearRuntimeIfMatches(gateway.runtime);
      if (gateway.state === "healthy" || gateway.state === "unknown") {
        throw new Error("Machine gateway exists without OpenAI tunnel ownership; refusing an unauthenticated shutdown.");
      }
      return false;
    }
    const functions = tunnelFunctions(options.tunnelFunctions);
    const before = functions.status(config, options.tunnelDependencies);
    const gatewayBefore = await observeMachineRuntime();
    if (gatewayBefore.state === "unknown" && gatewayBefore.reason !== "probe_failed") {
      throw uncertain(gatewayBefore);
    }
    if (!before.processRunning && gatewayBefore.state === "stopped") {
      if (
        gatewayBefore.runtime &&
        gatewayBefore.runtime.associationId === config.associationId &&
        gatewayBefore.runtime.associationNonce === config.associationNonce
      ) {
        clearRuntimeIfMatches(gatewayBefore.runtime);
      }
      return false;
    }
    if (!before.processRunning) {
      throw new Error("The configured OpenAI tunnel is not running; refusing to stop a live gateway outside its supervisor.");
    }
    assertManagedIdentity(config, before, gatewayBefore);
    functions.stop(config, options.tunnelDependencies);
    const stopTimeoutMs = positiveInteger(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "machine stop timeout");
    const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "machine poll interval");
    const deadline = Date.now() + stopTimeoutMs;
    for (;;) {
      const gateway = await observeMachineRuntime();
      if (gateway.state === "stopped") {
        if (gateway.runtime) clearRuntimeIfMatches(gateway.runtime);
        return before.processRunning || gatewayBefore.state !== "stopped";
      }
      if (gateway.state === "unknown" && gateway.reason !== "probe_failed") throw uncertain(gateway);
      if (Date.now() >= deadline) {
        throw new Error("OpenAI tunnel stopped, but its machine gateway did not exit before the shutdown deadline.");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };
  return options.machineLockHeld ? stop() : withMachineStartLock(stop);
}
