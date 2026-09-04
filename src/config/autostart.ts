import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "./paths.js";
import { Workspace } from "../workspace/manager.js";

export const AUTOSTART_LABEL_PREFIX = "dev.codex-with-chatgpt";
export const DEFAULT_AUTOSTART_INTERVAL_SECONDS = 60;
const MIN_AUTOSTART_INTERVAL_SECONDS = 30;
const MAX_AUTOSTART_INTERVAL_SECONDS = 86_400;

const C2C_AUTOSTART_ENV_KEYS = [
  "C2C_STATE_DIR",
  "C2C_CLOUDFLARED_PATH",
  "C2C_NAMED_TUNNEL_START_TIMEOUT_MS",
  "C2C_QUICK_TUNNEL_START_TIMEOUT_MS",
  "C2C_TUNNEL_HEALTH_CHECK_TIMEOUT_MS",
] as const;

export interface AutostartConfig {
  workspaceRoot: string;
  workspaceId: string;
  workspaceName: string;
  label: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  c2cBinPath: string;
  nodePath: string;
  intervalSeconds: number;
  programArguments: string[];
  environment: Record<string, string>;
}

export interface BuildAutostartConfigOptions {
  workspaceRoot: string;
  intervalSeconds?: number;
  c2cBinPath?: string;
  nodePath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AutostartCommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface LaunchctlOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  spawnSyncImpl?: typeof spawnSync;
}

export interface AutostartInstallResult {
  config: AutostartConfig;
  commands: AutostartCommandResult[];
}

export interface AutostartStatus {
  config: AutostartConfig;
  enabled: boolean;
  loaded: boolean | null;
  detail?: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function c2cBinPath(): string {
  return path.resolve(moduleDir, "..", "..", "bin", "c2c.js");
}

export function normalizeAutostartIntervalSeconds(value?: number | string): number {
  if (value === undefined || value === null || value === "") return DEFAULT_AUTOSTART_INTERVAL_SECONDS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_AUTOSTART_INTERVAL_SECONDS ||
    parsed > MAX_AUTOSTART_INTERVAL_SECONDS
  ) {
    throw new Error(
      `interval must be between ${MIN_AUTOSTART_INTERVAL_SECONDS} and ${MAX_AUTOSTART_INTERVAL_SECONDS} seconds`
    );
  }
  return parsed;
}

export function launchdLabelPart(workspaceName: string, workspaceId: string): string {
  const normalized = workspaceName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const cleaned = normalized
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64)
    .replace(/[._-]+$/g, "");
  const idPart = workspaceId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (!idPart) throw new Error("workspace id cannot produce a LaunchAgent label");
  return `${cleaned || "ws"}-${idPart}`;
}

function defaultPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const seen = new Set<string>();
  const parts = [
    ...(env.PATH?.split(path.delimiter) ?? []),
    path.join(homeDir, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return parts
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join(path.delimiter);
}

function executableIfExists(file: string): string | null {
  try {
    const resolved = path.resolve(file);
    fs.accessSync(resolved, fs.constants.F_OK | fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function autostartEnvironment(env: NodeJS.ProcessEnv, homeDir: string): Record<string, string> {
  const result: Record<string, string> = {
    HOME: homeDir,
    PATH: defaultPath(env, homeDir),
  };
  for (const key of C2C_AUTOSTART_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) result[key] = value;
  }
  if (!result.C2C_CLOUDFLARED_PATH) {
    const wrappedCloudflared = executableIfExists(path.join(homeDir, ".local", "bin", "c2c-cloudflared"));
    if (wrappedCloudflared) result.C2C_CLOUDFLARED_PATH = wrappedCloudflared;
  }
  return result;
}

export function buildAutostartConfig(opts: BuildAutostartConfigOptions): AutostartConfig {
  const workspace = new Workspace(opts.workspaceRoot);
  const homeDir = path.resolve(opts.homeDir ?? os.homedir());
  const labelPart = launchdLabelPart(workspace.name, workspace.id);
  const label = `${AUTOSTART_LABEL_PREFIX}.${labelPart}`;
  const stateDir = getStateDir();
  const logDir = path.join(stateDir, "logs");
  const intervalSeconds = normalizeAutostartIntervalSeconds(opts.intervalSeconds);
  const c2cEntry = path.resolve(opts.c2cBinPath ?? c2cBinPath());
  const nodePath = path.resolve(opts.nodePath ?? process.execPath);
  return {
    workspaceRoot: workspace.root,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    label,
    plistPath: path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`),
    stdoutPath: path.join(logDir, `autostart-${labelPart}.log`),
    stderrPath: path.join(logDir, `autostart-${labelPart}.error.log`),
    c2cBinPath: c2cEntry,
    nodePath,
    intervalSeconds,
    programArguments: [nodePath, c2cEntry, "autostart", "run", "-w", workspace.root, "--quiet"],
    environment: autostartEnvironment(opts.env ?? process.env, homeDir),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stringArray(values: string[]): string {
  return values.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
}

function environmentDict(values: Record<string, string>): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
}

export function renderLaunchAgentPlist(config: AutostartConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${stringArray(config.programArguments)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentDict(config.environment)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${config.intervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.workspaceRoot)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.stderrPath)}</string>
</dict>
</plist>
`;
}

function writeLaunchAgentPlist(config: AutostartConfig): void {
  ensureDir(path.dirname(config.plistPath));
  ensureDir(path.dirname(config.stdoutPath));
  fs.writeFileSync(config.plistPath, renderLaunchAgentPlist(config), { mode: 0o644 });
  try {
    fs.chmodSync(config.plistPath, 0o644);
  } catch {
    // best effort on filesystems without chmod semantics
  }
}

interface LaunchAgentSnapshot {
  contents: Buffer;
  mode: number;
}

function readLaunchAgentSnapshot(file: string): LaunchAgentSnapshot | null {
  try {
    return { contents: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function restoreLaunchAgentSnapshot(file: string, snapshot: LaunchAgentSnapshot | null): void {
  if (!snapshot) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, snapshot.contents, { mode: snapshot.mode });
  try {
    fs.chmodSync(file, snapshot.mode);
  } catch {
    // best effort on filesystems without chmod semantics
  }
}

function validateAutostartExecutables(config: AutostartConfig): void {
  for (const [label, file] of [
    ["Node executable", config.nodePath],
    ["C2C entrypoint", config.c2cBinPath],
  ] as const) {
    try {
      if (!fs.statSync(file).isFile()) throw new Error("not a regular file");
      fs.accessSync(file, fs.constants.F_OK | fs.constants.X_OK);
    } catch {
      throw new Error(`${label} is missing or not executable: ${file}`);
    }
  }
}

function ensureDarwin(platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error("autostart is currently supported on macOS LaunchAgents only");
  }
}

function launchdDomain(uid = process.getuid?.() ?? Number(process.env.UID) ?? 0): string {
  return `gui/${uid}`;
}

function runLaunchctl(args: string[], opts: LaunchctlOptions): AutostartCommandResult {
  const run = opts.spawnSyncImpl ?? spawnSync;
  const result = run("launchctl", args, { encoding: "utf8" }) as SpawnSyncReturns<string>;
  return {
    command: "launchctl",
    args,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandFailed(result: AutostartCommandResult): boolean {
  return result.status !== 0;
}

function bootoutIsIgnorable(result: AutostartCommandResult): boolean {
  return /could not find|not found|No such (?:process|file)|service is not loaded/i.test(
    `${result.stderr}\n${result.stdout}`
  );
}

function bootoutLaunchAgent(
  config: AutostartConfig,
  opts: LaunchctlOptions,
  commands: AutostartCommandResult[]
): void {
  const domain = launchdDomain(opts.uid);
  const bootout = runLaunchctl(["bootout", domain, config.plistPath], opts);
  commands.push(bootout);
  if (!commandFailed(bootout) || bootoutIsIgnorable(bootout)) return;

  const labelBootout = runLaunchctl(["bootout", `${domain}/${config.label}`], opts);
  commands.push(labelBootout);
  if (!commandFailed(labelBootout) || bootoutIsIgnorable(labelBootout)) return;
  throw new Error(
    `launchctl bootout failed: ${labelBootout.stderr || labelBootout.stdout || labelBootout.status}`
  );
}

export function enableAutostart(
  config: AutostartConfig,
  opts: LaunchctlOptions = {}
): AutostartInstallResult {
  ensureDarwin(opts.platform);
  validateAutostartExecutables(config);
  const commands: AutostartCommandResult[] = [];
  const domain = launchdDomain(opts.uid);
  const previous = readLaunchAgentSnapshot(config.plistPath);

  let oldBootoutCompleted = false;
  let bootstrapAttempted = false;
  try {
    bootoutLaunchAgent(config, opts, commands);
    oldBootoutCompleted = true;
    writeLaunchAgentPlist(config);
    bootstrapAttempted = true;
    const bootstrap = runLaunchctl(["bootstrap", domain, config.plistPath], opts);
    commands.push(bootstrap);
    if (commandFailed(bootstrap)) {
      throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout || bootstrap.status}`);
    }
    const kickstart = runLaunchctl(["kickstart", "-k", `${domain}/${config.label}`], opts);
    commands.push(kickstart);
    if (commandFailed(kickstart)) {
      throw new Error(`launchctl kickstart failed: ${kickstart.stderr || kickstart.stdout || kickstart.status}`);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (bootstrapAttempted || !oldBootoutCompleted) {
      try {
        bootoutLaunchAgent(config, opts, commands);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    try {
      restoreLaunchAgentSnapshot(config.plistPath, previous);
      if (previous) {
        const bootstrap = runLaunchctl(["bootstrap", domain, config.plistPath], opts);
        commands.push(bootstrap);
        if (commandFailed(bootstrap)) {
          throw new Error(`restore bootstrap failed: ${bootstrap.stderr || bootstrap.stdout || bootstrap.status}`);
        }
        const kickstart = runLaunchctl(["kickstart", "-k", `${domain}/${config.label}`], opts);
        commands.push(kickstart);
        if (commandFailed(kickstart)) {
          throw new Error(`restore kickstart failed: ${kickstart.stderr || kickstart.stdout || kickstart.status}`);
        }
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
    const reason = error instanceof Error ? error.message : String(error);
    const rollback = rollbackErrors.length > 0 ? `; rollback failed: ${rollbackErrors.join("; ")}` : "";
    throw new Error(`${reason}${rollback}`);
  }
  return { config, commands };
}

export function disableAutostart(
  config: AutostartConfig,
  opts: LaunchctlOptions = {}
): AutostartInstallResult {
  ensureDarwin(opts.platform);
  const commands: AutostartCommandResult[] = [];
  bootoutLaunchAgent(config, opts, commands);
  fs.rmSync(config.plistPath, { force: true });
  return { config, commands };
}

export function autostartStatus(
  config: AutostartConfig,
  opts: LaunchctlOptions = {}
): AutostartStatus {
  const enabled = fs.existsSync(config.plistPath);
  if ((opts.platform ?? process.platform) !== "darwin") {
    return { config, enabled, loaded: null, detail: "unsupported platform" };
  }
  const loaded = runLaunchctl(["print", `${launchdDomain(opts.uid)}/${config.label}`], opts);
  return {
    config,
    enabled,
    loaded: loaded.status === 0,
    detail: loaded.status === 0 ? undefined : (loaded.stderr || loaded.stdout || "").trim() || undefined,
  };
}
