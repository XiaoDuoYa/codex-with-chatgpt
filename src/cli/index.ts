import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { inspectRepositoryIdentity } from "../workspace/repository-identity.js";
import { assessPluginPreflight, pluginIntentSchema, pluginPreflightSchema } from "../session/turn-preflight.js";
import {
  AUTOSTART_LABEL,
  autostartStatus,
  buildAutostartConfig,
  disableAutostart,
  enableAutostart,
} from "../config/autostart.js";
import {
  ensureSandboxIsolation,
  restoreCodexConfig,
  snapshotCodexConfig,
} from "../config/sandbox-allow.js";
import {
  restorePrivateFile,
  snapshotPrivateFile,
} from "../config/private-file.js";
import { getProjectDataDir, getStateDir, writeSecureJson } from "../config/paths.js";
import {
  installRuntime,
  restoreRuntimeInstallation,
  runtimeCurrentPath,
  snapshotRuntimeInstallation,
  type RuntimeInstallResult,
} from "../config/runtime-install.js";
import {
  installGlobalSkill,
  restoreGlobalSkill,
  snapshotGlobalSkill,
  statusGlobalSkill,
  type SkillInstallResult,
  type SkillStatusResult,
} from "../config/skill-install.js";
import {
  runRollbackSteps,
  shouldRestorePreviousGateway,
  type RollbackStep,
} from "../config/setup-transaction.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CONTROL_PHASES,
  ControlMailboxError,
  MAX_C2C_ITERATION,
  validateControlId,
  type ControlPhase,
  type ControlResultRequest,
  type ControlResultCorrelation,
} from "../control/result-schema.js";
import { saveExecutionOutput } from "../execution/output.js";
import {
  appendExecutionRecord,
  parseExecutionExitStatus,
  validateExecutionRecordInput,
} from "../execution/records.js";
import {
  adminFetch as machineAdminFetch,
  claimSurface as claimMachineSurface,
  commitSurface as commitMachineSurface,
  acknowledgeMailboxResult,
  cancelMailboxRequest,
  cancelTurn as cancelMachineTurn,
  getMailboxStatus,
  getSurface as getMachineSurface,
  issueTurn as issueMachineTurn,
  openMailboxRequest,
  registerWorkspace as registerMachineWorkspace,
  releaseSurface as releaseMachineSurface,
  renewSurface as renewMachineSurface,
  revokeRequest as revokeMachineRequest,
  retireSurface as retireMachineSurface,
  unregisterWorkspace as unregisterMachineWorkspace,
  waitMailboxResult,
  type MachineRegistrationIdentity,
} from "../gateway/control-client.js";
import { startMachineGatewayServer, TURN_SCOPES } from "../gateway/server.js";
import {
  observeMachineRuntime,
  type MachineRuntimeObservation,
  type MachineRuntimeState,
} from "../gateway/runtime.js";
import { Logger } from "../logger/index.js";
import {
  ensureMachineGateway,
  observeManagedMachine,
  restoreMachineGateway,
  stopMachineGateway,
  withMachineSetupLock,
} from "../process/machine-daemon.js";
import {
  clearChatPointer,
  currentLocalSessionId,
  currentLocalSessionIdentity,
  PROTOCOL_STATES,
  readSession,
  resolveConversation,
  resolveConversationRoute,
  updateSession,
  WAITING_FOR,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import {
  createOpenAiTunnelConfig,
  doctorOpenAiTunnel,
  installOpenAiRuntimeKey,
  installOpenAiTunnelClient,
  OPENAI_CONNECTOR_NAME,
  openAiTunnelConfigFile,
  openAiTunnelRuntimeStatusView,
  openAiTunnelRuntimeKeyPath,
  readOpenAiTunnelConfig,
  statusOpenAiTunnel,
  stopOpenAiTunnel,
  writeOpenAiTunnelConfig,
  type OpenAiTunnelConfig,
} from "../tunnel/openai-secure.js";
import { checkGitUpdate } from "../update/check.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { Workspace } from "../workspace/manager.js";
import { assessPageHealth, PAGE_STATES, pageObservationSchema } from "../session/page-health.js";

const program = new Command();
const DEFAULT_TURN_TTL_MS = 30 * 60_000;
const MAX_TURN_TTL_MS = 60 * 60_000;
const DEFAULT_SURFACE_TTL_MS = 60 * 60_000;
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const check = (message: string): void => say(`✓ ${message}`);
const cross = (message: string): void => say(`✗ ${message}`);

function resolveWorkspace(option?: string): string {
  const cwd = fs.realpathSync.native(process.cwd());
  if (option === undefined) return cwd;

  const requested = fs.realpathSync.native(path.resolve(option));
  if (requested !== cwd) {
    throw new Error(
      "Workspace path must match the current working directory; run this command from the target workspace."
    );
  }
  return cwd;
}

function assertCurrentWorkspaceIdentity(
  workspace: Workspace,
  workspaceId: string,
  projectId: string,
): void {
  if (workspaceId !== workspace.id || projectId !== workspace.projectId) {
    throw new Error(
      "Workspace identity must match the workspace belonging to the current working directory."
    );
  }
}

function resolveLocalSession(option?: string): string {
  return currentLocalSessionId(option);
}

function parseIntegerOption(value: string, label: string, min: number, max: number): number {
  const normalized = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseControlIteration(value: string): number {
  return parseIntegerOption(value, "iteration", 0, MAX_C2C_ITERATION);
}

function parseControlPhase(value: string): ControlPhase {
  const phase = value.trim().toUpperCase();
  if (!CONTROL_PHASES.includes(phase as ControlPhase)) {
    throw new Error(`phase must be one of ${CONTROL_PHASES.join(", ")}`);
  }
  return phase as ControlPhase;
}

function parseMachinePhase(value: string): "BOOT" | ControlPhase {
  const phase = value.trim().toUpperCase();
  return phase === "BOOT" ? phase : parseControlPhase(phase);
}

function parseControlCorrelation(opts: {
  task: string;
  iteration: string;
  phase: string;
}): ControlResultCorrelation {
  return {
    taskId: validateControlId(opts.task, "task id"),
    iteration: parseControlIteration(opts.iteration),
    phase: parseControlPhase(opts.phase),
  };
}

function parseScopes(value?: string): string[] {
  const scopes = (value === undefined ? [...TURN_SCOPES] : value.split(","))
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length === 0) throw new Error("scopes must include at least one scope");
  const allowed = new Set<string>(TURN_SCOPES);
  const unknown = scopes.filter((scope) => !allowed.has(scope));
  if (unknown.length > 0) throw new Error(`unknown scopes: ${unknown.join(", ")}`);
  return [...new Set(scopes)];
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    return parseIntegerOption(normalized, "changed-files count", 0, 1_000_000);
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ControlMailboxError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    return code.startsWith("mailbox_") ? code.toUpperCase() : code;
  }
  return undefined;
}

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) say(JSON.stringify({ ok: false, error: message, code: errorCode(error) }));
  else cross(message);
  process.exitCode = 1;
}

function machineRuntimeView(
  runtime: MachineRuntimeState
): Omit<MachineRuntimeState, "adminToken" | "associationNonce"> {
  const { adminToken: _adminToken, associationNonce: _associationNonce, ...view } = runtime;
  return view;
}

function machineRuntimeObservationView(
  observation: MachineRuntimeObservation
): Record<string, unknown> {
  return {
    ...observation,
    runtime: observation.runtime ? machineRuntimeView(observation.runtime) : null,
  };
}

interface MachineAdminInfo {
  service: string;
  version: string;
  machineId: string;
  bootEpoch: string;
  pid: number;
  port: number;
  startedAt: string;
  workspaceCount: number;
  capabilityCount: number;
  activeTurnCount: number;
  tombstoneCount: number;
  drainingTurnCount: number;
  maxTombstones: number;
}

async function machineInfo(runtime: MachineRuntimeState): Promise<MachineAdminInfo> {
  return machineAdminFetch<MachineAdminInfo>(runtime, "GET", "/admin/info");
}

function tunnelConfigView(config: OpenAiTunnelConfig | null): Record<string, unknown> | null {
  if (!config) return null;
  return {
    tunnelId: config.tunnelId,
    associationId: config.associationId,
    alias: config.alias,
    profileName: config.profileName,
    binaryPath: config.binaryPath,
    runtimeKeyInstalled: fs.existsSync(config.runtimeKeyFile),
  };
}

function skillInstallView(result: SkillInstallResult): Record<string, unknown> {
  return {
    installed: result.installed,
    changed: result.changed,
    path: result.path,
    contentHash: result.contentHash,
  };
}

function skillStatusView(result: SkillStatusResult): Record<string, unknown> {
  return {
    installed: result.installed,
    matches: result.matches,
    path: result.path,
    contentHash: result.contentHash,
    expectedContentHash: result.expectedContentHash,
  };
}

function runtimeInstallView(result: RuntimeInstallResult): Record<string, unknown> {
  return {
    installed: result.installed,
    changed: result.changed,
    path: result.path,
    entryPath: result.entryPath,
    packageVersion: result.packageVersion,
    launcherPath: result.launcherPath,
    launcherChanged: result.launcherChanged,
  };
}

function sessionOwnerEpoch(localSessionId: string): string {
  return `owner-${createHash("sha256").update(localSessionId).digest("hex").slice(0, 32)}`;
}

async function machineSurfaceContext(
  workspace: Workspace,
  localSessionId: string,
): Promise<{
  runtime: MachineRuntimeState;
  identity: {
    workspaceId: string;
    projectId: string;
    registrationId: string;
    localSessionId: string;
  };
}> {
  const runtime = (await ensureMachineGateway()).runtime;
  const registration = await registerMachineWorkspace(runtime, workspace.root);
  if (registration.workspaceId !== workspace.id || registration.projectId !== workspace.projectId) {
    throw new Error("Machine workspace registration does not match the trusted local workspace.");
  }
  return {
    runtime,
    identity: {
      workspaceId: registration.workspaceId,
      projectId: registration.projectId,
      registrationId: registration.registrationId,
      localSessionId,
    },
  };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

// The official tunnel-client owns this process and its stdio transport.
program
  .command("serve-machine", { hidden: true })
  .description("Run the machine-scoped stdio MCP gateway (internal)")
  .requiredOption("--stdio", "serve MCP over stdio")
  .option("--port <port>", "loopback control port", "0")
  .action(async (opts: { stdio: boolean; port: string }) => {
    try {
      if (!opts.stdio) throw new Error("serve-machine requires --stdio");
      const associationId = process.env.C2C_ASSOCIATION_ID;
      const associationNonce = process.env.C2C_ASSOCIATION_NONCE;
      if (!associationId || !/^assoc-[a-f0-9]{32}$/.test(associationId)) {
        throw new Error("serve-machine requires C2C_ASSOCIATION_ID from the managed tunnel runtime");
      }
      if (!associationNonce || !/^[A-Za-z0-9_-]{43}$/.test(associationNonce)) {
        throw new Error("serve-machine requires C2C_ASSOCIATION_NONCE from the managed tunnel runtime");
      }
      const gateway = await startMachineGatewayServer({
        port: parseIntegerOption(opts.port, "port", 0, 65_535),
        connectStdio: true,
        exitOnShutdown: true,
        associationId,
        associationNonce,
        logger: new Logger({ name: "machine-gateway", console: false }),
      });
      const shutdown = (): void => {
        void gateway.close().finally(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

const machine = program
  .command("machine")
  .description("Manage the one machine-wide Connector, tunnel, and MCP gateway");

machine
  .command("setup")
  .description("Install and configure the official OpenAI Secure MCP Tunnel")
  .requiredOption("--tunnel-id <id>", "OpenAI tunnel id")
  .requiredOption("--runtime-key-file <path>", "file containing the tunnel runtime key")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { tunnelId: string; runtimeKeyFile: string; json: boolean }) => {
    try {
      const payload = await withMachineSetupLock(async () => {
        const previousConfig = readOpenAiTunnelConfig();
        const previousConfigFile = snapshotPrivateFile(openAiTunnelConfigFile());
        const previousRuntimeKeyFile = snapshotPrivateFile(openAiTunnelRuntimeKeyPath());
        const previousGateway = await observeMachineRuntime();
        const runtimeHomeDir = path.resolve(process.env.HOME ?? os.homedir());
        const previousRuntime = snapshotRuntimeInstallation({ homeDir: runtimeHomeDir });
        const previousSkill = snapshotGlobalSkill();
        const previousCodexConfig = snapshotCodexConfig();
        let installedRuntime: RuntimeInstallResult | null = null;
        let skill: SkillInstallResult | null = null;
        let draft: OpenAiTunnelConfig | null = null;
        let requiresFreshRuntime = false;
        let oldSupervisorStopped = false;
        let newSupervisorStarted = false;
        let replacementStartAttempted = false;
        try {
          const nextRuntime = installRuntime({ checkoutRoot: repoRoot, homeDir: runtimeHomeDir });
          installedRuntime = nextRuntime;
          const nextSkill = installGlobalSkill({ checkoutRoot: nextRuntime.path });
          skill = nextSkill;
          const binaryPath = await installOpenAiTunnelClient();
          const nextDraft = createOpenAiTunnelConfig({
            tunnelId: opts.tunnelId,
            binaryPath,
            associationId:
              previousConfig?.tunnelId === opts.tunnelId ? previousConfig.associationId : undefined,
            associationNonce:
              previousConfig?.tunnelId === opts.tunnelId ? previousConfig.associationNonce : undefined,
          });
          draft = nextDraft;
          const configChanged =
            previousConfig === null ||
            previousConfig.tunnelId !== nextDraft.tunnelId ||
            previousConfig.runtimeKeyFile !== nextDraft.runtimeKeyFile ||
            previousConfig.binaryPath !== nextDraft.binaryPath ||
            previousConfig.alias !== nextDraft.alias ||
            previousConfig.profileName !== nextDraft.profileName ||
            previousConfig.profileDir !== nextDraft.profileDir;
          requiresFreshRuntime = configChanged || nextRuntime.changed;
          installOpenAiRuntimeKey(path.resolve(opts.runtimeKeyFile), nextDraft.runtimeKeyFile);
          const installedRuntimeKey = fs.readFileSync(nextDraft.runtimeKeyFile);
          const runtimeKeyChanged =
            previousRuntimeKeyFile === null ||
            !previousRuntimeKeyFile.bytes.equals(installedRuntimeKey);
          requiresFreshRuntime ||= runtimeKeyChanged;
          if (requiresFreshRuntime && previousConfig) {
            oldSupervisorStopped = await stopMachineGateway({
              config: previousConfig,
              machineLockHeld: true,
            });
          }
          writeOpenAiTunnelConfig(nextDraft);
          const sandbox = ensureSandboxIsolation();
          replacementStartAttempted = requiresFreshRuntime || previousGateway.state !== "healthy";
          const result = await ensureMachineGateway({
            config: nextDraft,
            requireFreshRuntime: requiresFreshRuntime,
            previousRuntime: previousGateway.state === "healthy" ? previousGateway.runtime : null,
            machineLockHeld: true,
          });
          newSupervisorStarted = result.spawned;
          const info = await machineInfo(result.runtime);
          return {
            ok: true,
            configured: true,
            connector: {
              name: OPENAI_CONNECTOR_NAME,
              authentication: "none",
              tunnelId: nextDraft.tunnelId,
            },
            installation: runtimeInstallView(nextRuntime),
            skill: skillInstallView(nextSkill),
            tunnel: openAiTunnelRuntimeStatusView(result.tunnel),
            runtime: machineRuntimeView(result.runtime),
            info,
            sandbox,
          };
        } catch (error) {
          const replacementMayBeRunning =
            newSupervisorStarted ||
            oldSupervisorStopped ||
            replacementStartAttempted;
          const rollbackSteps: RollbackStep[] = [];
          const replacementConfig = draft;
          if (replacementMayBeRunning && replacementConfig) {
            rollbackSteps.push({
              label: "stop replacement gateway",
              run: () => stopMachineGateway({ config: replacementConfig, machineLockHeld: true }).then(() => undefined),
            });
          }
          rollbackSteps.push(
            {
              label: "restore tunnel config",
              run: () => restorePrivateFile(openAiTunnelConfigFile(), previousConfigFile),
            },
            {
              label: "restore tunnel runtime key",
              run: () => restorePrivateFile(openAiTunnelRuntimeKeyPath(), previousRuntimeKeyFile),
            },
            {
              label: "restore runtime installation",
              run: () => restoreRuntimeInstallation(previousRuntime),
            },
            {
              label: "restore global Skill",
              run: () => restoreGlobalSkill(previousSkill),
            },
            {
              label: "restore Codex config",
              run: () => restoreCodexConfig(previousCodexConfig),
            },
          );
          if (previousConfig && shouldRestorePreviousGateway(previousGateway.state, oldSupervisorStopped)) {
            rollbackSteps.push({
              label: "restore previous gateway",
              run: async () => {
                await restoreMachineGateway({ config: previousConfig, machineLockHeld: true });
              },
            });
          }
          const rollbackErrors = await runRollbackSteps(rollbackSteps);
          if (rollbackErrors.length > 0) {
            const original = error instanceof Error ? error.message : String(error);
            throw new Error(`${original}; machine setup rollback failed: ${rollbackErrors.join("; ")}`);
          }
          throw error;
        }
      });
      if (opts.json) say(JSON.stringify(payload));
      else {
        check("官方 OpenAI Secure MCP Tunnel 已配置");
        check("机器网关已启动");
        say(`Connector：${OPENAI_CONNECTOR_NAME}（Authentication: None）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const skill = program
  .command("skill")
  .description("Install and inspect the one machine-wide C2C Skill");

skill
  .command("install")
  .description("Install or update the Skill in the global Codex skills directory")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    try {
      const installedRuntime = installRuntime({ checkoutRoot: repoRoot });
      const result = installGlobalSkill({ checkoutRoot: installedRuntime.path });
      const payload = { ok: true, ...skillInstallView(result) };
      if (opts.json) say(JSON.stringify(payload));
      else check(result.changed ? "已安装或更新机器级 Skill" : "机器级 Skill 已是最新");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

skill
  .command("status", { isDefault: true })
  .description("Show the one machine-wide C2C Skill status")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    try {
      const result = statusGlobalSkill({ checkoutRoot: runtimeCurrentPath() });
      const payload = { ok: result.matches, ...skillStatusView(result) };
      if (opts.json) {
        say(JSON.stringify(payload));
        if (!result.matches) process.exitCode = 1;
      } else if (result.matches) {
        check("机器级 Skill 已安装且与当前版本一致");
      } else {
        cross(result.installed ? "机器级 Skill 需要更新" : "机器级 Skill 尚未安装");
        process.exitCode = 1;
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

machine
  .command("start")
  .description("Start or reuse the tunnel-owned machine gateway")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const result = await ensureMachineGateway();
      const info = await machineInfo(result.runtime);
      const payload = {
        ok: true,
        started: result.spawned,
        tunnel: openAiTunnelRuntimeStatusView(result.tunnel),
        runtime: machineRuntimeView(result.runtime),
        info,
      };
      if (opts.json) say(JSON.stringify(payload));
      else check(result.spawned ? "机器级安全连接已启动" : "机器级安全连接已在运行");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

machine
  .command("status")
  .description("Inspect the managed tunnel and its exact gateway child")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const observation = await observeManagedMachine();
      const info =
        observation.gateway.state === "healthy"
          ? await machineInfo(observation.gateway.runtime)
          : null;
      const payload = {
        ok: observation.ready,
        configured: observation.config !== null,
        ready: observation.ready,
        config: tunnelConfigView(observation.config),
        tunnel: openAiTunnelRuntimeStatusView(observation.tunnel),
        gateway: {
          ...machineRuntimeObservationView(observation.gateway),
          ...(info ? { info } : {}),
        },
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        if (!observation.ready) process.exitCode = 1;
      } else if (observation.ready && info) {
        check(`机器级安全连接正常（${info.workspaceCount} 个已注册 workspace）`);
      } else {
        cross(observation.config ? "机器级安全连接未就绪" : "机器级安全连接尚未配置");
        process.exitCode = 1;
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

machine
  .command("stop")
  .description("Stop the official tunnel supervisor and its gateway child")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      const stopped = await stopMachineGateway();
      if (opts.json) say(JSON.stringify({ ok: true, stopped }));
      else if (stopped) check("机器级安全连接已停止");
      else say("机器级安全连接未运行。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

machine
  .command("doctor")
  .description("Diagnose and optionally repair the machine-wide connection")
  .option("--no-fix", "diagnose only")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { fix: boolean; json: boolean }) => {
    try {
      const config = readOpenAiTunnelConfig();
      if (!config) {
        const payload = {
          ok: false,
          configured: false,
          setupRequired: true,
          connector: { name: OPENAI_CONNECTOR_NAME, authentication: "none" },
        };
        if (opts.json) say(JSON.stringify(payload));
        else cross("尚未配置 OpenAI Secure MCP Tunnel");
        process.exitCode = 1;
        return;
      }
      let repaired = false;
      let before = await observeManagedMachine({ config });
      if (opts.fix && !before.ready) {
        await ensureMachineGateway({ config });
        repaired = true;
        before = await observeManagedMachine({ config });
      }
      const tunnelDoctor = doctorOpenAiTunnel(config);
      const info =
        before.gateway.state === "healthy"
          ? await machineInfo(before.gateway.runtime)
          : null;
      const ok = before.ready && tunnelDoctor.ok && info !== null;
      const payload = {
        ok,
        configured: true,
        repaired,
        config: tunnelConfigView(config),
        tunnel: openAiTunnelRuntimeStatusView(before.tunnel),
        gateway: {
          ...machineRuntimeObservationView(before.gateway),
          ...(info ? { info } : {}),
        },
        info,
        checks: tunnelDoctor.checks,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        if (!ok) process.exitCode = 1;
      } else if (ok) {
        check(repaired ? "机器级安全连接已修复" : "机器级安全连接健康");
      } else {
        cross("机器级安全连接仍未就绪");
        process.exitCode = 1;
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const machineWorkspace = machine
  .command("workspace")
  .description("Register trusted local workspaces with the running gateway");

machineWorkspace
  .command("register")
  .option("-w, --workspace <path>", "workspace root")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const runtime = (await ensureMachineGateway()).runtime;
      const registration = await registerMachineWorkspace(runtime, resolveWorkspace(opts.workspace));
      if (opts.json) say(JSON.stringify({ ok: true, registration }));
      else check(`Workspace 已注册（${registration.workspaceName}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

machineWorkspace
  .command("unregister")
  .requiredOption("--workspace-id <id>")
  .requiredOption("--project-id <id>")
  .requiredOption("--registration-id <id>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: MachineRegistrationIdentity & { json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace());
      assertCurrentWorkspaceIdentity(workspace, opts.workspaceId, opts.projectId);
      const observation = await observeMachineRuntime();
      if (observation.state !== "healthy") throw new Error("Machine gateway is not running.");
      const result = await unregisterMachineWorkspace(observation.runtime, {
        workspaceId: opts.workspaceId,
        projectId: opts.projectId,
        registrationId: opts.registrationId,
      });
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else if (result.unregistered) check("Workspace 已注销");
      else say("Workspace 注册不存在。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const machineContext = machine
  .command("context")
  .description("Issue or cancel an exact short-lived turn capability");

machineContext
  .command("issue")
  .requiredOption("--workspace-id <id>")
  .requiredOption("--project-id <id>")
  .requiredOption("--registration-id <id>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--phase <phase>", "BOOT, RESEARCH, PLAN, or REVIEW")
  .requiredOption("--generation <n>")
  .option("--request <id>", "exact mailbox request id (required for non-BOOT phases)")
  .option("--compaction-epoch <n>", "compaction epoch", "0")
  .option("--local-session <id>")
  .option("--scopes <scope,...>")
  .option("--model-id <id>")
  .option("--effort <name>")
  .option("--ttl-ms <ms>", "capability lifetime", String(DEFAULT_TURN_TTL_MS))
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspaceId: string;
    projectId: string;
    registrationId: string;
    task: string;
    iteration: string;
    phase: string;
    generation: string;
    request?: string;
    compactionEpoch: string;
    localSession?: string;
    scopes?: string;
    modelId?: string;
    effort?: string;
    ttlMs: string;
    json: boolean;
  }) => {
    try {
      const phase = parseMachinePhase(opts.phase);
      if (phase !== "BOOT" && opts.request === undefined) {
        throw new Error("--request is required for non-BOOT machine context turns");
      }
      const workspace = new Workspace(resolveWorkspace());
      assertCurrentWorkspaceIdentity(workspace, opts.workspaceId, opts.projectId);
      const runtime = (await ensureMachineGateway()).runtime;
      const grant = await issueMachineTurn(runtime, {
        workspaceId: opts.workspaceId,
        projectId: opts.projectId,
        registrationId: opts.registrationId,
        localSessionId: resolveLocalSession(opts.localSession),
        taskId: validateControlId(opts.task, "task id"),
        iteration: parseControlIteration(opts.iteration),
        phase,
        requestId: opts.request
          ? validateControlId(opts.request, "request id")
          : undefined,
        scopes: parseScopes(opts.scopes),
        modelId: opts.modelId,
        effort: opts.effort,
        compactionEpoch: parseIntegerOption(
          opts.compactionEpoch,
          "compaction-epoch",
          0,
          Number.MAX_SAFE_INTEGER
        ),
        generation: parseIntegerOption(opts.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
        ttlMs: parseIntegerOption(opts.ttlMs, "ttl-ms", 1_000, MAX_TURN_TTL_MS),
      });
      if (opts.json) say(JSON.stringify({ ok: true, contextId: grant.token, grant }));
      else say(`CONTEXT_ID: ${grant.token}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

machineContext
  .command("cancel")
  .requiredOption("--context-id <id>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { contextId: string; json: boolean }) => {
    try {
      const observation = await observeMachineRuntime();
      if (observation.state !== "healthy") throw new Error("Machine gateway is not running.");
      const result = await cancelMachineTurn(observation.runtime, opts.contextId);
      if (opts.json) say(JSON.stringify({ ok: true, contextId: opts.contextId, ...result }));
      else check("Context capability 已取消");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- autostart (one machine-wide LaunchAgent)

function autostartCommandView(
  commands: Array<{ command: string; args: string[]; status: number | null }>,
): Array<{ command: string; args: string[]; status: number | null }> {
  return commands.map(({ command, args, status }) => ({ command, args, status }));
}

const autostart = program
  .command("autostart")
  .description("Manage the one machine-wide macOS LaunchAgent");

autostart
  .command("enable")
  .description("Install and load the machine LaunchAgent")
  .option("--interval-seconds <seconds>", "launchd wake interval in seconds", "60")
  .option("--json", "machine-readable output", false)
  .action((opts: { intervalSeconds: string; json: boolean }) => {
    try {
      const config = buildAutostartConfig({ intervalSeconds: opts.intervalSeconds });
      const result = enableAutostart(config);
      const status = autostartStatus(config);
      const payload = {
        ok: true,
        enabled: true,
        loaded: status.loaded,
        label: AUTOSTART_LABEL,
        plistPath: config.plistPath,
        intervalSeconds: config.intervalSeconds,
        programArguments: config.programArguments,
        commands: autostartCommandView(result.commands),
      };
      if (opts.json) say(JSON.stringify(payload));
      else {
        check("机器级 LaunchAgent 已启用");
        say(`· ${config.label}`);
        say(`· 每 ${config.intervalSeconds} 秒唤醒一次`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

autostart
  .command("status", { isDefault: true })
  .description("Show the machine LaunchAgent status")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    try {
      const config = buildAutostartConfig();
      const status = autostartStatus(config);
      const payload = {
        ok: true,
        enabled: status.enabled,
        loaded: status.loaded,
        detail: status.detail,
        label: AUTOSTART_LABEL,
        plistPath: config.plistPath,
        intervalSeconds: config.intervalSeconds,
        programArguments: config.programArguments,
      };
      if (opts.json) say(JSON.stringify(payload));
      else {
        say(`自启：${status.enabled ? "已启用" : "未启用"}`);
        say(`LaunchAgent：${status.loaded === null ? "不支持" : status.loaded ? "已加载" : "未加载"}`);
        say(`Label：${AUTOSTART_LABEL}`);
        if (status.detail) say(`Detail：${status.detail}`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

autostart
  .command("disable")
  .description("Unload and remove the machine LaunchAgent")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    try {
      const config = buildAutostartConfig();
      const result = disableAutostart(config);
      const payload = {
        ok: true,
        enabled: false,
        label: AUTOSTART_LABEL,
        plistPath: config.plistPath,
        commands: autostartCommandView(result.commands),
      };
      if (opts.json) say(JSON.stringify(payload));
      else check("机器级 LaunchAgent 已关闭");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

autostart
  .command("run", { hidden: true })
  .description("Wake the tunnel-owned machine gateway once")
  .option("--quiet", "suppress successful output", false)
  .action(async (opts: { quiet: boolean }) => {
    try {
      const result = await ensureMachineGateway();
      if (!opts.quiet) check(result.spawned ? "机器级安全连接已启动" : "机器级安全连接已在运行");
    } catch (error) {
      if (opts.quiet) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      } else {
        handleCliError(error, false);
      }
    }
  });

program
  .command("workspace")
  .description("Show the trusted local workspace identity")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const project = workspace.detectProject();
      const data = {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        name: workspace.name,
        root: workspace.root,
        ...project,
      };
      if (opts.json) say(JSON.stringify({ ok: true, ...data }));
      else {
        say(`Workspace：${data.name}`);
        say(`路径：${data.root}`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("repository-identity")
  .description("Inspect repository targets, effective gh account and Git author separately (no credentials)")
  .option("-w, --workspace <path>")
  .option("--remote <name>", "explicit intended Git remote; otherwise resolve branch push configuration")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; remote?: string; json: boolean }) => {
    try {
      const root = resolveWorkspace(opts.workspace);
      const identity = inspectRepositoryIdentity(root, opts.remote);
      say(JSON.stringify({ ok: true, ...identity }));
    } catch (error) { handleCliError(error, opts.json); }
  });

const surface = program
  .command("surface")
  .description("Manage the ChatGPT page owned by this local Codex session");

surface
  .command("get", { isDefault: true })
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; localSession?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const machine = await machineSurfaceContext(workspace, localSessionId);
      const { projectUrl, lease, binding, control } = await getMachineSurface(machine.runtime, machine.identity);
      if (opts.json) say(JSON.stringify({ ok: true, localSessionId, projectUrl, lease, binding, control }));
      else if (lease) {
        const route = lease.chatUrl ? `ChatGPT page：${lease.chatUrl}` : "ChatGPT Project candidate page";
        say(`${route}（generation ${lease.generation}）`);
      }
      else if (projectUrl) say(`Project：${projectUrl}`);
      else say("当前本地会话尚未认领 ChatGPT page。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

surface
  .command("check")
  .description("Assess a fresh host browser observation against this session's owned page")
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .requiredOption("--tab-id <id>", "exact observed tab id")
  .requiredOption("--generation <n>", "exact observed generation")
  .requiredOption("--page-state <state>", PAGE_STATES.join(", "))
  .option("--observed-url <url>", "URL observed on that exact page")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string; localSession?: string; tabId: string; generation: string;
    pageState: string; observedUrl?: string; json: boolean;
  }) => {
    try {
      const observation = pageObservationSchema.parse({
        tabId: opts.tabId,
        generation: parseIntegerOption(opts.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
        state: opts.pageState,
        url: opts.observedUrl,
      });
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const machine = await machineSurfaceContext(workspace, localSessionId);
      const current = await getMachineSurface(machine.runtime, machine.identity);
      const page = assessPageHealth(current, observation);
      const control = current.control;
      const controlReady = page.controlReady && control?.status !== "pending" && control?.status !== "received";
      if (opts.json) say(JSON.stringify({ ok: true, localSessionId, ...page, controlReady, control }));
      else say(`${page.action}: ${page.reason}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

surface
  .command("claim")
  .requiredOption("--tab-id <id>", "exact in-app browser tab id")
  .requiredOption("--project-url <url>", "ChatGPT Project collection URL")
  .option("--project-selection <json>", "first-pairing host observation: source, projectUrl, observedTitle, observedAt")
  .option("--chat-url <url>", "existing ChatGPT chat URL inside that Project")
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .option("--replace-generation <n>", "exact current generation to rotate")
  .option("--replace-tab-id <id>", "exact current tab id to rotate")
  .option("--lease-ttl-ms <ms>", "page ownership lease", String(DEFAULT_SURFACE_TTL_MS))
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    tabId: string;
    projectUrl: string;
    projectSelection?: string;
    chatUrl?: string;
    workspace?: string;
    localSession?: string;
    replaceGeneration?: string;
    replaceTabId?: string;
    leaseTtlMs: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const machine = await machineSurfaceContext(workspace, localSessionId);
      const { lease: current, binding: persistent } = await getMachineSurface(machine.runtime, machine.identity);
      let replaces;
      if ((opts.replaceGeneration === undefined) !== (opts.replaceTabId === undefined)) {
        throw new Error("replace-generation and replace-tab-id must be provided together");
      }
      if (opts.replaceGeneration !== undefined && opts.replaceTabId !== undefined) {
        const generation = parseIntegerOption(
          opts.replaceGeneration,
          "replace-generation",
          1,
          Number.MAX_SAFE_INTEGER
        );
        const previous = current ?? persistent;
        const previousGeneration = current?.generation ?? persistent?.lastGeneration;
        if (!previous || previousGeneration !== generation || previous.tabId !== opts.replaceTabId) {
          throw new Error("replacement generation or tab id does not match the current surface binding");
        }
        replaces = current ?? {
          projectId: previous.projectId,
          localSessionId: previous.localSessionId,
          browserId: previous.browserId,
          surfaceId: previous.surfaceId,
          tabId: previous.tabId,
          generation,
          ownerProcessEpoch: sessionOwnerEpoch(localSessionId),
        };
      }
      const { lease } = await claimMachineSurface(machine.runtime, machine.identity, {
        tabId: opts.tabId,
        projectUrl: opts.projectUrl,
        projectSelection: opts.projectSelection === undefined ? undefined : JSON.parse(opts.projectSelection),
        chatUrl: opts.chatUrl,
        ownerProcessEpoch: sessionOwnerEpoch(localSessionId),
        replaces,
        leaseTtlMs: parseIntegerOption(
          opts.leaseTtlMs,
          "lease-ttl-ms",
          1_000,
          24 * 60 * 60_000
        ),
      });
      if (opts.json) say(JSON.stringify({ ok: true, lease }));
      else check(`已临时认领本会话的 ChatGPT page（generation ${lease.generation}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

surface
  .command("commit")
  .description("Persist a page route after workspace verification succeeds")
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .requiredOption("--generation <n>", "exact verified page generation")
  .requiredOption("--tab-id <id>", "exact verified in-app browser tab id")
  .requiredOption("--chat-url <url>", "observed ChatGPT chat URL created inside that Project")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    localSession?: string;
    generation: string;
    tabId: string;
    chatUrl: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const machine = await machineSurfaceContext(workspace, localSessionId);
      const { lease } = await getMachineSurface(machine.runtime, machine.identity);
      if (!lease) throw new Error("This local session has no active ChatGPT page lease.");
      const generation = parseIntegerOption(opts.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
      if (lease.generation !== generation || lease.tabId !== opts.tabId) {
        throw new Error("generation or tab-id does not match the current surface lease");
      }
      const { binding, session: saved } = await commitMachineSurface(machine.runtime, machine.identity, lease, {
        chatUrl: opts.chatUrl,
        connectorName: OPENAI_CONNECTOR_NAME,
      });
      if (opts.json) say(JSON.stringify({ ok: true, binding, session: saved }));
      else check(`已保存验证通过的 ChatGPT page（generation ${binding.lastGeneration}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

surface
  .command("renew")
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .requiredOption("--generation <n>", "exact owned page generation")
  .requiredOption("--tab-id <id>", "exact owned in-app browser tab id")
  .option("--lease-ttl-ms <ms>", "page ownership lease", String(DEFAULT_SURFACE_TTL_MS))
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    localSession?: string;
    generation: string;
    tabId: string;
    leaseTtlMs: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const machine = await machineSurfaceContext(workspace, localSessionId);
      const { lease } = await getMachineSurface(machine.runtime, machine.identity);
      if (!lease) throw new Error("This local session has no active ChatGPT page lease.");
      const generation = parseIntegerOption(opts.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
      if (lease.generation !== generation || lease.tabId !== opts.tabId) {
        throw new Error("generation or tab-id does not match the current surface lease");
      }
      const { lease: renewed } = await renewMachineSurface(machine.runtime, machine.identity, lease, parseIntegerOption(
        opts.leaseTtlMs,
        "lease-ttl-ms",
        1_000,
        24 * 60 * 60_000
      ));
      if (opts.json) say(JSON.stringify({ ok: true, lease: renewed }));
      else check("ChatGPT page ownership 已续期");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

surface
  .command("release")
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .requiredOption("--generation <n>", "exact owned page generation")
  .requiredOption("--tab-id <id>", "exact owned in-app browser tab id")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    localSession?: string;
    generation: string;
    tabId: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const machine = await machineSurfaceContext(workspace, localSessionId);
      const { lease } = await getMachineSurface(machine.runtime, machine.identity);
      const generation = parseIntegerOption(opts.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
      if (lease && (lease.generation !== generation || lease.tabId !== opts.tabId)) {
        throw new Error("generation or tab-id does not match the current surface lease");
      }
      const released = lease
        ? (await releaseMachineSurface(machine.runtime, machine.identity, lease)).released
        : false;
      if (opts.json) say(JSON.stringify({ ok: true, released }));
      else if (released) check("ChatGPT page ownership 已释放");
      else say("当前本地会话没有活动 page lease。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

surface
  .command("retire")
  .description("Permanently retire this local session's ChatGPT page and contexts")
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; localSession?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const machine = await machineSurfaceContext(workspace, localSessionId);
      const result = await retireMachineSurface(machine.runtime, machine.identity);
      if (opts.json) say(JSON.stringify({ ok: true, localSessionId, ...result }));
      else if (result.retired) {
        check(`已退役本地会话的 ChatGPT page，并撤销 ${result.revokedContexts} 个 context`);
      } else {
        say("当前本地会话没有可退役的 ChatGPT page。");
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const session = program
  .command("session")
  .description("Remember one ChatGPT Project chat for this local Codex session");

session
  .command("get", { isDefault: true })
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; localSession?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const sessionIdentity = currentLocalSessionIdentity(opts.localSession);
      const machine = await machineSurfaceContext(workspace, sessionIdentity.id);
      const { lease } = await getMachineSurface(machine.runtime, machine.identity);
      // surface get reconciles any partially-written route before this
      // command reads and reports the session snapshot.
      const saved = readSession(workspace.id, sessionIdentity.id);
      const conversation = resolveConversation(saved);
      const route = resolveConversationRoute(conversation);
      const payload = {
        ok: true,
        connectorName: OPENAI_CONNECTOR_NAME,
        sessionIdentity,
        session: saved,
        conversation,
        route,
        surface: lease,
      };
      if (opts.json) say(JSON.stringify(payload));
      else if (!saved) say("尚未记录本会话的 ChatGPT Project chat。");
      else {
        say(`本地会话：${sessionIdentity.id}`);
        if (saved.projectUrl) say(`Project：${saved.projectUrl}`);
        if (saved.url) say(`Chat：${saved.url}`);
        if (lease) say(`Page：${lease.tabId}（generation ${lease.generation}）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("set")
  .option("-w, --workspace <path>")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>")
  .option("--protocol-state <state>")
  .option("--waiting-for <who>")
  .option("--goal <text>")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--mailbox-request <id>")
  .option("--mailbox-phase <phase>")
  .option("--mailbox-result <id>")
  .option("--clear-mailbox", "drop mailbox checkpoint metadata", false)
  .option("--clear-checkpoint", "drop the active task checkpoint", false)
  .option("--local-session <id>")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    workspace?: string;
    title?: string;
    task?: string;
    iteration?: string;
    state?: string;
    protocolState?: string;
    waitingFor?: string;
    goal?: string;
    completedSubtasks?: string;
    knownIssues?: string;
    nextStep?: string;
    mailboxRequest?: string;
    mailboxPhase?: string;
    mailboxResult?: string;
    clearMailbox: boolean;
    clearCheckpoint: boolean;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waiting =
        waitingRaw?.toLowerCase() === "none" ? "none" : waitingRaw?.toUpperCase();
      if (waiting && !WAITING_FOR.includes(waiting as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      if (opts.clearMailbox && (opts.mailboxRequest || opts.mailboxPhase || opts.mailboxResult)) {
        throw new Error("clear-mailbox cannot be combined with mailbox metadata");
      }
      if ((opts.clearMailbox || opts.mailboxRequest || opts.mailboxPhase || opts.mailboxResult) && !protocolRaw) {
        throw new Error("mailbox checkpoint options require --protocol-state");
      }
      const saved = updateSession(workspace.id, localSessionId, {
        localSessionId,
        title: opts.title,
        taskId: opts.task ? validateControlId(opts.task, "task id") : undefined,
        iteration:
          opts.iteration === undefined ? undefined : parseControlIteration(opts.iteration),
        lastState: opts.state,
        clearCheckpoint: opts.clearCheckpoint,
        clearMailbox: opts.clearMailbox,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: waiting as WaitingFor | undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
              mailboxRequestId: opts.mailboxRequest
                ? validateControlId(opts.mailboxRequest, "mailbox request id")
                : undefined,
              mailboxPhase: opts.mailboxPhase ? parseControlPhase(opts.mailboxPhase) : undefined,
              mailboxResultId: opts.mailboxResult
                ? validateControlId(opts.mailboxResult, "mailbox result id")
                : undefined,
            }
          : undefined,
      });
      if (opts.json) say(JSON.stringify({ ok: true, session: saved }));
      else check("已记录本地会话的 ChatGPT Project chat");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("clear")
  .option("-w, --workspace <path>")
  .option("--local-session <id>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; localSession?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const result = clearChatPointer(workspace.id, resolveLocalSession(opts.localSession));
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else if (result.cleared) check("已清除本会话的 Chat 指针，Project 绑定保留");
      else say("尚未记录 ChatGPT chat。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const control = program
  .command("control")
  .description("Manage exact, correlated ChatGPT result turns");

control
  .command("open")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--phase <phase>")
  .option("--local-session <id>")
  .option("--ttl-ms <ms>", "request and capability lifetime", String(DEFAULT_TURN_TTL_MS))
  .option("--scopes <scope,...>")
  .option("--model-id <id>")
  .option("--effort <name>")
  .option("--plugins <ids>", "comma-separated task-requested ChatGPT plugins")
  .option("--plugin-intent <intent>", "task or identity-discovery (authenticated own-profile only)")
  .option("--plugin-preflight <json>", "fresh host-observed plugin/account evidence for this exact turn")
  .option("--github-remote <name>", "intended repository remote for GitHub-dependent plugins")
  .option("--compaction-epoch <n>", "compaction epoch", "0")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    ttlMs: string;
    scopes?: string;
    modelId?: string;
    effort?: string;
    plugins?: string;
    pluginIntent?: string;
    pluginPreflight?: string;
    githubRemote?: string;
    compactionEpoch: string;
    json: boolean;
  }) => {
    let createdRequest: ControlResultRequest | null = null;
    let machineContext: Awaited<ReturnType<typeof machineSurfaceContext>> | null = null;
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const correlation = parseControlCorrelation(opts);
      const ttlMs = parseIntegerOption(opts.ttlMs, "ttl-ms", 1_000, MAX_TURN_TTL_MS);
      machineContext = await machineSurfaceContext(workspace, localSessionId);
      const machine = machineContext;
      const surface = await getMachineSurface(machine.runtime, machine.identity);
      const page = surface.lease;
      if (!page) throw new Error("Claim this local session's ChatGPT page before opening a control turn.");
      const binding = surface.binding;
      if (
        !binding ||
        binding.lastGeneration !== page.generation ||
        binding.tabId !== page.tabId ||
        binding.projectUrl !== page.projectUrl ||
        binding.chatUrl !== page.chatUrl
      ) {
        throw new Error("Commit this local session's verified ChatGPT page before opening a control turn.");
      }
      const plugins = opts.plugins?.split(",").map((id) => id.trim());
      const pluginIntent = pluginIntentSchema.parse(opts.pluginIntent ?? "task");
      const scopes = pluginIntent === "identity-discovery" && opts.scopes === undefined
        ? ["c2c.result.write"] : parseScopes(opts.scopes);
      const pluginPreflight = opts.pluginPreflight === undefined ? undefined : pluginPreflightSchema.parse(JSON.parse(opts.pluginPreflight));
      if (pluginIntent === "task" && pluginPreflight?.plugins.some((plugin) => plugin.usesGitHub || /github/i.test(plugin.id))) {
        const identity = inspectRepositoryIdentity(workspace.root, opts.githubRemote);
        if (!identity.target || !identity.ghActor || identity.accountStatus !== "matched") throw new Error("Repository owner and effective gh account are not verified; select the intended personal fork or verify organization access before plugin dispatch.");
        if (pluginPreflight.github && (["host", "owner", "name"] as const).some((key) => pluginPreflight.github!.repository[key].toLowerCase() !== identity.target![key].toLowerCase())) {
          throw new Error("GitHub plugin repository does not match the intended local remote.");
        }
        pluginPreflight.github = { repository: identity.target, expectedActor: identity.ghActor };
      }
      const pluginPolicy = assessPluginPreflight({
        workspaceId: workspace.id, localSessionId, ...correlation, generation: page.generation, plugins, pluginIntent, scopes, pluginPreflight,
      }, page, machine.runtime.bootEpoch);
      const opened = await openMailboxRequest(machine.runtime, machine.identity, {
        ...correlation,
        ttlMs,
      });
      if (!opened.created) {
        const payload = {
          ok: false,
          code: "CONTROL_REQUEST_ALREADY_OPEN",
          recoveryRequired: true,
          request: opened.request,
          nextAction: "Inspect this exact request with `c2c control status`, or cancel it before opening a replacement.",
        };
        if (opts.json) say(JSON.stringify(payload));
        else {
          cross(`请求 ${opened.request.requestId} 已存在，不能替换其 CONTEXT_ID`);
          say("请先查询或取消这个精确请求。");
        }
        process.exitCode = 1;
        return;
      }
      createdRequest = opened.request;
      const remainingTtlMs = Math.max(
        1_000,
        Math.min(MAX_TURN_TTL_MS, Date.parse(opened.request.expiresAt) - Date.now())
      );
      const grant = await issueMachineTurn(machine.runtime, {
        workspaceId: machine.identity.workspaceId,
        projectId: machine.identity.projectId,
        registrationId: machine.identity.registrationId,
        localSessionId,
        taskId: correlation.taskId,
        iteration: correlation.iteration,
        phase: correlation.phase,
        requestId: opened.request.requestId,
        scopes,
        modelId: opts.modelId,
        effort: opts.effort,
        plugins,
        pluginIntent,
        pluginPreflight,
        compactionEpoch: parseIntegerOption(
          opts.compactionEpoch,
          "compaction-epoch",
          0,
          Number.MAX_SAFE_INTEGER
        ),
        generation: page.generation,
        ttlMs: remainingTtlMs,
      });
      const payload = {
        ok: true,
        request: opened.request,
        contextId: grant.token,
        contextExpiresAt: grant.expiresAt,
        pluginPolicy,
        surface: {
          tabId: page.tabId,
          chatUrl: page.chatUrl,
          generation: page.generation,
        },
      };
      if (opts.json) say(JSON.stringify(payload));
      else {
        say(`RESULT_REQUEST_ID: ${opened.request.requestId}`);
        say(`CONTEXT_ID: ${grant.token}`);
      }
    } catch (error) {
      if (createdRequest) {
        try {
          if (!machineContext) throw new Error("machine context is unavailable for mailbox cleanup");
          await cancelMailboxRequest(
            machineContext.runtime,
            machineContext.identity,
            {
              requestId: createdRequest.requestId,
              taskId: createdRequest.taskId,
              iteration: createdRequest.iteration,
              phase: createdRequest.phase,
            },
          );
        } catch {
          // Preserve the original setup error.
        }
      }
      handleCliError(error, opts.json);
    }
  });

function addControlLookupOptions(command: Command): Command {
  return command
    .option("-w, --workspace <path>")
    .requiredOption("--request <id>")
    .requiredOption("--task <id>")
    .requiredOption("--iteration <n>")
    .requiredOption("--phase <phase>")
    .option("--local-session <id>")
    .option("--json", "machine-readable output", false);
}

addControlLookupOptions(control.command("status"))
  .action(async (opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const identity = await machineSurfaceContext(workspace, resolveLocalSession(opts.localSession));
      const status = await getMailboxStatus(identity.runtime, identity.identity, {
        requestId: opts.request,
        ...parseControlCorrelation(opts),
      });
      const payload = { ok: status.status !== "not_found", ...status };
      if (opts.json) say(JSON.stringify(payload));
      else say(`状态：${status.status}`);
      if (status.status === "not_found") process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

addControlLookupOptions(
  control
    .command("wait")
    .option("--timeout-ms <ms>", "local wait timeout", "300000")
)
  .action(async (opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    timeoutMs: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const identity = await machineSurfaceContext(workspace, resolveLocalSession(opts.localSession));
      const timeoutMs = parseIntegerOption(opts.timeoutMs, "timeout-ms", 0, 86_400_000);
      const status = await waitMailboxResult(identity.runtime, identity.identity, {
        requestId: opts.request,
        ...parseControlCorrelation(opts),
        timeoutMs,
      });
      const received = status.status === "received" || status.status === "acknowledged";
      if (opts.json) say(JSON.stringify({ ok: received, ...status }));
      else if (status.result) say(JSON.stringify(status.result, null, 2));
      else say(`状态：${status.status}`);
      if (!received) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

addControlLookupOptions(control.command("ack"))
  .action(async (opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const identity = await machineSurfaceContext(workspace, resolveLocalSession(opts.localSession));
      const status = await acknowledgeMailboxResult(identity.runtime, identity.identity, {
        requestId: opts.request,
        ...parseControlCorrelation(opts),
      });
      if (opts.json) say(JSON.stringify({ ok: true, ...status }));
      else check("已确认 control result");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

addControlLookupOptions(control.command("cancel"))
  .action(async (opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const runtimeObservation = await observeMachineRuntime();
      const localSessionId = resolveLocalSession(opts.localSession);
      const correlation = parseControlCorrelation(opts);
      let contextCancelled = false;
      let contextInvalidated = false;
      let machineRuntime: MachineRuntimeState;
      let registration: MachineRegistrationIdentity;
      if (runtimeObservation.state === "healthy") {
        machineRuntime = runtimeObservation.runtime;
        registration = await registerMachineWorkspace(machineRuntime, workspace.root);
        if (registration.workspaceId !== workspace.id || registration.projectId !== workspace.projectId) {
          throw new Error("Machine workspace registration does not match the trusted local workspace.");
        }
        const revoked = await revokeMachineRequest(machineRuntime, {
          workspaceId: registration.workspaceId,
          projectId: registration.projectId,
          localSessionId,
          ...correlation,
          requestId: opts.request,
        });
        contextCancelled = revoked.revoked > 0;
        contextInvalidated = revoked.revoked === 0;
      } else if (runtimeObservation.state === "stopped") {
        const ensured = await ensureMachineGateway();
        machineRuntime = ensured.runtime;
        registration = await registerMachineWorkspace(machineRuntime, workspace.root);
        if (registration.workspaceId !== workspace.id || registration.projectId !== workspace.projectId) {
          throw new Error("Machine workspace registration does not match the trusted local workspace.");
        }
        contextInvalidated = true;
      } else {
        throw new Error("The capability could not be revoked because the gateway state is uncertain.");
      }
      const status = await cancelMailboxRequest(machineRuntime, {
        ...registration,
        localSessionId,
      }, {
        requestId: opts.request,
        ...correlation,
      });
      if (opts.json) {
        say(JSON.stringify({
          ok: true,
          contextCancelled,
          contextInvalidated,
          ...status,
        }));
      } else if (contextCancelled) {
        check("已取消 control result request");
      } else {
        check("已清理已失效的 control result request");
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record one local execution iteration for ChatGPT review")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command")
  .option("--local-session <id>")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    workspace?: string;
    task: string;
    iteration: string;
    changedFiles: string;
    tests?: string;
    exitStatus: string;
    notes?: string;
    command?: string;
    output?: string;
    outputFile?: string;
    exitCode?: string;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const taskId = validateControlId(opts.task, "task id");
      const iteration = parseControlIteration(opts.iteration);
      const changedFiles = parseChangedFiles(opts.changedFiles);
      const base = validateExecutionRecordInput(workspace.id, {
        localSessionId,
        taskId,
        iteration,
        changedFiles,
        tests: opts.tests ?? null,
        exitStatus: parseExecutionExitStatus(opts.exitStatus),
        timestamp: new Date().toISOString(),
        notes: opts.notes,
        outputAvailable: false,
      });
      const rawOutput =
        opts.outputFile === undefined
          ? opts.output
          : readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ);
      if ((opts.command === undefined) !== (rawOutput === undefined)) {
        throw new Error("command and output/output-file must be provided together");
      }
      if (opts.exitCode !== undefined && opts.command === undefined) {
        throw new Error("exit-code requires command and output/output-file");
      }
      let outputId: number | undefined;
      let outputAvailable = false;
      if (opts.command && rawOutput !== undefined) {
        const saved = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode:
            opts.exitCode === undefined
              ? null
              : parseIntegerOption(opts.exitCode, "exit-code", 0, 255),
          localSessionId,
          taskId,
          iteration,
        });
        outputId = saved.id;
        outputAvailable = saved.allowed;
      }
      appendExecutionRecord(workspace.id, { ...base, outputId, outputAvailable });
      if (opts.json) say(JSON.stringify({ ok: true, outputId, outputAvailable }));
      else check("已记录本地执行结果");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("sandbox-clean")
  .description("Remove obsolete global write grants for C2C machine state")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    try {
      const result = ensureSandboxIsolation();
      if (opts.json) say(JSON.stringify({ ok: true, ...result }));
      else if (result.removedRoots > 0) check("已移除旧版 C2C 机器状态写权限");
      else check("C2C 机器状态未向工作区开放写权限");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const prefs = program
  .command("prefs")
  .description("Remember machine-wide ChatGPT setup preferences");

prefs
  .command("get", { isDefault: true })
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const value = readUiPrefs();
    if (opts.json) say(JSON.stringify({ ok: true, ...value }));
    else say(JSON.stringify(value, null, 2));
  });

prefs
  .command("set")
  .option("--developer-mode", "remember that ChatGPT developer mode is enabled", false)
  .option("--setup-mode <mode>", "auto or manual")
  .option("--json", "machine-readable output", false)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const mode = opts.setupMode?.trim().toLowerCase();
      if (mode && !SETUP_MODES.includes(mode as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !mode) throw new Error("nothing to save");
      const value = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: mode as SetupMode | undefined,
      });
      if (opts.json) say(JSON.stringify({ ok: true, ...value }));
      else check("机器级 ChatGPT 配置偏好已保存");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

program
  .command("update-check")
  .description("Check GitHub for a newer C2C revision")
  .option("-w, --workspace <path>")
  .option("--force", "bypass the daily cache", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; force: boolean; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const file = path.join(getProjectDataDir(workspace.projectId), "update-check.json");
      const today = new Date().toLocaleDateString("en-CA");
      let cached: { date?: string; updateAvailable?: boolean } = {};
      try {
        cached = JSON.parse(fs.readFileSync(file, "utf8")) as typeof cached;
      } catch {
        // First check on this machine.
      }
      if (!opts.force && cached.date === today) {
        const payload = {
          ok: true,
          checked: false,
          updateAvailable: cached.updateAvailable ?? false,
          version: VERSION,
        };
        if (opts.json) say(JSON.stringify(payload));
        else say(payload.updateAvailable ? "检测到新版本。" : "今天已检查过更新。");
        return;
      }
      const update = checkGitUpdate(repoRoot);
      if (!update) {
        const payload = { ok: true, checked: false, updateAvailable: false, version: VERSION };
        if (opts.json) say(JSON.stringify(payload));
        else say("当前无法检查更新。");
        return;
      }
      writeSecureJson(file, {
        date: today,
        updateAvailable: update.updateAvailable,
        remoteCommit: update.remoteCommit,
      });
      const payload = { ok: true, checked: true, version: VERSION, ...update };
      if (opts.json) say(JSON.stringify(payload));
      else say(update.updateAvailable ? "检测到新版本。" : "已是最新版本。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
